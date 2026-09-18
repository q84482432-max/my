/**
 * 周K / 月K 聚合正确性测试（第三阶段核心验收）
 *
 * 用户要求原文：
 *   「周K/月K不要重新读取不存在的数据。必须从日K聚合。
 *     周K: open=第一交易日 open, close=最后交易日 close,
 *          low=周内最低low, high=周内最高high,
 *          volume=周内 volume 求和, amount=周内 amount 求和。月K同理。」
 *
 * 本脚本的验证策略（关键在于**独立实现**）：
 *   1. 从数据库取全量真实日K（唯一存储源）。
 *   2. 用一份**独立于 marketDataService.aggregateKlines 的朴素实现**手工分组聚合，
 *      不复用被测代码的任何函数，避免"自己验自己"。
 *   3. 与 service 返回的周K/月K 逐根逐字段比对（open/close/high/low/volume/amount/date）。
 *   4. 另外直接查库确认 **不存在 period != '1d' 的行**，
 *      以证明周月K 确实未被物化落库、而是实时由日K 派生。
 *
 * 运行： npx tsx scripts/testKlineAggregation.ts
 */

import prisma from "@/lib/prisma";
import {
  aggregateKlines,
  getKlines,
  getStockInfoByCode,
  getStockList,
} from "@/services/marketDataService";
import type { KlineBar } from "@/types";

/* ------------------------------------------------------------------ */
/* 轻量测试框架                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m\x1b[36m── ${title} ──\x1b[0m`);
}

/** 浮点近似比较（相对误差，容忍 Decimal 累加尾差） */
function approx(a: number, b: number, relTol = 1e-9): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / scale <= relTol;
}

/* ------------------------------------------------------------------ */
/* 独立实现：朴素分组聚合（故意不复用被测代码）                          */
/* ------------------------------------------------------------------ */

/** 日历周键：以周一为一周起点（与 ISO 周一致） */
function plainWeekKey(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7; // 周日=7
  // 回退到本周一
  dt.setUTCDate(dt.getUTCDate() - (dayNum - 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** 自然月键 YYYY-MM */
function plainMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/**
 * 朴素聚合 —— 完全独立于 service 的实现。
 * 严格按用户给定规则：open 取首根、close 取末根、high/low 取极值、volume/amount 求和。
 */
function naiveAggregate(
  daily: KlineBar[],
  period: "1w" | "1M",
): KlineBar[] {
  const keyOf = period === "1w" ? plainWeekKey : plainMonthKey;
  // 用 Map 保持插入顺序；daily 已升序，故分组顺序亦为升序
  const groups = new Map<string, KlineBar[]>();
  for (const bar of daily) {
    const k = keyOf(bar.date);
    const g = groups.get(k);
    if (g) g.push(bar);
    else groups.set(k, [bar]);
  }

  const out: KlineBar[] = [];
  for (const bars of groups.values()) {
    const first = bars[0];
    const last = bars[bars.length - 1];
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let amount = 0;
    for (const b of bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
      amount += b.amount;
    }
    out.push({
      date: last.date,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      amount,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("\n\x1b[1m第三阶段验收测试 — 周K / 月K 聚合正确性\x1b[0m");
  console.log("═".repeat(70));

  /* ============================================================ */
  section("0. 前提：周月K 未物化落库（必须只从日K 派生）");

  const periodGroups = await prisma.kline.groupBy({
    by: ["period"],
    _count: { _all: true },
  });
  const periods = periodGroups.map((g) => g.period).sort();
  check(
    "Kline 表内 period 只有 1d（无 1w/1M 物化行）",
    periods.length === 1 && periods[0] === "1d",
    periodGroups.map((g) => `${g.period}=${g._count._all}`).join(", ")
  );

  /* ============================================================ */
  section("1. 聚合口径独立复核（4 只样本 × 周K/月K）");

  const samples = [
    { code: "600519", label: "贵州茅台/沪主板" },
    { code: "000001", label: "平安银行/深主板" },
    { code: "300750", label: "宁德时代/创业板" },
    { code: "920047", label: "诺思兰德/北交所" },
  ];

  for (const s of samples) {
    const info = await getStockInfoByCode(s.code);
    if (!info) {
      check(`${s.label} 可查询`, false, "未命中");
      continue;
    }

    const daily = await getKlines(s.code, {
      period: "1d",
      adjust: info.adjust,
      limit: 5000,
    });
    if (daily.length === 0) {
      check(`${s.label} 有日K`, false, "0 根");
      continue;
    }

    // 样本基本信息
    console.log(
      `  \x1b[90m样本 ${info.code} ${info.name}（${s.label}）日K ${daily.length} 根 @${info.adjust}\x1b[0m`
    );

    for (const period of ["1w", "1M"] as const) {
      const actual = await getKlines(s.code, {
        period,
        adjust: info.adjust,
        limit: 5000,
      });
      const expected = naiveAggregate(daily, period);

      const pLabel = period === "1w" ? "周K" : "月K";

      // 根数一致
      check(
        `${s.label} ${pLabel} 根数 = 独立实现分组数`,
        actual.length === expected.length,
        `service=${actual.length} naive=${expected.length}`
      );

      if (actual.length !== expected.length) continue;

      // 逐根逐字段比对
      let openBad = 0;
      let closeBad = 0;
      let highBad = 0;
      let lowBad = 0;
      let volBad = 0;
      let amtBad = 0;
      let dateBad = 0;

      for (let i = 0; i < actual.length; i++) {
        const a = actual[i];
        const e = expected[i];
        if (a.date !== e.date) dateBad++;
        if (!approx(a.open, e.open)) openBad++;
        if (!approx(a.close, e.close)) closeBad++;
        if (!approx(a.high, e.high)) highBad++;
        if (!approx(a.low, e.low)) lowBad++;
        if (a.volume !== e.volume) volBad++;
        if (!approx(a.amount, e.amount, 1e-9)) amtBad++;
      }

      check(`${s.label} ${pLabel} 日期 = 周期内最后交易日`, dateBad === 0, `不符 ${dateBad} 根`);
      check(
        `${s.label} ${pLabel} open = 周期内首日 open`,
        openBad === 0,
        `不符 ${openBad} 根`
      );
      check(
        `${s.label} ${pLabel} close = 周期内末日 close`,
        closeBad === 0,
        `不符 ${closeBad} 根`
      );
      check(
        `${s.label} ${pLabel} high = 周期内 high 最大值`,
        highBad === 0,
        `不符 ${highBad} 根`
      );
      check(
        `${s.label} ${pLabel} low = 周期内 low 最小值`,
        lowBad === 0,
        `不符 ${lowBad} 根`
      );
      check(
        `${s.label} ${pLabel} volume = 周期内 volume 求和`,
        volBad === 0,
        `不符 ${volBad} 根`
      );
      check(
        `${s.label} ${pLabel} amount = 周期内 amount 求和`,
        amtBad === 0,
        `不符 ${amtBad} 根`
      );

      // 结构不变量：high >= max(open, close), low <= min(open, close)
      const structureOk = actual.every(
        (b) =>
          b.high >= Math.max(b.open, b.close) - 1e-6 &&
          b.low <= Math.min(b.open, b.close) + 1e-6 &&
          b.high >= b.low
      );
      check(`${s.label} ${pLabel} 结构自洽（high≥max(o,c)、low≤min(o,c)）`, structureOk);

      // 升序
      const asc = actual.every(
        (b, i) => i === 0 || b.date > actual[i - 1].date
      );
      check(`${s.label} ${pLabel} 按日期严格升序`, asc);
    }
  }

  /* ============================================================ */
  section("2. 体量守恒（子周期求和 = 父周期总量）");

  const dailyAll = await getKlines("600519", {
    period: "1d",
    adjust: "qfq",
    limit: 5000,
  });
  const weekly = await getKlines("600519", { period: "1w", adjust: "qfq", limit: 5000 });
  const monthly = await getKlines("600519", { period: "1M", adjust: "qfq", limit: 5000 });

  const sumDailyVol = dailyAll.reduce((a, b) => a + b.volume, 0);
  const sumWeeklyVol = weekly.reduce((a, b) => a + b.volume, 0);
  const sumMonthlyVol = monthly.reduce((a, b) => a + b.volume, 0);
  check(
    "600519 日K 成交量总和 = 周K 成交量总和",
    sumDailyVol === sumWeeklyVol,
    `${sumDailyVol} vs ${sumWeeklyVol}`
  );
  check(
    "600519 周K 成交量总和 = 月K 成交量总和",
    sumWeeklyVol === sumMonthlyVol,
    `${sumWeeklyVol} vs ${sumMonthlyVol}`
  );

  const sumDailyAmt = dailyAll.reduce((a, b) => a + b.amount, 0);
  const sumMonthlyAmt = monthly.reduce((a, b) => a + b.amount, 0);
  check(
    "600519 日K 成交额总和 = 月K 成交额总和",
    approx(sumDailyAmt, sumMonthlyAmt, 1e-9),
    `${sumDailyAmt.toFixed(2)} vs ${sumMonthlyAmt.toFixed(2)}`
  );

  // 首尾价格锚点：月K 首根 open = 日K 首根 open；月K 末根 close = 日K 末根 close
  check(
    "600519 月K 首根 open = 日K 首根 open",
    approx(monthly[0].open, dailyAll[0].open),
    `${monthly[0].open} vs ${dailyAll[0].open}`
  );
  check(
    "600519 月K 末根 close = 日K 末根 close",
    approx(monthly[monthly.length - 1].close, dailyAll[dailyAll.length - 1].close),
    `${monthly[monthly.length - 1].close} vs ${dailyAll[dailyAll.length - 1].close}`
  );
  check(
    "600519 周K 首根 high = 日K 首根 high 或该周最高",
    weekly[0].high >= dailyAll[0].high - 1e-6,
    `周K首根high=${weekly[0].high} 日K首根high=${dailyAll[0].high}`
  );

  /* ============================================================ */
  section("3. limit 截断发生在聚合之后（不得先截日K再聚合）");

  // 若先截日K 再聚合，首根周期K 会因缺失周内前几日而 open/high/low 失真。
  // 正确实现：全量日K 聚合后再取尾部 N 根。
  const full = await getKlines("600519", { period: "1w", adjust: "qfq", limit: 5000 });
  const tail3 = await getKlines("600519", { period: "1w", adjust: "qfq", limit: 3 });
  check("周K limit=3 返回 3 根", tail3.length === 3, `${tail3.length} 根`);
  const tailExpected = full.slice(-3);
  const tailMatch = tail3.every(
    (b, i) =>
      b.date === tailExpected[i].date &&
      approx(b.open, tailExpected[i].open) &&
      approx(b.high, tailExpected[i].high) &&
      approx(b.low, tailExpected[i].low) &&
      approx(b.close, tailExpected[i].close) &&
      b.volume === tailExpected[i].volume
  );
  check(
    "周K limit=3 与全量尾部 3 根完全一致（截断在聚合后）",
    tailMatch,
    tail3.map((b) => b.date).join(", ")
  );

  // 首根周期K 的 open 必须等于对应周首个交易日的 open（若先截日K 则会错）
  const firstWeekBars = dailyAll.filter((b) => plainWeekKey(b.date) === plainWeekKey(full[0].date));
  check(
    "全量周K 首根 open = 该周首个交易日 open（未被截断破坏）",
    firstWeekBars.length > 0 && approx(full[0].open, firstWeekBars[0].open),
    `周K=${full[0].open} 日K首日=${firstWeekBars[0]?.open}`
  );

  /* ============================================================ */
  section("4. aggregateKlines 纯函数边界（空输入 / 日K 直通）");

  const asDaily = aggregateKlines(dailyAll, "1d");
  check(
    "period=1d 时原样返回（不聚合）",
    asDaily.length === dailyAll.length && asDaily[0] === dailyAll[0]
  );
  check("空输入返回空数组", aggregateKlines([], "1w").length === 0);
  check("单根日K 聚合后仍为 1 根", aggregateKlines([dailyAll[0]], "1w").length === 1);
  check(
    "单根日K 聚合后 OHLCV 与原值相等",
    (() => {
      const r = aggregateKlines([dailyAll[0]], "1M")[0];
      const d = dailyAll[0];
      return (
        r.open === d.open &&
        r.close === d.close &&
        r.high === d.high &&
        r.low === d.low &&
        r.volume === d.volume &&
        approx(r.amount, d.amount) &&
        r.date === d.date
      );
    })()
  );
  check(
    "aggregateKlines 不修改输入数组（纯函数）",
    (() => {
      const snapshot = JSON.stringify(dailyAll[0]);
      aggregateKlines(dailyAll, "1w");
      return JSON.stringify(dailyAll[0]) === snapshot;
    })()
  );

  /* ============================================================ */
  section("5. 跨板块抽样：聚合口徑一致（20 只）");

  const listResp = await getStockList({ take: 20, skip: 3000 });
  let aggFail = 0;
  let aggEmpty = 0;
  for (const item of listResp.items) {
    const d = await getKlines(item.code, {
      period: "1d",
      adjust: item.adjust,
      limit: 5000,
    });
    const w = await getKlines(item.code, {
      period: "1w",
      adjust: item.adjust,
      limit: 5000,
    });
    const m = await getKlines(item.code, {
      period: "1M",
      adjust: item.adjust,
      limit: 5000,
    });
    if (d.length === 0) {
      aggEmpty++;
      continue;
    }
    const expW = naiveAggregate(d, "1w");
    const expM = naiveAggregate(d, "1M");
    const okW =
      w.length === expW.length &&
      w.every(
        (b, i) =>
          b.date === expW[i].date &&
          approx(b.open, expW[i].open) &&
          approx(b.close, expW[i].close) &&
          approx(b.high, expW[i].high) &&
          approx(b.low, expW[i].low) &&
          b.volume === expW[i].volume
      );
    const okM =
      m.length === expM.length &&
      m.every(
        (b, i) =>
          b.date === expM[i].date &&
          approx(b.open, expM[i].open) &&
          approx(b.close, expM[i].close) &&
          approx(b.high, expM[i].high) &&
          approx(b.low, expM[i].low) &&
          b.volume === expM[i].volume
      );
    if (!okW || !okM) {
      aggFail++;
      console.log(`    \x1b[31m聚合不符: ${item.code}/${item.name}\x1b[0m`);
    }
  }
  check(
    "20 只抽样 周K/月K 全部与独立实现一致",
    aggFail === 0,
    `不符 ${aggFail} 只 / 空 ${aggEmpty} 只`
  );

  /* ============================================================ */
  console.log("\n" + "═".repeat(70));
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[1m\x1b[32m✔ 全部通过：${passed}/${total}\x1b[0m`);
  } else {
    console.log(`\x1b[1m\x1b[31m✗ 失败 ${failed}/${total}\x1b[0m`);
    failures.forEach((f) => console.log(`    - ${f}`));
  }
  console.log("═".repeat(70) + "\n");
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("\n\x1b[31m测试执行异常:\x1b[0m", e);
    await prisma.$disconnect();
    process.exit(1);
  });
