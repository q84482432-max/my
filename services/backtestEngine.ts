/**
 * backtestEngine —— 策略回测引擎（第一批：MA 金叉 / 死叉）
 *
 * ══════════════════════════════════════════════════════════════════
 * 架构定位（与 tradingEngine 的关系）
 * ══════════════════════════════════════════════════════════════════
 *  - 本文件**不 import tradingEngine**，tradingEngine 也**不 import 本文件** —— 两者互不耦合。
 *  - 二者共享的是**更底层的纯函数模块**：
 *      · lib/tradingRules.ts       费用 / 数量规则 / 成本均价 / 已实现盈亏 / 整手取整
 *      · lib/performanceMetrics.ts 最大回撤 / 年化 / 波动率 / 夏普
 *      · lib/indicators.ts         MA 计算
 *    因此回测结论与实盘模拟账户的口径完全一致，但回测**完全不碰**
 *    Account / Position / Order / Trade / DailyAsset 任何一张表。
 *  - 回测是**纯内存计算**：读 klines → 逐根推演 → 返回结果。
 *
 * ══════════════════════════════════════════════════════════════════
 * 时序模型（禁止未来函数的关键）
 * ══════════════════════════════════════════════════════════════════
 *  第 i 根日K（交易日 T）的处理顺序固定为：
 *    ① 先执行**上一根**产生的待成交订单 —— 以本根 **开盘价** 成交
 *    ② 再用本根 **收盘价** 给账户估值（写当日资金曲线点）
 *    ③ 最后用「截至本根收盘」的收盘价序列计算 MA，判断是否产生**新信号**
 *  → 信号在 T 日收盘产生，成交发生在 T+1 日开盘。
 *  → 任何时点用到的价格都不晚于该时点，均线只由过去数据构成。
 *  → 量能/价格全部来自传入的 bars 数组，函数**不改写入参**、**不读数据库**。
 *
 *  ★ 刻意不做「同根K线收盘价成交」的执行模型：那等于用收盘时刻才知道的
 *    信号去成交收盘价，属隐性未来函数。本引擎统一采用 **T+1 开盘成交**，
 *    并在结果里用 `executionModel: "NEXT_OPEN"` 明示。
 *  ★ 买入数量在**成交时点**按实际成交价计算（不使用信号日价格给次日成交定量），
 *    这样也不引入任何未来信息。
 *
 * ══════════════════════════════════════════════════════════════════
 * 仓位与交易规则
 * ══════════════════════════════════════════════════════════════════
 *  - 金叉 → 全仓买入（按整手 100 股，可用现金上限，费用已计入）
 *  - 死叉 → 清仓卖出（全部持仓）
 *  - 买入成本均价 =（成交额 + 全部费用）/ 数量，6 位小数（与实盘同源）
 *  - 卖出实现盈亏 =（卖价 − 成本均价）× 数量 − 卖出费用（与实盘同源）
 *  - T+1：卖出日不得等于买入日（本引擎的 NEXT_OPEN 模型下结构性满足，
 *    仍显式校验以固化规则、防止未来改执行模型时回归）
 */

import { calcMA } from "@/lib/indicators";
import { LOT_SIZE } from "@/lib/constants";
import {
  calcBuyOutlay,
  calcFees,
  calcRealizedPnl,
  calcSellNetIncome,
  maxAffordableLots,
  round2,
  round6,
} from "@/lib/tradingRules";
import {
  buildDrawdownCurve,
  calcPerformance,
} from "@/lib/performanceMetrics";
import { getKlines, getStockInfoByCode } from "@/services/marketDataService";
import type {
  AdjustType,
  BacktestBenchmark,
  BacktestDrawdownPoint,
  BacktestEquityPoint,
  BacktestEvent,
  BacktestInput,
  BacktestMarker,
  BacktestMetrics,
  BacktestResult,
  BacktestRoundTrip,
  BacktestStrategyId,
  BacktestTrade,
  KlineBar,
  MaCrossParams,
  OrderSide,
} from "@/types";

/** 默认策略参数（第一批固定 MA5 / MA20） */
export const DEFAULT_MA_CROSS_PARAMS: MaCrossParams = { fast: 5, slow: 20 };

/**
 * 单次回测最多处理的日K 根数（防止误传超大区间导致 O(n) 以外的负担）。
 * 取值远大于本机数据窗口（453 个交易日），确保区间**头部不会被 limit 截断**。
 */
export const MAX_BARS = 100_000;

/** 慢线周期上限（防止无意义的超长窗口） */
const MAX_SLOW = 250;

/* ------------------------------------------------------------------ */
/*                              结果类型                                */
/* ------------------------------------------------------------------ */

export interface BacktestRunResult {
  success: boolean;
  message: string;
  result?: BacktestResult;
}

/** 纯计算入参（不含任何 DB 语义，便于用合成数据做确定性测试） */
export interface MaCrossSimInput {
  symbol: string;
  stockName: string;
  adjust: AdjustType;
  bars: KlineBar[];
  initialCash: number;
  params: MaCrossParams;
  /** 用户请求的区间（结果里原样回填，便于前端显示） */
  startDate: string;
  endDate: string;
}

/* ------------------------------------------------------------------ */
/*                      核心：纯内存逐根推演                            */
/* ------------------------------------------------------------------ */

/** 待成交订单（在信号日收盘挂出，次日开盘执行） */
interface PendingOrder {
  /** 信号日 */
  signalDate: string;
  side: OrderSide;
  maFast: number;
  maSlow: number;
  reason: string;
}

/**
 * MA 金叉 / 死叉回测核心（**纯函数**：只依赖入参 bars，不读库、不写库）。
 *
 * @throws 参数非法时抛错（周期非正、快线不短于慢线等）
 */
export function simulateMaCross(input: MaCrossSimInput): BacktestResult {
  const { symbol, stockName, adjust, bars, params, startDate, endDate } = input;
  const { fast, slow } = params;

  /* ---------- 0) 参数校验 ---------- */
  if (!Number.isInteger(fast) || fast < 1) {
    throw new Error(`快线周期必须为正整数，收到 ${fast}`);
  }
  if (!Number.isInteger(slow) || slow < 2) {
    throw new Error(`慢线周期必须为 ≥ 2 的整数，收到 ${slow}`);
  }
  if (fast >= slow) {
    throw new Error(`快线周期（${fast}）必须小于慢线周期（${slow}）`);
  }
  if (slow > MAX_SLOW) {
    throw new Error(`慢线周期过大（上限 ${MAX_SLOW}），收到 ${slow}`);
  }
  if (!Number.isFinite(input.initialCash) || input.initialCash <= 0) {
    throw new Error("初始资金必须为正数");
  }

  const initialCash = round2(input.initialCash);

  /* ---------- 1) 指标（只用过去数据，calcMA 为滑动窗口） ---------- */
  const maFastArr = calcMA(bars, fast);
  const maSlowArr = calcMA(bars, slow);

  /* ---------- 2) 账户与日志状态 ---------- */
  let cash = initialCash;
  let positionQty = 0;
  /** 持仓成本总额（含买入费用），保留精确值，不提前取整 */
  let costTotal = 0;
  /** 成本均价（6 位小数，与实盘同源） */
  let avgCost = 0;
  let lastBuyDate: string | null = null;
  let lastBuyBarIndex = -1;

  const events: BacktestEvent[] = [];
  const trades: BacktestTrade[] = [];
  const roundTrips: BacktestRoundTrip[] = [];
  const equityCurve: BacktestEquityPoint[] = [];
  const markers: BacktestMarker[] = [];
  const warnings: string[] = [];

  let seq = 0;
  let pending: PendingOrder | null = null;
  /** 当前未平仓的开仓信息（用于配对往返） */
  let openEntry: {
    date: string;
    price: number;
    quantity: number;
    buyFee: number;
    buyOutlay: number;
    barIndex: number;
  } | null = null;

  /** 区间内最后一天的收益基准（首日以初始资金为基准） */
  let prevAsset = initialCash;

  const pushEvent = (e: Omit<BacktestEvent, "seq">): void => {
    seq += 1;
    events.push({ seq, ...e });
  };

  const zeroFeeDetail = { commission: 0, stampTax: 0, transferFee: 0 };

  /* ---------- 3) 逐根按时间顺序处理 ---------- */
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const date = bar.date;

    /* ---- ① 执行上一根产生的待成交订单：以本根**开盘价**成交 ---- */
    if (pending) {
      const order = pending;
      pending = null;

      if (order.side === "BUY") {
        // 数量在成交时点按实际成交价确定（不使用信号日价格，避免隐含未来信息）
        const qty = maxAffordableLots(cash, bar.open);
        if (qty <= 0) {
          const mv = round2(bar.close * positionQty);
          pushEvent({
            date,
            type: "SKIP",
            signalDate: order.signalDate,
            reason: `资金不足：可用 ¥${cash.toFixed(2)} 无法买入一手（最低佣金 5 元）`,
            price: bar.open,
            quantity: 0,
            amount: 0,
            fee: 0,
            feeDetail: { ...zeroFeeDetail },
            cash,
            positionQty,
            positionAvgCost: avgCost,
            marketValue: mv,
            totalAsset: round2(cash + mv),
            maFast: order.maFast,
            maSlow: order.maSlow,
            realizedPnl: null,
          });
        } else {
          const amount = round2(bar.open * qty);
          const fees = calcFees(amount, "BUY");
          const outlay = calcBuyOutlay(amount, fees);

          cash = round2(cash - outlay);
          costTotal += outlay;
          positionQty += qty;
          avgCost = round6(costTotal / positionQty);
          lastBuyDate = date;
          lastBuyBarIndex = i;

          const mv = round2(bar.close * positionQty);
          const totalAsset = round2(cash + mv);

          pushEvent({
            date,
            type: "BUY",
            signalDate: order.signalDate,
            reason: order.reason,
            price: bar.open,
            quantity: qty,
            amount,
            fee: fees.total,
            feeDetail: {
              commission: fees.commission,
              stampTax: fees.stampTax,
              transferFee: fees.transferFee,
            },
            cash,
            positionQty,
            positionAvgCost: avgCost,
            marketValue: mv,
            totalAsset,
            maFast: order.maFast,
            maSlow: order.maSlow,
            realizedPnl: null,
          });
          const tradeSeq = trades.length + 1;
          trades.push({
            seq: tradeSeq,
            date,
            signalDate: order.signalDate,
            side: "BUY",
            price: bar.open,
            quantity: qty,
            amount,
            fee: fees.total,
            feeDetail: {
              commission: fees.commission,
              stampTax: fees.stampTax,
              transferFee: fees.transferFee,
            },
            cash,
            positionQty,
            positionAvgCost: avgCost,
            marketValue: mv,
            totalAsset,
            realizedPnl: null,
            reason: order.reason,
          });
          markers.push({
            date,
            type: "BUY",
            price: bar.open,
            quantity: qty,
            signalDate: order.signalDate,
            reason: order.reason,
          });
          openEntry = {
            date,
            price: bar.open,
            quantity: qty,
            buyFee: fees.total,
            buyOutlay: outlay,
            barIndex: i,
          };
        }
      } else {
        // SELL
        if (positionQty <= 0) {
          const mv = round2(bar.close * positionQty);
          pushEvent({
            date,
            type: "SKIP",
            signalDate: order.signalDate,
            reason: "空仓，忽略卖出信号",
            price: bar.open,
            quantity: 0,
            amount: 0,
            fee: 0,
            feeDetail: { ...zeroFeeDetail },
            cash,
            positionQty,
            positionAvgCost: avgCost,
            marketValue: mv,
            totalAsset: round2(cash + mv),
            maFast: order.maFast,
            maSlow: order.maSlow,
            realizedPnl: null,
          });
        } else if (lastBuyDate !== null && date === lastBuyDate) {
          // T+1 防御性校验：NEXT_OPEN 模型下不可能触发（卖出最早在买入次日之后）
          const mv = round2(bar.close * positionQty);
          pushEvent({
            date,
            type: "SKIP",
            signalDate: order.signalDate,
            reason: "违反 T+1：当日买入份额当日不可卖",
            price: bar.open,
            quantity: 0,
            amount: 0,
            fee: 0,
            feeDetail: { ...zeroFeeDetail },
            cash,
            positionQty,
            positionAvgCost: avgCost,
            marketValue: mv,
            totalAsset: round2(cash + mv),
            maFast: order.maFast,
            maSlow: order.maSlow,
            realizedPnl: null,
          });
        } else {
          const qty = positionQty;
          const amount = round2(bar.open * qty);
          const fees = calcFees(amount, "SELL");
          const netIncome = calcSellNetIncome(amount, fees);
          const realizedPnl = calcRealizedPnl(bar.open, avgCost, qty, fees.total);

          cash = round2(cash + netIncome);
          positionQty = 0;
          costTotal = 0;
          avgCost = 0;

          const mv = 0; // 已清仓
          const totalAsset = round2(cash + mv);

          pushEvent({
            date,
            type: "SELL",
            signalDate: order.signalDate,
            reason: order.reason,
            price: bar.open,
            quantity: qty,
            amount,
            fee: fees.total,
            feeDetail: {
              commission: fees.commission,
              stampTax: fees.stampTax,
              transferFee: fees.transferFee,
            },
            cash,
            positionQty,
            positionAvgCost: avgCost,
            marketValue: mv,
            totalAsset,
            maFast: order.maFast,
            maSlow: order.maSlow,
            realizedPnl,
          });

          const entry = openEntry;
          const sellSeq = trades.length + 1;
          trades.push({
            seq: sellSeq,
            date,
            signalDate: order.signalDate,
            side: "SELL",
            price: bar.open,
            quantity: qty,
            amount,
            fee: fees.total,
            feeDetail: {
              commission: fees.commission,
              stampTax: fees.stampTax,
              transferFee: fees.transferFee,
            },
            cash,
            positionQty,
            positionAvgCost: avgCost,
            marketValue: mv,
            totalAsset,
            realizedPnl,
            reason: order.reason,
          });
          markers.push({
            date,
            type: "SELL",
            price: bar.open,
            quantity: qty,
            signalDate: order.signalDate,
            reason: order.reason,
          });

          if (entry) {
            const holdBars = i - entry.barIndex;
            roundTrips.push({
              seq: roundTrips.length + 1,
              entryDate: entry.date,
              entryPrice: entry.price,
              exitDate: date,
              exitPrice: bar.open,
              quantity: qty,
              buyFee: entry.buyFee,
              sellFee: fees.total,
              totalFee: round2(entry.buyFee + fees.total),
              holdDays: dayDiff(entry.date, date),
              holdBars,
              pnl: realizedPnl,
              pnlPercent:
                entry.buyOutlay > 0
                  ? round2((realizedPnl / entry.buyOutlay) * 100)
                  : 0,
              win: realizedPnl > 0,
            });
            openEntry = null;
          }
          void lastBuyBarIndex; // 保留：供未来扩展「持有N bar 后强制平仓」等规则
        }
      }
    }

    /* ---- ② 以本根收盘价给账户估值，写资金曲线 ---- */
    const marketValue = round2(bar.close * positionQty);
    const totalAsset = round2(cash + marketValue);
    const dailyReturn =
      prevAsset > 0 ? round2(((totalAsset - prevAsset) / prevAsset) * 100) : 0;
    equityCurve.push({
      date,
      close: bar.close,
      cash,
      positionQty,
      marketValue,
      totalAsset,
      nav: round6(totalAsset / initialCash),
      returnPercent: round2(((totalAsset - initialCash) / initialCash) * 100),
      dailyReturn,
    });
    prevAsset = totalAsset;

    /* ---- ③ 用「截至本根收盘」的均线判断是否产生新信号 ---- */
    const mf = maFastArr[i];
    const ms = maSlowArr[i];
    const pf = i > 0 ? maFastArr[i - 1] : null;
    const ps = i > 0 ? maSlowArr[i - 1] : null;
    if (mf === null || ms === null || pf === null || ps === null) continue;

    const crossUp = pf <= ps && mf > ms;
    const crossDown = pf >= ps && mf < ms;
    if (!crossUp && !crossDown) continue;

    if (crossUp) {
      const actionable = positionQty === 0;
      pushEvent({
        date,
        type: "GOLDEN_CROSS",
        signalDate: null,
        reason: actionable
          ? `MA${fast} 上穿 MA${slow}（金叉）→ 次日开盘全仓买入`
          : `MA${fast} 上穿 MA${slow}（金叉），但已持仓，忽略`,
        price: bar.close,
        quantity: 0,
        amount: 0,
        fee: 0,
        feeDetail: { ...zeroFeeDetail },
        cash,
        positionQty,
        positionAvgCost: avgCost,
        marketValue,
        totalAsset,
        maFast: mf,
        maSlow: ms,
        realizedPnl: null,
      });
      if (actionable) {
        pending = {
          signalDate: date,
          side: "BUY",
          maFast: mf,
          maSlow: ms,
          reason: `MA${fast} 上穿 MA${slow}（金叉）`,
        };
      }
    } else {
      const actionable = positionQty > 0;
      pushEvent({
        date,
        type: "DEATH_CROSS",
        signalDate: null,
        reason: actionable
          ? `MA${fast} 下穿 MA${slow}（死叉）→ 次日开盘清仓卖出`
          : `MA${fast} 下穿 MA${slow}（死叉），但当前空仓，忽略`,
        price: bar.close,
        quantity: 0,
        amount: 0,
        fee: 0,
        feeDetail: { ...zeroFeeDetail },
        cash,
        positionQty,
        positionAvgCost: avgCost,
        marketValue,
        totalAsset,
        maFast: mf,
        maSlow: ms,
        realizedPnl: null,
      });
      if (actionable) {
        pending = {
          signalDate: date,
          side: "SELL",
          maFast: mf,
          maSlow: ms,
          reason: `MA${fast} 下穿 MA${slow}（死叉）`,
        };
      }
    }
  }

  /* ---------- 4) 区间末尾仍挂着的信号：如实记录未成交 ---------- */
  if (pending) {
    const last = bars[bars.length - 1];
    const mv = round2(last.close * positionQty);
    pushEvent({
      date: last.date,
      type: "SKIP",
      signalDate: pending.signalDate,
      reason: "区间已到最后一根K线，无次日开盘行情，该信号未成交",
      price: last.close,
      quantity: 0,
      amount: 0,
      fee: 0,
      feeDetail: { ...zeroFeeDetail },
      cash,
      positionQty,
      positionAvgCost: avgCost,
      marketValue: mv,
      totalAsset: round2(cash + mv),
      maFast: pending.maFast,
      maSlow: pending.maSlow,
      realizedPnl: null,
    });
    warnings.push(
      `区间最后一根K线（${last.date}）产生了信号，但没有次日行情可成交，该信号已如实记录为未成交。`,
    );
  }

  /* ---------- 5) 指标 ---------- */
  const perf = calcPerformance(
    equityCurve.map((e) => ({
      date: e.date,
      totalAsset: e.totalAsset,
      dailyReturn: e.dailyReturn,
    })),
    initialCash,
  );

  // 回撤曲线：运行峰值只向后看，与 calcMaxDrawdown 同源同口径
  const drawdownCurve: BacktestDrawdownPoint[] = buildDrawdownCurve(
    equityCurve.map((e) => ({ date: e.date, totalAsset: e.totalAsset })),
  );

  const wins = roundTrips.filter((r) => r.pnl > 0);
  const losses = roundTrips.filter((r) => r.pnl < 0);
  const flats = roundTrips.filter((r) => r.pnl === 0);
  const totalWin = round2(wins.reduce((a, r) => a + r.pnl, 0));
  const totalLoss = round2(losses.reduce((a, r) => a + r.pnl, 0));
  const avgWin = wins.length > 0 ? round2(totalWin / wins.length) : 0;
  const avgLoss = losses.length > 0 ? round2(totalLoss / losses.length) : 0;
  const totalFee = round2(trades.reduce((a, t) => a + t.fee, 0));

  const metrics: BacktestMetrics = {
    initialAsset: initialCash,
    finalAsset: perf.finalAsset,
    totalReturn: perf.totalReturn,
    annualReturn: perf.annualReturn,
    maxDrawdown: perf.maxDrawdown,
    maxDrawdownStart: perf.maxDrawdownStart,
    maxDrawdownEnd: perf.maxDrawdownEnd,
    volatility: perf.volatility,
    sharpeRatio: perf.sharpeRatio,
    tradingDays: perf.tradingDays,
    tradeCount: roundTrips.length,
    winCount: wins.length,
    lossCount: losses.length,
    flatCount: flats.length,
    winRate:
      roundTrips.length > 0
        ? round2((wins.length / roundTrips.length) * 100)
        : 0,
    avgWin,
    avgLoss,
    // 无亏损单时盈亏比在数学上为无穷，用 null 如实表达（而非塞一个大数）
    profitFactor: losses.length > 0 ? round2(totalWin / Math.abs(totalLoss)) : null,
    payoffRatio:
      losses.length > 0 && avgLoss !== 0 ? round2(avgWin / Math.abs(avgLoss)) : null,
    totalWin,
    totalLoss,
    avgHoldDays:
      roundTrips.length > 0
        ? round2(
            roundTrips.reduce((a, r) => a + r.holdBars, 0) / roundTrips.length,
          )
        : 0,
    totalFee,
    feeRatio: round2((totalFee / initialCash) * 100),
  };

  /* ---------- 6) 基准：同等费用口径下的买入持有 ---------- */
  const benchmark = buildBuyHoldBenchmark(
    symbol,
    stockName,
    bars,
    initialCash,
    drawdownCurve,
  );

  /* ---------- 7) 提示 ---------- */
  const warmupBars = Math.min(slow - 1, bars.length);
  if (bars.length === 0) {
    warnings.push("区间内没有该股票的日K数据。");
  } else {
    if (bars.length < slow + 1) {
      warnings.push(
        `区间内仅 ${bars.length} 根日K，而 MA${slow} 需要 ${slow} 根才能成形、` +
          `成交还需要下一根开盘价，因此**不可能**产生任何交易。请扩大日期区间。`,
      );
    } else if (bars.length < slow * 3) {
      warnings.push(
        `区间内仅 ${bars.length} 根日K，其中前 ${warmupBars} 根用于均线预热` +
          `（占 ${round2((warmupBars / bars.length) * 100)}%），样本偏少，结论参考性有限。`,
      );
    }
    if (roundTrips.length === 0 && bars.length >= slow + 1) {
      // 区分两种「零交易」：① 真的没有可成交信号；② 有信号但资金买不起一手。
      // 后者必须如实指出，否则用户会误以为策略没信号（高价股 + 小资金极常见）。
      const unfunded = events.find(
        (e) => e.type === "SKIP" && e.reason.startsWith("资金不足"),
      );
      if (unfunded) {
        const goldenCount = events.filter((e) => e.type === "GOLDEN_CROSS").length;
        const oneLot = round2(unfunded.price * LOT_SIZE);
        warnings.push(
          `区间内产生了 ${goldenCount} 次金叉买入信号，但初始资金 ¥${initialCash.toFixed(2)} ` +
            `不足以买入一手：${unfunded.date} 成交参考价 ${unfunded.price}，` +
            `一手（${LOT_SIZE} 股）约需 ¥${oneLot.toFixed(2)}。所有信号均如实记录为未成交，` +
            `策略全程空仓。请提高初始资金或更换标的。`,
        );
      } else {
        warnings.push("区间内未产生可成交的均线交叉信号，策略全程空仓。");
      }
    }
    if (metrics.maxDrawdown < -30) {
      warnings.push(`最大回撤达 ${metrics.maxDrawdown}%，风险偏高。`);
    }
    if (metrics.feeRatio > 2) {
      warnings.push(
        `手续费累计占初始资金 ${metrics.feeRatio}%（${metrics.tradeCount} 次交易），` +
          `交易过于频繁会显著侵蚀收益。`,
      );
    }
  }

  const firstSignal = events.find((e) => e.type === "GOLDEN_CROSS" || e.type === "DEATH_CROSS");

  return {
    symbol,
    stockName,
    adjust,
    strategy: "MA_CROSS",
    params: { fast, slow },
    startDate,
    endDate,
    firstBarDate: bars.length > 0 ? bars[0].date : "",
    lastBarDate: bars.length > 0 ? bars[bars.length - 1].date : "",
    barCount: bars.length,
    warmupBars,
    firstSignalDate: firstSignal ? firstSignal.date : null,
    executionModel: "NEXT_OPEN",
    initialCash,
    metrics,
    benchmark,
    events,
    trades,
    roundTrips,
    equityCurve,
    drawdownCurve,
    markers,
    bars,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/*                            辅助                                     */
/* ------------------------------------------------------------------ */

/** 日期差（自然日） */
function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * 买入持有基准：区间首根收盘价全仓买入（含费），末根收盘价卖出（含费）。
 * 与策略采用**完全相同的费用规则**，因此收益率可直接比较。
 * 若区间内买不起一手（资金过小），返回 null 而不是编造一个数字。
 */
function buildBuyHoldBenchmark(
  symbol: string,
  stockName: string,
  bars: KlineBar[],
  initialCash: number,
  _dd: BacktestDrawdownPoint[],
): BacktestBenchmark | null {
  if (bars.length < 2) return null;
  const first = bars[0];
  const last = bars[bars.length - 1];

  const qty = maxAffordableLots(initialCash, first.close);
  if (qty <= 0) return null;

  const buyAmount = round2(first.close * qty);
  const buyFees = calcFees(buyAmount, "BUY");
  const outlay = calcBuyOutlay(buyAmount, buyFees);
  const avgCost = round6(outlay / qty);

  const sellAmount = round2(last.close * qty);
  const sellFees = calcFees(sellAmount, "SELL");
  const netIncome = calcSellNetIncome(sellAmount, sellFees);
  const finalAsset = round2(initialCash - outlay + netIncome);

  return {
    symbol,
    name: stockName,
    returnPercent: round2(((finalAsset - initialCash) / initialCash) * 100),
    finalAsset,
    initialPrice: first.close,
    finalPrice: last.close,
  };
}

/* ------------------------------------------------------------------ */
/*                       对外入口（读库 + 推演）                        */
/* ------------------------------------------------------------------ */

/**
 * 运行一次回测。
 *
 * 只**读** klines/stocks，不写任何表；账户与模拟交易系统完全隔离。
 */
export async function runBacktest(
  input: BacktestInput,
): Promise<BacktestRunResult> {
  const symbol = (input.symbol ?? "").trim();
  const startDate = (input.startDate ?? "").slice(0, 10);
  const endDate = (input.endDate ?? "").slice(0, 10);
  const initialCash = Number(input.initialCash);

  if (!symbol) return { success: false, message: "请选择股票" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { success: false, message: "开始/结束日期格式必须为 YYYY-MM-DD" };
  }
  if (startDate > endDate) {
    return { success: false, message: "开始日期不能晚于结束日期" };
  }
  if (!Number.isFinite(initialCash) || initialCash <= 0) {
    return { success: false, message: "初始资金必须为正数" };
  }
  if (initialCash > 1_000_000_000) {
    return { success: false, message: "初始资金过大（上限 10 亿）" };
  }

  const strategy: BacktestStrategyId = input.strategy ?? "MA_CROSS";
  if (strategy !== "MA_CROSS") {
    return { success: false, message: `暂不支持策略 ${strategy}（第一批仅 MA_CROSS）` };
  }

  const fast = input.params?.fast ?? DEFAULT_MA_CROSS_PARAMS.fast;
  const slow = input.params?.slow ?? DEFAULT_MA_CROSS_PARAMS.slow;
  if (!Number.isInteger(fast) || fast < 1) {
    return { success: false, message: "快线周期必须为正整数" };
  }
  if (!Number.isInteger(slow) || slow < 2) {
    return { success: false, message: "慢线周期必须为不小于 2 的整数" };
  }
  if (fast >= slow) {
    return { success: false, message: `快线周期（${fast}）必须小于慢线周期（${slow}）` };
  }
  if (slow > MAX_SLOW) {
    return { success: false, message: `慢线周期过大（上限 ${MAX_SLOW}）` };
  }

  const stock = await getStockInfoByCode(symbol);
  if (!stock) return { success: false, message: `股票 ${symbol} 不存在` };

  // 口径：与库内该股自身口径一致（qfq / none 不可混用）
  const bars = await getKlines(symbol, {
    period: "1d",
    adjust: stock.adjust,
    startDate,
    endDate,
    limit: MAX_BARS,
  });

  if (bars.length === 0) {
    return {
      success: false,
      message: `区间 ${startDate} ~ ${endDate} 内没有 ${symbol} 的日K数据（该股数据窗口为 ${stock.windowStart ?? "—"} ~ ${stock.windowEnd ?? "—"}）`,
    };
  }
  // 防御：getKlines 的 limit 是「取尾部」，一旦命中会因为截断丢掉区间头部
  if (bars[0].date > startDate) {
    return {
      success: false,
      message: `数据未覆盖开始日期：区间首根K线为 ${bars[0].date}，晚于请求的 ${startDate}`,
    };
  }

  let result: BacktestResult;
  try {
    result = simulateMaCross({
      symbol,
      stockName: stock.name,
      adjust: stock.adjust,
      bars,
      initialCash,
      params: { fast, slow },
      startDate,
      endDate,
    });
  } catch (err) {
    return { success: false, message: (err as Error).message };
  }

  return {
    success: true,
    message: `回测完成：${stock.name}（${symbol}）MA${fast}/MA${slow}，${result.barCount} 个交易日，${result.metrics.tradeCount} 次交易，总收益率 ${result.metrics.totalReturn}%`,
    result,
  };
}
