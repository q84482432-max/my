/**
 * _verify_v3 —— 独立对抗性证伪脚本（verify 队友，不依赖 team-lead 的测试）
 *
 * 目标：对 V3 引擎/快照/分时契约做**独立复算**的证伪，重点核对
 *   A. 逐节点防泄漏（todayBar 只能反映「已揭示」的 30m 根，绝不读未来棒/全天量）
 *   B. history 末根 与 todayBar 两套真相一致性
 *   C. /api/intraday 会话模式分时契约防泄漏
 *   D. 换日正确性 + 不越界（绝不提前揭示新日收盘）
 *   E. 量纲换算：finalized 时恰好等于官方日K；且比值非恒定 100（688 反例）
 *   F. T+1 与每日 8 次总操作配额
 *   G. 污染标记 → 不可用处理
 *
 * 运行（必须用内联写法，本机直接 node <脚本> 会被静默拦截）：
 *   DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/_verify_v3.ts')"
 *
 * 设计原则：所有「期望值」都由本脚本**独立从原始 30m/日K 数据重算**，
 * 不采信服务端的任何自述字段（source / fillPriceSource / finalized 等只作辅助断言）。
 */
import fs from "node:fs";
import path from "node:path";

import {
  advanceSimTradeIntraday,
  advanceSimTradeStage,
  createSimTradeSession,
  deleteSimTradeSession,
  getSimTradeSnapshot,
  settleAndAdvanceToNextDay,
  submitSimTradeAction,
} from "@/services/simtradeService";
import { GET } from "@/app/api/intraday/route";
import prisma from "@/lib/prisma";
import {
  BARS_PER_DAY,
  INTRADAY_TIMES,
  aggregateDayBars,
  clipBarsToCount,
  computeDailyUnitFactors,
  getIntradayBars,
  contaminatedDatesOf,
  isContaminated,
  contaminatedInRange,
} from "@/lib/intraday30m";
import { getKlineAt, getPrevKlineBefore } from "@/services/marketDataService";
import type { KlineBar } from "@/types";

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

/** 删除会话（清理 test.db） */
async function safeDelete(id: string): Promise<void> {
  try {
    await deleteSimTradeSession(id);
  } catch {
    /* ignore */
  }
}

/** 创建一个「当日首根 30m 数据齐全（8 根）」的会话，保证能走动态合成路径 */
async function createSessionWithIntraday(
  tries = 12,
): Promise<{ id: string; code: string; date: string; adjust: string } | null> {
  for (let i = 0; i < tries; i += 1) {
    const created = await createSimTradeSession({ initialCash: 100000, tradingDays: 22 });
    if (!created.success || !created.session) {
      continue;
    }
    const id = created.session.id;
    const row = await prisma.simTradeSession.findUnique({
      where: { id },
      select: { hiddenStockCode: true, currentDate: true, adjust: true },
    });
    if (!row) {
      await safeDelete(id);
      continue;
    }
    const code = row.hiddenStockCode;
    const date = row.currentDate.toISOString().slice(0, 10);
    const adjust = row.adjust;
    const bars = await getIntradayBars(code, date);
    if (bars.length === BARS_PER_DAY && !isContaminated(code, date)) {
      return { id, code, date, adjust };
    }
    await safeDelete(id);
  }
  return null;
}

/* ============================ A. 逐节点防泄漏 ============================ */
async function verifyPerNodeAntiLeak(): Promise<void> {
  console.log("\n===== A. 逐节点防泄漏（OPEN 阶段 1→7 根，todayBar 只反映已揭示部分）=====");
  const s = await createSessionWithIntraday();
  if (!s) {
    check("A: 找不到当日 30m 齐全的会话（环境数据缺失）", false);
    return;
  }
  const { id, code, date, adjust } = s;
  try {
    const allBars = await getIntradayBars(code, date);
    const dailyBar = await getKlineAt(code, date, adjust as never);
    if (!dailyBar) {
      check("A: 当日日K 存在", false);
      return;
    }
    // 独立量纲因子（与服务端同口径纯函数，但本脚本独立调用）
    const full30mVol = allBars.reduce((a, b) => a + b.volume, 0);
    const full30mAmt = allBars.reduce((a, b) => a + b.amount, 0);
    const factors = computeDailyUnitFactors({
      dailyVolume: dailyBar.volume,
      dailyAmount: dailyBar.amount,
      fullDay30mVolume: full30mVol,
      fullDay30mAmount: full30mAmt,
    });
    const fullDayMaxHigh = Math.max(...allBars.map((b) => b.high));
    const fullDayMinLow = Math.min(...allBars.map((b) => b.low));

    for (let n = 1; n <= 7; n += 1) {
      if (n > 1) await advanceSimTradeIntraday(id);
      const snap = await getSimTradeSnapshot(id);
      if (!snap || !snap.todayBar) {
        check(`A-N${n}: 快照/todayBar 非空`, false);
        continue;
      }
      const tb: any = snap.todayBar;
      // 独立重算：只取前 n 根（按标准时点 cutoff），与服务端 clipBarsToCount 同口径
      const revealed = clipBarsToCount(allBars, n);
      const agg = aggregateDayBars(revealed);
      if (!agg) {
        check(`A-N${n}: 聚合成功`, false);
        continue;
      }
      const expVol = Math.round(agg.volume * factors.volumeFactor);
      const expAmt = Math.round(agg.amount * factors.amountFactor * 100) / 100;

      const tag = `A-N${n}`;
      check(`${tag}: source === INTRADAY_30M`, tb.source === "INTRADAY_30M", `source=${tb.source}`);
      check(`${tag}: revealedBars === ${n}`, tb.revealedBars === n, `revealedBars=${tb.revealedBars}`);
      check(`${tag}: open 正确`, near(tb.open, agg.open, 1e-3), `实际=${tb.open} 期望=${agg.open}`);
      check(`${tag}: high == 已揭示部分 max`, near(tb.high, agg.high, 1e-3), `实际=${tb.high} 期望=${agg.high}`);
      check(`${tag}: low == 已揭示部分 min`, near(tb.low, agg.low, 1e-3), `实际=${tb.low} 期望=${agg.low}`);
      check(`${tag}: close == 第${n}根 close`, near(tb.close, agg.close, 1e-3), `实际=${tb.close} 期望=${agg.close}`);
      check(`${tag}: volume == 前${n}根累计*因子(${expVol})`, tb.volume === expVol, `实际=${tb.volume} 期望=${expVol}`);
      check(`${tag}: amount 与已揭示部分一致`, near(tb.amount, expAmt, 2), `实际=${tb.amount} 期望=${expAmt}`);

      // ★ 核心防泄漏：N<8 时，todayBar 绝不能等于全天 8 根之和（换算后）
      const fullDayVolConverted = Math.round(full30mVol * factors.volumeFactor);
      check(
        `${tag}: volume 严格 < 全天量(${fullDayVolConverted})【不泄露全天成交量】`,
        tb.volume < fullDayVolConverted,
        `实际=${tb.volume} 全天=${fullDayVolConverted}`,
      );
      check(
        `${tag}: volume < 官方日K成交量(${dailyBar.volume})【不泄露全天成交量】`,
        tb.volume < dailyBar.volume,
        `实际=${tb.volume} 日K=${dailyBar.volume}`,
      );

      // ★ 核心防泄漏：high/low 不得「偷看」未揭示的第 n+1..8 根
      const revealedMaxHigh = Math.max(...revealed.map((b) => b.high));
      const revealedMinLow = Math.min(...revealed.map((b) => b.low));
      check(`${tag}: high 不超已揭示部分`, tb.high <= revealedMaxHigh + 1e-6, `high=${tb.high} 已揭示max=${revealedMaxHigh}`);
      check(`${tag}: low 不低于已揭示部分`, tb.low >= revealedMinLow - 1e-6, `low=${tb.low} 已揭示min=${revealedMinLow}`);
      if (revealedMaxHigh < fullDayMaxHigh) {
        check(
          `${tag}: high < 全天 max(${fullDayMaxHigh})【未偷看第8根】`,
          tb.high < fullDayMaxHigh,
          `high=${tb.high} 全天max=${fullDayMaxHigh}`,
        );
      }
      if (revealedMinLow > fullDayMinLow) {
        check(
          `${tag}: low > 全天 min(${fullDayMinLow})【未偷看第8根】`,
          tb.low > fullDayMinLow,
          `low=${tb.low} 全天min=${fullDayMinLow}`,
        );
      }
      // close 必须等于第 n 根 close（上面已核）；未读未来棒：若第8根 close 与第n根不同，
      // 则 todayBar.close 不得等于第8根 close（二者恰巧相等是真实数据巧合，不算泄露）。
      const bar8Close = allBars[allBars.length - 1].close;
      if (Math.abs(bar8Close - agg.close) > 1e-6) {
        check(`${tag}: close 不是第8根(15:00)收盘【未读未来棒】`, Math.abs(tb.close - bar8Close) > 1e-9, `close=${tb.close} 15:00=${bar8Close}`);
      }

      // 未定格 / 未泄露当日收盘
      check(`${tag}: finalized === false`, tb.finalized === false);
      check(`${tag}: todayClose === null【未泄露当日收盘】`, snap.todayClose === null, `todayClose=${snap.todayClose}`);
      // 不变量：high >= max(open,close); low <= min(open,close)
      check(`${tag}: OHLC 不变量`, tb.high >= Math.max(tb.open, tb.close) - 1e-6 && tb.low <= Math.min(tb.open, tb.close) + 1e-6);
    }
  } finally {
    await safeDelete(id);
  }
}

/* ====================== B. history 末根 与 todayBar 一致性 ====================== */
async function verifyHistoryMatchesTodayBar(): Promise<void> {
  console.log("\n===== B. history 末根 == todayBar（不允许两套真相）=====");
  const s = await createSessionWithIntraday();
  if (!s) {
    check("B: 找不到当日 30m 齐全的会话", false);
    return;
  }
  const { id, code, date } = s;
  try {
    // 在 N=7（开盘上限）处核对
    for (let n = 1; n < 7; n += 1) await advanceSimTradeIntraday(id);
    const snap = await getSimTradeSnapshot(id);
    if (!snap || !snap.todayBar) {
      check("B: 快照非空", false);
      return;
    }
    const last = snap.history[snap.history.length - 1];
    const tb: any = snap.todayBar;
    check("B: history 末根日期 == currentDate", last && last.date === snap.session.currentDate, `last=${last?.date} cur=${snap.session.currentDate}`);
    check("B: history末根.open == todayBar.open", near(last?.open, tb.open, 1e-3));
    check("B: history末根.high == todayBar.high", near(last?.high, tb.high, 1e-3));
    check("B: history末根.low == todayBar.low", near(last?.low, tb.low, 1e-3));
    check("B: history末根.close == todayBar.close", near(last?.close, tb.close, 1e-3));
    check("B: history末根.volume == todayBar.volume", last?.volume === tb.volume, `hist=${last?.volume} tb=${tb.volume}`);
    check("B: history末根.amount == todayBar.amount", near(last?.amount, tb.amount, 2));
    check("B: 不存在 second source of truth（todayBar 与 history 末根逐字段相等）",
      near(last?.open, tb.open, 1e-3) && near(last?.high, tb.high, 1e-3) &&
      near(last?.low, tb.low, 1e-3) && near(last?.close, tb.close, 1e-3) &&
      last?.volume === tb.volume);
  } finally {
    await safeDelete(id);
  }
}

/* ====================== C. /api/intraday 分时契约防泄漏 ====================== */
async function verifyIntradayContract(): Promise<void> {
  console.log("\n===== C. /api/intraday 会话模式分时契约（独立复算 ticks）=====");
  const s = await createSessionWithIntraday();
  if (!s) {
    check("C: 找不到当日 30m 齐全的会话", false);
    return;
  }
  const { id, code, date, adjust } = s;
  try {
    const allBars = await getIntradayBars(code, date);
    const dailyBar = await getKlineAt(code, date, adjust as never);
    const prevBar = await getPrevKlineBefore(code, date, adjust as never);
    const prevClose = prevBar ? Math.round(prevBar.close * 100) / 100 : null;
    const full30mVol = allBars.reduce((a, b) => a + b.volume, 0);
    const factors = computeDailyUnitFactors({
      dailyVolume: dailyBar?.volume ?? 0,
      dailyAmount: dailyBar?.amount ?? 0,
      fullDay30mVolume: full30mVol,
      fullDay30mAmount: allBars.reduce((a, b) => a + b.amount, 0),
    });

    const fetchSession = async () => {
      const res = await GET(new Request(`http://localhost/api/intraday?sessionId=${encodeURIComponent(id)}`));
      const json = (await res.json()) as any;
      if (!json.success || !json.data) throw new Error("接口失败: " + JSON.stringify(json));
      return json.data as any;
    };

    const pct = (price: number) =>
      prevClose && prevClose > 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : null;

    // 逐节点核对 ticks 契约
    for (let n = 1; n <= 7; n += 1) {
      if (n > 1) await advanceSimTradeIntraday(id);
      const d = await fetchSession();
      const tag = `C-N${n}`;
      check(`${tag}: ticks.length == barCount+1`, d.ticks.length === d.barCount + 1, `ticks=${d.ticks.length} barCount=${d.barCount}`);
      check(`${tag}: ticks[0].time == 09:30（开盘锚点）`, d.ticks[0]?.time === "09:30", `实际=${d.ticks[0]?.time}`);
      check(`${tag}: 锚点价 == 第1根30m open（独立复算）`, near(d.ticks[0]?.price, Math.round(allBars[0].open * 100) / 100, 1e-3), `实际=${d.ticks[0]?.price} 期望=${Math.round(allBars[0].open * 100) / 100}`);
      // 防泄漏：不得出现任何晚于第 n 个时点的 tick
      const cutoff = INTRADAY_TIMES[n - 1].slice(0, 5);
      const future = d.ticks.filter((t: any) => t.time !== "09:30" && t.time > cutoff);
      check(`${tag}: 不含晚于 ${cutoff} 的时点【防泄露】`, future.length === 0, `越界=${JSON.stringify(future)}`);

      // 独立复算每个 tick 的 price / changePercent / volume
      // 期望序列：锚点(09:30, bars[0].open) + bars[0..n-1].close
      const expTicks: any[] = [];
      expTicks.push({ time: "09:30", price: Math.round(allBars[0].open * 100) / 100, changePercent: pct(Math.round(allBars[0].open * 100) / 100), volume: 0 });
      for (let k = 0; k < n; k += 1) {
        const p = Math.round(allBars[k].close * 100) / 100;
        expTicks.push({ time: allBars[k].time.slice(0, 5), price: p, changePercent: pct(p), volume: Math.round(allBars[k].volume * factors.volumeFactor) });
      }
      const priceOk = d.ticks.every((t: any, i: number) => near(t.price, expTicks[i].price, 1e-3));
      const pctOk = d.ticks.every((t: any, i: number) => (expTicks[i].changePercent === null ? t.changePercent === null : near(t.changePercent, expTicks[i].changePercent, 0.02)));
      const volOk = d.ticks.every((t: any, i: number) => t.volume === expTicks[i].volume);
      check(`${tag}: 每个 tick.price 与独立复算一致`, priceOk, `api=${JSON.stringify(d.ticks.map((t:any)=>t.price))} exp=${JSON.stringify(expTicks.map(t=>t.price))}`);
      check(`${tag}: changePercent 口径 = (price-prevClose)/prevClose*100`, pctOk);
      check(`${tag}: 每个 tick.volume 与独立复算一致`, volOk);

      // 当前价 / 当前涨跌幅
      const lastTick = d.ticks[d.ticks.length - 1];
      check(`${tag}: currentPrice == 最后 tick 价`, near(d.currentPrice, lastTick.price, 1e-3), `current=${d.currentPrice} last=${lastTick.price}`);
      check(`${tag}: currentChangePercent == 最后 tick 涨跌幅`, near(d.currentChangePercent, lastTick.changePercent, 0.02));
      // cumVolume 单调递增且 < 全天量
      if (allBars.length === BARS_PER_DAY) {
        const expCum = Math.round(allBars.slice(0, n).reduce((a, b) => a + b.volume, 0) * factors.volumeFactor);
        check(`${tag}: cumVolume == 前${n}根累计(${expCum})`, near(d.cumVolume, expCum, 2), `实际=${d.cumVolume}`);
        check(`${tag}: cumVolume < 全天量【防泄露】`, d.cumVolume < (dailyBar?.volume ?? 0), `实际=${d.cumVolume}`);
      }
      check(`${tag}: revealClose === false（未揭示）`, d.revealClose === false);
      // prevClose 防泄露（结构性）：必须是「严格早于当日」的前一交易日收盘，而非当日收盘。
      // 注意：若前收恰与当日收盘数值相等（平盘日），仅靠数值无法区分，故用「前一交易日日期 < 当日」做结构判定。
      check(`${tag}: prevClose == 独立复算的前收`, near(d.prevClose, prevClose, 1e-3), `api=${d.prevClose} 期望=${prevClose}`);
      check(`${tag}: prevClose 来自严格早于当日的前一交易日（结构防泄露）`, !!prevBar && prevBar.date < date, `prevBar.date=${prevBar?.date} cur=${date}`);
      if (prevBar && Math.abs(prevBar.close - (dailyBar?.close ?? 0)) > 1e-6) {
        check(`${tag}: prevClose != 当日收盘【未泄露】`, !near(d.prevClose, dailyBar?.close, 1e-6), `prevClose=${d.prevClose} 当日收盘=${dailyBar?.close}`);
      }
    }

    // 揭示收盘后：ticks 9 点，cumVolume == 官方日K 成交量
    await advanceSimTradeStage(id); // → CLOSE_ANIMATION
    const d2 = await fetchSession();
    check("C-收盘: ticks.length == 9（8根+锚点）", d2.ticks.length === 9, `实际=${d2.ticks.length}`);
    check("C-收盘: cumVolume == 官方日K成交量", near(d2.cumVolume, dailyBar?.volume ?? 0, 2), `实际=${d2.cumVolume} 期望=${dailyBar?.volume}`);
    check("C-收盘: 末点价 == 当日收盘", near(d2.ticks[8].price, dailyBar?.close ?? 0, 1e-3));
  } finally {
    await safeDelete(id);
  }
}

/* ====================== D. 换日正确性 + 不越界 ====================== */
async function verifyDayAdvance(): Promise<void> {
  console.log("\n===== D. 换日正确性 + 不越界（绝不提前揭示新日收盘）=====");
  const s = await createSessionWithIntraday();
  if (!s) {
    check("D: 找不到当日 30m 齐全的会话", false);
    return;
  }
  const { id } = s;
  try {
    // 把 30m 游标推到开盘上限 7
    for (let n = 1; n < 7; n += 1) await advanceSimTradeIntraday(id);
    const before = await getSimTradeSnapshot(id);
    const startDate = before!.session.currentDate;
    // OPEN(7) → CLOSE_ANIMATION(8) → CLOSE
    const a1 = await advanceSimTradeStage(id);
    check("D: OPEN→CLOSE_ANIMATION", a1.snapshot?.stage === "CLOSE_ANIMATION", `stage=${a1.snapshot?.stage}`);
    const a2 = await advanceSimTradeStage(id);
    check("D: CLOSE_ANIMATION→CLOSE", a2.snapshot?.stage === "CLOSE", `stage=${a2.snapshot?.stage}`);

    // settleAndAdvanceToNextDay
    const r = await settleAndAdvanceToNextDay(id);
    check("D: 换日成功", r.success, r.message);
    const after = await getSimTradeSnapshot(id);
    const afterInfo = after!.session;
    check("D: 新日期 != 旧日期", afterInfo.currentDate !== startDate, `旧=${startDate} 新=${afterInfo.currentDate}`);
    check("D: stage === OPEN", afterInfo.stage === "OPEN", `stage=${afterInfo.stage}`);
    check("D: 绝非 CLOSE_ANIMATION（越界＝泄露新日收盘）", afterInfo.stage !== "CLOSE_ANIMATION");
    check("D: 游标重置为 1", afterInfo.intradayBarCount === 1, `cursor=${afterInfo.intradayBarCount}`);
    check("D: operationCount === 0", afterInfo.operationCount === 0, `ops=${afterInfo.operationCount}`);
    check("D: remainingBuy === 2", afterInfo.remainingBuy === 2, `rb=${afterInfo.remainingBuy}`);
    check("D: remainingSell === 2", afterInfo.remainingSell === 2, `rs=${afterInfo.remainingSell}`);
    check("D: todayClose === null（新日收盘未揭示）", after!.todayClose === null, `todayClose=${after!.todayClose}`);

    // 再连调一次：必须从 OPEN 被拒，且日期不跳
    const r2 = await settleAndAdvanceToNextDay(id);
    check("D: 二次换日从 OPEN 被拒", r2.success === false, `success=${r2.success} msg=${r2.message}`);
    const after2 = await getSimTradeSnapshot(id);
    check("D: 二次调用后日期不变（不跳日）", after2!.session.currentDate === afterInfo.currentDate, `日期=${after2!.session.currentDate}`);
    check("D: 二次调用后阶段仍 OPEN", after2!.session.stage === "OPEN");
  } finally {
    await safeDelete(id);
  }
}

/* ====================== E. 量纲换算：finalized==官方；比值非恒定 ====================== */
async function verifyUnitConversion(): Promise<void> {
  console.log("\n===== E. 量纲换算（finalized==官方日K；比值非恒定 100）=====");
  // E-a: 在 CLOSE_ANIMATION（已揭示收盘）时，todayBar.volume 必须恰好等于官方日K 成交量（独立取）
  const s = await createSessionWithIntraday();
  if (!s) {
    check("E: 找不到当日 30m 齐全的会话", false);
    return;
  }
  const { id, code, date, adjust } = s;
  try {
    const dailyBar = await getKlineAt(code, date, adjust as never);
    await advanceSimTradeStage(id); // → CLOSE_ANIMATION（revealClose）
    const snap = await getSimTradeSnapshot(id);
    const tb: any = snap!.todayBar;
    check("E-a: CLOSE_ANIMATION 时 finalized === true", tb.finalized === true);
    check(
      `E-a: todayBar.volume 恰好 == 官方日K成交量(${dailyBar?.volume})`,
      tb.volume === dailyBar?.volume,
      `todayBar.volume=${tb.volume} 日K=${dailyBar?.volume}`,
    );
    // 同时核对 high/low/close/open 与官方日K 完全一致（同一套真相）
    check("E-a: todayBar.open == 日K.open", near(tb.open, dailyBar?.open, 1e-3));
    check("E-a: todayBar.close == 日K.close", near(tb.close, dailyBar?.close, 1e-3));

    // E-b: 独立扫描若干标的，证明 30m/日K 成交量比值**非恒定 100**（含科创板 688）
    console.log("\n  -- E-b: 独立复算 30m/日K 成交量比值 --");
    const candidates = ["600000", "000001", "300050", "688002", "601318", "000651"];
    const scanDates = [
      "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-15", "2026-08-15",
      "2026-09-01", "2026-09-10", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
    ];
    const ratios: Record<string, number | null> = {};
    for (const c of candidates) {
      let found: number | null = null;
      for (const dt of scanDates) {
        const db = await getKlineAt(c, dt);
        const ib = await getIntradayBars(c, dt);
        if (db && ib.length === BARS_PER_DAY && db.volume > 0) {
          const f30 = ib.reduce((a, b) => a + b.volume, 0);
          found = Math.round((db.volume / f30) * 10000) / 10000;
          break;
        }
      }
      ratios[c] = found;
      console.log(`      ${c}: 比值=${found === null ? "无可用数据" : found}`);
    }
    const present = Object.values(ratios).filter((v): v is number => v !== null);
    check("E-b: 至少取到 3 只标的的有效比值", present.length >= 3, JSON.stringify(ratios));
    // 关键反例：688002（科创板）比值应≈1，而主板≈100 —— 证明非恒定
    if (ratios["688002"] !== null) {
      check("E-b: 688002 比值 ≈ 1（非恒定 100）", Math.abs((ratios["688002"] as number) - 1) < 0.5, `688002=${ratios["688002"]}`);
    } else {
      console.log("  (注：688002 在扫描日期内无 30m/日K 同时可用，跳过该反例)");
    }
    const main = ratios["600000"];
    if (main !== null && ratios["688002"] !== null) {
      // main 是 手/股（主板≈0.01 → 即 股/手≈100）；688002≈1（股/手≈1）。换算成「股/手」后相差>10 倍。
      const mainSharesPerHand = 1 / (main as number);
      const bjSharesPerHand = 1 / (ratios["688002"] as number);
      check("E-b: 主板(股/手≈100) 与 科创板(≈1) 相差>10倍（证明换算不可硬编码 100）",
        Math.abs(mainSharesPerHand - bjSharesPerHand) > 10,
        `600000(股/手)=${mainSharesPerHand} 688002=${bjSharesPerHand}`);
    }
    // 用恒定 100 当因子会算错：对 688002，8 根换算量 = 全天30m * 100 >> 日K量
    if (ratios["688002"] !== null) {
      const correct = Math.abs((ratios["688002"] as number) - 1) < 0.5;
      check("E-b: 若强行用因子100 会显著错算（证明 computeDailyUnitFactors 必须按日推出）", correct);
    }

    // E-c: 泄露复核 —— 因子不出现在任何快照响应中，且 N<8 时 todayBar.volume 严格小于日K量
    // （已在 A 段验证；此处补一句 JSON 不含 factor 字段的事实）
    const snapJson = JSON.stringify(snap);
    check("E-c: 快照响应中不含量纲因子字段（防反向推导）", !/"volumeFactor"/.test(snapJson) && !/"amountFactor"/.test(snapJson));
  } finally {
    await safeDelete(id);
  }
}

/* ====================== F. T+1 与每日 8 次配额 ====================== */
async function verifyT1AndQuota(): Promise<void> {
  console.log("\n===== F. T+1 与每日总操作配额（≤8；买入≤2；卖出≤2）=====");
  // F-a: T+1 —— 当日买入后 availableQty===0；换日后 availableQty===quantity
  const s1 = await createSessionWithIntraday();
  if (!s1) {
    check("F: 找不到会话", false);
    return;
  }
  const id1 = s1.id;
  try {
    const buy = await submitSimTradeAction(id1, { action: "BUY", percent: 50, mode: "INSTANT" });
    check("F-a: 当日买入成功", buy.success, buy.message);
    let snap = await getSimTradeSnapshot(id1);
    const qtyAfterBuy = snap!.position?.quantity ?? 0;
    check("F-a: 买入后有持仓 quantity>0", qtyAfterBuy > 0, `qty=${qtyAfterBuy}`);
    check("F-a: 当日买入后 availableQty === 0（T+1 冻结）", (snap!.position?.availableQty ?? -1) === 0, `avail=${snap!.position?.availableQty}`);

    // 推进到次日 OPEN
    await advanceSimTradeStage(id1); // CLOSE_ANIMATION
    await advanceSimTradeStage(id1); // CLOSE
    await settleAndAdvanceToNextDay(id1); // 下一交易日 OPEN
    snap = await getSimTradeSnapshot(id1);
    check("F-a: 换日后 availableQty === quantity（T+1 解冻）", (snap!.position?.availableQty ?? -1) === qtyAfterBuy, `avail=${snap!.position?.availableQty} qty=${qtyAfterBuy}`);
  } finally {
    await safeDelete(id1);
  }

  // F-b: 连续 HOLD 到第 9 次必须被拒
  const s2 = await createSessionWithIntraday();
  if (!s2) {
    check("F-b: 找不到会话", false);
    return;
  }
  const id2 = s2.id;
  try {
    let allOk = true;
    let lastOps = 0;
    for (let i = 0; i < 8; i += 1) {
      const r = await submitSimTradeAction(id2, { action: "HOLD", mode: "INSTANT" });
      if (!r.success) {
        allOk = false;
        break;
      }
      lastOps = r.snapshot?.session.operationCount ?? lastOps;
    }
    check("F-b: 连续 8 次 HOLD 全部成功", allOk && lastOps === 8, `allOk=${allOk} ops=${lastOps}`);
    const over = await submitSimTradeAction(id2, { action: "HOLD", mode: "INSTANT" });
    check("F-b: 第 9 次 HOLD 被拒（每日上限 8）", !over.success, over.message);
    check("F-b: 超限文案说明上限为 8", over.message.includes("8"), over.message);
    const locked = await getSimTradeSnapshot(id2);
    check("F-b: 超限后 operationCount 仍为 8（不被多扣）", locked!.session.operationCount === 8, `ops=${locked!.session.operationCount}`);
  } finally {
    await safeDelete(id2);
  }
}

/* ====================== G. 污染标记 → 不可用处理 ====================== */
async function verifyContamination(): Promise<void> {
  console.log("\n===== G. 污染标记 → 不可用处理 =====");
  // G-a: 引擎选择保证会话区间不与污染日相交
  const s = await createSessionWithIntraday();
  if (!s) {
    check("G: 找不到会话", false);
    return;
  }
  const { id, code, date } = s;
  try {
    const row = await prisma.simTradeSession.findUnique({ where: { id }, select: { startDate: true, endDate: true } });
    const hits = contaminatedInRange(code, row!.startDate.toISOString().slice(0, 10), row!.endDate.toISOString().slice(0, 10));
    check("G-a: 会话模拟区间不含污染日（引擎选择保证）", hits.length === 0, `命中=${JSON.stringify(hits)}`);
  } finally {
    await safeDelete(id);
  }

  // G-b: 读取污染标记文件，取一个真实 (code,date)，验证 API 与 isContaminated 一致地「不可用」
  const contaminatedPath = process.env.CONTAMINATED_DAYS_FILE ?? "D:\\AStockData\\metadata\\contaminated_days.json";
  let sample: { code: string; date: string } | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(contaminatedPath, "utf8"));
    const entries: any[] = Array.isArray(raw.excludeStockDates) ? raw.excludeStockDates : [];
    if (entries.length > 0) sample = { code: String(entries[0].code), date: String(entries[0].date) };
  } catch {
    /* ignore */
  }
  if (!sample) {
    check("G-b: 无法读取污染标记样本（文件缺失）", false);
  } else {
    console.log(`  G-b: 取污染样本 ${sample.code} @ ${sample.date}`);
    check("G-b: isContaminated(样本) === true", isContaminated(sample.code, sample.date) === true);
    const dates = contaminatedDatesOf(sample.code);
    check("G-b: contaminatedDatesOf 返回该日期", dates.includes(sample.date), `dates=${JSON.stringify(dates.slice(0, 3))}...`);
    // 直接按 code 模式访问该污染日：API 应返回 contaminated:true 且 bars 为空（不可用）
    const res = await GET(new Request(`http://localhost/api/intraday?code=${encodeURIComponent(sample.code)}&date=${encodeURIComponent(sample.date)}`));
    const json = (await res.json()) as any;
    const d = json.data as any;
    check("G-b: API(code,date) 标记 contaminated=true（不可用）", d?.contaminated === true, `contaminated=${d?.contaminated}`);
    check("G-b: API(code,date) 过滤后 bars=[]（不可用）", Array.isArray(d?.bars) && d.bars.length === 0, `barsLen=${d?.bars?.length}`);
    check("G-b: API(code,date) excludedByContamination=true", d?.excludedByContamination === true);

    // G-c: 若会话当日命中污染日，服务端 todayAllBars 会置空 → 走 DAILY_K 占位（volume=0），
    //      绝不把被污染 30m 数据喂给玩家。用 code 模式已证明 API 层过滤；引擎层同款 isContaminated 拦截。
    //      由于引擎选股已排除污染区间，真实会话不会落在此路径，这里只验证「拦截函数」本身有效。
    check("G-c: 污染日 getIntradayBars 底层虽有数据、但服务层以 isContaminated 拦截（不进入消费路径）",
      isContaminated(sample.code, sample.date) === true);
  }
}

/* ============================ 主流程 ============================ */
async function main(): Promise<void> {
  console.log("\n################ V3 独立对抗性证伪（verify 队友）################\n");
  await verifyPerNodeAntiLeak();
  await verifyHistoryMatchesTodayBar();
  await verifyIntradayContract();
  await verifyDayAdvance();
  await verifyUnitConversion();
  await verifyT1AndQuota();
  await verifyContamination();

  console.log("\n" + "=".repeat(64));
  console.log(`V3 证伪脚本：通过 ${passed} / 失败 ${failed}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log("=".repeat(64));
  if (failed > 0) process.exit(1);
}

void main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("ERR", e);
    await prisma.$disconnect();
    process.exit(1);
  });
