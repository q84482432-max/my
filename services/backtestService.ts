/**
 * backtestService —— 策略回测的持久化与读取（不参与任何交易计算）
 *
 * ══════════════════════════════════════════════════════════════════
 * 职责边界
 * ══════════════════════════════════════════════════════════════════
 *  - 计算全在 services/backtestEngine.ts（读 klines → 逐根推演 → 返回结果）。
 *    本文件**不复制任何交易规则**，只做「跑 + 存 + 读 + 删」。
 *  - 回测**完全不触碰** Account / Position / Order / Trade / DailyAsset ——
 *    `Backtest.accountId` 为可空且默认不写，从库层面保证与模拟交易系统解耦。
 *  - DB 只存**计算结果**（source of truth 的日K 不落第二份），因此详情接口的
 *    `bars` 由 `MarketDataService` 按 `firstBarDate ~ lastBarDate` + 该股
 *    `adjust` 口径现取 —— 与回测当时引擎读到的是同一批数据。
 */

import prisma from "@/lib/prisma";
import { getKlines } from "@/services/marketDataService";
import {
  DEFAULT_MA_CROSS_PARAMS,
  MAX_BARS,
  runBacktest,
} from "@/services/backtestEngine";
import { normalizeDate } from "@/services/marketDataService";
import { toDateStr } from "@/lib/utils";
import { toNum, round2 } from "@/lib/tradingRules";
import { calcMaxDrawdown } from "@/lib/performanceMetrics";
import type {
  BacktestDetail,
  BacktestDrawdownPoint,
  BacktestEquityPoint,
  BacktestEvent,
  BacktestInput,
  BacktestMarker,
  BacktestMetrics,
  BacktestResult,
  BacktestRoundTrip,
  BacktestStrategyId,
  BacktestSummary,
  BacktestTrade,
  MaCrossParams,
} from "@/types";

/** 历史列表默认返回条数 */
const DEFAULT_LIST_LIMIT = 100;

export interface RunAndSaveBacktestResult {
  success: boolean;
  message: string;
  /** 落库后的记录 ID（成功时存在） */
  id?: string;
  /** 完整回测结果（成功时存在） */
  result?: BacktestResult;
}

/* ------------------------------------------------------------------ */
/*                              工具                                    */
/* ------------------------------------------------------------------ */

/** 安全 JSON.parse（失败返回 fallback，绝不抛错中断读取） */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 归一化策略参数 */
function parseParams(raw: string | null): MaCrossParams {
  const p = parseJson<Partial<MaCrossParams>>(raw, {});
  return {
    fast: Number(p.fast) || DEFAULT_MA_CROSS_PARAMS.fast,
    slow: Number(p.slow) || DEFAULT_MA_CROSS_PARAMS.slow,
  };
}

/** 可空的 Decimal -> number | null */
function decOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = toNum(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/*                              运行                                    */
/* ------------------------------------------------------------------ */

/**
 * 运行一次回测并落库。
 *
 * 失败（参数非法 / 无数据）时**不写库**，直接把失败原因返回给调用方 ——
 * 历史列表里只保留真实产出过结果的记录，避免噪音。
 */
export async function runAndSaveBacktest(
  input: BacktestInput & { name?: string },
): Promise<RunAndSaveBacktestResult> {
  const started = await runBacktest(input);
  if (!started.success || !started.result) {
    return { success: false, message: started.message };
  }

  const r = started.result;
  const name =
    input.name?.trim() ||
    `${r.stockName}(${r.symbol}) MA${r.params.fast}/MA${r.params.slow} · ${r.startDate}~${r.endDate}`;

  const m = r.metrics;

  const row = await prisma.backtest.create({
    data: {
      // accountId 保持 null —— 回测与账户无关
      name,
      strategy: r.strategy,
      params: JSON.stringify(r.params),
      symbol: r.symbol,
      stockName: r.stockName,
      adjust: r.adjust,
      startDate: normalizeDate(r.startDate),
      endDate: normalizeDate(r.endDate),
      firstBarDate: r.firstBarDate ? normalizeDate(r.firstBarDate) : null,
      lastBarDate: r.lastBarDate ? normalizeDate(r.lastBarDate) : null,
      barCount: r.barCount,
      warmupBars: r.warmupBars,
      initialCash: r.initialCash,
      finalAsset: m.finalAsset,
      totalReturn: m.totalReturn,
      annualReturn: m.annualReturn,
      maxDrawdown: m.maxDrawdown,
      volatility: m.volatility,
      sharpeRatio: m.sharpeRatio,
      winRate: m.winRate,
      tradeCount: m.tradeCount,
      winCount: m.winCount,
      lossCount: m.lossCount,
      avgWin: m.avgWin,
      avgLoss: m.avgLoss,
      // null 语义必须保留：无亏损单时盈亏比在数学上是无穷，不能用 0 冒充
      profitFactor: m.profitFactor,
      payoffRatio: m.payoffRatio,
      totalFee: m.totalFee,
      tradingDays: m.tradingDays,
      benchmarkReturn: r.benchmark ? r.benchmark.returnPercent : null,
      equityCurve: JSON.stringify(r.equityCurve),
      tradeLog: JSON.stringify(r.trades),
      drawdownCurve: JSON.stringify(r.drawdownCurve),
      markers: JSON.stringify(r.markers),
      roundTrips: JSON.stringify(r.roundTrips),
      events: JSON.stringify(r.events),
      warnings: JSON.stringify(r.warnings),
      status: "SUCCESS",
    },
    select: { id: true },
  });

  return { success: true, message: started.message, id: row.id, result: r };
}

/* ------------------------------------------------------------------ */
/*                              列表                                    */
/* ------------------------------------------------------------------ */

/** 回测历史（按创建时间倒序，不含大数组） */
export async function listBacktests(
  limit = DEFAULT_LIST_LIMIT,
): Promise<BacktestSummary[]> {
  const rows = await prisma.backtest.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 500)),
    select: {
      id: true,
      name: true,
      symbol: true,
      stockName: true,
      strategy: true,
      params: true,
      startDate: true,
      endDate: true,
      initialCash: true,
      finalAsset: true,
      totalReturn: true,
      annualReturn: true,
      maxDrawdown: true,
      sharpeRatio: true,
      winRate: true,
      tradeCount: true,
      status: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    stockName: row.stockName,
    strategy: (row.strategy as BacktestStrategyId) ?? "MA_CROSS",
    params: parseParams(row.params),
    startDate: toDateStr(row.startDate),
    endDate: toDateStr(row.endDate),
    initialCash: round2(toNum(row.initialCash)),
    finalAsset: decOrNull(row.finalAsset),
    totalReturn: decOrNull(row.totalReturn),
    annualReturn: decOrNull(row.annualReturn),
    maxDrawdown: decOrNull(row.maxDrawdown),
    sharpeRatio: decOrNull(row.sharpeRatio),
    winRate: decOrNull(row.winRate),
    tradeCount: row.tradeCount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/*                              详情                                    */
/* ------------------------------------------------------------------ */

/**
 * 回测详情（完整结果）。
 *
 * `bars` 不落库 —— 按记录的 `firstBarDate ~ lastBarDate` 与 `adjust` 口径
 * 现从 MarketDataService 取，保证 K 线仍只有一份 source of truth。
 */
export async function getBacktestById(
  id: string,
): Promise<BacktestDetail | null> {
  const row = await prisma.backtest.findUnique({ where: { id } });
  if (!row) return null;

  const adjust = (row.adjust as BacktestResult["adjust"]) ?? "qfq";
  const firstBarDate = row.firstBarDate ? toDateStr(row.firstBarDate) : "";
  const lastBarDate = row.lastBarDate ? toDateStr(row.lastBarDate) : "";

  const bars =
    firstBarDate && lastBarDate
      ? await getKlines(row.symbol, {
          period: "1d",
          adjust,
          startDate: firstBarDate,
          endDate: lastBarDate,
          limit: MAX_BARS,
        })
      : [];

  const metrics: BacktestMetrics = {
    initialAsset: round2(toNum(row.initialCash)),
    finalAsset: decOrNull(row.finalAsset) ?? 0,
    totalReturn: decOrNull(row.totalReturn) ?? 0,
    annualReturn: decOrNull(row.annualReturn) ?? 0,
    maxDrawdown: decOrNull(row.maxDrawdown) ?? 0,
    maxDrawdownStart: null,
    maxDrawdownEnd: null,
    volatility: decOrNull(row.volatility) ?? 0,
    sharpeRatio: decOrNull(row.sharpeRatio) ?? 0,
    tradingDays: row.tradingDays,
    tradeCount: row.tradeCount,
    winCount: row.winCount,
    lossCount: row.lossCount,
    flatCount: Math.max(0, row.tradeCount - row.winCount - row.lossCount),
    winRate: decOrNull(row.winRate) ?? 0,
    avgWin: decOrNull(row.avgWin) ?? 0,
    avgLoss: decOrNull(row.avgLoss) ?? 0,
    profitFactor: decOrNull(row.profitFactor),
    payoffRatio: decOrNull(row.payoffRatio),
    totalWin: 0,
    totalLoss: 0,
    avgHoldDays: 0,
    totalFee: decOrNull(row.totalFee) ?? 0,
    feeRatio: 0,
  };

  // 回撤起止日、总盈利/总亏损、平均持有天数、手续费占比均可由留存明细还原，
  // 避免把它们也冗余进库（DB 只存不可复现的原始结果）。
  const drawdownCurve = parseJson<BacktestDrawdownPoint[]>(row.drawdownCurve, []);
  const roundTrips = parseJson<BacktestRoundTrip[]>(row.roundTrips, []);
  const trades = parseJson<BacktestTrade[]>(row.tradeLog, []);
  const events = parseJson<BacktestEvent[]>(row.events, []);

  // 回撤起止日：必须「跑一遍同时记录峰值日与谷底日」。旧写法先求最低点、
  // 再把起点取成整条曲线的最高点 —— 一旦曲线在谷底之后创新高，起点就会晚于
  // 终点，回撤区间颠倒（2026-09-18 线上实测 bug，已在服务器构建产物上热修）。
  // 这里改为直接复用引擎层同一实现，从根上消除这份重复实现走样的可能。
  const dd = calcMaxDrawdown(drawdownCurve);
  if (dd.maxDrawdown < 0) {
    metrics.maxDrawdownStart = dd.start;
    metrics.maxDrawdownEnd = dd.end;
  }

  metrics.totalWin = round2(
    roundTrips.filter((r) => r.pnl > 0).reduce((a, r) => a + r.pnl, 0),
  );
  metrics.totalLoss = round2(
    roundTrips.filter((r) => r.pnl < 0).reduce((a, r) => a + r.pnl, 0),
  );
  metrics.avgHoldDays =
    roundTrips.length > 0
      ? round2(roundTrips.reduce((a, r) => a + r.holdBars, 0) / roundTrips.length)
      : 0;
  metrics.totalFee = round2(trades.reduce((a, t) => a + t.fee, 0));
  metrics.feeRatio =
    metrics.initialAsset > 0
      ? round2((metrics.totalFee / metrics.initialAsset) * 100)
      : 0;

  const benchmark =
    row.benchmarkReturn !== null && bars.length > 0
      ? {
          symbol: row.symbol,
          name: row.stockName ?? row.symbol,
          returnPercent: round2(toNum(row.benchmarkReturn)),
          finalAsset: round2(
            metrics.initialAsset * (1 + toNum(row.benchmarkReturn) / 100),
          ),
          initialPrice: bars[0].close,
          finalPrice: bars[bars.length - 1].close,
        }
      : null;

  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    symbol: row.symbol,
    stockName: row.stockName ?? row.symbol,
    adjust,
    strategy: (row.strategy as BacktestStrategyId) ?? "MA_CROSS",
    params: parseParams(row.params),
    startDate: toDateStr(row.startDate),
    endDate: toDateStr(row.endDate),
    firstBarDate,
    lastBarDate,
    barCount: row.barCount,
    warmupBars: row.warmupBars,
    firstSignalDate: events.find(
      (e) => e.type === "GOLDEN_CROSS" || e.type === "DEATH_CROSS",
    )?.date ?? null,
    executionModel: "NEXT_OPEN",
    initialCash: round2(toNum(row.initialCash)),
    metrics,
    benchmark,
    events,
    trades,
    roundTrips,
    equityCurve: parseJson<BacktestEquityPoint[]>(row.equityCurve, []),
    drawdownCurve,
    markers: parseJson<BacktestMarker[]>(row.markers, []),
    bars,
    warnings: parseJson<string[]>(row.warnings, []),
  };
}

/* ------------------------------------------------------------------ */
/*                              删除                                    */
/* ------------------------------------------------------------------ */

/** 删除一条回测记录（不涉及任何其它表） */
export async function deleteBacktest(
  id: string,
): Promise<{ success: boolean; message: string }> {
  const row = await prisma.backtest.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!row) return { success: false, message: "回测记录不存在" };
  await prisma.backtest.delete({ where: { id } });
  return { success: true, message: "回测记录已删除" };
}
