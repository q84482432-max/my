/**
 * tradingEngine —— 交易核心引擎
 *
 * 职责边界（重要）：
 *  - 本文件承载**全部**交易业务规则：费用计算、T+1 约束、资金校验、
 *    持仓维护、盈亏计算、资产快照。
 *  - React 页面 / API Route 只能调用本文件暴露的函数，
 *    **不允许**在页面里直接写买卖逻辑或直接改 Account/Position 表。
 *  - 本文件不依赖任何 React / Next.js API，可被脚本、回测器复用。
 *
 * 对外入口：
 *  - `placeOrder(input)`   统一下单入口（含买卖共用前置流程）
 *  - `buyStock(input)`     买入语义化入口，等价 placeOrder({side:"BUY"})
 *  - `sellStock(input)`    卖出语义化入口，等价 placeOrder({side:"SELL"})
 *  内部由 executeBuy / executeSell 分别执行两条流程。
 *
 * 交易规则（A股）：
 *  - 买入按 100 股整数倍（一手）委托；卖出允许零股（清仓）
 *  - 卖出可卖数量受 T+1 限制（当日买入次日才可卖，由 settleT1 结算）
 *  - 佣金：万三，最低 5 元，双向
 *  - 印花税：千一，仅卖出
 *  - 过户费：万0.1，双向
 *  - 买入用「成本价」= (成交额 + 全部费用) / 数量
 *  - 卖出实现盈亏 = (卖价 − 成本均价) × 数量 − 卖出费用
 *
 * 账户字段（派生值，不落库）：
 *  - cash = availableCash + frozenCash
 *  - totalAsset = cash + marketValue（marketValue 按各持仓最新收盘价计）
 *  - totalProfit = totalAsset − initialCash
 *  - totalProfitRate = totalProfit / initialCash × 100
 */

import prisma from "@/lib/prisma";
import { DEFAULT_INITIAL_CASH } from "@/lib/constants";
import { toDateStr } from "@/lib/utils";
import type {
  AccountInfo,
  DailyAssetInfo,
  OrderInfo,
  OrderSide,
  OrderType,
  PerformanceMetrics,
  PlaceOrderInput,
  PlaceOrderResult,
  PositionInfo,
  TradeInfo,
} from "@/types";
import {
  getKlineAt,
  getLatestBar,
  getNextTradeDate,
  getQuotesAsOf,
  getStockQuotes,
} from "@/services/marketDataService";

/* ------------------------------------------------------------------ */
/*        共享底层规则（lib/tradingRules.ts · lib/performanceMetrics.ts） */
/*                                                                    */
/*  费用 / 数量 / 成本 / 已实现盈亏 / 绩效指标 一律从 lib/ 下的**纯函数**   */
/*  模块导入，本文件不重复实现 —— `backtestEngine` 从同一处导入，          */
/*  两个引擎因此共享完整口径，却**互不 import**（不产生耦合）。             */
/*  见 lib/tradingRules.ts 头部说明。                                    */
/*                                                                    */
/*  下列函数在本模块**原样 re-export**，以保证既有调用方                  */
/*  （scripts/test*.ts）的 `from "@/services/tradingEngine"` 路径不变。   */
/* ------------------------------------------------------------------ */
import {
  calcAvgCostAfterBuy,
  calcBuyOutlay,
  calcFees,
  calcRealizedPnl,
  calcSellNetIncome,
  round2,
  round4,
  round6,
  toNum as num,
  type TradeFees,
  validateQuantity,
} from "@/lib/tradingRules";
import { calcMaxDrawdown, calcPerformance } from "@/lib/performanceMetrics";

export { calcBuyOutlay, calcFees, validateQuantity };
export { calcMaxDrawdown, calcPerformance };
export type { TradeFees } from "@/lib/tradingRules";

/** 归一化日期到 UTC 零点 */
function normalizeDate(d: Date | string): Date {
  const date = typeof d === "string" ? new Date(`${d.slice(0, 10)}T00:00:00.000Z`) : d;
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * 引擎在事务内判定「拒绝成交」时抛出的哨兵错误，由 placeOrder 转换为失败结果。
 *
 * 用途：把资金 / 持仓 / 可卖数量的校验移入数据库事务内部，避免并发下单竞态
 * （见 executeBuy / executeSell）。事务回滚后由 placeOrder 捕获并转成
 * `PlaceOrderResult({ success: false })` —— 既保证原子性，又维持既有返回契约。
 */
class OrderRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderRejectError";
  }
}

/* ------------------------------------------------------------------ */
/*                            账户                                    */
/* ------------------------------------------------------------------ */

/**
 * 创建账户（同用户下可多账户）。
 *
 * @param simulationId 归属的历史模拟会话；缺省（undefined/null）= 普通模拟账户。
 *   两类账户共用 accounts 表，靠该字段区分（见 ensureDefaultAccount 的过滤说明）。
 * @param simTradeSessionId 归属的模拟炒股（猜股票）会话；缺省 = 非该玩法账户。
 *   与 simulationId 同为「归属标记」，二者互斥，且都非空时账户必不属于普通账户。
 */
export async function createAccount(input: {
  username: string;
  nickname?: string;
  accountName?: string;
  initialCash: number;
  simulationId?: string;
  simTradeSessionId?: string;
}): Promise<string> {
  const user = await prisma.user.upsert({
    where: { username: input.username },
    update: input.nickname ? { nickname: input.nickname } : {},
    create: { username: input.username, nickname: input.nickname ?? null },
    select: { id: true },
  });

  const account = await prisma.account.create({
    data: {
      userId: user.id,
      name: input.accountName ?? "默认模拟账户",
      initialCash: input.initialCash,
      availableCash: input.initialCash,
      frozenCash: 0,
      simulationId: input.simulationId ?? null,
      simTradeSessionId: input.simTradeSessionId ?? null,
    },
    select: { id: true },
  });
  return account.id;
}

/**
 * 确保存在一个**普通模拟账户**，不存在则创建（首次进入页面时调用）。
 *
 * ⚠️ 解耦的硬性保证点：必须排除历史模拟会话账户（`simulationId != null`）
 * 与模拟炒股（猜股票）会话账户（`simTradeSessionId != null`）。
 * 三类账户共用 accounts 表，若不过滤，则「用户先创建过历史模拟/模拟炒股」时
 * ensureDefaultAccount 会解析到这些专用账户，导致普通页面与会话读写同一份
 * 现金/持仓而互相污染。
 */
export async function ensureDefaultAccount(): Promise<string> {
  const existing = await prisma.account.findFirst({
    where: { simulationId: null, simTradeSessionId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  return createAccount({
    username: "demo",
    nickname: "模拟投资者",
    accountName: "默认模拟账户",
    initialCash: DEFAULT_INITIAL_CASH,
  });
}

/**
 * 账户汇总：现金 + 持仓市值 + 累计盈亏。持仓市值按每只股票最新日K 收盘价计算。
 *
 * @param asOfDate 行情可见上界（YYYY-MM-DD）。提供时按「截至该日的最后一根日K」
 *   计算市值 —— 历史模拟模式**必须**传入，否则会读到未来行情。缺省 = 最新交易日
 *   （普通模拟账户行为，保持不变）。
 *
 * 返回字段满足以下恒等关系：
 *   cash = availableCash + frozenCash
 *   totalAsset = cash + marketValue
 *   totalProfit = totalAsset - initialCash
 *   totalProfitRate = totalProfit / initialCash * 100
 */
export async function getAccountSummary(
  accountId: string,
  asOfDate?: string,
): Promise<AccountInfo | null> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      name: true,
      initialCash: true,
      availableCash: true,
      frozenCash: true,
      positions: {
        select: { stock: { select: { code: true } }, quantity: true },
      },
    },
  });
  if (!account) return null;

  const held = account.positions.filter((p) => p.quantity > 0);
  let marketValue = 0;
  if (asOfDate) {
    // 历史模拟：严格按 asOfDate（含）之前的行情估值
    const quotes = await getQuotesAsOf(
      held.map((p) => p.stock.code),
      asOfDate,
    );
    for (const pos of held) {
      const q = quotes[pos.stock.code];
      if (q) marketValue += q.close * pos.quantity;
    }
  } else {
    for (const pos of held) {
      const bar = await getLatestBar(pos.stock.code);
      if (bar) marketValue += bar.close * pos.quantity;
    }
  }

  const availableCash = round2(num(account.availableCash));
  const frozenCash = round2(num(account.frozenCash));
  const initialCash = round2(num(account.initialCash));
  const cash = round2(availableCash + frozenCash);
  // 总资产 = 现金 + 持仓市值
  const totalAsset = round2(cash + marketValue);
  const totalProfit = round2(totalAsset - initialCash);
  const totalProfitRate = initialCash > 0 ? round2((totalProfit / initialCash) * 100) : 0;

  return {
    id: account.id,
    name: account.name,
    initialCash,
    cash,
    availableCash,
    frozenCash,
    marketValue: round2(marketValue),
    totalAsset,
    totalProfit,
    totalProfitRate,
  };
}

/* ------------------------------------------------------------------ */
/*                            持仓                                    */
/* ------------------------------------------------------------------ */

/**
 * 持仓列表（含实时市值、浮动盈亏、今日盈亏）。
 *
 * @param asOfDate 行情可见上界（YYYY-MM-DD）。提供时取「截至该日的最后一根日K」
 *   作为现价、其前一根作为昨收 —— 历史模拟模式**必须**传入（防未来数据泄露）。
 *   缺省 = 各股自身最新交易日（普通账户行为，保持不变）。
 *
 * 今日盈亏：昨日及以前持有的部分以昨收为基准；当日买入的部分以当日买入
 *   成本价（含费）为基准 —— 详见 types/index.ts 的 PositionInfo.todayPnl 注释。
 */
export async function getPositions(
  accountId: string,
  asOfDate?: string,
): Promise<PositionInfo[]> {
  const rows = await prisma.position.findMany({
    where: { accountId, quantity: { gt: 0 } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      stockId: true,
      quantity: true,
      availableQty: true,
      avgCost: true,
      stock: { select: { code: true, name: true } },
    },
  });
  if (rows.length === 0) return [];

  const codes = rows.map((r) => r.stock.code);

  // 取价 + 「当日」判定：
  //  - asOfDate 提供：现价/昨收均取截至该日的行情，「当日」即 asOfDate
  //  - 缺省：取各股最新两根日K，「当日」= 该股自身最新交易日
  const priceMap = new Map<string, { close: number; prevClose: number }>();
  const todayMap = new Map<string, string | null>();
  if (asOfDate) {
    const quotes = await getQuotesAsOf(codes, asOfDate);
    for (const c of codes) {
      const q = quotes[c];
      priceMap.set(c, { close: q?.close ?? 0, prevClose: q?.prevClose ?? 0 });
      todayMap.set(c, asOfDate);
    }
  } else {
    const quotes = await getStockQuotes(codes);
    for (const c of codes) {
      const q = quotes[c];
      priceMap.set(c, { close: q?.lastPrice ?? 0, prevClose: q?.prevClose ?? 0 });
      todayMap.set(c, q?.lastDate ?? null);
    }
  }

  // 「当日买入」成交 —— 今日盈亏中「当日买入部分」的数据源。
  // 以 (stockId, 成交日) 双键匹配，避免把非当日的成交误算成当日买入。
  const todayDates = Array.from(
    new Set(
      Array.from(todayMap.values()).filter(
        (d): d is string => typeof d === "string" && d.length > 0,
      ),
    ),
  );
  const todayBuyMap = new Map<string, { qty: number; cost: number }>();
  if (todayDates.length > 0) {
    const todayBuys = await prisma.trade.findMany({
      where: {
        accountId,
        side: "BUY",
        stockId: { in: rows.map((r) => r.stockId) },
        tradedAt: { in: todayDates.map(normalizeDate) },
      },
      select: {
        stockId: true,
        tradedAt: true,
        quantity: true,
        amount: true,
        commission: true,
        stampTax: true,
        transferFee: true,
      },
    });
    for (const t of todayBuys) {
      const key = `${t.stockId}|${toDateStr(t.tradedAt)}`;
      const cur = todayBuyMap.get(key) ?? { qty: 0, cost: 0 };
      cur.qty += t.quantity;
      // 买入成本含全部费用（买入无印花税，仍统一累加以防口径漂移）
      cur.cost +=
        num(t.amount) + num(t.commission) + num(t.stampTax) + num(t.transferFee);
      todayBuyMap.set(key, cur);
    }
  }

  const result: PositionInfo[] = [];
  for (const r of rows) {
    const px = priceMap.get(r.stock.code) ?? { close: 0, prevClose: 0 };
    const lastPrice = px.close;
    // 无昨收（次新股/停牌）时退化为 lastPrice，今日盈亏自然为 0，不编造数据
    const prevClose = px.prevClose > 0 ? px.prevClose : lastPrice;

    // 内部用 6 位小数的精确成本均额计算，对外 DTO 收敛到 4 位（展示取 3 位）
    const avgCostExact = num(r.avgCost);
    const avgCost = round4(avgCostExact);
    const marketValue = round2(lastPrice * r.quantity);
    const costAmount = round2(avgCostExact * r.quantity);
    const unrealizedPnl = round2(marketValue - costAmount);

    // 今日盈亏：当日买入量与买入均价
    const today = todayMap.get(r.stock.code) ?? null;
    const bought = today ? todayBuyMap.get(`${r.stockId}|${today}`) : undefined;
    const todayQty = Math.min(bought?.qty ?? 0, r.quantity);
    const heldBeforeQty = r.quantity - todayQty;
    const todayBuyAvgCost =
      bought && bought.qty > 0 ? bought.cost / bought.qty : lastPrice;
    const todayPnl = round2(
      (lastPrice - prevClose) * heldBeforeQty +
        (lastPrice - todayBuyAvgCost) * todayQty,
    );

    result.push({
      id: r.id,
      stockId: r.stockId,
      stockCode: r.stock.code,
      stockName: r.stock.name,
      quantity: r.quantity,
      availableQty: r.availableQty,
      avgCost,
      lastPrice,
      prevClose,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPercent:
        costAmount > 0 ? round2((unrealizedPnl / costAmount) * 100) : 0,
      todayPnl,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*                          委托 / 成交                                */
/* ------------------------------------------------------------------ */

/** 委托列表 */
export async function getOrders(
  accountId: string,
  options: { limit?: number; status?: string } = {},
): Promise<OrderInfo[]> {
  const rows = await prisma.order.findMany({
    where: {
      accountId,
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: { orderTime: "desc" },
    take: options.limit ?? 100,
    select: {
      id: true,
      side: true,
      orderType: true,
      price: true,
      quantity: true,
      filledQty: true,
      filledPrice: true,
      status: true,
      orderTime: true,
      remark: true,
      stock: { select: { code: true, name: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    stockCode: r.stock.code,
    stockName: r.stock.name,
    side: r.side as OrderSide,
    orderType: r.orderType as OrderType,
    price: r.price === null ? null : num(r.price),
    quantity: r.quantity,
    filledQty: r.filledQty,
    filledPrice: r.filledPrice === null ? null : num(r.filledPrice),
    status: r.status as OrderInfo["status"],
    orderTime: toDateStr(r.orderTime),
    remark: r.remark,
  }));
}

/** 成交记录 */
export async function getTrades(
  accountId: string,
  options: { limit?: number; stockCode?: string } = {},
): Promise<TradeInfo[]> {
  const rows = await prisma.trade.findMany({
    where: {
      accountId,
      ...(options.stockCode ? { stock: { code: options.stockCode } } : {}),
    },
    orderBy: { tradedAt: "desc" },
    take: options.limit ?? 100,
    select: {
      id: true,
      side: true,
      price: true,
      quantity: true,
      amount: true,
      commission: true,
      stampTax: true,
      transferFee: true,
      realizedPnl: true,
      tradedAt: true,
      stock: { select: { code: true, name: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    stockCode: r.stock.code,
    stockName: r.stock.name,
    side: r.side as OrderSide,
    price: num(r.price),
    quantity: r.quantity,
    amount: num(r.amount),
    commission: num(r.commission),
    stampTax: num(r.stampTax),
    transferFee: num(r.transferFee),
    // 手续费合计由引擎给出（费用规则只在本文件定义，展示层不再自行求和）
    totalFee: round2(
      num(r.commission) + num(r.stampTax) + num(r.transferFee),
    ),
    realizedPnl: num(r.realizedPnl),
    tradedAt: toDateStr(r.tradedAt),
  }));
}

/* ------------------------------------------------------------------ */
/*                        下单主流程                                   */
/* ------------------------------------------------------------------ */

/** 下单公共上下文（前置校验与定价的结果） */
interface OrderContext {
  accountId: string;
  stockId: string;
  stockCode: string;
  stockName: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  /** 成交价 */
  fillPrice: number;
  /** 成交日（UTC 零点） */
  fillDate: Date;
  /** 成交金额 = fillPrice × quantity */
  amount: number;
  /** 费用明细（含佣金 / 印花税 / 过户费） */
  fees: TradeFees;
  /** 账户可用现金（买入校验用） */
  availableCash: number;
}

/**
 * 构造成交后的委托 DTO。
 *
 * 直接由已知值构造，而不是回查数据库取「最近一笔委托」——
 * 后者在并发下单时可能取到别的委托（竞态），是不可靠写法。
 */
function buildOrderInfo(ctx: OrderContext, orderId: string): OrderInfo {
  return {
    id: orderId,
    stockCode: ctx.stockCode,
    stockName: ctx.stockName,
    side: ctx.side,
    orderType: ctx.orderType,
    price: ctx.orderType === "LIMIT" ? ctx.fillPrice : null,
    quantity: ctx.quantity,
    filledQty: ctx.quantity,
    filledPrice: ctx.fillPrice,
    status: "FILLED",
    orderTime: toDateStr(ctx.fillDate),
    remark: null,
  };
}

/**
 * 构造成交后的成交记录 DTO。
 *
 * PlaceOrderResult 声明了可选的 trade 字段（前端据此判断成交并复位表单），
 * 但原实现只返回 order + message，trade 恒为 undefined —— 属 DTO 契约未兑现。
 * 这里同样由已知值直接构造，避免回查数据库。
 */
function buildTradeInfo(
  ctx: OrderContext,
  tradeId: string,
  realizedPnl: number,
): TradeInfo {
  return {
    id: tradeId,
    stockCode: ctx.stockCode,
    stockName: ctx.stockName,
    side: ctx.side,
    price: ctx.fillPrice,
    quantity: ctx.quantity,
    amount: ctx.amount,
    commission: ctx.fees.commission,
    stampTax: ctx.fees.stampTax,
    transferFee: ctx.fees.transferFee,
    totalFee: ctx.fees.total,
    realizedPnl,
    tradedAt: toDateStr(ctx.fillDate),
  };
}

/**
 * 下单统一入口（即时全额成交的简化撮合）。
 *
 * ⚠️ 所有交易**必须**经由此函数（或其语义化包装 buyStock / sellStock）。
 *    React 组件与 API Route 不得直接读写 Account / Position 表。
 *
 * 成交价确定规则：
 *  - 限价单：以委托价成交
 *  - 市价单：以 tradeDate 当日（缺省为最新交易日）日K 收盘价成交
 *  - tradeDate 支持回溯历史日期，为历史模拟交易预留
 *
 * 历史模拟模式（`asOfDate`）：把「行情可见上界」下沉到引擎层强制校验 ——
 *  缺省成交日取 asOfDate、禁止成交日晚于 asOfDate、且该股在 asOfDate 必须
 *  真实有行情（停牌回落到更早K线时直接拒绝，避免成交日被写成更早日期）。
 *
 * 本函数只做**买卖共用的前置步骤**，随后分派给 executeBuy / executeSell：
 *   1. 参数合法性（数量必须为正整数；买入须为 100 股整数倍；限价单须有价）
 *   2. 账户是否存在
 *   3. 股票是否存在
 *   4. 确定成交价与成交日
 *   5. 计算交易金额与手续费
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const {
    accountId,
    stockCode,
    side,
    orderType = "MARKET",
    price,
    quantity,
    tradeDate,
    asOfDate,
  } = input;

  // 1) 参数校验（数量规则 + 限价单价格）
  const qtyError = validateQuantity(quantity, side);
  if (qtyError) return { success: false, message: qtyError };
  if (orderType === "LIMIT" && (!price || price <= 0)) {
    return { success: false, message: "限价单必须指定有效的委托价格" };
  }

  // 1.5) 历史模拟：成交日不得晚于行情可见上界（引擎层硬约束，防未来数据泄露）
  if (asOfDate && tradeDate && normalizeDate(tradeDate) > normalizeDate(asOfDate)) {
    return {
      success: false,
      message: `成交日不能晚于当前模拟交易日 ${asOfDate}`,
    };
  }
  /** 实际使用的成交日：显式 tradeDate 优先，其次 asOfDate，缺省沿用最新交易日 */
  const effectiveDate = tradeDate ?? asOfDate;

  // 2) 账户校验
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, availableCash: true },
  });
  if (!account) return { success: false, message: "账户不存在" };

  // 3) 股票校验
  const stock = await prisma.stock.findUnique({
    where: { code: stockCode },
    select: { id: true, code: true, name: true },
  });
  if (!stock) return { success: false, message: `股票 ${stockCode} 不存在` };

  // 4) 确定成交价与成交日（getKlineAt 为「<= 日期」语义，天然不会读到未来）
  let fillPrice: number;
  let barDate: string;
  if (orderType === "LIMIT" && price) {
    const bar = effectiveDate
      ? await getKlineAt(stockCode, effectiveDate)
      : await getKlineAt(stockCode, toDateStr(new Date()));
    if (!bar) return { success: false, message: "该日期无行情数据，无法成交" };
    fillPrice = price;
    barDate = bar.date;
  } else {
    const bar = effectiveDate
      ? await getKlineAt(stockCode, effectiveDate)
      : await getLatestBar(stockCode);
    if (!bar) return { success: false, message: "无行情数据，无法成交" };
    fillPrice = bar.close;
    barDate = bar.date;
  }
  if (fillPrice <= 0) return { success: false, message: "成交价异常" };

  // 历史模拟：成交日必须**严格等于** asOfDate（该股当日有真实行情）。
  // 若该股当日停牌，getKlineAt 会回落到更早的一根K线 —— 那等于用旧价成交
  // 并把成交日写成更早日期，故直接拒绝。
  if (asOfDate && barDate !== asOfDate) {
    return {
      success: false,
      message: `该股票在 ${asOfDate} 无行情（停牌或尚未上市），无法成交`,
    };
  }
  const fillDate = normalizeDate(barDate);

  // 5) 计算交易金额与手续费
  const amount = round2(fillPrice * quantity);
  const fees = calcFees(amount, side);

  const ctx: OrderContext = {
    accountId,
    stockId: stock.id,
    stockCode: stock.code,
    stockName: stock.name,
    side,
    orderType,
    quantity,
    fillPrice,
    fillDate,
    amount,
    fees,
    availableCash: num(account.availableCash),
  };

  try {
    return side === "BUY" ? await executeBuy(ctx) : await executeSell(ctx);
  } catch (e) {
    if (e instanceof OrderRejectError) {
      return { success: false, message: e.message };
    }
    throw e;
  }
}

/**
 * 买入执行流程。
 *
 * 步骤（与需求一一对应）：
 *  1. 检查股票是否存在  —— 已由 placeOrder 前置完成
 *  2. 检查交易数量      —— validateQuantity（正整数）
 *  3. 检查是否 100 股整数倍 —— validateQuantity
 *  4. 计算交易金额      —— ctx.amount
 *  5. 计算手续费        —— calcFees
 *  6. 检查现金是否足够  ← 本函数
 *  7. 生成订单          ← 事务内
 *  8. 生成成交记录      ← 事务内
 *  9. 更新账户（扣现金）← 事务内
 * 10. 更新持仓          ← 事务内
 * 11. 重新计算资产      ← refreshDailyAsset
 */
async function executeBuy(ctx: OrderContext): Promise<PlaceOrderResult> {
  // 6) 计算所需现金（买入需支付成交金额 + 全部费用）
  const needCash = calcBuyOutlay(ctx.amount, ctx.fees);

  // 7~10) 事务：原子校验余额 + 扣现金 → 更新持仓 → 生成订单 → 生成成交记录
  //
  // ⚠️ 资金校验**必须**在事务内读取 account.availableCash：若放在事务外（原实现），
  // 并发买入会基于过期的余额快照同时通过校验，导致账户被透支（写丢失竞态）。
  const { orderId, tradeId, realizedPnl } = await prisma.$transaction(async (tx) => {
    // 9) 事务内重新读取可用现金并校验（避免并发透支）
    const account = await tx.account.findUnique({
      where: { id: ctx.accountId },
      select: { availableCash: true },
    });
    if (!account) throw new OrderRejectError("账户不存在");
    if (num(account.availableCash) < needCash - 1e-9) {
      throw new OrderRejectError(
        `可用资金不足：需 ¥${needCash.toFixed(2)}，可用 ¥${num(account.availableCash).toFixed(2)}`,
      );
    }
    // 9) 更新账户：扣减可用现金
    await tx.account.update({
      where: { id: ctx.accountId },
      data: { availableCash: { decrement: needCash } },
    });

    // 10) 更新持仓（已持有则加权平均成本，否则新建）
    const pos = await tx.position.findUnique({
      where: {
        accountId_stockId: { accountId: ctx.accountId, stockId: ctx.stockId },
      },
    });
    if (pos) {
      const oldQty = pos.quantity;
      // 原成本总额 = 精确成本均价 × 原数量（保留摊薄成本，不提前取整）
      const oldCost = num(pos.avgCost) * oldQty;
      const newQty = oldQty + ctx.quantity;
      // 成本价含买入费用：(原成本 + 本次实际支出) / 新数量，按 6 位小数保留精度
      const newAvgCost = calcAvgCostAfterBuy(oldCost, needCash, newQty);
      await tx.position.update({
        where: { id: pos.id },
        data: {
          quantity: newQty,
          // T+1：当日买入不计入可卖，仅累加总量
          availableQty: pos.availableQty,
          avgCost: newAvgCost,
          // 冗余列：以本次成交价作为最新价，浮动盈亏按 (最新价 − 成本价) × 数量 同步，
          // 保证与 lastPrice 口径自洽（原实现从不写 unrealizedPnl，该列恒为 0 误导调库者）。
          lastPrice: ctx.fillPrice,
          unrealizedPnl: round2((ctx.fillPrice - newAvgCost) * newQty),
        },
      });
    } else {
      const newAvgCost = calcAvgCostAfterBuy(0, needCash, ctx.quantity);
      await tx.position.create({
        data: {
          accountId: ctx.accountId,
          stockId: ctx.stockId,
          quantity: ctx.quantity,
          // T+1：当日买入不可卖
          availableQty: 0,
          // 成本含费，保留 6 位小数（见 round6 注释）
          avgCost: newAvgCost,
          lastPrice: ctx.fillPrice,
          unrealizedPnl: round2((ctx.fillPrice - newAvgCost) * ctx.quantity),
        },
      });
    }

    // 7) 生成订单
    const order = await tx.order.create({
      data: {
        accountId: ctx.accountId,
        stockId: ctx.stockId,
        side: ctx.side,
        orderType: ctx.orderType,
        price: ctx.orderType === "LIMIT" ? ctx.fillPrice : null,
        quantity: ctx.quantity,
        filledQty: ctx.quantity,
        filledPrice: ctx.fillPrice,
        status: "FILLED",
        orderTime: ctx.fillDate,
      },
      select: { id: true },
    });

    // 8) 生成成交记录（买入不产生已实现盈亏）
    const trade = await tx.trade.create({
      data: {
        accountId: ctx.accountId,
        stockId: ctx.stockId,
        orderId: order.id,
        side: ctx.side,
        price: ctx.fillPrice,
        quantity: ctx.quantity,
        amount: ctx.amount,
        commission: ctx.fees.commission,
        stampTax: ctx.fees.stampTax,
        transferFee: ctx.fees.transferFee,
        realizedPnl: 0,
        tradedAt: ctx.fillDate,
      },
      select: { id: true },
    });

    return { orderId: order.id, tradeId: trade.id, realizedPnl: 0 };
  });

  // 11) 重新计算资产（写入当日快照）
  await refreshDailyAsset(ctx.accountId, ctx.fillDate);

  return {
    success: true,
    order: buildOrderInfo(ctx, orderId),
    trade: buildTradeInfo(ctx, tradeId, realizedPnl),
    message: `买入成功：${ctx.stockName} ${ctx.quantity} 股 @ ¥${ctx.fillPrice.toFixed(
      2,
    )}，共支出 ¥${needCash.toFixed(2)}（含费用 ¥${ctx.fees.total.toFixed(2)}）`,
  };
}

/**
 * 卖出执行流程。
 *
 * 步骤（与需求一一对应）：
 *  1. 检查持仓            ← 本函数
 *  2. 检查可卖数量（T+1） ← 本函数
 *  3. 检查数量            —— validateQuantity
 *  4. 计算成交金额        —— ctx.amount
 *  5. 计算手续费          —— calcFees
 *  6. 计算印花税          —— calcFees（仅卖出收取）
 *  7. 生成订单            ← 事务内
 *  8. 生成成交记录        ← 事务内
 *  9. 减少持仓            ← 事务内
 * 10. 增加现金            ← 事务内
 * 11. 计算已实现盈亏      ← 本函数
 * 12. 重新计算账户        ← refreshDailyAsset
 */
async function executeSell(ctx: OrderContext): Promise<PlaceOrderResult> {
  // 7~10) 事务：原子校验持仓/可卖 → 增加现金 → 减少持仓 → 生成订单/成交
  //
  // ⚠️ 持仓与可卖数量**必须**在事务内读取：若放在事务外（原实现），并发卖出会
  // 基于过期的快照同时通过校验，造成超卖（写丢失竞态，破坏持仓数量守恒与 T+1）。
  const { orderId, tradeId, realizedPnl, netIncome } = await prisma.$transaction(
    async (tx) => {
      // 1) 检查持仓（事务内读取，保证与后续写入基于同一快照）
      const pos = await tx.position.findUnique({
        where: {
          accountId_stockId: { accountId: ctx.accountId, stockId: ctx.stockId },
        },
      });
      if (!pos || pos.quantity <= 0) {
        throw new OrderRejectError(`未持有 ${ctx.stockName}，无法卖出`);
      }

      // 2) 检查可卖数量（T+1：当日买入的部分不可卖）
      if (pos.availableQty < ctx.quantity) {
        throw new OrderRejectError(
          `可卖数量不足（T+1 限制）：可卖 ${pos.availableQty} 股，本次委托 ${ctx.quantity} 股`,
        );
      }

      // 11) 计算已实现盈亏 =（卖价 − 成本均价）× 数量 − 卖出费用
      //     成本均价取 6 位小数精度，保证「实现盈亏」与真实现金流一致
      //     （全仓清仓时 该值 恰好等于 总资产 − 初始资金）
      const avgCost = num(pos.avgCost);
      const realizedPnl = calcRealizedPnl(ctx.fillPrice, avgCost, ctx.quantity, ctx.fees.total);
      // 卖出到账金额 = 成交金额 − 全部费用（含印花税）
      const netIncome = calcSellNetIncome(ctx.amount, ctx.fees);

      // 10) 增加现金（净到账）
      await tx.account.update({
        where: { id: ctx.accountId },
        data: { availableCash: { increment: netIncome } },
      });

      // 9) 减少持仓（清仓则删除记录）
      const remainQty = pos.quantity - ctx.quantity;
      if (remainQty <= 0) {
        await tx.position.delete({ where: { id: pos.id } });
      } else {
        await tx.position.update({
          where: { id: pos.id },
          data: {
            quantity: remainQty,
            availableQty: Math.max(0, pos.availableQty - ctx.quantity),
            // 冗余列：卖出后成本均价不变（已实现盈亏另计），浮动盈亏按剩余数量重算
            lastPrice: ctx.fillPrice,
            unrealizedPnl: round2((ctx.fillPrice - avgCost) * remainQty),
          },
        });
      }

      // 7) 生成订单
      const order = await tx.order.create({
        data: {
          accountId: ctx.accountId,
          stockId: ctx.stockId,
          side: ctx.side,
          orderType: ctx.orderType,
          price: ctx.orderType === "LIMIT" ? ctx.fillPrice : null,
          quantity: ctx.quantity,
          filledQty: ctx.quantity,
          filledPrice: ctx.fillPrice,
          status: "FILLED",
          orderTime: ctx.fillDate,
        },
        select: { id: true },
      });

      // 8) 生成成交记录（含已实现盈亏）
      const trade = await tx.trade.create({
        data: {
          accountId: ctx.accountId,
          stockId: ctx.stockId,
          orderId: order.id,
          side: ctx.side,
          price: ctx.fillPrice,
          quantity: ctx.quantity,
          amount: ctx.amount,
          commission: ctx.fees.commission,
          stampTax: ctx.fees.stampTax,
          transferFee: ctx.fees.transferFee,
          realizedPnl,
          tradedAt: ctx.fillDate,
        },
        select: { id: true },
      });

      return { orderId: order.id, tradeId: trade.id, realizedPnl, netIncome };
    },
  );

  // 12) 重新计算账户资产（写入当日快照）
  await refreshDailyAsset(ctx.accountId, ctx.fillDate);

  return {
    success: true,
    order: buildOrderInfo(ctx, orderId),
    trade: buildTradeInfo(ctx, tradeId, realizedPnl),
    message: `卖出成功：${ctx.stockName} ${ctx.quantity} 股 @ ¥${ctx.fillPrice.toFixed(
      2,
    )}，到账 ¥${netIncome.toFixed(2)}，实现盈亏 ¥${realizedPnl.toFixed(2)}`,
  };
}

/** 买入（语义化入口）。等价于 placeOrder({ side: "BUY" })。 */
export async function buyStock(
  input: Omit<PlaceOrderInput, "side">,
): Promise<PlaceOrderResult> {
  return placeOrder({ ...input, side: "BUY" });
}

/** 卖出（语义化入口）。等价于 placeOrder({ side: "SELL" })。 */
export async function sellStock(
  input: Omit<PlaceOrderInput, "side">,
): Promise<PlaceOrderResult> {
  return placeOrder({ ...input, side: "SELL" });
}


/**
 * T+1 结算：把「非当日买入」的持仓置为可卖。
 * 在每日开盘前（或读取持仓前）调用。回测/历史模拟时按日期推进调用。
 *
 * 语义（A股 T+1）：
 *   某只股票的可卖数量 = 该股持仓数量 − **该股在 asOfDate 当日买入的数量**。
 *   即当日买入的部分冻结到下一交易日。
 *
 * ⚠️ 缺陷修复记录（第四阶段）：
 *   原实现用 `trade.aggregate({ where: { accountId, side: "BUY", tradedAt: { lt: date } } })`
 *   汇总买入量，**未按 stockId 过滤**，且 select 未取 stockId。后果是多股票账户
 *   互相串味：若账户持有 A（当日买入 100 股）与 B（昨日买入 200 股），
 *   结算时 `bought = 200`（只统计昨日及以前的买入，且跨股票汇总），
 *   于是 A 被错误置为可卖 100 股 —— 违反 T+1。
 *   现改为**逐股票**统计当日买入量并相减。
 *
 * @returns 被更新的持仓条数
 */
export async function settleT1(accountId: string, asOfDate: string): Promise<number> {
  const date = normalizeDate(asOfDate);
  const positions = await prisma.position.findMany({
    where: { accountId, quantity: { gt: 0 } },
    select: { id: true, stockId: true, quantity: true, availableQty: true },
  });

  let updated = 0;
  for (const pos of positions) {
    // 该股票在 asOfDate **当日**买入的数量（这部分不可卖）
    const todayBuy = await prisma.trade.aggregate({
      where: {
        accountId,
        stockId: pos.stockId,
        side: "BUY",
        tradedAt: date,
      },
      _sum: { quantity: true },
    });
    const frozenQty = num(todayBuy._sum.quantity);
    const sellable = Math.max(0, pos.quantity - frozenQty);

    if (sellable !== pos.availableQty) {
      await prisma.position.update({
        where: { id: pos.id },
        data: { availableQty: sellable },
      });
      updated += 1;
    }
  }
  return updated;
}

/**
 * 解析账户的 T+1 结算日（只计算，不写库），供 POST /api/account/settle 使用。
 *
 * 背景：本系统市价单以「最新交易日收盘价」成交，而 A股 T+1 规定当日买入
 * 的份额次日才可卖。若界面没有推进交易日的入口，用户买入后「可卖数量」会
 * 恒为 0 —— 永远无法卖出。故提供一个显式的 T+1 结算动作：把结算日推进到
 * 「最近一次买入日之后的下一**真实**交易日」（交易日取自 klines，避免落到
 * 周末/节假日这种并不存在的交易日）。
 *
 * 若数据窗口已到最新交易日、不存在更晚的真实交易日，则回退为
 * 「买入日 + 1 个自然日」，并把 isTradingDay 置为 false，
 * 由界面如实提示该限制（不谎报为真实交易日）。
 */
export async function resolveT1Settlement(accountId: string): Promise<{
  asOfDate: string;
  isTradingDay: boolean;
  latestBuyDate: string;
} | null> {
  const latestBuy = await prisma.trade.aggregate({
    where: { accountId, side: "BUY" },
    _max: { tradedAt: true },
  });
  if (!latestBuy._max.tradedAt) return null; // 无买入成交 → 无可解锁份额

  const latestBuyDate = toDateStr(latestBuy._max.tradedAt);

  // 以「账户交易过的股票」作为交易日历来源
  const traded = await prisma.trade.findMany({
    where: { accountId },
    select: { stockId: true, stock: { select: { code: true } } },
    distinct: ["stockId"],
  });
  const codes = traded.map((t) => t.stock.code);

  const next = await getNextTradeDate(latestBuyDate, codes);
  if (next) return { asOfDate: next, isTradingDay: true, latestBuyDate };

  const fallback = new Date(`${latestBuyDate}T00:00:00.000Z`);
  fallback.setUTCDate(fallback.getUTCDate() + 1);
  return { asOfDate: toDateStr(fallback), isTradingDay: false, latestBuyDate };
}

/* ------------------------------------------------------------------ */
/*                      资产快照 / 收益分析                            */
/* ------------------------------------------------------------------ */

/**
 * 刷新指定日期的资产快照（DailyAsset）。
 * 以该日（或之前最近交易日）的收盘价计算持仓市值。
 */
export async function refreshDailyAsset(
  accountId: string,
  date: string | Date,
): Promise<DailyAssetInfo | null> {
  const d = typeof date === "string" ? date : toDateStr(date);
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      initialCash: true,
      availableCash: true,
      frozenCash: true,
      positions: {
        select: { quantity: true, stock: { select: { code: true } } },
      },
    },
  });
  if (!account) return null;

  let marketValue = 0;
  for (const pos of account.positions) {
    if (pos.quantity <= 0) continue;
    const bar = await getKlineAt(pos.stock.code, d);
    if (bar) marketValue += bar.close * pos.quantity;
  }

  const cash = round2(num(account.availableCash) + num(account.frozenCash));
  const initialCash = round2(num(account.initialCash));
  const totalAsset = round2(cash + marketValue);
  const totalPnl = round2(totalAsset - initialCash);
  const totalReturn = initialCash > 0 ? round2((totalPnl / initialCash) * 100) : 0;

  // 上一快照用于算日收益
  const prev = await prisma.dailyAsset.findFirst({
    where: { accountId, date: { lt: normalizeDate(d) } },
    orderBy: { date: "desc" },
    select: { totalAsset: true },
  });
  const prevAsset = prev ? num(prev.totalAsset) : initialCash;
  const dailyReturn =
    prevAsset > 0 ? round2(((totalAsset - prevAsset) / prevAsset) * 100) : 0;

  const saved = await prisma.dailyAsset.upsert({
    where: { accountId_date: { accountId, date: normalizeDate(d) } },
    update: {
      cash,
      marketValue: round2(marketValue),
      totalAsset,
      totalPnl,
      dailyReturn,
      totalReturn,
    },
    create: {
      accountId,
      date: normalizeDate(d),
      cash,
      marketValue: round2(marketValue),
      totalAsset,
      totalPnl,
      dailyReturn,
      totalReturn,
    },
  });

  return {
    date: toDateStr(saved.date),
    cash: num(saved.cash),
    marketValue: num(saved.marketValue),
    totalAsset: num(saved.totalAsset),
    totalPnl: num(saved.totalPnl),
    dailyReturn: num(saved.dailyReturn),
    totalReturn: num(saved.totalReturn),
  };
}

/** 净值曲线（按日期升序） */
export async function getEquityCurve(accountId: string): Promise<
  { date: string; totalAsset: number; nav: number; returnPercent: number }[]
> {
  const rows = await prisma.dailyAsset.findMany({
    where: { accountId },
    orderBy: { date: "asc" },
    select: { date: true, totalAsset: true },
  });
  if (rows.length === 0) return [];

  const base = num(rows[0].totalAsset) || 1;
  return rows.map((r) => {
    const totalAsset = num(r.totalAsset);
    const nav = base > 0 ? totalAsset / base : 1;
    return {
      date: toDateStr(r.date),
      totalAsset,
      nav: Math.round(nav * 10000) / 10000,
      returnPercent: Math.round((nav - 1) * 10000) / 100,
    };
  });
}

/* 注：`calcMaxDrawdown` / `calcPerformance` 已下沉到 lib/performanceMetrics.ts
   （回测引擎需复用同一套口径），并在本文件顶部 re-export 以保持既有 import 路径。 */

/** 一次性计算某账户的绩效指标 */
export async function getPerformance(accountId: string): Promise<PerformanceMetrics> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { initialCash: true },
  });
  const initialAsset = account ? num(account.initialCash) : 0;

  const rows = await prisma.dailyAsset.findMany({
    where: { accountId },
    orderBy: { date: "asc" },
    select: { date: true, totalAsset: true, dailyReturn: true },
  });

  const curve = rows.map((r) => ({
    date: toDateStr(r.date),
    totalAsset: num(r.totalAsset),
    dailyReturn: num(r.dailyReturn),
  }));

  return calcPerformance(curve, initialAsset);
}

/** 重置账户（清空持仓/委托/成交/快照，恢复初始资金） */
export async function resetAccount(accountId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { initialCash: true },
    });
    if (!account) return;

    await tx.trade.deleteMany({ where: { accountId } });
    await tx.order.deleteMany({ where: { accountId } });
    await tx.position.deleteMany({ where: { accountId } });
    await tx.dailyAsset.deleteMany({ where: { accountId } });
    await tx.account.update({
      where: { id: accountId },
      data: {
        availableCash: account.initialCash,
        frozenCash: 0,
      },
    });
  });
}
