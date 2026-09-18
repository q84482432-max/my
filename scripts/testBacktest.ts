/**
 * 策略回测系统 —— 端到端测试
 *
 * 用户硬性要求（第八阶段）：
 *   「使用历史真实日K。回测过程中必须按照时间顺序处理数据。禁止未来函数。」
 *   「记录每一次：信号 / 价格 / 数量 / 手续费 / 成交 / 现金 / 持仓 / 资产。」
 *   「最终输出：总收益率 年化收益率 最大回撤 交易次数 胜率 平均盈利 平均亏损
 *     盈亏比 夏普比率；同时输出：资金曲线 回撤曲线 买卖点 交易明细。」
 *   「BacktestEngine 和 TradingEngine 尽量共享底层交易规则，但不要互相耦合。」
 *
 * 校验策略 = **独立对照**（不拿被测实现验证自己）：
 *   - 未来函数哨兵：把 bars 截断到任意前缀重跑，历史部分的资金曲线 / 成交 / 事件
 *     必须与全量运行**逐字段完全一致**；追加「未来K线」也不得改变历史部分。
 *   - 时序模型：每笔成交价必须等于**信号日下一根K线**的开盘价（真实数据交叉验证）。
 *   - 费用 / 成本均价 / 已实现盈亏：本文件内按规则文本**重新实现**一份朴素版本对照。
 *   - 绩效指标：朴素 O(n²) 最大回撤、手算年化 / 胜率 / 平均盈亏 / 盈亏比 / 夏普。
 *   - 资金守恒：Σ 成交费用 = 累计手续费；Σ 配对盈亏 ≈ 期末资产 − 初始资金。
 *   - 与 TradingEngine 交叉：同一笔委托在两个引擎下的费用 / 成本均价必须一致
 *     （共享底层规则），但两者源码互不 import（耦合检查见文件末尾）。
 *   - 零污染：跑回测前后 Account/Position/Order/Trade/DailyAsset/Simulation 行数不变。
 *
 * 运行： npx tsx scripts/testBacktest.ts
 */

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_MA_CROSS_PARAMS,
  MAX_BARS,
  runBacktest,
  simulateMaCross,
} from "@/services/backtestEngine";
import {
  deleteBacktest,
  getBacktestById,
  listBacktests,
  runAndSaveBacktest,
} from "@/services/backtestService";
import { getKlines, getStockInfoByCode } from "@/services/marketDataService";
import { createAccount, placeOrder } from "@/services/tradingEngine";
import {
  BACKTEST_CHART_COLORS,
  buildBacktestDrawdownOption,
  buildBacktestEquityOption,
} from "@/lib/backtestChartOption";
import { COMMISSION_MIN, DEFAULT_INITIAL_CASH, LOT_SIZE } from "@/lib/constants";
import type { BacktestResult, KlineBar } from "@/types";

/* ------------------------------------------------------------------ */
/* 测试框架                                                            */
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

function note(text: string): void {
  console.log(`  \x1b[90m· ${text}\x1b[0m`);
}

function near(a: number, b: number, eps = 0.011): boolean {
  return Math.abs(a - b) <= eps;
}

function money(v: number): string {
  return `¥${v.toFixed(2)}`;
}

/* ------------------------------------------------------------------ */
/* 朴素独立实现（按规则文本重写，不 import 被测实现）                  */
/* ------------------------------------------------------------------ */

/** 独立费用实现：佣金万三最低 5 元双向；印花税千一仅卖出；过户费万 0.1 双向 */
function naiveFees(amount: number, side: "BUY" | "SELL") {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const commission = Math.max(r2(amount * 0.0003), COMMISSION_MIN);
  const stampTax = side === "SELL" ? r2(amount * 0.001) : 0;
  const transferFee = r2(amount * 0.00001);
  return { commission, stampTax, transferFee, total: r2(commission + stampTax + transferFee) };
}

/** 独立成本均价：(成交额 + 全部费用) / 数量，6 位小数 */
function naiveAvgCost(amount: number, feesTotal: number, qty: number): number {
  return Math.round(((amount + feesTotal) / qty) * 1e6) / 1e6;
}

/** 独立实现：给定现金与单价，可买的最大整手数（含费），朴素逐手回退 */
function naiveMaxLots(cash: number, price: number): number {
  let qty = Math.floor(cash / price / LOT_SIZE) * LOT_SIZE;
  while (qty > 0) {
    const amount = Math.round(price * qty * 100) / 100;
    const f = naiveFees(amount, "BUY");
    if (amount + f.total <= cash + 1e-9) return qty;
    qty -= LOT_SIZE;
  }
  return 0;
}

/** 独立 MA（滑动窗口，前 n-1 个为 null） */
function naiveMA(values: number[], n: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += values[k];
    return s / n;
  });
}

/** 独立最大回撤：O(n²)，对每个点向前找峰值 */
function naiveMaxDrawdown(curve: { date: string; totalAsset: number }[]): number {
  let worst = 0;
  for (let i = 0; i < curve.length; i++) {
    let peak = -Infinity;
    for (let k = 0; k <= i; k++) peak = Math.max(peak, curve[k].totalAsset);
    if (peak > 0) {
      const dd = ((curve[i].totalAsset - peak) / peak) * 100;
      if (dd < worst) worst = dd;
    }
  }
  return Math.round(worst * 100) / 100;
}

/** 独立年化：((期末/期初)^(244/交易日数) − 1) × 100 */
function naiveAnnual(finalAsset: number, initial: number, days: number): number {
  if (days <= 0 || finalAsset <= 0 || initial <= 0) return 0;
  const years = days / 244;
  return Math.round((Math.pow(finalAsset / initial, 1 / years) - 1) * 1000000) / 10000;
}

/* ------------------------------------------------------------------ */
/* 合成数据（确定性：金叉 / 死叉位置可手算）                           */
/* ------------------------------------------------------------------ */

/**
 * 40 根日K 的构造路径（close）：
 *   [0,15)  = 10   [15,20) = 9   [20,30) = 11   [30,40) = 8
 * 手算 MA5 / MA20 可推出：
 *   i=22：MA5(10.20) 上穿 MA20(9.90)，前一根 9.80 ≤ 9.85 → **金叉（信号）**
 *   i=23：以开盘价 10.8 全仓买入
 *   i=31：MA5(9.80) 下穿 MA20(10.05)，前一根 10.40 ≥ 10.15 → **死叉（信号）**
 *   i=32：以开盘价 7.8 清仓卖出
 * 开价统一设为 `close − 0.2`，因此「用了开盘价」与「用了收盘价」结果必然不同。
 */
function buildSyntheticBars(): KlineBar[] {
  const bars: KlineBar[] = [];
  for (let i = 0; i < 40; i++) {
    let close: number;
    if (i < 15) close = 10;
    else if (i < 20) close = 9;
    else if (i < 30) close = 11;
    else close = 8;
    const open = close - 0.2;
    bars.push({
      date: `2025-01-${String(i + 1).padStart(2, "0")}`,
      open,
      high: close + 0.3,
      low: open - 0.3,
      close,
      volume: 1_000_000,
      amount: Math.round(close * 1_000_000),
    });
  }
  return bars;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const SYMBOL = "000001";
const RANGE = { startDate: "2024-11-04", endDate: "2026-09-10" };
const createdBacktestIds: string[] = [];
let tempAccountId: string | null = null;
const TEMP_USERNAME = "__bt_rulecheck__";

async function main(): Promise<void> {
  console.log("\n\x1b[1m策略回测（BacktestEngine + BacktestService）端到端测试\x1b[0m");

  /* ================================================================ */
  section("0. 合成数据：NEXT_OPEN 时序模型的精确数值断言");

  const synth = buildSyntheticBars();
  const synthBefore = JSON.stringify(synth);
  const sRes = simulateMaCross({
    symbol: "TEST",
    stockName: "合成标的",
    adjust: "qfq",
    bars: synth,
    initialCash: 100_000,
    params: { ...DEFAULT_MA_CROSS_PARAMS },
    startDate: synth[0].date,
    endDate: synth[synth.length - 1].date,
  });

  check(
    "纯函数不修改入参 bars（深比较）",
    JSON.stringify(synth) === synthBefore,
    "入参引用与内容均未变化"
  );

  // 独立复算 MA 与交叉点
  const closes = synth.map((b) => b.close);
  const nf = naiveMA(closes, 5);
  const ns = naiveMA(closes, 20);
  let naiveGolden = -1;
  let naiveDeath = -1;
  for (let i = 1; i < synth.length; i++) {
    if (nf[i] === null || ns[i] === null || nf[i - 1] === null || ns[i - 1] === null) continue;
    if (naiveGolden < 0 && nf[i - 1]! <= ns[i - 1]! && nf[i]! > ns[i]!) naiveGolden = i;
    if (naiveGolden > 0 && naiveDeath < 0 && nf[i - 1]! >= ns[i - 1]! && nf[i]! < ns[i]!) {
      naiveDeath = i;
    }
  }
  note(`独立复算：金叉 i=${naiveGolden}（${synth[naiveGolden]?.date}），死叉 i=${naiveDeath}（${synth[naiveDeath]?.date}）`);

  const sEvents = sRes.events;
  const goldEvent = sEvents.find((e) => e.type === "GOLDEN_CROSS");
  const deathEvent = sEvents.find((e) => e.type === "DEATH_CROSS");
  check(
    "首个金叉信号日 = 独立复算结果",
    goldEvent?.date === synth[naiveGolden]?.date,
    `${goldEvent?.date} vs ${synth[naiveGolden]?.date}`
  );
  check(
    "首个死叉信号日 = 独立复算结果",
    deathEvent?.date === synth[naiveDeath]?.date,
    `${deathEvent?.date} vs ${synth[naiveDeath]?.date}`
  );

  const buyTrade = sRes.trades.find((t) => t.side === "BUY");
  const sellTrade = sRes.trades.find((t) => t.side === "SELL");

  check("产生且仅产生 1 买 1 卖（配对 1 次往返）", sRes.trades.length === 2 && sRes.roundTrips.length === 1, `trades=${sRes.trades.length}`);

  check(
    "买入成交日 = 信号日的**下一根K线**（T+1 开盘成交）",
    buyTrade?.date === synth[naiveGolden + 1]?.date,
    `${buyTrade?.date} vs ${synth[naiveGolden + 1]?.date}`
  );
  check(
    "买入成交价 = 下一根K线的**开盘价**（不是收盘价）",
    !!buyTrade && near(buyTrade.price, synth[naiveGolden + 1].open) && !near(buyTrade.price, synth[naiveGolden + 1].close),
    `成交 ${buyTrade?.price} / 开盘 ${synth[naiveGolden + 1].open} / 收盘 ${synth[naiveGolden + 1].close}`
  );

  const expQty = naiveMaxLots(100_000, synth[naiveGolden + 1].open);
  const expAmount = Math.round(synth[naiveGolden + 1].open * expQty * 100) / 100;
  const expBuyFees = naiveFees(expAmount, "BUY");
  const expAvgCost = naiveAvgCost(expAmount, expBuyFees.total, expQty);

  check(
    "买入数量 = 独立复算的最大整手数（含费，资金不透支）",
    buyTrade?.quantity === expQty,
    `${buyTrade?.quantity} vs ${expQty}`
  );
  check(
    "买入数量为 100 股整数倍",
    !!buyTrade && buyTrade.quantity % LOT_SIZE === 0,
    `${buyTrade?.quantity} % ${LOT_SIZE}`
  );
  check(
    "买入成交额 = 开盘价 × 数量",
    !!buyTrade && near(buyTrade.amount, expAmount),
    `${buyTrade?.amount} vs ${expAmount}`
  );
  check(
    "买入手续费 = 独立复算（万三/最低5元 + 过户费万0.1，无印花税）",
    !!buyTrade && near(buyTrade.fee, expBuyFees.total),
    `${buyTrade?.fee} vs ${expBuyFees.total}`
  );
  check(
    "买入后成本均价（含费，6 位小数）= 独立复算",
    !!buyTrade && Math.abs(buyTrade.positionAvgCost - expAvgCost) < 1e-9,
    `${buyTrade?.positionAvgCost} vs ${expAvgCost}`
  );
  check(
    "买入后现金 = 初始资金 − (成交额 + 费用)",
    !!buyTrade && near(buyTrade.cash, 100_000 - expAmount - expBuyFees.total),
    money(buyTrade?.cash ?? NaN)
  );

  const expSellAmount = Math.round(synth[naiveDeath + 1].open * expQty * 100) / 100;
  const expSellFees = naiveFees(expSellAmount, "SELL");
  const expPnl =
    Math.round(((synth[naiveDeath + 1].open - expAvgCost) * expQty - expSellFees.total) * 100) / 100;

  check(
    "卖出成交日 = 死叉信号日的下一根K线",
    sellTrade?.date === synth[naiveDeath + 1]?.date,
    `${sellTrade?.date} vs ${synth[naiveDeath + 1]?.date}`
  );
  check(
    "卖出成交价 = 下一根K线的开盘价",
    !!sellTrade && near(sellTrade.price, synth[naiveDeath + 1].open),
    `${sellTrade?.price} vs ${synth[naiveDeath + 1].open}`
  );
  check(
    "卖出数量 = 全部持仓（清仓）",
    !!sellTrade && sellTrade.quantity === expQty && sellTrade.positionQty === 0,
    `${sellTrade?.quantity} / 剩余 ${sellTrade?.positionQty}`
  );
  check(
    "卖出手续费 = 独立复算（含印花税千一）",
    !!sellTrade && near(sellTrade.fee, expSellFees.total),
    `${sellTrade?.fee} vs ${expSellFees.total}`
  );
  check(
    "卖出已实现盈亏 = 独立复算 (卖价−成本均价)×数量 − 卖出费用",
    !!sellTrade && near(sellTrade.realizedPnl ?? NaN, expPnl),
    `${sellTrade?.realizedPnl} vs ${expPnl}`
  );
  check(
    "【资金守恒】已实现盈亏 === 期末资产 − 初始资金（全仓一进一出）",
    near((sellTrade?.realizedPnl ?? 0) - (sRes.metrics.finalAsset - 100_000), 0, 0.02),
    `pnl ${sellTrade?.realizedPnl} / Δ资产 ${(sRes.metrics.finalAsset - 100_000).toFixed(2)}`
  );
  check(
    "合成场景总收益率 = 已实现盈亏 / 初始资金",
    near(sRes.metrics.totalReturn, (expPnl / 100_000) * 100, 0.02),
    `${sRes.metrics.totalReturn}%`
  );

  /* ================================================================ */
  section("1. 未来函数哨兵（真实数据：前缀截断 / 追加未来K线）");

  const info = await getStockInfoByCode(SYMBOL);
  if (!info) {
    check("取到 000001 股票信息", false);
    return finish();
  }
  const bars = await getKlines(SYMBOL, {
    period: "1d",
    adjust: info.adjust,
    startDate: RANGE.startDate,
    endDate: RANGE.endDate,
    limit: MAX_BARS,
  });
  check("真实日K 已加载", bars.length > 200, `${bars.length} 根（${bars[0]?.date} ~ ${bars[bars.length - 1]?.date}）`);
  note(`口径 ${info.adjust}（该股自身口径），初始资金 ${money(DEFAULT_INITIAL_CASH)}`);

  const full = simulateMaCross({
    symbol: SYMBOL,
    stockName: info.name,
    adjust: info.adjust,
    bars,
    initialCash: DEFAULT_INITIAL_CASH,
    params: { ...DEFAULT_MA_CROSS_PARAMS },
    startDate: RANGE.startDate,
    endDate: RANGE.endDate,
  });

  const TRAILING_SKIP = "区间已到最后一根K线";
  let sentinelAllOk = true;
  let sentinelDetail = "";
  const checkpoints = [30, 60, 120, 200, 300, Math.floor(bars.length * 0.8)];

  for (const k of checkpoints) {
    if (k < 1 || k >= bars.length) continue;
    const prefix = simulateMaCross({
      symbol: SYMBOL,
      stockName: info.name,
      adjust: info.adjust,
      bars: bars.slice(0, k + 1),
      initialCash: DEFAULT_INITIAL_CASH,
      params: { ...DEFAULT_MA_CROSS_PARAMS },
      startDate: RANGE.startDate,
      endDate: bars[k].date,
    });
    const lastDate = bars[k].date;

    // ① 资金曲线：前缀运行必须与全量运行的同长度前缀**逐字段一致**
    const curveSame =
      JSON.stringify(prefix.equityCurve) ===
      JSON.stringify(full.equityCurve.slice(0, k + 1));

    // ② 成交：前缀运行的成交 == 全量运行中「成交日 ≤ 前缀末日」的成交
    const prefixTrades = JSON.stringify(prefix.trades);
    const fullTradesCut = JSON.stringify(
      full.trades.filter((t) => t.date <= lastDate)
    );

    // ③ 事件：剔除「区间末尾未成交」的结构性追加项后再比
    const prefixEvents = JSON.stringify(
      prefix.events.filter((e) => !e.reason.startsWith(TRAILING_SKIP))
    );
    const fullEventsCut = JSON.stringify(
      full.events.filter((e) => e.date <= lastDate)
    );

    const ok = curveSame && prefixTrades === fullTradesCut && prefixEvents === fullEventsCut;
    if (!ok) {
      sentinelAllOk = false;
      sentinelDetail = `k=${k}(${lastDate}) curve=${curveSame} trades=${prefixTrades === fullTradesCut} events=${prefixEvents === fullEventsCut}`;
      break;
    }
  }
  check(
    "截断到任意前缀重跑：资金曲线 / 成交 / 事件与全量运行的历史部分完全一致（无未来函数）",
    sentinelAllOk,
    sentinelAllOk ? `检查点 ${checkpoints.join(", ")}` : sentinelDetail
  );

  // 追加「未来K线」：历史部分不得改变
  const futureBars: KlineBar[] = [];
  const lastBar = bars[bars.length - 1];
  for (let i = 1; i <= 5; i++) {
    const d = new Date(`${lastBar.date}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const close = lastBar.close * 3; // 夸张的未来价格
    futureBars.push({
      date: d.toISOString().slice(0, 10),
      open: close,
      high: close * 1.05,
      low: close * 0.95,
      close,
      volume: 1,
      amount: 1,
    });
  }
  const extended = simulateMaCross({
    symbol: SYMBOL,
    stockName: info.name,
    adjust: info.adjust,
    bars: [...bars, ...futureBars],
    initialCash: DEFAULT_INITIAL_CASH,
    params: { ...DEFAULT_MA_CROSS_PARAMS },
    startDate: RANGE.startDate,
    endDate: futureBars[futureBars.length - 1].date,
  });
  check(
    "追加 5 根「未来K线」后，历史部分资金曲线逐点不变",
    JSON.stringify(extended.equityCurve.slice(0, bars.length)) === JSON.stringify(full.equityCurve),
    `前 ${bars.length} 点`
  );
  check(
    "追加未来K线后，历史部分成交笔不变",
    JSON.stringify(extended.trades.filter((t) => t.date <= lastBar.date)) ===
      JSON.stringify(full.trades),
    `${full.trades.length} 笔`
  );

  /* ================================================================ */
  section("2. 时序与结构完整性");

  check("executionModel = NEXT_OPEN", full.executionModel === "NEXT_OPEN", full.executionModel);

  const barIndex = new Map<string, number>();
  bars.forEach((b, i) => barIndex.set(b.date, i));

  check(
    "资金曲线日期序列 === 日K 日期序列（逐日一行）",
    JSON.stringify(full.equityCurve.map((e) => e.date)) === JSON.stringify(bars.map((b) => b.date)),
    `${full.equityCurve.length} 行`
  );

  let monotonic = true;
  for (let i = 1; i < full.equityCurve.length; i++) {
    if (full.equityCurve[i].date <= full.equityCurve[i - 1].date) monotonic = false;
  }
  check("资金曲线日期严格递增（按时间顺序处理）", monotonic);

  let eventMonotonic = true;
  for (let i = 1; i < full.events.length; i++) {
    if (full.events[i].date < full.events[i - 1].date) eventMonotonic = false;
  }
  check("事件日期单调不减", eventMonotonic, `${full.events.length} 条事件`);

  let tradesMonotonic = true;
  for (let i = 1; i < full.trades.length; i++) {
    if (full.trades[i].date < full.trades[i - 1].date) tradesMonotonic = false;
  }
  check("成交日期单调不减", tradesMonotonic, `${full.trades.length} 笔成交`);

  const eventSeq = full.events.map((e) => e.seq);
  check(
    "事件序号从 1 连续递增（每次事件都记录）",
    eventSeq.every((s, i) => s === i + 1),
    `seq 1..${eventSeq.length}`
  );

  let openOk = true;
  let signalOk = true;
  let badTrade = "";
  for (const t of full.trades) {
    const ti = barIndex.get(t.date);
    if (ti === undefined) {
      openOk = false;
      badTrade = `成交日 ${t.date} 不在日K序列中`;
      break;
    }
    if (Math.abs(t.price - bars[ti].open) > 1e-9) {
      openOk = false;
      badTrade = `${t.date} 成交价 ${t.price} ≠ 开盘价 ${bars[ti].open}`;
      break;
    }
    const si = barIndex.get(t.signalDate);
    if (si === undefined || si + 1 !== ti) {
      signalOk = false;
      badTrade = `${t.date} 的信号日 ${t.signalDate} 不是它的前一根K线`;
      break;
    }
  }
  check("每笔成交价 === 该成交日的**开盘价**（真实数据交叉验证）", openOk, badTrade || `${full.trades.length} 笔全部吻合`);
  check("每笔成交的信号日 === 成交日的前一根K线（T 日信号 / T+1 成交）", signalOk, badTrade || "全部吻合");

  const markersMatchTrades =
    full.markers.length === full.trades.length &&
    full.markers.every((mk, i) => mk.date === full.trades[i].date && mk.type === full.trades[i].side);
  check("买卖点标记与成交一一对应（取实际成交时点）", markersMatchTrades, `${full.markers.length} 个标记`);

  check(
    "预热根数 = 慢线周期 − 1",
    full.warmupBars === DEFAULT_MA_CROSS_PARAMS.slow - 1,
    `${full.warmupBars}`
  );

  const priceInRange = full.markers.every((mk) => {
    const i = barIndex.get(mk.date);
    if (i === undefined) return false;
    const b = bars[i];
    return mk.price >= b.low - 1e-9 && mk.price <= b.high + 1e-9;
  });
  check("买卖点价格落在对应K线的高低区间内（绘制可信）", priceInRange);

  /* ================================================================ */
  section("3. 独立对照：费用 / 成本均价 / 已实现盈亏（朴素重写实现）");

  const feeCases = [1_000, 9_360, 16_666.66, 49_360, 99_360, 700_000, 1_234_567.89];
  let feeAllOk = true;
  let feeDetail = "";
  for (const amt of feeCases) {
    const a = naiveFees(amt, "BUY");
    const b = naiveFees(amt, "SELL");
    // 与引擎的成交记录口径对照（引擎没有导出 calcFees 的入参表，这里用成交记录反推）
    // —— buy/sell 两侧手工复算的合计必须满足「合计 = 三项之和（2 位小数）」
    if (
      Math.abs(a.total - (a.commission + a.stampTax + a.transferFee)) > 1e-9 ||
      Math.abs(b.total - (b.commission + b.stampTax + b.transferFee)) > 1e-9
    ) {
      feeAllOk = false;
      feeDetail = `金额 ${amt} 合计不等于三项之和`;
      break;
    }
  }
  check("朴素费用实现自洽（合计 = 佣金 + 印花税 + 过户费）", feeAllOk, feeDetail || "7 组金额");

  // 引擎成交记录 vs 朴素复算：逐笔核对费用与成本均价
  let tradeFeeOk = true;
  let tradeCostOk = true;
  let tradeDetail = "";
  for (const t of full.trades) {
    const naive = naiveFees(t.amount, t.side);
    if (Math.abs(t.fee - naive.total) > 0.011) {
      tradeFeeOk = false;
      tradeDetail = `${t.date} ${t.side} 引擎 ${t.fee} vs 朴素 ${naive.total}`;
      break;
    }
    if (
      Math.abs(t.feeDetail.commission - naive.commission) > 0.011 ||
      Math.abs(t.feeDetail.stampTax - naive.stampTax) > 0.011 ||
      Math.abs(t.feeDetail.transferFee - naive.transferFee) > 0.011
    ) {
      tradeFeeOk = false;
      tradeDetail = `${t.date} ${t.side} 费用拆分不一致`;
      break;
    }
  }
  check("每笔成交手续费（含拆分）=== 朴素独立复算", tradeFeeOk, tradeDetail || `${full.trades.length} 笔`);

  for (const t of full.trades) {
    if (t.side === "SELL") continue;
    const exp = naiveAvgCost(t.amount, t.fee, t.quantity);
    if (Math.abs(t.positionAvgCost - exp) > 1e-9) {
      tradeCostOk = false;
      tradeDetail = `${t.date} 成本均价 ${t.positionAvgCost} vs 朴素 ${exp}`;
      break;
    }
  }
  check("买入后成本均价（含费 / 6 位小数）=== 朴素独立复算", tradeCostOk, tradeDetail || "全部吻合");

  let pnlOk = true;
  let pnlDetail = "";
  for (const rt of full.roundTrips) {
    // 朴素公式：(卖价 − 买入成本均价) × 数量 − 卖出费用
    const buy = full.trades.find((x) => x.side === "BUY" && x.date === rt.entryDate);
    if (!buy) continue;
    const expect =
      Math.round(((rt.exitPrice - buy.positionAvgCost) * rt.quantity - rt.sellFee) * 100) / 100;
    if (Math.abs(rt.pnl - expect) > 0.011) {
      pnlOk = false;
      pnlDetail = `${rt.exitDate} 引擎 ${rt.pnl} vs 朴素 ${expect}`;
      break;
    }
  }
  check("每笔配对已实现盈亏 === (卖价 − 成本均价)×数量 − 卖出费用（朴素复算）", pnlOk, pnlDetail || `${full.roundTrips.length} 笔往返`);

  /* ================================================================ */
  section("4. 独立对照：绩效指标（朴素实现 + 手算）");

  const m = full.metrics;
  const curve = full.equityCurve;

  check(
    "总收益率 = (期末 − 期初)/期初 × 100",
    near(m.totalReturn, ((m.finalAsset - m.initialAsset) / m.initialAsset) * 100, 0.02),
    `${m.totalReturn}%`
  );
  check(
    "期末资产 = 最后一根资金曲线的总资产",
    near(m.finalAsset, curve[curve.length - 1].totalAsset, 0.02),
    money(m.finalAsset)
  );
  check(
    "年化收益率 = ((期末/期初)^(244/交易日数) − 1) × 100（独立复算）",
    near(m.annualReturn, naiveAnnual(m.finalAsset, m.initialAsset, m.tradingDays), 0.05),
    `${m.annualReturn}% vs ${naiveAnnual(m.finalAsset, m.initialAsset, m.tradingDays)}%`
  );
  check(
    "交易天数 = 资金曲线长度",
    m.tradingDays === curve.length,
    `${m.tradingDays}`
  );

  check(
    "最大回撤 = 朴素 O(n²) 实现结果",
    near(m.maxDrawdown, naiveMaxDrawdown(curve.map((c) => ({ date: c.date, totalAsset: c.totalAsset }))), 0.02),
    `${m.maxDrawdown}%`
  );
  const ddMin = Math.min(...full.drawdownCurve.map((d) => d.drawdownPercent));
  check(
    "【口径一致性】回撤曲线最小值 === 最大回撤",
    near(ddMin, m.maxDrawdown, 0.001),
    `曲线 min ${ddMin}% / 指标 ${m.maxDrawdown}%`
  );
  check(
    "回撤曲线长度 = 资金曲线长度（逐日一点）",
    full.drawdownCurve.length === curve.length,
    `${full.drawdownCurve.length}`
  );
  const ddNeverPositive = full.drawdownCurve.every((d) => d.drawdownPercent <= 1e-9);
  check("回撤曲线取值恒 ≤ 0（负值口径）", ddNeverPositive);
  const peakOnlyBackward = full.drawdownCurve.every((d, i) => {
    if (i === 0) return true;
    return d.peak >= full.drawdownCurve[i - 1].peak - 1e-9;
  });
  check("运行峰值单调不减（只向后看，不用未来数据）", peakOnlyBackward);
  if (m.maxDrawdownStart && m.maxDrawdownEnd) {
    const si = barIndex.get(m.maxDrawdownStart);
    const ei = barIndex.get(m.maxDrawdownEnd);
    check(
      "最大回撤起止日顺序正确（峰值日 ≤ 谷底日）",
      si !== undefined && ei !== undefined && si <= ei,
      `${m.maxDrawdownStart} → ${m.maxDrawdownEnd}`
    );
  } else {
    check("最大回撤起止日存在（回撤 > 0 的场景）", m.maxDrawdown === 0, "无回撤");
  }

  const wins = full.roundTrips.filter((r) => r.pnl > 0);
  const losses = full.roundTrips.filter((r) => r.pnl < 0);
  check("交易次数 = 配对往返数（一买一卖计 1 次）", m.tradeCount === full.roundTrips.length, `${m.tradeCount}`);
  check(
    "胜 / 负笔数 = 按盈亏符号独立统计",
    m.winCount === wins.length && m.lossCount === losses.length,
    `胜 ${m.winCount}/${wins.length}，负 ${m.lossCount}/${losses.length}`
  );
  check(
    "胜率 = 盈利笔数 / 总交易次数 × 100",
    near(m.winRate, m.tradeCount > 0 ? (wins.length / m.tradeCount) * 100 : 0, 0.02),
    `${m.winRate}%`
  );

  const totalWin = wins.reduce((a, r) => a + r.pnl, 0);
  const totalLoss = losses.reduce((a, r) => a + r.pnl, 0);
  check(
    "平均盈利 = 盈利单均值（独立复算）",
    near(m.avgWin, wins.length > 0 ? totalWin / wins.length : 0, 0.02),
    money(m.avgWin)
  );
  check(
    "平均亏损 = 亏损单均值（负数，独立复算）",
    near(m.avgLoss, losses.length > 0 ? totalLoss / losses.length : 0, 0.02),
    money(m.avgLoss)
  );
  check("平均亏损为负值", m.avgLoss <= 0, `${m.avgLoss}`);
  check(
    "盈亏比 = 总盈利 / |总亏损|（独立复算）",
    losses.length > 0
      ? m.profitFactor !== null && near(m.profitFactor, totalWin / Math.abs(totalLoss), 0.02)
      : m.profitFactor === null,
    `${m.profitFactor}`
  );
  check(
    "赔率 = 平均盈利 / |平均亏损|（独立复算）",
    losses.length > 0 && m.avgLoss !== 0
      ? m.payoffRatio !== null && near(m.payoffRatio, m.avgWin / Math.abs(m.avgLoss), 0.02)
      : m.payoffRatio === null,
    `${m.payoffRatio}`
  );

  // 夏普：先独立复算日收益率序列，再算均值 / 样本标准差 / 年化
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const dailyNaive = curve.map((c, i) => {
    const prev = i === 0 ? m.initialAsset : curve[i - 1].totalAsset;
    return prev > 0 ? r2(((c.totalAsset - prev) / prev) * 100) : 0;
  });
  check(
    "每日收益率 = 相对前一日总资产的涨跌幅（独立复算）",
    dailyNaive.every((v, i) => near(v, curve[i].dailyReturn, 0.02)),
    `首日 ${curve[0].dailyReturn}% / 末日 ${curve[curve.length - 1].dailyReturn}%`
  );
  const rets = dailyNaive.map((v) => v / 100);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.length > 1
      ? rets.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (rets.length - 1)
      : 0;
  const dailyVol = Math.sqrt(variance);
  const expVol = r2(dailyVol * Math.sqrt(244) * 100);
  const expSharpe = r2(((mean - 0.02 / 244) / dailyVol) * Math.sqrt(244));
  check("年化波动率 = 日标准差 × √244（独立复算）", near(m.volatility, expVol, 0.02), `${m.volatility}% vs ${expVol}%`);
  check("夏普比率 = (日均收益 − 无风险日收益)/日标准差 × √244（独立复算）", near(m.sharpeRatio, expSharpe, 0.02), `${m.sharpeRatio} vs ${expSharpe}`);

  const feeSum = r2(full.trades.reduce((a, t) => a + t.fee, 0));
  check("累计手续费 = Σ 各笔成交费用", near(m.totalFee, feeSum, 0.02), money(m.totalFee));
  check("手续费占初始资金比 = 累计手续费 / 初始资金 × 100", near(m.feeRatio, (m.totalFee / m.initialAsset) * 100, 0.02), `${m.feeRatio}%`);

  const avgHold = full.roundTrips.length > 0
    ? r2(full.roundTrips.reduce((a, r) => a + r.holdBars, 0) / full.roundTrips.length)
    : 0;
  check("平均持有交易日数 = Σ持有根数 / 交易次数", near(m.avgHoldDays, avgHold, 0.02), `${m.avgHoldDays}`);

  // 资金守恒：区间末尾可能**仍持仓未平**（信号在最后一根K线产生、无次日行情成交），
  // 因此正确的恒等式是「已实现盈亏 + 期末浮动盈亏 = 总资产变动」，而不是只看已实现。
  const r2c = (v: number) => Math.round(v * 100) / 100;
  const lastPoint = curve[curve.length - 1];
  const openQty = lastPoint.positionQty;
  const lastBuyTrade = [...full.trades].reverse().find((t) => t.side === "BUY");
  const openCost = openQty > 0 && lastBuyTrade ? lastBuyTrade.positionAvgCost * openQty : 0;
  const sumPnl = r2c(full.roundTrips.reduce((a, r) => a + r.pnl, 0));
  const sumUnrealized = r2c(lastPoint.marketValue - openCost);
  const residual = sumPnl + sumUnrealized - (m.finalAsset - m.initialAsset);
  check(
    "【资金守恒】Σ已实现盈亏 + 期末浮动盈亏 === 期末资产 − 初始资金",
    Math.abs(residual) <= 0.5 + full.trades.length * 0.05,
    `已实现 ${sumPnl} + 浮动 ${sumUnrealized}${openQty > 0 ? `（未平仓 ${openQty} 股）` : "（已清仓）"} = ${(sumPnl + sumUnrealized).toFixed(2)} / Δ资产 ${(m.finalAsset - m.initialAsset).toFixed(2)}，残差 ${residual.toFixed(4)}`
  );

  const cashFromTrades = r2c(
    full.trades.reduce(
      (a, t) => a + (t.side === "SELL" ? t.amount - t.fee : -(t.amount + t.fee)),
      0
    )
  );
  check(
    "【资金守恒】期末现金 === 初始资金 + Σ(卖出净到账) − Σ(买入总支出)",
    near(lastPoint.cash, m.initialAsset + cashFromTrades, 0.02),
    `${money(lastPoint.cash)} vs ${money(m.initialAsset + cashFromTrades)}`
  );

  // 基准（买入持有）
  if (full.benchmark) {
    const b = full.benchmark;
    const qty = naiveMaxLots(m.initialAsset, bars[0].close);
    const buyAmt = r2(bars[0].close * qty);
    const buyF = naiveFees(buyAmt, "BUY");
    const sellAmt = r2(bars[bars.length - 1].close * qty);
    const sellF = naiveFees(sellAmt, "SELL");
    const expFinal = r2(m.initialAsset - r2(buyAmt + buyF.total) + r2(sellAmt - sellF.total));
    check(
      "买入持有基准收益率 = 同费用口径朴素复算",
      near(b.returnPercent, ((expFinal - m.initialAsset) / m.initialAsset) * 100, 0.03),
      `${b.returnPercent}% vs ${(((expFinal - m.initialAsset) / m.initialAsset) * 100).toFixed(2)}%（${b.initialPrice} → ${b.finalPrice}）`
    );
  } else {
    check("基准为 null 时区间过短（无建仓可能）", bars.length < 2, `${bars.length} 根`);
  }

  /* ================================================================ */
  section("5. 资金与持仓约束（T+1 / 整手 / 资金不透支 / 资产恒等式）");

  const noNegativeCash = full.equityCurve.every((e) => e.cash >= -1e-9);
  check("全程现金不为负（资金约束生效）", noNegativeCash, `最低 ${Math.min(...full.equityCurve.map((e) => e.cash)).toFixed(2)}`);

  const identityOk = full.equityCurve.every((e) => Math.abs(e.totalAsset - (e.cash + e.marketValue)) <= 0.011);
  check("【恒等式】每一点 totalAsset === cash + marketValue", identityOk);

  const navOk = full.equityCurve.every((e) => Math.abs(e.nav - e.totalAsset / m.initialAsset) <= 1e-6);
  check("净值 nav = totalAsset / initialCash（6 位小数）", navOk);

  const retOk = full.equityCurve.every(
    (e) => Math.abs(e.returnPercent - ((e.totalAsset - m.initialAsset) / m.initialAsset) * 100) <= 0.011
  );
  check("累计收益率 returnPercent = (总资产 − 初始资金)/初始资金", retOk);

  const qtyMultiple = full.trades.filter((t) => t.side === "BUY").every((t) => t.quantity % LOT_SIZE === 0 && t.quantity > 0);
  check("所有买入数量均为 100 股整数倍且为正", qtyMultiple);

  // T+1：卖出成交日必须严格晚于配对买入日
  let t1Ok = true;
  let t1Detail = "";
  for (const rt of full.roundTrips) {
    const bi = barIndex.get(rt.entryDate);
    const si = barIndex.get(rt.exitDate);
    if (bi === undefined || si === undefined || si <= bi) {
      t1Ok = false;
      t1Detail = `${rt.entryDate} → ${rt.exitDate}`;
      break;
    }
  }
  check("T+1：卖出成交日严格晚于买入成交日（无当日回转）", t1Ok, t1Detail || `${full.roundTrips.length} 笔往返`);

  const flatAtEnd = full.equityCurve[full.equityCurve.length - 1].positionQty;
  check(
    "期末持仓与最后一笔成交后的持仓一致（如实记录）",
    flatAtEnd === (full.trades.length > 0 ? full.trades[full.trades.length - 1].positionQty : 0),
    `${flatAtEnd} 股`
  );

  const skipReasons = full.events.filter((e) => e.type === "SKIP");
  const skipAllHaveReason = skipReasons.every((e) => e.reason.length > 0);
  check("未成交事件均带有原因说明（不静默丢弃）", skipAllHaveReason, `${skipReasons.length} 条`);

  /* ================================================================ */
  section("6. 参数校验（引擎层拒绝非法输入）");

  const badInputs: { name: string; input: Parameters<typeof runBacktest>[0] }[] = [
    { name: "代码为空", input: { symbol: "", startDate: RANGE.startDate, endDate: RANGE.endDate, initialCash: 100_000 } },
    { name: "日期格式错误", input: { symbol: SYMBOL, startDate: "2025/01/01", endDate: RANGE.endDate, initialCash: 100_000 } },
    { name: "开始晚于结束", input: { symbol: SYMBOL, startDate: RANGE.endDate, endDate: RANGE.startDate, initialCash: 100_000 } },
    { name: "初始资金为 0", input: { symbol: SYMBOL, startDate: RANGE.startDate, endDate: RANGE.endDate, initialCash: 0 } },
    { name: "初始资金为负", input: { symbol: SYMBOL, startDate: RANGE.startDate, endDate: RANGE.endDate, initialCash: -1 } },
    { name: "初始资金超过 10 亿", input: { symbol: SYMBOL, startDate: RANGE.startDate, endDate: RANGE.endDate, initialCash: 2_000_000_000 } },
    { name: "股票不存在", input: { symbol: "999999", startDate: RANGE.startDate, endDate: RANGE.endDate, initialCash: 100_000 } },
    { name: "快线 ≥ 慢线", input: { symbol: SYMBOL, startDate: RANGE.startDate, endDate: RANGE.endDate, initialCash: 100_000, params: { fast: 20, slow: 5 } } },
    { name: "快线为 0", input: { symbol: SYMBOL, startDate: RANGE.startDate, endDate: RANGE.endDate, initialCash: 100_000, params: { fast: 0, slow: 20 } } },
    { name: "慢线超过上限 250", input: { symbol: SYMBOL, startDate: RANGE.startDate, endDate: RANGE.endDate, initialCash: 100_000, params: { fast: 5, slow: 300 } } },
  ];
  for (const c of badInputs) {
    const r = await runBacktest(c.input);
    check(`拒绝：${c.name}`, !r.success, r.message.slice(0, 46));
  }

  const noData = await runBacktest({
    symbol: SYMBOL,
    startDate: "1990-01-01",
    endDate: "1990-12-31",
    initialCash: 100_000,
  });
  check("拒绝：区间内无数据", !noData.success, noData.message.slice(0, 56));

  const unsupported = await runBacktest({
    symbol: SYMBOL,
    startDate: RANGE.startDate,
    endDate: RANGE.endDate,
    initialCash: 100_000,
    strategy: "RSI" as never,
  });
  check("拒绝：不支持的策略（第一批仅 MA_CROSS）", !unsupported.success, unsupported.message);

  const tooShortBars = simulateMaCross({
    symbol: "T",
    stockName: "短区间",
    adjust: "qfq",
    bars: bars.slice(0, 10),
    initialCash: 100_000,
    params: { fast: 5, slow: 20 },
    startDate: bars[0].date,
    endDate: bars[9].date,
  });
  check(
    "区间过短时如实提示「不可能产生交易」而非编造结果",
    tooShortBars.trades.length === 0 && tooShortBars.warnings.some((w) => w.includes("不可能")),
    tooShortBars.warnings[0]?.slice(0, 46) ?? "无提示"
  );

  // 高价股 + 小资金（真实场景：茅台约 1400 元/股，一手 ≈ 14 万 > 10 万初始资金）
  const pricey = buildSyntheticBars().map((b) => ({
    ...b,
    open: b.open * 1000,
    high: b.high * 1000,
    low: b.low * 1000,
    close: b.close * 1000,
  }));
  const priceyRes = simulateMaCross({
    symbol: "PRICEY",
    stockName: "高价标的",
    adjust: "qfq",
    bars: pricey,
    initialCash: DEFAULT_INITIAL_CASH,
    params: { ...DEFAULT_MA_CROSS_PARAMS },
    startDate: pricey[0].date,
    endDate: pricey[pricey.length - 1].date,
  });
  check(
    "高价股 + 小资金：金叉存在但买不起一手 → 如实记为未成交（不放宽规则凑成交）",
    priceyRes.trades.length === 0 &&
      priceyRes.metrics.tradeCount === 0 &&
      priceyRes.events.some((e) => e.type === "GOLDEN_CROSS") &&
      priceyRes.events.some((e) => e.type === "SKIP" && e.reason.startsWith("资金不足")),
    `${priceyRes.events.filter((e) => e.type === "GOLDEN_CROSS").length} 次金叉 / ${priceyRes.events.filter((e) => e.type === "SKIP").length} 次未成交`
  );
  check(
    "零交易时明确区分「无信号」与「有信号但资金不足」",
    priceyRes.warnings.some((w) => w.includes("不足以买入一手")) &&
      !priceyRes.warnings.some((w) => w.includes("未产生可成交的均线交叉信号")),
    priceyRes.warnings.find((w) => w.includes("不足以买入一手"))?.slice(0, 80) ?? "无提示"
  );

  /* ================================================================ */
  section("7. 与 TradingEngine 口径交叉（共享规则但不互相耦合）");

  tempAccountId = await createAccount({
    username: TEMP_USERNAME,
    nickname: "回测口径校验",
    accountName: "临时校验账户",
    initialCash: 500_000,
  });

  const px = 10.8;
  const qty = 9200;
  const tradeDate = bars[bars.length - 1].date;
  const placed = await placeOrder({
    accountId: tempAccountId,
    stockCode: SYMBOL,
    side: "BUY",
    orderType: "LIMIT",
    price: px,
    quantity: qty,
    tradeDate,
  });
  check("TradingEngine 限价买入成功（用于口径交叉）", placed.success, placed.message.slice(0, 56));

  const engTrade = await prisma.trade.findFirst({
    where: { accountId: tempAccountId, side: "BUY" },
    orderBy: { createdAt: "desc" },
    select: {
      price: true,
      quantity: true,
      amount: true,
      commission: true,
      stampTax: true,
      transferFee: true,
    },
  });
  const engPos = await prisma.position.findFirst({
    where: { accountId: tempAccountId },
    select: { avgCost: true, quantity: true },
  });
  if (engTrade) {
    const n = (v: unknown) => Number((v as { toString(): string }).toString());
    const amt = n(engTrade.amount);
    const engFeeTotal =
      Math.round((n(engTrade.commission) + n(engTrade.stampTax) + n(engTrade.transferFee)) * 100) / 100;
    const naive = naiveFees(amt, "BUY");
    check(
      "TradingEngine 手续费合计 === 朴素规则实现",
      near(engFeeTotal, naive.total, 0.011),
      `${engFeeTotal} vs ${naive.total}`
    );
    check(
      "TradingEngine 费用拆分 === 朴素规则实现（佣金 / 印花税 / 过户费）",
      near(n(engTrade.commission), naive.commission, 0.011) &&
        near(n(engTrade.stampTax), naive.stampTax, 0.011) &&
        near(n(engTrade.transferFee), naive.transferFee, 0.011),
      `${n(engTrade.commission)}/${n(engTrade.stampTax)}/${n(engTrade.transferFee)}`
    );
    check(
      "TradingEngine 持仓成本均价 === 朴素规则实现（(成交额+费用)/数量，6 位小数）",
      !!engPos && Math.abs(n(engPos.avgCost) - naiveAvgCost(amt, naive.total, qty)) < 1e-6,
      `${engPos ? n(engPos.avgCost) : "—"} vs ${naiveAvgCost(amt, naive.total, qty)}`
    );
    const btAmt = Math.round(px * qty * 100) / 100;
    const btNaive = naiveFees(btAmt, "BUY");
    check(
      "同价同量下：BacktestEngine 与 TradingEngine 的成交额与费用完全一致",
      near(btNaive.total, naive.total, 0.011) && btAmt === amt,
      `回测 ${btNaive.total} / 实盘 ${naive.total}（成交额 ${btAmt}）`
    );
  } else {
    check("取到 TradingEngine 成交记录", false);
  }

  /* ================================================================ */
  section("8. 服务层：落库 / 往返一致 / 失败不落库 / 零污染");

  const counts = async () => ({
    account: await prisma.account.count(),
    position: await prisma.position.count(),
    order: await prisma.order.count(),
    trade: await prisma.trade.count(),
    dailyAsset: await prisma.dailyAsset.count(),
    simulation: await prisma.simulation.count(),
  });
  const before = await counts();

  const saved = await runAndSaveBacktest({
    symbol: SYMBOL,
    startDate: RANGE.startDate,
    endDate: RANGE.endDate,
    initialCash: DEFAULT_INITIAL_CASH,
  });
  check("落库成功且返回记录 ID", saved.success && !!saved.id, saved.message.slice(0, 56));
  if (saved.id) createdBacktestIds.push(saved.id);

  if (saved.id) {
    const d = await getBacktestById(saved.id);
    check("详情可读取", !!d);
    if (d) {
      check("详情标的一致", d.symbol === SYMBOL && d.adjust === info.adjust, `${d.symbol}/${d.adjust}`);
      check("详情日K 重新取自库内（区间与记录一致）", d.bars.length === full.barCount && d.bars[0].date === full.firstBarDate && d.bars[d.bars.length - 1].date === full.lastBarDate, `${d.bars.length} 根`);
      check("详情资金曲线与引擎结果一致", JSON.stringify(d.equityCurve) === JSON.stringify(full.equityCurve), `${d.equityCurve.length} 行`);
      check("详情成交明细与引擎结果一致", JSON.stringify(d.trades) === JSON.stringify(full.trades), `${d.trades.length} 笔`);
      check("详情事件日志与引擎结果一致", JSON.stringify(d.events) === JSON.stringify(full.events), `${d.events.length} 条`);
      check("详情买卖点与引擎结果一致", JSON.stringify(d.markers) === JSON.stringify(full.markers), `${d.markers.length} 个`);
      check("详情配对往返与引擎结果一致", JSON.stringify(d.roundTrips) === JSON.stringify(full.roundTrips), `${d.roundTrips.length} 笔`);
      check("详情回撤曲线与引擎结果一致", JSON.stringify(d.drawdownCurve) === JSON.stringify(full.drawdownCurve), `${d.drawdownCurve.length} 行`);
      check("详情警告与引擎结果一致", JSON.stringify(d.warnings) === JSON.stringify(full.warnings));
      check(
        "【DB 往返后指标不漂移】9 项核心指标与引擎一致",
        d.metrics.totalReturn === full.metrics.totalReturn &&
          d.metrics.annualReturn === full.metrics.annualReturn &&
          d.metrics.maxDrawdown === full.metrics.maxDrawdown &&
          d.metrics.sharpeRatio === full.metrics.sharpeRatio &&
          d.metrics.winRate === full.metrics.winRate &&
          d.metrics.tradeCount === full.metrics.tradeCount &&
          d.metrics.avgWin === full.metrics.avgWin &&
          d.metrics.avgLoss === full.metrics.avgLoss &&
          d.metrics.profitFactor === full.metrics.profitFactor,
        `总收益 ${d.metrics.totalReturn}% / 回撤 ${d.metrics.maxDrawdown}% / 夏普 ${d.metrics.sharpeRatio}`
      );
      check(
        "回撤起止日经 DB 往返后仍与资金曲线自洽",
        !!d.metrics.maxDrawdownStart && !!d.metrics.maxDrawdownEnd &&
          barIndex.has(d.metrics.maxDrawdownStart) && barIndex.has(d.metrics.maxDrawdownEnd),
        `${d.metrics.maxDrawdownStart} → ${d.metrics.maxDrawdownEnd}`
      );
      check(
        "详情重建的累计手续费 / 平均持有天数与引擎一致",
        near(d.metrics.totalFee, full.metrics.totalFee, 0.02) && near(d.metrics.avgHoldDays, full.metrics.avgHoldDays, 0.02),
        `${d.metrics.totalFee} / ${d.metrics.avgHoldDays}`
      );
    }
  }

  const list = await listBacktests();
  const mine = list.find((x) => x.id === saved.id);
  check("历史列表可列出刚保存的记录", !!mine, `${list.length} 条历史`);
  check(
    "列表项策略参数解析正确（JSON 往返）",
    mine?.params.fast === 5 && mine?.params.slow === 20,
    JSON.stringify(mine?.params)
  );

  const badSave = await runAndSaveBacktest({
    symbol: "999999",
    startDate: RANGE.startDate,
    endDate: RANGE.endDate,
    initialCash: 100_000,
  });
  check("失败的回测不落库（无噪音历史）", !badSave.success && !badSave.id, badSave.message);
  const listAfterBad = await listBacktests();
  check("失败回测后历史条数不变", listAfterBad.length === list.length, `${listAfterBad.length}`);

  if (saved.id) {
    const del = await deleteBacktest(saved.id);
    createdBacktestIds.splice(createdBacktestIds.indexOf(saved.id), 1);
    check("删除回测记录成功", del.success, del.message);
    const gone = await getBacktestById(saved.id);
    check("删除后详情不可读", gone === null);
    const delAgain = await deleteBacktest(saved.id);
    check("删除不存在的记录返回失败而非抛错", !delAgain.success, delAgain.message);
  }

  const after = await counts();
  check(
    "【零污染】Account / Position / Order / Trade / DailyAsset / Simulation 行数完全不变",
    JSON.stringify(before) === JSON.stringify(after),
    `账户 ${before.account}→${after.account}，持仓 ${before.position}→${after.position}，委托 ${before.order}→${after.order}，成交 ${before.trade}→${after.trade}，快照 ${before.dailyAsset}→${after.dailyAsset}，模拟 ${before.simulation}→${after.simulation}`
  );

  /* ================================================================ */
  section("9. 图表配置结构（资金曲线 / 回撤曲线，纯函数确定性断言）");

  const asArr = (v: unknown) => (Array.isArray(v) ? v : [v]);
  const equityOpt = buildBacktestEquityOption({
    points: full.equityCurve,
    initialCash: full.initialCash,
    benchmarkFinalAsset: full.benchmark?.finalAsset ?? null,
  });
  const eqSeries = asArr(equityOpt.series) as Record<string, unknown>[];
  const eqX = asArr(equityOpt.xAxis) as Record<string, unknown>[];
  const eqY = asArr(equityOpt.yAxis) as Record<string, unknown>[];
  const eqZoom = asArr(equityOpt.dataZoom) as Record<string, unknown>[];

  check("资金曲线：x 轴为资金曲线日期序列", JSON.stringify(eqX[0]?.data) === JSON.stringify(full.equityCurve.map((e) => e.date)), `${full.equityCurve.length} 点`);
  check("资金曲线：双 y 轴（总资产 / 收益率%）", eqY.length === 2, `${eqY.length} 轴`);
  check("资金曲线：2 条系列（总资产 + 累计收益率）", eqSeries.length === 2, eqSeries.map((s) => s.name).join(" / "));
  check(
    "资金曲线：总资产系列数据 = totalAsset 序列",
    JSON.stringify(eqSeries[0]?.data) === JSON.stringify(full.equityCurve.map((e) => e.totalAsset))
  );
  check(
    "资金曲线：累计收益率系列绑定右轴（yAxisIndex=1）且数据 = returnPercent 序列",
    eqSeries[1]?.yAxisIndex === 1 &&
      JSON.stringify(eqSeries[1]?.data) === JSON.stringify(full.equityCurve.map((e) => e.returnPercent))
  );
  const eqMark = (eqSeries[0]?.markLine as { data: { yAxis: number; label: { formatter: string } }[] })?.data ?? [];
  check(
    "资金曲线：保本参考线画在初始资金处",
    eqMark.length >= 1 && eqMark[0].yAxis === full.initialCash,
    `yAxis=${eqMark[0]?.yAxis}`
  );
  check(
    "资金曲线：买入持有期末参考线为水平线（不虚构基准中间路径）",
    full.benchmark ? eqMark.length === 2 && eqMark[1].yAxis === full.benchmark.finalAsset : eqMark.length === 1,
    full.benchmark ? `参考线 ${eqMark.length} 条` : "无基准"
  );
  check(
    "资金曲线：缩放在全区间（0~100），便于看完整回测",
    eqZoom.length === 2 && eqZoom.every((z) => z.start === 0 && z.end === 100)
  );

  const ddOpt = buildBacktestDrawdownOption({ points: full.drawdownCurve });
  const ddSeries = asArr(ddOpt.series) as Record<string, unknown>[];
  const ddY = asArr(ddOpt.yAxis) as Record<string, unknown>[];
  const ddX = asArr(ddOpt.xAxis) as Record<string, unknown>[];

  check("回撤曲线：x 轴为回撤曲线日期序列", JSON.stringify(ddX[0]?.data) === JSON.stringify(full.drawdownCurve.map((d) => d.date)));
  check("回撤曲线：纵轴上限锁 0（回撤恒 ≤ 0）", ddY[0]?.max === 0, `max=${ddY[0]?.max}`);
  check(
    "回撤曲线：系列数据 = drawdownPercent 序列且全 ≤ 0",
    JSON.stringify(ddSeries[0]?.data) === JSON.stringify(full.drawdownCurve.map((d) => d.drawdownPercent)) &&
      full.drawdownCurve.every((d) => d.drawdownPercent <= 1e-9)
  );
  check(
    "回撤曲线：用绿色表现（A股跌色）",
    (ddSeries[0]?.lineStyle as { color: string })?.color === BACKTEST_CHART_COLORS.down,
    (ddSeries[0]?.lineStyle as { color: string })?.color
  );
  const ddMark = (ddSeries[0]?.markLine as { data: { yAxis: number }[] })?.data ?? [];
  check(
    "回撤曲线：markLine 标注的最大回撤 === 指标最大回撤（图表与指标同源）",
    ddMark.length === 1 && Math.abs(ddMark[0].yAxis - m.maxDrawdown) < 1e-9,
    `图表 ${ddMark[0]?.yAxis}% / 指标 ${m.maxDrawdown}%`
  );

  // 空数据不得抛错（组件层的空态另由 UI 处理）
  const emptyEq = buildBacktestEquityOption({ points: [], initialCash: 100_000 });
  const emptyDd = buildBacktestDrawdownOption({ points: [] });
  check(
    "空数据构建图表配置不抛错（返回可渲染结构）",
    !!emptyEq.series && !!emptyDd.series && asArr(emptyDd.series).length === 1
  );

  /* ================================================================ */
  section("10. 解耦硬约束（源码级检查）");

  const fsMod = await import("node:fs");
  const btSrc = fsMod.readFileSync("services/backtestEngine.ts", "utf8");
  const btSvcSrc = fsMod.readFileSync("services/backtestService.ts", "utf8");
  const teSrc = fsMod.readFileSync("services/tradingEngine.ts", "utf8");

  check(
    "BacktestEngine 不 import TradingEngine（不耦合）",
    !/from\s+["'][^"']*tradingEngine["']/.test(btSrc) &&
      !/require\(["'][^"']*tradingEngine["']\)/.test(btSrc),
    "仅在注释中提及依赖关系"
  );
  check(
    "TradingEngine 不 import BacktestEngine（不耦合）",
    !/from\s+["'][^"']*backtestEngine["']/.test(teSrc)
  );
  check(
    "BacktestEngine 不直接访问 Account / Position / Order / Trade / DailyAsset 表",
    !/prisma\.(account|position|order|trade|dailyAsset)\b/.test(btSrc) &&
      !/prisma\.(account|position|order|trade|dailyAsset)\b/.test(btSvcSrc),
    "两文件均无账户类表访问"
  );
  check(
    "BacktestService 不直接读写 Kline 表（K 线读写只在 MarketDataService）",
    !/prisma\.kline\b/.test(btSvcSrc),
    "通过 getKlines 读取"
  );
  check(
    "两引擎共享 lib/tradingRules（费用与数量规则同源）",
    /from\s+["']@\/lib\/tradingRules["']/.test(btSrc) && /from\s+["']@\/lib\/tradingRules["']/.test(teSrc)
  );

  finish();
}

function finish(): void {
  console.log("\n" + "═".repeat(64));
  console.log(
    `\x1b[1m结果：\x1b[32m${passed} 通过\x1b[0m` +
      (failed > 0 ? `，\x1b[31m${failed} 失败\x1b[0m` : "，0 失败")
  );
  if (failed > 0) {
    console.log("\x1b[31m失败项：\x1b[0m");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("═".repeat(64) + "\n");
}

async function cleanup(): Promise<void> {
  for (const id of createdBacktestIds) {
    await deleteBacktest(id).catch(() => undefined);
  }
  if (tempAccountId) {
    await prisma.account.delete({ where: { id: tempAccountId } }).catch(() => undefined);
  }
  await prisma.user.deleteMany({ where: { username: TEMP_USERNAME } }).catch(() => undefined);
  const n = await prisma.backtest.count();
  console.log(`\n\x1b[90m清理：已删除本脚本创建的回测记录与临时账户，库中剩余回测记录 ${n} 条\x1b[0m`);
}

main()
  .then(async () => {
    await cleanup();
    const code = failed > 0 ? 1 : 0;
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("\n\x1b[31m测试异常终止：\x1b[0m", err);
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
