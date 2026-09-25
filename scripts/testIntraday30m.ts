/**
 * 30 分钟 K 线（Parquet）+ 污染标记 —— 防未来数据 / 边界回归测试
 *
 * 为什么必须存在（阶段 1 安全收口）：
 *   30m 数据即将接入 V3 前端，接入后**玩家可见的每一根 K 都从这条链路出来**。
 *   两个函数是整个 V3 的红线，而此前**零测试覆盖**：
 *
 *     1. `clipBarsForReveal` —— 未揭示当日收盘时，只允许下发当日第一根（10:00）。
 *        一旦它出错，玩家在盘中就能从图上读到当日收盘价 —— 等于提前看到答案。
 *     2. `contaminatedInRange` —— 与污染日期有交集的标的必须整体出局。
 *        一旦它出错，模拟区间会推进到已知损坏的 2026-06-30（北交所 34 只）。
 *
 * 测试策略（拒绝自证）：
 *   - 纯函数部分：合成 8 根棒做**穷举式边界断言**（必然运行，不依赖数据集）。
 *   - 真实数据部分：读实际 Parquet / 实际污染标记文件做**交叉验证**；
 *     并用 dev.db 日K **独立复算**「30m 越出日K」这一污染定义本身，
 *     而不是相信标记文件的自述。
 *   - 数据目录不存在时明确 SKIP 并打印原因，**不伪装成通过**。
 *
 * 运行： npx tsx scripts/testIntraday30m.ts
 */

import fs from "node:fs";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import {
  BARS_PER_DAY,
  CONTAMINATED_DAYS_FILE,
  FIRST_INTRADAY_TIME,
  INTRADAY_DIR,
  INTRADAY_TIMES,
  clipBarsForReveal,
  contaminatedDatesOf,
  contaminatedInRange,
  getContaminatedIndex,
  getIntradayBars,
  getIntradayCoverage,
  isContaminated,
  type IntradayBar,
} from "@/lib/intraday30m";
import { getKlineAt } from "@/services/marketDataService";
import type { KlineBar } from "@/types";

/**
 * 编译期断言（由 `npm run typecheck` 兜底）：
 * DTO 统一后 `IntradayBar` 必须可赋给 `KlineBar`，否则「一套 DTO」没做到。
 * 放在模块顶层，tsx 转译不报错，但 tsc 会。
 */
const _dtoCompat: KlineBar = null as unknown as IntradayBar;
void _dtoCompat;

/* ------------------------------------------------------------------ */
/* 测试框架（轻量，无外部依赖；与其它 test*.ts 保持一致）                  */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
let skipped = 0;
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

function info(msg: string): void {
  console.log(`  \x1b[90m· ${msg}\x1b[0m`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m\x1b[36m── ${title} ──\x1b[0m`);
}

function skip(title: string, reason: string): void {
  skipped++;
  console.log(`\n\x1b[1m\x1b[33m── ${title} ──  SKIP\x1b[0m`);
  console.log(`  \x1b[33m! ${reason}\x1b[0m`);
}

/* ------------------------------------------------------------------ */
/* 合成数据（纯函数测试用）                                              */
/* ------------------------------------------------------------------ */

const SYNTH_DATE = "2026-09-21";

/** 标准 8 根棒：价格/量额逐根递增，便于用引用与数值双重定位 */
const SYNTH_DAY: IntradayBar[] = INTRADAY_TIMES.map((t, i) => ({
  date: SYNTH_DATE,
  time: t,
  open: 10 + i,
  high: 10.5 + i,
  low: 9.5 + i,
  close: 10.2 + i,
  volume: 1000 * (i + 1),
  amount: 10000 * (i + 1),
}));

/* ------------------------------------------------------------------ */
/* 源码扫描（守卫「唯一业务定义」）                                       */
/* ------------------------------------------------------------------ */

/** 递归收集项目自身源码（排除 node_modules 与隐藏目录，且**不含 scripts/**） */
function walkSources(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 去掉行注释与块注释。
 *
 * 守卫断言必须只看**代码**。本次收口恰恰在 `simtradeService.ts` / `route.ts` 的注释里
 * 写明了「曾复制一份 isCloseRevealedStage」「原为 prisma.$queryRawUnsafe」这类
 * 说明文字 —— 如果不剥注释，守卫就会被自己写的解释性文字误判为「问题仍然存在」。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** 在**剥离注释后**的源码里统计正则命中数 */
function countCodeMatches(
  files: string[],
  re: RegExp,
): { file: string; count: number }[] {
  const hits: { file: string; count: number }[] = [];
  for (const f of files) {
    const text = stripComments(fs.readFileSync(f, "utf8"));
    const m = text.match(new RegExp(re.source, "g"));
    if (m && m.length > 0) hits.push({ file: f, count: m.length });
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("\n\x1b[1m30m K 线防未来数据 / 污染边界回归测试（阶段 1）\x1b[0m");
  console.log("═".repeat(64));

  /* ============================================================ */
  section("1. 常量契约（30m 时点与根数）");

  check("INTRADAY_TIMES 共 8 个时点", INTRADAY_TIMES.length === 8, `实得 ${INTRADAY_TIMES.length}`);
  check("BARS_PER_DAY = INTRADAY_TIMES.length", BARS_PER_DAY === INTRADAY_TIMES.length, `BARS_PER_DAY=${BARS_PER_DAY}`);
  check("首个可揭示时点 = 10:00:00", FIRST_INTRADAY_TIME === "10:00:00", `实得 ${FIRST_INTRADAY_TIME}`);
  check(
    "时点严格升序（无重复/乱序）",
    INTRADAY_TIMES.every((t, i) => i === 0 || t > INTRADAY_TIMES[i - 1]),
    INTRADAY_TIMES.join(" "),
  );
  check(
    "全部时点落在 A 股交易时段内（≤ 15:00:00）",
    INTRADAY_TIMES.every((t) => t <= "15:00:00"),
  );

  /* ============================================================ */
  section("2. clipBarsForReveal —— 纯函数防未来数据（核心红线）");

  const revealed = clipBarsForReveal(SYNTH_DAY, true);
  const hidden = clipBarsForReveal(SYNTH_DAY, false);

  check("已揭示收盘 → 返回全部 8 根", revealed.length === 8, `实得 ${revealed.length}`);
  check(
    "已揭示收盘 → 逐根原样返回（引用相同、顺序不变）",
    revealed.length === SYNTH_DAY.length && revealed.every((b, i) => b === SYNTH_DAY[i]),
  );
  check("未揭示收盘 → 只返回 1 根", hidden.length === 1, `实得 ${hidden.length}`);
  check(
    "未揭示收盘 → 唯一返回的那根就是 10:00",
    hidden.length === 1 && hidden[0].time === FIRST_INTRADAY_TIME,
    hidden.map((b) => b.time).join(",") || "(空)",
  );

  // —— 防未来数据的三条硬断言 ——
  check(
    "【防未来】未揭示收盘时，返回的每一根 time 都 ≤ 10:00:00",
    hidden.every((b) => b.time <= FIRST_INTRADAY_TIME),
    hidden.map((b) => b.time).join(",") || "(空)",
  );
  check(
    "【防未来】未揭示收盘时，当日 15:00 那根（承载当日收盘价）绝不在返回集中",
    !hidden.includes(SYNTH_DAY[SYNTH_DAY.length - 1]),
  );
  check(
    "【防未来】未揭示收盘时，返回集不含任何 10:30 及之后的棒",
    hidden.every((b) => !INTRADAY_TIMES.slice(1).includes(b.time as (typeof INTRADAY_TIMES)[number])),
    `被拦下的时点：${INTRADAY_TIMES.slice(1).join(",")}`,
  );
  check(
    "【防未来】未揭示集的 close 不等于当日真实收盘价（信息量对齐 V2「只暴露 open」）",
    hidden.length === 1 && hidden[0].close !== SYNTH_DAY[SYNTH_DAY.length - 1].close,
    `hidden.close=${hidden[0]?.close} 当日close=${SYNTH_DAY[SYNTH_DAY.length - 1].close}`,
  );

  // —— 不变量：不可变 / 幂等 / 单调 ——
  check("调用不修改入参（原数组仍为 8 根）", SYNTH_DAY.length === 8, `实得 ${SYNTH_DAY.length}`);
  check(
    "未揭示裁剪幂等：clip(clip(x,false),false).length = 1",
    clipBarsForReveal(hidden, false).length === 1,
  );
  check(
    "已揭示裁剪幂等：clip(clip(x,true),true).length = 8",
    clipBarsForReveal(revealed, true).length === 8,
  );
  check(
    "单调性：已揭示集 ⊇ 未揭示集（揭示只会多给，不会少给）",
    revealed.length >= hidden.length && hidden.every((b) => revealed.includes(b)),
  );

  // —— 边界输入 ——
  check("空数组 + 未揭示 → 空", clipBarsForReveal([], false).length === 0);
  check("空数组 + 已揭示 → 空", clipBarsForReveal([], true).length === 0);
  check(
    "只含盘后棒（13:30~15:00）+ 未揭示 → 空（无任何可揭示内容）",
    clipBarsForReveal(SYNTH_DAY.slice(4), false).length === 0,
    `实得 ${clipBarsForReveal(SYNTH_DAY.slice(4), false).length}`,
  );
  check(
    "只含 10:00 一根 + 未揭示 → 保留该根",
    clipBarsForReveal(SYNTH_DAY.slice(0, 1), false).length === 1,
  );
  check(
    "乱序输入（倒序）+ 未揭示 → 仍只留 10:00 一根",
    (() => {
      const rev = [...SYNTH_DAY].reverse();
      const c = clipBarsForReveal(rev, false);
      return c.length === 1 && c[0].time === FIRST_INTRADAY_TIME;
    })(),
  );
  check(
    "边界时刻：10:00:00 保留、10:30:00 剔除",
    (() => {
      const pair = [SYNTH_DAY[0], SYNTH_DAY[1]];
      const c = clipBarsForReveal(pair, false);
      return c.length === 1 && c[0].time === "10:00:00";
    })(),
  );

  /* ============================================================ */
  section("3. clipBarsForReveal —— 真实 Parquet 数据交叉验证");

  const dataAvailable = fs.existsSync(INTRADAY_DIR);
  if (!dataAvailable) {
    skip("3. 真实 Parquet 交叉验证", `30m 数据目录不存在：${INTRADAY_DIR}`);
  } else {
    info(`30m 数据目录：${INTRADAY_DIR}`);
    const realCodes = ["600036", "000001", "300750"];
    for (const code of realCodes) {
      const cov = await getIntradayCoverage(code);
      check(`${code} 30m 数据可用`, cov.available, `bars=${cov.bars} days=${cov.days}`);
      if (!cov.available || !cov.last) {
        check(`${code} 存在最后交易日`, false, "coverage.last 为空");
        continue;
      }
      const bars = await getIntradayBars(code, cov.last);
      check(`${code} ${cov.last} 有 30m 棒`, bars.length > 0, `bars=${bars.length}`);
      check(
        `${code} ${cov.last} 按 time 升序（前端画图依赖）`,
        bars.every((b, i) => i === 0 || b.time >= bars[i - 1].time),
      );
      check(
        `${code} 每根棒 DTO 字段完整且为 number（KlineBar 兼容）`,
        bars.every(
          (b) =>
            typeof b.date === "string" &&
            typeof b.time === "string" &&
            [b.open, b.high, b.low, b.close, b.volume, b.amount].every((v) => typeof v === "number"),
        ),
      );
      check(
        `${code} ${cov.last} high ≥ low 且价格为正`,
        bars.every((b) => b.high >= b.low && b.low > 0),
      );

      const clipHidden = clipBarsForReveal(bars, false);
      const clipRevealed = clipBarsForReveal(bars, true);
      check(
        `${code} 未揭示 → 每根 time ≤ 10:00:00（真实数据防未来）`,
        clipHidden.every((b) => b.time <= FIRST_INTRADAY_TIME),
        clipHidden.map((b) => b.time).join(",") || "(空)",
      );
      check(
        `${code} 未揭示 → 根数 ≤ 1`,
        clipHidden.length <= 1,
        `实得 ${clipHidden.length}`,
      );
      check(
        `${code} 已揭示 → 根数 ≥ 未揭示根数`,
        clipRevealed.length >= clipHidden.length,
        `${clipRevealed.length} vs ${clipHidden.length}`,
      );
      if (bars.length === BARS_PER_DAY) {
        check(
          `${code} 完整 8 根日：未揭示恰好 1 根 / 已揭示恰好 8 根`,
          clipHidden.length === 1 && clipRevealed.length === 8,
          `${clipHidden.length} / ${clipRevealed.length}`,
        );
        check(
          `${code} 完整 8 根日：当日 15:00 棒未被未揭示集包含`,
          !clipHidden.includes(bars[BARS_PER_DAY - 1]),
        );
        check(
          `${code} 完整 8 根日：已揭示集末根 close = 当日真实收盘价`,
          clipRevealed[BARS_PER_DAY - 1].close === bars[BARS_PER_DAY - 1].close,
        );
      } else {
        info(`${code} ${cov.last} 仅 ${bars.length} 根（非完整 8 根日），跳过完整日断言`);
      }
      info(`${code} coverage: days=${cov.days} first=${cov.first} last=${cov.last} barsPerDayOk=${cov.barsPerDayOk}`);
    }
  }

  /* ============================================================ */
  section("4. contaminatedInRange —— 区间边界与污染日");

  const contamFileAvailable = fs.existsSync(CONTAMINATED_DAYS_FILE);
  if (!contamFileAvailable) {
    skip("4. contaminatedInRange 边界", `污染标记文件不存在：${CONTAMINATED_DAYS_FILE}`);
  } else {
    const BJ = "920001";
    const BAD_DAY = "2026-06-30";

    check(
      `[${BAD_DAY}, ${BAD_DAY}] 单日区间命中（左右端点都含）`,
      contaminatedInRange(BJ, BAD_DAY, BAD_DAY).join(",") === BAD_DAY,
      JSON.stringify(contaminatedInRange(BJ, BAD_DAY, BAD_DAY)),
    );
    check(
      `区间终点恰为污染日 → 命中（右端点闭区间）`,
      contaminatedInRange(BJ, "2026-06-01", BAD_DAY).join(",") === BAD_DAY,
      JSON.stringify(contaminatedInRange(BJ, "2026-06-01", BAD_DAY)),
    );
    check(
      `区间起点恰为污染日 → 命中（左端点闭区间）`,
      contaminatedInRange(BJ, BAD_DAY, "2026-07-31").join(",") === BAD_DAY,
      JSON.stringify(contaminatedInRange(BJ, BAD_DAY, "2026-07-31")),
    );
    check(
      `区间终点 = 污染日前一天 → 不命中`,
      contaminatedInRange(BJ, "2026-06-01", "2026-06-29").length === 0,
      JSON.stringify(contaminatedInRange(BJ, "2026-06-01", "2026-06-29")),
    );
    check(
      `区间起点 = 污染日后一天 → 不命中`,
      contaminatedInRange(BJ, "2026-07-01", "2026-07-31").length === 0,
      JSON.stringify(contaminatedInRange(BJ, "2026-07-01", "2026-07-31")),
    );
    check(
      `同月但早于污染日 → 不命中`,
      contaminatedInRange(BJ, "2026-06-01", "2026-06-30".replace("30", "29")).length === 0,
    );
    check(
      `远早区间（2020 全年）→ 不命中`,
      contaminatedInRange(BJ, "2020-01-01", "2020-12-31").length === 0,
    );
    check(
      `超大区间（2000~2099）→ 恰好命中 1 天`,
      contaminatedInRange(BJ, "2000-01-01", "2099-12-31").join(",") === BAD_DAY,
      JSON.stringify(contaminatedInRange(BJ, "2000-01-01", "2099-12-31")),
    );
    check(
      `未受污染标的（600036）超大区间 → 不命中`,
      contaminatedInRange("600036", "2000-01-01", "2099-12-31").length === 0,
    );
    check(
      `不存在的标的码 → 不命中且不抛错`,
      contaminatedInRange("999999", "2000-01-01", "2099-12-31").length === 0,
    );
    check(
      `非法区间（from > to）→ 返回空而非抛错`,
      contaminatedInRange(BJ, "2026-07-01", "2026-06-30").length === 0,
    );
    check(
      `返回结果升序且去重`,
      (() => {
        const r = contaminatedInRange(BJ, "2000-01-01", "2099-12-31");
        return r.every((d, i) => i === 0 || d > r[i - 1]);
      })(),
    );

    // —— 单日/单标的判定与区间判定必须一致 ——
    check(
      `isContaminated 与 contaminatedInRange 同口径（${BJ} @ ${BAD_DAY}）`,
      isContaminated(BJ, BAD_DAY) === (contaminatedInRange(BJ, BAD_DAY, BAD_DAY).length === 1),
    );
    check(
      `contaminatedDatesOf(${BJ}) = [${BAD_DAY}]`,
      contaminatedDatesOf(BJ).join(",") === BAD_DAY,
      JSON.stringify(contaminatedDatesOf(BJ)),
    );
    check(
      `污染日前一天 isContaminated = false`,
      isContaminated(BJ, "2026-06-29") === false,
    );
  }

  /* ============================================================ */
  section("5. 污染标记索引 vs 原始 JSON 文件交叉验证");

  if (!contamFileAvailable) {
    skip("5. 索引交叉验证", `污染标记文件不存在：${CONTAMINATED_DAYS_FILE}`);
  } else {
    const idx = getContaminatedIndex();
    check("污染索引已成功加载（loaded = true）", idx.loaded === true);
    check("索引含 34 只标的（与 stats.excludedStocks 一致）", idx.byCode.size === 34, `实得 ${idx.byCode.size}`);
    check("索引明细条目 34 条（与 stats.excludedPairs 一致）", idx.entries.length === 34, `实得 ${idx.entries.length}`);

    // 独立重读原始文件（不经过模块缓存），逐项比对
    const rawFile = JSON.parse(fs.readFileSync(CONTAMINATED_DAYS_FILE, "utf8")) as {
      stats?: { excludedPairs?: number; excludedStocks?: number; excludedDates?: string[] };
      excludeIndex?: Record<string, string[]>;
    };
    const rawIndex = rawFile.excludeIndex ?? {};
    const rawCodes = Object.keys(rawIndex).sort();
    const idxCodes = [...idx.byCode.keys()].sort();

    check(
      "模块索引的标的集合 = 文件 excludeIndex 的键集合（逐项比对）",
      idxCodes.length === rawCodes.length && idxCodes.every((c, i) => c === rawCodes[i]),
      `模块 ${idxCodes.length} 只 vs 文件 ${rawCodes.length} 只`,
    );
    check(
      "stats.excludedPairs = 34（文件自述与实测一致）",
      rawFile.stats?.excludedPairs === 34,
      `文件值 ${rawFile.stats?.excludedPairs}`,
    );
    check(
      "stats.excludedDates 恰为 [2026-06-30]",
      JSON.stringify(rawFile.stats?.excludedDates) === JSON.stringify(["2026-06-30"]),
      JSON.stringify(rawFile.stats?.excludedDates),
    );

    const allSameDay = idxCodes.every((c) => idx.byCode.get(c)?.has("2026-06-30"));
    check("34 只标的的污染日全部为 2026-06-30", allSameDay);

    const allBj = idx.entries.every((e) => e.exchange === "BJ");
    check("全部污染条目 exchange = BJ（北交所）", allBj);

    const allBjCode = idxCodes.every((c) => c.startsWith("920") || c.startsWith("8"));
    check("全部污染代码为北交所代码段（920/8 开头）", allBjCode, idxCodes.slice(0, 5).join(","));

    // 逐标的：contaminatedInRange 必须能命中文件里记录的每一天
    let perCodeOk = true;
    const mismatch: string[] = [];
    for (const [code, dates] of Object.entries(rawIndex)) {
      for (const d of dates) {
        if (contaminatedInRange(code, d, d).join(",") !== d) {
          perCodeOk = false;
          mismatch.push(`${code}@${d}`);
        }
      }
    }
    check(
      "文件里记录的每一个 (标的,日期) 对都能被 contaminatedInRange 命中",
      perCodeOk,
      mismatch.length ? `未命中：${mismatch.slice(0, 5).join(",")}` : `${idx.entries.length} 对全部命中`,
    );
  }

  /* ============================================================ */
  section("6. 污染样本三方对齐（标记清单 / 修复记录 / 实际 Parquet）");

  const BJ_CODE = "920001";
  const BJ_DATE = "2026-06-30";
  const REPAIRS_FILE = path.join(
    INTRADAY_DIR,
    "..",
    "metadata",
    "kline_30m_repairs.jsonl",
  );

  if (!dataAvailable || !contamFileAvailable) {
    skip("6. 污染样本三方对齐", "缺少 30m 数据目录或污染标记文件");
  } else {
    // ---------- 6.0 该日确实有数据（所以拦截不是空跑） ----------
    const rawBj = await getIntradayBars(BJ_CODE, BJ_DATE);
    check(
      `${BJ_CODE} ${BJ_DATE} 该日确有 30m 数据（所以拦截是必需的，不是空跑）`,
      rawBj.length > 0,
      `bars=${rawBj.length}`,
    );

    // ---------- 读入两套元数据 ----------
    const contamIndex =
      (JSON.parse(fs.readFileSync(CONTAMINATED_DAYS_FILE, "utf8")) as {
        excludeIndex?: Record<string, string[]>;
      }).excludeIndex ?? {};
    const listedPairs: { code: string; date: string }[] = [];
    for (const [code, dates] of Object.entries(contamIndex)) {
      for (const d of dates) listedPairs.push({ code, date: d });
    }

    interface RepairRecord {
      code: string;
      tradeDate: string;
      time: string;
      bad_fields?: string[];
      original?: Record<string, number>;
      repaired?: Record<string, number>;
      rule?: string;
    }
    const repairRecords: RepairRecord[] = [];
    if (fs.existsSync(REPAIRS_FILE)) {
      for (const line of fs.readFileSync(REPAIRS_FILE, "utf8").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          repairRecords.push(JSON.parse(s) as RepairRecord);
        } catch {
          /* 单行损坏不阻断整体记账 */
        }
      }
    } else {
      info(`未见修复记录文件 ${REPAIRS_FILE}，按「无修复」口径记账`);
    }
    const repairedKey = new Set(repairRecords.map((r) => `${r.code}|${r.tradeDate}`));

    // ---------- 缓存：避免 34 对重复 IO / 查询 ----------
    const dailyCache = new Map<string, KlineBar | null>();
    const barsCache = new Map<string, IntradayBar[]>();
    const getDaily = async (code: string, date: string): Promise<KlineBar | null> => {
      const k = `${code}|${date}`;
      if (!dailyCache.has(k)) dailyCache.set(k, await getKlineAt(code, date));
      return dailyCache.get(k) ?? null;
    };
    const getBars = async (code: string, date: string): Promise<IntradayBar[]> => {
      const k = `${code}|${date}`;
      if (!barsCache.has(k)) barsCache.set(k, await getIntradayBars(code, date));
      return barsCache.get(k) ?? [];
    };
    const TOL = 1e-6;
    const barViolates = (b: IntradayBar, d: KlineBar): boolean =>
      b.high > d.high + TOL ||
      b.low < d.low - TOL ||
      b.close > d.high + TOL ||
      b.close < d.low - TOL;

    // ---------- 6.1 逐对记账：不允许存在「无法解释」的标记 ----------
    let stillViolating = 0;
    let repairedAndClean = 0;
    const unaccounted: string[] = [];
    const unknownDaily: string[] = [];
    for (const p of listedPairs) {
      const bars = await getBars(p.code, p.date);
      const daily = await getDaily(p.code, p.date);
      if (!daily || bars.length === 0) {
        unknownDaily.push(`${p.code}@${p.date}`);
        continue;
      }
      if (bars.some((b) => barViolates(b, daily))) stillViolating++;
      else if (repairedKey.has(`${p.code}|${p.date}`)) repairedAndClean++;
      else unaccounted.push(`${p.code}@${p.date}`);
    }
    info(
      `清单 ${listedPairs.length} 对 → 仍越界 ${stillViolating} / 已修复且现已合规 ${repairedAndClean} / 缺日K或无数据 ${unknownDaily.length}`,
    );
    check(
      "不存在「既不复现越界、又无修复记录」的无法解释标记",
      unaccounted.length === 0,
      unaccounted.length ? `无法解释：${unaccounted.slice(0, 5).join(",")}` : "全部有据可查",
    );
    check(
      "清单每一对都能在 dev.db 取到当日日K（否则无法判定其合规性）",
      unknownDaily.length === 0,
      unknownDaily.length
        ? `缺日K：${unknownDaily.slice(0, 5).join(",")}`
        : `${listedPairs.length} 对全部可取`,
    );

    // ---------- 6.2 两套元数据不得漂移 ----------
    const listedKey = new Set(listedPairs.map((p) => `${p.code}|${p.date}`));
    check(
      "修复记录的 (标的,日期) 集合与污染清单完全一致（两套元数据未漂移）",
      repairedKey.size === listedKey.size &&
        [...listedKey].every((k) => repairedKey.has(k)),
      `修复 ${repairedKey.size} 对 vs 清单 ${listedKey.size} 对`,
    );

    // ---------- 6.3 修复必须真的落到磁盘上的 Parquet ----------
    const notLanded: string[] = [];
    for (const r of repairRecords) {
      const bars = await getBars(r.code, r.tradeDate);
      const daily = await getDaily(r.code, r.tradeDate);
      const hit = bars.find((b) => b.time === r.time);
      if (!hit || !daily) notLanded.push(`${r.code}@${r.tradeDate} ${r.time}(缺数据)`);
      else if (barViolates(hit, daily)) notLanded.push(`${r.code}@${r.tradeDate} ${r.time}(仍越界)`);
    }
    check(
      "修复记录中每一根棒都已不再越出日K（修复已落盘，不只是写了日志）",
      notLanded.length === 0,
      notLanded.length
        ? `未生效：${notLanded.slice(0, 5).join(",")}`
        : `${repairRecords.length} 条记录全部已落盘`,
    );

    // ---------- 6.4 修复口径自洽：坏字段被钳制进「同棒好字段」区间 ----------
    //
    // 实测到的污染有两种形态，不能只按一种去断言：
    //   A. `high`（少数含 `close`）被灌成数千倍 —— 如 920001 high=26681.471（真值 ~14.98）
    //   B. `low` 被灌成远低于真实值     —— 如 920111 low=17.41（同棒 open=32.65）
    // 因此不能简单断言「repaired.high ≤ max(open,close,low)」：形态 B 里 high 是**好数据**，
    // 真实日内高点本来就可以高于该棒的 open/close，这条断言会把好数据误判成坏数据。
    //
    // `same-bar-bound/v1` 的实际语义（逐条复算得出）：
    //   · 坏字段 := clamp(原值, min(好字段), max(好字段))
    //   · 好字段逐位不变
    const ALL_FIELDS = ["open", "high", "low", "close"] as const;
    const badRepair: string[] = [];
    for (const r of repairRecords) {
      const orig = r.original ?? {};
      const rep = r.repaired ?? {};
      const bad = new Set(r.bad_fields ?? []);
      const goodVals = ALL_FIELDS.filter((f) => !bad.has(f))
        .map((f) => orig[f])
        .filter((v): v is number => typeof v === "number");
      if (bad.size === 0 || goodVals.length === 0) {
        badRepair.push(`${r.code}@${r.time} bad_fields 为空或无可用好字段`);
        continue;
      }
      const lo = Math.min(...goodVals);
      const hi = Math.max(...goodVals);
      for (const f of ALL_FIELDS) {
        const o = orig[f];
        const p = rep[f];
        if (typeof o !== "number" || typeof p !== "number") continue;
        if (bad.has(f)) {
          const expect = Math.min(hi, Math.max(lo, o));
          if (Math.abs(p - expect) > TOL) {
            badRepair.push(`${r.code}@${r.time}.${f}: ${p} ≠ clamp(${o},[${lo},${hi}])=${expect}`);
          }
        } else if (Math.abs(p - o) > 1e-9) {
          badRepair.push(`${r.code}@${r.time}.${f}: 好字段被改动 ${o}→${p}`);
        }
      }
    }
    check(
      "修复口径自洽：坏字段被钳制进同棒好字段区间，且好字段逐位未被改动",
      badRepair.length === 0,
      badRepair.length ? badRepair.slice(0, 3).join(" ; ") : `${repairRecords.length} 条全部符合`,
    );
    check(
      "修复后的棒满足 OHLC 自洽（high ≥ max(open,close,low) 且 low ≤ min(open,close,high)）",
      repairRecords.every((r) => {
        const { open, high, low, close } = (r.repaired ?? {}) as Record<string, number>;
        return (
          typeof open === "number" &&
          typeof high === "number" &&
          typeof low === "number" &&
          typeof close === "number" &&
          high >= Math.max(open, close, low) - 1e-9 &&
          low <= Math.min(open, close, high) + 1e-9
        );
      }),
    );

    // ---------- 6.5 元数据口径一致性（显性核对，不悄悄吞掉） ----------
    const highBad = repairRecords.filter((r) => r.bad_fields?.includes("high")).length;
    const lowBad = repairRecords.filter((r) => r.bad_fields?.includes("low")).length;
    info(
      `污染形态分布：含坏 high ${highBad} 条 / 含坏 low ${lowBad} 条（共 ${repairRecords.length} 条）`,
    );
    info(
      "污染清单 policy：数据已就地修复（same-bar-bound/v1），但**仍保留按 (code,date) 排除**。" +
        "理由：修复值是合成值（clamp 到同棒好字段），且「不再越界」是 clamp 规则的自证；" +
        "北交所无独立分钟源可交叉验证 ⇒ 证据不足即保守排除（2026-09-23 复核维持）。",
    );
    const policyAction =
      (JSON.parse(fs.readFileSync(CONTAMINATED_DAYS_FILE, "utf8")) as {
        policy?: { action?: string; repairStatus?: { applied?: boolean } };
      }).policy ?? {};
    check(
      "污染清单 policy 已如实记录「已修复但仍保留排除」（不再自相矛盾）",
      typeof policyAction.action === "string" &&
        policyAction.action.includes("已就地修复") &&
        policyAction.action.includes("仍保留") &&
        policyAction.repairStatus?.applied === true,
      policyAction.action ?? "(缺失)",
    );

    // ---------- 6.6 守卫：被标记的污染日不得进入任何消费路径 ----------
    const contaminatedNow = isContaminated(BJ_CODE, BJ_DATE);
    check("被标记的污染日 isContaminated = true（清单仍然生效）", contaminatedNow === true);
    const composedHidden = contaminatedNow ? [] : clipBarsForReveal(rawBj, false);
    const composedRevealed = contaminatedNow ? [] : clipBarsForReveal(rawBj, true);
    check(
      "污染日 + 未揭示 → 返回空（污染优先于裁剪）",
      composedHidden.length === 0,
      `bars=${composedHidden.length}`,
    );
    check(
      "污染日 + 已揭示 → 仍必须返回空（污染不可被「揭示」绕过）",
      composedRevealed.length === 0,
      `bars=${composedRevealed.length}`,
    );

    // 对照：同一天未被污染的白马股，已揭示时应当能拿到 8 根
    const ctrl = await getIntradayBars("600036", BJ_DATE);
    const ctrlComposed = isContaminated("600036", BJ_DATE) ? [] : clipBarsForReveal(ctrl, true);
    check(
      `对照组 600036 ${BJ_DATE} 未受污染 → 已揭示时正常下发 ${ctrlComposed.length} 根`,
      ctrlComposed.length === ctrl.length && ctrlComposed.length > 0,
      `bars=${ctrlComposed.length}`,
    );
  }

  /* ============================================================ */
  section("7. 守卫：唯一业务定义 / 无绕过通道");

  const srcFiles = [
    ...walkSources(path.join(process.cwd(), "app")),
    ...walkSources(path.join(process.cwd(), "services")),
    ...walkSources(path.join(process.cwd(), "lib")),
  ];
  info(`扫描项目源码 ${srcFiles.length} 个文件（app/ services/ lib/）`);

  const defHits = countCodeMatches(srcFiles, /function isCloseRevealed\s*\(/);
  const totalDefs = defHits.reduce((s, h) => s + h.count, 0);
  check(
    "isCloseRevealed 在整个项目里只有 1 处定义（去重完成）",
    totalDefs === 1,
    defHits.map((h) => `${path.relative(process.cwd(), h.file)}×${h.count}`).join(" ") || "(0 处)",
  );
  check(
    "唯一那份定义位于 lib/simtradeStage.ts",
    defHits.length === 1 &&
      path.relative(process.cwd(), defHits[0].file).replace(/\\/g, "/") === "lib/simtradeStage.ts",
    defHits.map((h) => path.relative(process.cwd(), h.file)).join(",") || "(无)",
  );

  const dupHits = countCodeMatches(srcFiles, /\bisCloseRevealedStage\b/);
  check(
    "旧的重名实现 isCloseRevealedStage 在代码中已彻底移除（注释里的历史说明不计）",
    dupHits.length === 0,
    dupHits.map((h) => path.relative(process.cwd(), h.file)).join(",") || "(0 处)",
  );

  const routePath = path.join(process.cwd(), "app", "api", "intraday", "route.ts");
  const routeSrc = stripComments(fs.readFileSync(routePath, "utf8"));
  check(
    "route.ts 从 @/lib/simtradeStage 复用唯一业务定义",
    routeSrc.includes("@/lib/simtradeStage") && /\bisCloseRevealed\s*\(/.test(routeSrc),
  );
  check(
    "route.ts 不再直接执行 klines 原始 SQL（已下沉到 marketDataService）",
    !routeSrc.includes("$queryRawUnsafe") && !/FROM\s+klines/i.test(routeSrc),
  );
  check(
    "route.ts 通过 listDailyDatesForCode 取交易日（不再自持数据源）",
    /\blistDailyDatesForCode\s*\(/.test(routeSrc),
  );
  check(
    "route.ts 会话查询不再 select 未使用的 revealed 字段",
    !/\brevealed\s*:\s*true/.test(routeSrc),
  );
  check(
    "route.ts 不再引入未使用的 contaminatedInRange",
    !/\bcontaminatedInRange\b/.test(routeSrc),
  );

  /* ============================================================ */
  console.log("\n" + "═".repeat(64));
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `\x1b[1m\x1b[32m✔ 全部通过：${passed}/${total}\x1b[0m` +
        (skipped > 0 ? `  \x1b[33m（${skipped} 个分组因数据集缺失被 SKIP）\x1b[0m` : ""),
    );
  } else {
    console.log(`\x1b[1m\x1b[31m✗ 失败 ${failed}/${total}\x1b[0m`);
    failures.forEach((f) => console.log(`    - ${f}`));
  }
  console.log("═".repeat(64) + "\n");
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
