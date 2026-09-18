/**
 * 账户三视图数据同步端到端测试（我的持仓 / 委托订单 / 成交记录）
 *
 * 对齐用户指定的验证流程：
 *   买入 → 查看持仓 → 查看委托 → 查看成交 → 卖出 → 再次查看三者是否同步
 *
 * 数据来源要求（对应「所有数据显示必须来自数据库和 TradingEngine，禁止假数据」）：
 *   - 三个视图的 DTO 一律由 services/tradingEngine.ts 生成；
 *   - 本脚本对每个关键值都做「独立对照」或「DB 溯源」校验：
 *       · 持仓价格/昨收 ↔ 直接读 klines（getKline）对照
 *       · 委托编号 ↔ orders 表主键命中
 *       · 成交 ↔ trades 表行、且可回溯到对应委托单
 *       · 手续费 ↔ calcFees 纯函数独立计算
 *
 * 运行： npx tsx scripts/testAccountViews.ts
 */

import { prisma } from "@/lib/prisma";
import {
  buyStock,
  calcFees,
  createAccount,
  getAccountSummary,
  getOrders,
  getPositions,
  getTrades,
  resolveT1Settlement,
  sellStock,
  settleT1,
} from "@/services/tradingEngine";
import { getKline, getStockInfoByCode } from "@/services/marketDataService";
import { DEFAULT_INITIAL_CASH, LOT_SIZE } from "@/lib/constants";
import type { OrderInfo, PositionInfo, TradeInfo } from "@/types";

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

function near(a: number, b: number, eps = 0.011): boolean {
  return Math.abs(a - b) <= eps;
}

function money(v: number): string {
  return `¥${v.toFixed(2)}`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** 字段存在性判断（包一层 unknown，避免与 null/undefined 比较时触发 TS2367） */
function isDefined(v: unknown): boolean {
  return v !== undefined;
}
function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const TEST_USERNAME = "e2e_account_views";
const TEST_ACCOUNT_NAME = "E2E 三视图同步测试账户";
/** 候选标的：低价高流动性，保证 200 股金额远低于 10 万元本金 */
const CANDIDATES = ["000001", "601398", "600000", "000002", "601988"];
const QTY = 200;

/** 准备干净账户：同名用户存在则清空其交易数据（不直连 Account 造数） */
async function freshAccount(username: string, accountName: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      accounts: { select: { id: true }, orderBy: { createdAt: "asc" } },
    },
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
        data: {
          initialCash: DEFAULT_INITIAL_CASH,
          availableCash: DEFAULT_INITIAL_CASH,
          frozenCash: 0,
        },
      });
    });
    return accountId;
  }

  return createAccount({
    username,
    nickname: accountName,
    accountName,
    initialCash: DEFAULT_INITIAL_CASH,
  });
}

interface Target {
  code: string;
  name: string;
  /** 较早的交易日（买入日） */
  d1: string;
  /** d1 之后的下一真实交易日（T+1 结算日） */
  dNext: string;
  /** 最新交易日（卖出日） */
  d2: string;
  /** d1 收盘价 */
  c1: number;
  /** d2（最新）收盘价 */
  c2: number;
  /** 上一交易日收盘价 */
  cPrev: number;
}

/** 挑选可交易标的，并取「买入日 / 结算日 / 卖出日」三个真实交易日 */
async function pickTarget(): Promise<Target | null> {
  for (const code of CANDIDATES) {
    const info = await getStockInfoByCode(code);
    if (!info || info.barCount < 40) continue;

    const bars = await getKline(code, {
      adjust: info.adjust,
      limit: 40,
    });
    if (bars.length < 40) continue;

    const c2 = bars[bars.length - 1].close;
    if (c2 * LOT_SIZE > DEFAULT_INITIAL_CASH * 0.9) continue;

    return {
      code,
      name: info.name,
      d1: bars[bars.length - 21].date,
      dNext: bars[bars.length - 20].date,
      d2: bars[bars.length - 1].date,
      c1: bars[bars.length - 21].close,
      c2,
      cPrev: bars[bars.length - 2].close,
    };
  }
  return null;
}

/** 删除本测试创建的账户（不影响用户真实数据） */
async function cleanup(): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { username: TEST_USERNAME },
      select: { id: true, accounts: { select: { id: true } } },
    });
    if (!user) return;
    const ids = user.accounts.map((a) => a.id);
    if (ids.length > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.trade.deleteMany({ where: { accountId: { in: ids } } });
        await tx.order.deleteMany({ where: { accountId: { in: ids } } });
        await tx.position.deleteMany({ where: { accountId: { in: ids } } });
        await tx.dailyAsset.deleteMany({ where: { accountId: { in: ids } } });
        await tx.account.deleteMany({ where: { id: { in: ids } } });
      });
    }
    await prisma.user.deleteMany({ where: { id: user.id } });
  } catch {
    /* 清理失败不影响测试结论 */
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("\n\x1b[1m账户三视图数据同步测试 — 持仓 / 委托 / 成交\x1b[0m");
  console.log("═".repeat(64));

  section("0. 环境准备（真实数据 + 干净账户）");

  const stockCount = await prisma.stock.count();
  const klineCount = await prisma.kline.count();
  check("数据库已落地真实股票数据", stockCount > 0, `stocks=${stockCount}`);
  check("数据库已落地真实K线数据", klineCount > 0, `klines=${klineCount}`);

  const t = await pickTarget();
  check(
    "选取到可交易标的与三个真实交易日",
    t !== null,
    t ? `${t.code} ${t.name} 买入日=${t.d1} 结算日=${t.dNext} 卖出日=${t.d2}` : "候选全部不可用",
  );
  if (!t) {
    console.log("\n\x1b[31m无法选取标的，测试中止\x1b[0m");
    await prisma.$disconnect();
    process.exit(1);
  }

  const accountId = await freshAccount(TEST_USERNAME, TEST_ACCOUNT_NAME);
  const open = await getAccountSummary(accountId);
  check(
    "测试账户初始资金 100000 元且无持仓",
    open?.initialCash === DEFAULT_INITIAL_CASH &&
      near(open.availableCash, DEFAULT_INITIAL_CASH) &&
      open.marketValue === 0,
    `availableCash=${money(open?.availableCash ?? 0)}`,
  );

  /* ---------------------------------------------------------------- */
  section("1. 买入（按真实历史交易日成交）");

  const buyRes = await buyStock({
    accountId,
    stockCode: t.code,
    quantity: QTY,
    tradeDate: t.d1,
  });
  check("买入成功", buyRes.success, buyRes.message);
  check("下单结果返回委托单", Boolean(buyRes.order), buyRes.order?.id);
  check("下单结果返回成交记录", Boolean(buyRes.trade), buyRes.trade?.id);

  const buyAmount = round2(t.c1 * QTY);
  const buyFees = calcFees(buyAmount, "BUY");
  check(
    "成交价 = 买入日收盘价（真实行情）",
    near(buyRes.trade?.price ?? 0, t.c1),
    `成交价=${buyRes.trade?.price} 该日收盘=${t.c1}`,
  );

  /* ---------------------------------------------------------------- */
  section("2. 查看持仓（买入后）");

  const positions = await getPositions(accountId);
  check("持仓视图返回 1 条", positions.length === 1, `count=${positions.length}`);
  const p = positions[0] as PositionInfo;
  const avgCost6 = round6((buyAmount + buyFees.total) / QTY);

  check("持仓数量 = 200", p.quantity === QTY, String(p.quantity));
  check("可卖数量 = 0（T+1 当日买入冻结）", p.availableQty === 0, String(p.availableQty));
  check(
    "平均成本 =（成交额 + 全部费用）/ 数量",
    near(p.avgCost, avgCost6, 1e-4),
    `avgCost=${p.avgCost} 期望=${avgCost6}`,
  );
  check(
    "当前价格 = 最新交易日收盘价（独立读 klines 对照）",
    near(p.lastPrice, t.c2),
    `lastPrice=${p.lastPrice} klines收盘=${t.c2}`,
  );
  check(
    "上一交易日收盘价来自真实行情",
    near(p.prevClose, t.cPrev),
    `prevClose=${p.prevClose} klines=${t.cPrev}`,
  );
  check(
    "持仓市值 = 当前价格 × 持仓数量",
    near(p.marketValue, round2(t.c2 * QTY)),
    money(p.marketValue),
  );
  check(
    "浮动盈亏 = 市值 − 成本总额",
    near(p.unrealizedPnl, round2(round2(t.c2 * QTY) - round2(avgCost6 * QTY))),
    money(p.unrealizedPnl),
  );
  check(
    "浮动盈亏率 = 浮动盈亏 / 成本总额 × 100",
    near(p.unrealizedPnlPercent, round2((p.unrealizedPnl / round2(avgCost6 * QTY)) * 100)),
    `${p.unrealizedPnlPercent}%`,
  );
  check(
    "今日盈亏 =（现价 − 昨收）× 持仓数量（非当日买入分支）",
    near(p.todayPnl, round2((t.c2 - t.cPrev) * QTY)),
    `${money(p.todayPnl)} 期望 ${money(round2((t.c2 - t.cPrev) * QTY))}`,
  );

  /* ---------------------------------------------------------------- */
  section("3. 查看委托订单（买入后）");

  const orders = await getOrders(accountId);
  check("委托视图返回 1 条", orders.length === 1, `count=${orders.length}`);
  const o = orders[0] as OrderInfo;
  const orderRow = await prisma.order.findUnique({
    where: { id: o.id },
    select: { id: true, quantity: true, status: true },
  });
  check("订单编号非空", typeof o.id === "string" && o.id.length > 0, o.id);
  check("订单编号即数据库主键（可在 orders 表命中）", orderRow !== null && orderRow.id === o.id);
  check("库表数量与视图一致", orderRow?.quantity === o.quantity && orderRow?.status === o.status);
  check("方向 = BUY", o.side === "BUY");
  check("市价单委托价为空", o.price === null, String(o.price));
  check("成交均价 = 买入日收盘价", near(o.filledPrice ?? 0, t.c1), String(o.filledPrice));
  check("数量 = 已成交数量 = 200", o.quantity === QTY && o.filledQty === QTY);
  check("状态 = FILLED", o.status === "FILLED");
  check("创建时间 = 买入日", o.orderTime === t.d1, o.orderTime);

  /* ---------------------------------------------------------------- */
  section("4. 查看成交记录（买入后）");

  const trades = await getTrades(accountId);
  check("成交视图返回 1 条", trades.length === 1, `count=${trades.length}`);
  const tr = trades[0] as TradeInfo;
  const tradeRow = await prisma.trade.findUnique({
    where: { id: tr.id },
    select: { orderId: true, amount: true, quantity: true },
  });
  check("成交价格 = 买入日收盘价", near(tr.price, t.c1), String(tr.price));
  check("成交数量 = 200", tr.quantity === QTY);
  check("成交金额 = 成交价格 × 数量", near(tr.amount, buyAmount), money(tr.amount));
  check("库表成交金额与视图一致", near(tradeRow?.amount ? Number(tradeRow.amount) : -1, tr.amount));
  check(
    "手续费 = 佣金 + 印花税 + 过户费（引擎口径）",
    near(tr.totalFee, round2(tr.commission + tr.stampTax + tr.transferFee)),
    `${money(tr.totalFee)} = ${tr.commission} + ${tr.stampTax} + ${tr.transferFee}`,
  );
  check("买入无印花税", tr.stampTax === 0);
  check("买入手续费 = calcFees 独立计算结果", near(tr.totalFee, buyFees.total), money(tr.totalFee));
  check("买入已实现盈亏 = 0", tr.realizedPnl === 0);
  check("成交时间 = 买入日", tr.tradedAt === t.d1, tr.tradedAt);
  check("成交可回溯到对应委托单", tradeRow?.orderId === o.id, tradeRow?.orderId);

  /* ---------------------------------------------------------------- */
  section("5. 账户资金恒等式（买入后）");

  const s1 = await getAccountSummary(accountId);
  const expectCash1 = round2(DEFAULT_INITIAL_CASH - (buyAmount + buyFees.total));
  check(
    "可用资金 = 初始资金 −（成交额 + 买入费用）",
    near(s1?.availableCash ?? 0, expectCash1),
    `${money(s1?.availableCash ?? 0)} 期望 ${money(expectCash1)}`,
  );
  check(
    "账户持仓市值 = 持仓视图市值之和",
    near(s1?.marketValue ?? 0, positions.reduce((a, x) => a + x.marketValue, 0)),
  );
  check("现金 = 可用资金 + 冻结资金", near(s1?.cash ?? 0, (s1?.availableCash ?? 0) + (s1?.frozenCash ?? 0)));
  check("总资产 = 现金 + 持仓市值", near(s1?.totalAsset ?? 0, round2((s1?.cash ?? 0) + (s1?.marketValue ?? 0))));
  check(
    "累计盈亏 = 总资产 − 初始资金",
    near(s1?.totalProfit ?? 0, round2((s1?.totalAsset ?? 0) - DEFAULT_INITIAL_CASH)),
  );
  check(
    "累计收益率 = 累计盈亏 / 初始资金 × 100",
    near(s1?.totalProfitRate ?? 0, round2(((s1?.totalProfit ?? 0) / DEFAULT_INITIAL_CASH) * 100)),
  );

  /* ---------------------------------------------------------------- */
  section("6. T+1 约束 → 结算 → 卖出");

  const blocked = await sellStock({
    accountId,
    stockCode: t.code,
    quantity: QTY,
    tradeDate: t.d2,
  });
  check(
    "买入当日卖出被 T+1 拒绝",
    !blocked.success && blocked.message.includes("可卖数量不足"),
    blocked.message,
  );

  const settlement = await resolveT1Settlement(accountId);
  check(
    "结算日 = 买入日之后的下一真实交易日",
    settlement?.asOfDate === t.dNext && settlement.isTradingDay === true,
    `asOfDate=${settlement?.asOfDate} 期望=${t.dNext}`,
  );

  const updated = await settleT1(accountId, settlement!.asOfDate);
  const posSettled = await getPositions(accountId);
  check(
    "结算后可卖数量 = 持仓数量",
    updated === 1 && posSettled[0].availableQty === QTY,
    `updated=${updated} availableQty=${posSettled[0].availableQty}`,
  );

  const sellRes = await sellStock({
    accountId,
    stockCode: t.code,
    quantity: QTY,
    tradeDate: t.d2,
  });
  check("结算后卖出成功", sellRes.success, sellRes.message);

  const sellAmount = round2(t.c2 * QTY);
  const sellFees = calcFees(sellAmount, "SELL");
  const expectedRealized = round2((t.c2 - avgCost6) * QTY - sellFees.total);

  /* ---------------------------------------------------------------- */
  section("7. 再次查看三者（卖出后）—— 数据是否同步");

  const positions2 = await getPositions(accountId);
  const orders2 = await getOrders(accountId);
  const trades2 = await getTrades(accountId);

  check("① 持仓：清仓后为空", positions2.length === 0, `count=${positions2.length}`);
  check(
    "② 委托：2 条，最新为卖出",
    orders2.length === 2 && orders2[0].side === "SELL" && orders2[1].side === "BUY",
    orders2.map((x) => x.side).join(","),
  );
  check(
    "③ 成交：2 条，最新为卖出",
    trades2.length === 2 && trades2[0].side === "SELL" && trades2[1].side === "BUY",
    trades2.map((x) => x.side).join(","),
  );
  check(
    "三视图数量同步：委托数 = 成交数（每笔委托全额成交）",
    orders2.length === trades2.length,
    `orders=${orders2.length} trades=${trades2.length}`,
  );
  check(
    "委托编号唯一",
    new Set(orders2.map((x) => x.id)).size === orders2.length,
  );

  const sellTrade = trades2[0];
  const sellOrder = orders2[0];
  check("卖出成交价 = 卖出日收盘价", near(sellTrade.price, t.c2), String(sellTrade.price));
  check("卖出成交金额 = 卖价 × 数量", near(sellTrade.amount, sellAmount), money(sellTrade.amount));
  check(
    "卖出已实现盈亏 =（卖价 − 成本均价）× 数量 − 卖出费用",
    near(sellTrade.realizedPnl, expectedRealized),
    `${money(sellTrade.realizedPnl)} 期望 ${money(expectedRealized)}`,
  );
  check(
    "卖出手续费 = 佣金 + 印花税 + 过户费（含千一印花税）",
    near(sellTrade.totalFee, sellFees.total) && sellTrade.stampTax > 0,
    `${money(sellTrade.totalFee)}（印花税 ${money(sellTrade.stampTax)}）`,
  );
  check("买入成交的已实现盈亏仍为 0", trades2[1].realizedPnl === 0);
  check(
    "卖出委托状态 FILLED 且成交均价 = 卖出价",
    sellOrder.status === "FILLED" && near(sellOrder.filledPrice ?? 0, t.c2),
  );
  check("卖出委托创建时间 = 卖出日", sellOrder.orderTime === t.d2);

  const s2 = await getAccountSummary(accountId);
  const expectCash2 = round2(
    DEFAULT_INITIAL_CASH - (buyAmount + buyFees.total) + (sellAmount - sellFees.total),
  );
  check(
    "资金同步：可用资金 = 初始资金 − 买入费用 − 卖出费用 + 买卖价差",
    near(s2?.availableCash ?? 0, expectCash2),
    `${money(s2?.availableCash ?? 0)} 期望 ${money(expectCash2)}`,
  );
  check("清仓后持仓市值 = 0", s2?.marketValue === 0);
  check("清仓后总资产 = 现金", near(s2?.totalAsset ?? 0, s2?.cash ?? 0));
  check(
    "清仓后累计盈亏 = 买入费用 + 卖出费用 + 已实现盈亏（与成交记录自洽）",
    near(s2?.totalProfit ?? 0, expectedRealized, 0.02),
    `${money(s2?.totalProfit ?? 0)} vs 已实现 ${money(expectedRealized)}`,
  );
  check(
    "累计收益率 = 累计盈亏 / 初始资金 × 100",
    near(s2?.totalProfitRate ?? 0, round2(((s2?.totalProfit ?? 0) / DEFAULT_INITIAL_CASH) * 100)),
  );

  section("8. DB 溯源（视图数据必须来自数据库）");

  check(
    "库中委托数 = 委托视图条数",
    (await prisma.order.count({ where: { accountId } })) === orders2.length,
  );
  check(
    "库中成交数 = 成交视图条数",
    (await prisma.trade.count({ where: { accountId } })) === trades2.length,
  );
  check(
    "库中持仓数 = 持仓视图条数",
    (await prisma.position.count({ where: { accountId, quantity: { gt: 0 } } })) ===
      positions2.length,
  );
  const dbTrades = await prisma.trade.findMany({
    where: { accountId },
    select: { id: true, orderId: true },
  });
  const orderIds = new Set(orders2.map((x) => x.id));
  check(
    "每笔成交都对应到一条委托",
    dbTrades.every((x) => orderIds.has(x.orderId)),
    `trades=${dbTrades.length}`,
  );

  section("9. 三视图 DTO 字段完整性");

  const posFields: (keyof PositionInfo)[] = [
    "id",
    "stockId",
    "stockCode",
    "stockName",
    "quantity",
    "availableQty",
    "avgCost",
    "lastPrice",
    "marketValue",
    "unrealizedPnl",
    "unrealizedPnlPercent",
    "todayPnl",
  ];
  const orderFields: (keyof OrderInfo)[] = [
    "id",
    "stockCode",
    "stockName",
    "side",
    "orderType",
    "price",
    "quantity",
    "filledQty",
    "filledPrice",
    "status",
    "orderTime",
  ];
  const tradeFields: (keyof TradeInfo)[] = [
    "id",
    "stockCode",
    "stockName",
    "side",
    "price",
    "quantity",
    "amount",
    "commission",
    "stampTax",
    "transferFee",
    "totalFee",
    "realizedPnl",
    "tradedAt",
  ];

  // 用「步骤 10」重新建仓后的持仓做样本（此时持仓为空，先建仓再校验）
  const rebuy = await buyStock({ accountId, stockCode: t.code, quantity: QTY });
  check("按最新交易日买入成功（用于字段完整性校验）", rebuy.success, rebuy.message);
  const samplePos = (await getPositions(accountId))[0];
  const sampleOrder = (await getOrders(accountId))[0];
  const sampleTrade = (await getTrades(accountId))[0];

  check(
    "持仓 DTO 全字段齐备",
    posFields.every((f) => isPresent(samplePos[f])),
    posFields.filter((f) => !isPresent(samplePos[f])).join(",") || "全部齐备",
  );
  check(
    "委托 DTO 全字段齐备（price / filledPrice 允许为 null）",
    orderFields.every((f) => isDefined(sampleOrder[f])),
    orderFields.filter((f) => !isDefined(sampleOrder[f])).join(",") || "全部齐备",
  );
  check(
    "成交 DTO 全字段齐备",
    tradeFields.every((f) => isPresent(sampleTrade[f])),
    tradeFields.filter((f) => !isPresent(sampleTrade[f])).join(",") || "全部齐备",
  );

  section("10. 今日盈亏「当日买入」分支");

  const rebuyAmount = round2(t.c2 * QTY);
  const rebuyFees = calcFees(rebuyAmount, "BUY");
  const todayBuyAvgCost = round6((rebuyAmount + rebuyFees.total) / QTY);
  check(
    "当日买入分支：今日盈亏 =（现价 − 当日买入成本价）× 数量",
    near(samplePos.todayPnl, round2((t.c2 - todayBuyAvgCost) * QTY)),
    `${money(samplePos.todayPnl)}`,
  );
  check(
    "当日买入分支：以收盘价买入时今日盈亏 ≈ −买入费用（不把买入前的当日涨跌算作收益）",
    near(samplePos.todayPnl, -rebuyFees.total, 0.02),
    `${money(samplePos.todayPnl)} vs −${rebuyFees.total}`,
  );
  const naive = round2((t.c2 - t.cPrev) * QTY);
  console.log(
    `  \x1b[90m· 对照：若误用「昨收」为基准会显示 ${money(naive)}，正确口径为 ${money(
      samplePos.todayPnl,
    )}\x1b[0m`,
  );

  /* ---------------------------------------------------------------- */
  await cleanup();

  console.log("\n" + "═".repeat(64));
  console.log(
    `\x1b[1m结果：\x1b[32m${passed} 通过\x1b[0m` +
      (failed > 0 ? `，\x1b[31m${failed} 失败\x1b[0m` : "，0 失败"),
  );
  if (failed > 0) {
    console.log("\x1b[31m失败项：\x1b[0m");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("═".repeat(64) + "\n");

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\n\x1b[31m测试异常终止：\x1b[0m", err);
  await prisma.$disconnect();
  process.exit(1);
});
