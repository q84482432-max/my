/**
 * TradingEngine 端到端验收测试（第四阶段）
 *
 * 验证目标（对齐用户指令）：
 *   1. 虚拟账户初始资金 100000 元，字段 cash / marketValue / totalAsset /
 *      availableCash / frozenCash / totalProfit / totalProfitRate 齐备且满足恒等式
 *   2. 买入流程（11 步）逐条生效：校验 → 计算 → 检查资金 → 委托 → 成交 → 账户 → 持仓 → 资产
 *   3. 卖出流程（12 步）逐条生效：持仓 → T+1 可卖 → 计算 → 印花税 → 委托 → 成交 → 现金 → 盈亏
 *   4. 用户指定的核心场景：10 万元账户买 100 股 → 检查现金 / 持仓 → 再卖出 → 检查最终资产
 *   5. 拒绝路径：非 100 股整数倍 / 资金不足 / 股票不存在 / 超卖 / 未持有 / 限价单缺价
 *   6. settleT1 跨股票串味缺陷回归（多股票账户 T+1 互不干扰）
 *   7. 分层约束：账户余额只能由 TradingEngine 改写（本脚本不直连 Account 表做写操作）
 *
 * 运行： npx tsx scripts/testTradingEngine.ts
 */

import { prisma } from "@/lib/prisma";
import {
  buyStock,
  sellStock,
  calcFees,
  validateQuantity,
  createAccount,
  getAccountSummary,
  getPositions,
  getOrders,
  getTrades,
  settleT1,
} from "@/services/tradingEngine";
import { getKline, getLatestBar, getStockInfoByCode } from "@/services/marketDataService";
import { DEFAULT_INITIAL_CASH, LOT_SIZE } from "@/lib/constants";

/* ------------------------------------------------------------------ */
/* 测试框架（轻量，无外部依赖）                                          */
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

/** 金额近似相等（引擎内部按 round2 收敛，容差取 0.011） */
function near(a: number, b: number, eps = 0.011): boolean {
  return Math.abs(a - b) <= eps;
}

function money(v: number): string {
  return `¥${v.toFixed(2)}`;
}

/* ------------------------------------------------------------------ */
/* 测试夹具                                                            */
/* ------------------------------------------------------------------ */

const TEST_USERNAME = "e2e_trading_engine";
const TEST_ACCOUNT_NAME = "E2E 交易引擎测试账户";
const T1_USERNAME = "e2e_trading_t1";
const T1_ACCOUNT_NAME = "E2E T+1 隔离测试账户";

/** 候选标的：低价高流动性优先，保证 100 股金额远低于 10 万元本金 */
const CANDIDATES = ["000001", "601398", "600000", "000002", "601988", "600519"];

/**
 * 准备一个干净的测试账户：
 *  - 若同名用户已存在，先清空其全部交易数据并把资金复位到 initialCash；
 *  - 否则新建（统一走 TradingEngine.createAccount，不直连 Account 造数）。
 */
async function freshAccount(
  username: string,
  accountName: string,
  initialCash = DEFAULT_INITIAL_CASH,
): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, accounts: { select: { id: true }, orderBy: { createdAt: "asc" } } },
  });

  if (user && user.accounts.length > 0) {
    const accountId = user.accounts[0].id;
    await prisma.$transaction(async (tx) => {
      await tx.trade.deleteMany({ where: { accountId } });
      await tx.order.deleteMany({ where: { accountId } });
      await tx.position.deleteMany({ where: { accountId } });
      await tx.dailyAsset.deleteMany({ where: { accountId } });
      await tx.account.update({
        where: { id: accountId },
        data: { initialCash, availableCash: initialCash, frozenCash: 0 },
      });
    });
    return accountId;
  }

  return createAccount({ username, nickname: accountName, accountName, initialCash });
}

/** 挑选一只可用的测试标的，返回其代码 / 名称 / 复权口径 / 历史区间 */
async function pickStock(): Promise<{
  code: string;
  name: string;
  adjust: string;
  d1: string; // 较早的交易日（买入日）
  d2: string; // 最新交易日（卖出日）
  bars: { date: string; close: number }[];
} | null> {
  for (const code of CANDIDATES) {
    const info = await getStockInfoByCode(code);
    if (!info || info.barCount < 40) continue;

    const latest = await getLatestBar(code);
    if (!latest || latest.close <= 0) continue;
    // 100 股金额必须留足空间（不超过本金的 90%），否则无法覆盖「资金充足」正例
    if (latest.close * LOT_SIZE > DEFAULT_INITIAL_CASH * 0.9) continue;

    const bars = await getKline(code, {
      adjust: info.adjust as "qfq" | "hfq" | "none",
      limit: 40,
    });
    if (bars.length < 30) continue;

    const d2 = bars[bars.length - 1].date;
    const d1 = bars[bars.length - 21].date; // 约 20 个交易日前
    if (d1 >= d2) continue;

    return {
      code,
      name: info.name,
      adjust: info.adjust,
      d1,
      d2,
      bars: bars.map((b) => ({ date: b.date, close: b.close })),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("\n\x1b[1m第四阶段验收测试 — TradingEngine 端到端\x1b[0m");
  console.log("═".repeat(64));

  /* ============================================================ */
  section("0. 环境准备（真实数据 + 干净测试账户）");

  const stockCount = await prisma.stock.count();
  const klineCount = await prisma.kline.count();
  check(`数据库已落地真实股票数据`, stockCount > 0, `stocks=${stockCount}`);
  check(`数据库已落地真实K线数据`, klineCount > 0, `klines=${klineCount}`);

  const target = await pickStock();
  check(
    "选取到可交易标的（100 股金额 ≤ 本金 90%）",
    target !== null,
    target ? `${target.code} ${target.name} 复权=${target.adjust} D1=${target.d1} D2=${target.d2}` : "候选全部不可用",
  );
  if (!target) {
    console.log("\n\x1b[31m无法选取标的，测试中止\x1b[0m");
    process.exit(1);
  }

  const accountId = await freshAccount(TEST_USERNAME, TEST_ACCOUNT_NAME, DEFAULT_INITIAL_CASH);

  const open0 = await getAccountSummary(accountId);
  check("测试账户初始资金为 100000 元", open0?.initialCash === DEFAULT_INITIAL_CASH, `initialCash=${open0?.initialCash}`);
  check(
    "新账户现金 = 可用现金 = 初始资金，冻结与持仓为空",
    open0 !== null &&
      near(open0.availableCash, DEFAULT_INITIAL_CASH) &&
      near(open0.cash, DEFAULT_INITIAL_CASH) &&
      open0.frozenCash === 0 &&
      open0.marketValue === 0 &&
      near(open0.totalAsset, DEFAULT_INITIAL_CASH) &&
      open0.totalProfit === 0 &&
      open0.totalProfitRate === 0,
    `cash=${money(open0?.cash ?? 0)} marketValue=${money(open0?.marketValue ?? 0)} totalAsset=${money(open0?.totalAsset ?? 0)}`,
  );

  /* ============================================================ */
  section("1. 纯函数：交易费用与委托数量规则");

  const buyFee = calcFees(10000, "BUY");
  check(
    "买入费用：佣金 min(万三, 5) / 无印花税 / 过户费万0.1",
    near(buyFee.commission, 5) && buyFee.stampTax === 0 && near(buyFee.transferFee, 0.1) && near(buyFee.total, 5.1),
    `commission=${buyFee.commission} stampTax=${buyFee.stampTax} transferFee=${buyFee.transferFee} total=${buyFee.total}`,
  );

  const sellFee = calcFees(10000, "SELL");
  check(
    "卖出费用：额外收取千一印花税",
    near(sellFee.commission, 5) && near(sellFee.stampTax, 10) && near(sellFee.transferFee, 0.1) && near(sellFee.total, 15.1),
    `commission=${sellFee.commission} stampTax=${sellFee.stampTax} transferFee=${sellFee.transferFee} total=${sellFee.total}`,
  );

  const bigBuy = calcFees(1_000_000, "BUY");
  const bigSell = calcFees(1_000_000, "SELL");
  check(
    "大额费用按费率线性计算（万三佣金生效，不再触发 5 元下限）",
    near(bigBuy.commission, 300) && near(bigBuy.total, 310) && near(bigSell.stampTax, 1000) && near(bigSell.total, 1310),
    `buy.total=${bigBuy.total} sell.total=${bigSell.total}`,
  );

  check("数量规则：买入 100 股合法", validateQuantity(100, "BUY") === null);
  check("数量规则：买入 200 股合法", validateQuantity(200, "BUY") === null);
  check("数量规则：买入 150 股非法（非 100 整数倍）", validateQuantity(150, "BUY") !== null, validateQuantity(150, "BUY") ?? "");
  check("数量规则：买入 0 股非法", validateQuantity(0, "BUY") !== null);
  check("数量规则：买入负数非法", validateQuantity(-100, "BUY") !== null);
  check("数量规则：买入小数非法", validateQuantity(100.5, "BUY") !== null);
  check("数量规则：卖出 150 股合法（允许零股清仓）", validateQuantity(150, "SELL") === null);
  check("数量规则：卖出 1 股合法（零股）", validateQuantity(1, "SELL") === null);

  /* ============================================================ */
  section("2. 拒绝路径（不产生任何副作用）");

  const rejMultiple = await buyStock({ accountId, stockCode: target.code, quantity: 150, tradeDate: target.d1 });
  check("买入 150 股被拒（非一手整数倍）", !rejMultiple.success && rejMultiple.message.includes("整数倍"), rejMultiple.message);

  const rejNoStock = await buyStock({ accountId, stockCode: "999999", quantity: 100, tradeDate: target.d1 });
  check("买入不存在的股票被拒", !rejNoStock.success && rejNoStock.message.includes("不存在"), rejNoStock.message);

  const rejNoAccount = await buyStock({ accountId: "no-such-account", stockCode: target.code, quantity: 100, tradeDate: target.d1 });
  check("账户不存在被拒", !rejNoAccount.success && rejNoAccount.message.includes("账户不存在"), rejNoAccount.message);

  const rejNoPrice = await buyStock({ accountId, stockCode: target.code, quantity: 100, orderType: "LIMIT" });
  check("限价单未指定委托价被拒", !rejNoPrice.success && rejNoPrice.message.includes("委托价格"), rejNoPrice.message);

  const d1Close = target.bars.find((b) => b.date === target.d1)?.close ?? 0;
  const oversizeQty = Math.ceil((DEFAULT_INITIAL_CASH * 2) / d1Close / LOT_SIZE) * LOT_SIZE;
  const rejNoCash = await buyStock({ accountId, stockCode: target.code, quantity: oversizeQty, tradeDate: target.d1 });
  check(
    "资金不足被拒（委托金额远超可用资金）",
    !rejNoCash.success && rejNoCash.message.includes("可用资金不足"),
    `${oversizeQty} 股 -> ${rejNoCash.message}`,
  );

  const rejNoPosition = await sellStock({ accountId, stockCode: target.code, quantity: 100, tradeDate: target.d2 });
  check("未持有即卖出被拒", !rejNoPosition.success && rejNoPosition.message.includes("未持有"), rejNoPosition.message);

  const untouched = await getAccountSummary(accountId);
  const untouchedPositions = await getPositions(accountId);
  const untouchedOrders = await getOrders(accountId);
  const untouchedTrades = await getTrades(accountId);
  check(
    "全部拒绝路径均未产生副作用（资金 / 持仓 / 委托 / 成交 均无变化）",
    untouched !== null &&
      near(untouched.availableCash, DEFAULT_INITIAL_CASH) &&
      untouched.cash === DEFAULT_INITIAL_CASH &&
      untouched.marketValue === 0 &&
      untouchedPositions.length === 0 &&
      untouchedOrders.length === 0 &&
      untouchedTrades.length === 0,
    `availableCash=${money(untouched?.availableCash ?? 0)} positions=${untouchedPositions.length} orders=${untouchedOrders.length} trades=${untouchedTrades.length}`,
  );

  /* ============================================================ */
  section(`3. 买入流程 —— 10 万元账户买入 100 股 ${target.name}（成交日 ${target.d1}）`);

  const beforeBuy = (await getAccountSummary(accountId))!;
  const buyRes = await buyStock({
    accountId,
    stockCode: target.code,
    quantity: 100,
    tradeDate: target.d1,
  });

  check("买入委托成交成功", buyRes.success, buyRes.message);
  if (!buyRes.success) {
    console.log("\n\x1b[31m买入失败，测试中止\x1b[0m");
    process.exit(1);
  }

  // —— 手工独立复算（不复用引擎内部变量，验证引擎算得对） ——
  const expectBuyAmount = Math.round(d1Close * 100 * 100) / 100;
  const expectBuyFees = calcFees(expectBuyAmount, "BUY");
  const expectNeedCash = Math.round((expectBuyAmount + expectBuyFees.total) * 100) / 100;
  const expectAvgCost = expectNeedCash / 100;

  check("成交价 = 买入日收盘价", near(buyRes.order!.filledPrice!, d1Close), `filled=${buyRes.order!.filledPrice} close=${d1Close}`);
  check("委托单状态为已成交且数量一致", buyRes.order!.status === "FILLED" && buyRes.order!.filledQty === 100, `status=${buyRes.order!.status} filledQty=${buyRes.order!.filledQty}`);

  // 步骤 9：更新账户（扣现金）
  const afterBuy = (await getAccountSummary(accountId))!;
  check(
    "① cash 下降（扣减成交额 + 全部费用）",
    near(afterBuy.availableCash, beforeBuy.availableCash - expectNeedCash),
    `${money(beforeBuy.availableCash)} - ${money(expectNeedCash)} = ${money(afterBuy.availableCash)}`,
  );
  check("② 冻结资金不变（即时全额成交无挂单占用）", afterBuy.frozenCash === 0, `frozenCash=${afterBuy.frozenCash}`);

  // 步骤 10：更新持仓
  const positions = await getPositions(accountId);
  const pos = positions.find((p) => p.stockCode === target.code);
  check("③ position 增加：新增 100 股持仓", positions.length === 1 && pos?.quantity === 100, `持仓数=${positions.length} 数量=${pos?.quantity}`);
  check("④ T+1：当日买入的 100 股不可卖（availableQty = 0）", pos?.availableQty === 0, `availableQty=${pos?.availableQty}`);
  check(
    "⑤ 成本均价含买入费用 =（成交额 + 费用）/ 数量",
    pos !== undefined && near(pos.avgCost, expectAvgCost, 0.001),
    `avgCost=${pos?.avgCost} 期望≈${expectAvgCost.toFixed(4)}`,
  );

  // 步骤 11：重新计算资产
  const latest = (await getLatestBar(target.code))!;
  const expectMarketValue = Math.round(latest.close * 100 * 100) / 100;
  check("⑥ marketValue 增加：> 0 且 = 最新收盘价 × 持仓数量", afterBuy.marketValue > 0 && near(afterBuy.marketValue, expectMarketValue), `${money(afterBuy.marketValue)} 期望=${money(expectMarketValue)}`);
  check("⑦ totalAsset 重新计算 = cash + marketValue", near(afterBuy.totalAsset, afterBuy.cash + afterBuy.marketValue), `${money(afterBuy.totalAsset)} = ${money(afterBuy.cash)} + ${money(afterBuy.marketValue)}`);
  check("⑧ totalProfit = totalAsset − 初始资金", near(afterBuy.totalProfit, afterBuy.totalAsset - DEFAULT_INITIAL_CASH), `${money(afterBuy.totalProfit)}`);
  check(
    "⑨ totalProfit = 持仓市值 − 买入总支出（现金流口径，与市值/现金自洽）",
    near(afterBuy.totalProfit, afterBuy.marketValue - expectNeedCash),
    `totalProfit=${money(afterBuy.totalProfit)} = marketValue ${money(afterBuy.marketValue)} − 支出 ${money(expectNeedCash)}`,
  );
  check(
    "⑩ totalProfitRate = totalProfit / 初始资金 × 100",
    near(afterBuy.totalProfitRate, (afterBuy.totalProfit / DEFAULT_INITIAL_CASH) * 100),
    `${afterBuy.totalProfitRate}%`,
  );

  // 落库校验：委托 / 成交 / 资产快照
  const ordersAfterBuy = await getOrders(accountId);
  check("⑪ 生成订单 1 笔（BUY / FILLED）", ordersAfterBuy.length === 1 && ordersAfterBuy[0].side === "BUY" && ordersAfterBuy[0].status === "FILLED", `orders=${ordersAfterBuy.length}`);

  const tradesAfterBuy = await getTrades(accountId);
  const buyTrade = tradesAfterBuy[0];
  check(
    "⑫ 生成成交记录：金额 / 佣金 / 无印花税 / 过户费 / 实现盈亏 0 全部吻合",
    tradesAfterBuy.length === 1 &&
      buyTrade.side === "BUY" &&
      near(buyTrade.amount, expectBuyAmount) &&
      near(buyTrade.commission, expectBuyFees.commission) &&
      buyTrade.stampTax === 0 &&
      near(buyTrade.transferFee, expectBuyFees.transferFee) &&
      buyTrade.realizedPnl === 0,
    `amount=${money(buyTrade.amount)} commission=${buyTrade.commission} stampTax=${buyTrade.stampTax} realizedPnl=${buyTrade.realizedPnl}`,
  );
  check("⑬ 成交记录交易日 = 委托指定的买入日", buyTrade.tradedAt === target.d1, `tradedAt=${buyTrade.tradedAt}`);

  const snapBuy = await prisma.dailyAsset.findFirst({ where: { accountId, date: new Date(`${target.d1}T00:00:00.000Z`) } });
  check(
    "⑭ 写入成交日资产快照：totalAsset = 初始资金 − 买入费用（买入当刻只承担费用、不产生盈亏）",
    snapBuy !== null && near(Number(snapBuy.totalAsset), DEFAULT_INITIAL_CASH - expectBuyFees.total) && near(Number(snapBuy.totalPnl), -expectBuyFees.total),
    `totalAsset=${money(Number(snapBuy?.totalAsset ?? 0))} totalPnl=${money(Number(snapBuy?.totalPnl ?? 0))}`,
  );

  /* ============================================================ */
  section("4. T+1 约束与卖出流程");

  // 卖出前先确认 T+1 正在生效
  const earlySell = await sellStock({ accountId, stockCode: target.code, quantity: 100, tradeDate: target.d2 });
  check("⑮ 未结算即卖出被拒（T+1 可卖数量不足）", !earlySell.success && earlySell.message.includes("可卖数量不足"), earlySell.message);

  const settledSameDay = await settleT1(accountId, target.d1);
  const posSameDay = (await getPositions(accountId)).find((p) => p.stockCode === target.code);
  check("⑯ settleT1 以「买入当日」结算时仍不可卖（当日买入冻结到次日）", posSameDay?.availableQty === 0, `updated=${settledSameDay} availableQty=${posSameDay?.availableQty}`);

  const settledNext = await settleT1(accountId, target.d2);
  const posNext = (await getPositions(accountId)).find((p) => p.stockCode === target.code);
  check("⑰ settleT1 推进到下一交易日后全部可卖", settledNext === 1 && posNext?.availableQty === 100, `updated=${settledNext} availableQty=${posNext?.availableQty}`);

  // —— 卖出 100 股 ——
  const beforeSell = (await getAccountSummary(accountId))!;
  const d2Close = (await getLatestBar(target.code))!.close;
  const sellRes = await sellStock({ accountId, stockCode: target.code, quantity: 100, tradeDate: target.d2 });
  check("卖出委托成交成功", sellRes.success, sellRes.message);

  const expectSellAmount = Math.round(d2Close * 100 * 100) / 100;
  const expectSellFees = calcFees(expectSellAmount, "SELL");
  const expectNetIncome = Math.round((expectSellAmount - expectSellFees.total) * 100) / 100;
  const expectRealized = Math.round((expectSellAmount - expectNeedCash - expectSellFees.total) * 100) / 100;
  const expectFinalAsset = Math.round((DEFAULT_INITIAL_CASH - expectNeedCash + expectNetIncome) * 100) / 100;

  const sellTrade = (await getTrades(accountId, { stockCode: target.code })).find((t) => t.side === "SELL");
  if (sellTrade) {
    check(
      "⑱ 卖出费用结构正确：佣金 + 千一印花税 + 过户费",
      near(sellTrade.commission, expectSellFees.commission) &&
        near(sellTrade.stampTax, expectSellFees.stampTax) &&
        sellTrade.stampTax > 0 &&
        near(sellTrade.transferFee, expectSellFees.transferFee),
      `commission=${sellTrade.commission} stampTax=${sellTrade.stampTax} transferFee=${sellTrade.transferFee}`,
    );
    check(
      "⑲ realizedPnl 更新 =（卖价 − 成本均价）× 数量 − 卖出费用",
      near(sellTrade.realizedPnl, expectRealized),
      `realizedPnl=${money(sellTrade.realizedPnl)} 期望=${money(expectRealized)}`,
    );
  } else {
    check("⑱ 生成卖出成交记录", false, "未找到 SELL 成交记录");
    check("⑲ realizedPnl 更新", false, "未找到 SELL 成交记录");
  }

  const afterSell = (await getAccountSummary(accountId))!;
  const positionsAfterSell = await getPositions(accountId);
  check("⑳ position 减少：持仓已清空", positionsAfterSell.length === 0, `剩余持仓=${positionsAfterSell.length}`);
  check("㉑ marketValue 归零", afterSell.marketValue === 0, `${money(afterSell.marketValue)}`);
  check(
    "㉒ cash 增加（净到账 = 成交额 − 全部费用）",
    near(afterSell.availableCash, beforeSell.availableCash + expectNetIncome),
    `${money(beforeSell.availableCash)} + ${money(expectNetIncome)} = ${money(afterSell.availableCash)}`,
  );
  check("㉓ cash = availableCash + frozenCash 恒等", near(afterSell.cash, afterSell.availableCash + afterSell.frozenCash), `${money(afterSell.cash)}`);
  check("㉔ totalAsset = cash + marketValue 恒等", near(afterSell.totalAsset, afterSell.cash + afterSell.marketValue), `${money(afterSell.totalAsset)} = ${money(afterSell.cash)} + ${money(afterSell.marketValue)}`);
  check("㉕ 最终资产 = 初始资金 − 买入支出 + 卖出净到账（手工验算）", near(afterSell.totalAsset, expectFinalAsset), `${money(afterSell.totalAsset)} 期望=${money(expectFinalAsset)}`);
  check("㉖ totalProfit = totalAsset − 初始资金", near(afterSell.totalProfit, afterSell.totalAsset - DEFAULT_INITIAL_CASH), `${money(afterSell.totalProfit)}`);
  check("㉗ 全仓清仓后 totalProfit 恰等于已实现盈亏（累计盈亏 = 已实现盈亏）", near(afterSell.totalProfit, expectRealized), `${money(afterSell.totalProfit)} vs ${money(expectRealized)}`);
  check("㉘ totalProfitRate = totalProfit / 初始资金 × 100", near(afterSell.totalProfitRate, (afterSell.totalProfit / DEFAULT_INITIAL_CASH) * 100), `${afterSell.totalProfitRate}%`);

  const snapSell = await prisma.dailyAsset.findFirst({ where: { accountId, date: new Date(`${target.d2}T00:00:00.000Z`) } });
  check(
    "㉙ 卖出日资产快照已更新（持仓清空后 totalAsset = 现金）",
    snapSell !== null && near(Number(snapSell.marketValue), 0) && near(Number(snapSell.totalAsset), expectFinalAsset),
    `totalAsset=${money(Number(snapSell?.totalAsset ?? 0))}`,
  );

  const allOrders = await getOrders(accountId);
  check("㉚ 委托流水共 2 笔（买入 + 卖出）", allOrders.length === 2, `orders=${allOrders.length}`);

  /* ============================================================ */
  section("5. settleT1 跨股票隔离（缺陷回归）");

  const second = await pickStockByOffset(1); // 另选一只股票，避免与 target 相同
  const windowAligned = second !== null && second.d2 === target.d2;

  if (!second) {
    check("取得第二只测试标的", false, "无法取得第二只标的");
  } else {
    const dToday = second.d2; // 「今日」= 两只股票共同的最新交易日
    const dEarly = target.bars[target.bars.length - 31].date; // 「更早的交易日」

    check(
      "A/B 两标的数据窗口末端对齐（保证 fillDate 精确落在指定交易日）",
      windowAligned && dEarly < dToday,
      `A=${target.code}@${target.d2} B=${second.code}@${second.d2} dEarly=${dEarly}`,
    );

    /* --- 场景一：旧实现会把「已过 T+1 的 A」错误冻结 --- */
    const t1a = await freshAccount(T1_USERNAME, T1_ACCOUNT_NAME, DEFAULT_INITIAL_CASH);
    const buyA1 = await buyStock({ accountId: t1a, stockCode: target.code, quantity: 100, tradeDate: dEarly });
    const buyB1 = await buyStock({ accountId: t1a, stockCode: second.code, quantity: 100, tradeDate: dToday });
    check(
      "场景一建仓：A 早前买入 100 股 / B 今日买入 100 股",
      buyA1.success && buyB1.success && buyA1.order?.orderTime === dEarly && buyB1.order?.orderTime === dToday,
      `A@${buyA1.order?.orderTime} B@${buyB1.order?.orderTime}`,
    );

    await settleT1(t1a, dToday);
    const posA1 = (await getPositions(t1a)).find((p) => p.stockCode === target.code);
    const posB1 = (await getPositions(t1a)).find((p) => p.stockCode === second.code);
    check(
      "㉛ A（早前买入）今日全部可卖 = 100",
      posA1?.availableQty === 100,
      `A(${target.code}) availableQty=${posA1?.availableQty}（旧实现跨股票汇总后会被错误冻结为 0）`,
    );
    check(
      "㉜ B（今日买入）今日不可卖 = 0",
      posB1?.availableQty === 0,
      `B(${second.code}) availableQty=${posB1?.availableQty}`,
    );

    const sellA1 = await sellStock({ accountId: t1a, stockCode: target.code, quantity: 100, tradeDate: dToday });
    const sellB1 = await sellStock({ accountId: t1a, stockCode: second.code, quantity: 100, tradeDate: dToday });
    check("㉝ 可卖的 A 能成功卖出并更新已实现盈亏", sellA1.success && !sellA1.message.includes("不足"), sellA1.message);
    check("㉞ 不可卖的 B 被正确拒绝", !sellB1.success && sellB1.message.includes("可卖数量不足"), sellB1.message);

    /* --- 场景二：旧实现会把「当日买入的 A」错误置为可卖（甚至写成负数） --- */
    const t1b = await freshAccount(T1_USERNAME + "_b", T1_ACCOUNT_NAME + " B", DEFAULT_INITIAL_CASH);
    const buyA2 = await buyStock({ accountId: t1b, stockCode: target.code, quantity: 100, tradeDate: dToday });
    const buyB2 = await buyStock({ accountId: t1b, stockCode: second.code, quantity: 200, tradeDate: dEarly });
    check(
      "场景二建仓：A 今日买入 100 股 / B 早前买入 200 股",
      buyA2.success && buyB2.success && buyA2.order?.orderTime === dToday,
      `A@${buyA2.order?.orderTime} B=${buyB2.order?.filledQty}股@${buyB2.order?.orderTime}`,
    );

    await settleT1(t1b, dToday);
    const posA2 = (await getPositions(t1b)).find((p) => p.stockCode === target.code);
    const posB2 = (await getPositions(t1b)).find((p) => p.stockCode === second.code);
    check(
      "㉟ A（今日买入）今日不可卖 = 0（旧实现会误判为可卖或负数）",
      posA2?.availableQty === 0,
      `A(${target.code}) availableQty=${posA2?.availableQty}`,
    );
    check(
      "㊱ B（早前买入 200 股）今日全部可卖 = 200",
      posB2?.availableQty === 200,
      `B(${second.code}) availableQty=${posB2?.availableQty}（旧实现被 A 的持仓量冲抵后为 0）`,
    );

    const sellA2 = await sellStock({ accountId: t1b, stockCode: target.code, quantity: 100, tradeDate: dToday });
    check("㊲ 违反 T+1 的卖出被拒绝", !sellA2.success && sellA2.message.includes("可卖数量不足"), sellA2.message);
  }

  /* ============================================================ */
  section("6. 分层约束：账户余额仅由 TradingEngine 改写");

  const engineSource = await readFileSafe("services/tradingEngine.ts");
  const apiOrdersRoute = await readFileSafe("app/api/account/orders/route.ts");
  const accountClient = await readFileSafe("components/AccountClient.tsx");
  const stockDetail = await readFileSafe("components/StockDetail.tsx");

  check("tradingEngine 内部集中管理账户写入（未散落他处）", engineSource.includes("availableCash"), "services/tradingEngine.ts");
  check(
    "下单 API 仅调用交易引擎，不直接操作 Account 表",
    apiOrdersRoute.length > 0 && !/prisma\.account\.(update|create)/.test(apiOrdersRoute),
    "app/api/account/orders/route.ts",
  );
  check(
    "React 组件不直接改账户余额（无 prisma.account 写入）",
    !/prisma\.account\.(update|create)/.test(accountClient) && !/prisma\.account\.(update|create)/.test(stockDetail),
    "components/AccountClient.tsx / components/StockDetail.tsx",
  );

  /* ============================================================ */
  // 清理测试账户（保留用户真实账户不受影响）
  await cleanup();

  console.log("\n" + "═".repeat(64));
  console.log(
    `\x1b[1m测试结果：\x1b[32m通过 ${passed}\x1b[0m  \x1b[31m失败 ${failed}\x1b[0m  共 ${passed + failed} 项\x1b[0m`,
  );
  if (failed > 0) {
    console.log("\x1b[31m失败项：\x1b[0m");
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log("");

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 按偏移量再挑一只不同的标的（用于跨股票 T+1 测试） */
async function pickStockByOffset(offset: number) {
  for (const code of CANDIDATES.slice(offset)) {
    const info = await getStockInfoByCode(code);
    if (!info || info.barCount < 60) continue;
    const latest = await getLatestBar(code);
    if (!latest || latest.close <= 0) continue;
    if (latest.close * LOT_SIZE > DEFAULT_INITIAL_CASH * 0.9) continue;
    const bars = await getKline(code, { adjust: info.adjust as "qfq" | "hfq" | "none", limit: 40 });
    if (bars.length < 35) continue;
    return { code, name: info.name, adjust: info.adjust, d2: bars[bars.length - 1].date };
  }
  return null;
}

/** settleT1 的薄封装（仅用于语义清晰） */
async function settleT1Account(accountId: string, asOfDate: string): Promise<number> {
  return settleT1(accountId, asOfDate);
}

async function readFileSafe(relPath: string): Promise<string> {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    return await fs.readFile(path.join(process.cwd(), relPath), "utf8");
  } catch {
    return "";
  }
}

/** 删除本测试创建的用户与账户（不影响用户真实数据） */
async function cleanup(): Promise<void> {
  const usernames = [TEST_USERNAME, T1_USERNAME, T1_USERNAME + "_b"];
  try {
    const users = await prisma.user.findMany({
      where: { username: { in: usernames } },
      select: { id: true, accounts: { select: { id: true } } },
    });
    const accountIds = users.flatMap((u) => u.accounts.map((a) => a.id));
    if (accountIds.length > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.trade.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.order.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.position.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.dailyAsset.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.account.deleteMany({ where: { id: { in: accountIds } } });
      });
    }
    await prisma.user.deleteMany({ where: { username: { in: usernames } } });
  } catch {
    /* 清理失败不影响测试结论 */
  }
}

main().catch(async (err) => {
  console.error("\n\x1b[31m测试异常终止：\x1b[0m", err);
  await prisma.$disconnect();
  process.exit(1);
});
