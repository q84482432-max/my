/**
 * testSimTradeV3Intraday —— /api/intraday 会话模式 V3 分时契约验收
 *
 * 验证：
 *   - prevClose 是**前一交易日**收盘（不是当日开盘、不是当日收盘）
 *   - ticks 长度 == barCount + 1，首点是 09:30 锚点
 *   - ticks 中不含任何未揭示时点【防泄露】
 *   - changePercent 口径 = (price - prevClose)/prevClose*100
 *   - currentPrice == 最后一个已揭示收盘点
 *   - cumVolume 随节点单调递增，第 8 根 == 官方日K 成交量
 *   - 未揭示时 revealClose=false
 *
 * 运行：DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testSimTradeV3Intraday.ts')"
 */
import { GET } from "@/app/api/intraday/route";
import prisma from "@/lib/prisma";
import { INTRADAY_AXIS_TIMES, INTRADAY_TIMES, getIntradayBars } from "@/lib/intraday30m";
import { getKlineAt, getPrevKlineBefore } from "@/services/marketDataService";
import {
  advanceSimTradeIntraday,
  advanceSimTradeStage,
  createSimTradeSession,
  deleteSimTradeSession,
} from "@/services/simtradeService";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}
const near = (a: number | null | undefined, b: number | null | undefined, tol = 1e-2) =>
  a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= tol;

async function fetchSession(sessionId: string) {
  const res = await GET(
    new Request(`http://localhost/api/intraday?sessionId=${encodeURIComponent(sessionId)}`),
  );
  const json = (await res.json()) as { success: boolean; data?: Record<string, unknown> };
  if (!json.success || !json.data) throw new Error("接口返回失败: " + JSON.stringify(json));
  return json.data as {
    barCount: number;
    expectedBars: number;
    revealClose: boolean;
    intradayBarCount: number;
    fullDayRevealed: boolean;
    prevClose: number | null;
    ticks: { time: string; price: number; changePercent: number | null; volume: number }[];
    times: string[];
    cumVolume: number;
    currentPrice: number | null;
    currentChangePercent: number | null;
    intradayAvailable: boolean;
  };
}

async function main(): Promise<void> {
  /* ⚠️ 会话创建需要「重试到起始日 30m 数据齐全」。
     原因（2026-09-23 实测到本文件偶发 58/5 红）：会话的起始交易日是在**全历史**里
     随机定位的，而 30m parquet 只覆盖 2024-11-04 之后。若随机落到更早的日期，
     当日 30m 根数 != 8，本文件后续**所有**分时契约断言（ticks 长度、cumVolume、
     锚点、揭示进度）都会连锁失败 —— 属测试夹具的确定性不足，不是产品缺陷。 */
  let created = await createSimTradeSession({ name: "V3-INTRADAY", tradingDays: 20 });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!created.success || !created.session) {
      created = await createSimTradeSession({ name: "V3-INTRADAY", tradingDays: 20 });
      continue;
    }
    const probe = await prisma.simTradeSession.findUnique({
      where: { id: created.session.id },
      select: { hiddenStockCode: true },
    });
    const probeBars = probe
      ? await getIntradayBars(probe.hiddenStockCode, created.session.startDate)
      : [];
    if (probeBars.length === 8) break;
    // 起始日 30m 不全 → 换一局重试，并把这一局清掉
    await deleteSimTradeSession(created.session.id);
    created = await createSimTradeSession({ name: "V3-INTRADAY", tradingDays: 20 });
  }
  if (!created.success || !created.session) throw new Error("创建失败: " + created.message);
  const id = created.session.id;
  const row = await prisma.simTradeSession.findUnique({ where: { id } });
  if (!row) throw new Error("会话行缺失");
  const code = row.hiddenStockCode;
  const date = created.session.startDate;

  const allBars = await getIntradayBars(code, date);
  const dailyBar = await getKlineAt(code, date);
  const prevBar = await getPrevKlineBefore(code, date, row.adjust as never);
  const fullDay30mVol = allBars.reduce((s, b) => s + b.volume, 0);
  const finalVolume = dailyBar?.volume ?? 0;
  const vFactor = fullDay30mVol > 0 ? finalVolume / fullDay30mVol : 1;

  console.log(`会话 id=${id} 标的=${code} 日期=${date}`);
  console.log(`前收(独立取)=${prevBar?.close}  当日开盘=${dailyBar?.open}  当日收盘=${dailyBar?.close}  8根=${allBars.length}`);
  console.log(`量纲因子=${vFactor.toFixed(6)}`);

  /* ---------- 第 1 根（初始游标 1） ---------- */
  /* 2026-09-25：游标改为从 0 起算 —— 新建会话的初始状态是「一根 30m K 都没走完」，
     此时 ticks 只有 09:30 开盘锚点一个点（barCount=0、ticks.length=1）。 */
  console.log("\n=== 游标 0（未推进：只揭示开盘价）===");
  let d = await fetchSession(id);
  check("prevClose == 前一交易日收盘（≠当日开盘）", near(d.prevClose, prevBar?.close), `实际=${d.prevClose} 期望=${prevBar?.close}`);
  check("prevClose != 当日收盘【不泄露】", !near(d.prevClose, dailyBar?.close, 1e-6), `prevClose=${d.prevClose} 当日收盘=${dailyBar?.close}`);
  check("times == 09:30 + 8 个标准时点（共 9）", d.times.length === 9 && d.times[0] === "09:30", `实际=${JSON.stringify(d.times)}`);
  check("times[1..] == INTRADAY_TIMES", d.times.slice(1).join(",") === INTRADAY_TIMES.map((t) => t.slice(0, 5)).join(","));
  check("ticks.length == barCount + 1", d.ticks.length === d.barCount + 1, `ticks=${d.ticks.length} barCount=${d.barCount}`);
  check("ticks[0].time == 09:30", d.ticks[0]?.time === "09:30", `实际=${d.ticks[0]?.time}`);
  /* ★ 防回归（2026-09-25）：/api/intraday 里曾有一个 `Math.max(row.intradayBarCount, 1)`
     兜底，把游标 0 悄悄抬回 1，于是 ticks 多出 10:00、把本不该存在的
     09:30→10:00 曲线画了出来（用户实测反馈）。这条断言直接锁死「开盘只看得到开盘价」。 */
  check("游标 0：barCount = 0（一根 30m K 都还没走完）", d.barCount === 0, `实际=${d.barCount}`);
  check(
    "★ 游标 0：**不得出现 10:00 及以后的时点**（否则会画出 09:30→10:00 曲线）",
    d.ticks.every((t) => t.time === "09:30"),
    JSON.stringify(d.ticks.map((t) => t.time)),
  );
  if (allBars.length > 0) {
    check("09:30 锚点价 == 第1根30m open", near(d.ticks[0]?.price, allBars[0].open), `实际=${d.ticks[0]?.price} 期望=${allBars[0].open}`);
  }
  check("revealClose = false【未揭示】", d.revealClose === false, `实际=${d.revealClose}`);
  check("currentPrice == 最后一点价格", near(d.currentPrice, d.ticks[d.ticks.length - 1]?.price), `实际=${d.currentPrice}`);

  /* ---------- 逐节点推进 ---------- */
  console.log("\n=== 逐节点推进（1→7）===");
  for (let n = 1; n <= 7; n += 1) {
    // 初始游标为 0，故每轮都要先推进一根（改前初始为 1，只在 n>1 时推进）
    await advanceSimTradeIntraday(id);
    d = await fetchSession(id);
    check(`N=${n}: barCount == ${n}`, d.barCount === n, `实际=${d.barCount}`);
    check(`N=${n}: ticks.length == ${n + 1}`, d.ticks.length === n + 1, `实际=${d.ticks.length}`);

    // 防泄漏：不得出现任何「大于第 n 个时点」的 tick
    const cutoff = INTRADAY_TIMES[n - 1].slice(0, 5);
    const future = d.ticks.filter((t) => t.time !== "09:30" && t.time > cutoff);
    check(`N=${n}: 不含晚于 ${cutoff} 的时点【防泄露】`, future.length === 0, `越界=${JSON.stringify(future)}`);

    // 涨跌幅口径
    const last = d.ticks[d.ticks.length - 1];
    if (d.prevClose) {
      const exp = Math.round(((last.price - d.prevClose) / d.prevClose) * 100 * 100) / 100;
      check(`N=${n}: changePercent 口径正确`, near(last.changePercent, exp, 0.02), `实际=${last.changePercent} 期望≈${exp}`);
    }
    // 累计成交量单调递增且 < 全天量
    if (allBars.length === 8) {
      const expCum = Math.round(allBars.slice(0, n).reduce((s, b) => s + b.volume, 0) * vFactor);
      check(`N=${n}: cumVolume == 前${n}根累计(${expCum})`, near(d.cumVolume, expCum, 2), `实际=${d.cumVolume}`);
      check(`N=${n}: cumVolume < 全天量(${finalVolume})【防泄露】`, d.cumVolume < finalVolume, `实际=${d.cumVolume}`);
    }
    check(`N=${n}: revealClose=false【防泄露】`, d.revealClose === false);
    console.log(`    → ticks=${d.ticks.map((t) => `${t.time}:${t.price}`).join(" ")} cum=${d.cumVolume}`);
  }

  /* ---------- 揭示收盘后 ---------- */
  console.log("\n=== 揭示收盘（CLOSE_ANIMATION）===");
  await advanceSimTradeStage(id);
  d = await fetchSession(id);
  check("revealClose = true", d.revealClose === true, `实际=${d.revealClose}`);
  check("fullDayRevealed = true", d.fullDayRevealed === true);
  check("ticks.length == 9（8根+锚点）", d.ticks.length === 9, `实际=${d.ticks.length}`);
  check(
    "cumVolume == 官方日K成交量（量纲一致）",
    allBars.length === 8 ? near(d.cumVolume, finalVolume, 2) : true,
    `实际=${d.cumVolume} 期望=${finalVolume}`,
  );
  check(
    "最后一点价格 == 当日收盘",
    near(d.ticks[d.ticks.length - 1].price, dailyBar?.close),
    `实际=${d.ticks[d.ticks.length - 1].price} 期望=${dailyBar?.close}`,
  );

  await deleteSimTradeSession(id);

  console.log("\n" + "=".repeat(64));
  console.log(`通过 ${passed} / 失败 ${failed}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log("=".repeat(64));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("ERR", e);
    await prisma.$disconnect();
    process.exit(1);
  });
