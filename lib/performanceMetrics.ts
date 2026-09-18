/**
 * performanceMetrics —— 绩效指标纯函数层（无 DB / 无框架依赖）
 *
 * 与 lib/tradingRules.ts 同属「共享底层」：
 *   tradingEngine（实盘账户绩效）与 backtestEngine（回测绩效）必须用同一套口径，
 *   否则同一条净值曲线在两个页面会算出不同的最大回撤 / 夏普。
 *   两者都不 import 对方，只 import 本模块。
 *
 * 口径基准：
 *  - A股年均交易日取 **244**（与既有实盘绩效口径一致）
 *  - 年化收益率 = (期末/期初)^(1/年数) − 1，年数 = 交易日数 / 244
 *  - 波动率 = 日收益率样本标准差 × √244
 *  - 夏普 = (日均收益 − 无风险日收益) / 日标准差 × √244，无风险年化默认 2%
 *  - 最大回撤以**负值**表示（-14.29% 表示从峰值跌去 14.29%）
 */

import { round2 } from "@/lib/tradingRules";
import type { PerformanceMetrics } from "@/types";

/** A股年均交易日数（年化与波动率的分母） */
export const TRADING_DAYS_PER_YEAR = 244;

/** 净值曲线点（本模块的最小入参形状） */
export interface EquityLike {
  date: string;
  totalAsset: number;
}

/** 回撤曲线点 */
export interface DrawdownPoint {
  date: string;
  totalAsset: number;
  /** 截至该日的运行峰值 */
  peak: number;
  /** 距峰值的回撤百分比（≤ 0） */
  drawdownPercent: number;
}

/**
 * 最大回撤（纯函数）。
 * 返回 { maxDrawdown(%), start, end }：start = 峰值日，end = 谷底日。
 */
export function calcMaxDrawdown(curve: EquityLike[]): {
  maxDrawdown: number;
  start: string | null;
  end: string | null;
} {
  if (curve.length === 0) return { maxDrawdown: 0, start: null, end: null };

  let peak = curve[0].totalAsset;
  let peakDate = curve[0].date;
  let maxDrawdown = 0;
  let startDate: string | null = null;
  let endDate: string | null = null;

  for (const point of curve) {
    if (point.totalAsset > peak) {
      peak = point.totalAsset;
      peakDate = point.date;
    }
    const dd = peak > 0 ? ((point.totalAsset - peak) / peak) * 100 : 0;
    if (dd < maxDrawdown) {
      maxDrawdown = dd;
      startDate = peakDate;
      endDate = point.date;
    }
  }

  return {
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    start: startDate,
    end: endDate,
  };
}

/**
 * 逐日回撤曲线：每一点记录「当日的运行峰值」与「距该峰值的回撤百分比」。
 *
 * 运行峰值口径：`peak_i = max(asset_0..asset_i)`（**只向后看，不用未来数据**）。
 * 这是回撤曲线与最大回撤保持一致的前提：
 * `min(drawdownCurve[].drawdownPercent) === calcMaxDrawdown(curve).maxDrawdown`。
 */
export function buildDrawdownCurve(curve: EquityLike[]): DrawdownPoint[] {
  let peak = -Infinity;
  const out: DrawdownPoint[] = [];
  for (const point of curve) {
    if (point.totalAsset > peak) peak = point.totalAsset;
    const dd = peak > 0 ? ((point.totalAsset - peak) / peak) * 100 : 0;
    out.push({
      date: point.date,
      totalAsset: point.totalAsset,
      peak: Math.round(peak * 100) / 100,
      drawdownPercent: Math.round(dd * 100) / 100,
    });
  }
  return out;
}

/**
 * 绩效指标：收益率 / 年化 / 最大回撤 / 波动率 / 夏普。
 * 纯计算，数据来自净值曲线（实盘取 DailyAsset 快照，回测取内存曲线）。
 */
export function calcPerformance(
  curve: { date: string; totalAsset: number; dailyReturn: number }[],
  initialAsset: number,
  riskFreeRate = 0.02,
): PerformanceMetrics {
  if (curve.length === 0) {
    return {
      initialAsset,
      finalAsset: initialAsset,
      totalReturn: 0,
      annualReturn: 0,
      maxDrawdown: 0,
      maxDrawdownStart: null,
      maxDrawdownEnd: null,
      volatility: 0,
      sharpeRatio: 0,
      tradingDays: 0,
    };
  }

  const finalAsset = curve[curve.length - 1].totalAsset;
  const totalReturn =
    initialAsset > 0 ? ((finalAsset - initialAsset) / initialAsset) * 100 : 0;
  const tradingDays = curve.length;
  const years = tradingDays / TRADING_DAYS_PER_YEAR;
  const annualReturn =
    years > 0 && initialAsset > 0
      ? (Math.pow(finalAsset / initialAsset, 1 / years) - 1) * 100
      : 0;

  const dd = calcMaxDrawdown(curve);

  // 日收益率序列的样本标准差 -> 年化波动率
  const rets = curve.map((c) => c.dailyReturn / 100).filter((v) => Number.isFinite(v));
  const mean = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance =
    rets.length > 1
      ? rets.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (rets.length - 1)
      : 0;
  const dailyVol = Math.sqrt(variance);
  const volatility = dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
  const sharpeRatio =
    dailyVol > 0
      ? ((mean - riskFreeRate / TRADING_DAYS_PER_YEAR) / dailyVol) *
        Math.sqrt(TRADING_DAYS_PER_YEAR)
      : 0;

  return {
    initialAsset,
    finalAsset: round2(finalAsset),
    totalReturn: round2(totalReturn),
    annualReturn: round2(annualReturn),
    maxDrawdown: dd.maxDrawdown,
    maxDrawdownStart: dd.start,
    maxDrawdownEnd: dd.end,
    volatility: round2(volatility),
    sharpeRatio: round2(sharpeRatio),
    tradingDays,
  };
}
