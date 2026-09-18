/**
 * tradingRules —— A股交易规则**纯函数**层（无 DB / 无框架依赖）
 *
 * 存在理由（架构约束）：
 *   `tradingEngine`（实盘撮合 + 账户落库）与 `backtestEngine`（历史回测，纯内存）
 *   必须使用**同一套**交易规则，否则回测结论无法代表实盘行为。
 *   但两者若互相 import 就会形成耦合（回测器依赖 Prisma 账户模型 / 引擎被迫感知回测），
 *   因此把「与状态无关的规则计算」下沉到本模块：
 *
 *       lib/tradingRules.ts        ← 共享底层（本文件，纯函数）
 *            ↑            ↑
 *     tradingEngine   backtestEngine     ← 互不 import
 *
 *   本模块**只做数学与规则判定**，不读写数据库、不持有账户状态、不抛业务异常。
 *
 * 规则口径（与 tradingEngine 历史实现完全一致，迁移时逐行对齐）：
 *  - 佣金：万三（`COMMISSION_RATE`），**最低 5 元**，双向
 *  - 印花税：千一（`STAMP_TAX_RATE`），**仅卖出**
 *  - 过户费：万 0.1（`TRANSFER_FEE_RATE`），双向
 *  - 买入成本价 = (成交额 + 全部费用) / 数量
 *  - 卖出实现盈亏 = (卖价 − 成本均价) × 数量 − 卖出费用
 *  - 买入按一手（100 股）整数倍；卖出允许零股
 */

import {
  COMMISSION_MIN,
  COMMISSION_RATE,
  LOT_SIZE,
  STAMP_TAX_RATE,
  TRANSFER_FEE_RATE,
} from "@/lib/constants";
import type { OrderSide } from "@/types";

/* ------------------------------------------------------------------ */
/*                         数值 / 舍入工具                             */
/* ------------------------------------------------------------------ */

/** Prisma Decimal / BigInt / string -> number（对外出参一律 number） */
export function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return parseFloat(v) || 0;
  const anyV = v as { toNumber?: () => number; toString?: () => string };
  if (typeof anyV.toNumber === "function") return anyV.toNumber();
  if (typeof anyV.toString === "function") return parseFloat(anyV.toString()) || 0;
  return 0;
}

/** 四舍五入到指定小数位 */
export function roundTo(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 金额：2 位小数 */
export function round2(v: number): number {
  return roundTo(v, 2);
}

/** 展示精度：4 位小数 */
export function round4(v: number): number {
  return roundTo(v, 4);
}

/**
 * 成本均价：6 位小数（**不可降为 2 位**）。
 *
 * 卖出已实现盈亏 =（卖价 − 成本均价）× 数量 − 卖出费用。
 * 若成本均价只留 2 位，误差 ≤ 0.005 元/股，乘上持仓数量后被放大
 * （1000 股即最多偏差 5 元），导致「累计盈亏 ≠ 已实现盈亏」、资产恒等式被破坏。
 */
export function round6(v: number): number {
  return roundTo(v, 6);
}

/* ------------------------------------------------------------------ */
/*                             费用                                    */
/* ------------------------------------------------------------------ */

/** 交易费用明细 */
export interface TradeFees {
  /** 佣金（万三，最低 5 元，双向） */
  commission: number;
  /** 印花税（千一，仅卖出） */
  stampTax: number;
  /** 过户费（万 0.1，双向） */
  transferFee: number;
  /** 合计 */
  total: number;
}

/**
 * 计算交易费用（纯函数）。
 * @param amount 成交额 = price × quantity
 * @param side   买卖方向（印花税仅卖出收取）
 */
export function calcFees(amount: number, side: OrderSide): TradeFees {
  const commission = Math.max(round2(amount * COMMISSION_RATE), COMMISSION_MIN);
  const stampTax = side === "SELL" ? round2(amount * STAMP_TAX_RATE) : 0;
  const transferFee = round2(amount * TRANSFER_FEE_RATE);
  return {
    commission,
    stampTax,
    transferFee,
    total: round2(commission + stampTax + transferFee),
  };
}

/* ------------------------------------------------------------------ */
/*                           数量规则                                  */
/* ------------------------------------------------------------------ */

/**
 * 校验委托数量是否符合 A股规则（只校验数量本身，不涉及资金与持仓）。
 *
 * - 买入必须为 100 股（一手）整数倍；
 * - 卖出允许不足一手的零股（清仓场景），但仍须为正整数。
 *
 * @returns 合法返回 null，非法返回原因
 */
export function validateQuantity(quantity: number, side: OrderSide): string | null {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return "委托数量必须为正整数";
  }
  if (side === "BUY" && quantity % LOT_SIZE !== 0) {
    return `买入数量必须为 ${LOT_SIZE} 股（一手）的整数倍`;
  }
  return null;
}

/** 向下取整到整手（100 股） */
export function floorToLot(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.floor(quantity / LOT_SIZE) * LOT_SIZE;
}

/* ------------------------------------------------------------------ */
/*                        买卖现金流 / 成本                            */
/* ------------------------------------------------------------------ */

/**
 * 买入实际支出（现金流出）= 成交额 + 全部费用。
 * tradingEngine 用该值做「资金是否足够」判定，并以它累加持仓成本。
 */
export function calcBuyOutlay(amount: number, fees: TradeFees): number {
  return round2(amount + fees.total);
}

/** 卖出净到账（现金流入）= 成交额 − 全部费用（含印花税） */
export function calcSellNetIncome(amount: number, fees: TradeFees): number {
  return round2(amount - fees.total);
}

/**
 * 卖出已实现盈亏 =（卖价 − 成本均价）× 数量 − 卖出费用。
 * 全仓清仓时该值恰好等于「总资产 − 买入时投入的总成本」。
 */
export function calcRealizedPnl(
  fillPrice: number,
  avgCost: number,
  quantity: number,
  feesTotal: number,
): number {
  return round2((fillPrice - avgCost) * quantity - feesTotal);
}

/**
 * 加仓后的成本均价 =（原成本总额 + 本次实际支出）/ 新数量，保留 6 位小数。
 * @param prevCostTotal 原成本总额（用精确成本均价 × 原数量，不提前取整）
 * @param addedOutlay   本次实际支出（含费）
 * @param newQuantity   加仓后的总数量
 */
export function calcAvgCostAfterBuy(
  prevCostTotal: number,
  addedOutlay: number,
  newQuantity: number,
): number {
  if (newQuantity <= 0) return 0;
  return round6((prevCostTotal + addedOutlay) / newQuantity);
}

/**
 * 在给定现金与价格下，可买入的最大**整手**数量（已考虑手续费）。
 *
 * 做法：先按「现金 / 单价」粗算手数，再逐手回退直到
 * `成交额 + 费用 ≤ 现金`。因为费用随成交额单调递增，
 * 粗算值最多只会高出 1~2 手，回退循环次数极少（不会退化成线性扫描）。
 *
 * 说明：现实中「佣金最低 5 元」意味着极小额的买入可能永远买不起，
 * 此处会如实返回 0，而不是放宽规则去凑一笔成交。
 */
export function maxAffordableLots(availableCash: number, price: number): number {
  if (!Number.isFinite(availableCash) || !Number.isFinite(price)) return 0;
  if (availableCash <= 0 || price <= 0) return 0;

  let qty = floorToLot(Math.floor(availableCash / price));
  while (qty > 0) {
    const amount = round2(price * qty);
    const outlay = calcBuyOutlay(amount, calcFees(amount, "BUY"));
    if (outlay <= availableCash + 1e-9) return qty;
    qty -= LOT_SIZE;
  }
  return 0;
}
