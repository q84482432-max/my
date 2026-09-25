/**
 * 模拟炒股 UI 规格测试 · V2（SSR 渲染，覆盖阶段状态机 / 双成交价 / 每日额度 / 防泄漏 / 回归守卫）
 *
 * 覆盖 V2 已确认 UI 规格的关键可渲染契约：
 *  1. TradeActionBar 按 stage 四态渲染：
 *     - OPEN / CLOSE（可交易）：买入 / 卖出（观望已于 2026-09-24 取消）+ 比例滑块 + 确认
 *     - OPEN_CONFIRMED：仅「查看今日收盘」
 *     - CLOSE_CONFIRMED / DAY_SETTLED：结算卡 +「进入下一交易日」（一步换日；末日为「结束本局并查看结算」）
 *  2. 每日额度：买入 ≤2 / 卖出 ≤2（开盘 + 收盘共享），额度用尽对应按钮禁用
 *  3. 双成交价：OPEN 阶段确认按钮文案「确认开盘阶段操作」，CLOSE 阶段「确认收盘阶段操作」
 *  4. 防泄漏：OPEN 阶段 todayClose === null，PriceBlock 不得出现「今日收盘」；
 *     CLOSE_ANIMATION 起才显示收盘价（且取服务端已揭示值，前端不自行推算未来）
 *  5. 回归守卫：不再有旧的 10/30/50/100 比例档位按钮；不再渲染大盘三卡（上证指数等）
 *  6. 紧凑布局：账户**紧凑单行**（需求十二）；持仓小字 text-[11px]；开盘价 text-3xl
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/testSimTradeUI.ts
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  DailyAssetInfo,
  KlineBar,
  SimTradeAction,
  SimTradeBenchmark,
  SimTradeDayRecord,
  SimTradeInfo,
  SimTradePosition,
  SimTradeSnapshot,
  SimTradeStage,
} from "@/types";
import {
  AccountSummary,
  CloseAnimation,
  OpenPriceBlock,
  PositionMini,
  PriceBlock,
  SimTradeBoard,
  StageBanner,
  TodaySettlementPanel,
  TradeActionBar,
} from "@/components/SimTradeClient";
import { formatMoney, formatNumber, formatPercent } from "@/lib/utils";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/** 从 SSR HTML 中按可见文案精确匹配某个按钮，返回其属性串（含 class）；不存在返回 null */
function buttonAttrs(html: string, label: string): string | null {
  const re = new RegExp(`<button([^>]*)>\\s*${label}\\s*</button>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

/** 按钮状态：absent / disabled / enabled（以真实 disabled="" 属性判定，避开 class 中的 disabled:） */
function buttonState(html: string, label: string): "disabled" | "enabled" | "absent" {
  const attrs = buttonAttrs(html, label);
  if (attrs === null) return "absent";
  return attrs.includes('disabled=""') ? "disabled" : "enabled";
}

/* ----------------------------- 数据工厂 ----------------------------- */

function makeSession(over: Partial<SimTradeInfo> = {}): SimTradeInfo {
  return {
    id: "s1",
    name: "猜股票",
    initialCash: 100000,
    startDate: "2024-01-01",
    endDate: "2024-02-01",
    currentDate: "2024-01-03",
    historyStart: "2023-10-01",
    status: "ACTIVE",
    totalDays: 22,
    dayIndex: 3,
    nextDate: "2024-01-04",
    prevDate: "2024-01-02",
    confirmedToday: false,
    accountId: "a1",
    revealed: false,
    createdAt: new Date().toISOString(),
    // ---- V2 阶段状态机字段 ----
    stage: "OPEN",
    stageActionCompleted: false,
    remainingBuy: 2,
    remainingSell: 2,
    // ---- V3：每日总操作计数（上限 8） ----
    operationCount: 0,
    remainingOps: 8,
    // ---- V3：30m 时间轴游标 ----
    intradayBarCount: 1,
    maxRevealableBars: 7,
    currentIntradayTime: "10:00",
    // ---- V3 确认模式：默认无待确认 ----
    pendingAction: null,
    pendingPercent: null,
    pool: "STOCK",
    ...over,
  };
}

function makePosition(over: Partial<SimTradePosition> = {}): SimTradePosition {
  return {
    quantity: 1000,
    availableQty: 1000,
    todayQty: 0,
    avgCost: 10,
    lastPrice: 10.5,
    prevClose: 10,
    marketValue: 10500,
    unrealizedPnl: 500,
    unrealizedPnlPercent: 5,
    todayPnl: 500,
    ...over,
  };
}

/**
 * 快照工厂：stage / tradable / 额度 默认由 session 推导，
 * 避免「session.stage 与 snapshot.stage 不一致」这种假通过。
 */
function makeSnapshot(over: Partial<SimTradeSnapshot> = {}): SimTradeSnapshot {
  const session = over.session ?? makeSession();
  const stage: SimTradeStage = over.stage ?? session.stage;

  const history: KlineBar[] = [
    { date: "2024-01-02", open: 9.8, high: 10.2, low: 9.7, close: 10, volume: 1, amount: 1 },
    { date: "2024-01-03", open: 10, high: 11, low: 9, close: 10.5, volume: 1, amount: 1 },
  ];
  const curve: DailyAssetInfo[] = [
    { date: "2024-01-02", cash: 90000, marketValue: 10000, totalAsset: 100000, totalPnl: 0, dailyReturn: 0, totalReturn: 0 },
    { date: "2024-01-03", cash: 90000, marketValue: 10500, totalAsset: 100500, totalPnl: 500, dailyReturn: 0.5, totalReturn: 0.5 },
  ];
  // 大盘参照数据仍在 DTO 中（API 兼容），但 V2 前端不再渲染任何指数卡片
  const benchmarks: SimTradeBenchmark[] = [
    { code: "sh000001", name: "上证指数", date: "2024-01-03", value: 3005, change: 25, changePercent: 0.84 },
    { code: "sz399001", name: "深证成指", date: "2024-01-03", value: 9600, change: 120, changePercent: 1.27 },
    { code: "sz399006", name: "创业板指", date: "2024-01-03", value: 1925, change: 30, changePercent: 1.58 },
  ];
  const lastAction: SimTradeDayRecord = {
    date: "2024-01-03",
    action: "BUY",
    fillCount: 0,
    fills: [],
    amount: 0,
    dailyPnl: 0,
    dailyReturn: 0,
  };

  const closeRevealed = stage === "CLOSE_ANIMATION" || stage === "CLOSE" || stage === "CLOSE_CONFIRMED" || stage === "DAY_SETTLED";
  const tradable = stage === "OPEN" || stage === "CLOSE";

  return {
    session,
    summary: {
      id: "a1",
      name: "账户",
      initialCash: 100000,
      cash: 90000,
      availableCash: 90000,
      frozenCash: 0,
      marketValue: 10500,
      totalAsset: 100500,
      totalProfit: 500,
      totalProfitRate: 0.5,
    },
    positionRatio: 9.45,
    position: makePosition(),
    history,
    benchmarks,
    openPrice: 10,
    // V3 新增契约字段（分时图 0 轴 / 当日动态日K）。
    // 夹具默认给最小合法值；需要断言动态日K的用例通过 makeSnapshot({ todayBar }) 覆盖。
    prevClose: 10,
    todayBar: null,
    todayClose: closeRevealed ? 10.5 : null,
    stage,
    stageFillPrice: stage === "OPEN" ? 10 : stage === "CLOSE" ? 10.5 : null,
    // V3：成交价来源（夹具按 30m 来源，便于断言）
    fillPriceSource: stage === "OPEN" || stage === "CLOSE" ? "INTRADAY_30M" : null,
    fillPriceTime: stage === "OPEN" ? "10:00" : stage === "CLOSE" ? "15:00" : null,
    stageActionCompleted: session.stageActionCompleted,
    remainingBuy: session.remainingBuy,
    remainingSell: session.remainingSell,
    operationCount: session.operationCount,
    remainingOps: session.remainingOps,
    intradayBarCount: session.intradayBarCount,
    maxRevealableBars: session.maxRevealableBars,
    currentIntradayTime: session.currentIntradayTime,
    pendingAction: session.pendingAction,
    pendingPercent: session.pendingPercent,
    tradable,
    lastAction,
    tradeCount: 0,
    /* 2026-09-24：成交明细与当日「做T」概览（图表买卖点 / 成本线用）。
       全部来自已发生的成交，不存在未来的买卖点。 */
    fills: [],
    todayTrades: {
      count: 0,
      buyCount: 0,
      sellCount: 0,
      buyAmount: 0,
      sellAmount: 0,
      hasBuy: false,
      hasSell: false,
      isDayTrade: false,
    },
    curve,
    metrics: {
      initialAsset: 100000,
      finalAsset: 100500,
      totalReturn: 0.5,
      annualReturn: 0,
      maxDrawdown: 0,
      maxDrawdownStart: null,
      maxDrawdownEnd: null,
      volatility: 0,
      sharpeRatio: 0,
      tradingDays: 2,
    },
    settlement: null,
    ...over,
  };
}

/** 渲染 TradeActionBar（减少样板） */
function renderBar(
  snapshot: SimTradeSnapshot,
  opts: {
    busy?: boolean;
    pending?: { action: SimTradeAction; percent: number } | null;
  } = {},
): string {
  return renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot,
      busy: opts.busy ?? false,
      pending: opts.pending ?? null,
      onPick: () => {},
      onConfirm: () => {},
      onConfirmPending: () => {},
      onCancelPending: () => {},
      onCancel: () => {},
      onNext: () => {},
      onNextDay: () => {},
    }),
  );
}

/* ------------------------------- 测试 ------------------------------- */

function testActionBarTradableStage(): void {
  console.log("\n[1] TradeActionBar · OPEN 阶段（可交易）：动作按钮 + 额度门控");

  // 空仓：仅买入可用
  const emptyHtml = renderBar(makeSnapshot({ position: null }));
  check("空仓：买入可用", buttonState(emptyHtml, "买入") === "enabled");
  check("空仓：卖出禁用", buttonState(emptyHtml, "卖出") === "disabled");
  // 需求十四：核心按钮只有 买入/卖出 —— 不再有独立的「加仓」按钮
  check("空仓：无独立『加仓』按钮（已合并为买入）", buttonAttrs(emptyHtml, "加仓") === null);
  /* 观望已于 2026-09-24 取消：玩家可直接推进 30 分钟 K 线且不消耗操作次数，
     二者功能等价。这里断言按钮**不再存在**（而不是「可用/禁用」）。 */
  check("观望按钮已取消（不存在）", buttonAttrs(emptyHtml, "观望") === null && !emptyHtml.includes("观望"));

  // 有仓且可卖>0：买入与卖出都可用
  const holdHtml = renderBar(makeSnapshot({ position: makePosition({ availableQty: 1000 }) }));
  check("有仓：买入仍可用（加仓也走它）", buttonState(holdHtml, "买入") === "enabled");
  check("有仓：无独立『加仓』按钮", buttonAttrs(holdHtml, "加仓") === null);
  check("有仓：卖出可用", buttonState(holdHtml, "卖出") === "enabled");
  check("有仓：观望按钮仍不存在", buttonAttrs(holdHtml, "观望") === null);

  // T+1：有仓但可卖=0（当日买入未解冻）
  const t1Html = renderBar(
    makeSnapshot({ position: makePosition({ quantity: 1000, availableQty: 0 }) }),
  );
  check("T+1：卖出禁用（可卖=0）", buttonState(t1Html, "卖出") === "disabled");
  check("T+1：买入仍可用", buttonState(t1Html, "买入") === "enabled");
  check("T+1：提示当日买入 T+1 后可卖", t1Html.includes("T+1"));

  // busy：所有动作禁用
  const busyHtml = renderBar(makeSnapshot({ position: null }), { busy: true });
  check("busy：买入禁用", buttonState(busyHtml, "买入") === "disabled");
  check("busy：卖出禁用", buttonState(busyHtml, "卖出") === "disabled");

  // 操作栏只展示两项真正会用完的配额，**不再展示总操作次数**
  check("操作栏显示「买入 X/2」", emptyHtml.includes("买入") && emptyHtml.includes("/2"));
  check("操作栏显示「卖出 X/2」", emptyHtml.includes("卖出") && emptyHtml.includes("/2"));
  check("操作栏不再展示总操作次数 X/8", !emptyHtml.includes("/8") && !emptyHtml.includes("今日操作"));

  // safe-area：移动端 fixed 容器带 env(safe-area-inset-bottom)
  check("操作区含 safe-area inset", emptyHtml.includes("env(safe-area-inset-bottom)"));
  check("操作区移动端 fixed / 桌面 static", emptyHtml.includes("md:static"));
}

function testDailyQuota(): void {
  console.log("\n[2] 每日额度（买 ≤2 / 卖 ≤2，开盘 + 收盘共享）");

  // 买入额度用尽：买入 / 加仓均禁用，卖出不受影响
  const noBuy = makeSnapshot({
    session: makeSession({ remainingBuy: 0 }),
    position: makePosition({ availableQty: 1000 }),
  });
  const noBuyHtml = renderBar(noBuy);
  check("买额用尽：买入禁用", buttonState(noBuyHtml, "买入") === "disabled");
  check("买额用尽：无独立『加仓』按钮", buttonAttrs(noBuyHtml, "加仓") === null);
  check("买额用尽：卖出仍可用", buttonState(noBuyHtml, "卖出") === "enabled");
  check("买额用尽：提示文案出现", noBuyHtml.includes("今日买入次数已用完"));

  // 卖出额度用尽：卖出禁用，买入/加仓不受影响
  const noSell = makeSnapshot({
    session: makeSession({ remainingSell: 0 }),
    position: null,
  });
  const noSellHtml = renderBar(noSell);
  check("卖额用尽：卖出禁用", buttonState(noSellHtml, "卖出") === "disabled");
  check("卖额用尽：买入仍可用", buttonState(noSellHtml, "买入") === "enabled");

  // 额度剩余 1 次时仍可用
  const oneLeft = makeSnapshot({
    session: makeSession({ remainingBuy: 1, remainingSell: 1 }),
    position: makePosition({ availableQty: 1000 }),
  });
  const oneLeftHtml = renderBar(oneLeft);
  check("剩 1 次买额：买入可用", buttonState(oneLeftHtml, "买入") === "enabled");
  check("剩 1 次卖额：卖出可用", buttonState(oneLeftHtml, "卖出") === "enabled");
}

function testTwoStepConfirm(): void {
  console.log("\n[3] 两阶段提交（选动作 → 确认成交）与双成交价文案");

  const selHtml = renderBar(makeSnapshot({ position: null }));
  check("未选动作：无『提交待确认开盘阶段操作』", buttonAttrs(selHtml, "提交待确认开盘阶段操作") === null);
  check("未选动作：无『取消』", buttonAttrs(selHtml, "取消") === null);
  // 滑块只在「已选动作」后出现，避免拖滑块隐式选中买入
  check("未选动作：不显示滑块（须先选动作）", !selHtml.includes('type="range"'));

  // OPEN 阶段已选动作 → 确认按钮带「开盘价」语义
  const pickOpen = renderBar(makeSnapshot({ position: null }), {
    pending: { action: "BUY", percent: 30 },
  });
  check("OPEN 已选动作：出现『提交待确认开盘阶段操作』（默认需要确认）",
    buttonAttrs(pickOpen, "提交待确认开盘阶段操作") !== null);
  check("OPEN 已选动作：出现执行方式开关", pickOpen.includes("执行方式") && pickOpen.includes("立即执行") && pickOpen.includes("需要确认"));
  check("OPEN 已选动作：出现『取消』", buttonAttrs(pickOpen, "取消") !== null);
  check("OPEN 已选动作：摘要『买入 · 30%』", pickOpen.includes("买入 · 30%"));
  check("OPEN 已选动作：标注按今日开盘价成交", pickOpen.includes("按今日开盘价成交"));
  check("OPEN 已选动作：滑块带当前值 30", /type="range"[^>]*value="30"/.test(pickOpen));

  // CLOSE 阶段已选动作 → 确认按钮带「收盘价」语义
  const pickClose = renderBar(
    makeSnapshot({
      session: makeSession({ stage: "CLOSE", stageActionCompleted: false, remainingBuy: 1 }),
      position: null,
    }),
    { pending: { action: "BUY", percent: 60 } },
  );
  check("CLOSE 已选动作：出现『提交待确认收盘阶段操作』",
    buttonAttrs(pickClose, "提交待确认收盘阶段操作") !== null);
  check("CLOSE 已选动作：标注按今日收盘价成交", pickClose.includes("按今日收盘价成交"));
  check("CLOSE 已选动作：不出现『提交待确认开盘阶段操作』", !pickClose.includes("提交待确认开盘阶段操作"));

  /* 观望已于 2026-09-24 取消，原「观望 pending」用例已无意义（无法再产生 HOLD pending）。
     改测「卖出待确认」—— 它同样走 pending 链路，且有百分比与滑块（覆盖与 BUY 互补的一侧）。 */
  const sellPending = renderBar(makeSnapshot({ position: makePosition({ availableQty: 1000 }) }), {
    pending: { action: "SELL", percent: 30 },
  });
  check("卖出 pending：摘要显示百分比 30%", sellPending.includes("30%"));
  check("卖出 pending：显示滑块", sellPending.includes('type="range"'));
  check("卖出 pending：出现确认按钮", buttonAttrs(sellPending, "提交待确认开盘阶段操作") !== null);
  check("观望 pending 已不存在（界面不再出现『观望』）", !sellPending.includes("观望"));
}

function testStageProgression(): void {
  console.log("\n[4] 阶段推进按钮（OPEN_CONFIRMED / CLOSE_CONFIRMED / DAY_SETTLED）");

  // OPEN_CONFIRMED：只能查看今日收盘
  const afterOpen = renderBar(
    makeSnapshot({
      session: makeSession({ stage: "OPEN_CONFIRMED", stageActionCompleted: true, remainingBuy: 1 }),
      position: null,
    }),
  );
  check("OPEN_CONFIRMED：出现『查看今日收盘』", buttonState(afterOpen, "查看今日收盘") === "enabled");
  check("OPEN_CONFIRMED：动作按钮（买入）消失", buttonState(afterOpen, "买入") === "absent");
  check("OPEN_CONFIRMED：无『进入下一交易日』", !afterOpen.includes("进入下一交易日"));
  check("OPEN_CONFIRMED：无确认按钮",
    !afterOpen.includes("确认开盘阶段操作") && !afterOpen.includes("提交待确认开盘阶段操作"));

  // CLOSE_CONFIRMED：先「结算今日」（这一步不换日）
  const afterClose = renderBar(
    makeSnapshot({
      session: makeSession({ stage: "CLOSE_CONFIRMED", stageActionCompleted: true, confirmedToday: true }),
      position: null,
    }),
  );
  // 需求十九：结算与换日合并为一次点击（原子接口 /next-day），不再有「结算今日」这一步
  check("CLOSE_CONFIRMED：直接给出『进入下一交易日』", buttonState(afterClose, "进入下一交易日") === "enabled");
  check(
    "CLOSE_CONFIRMED：不再出现『结算今日』（已合并为一步换日）",
    buttonAttrs(afterClose, "结算今日") === null,
  );
  check("CLOSE_CONFIRMED：动作按钮消失", buttonState(afterClose, "买入") === "absent");

  // DAY_SETTLED：才轮到「进入下一交易日」
  const settled = renderBar(
    makeSnapshot({
      session: makeSession({ stage: "DAY_SETTLED", stageActionCompleted: true, confirmedToday: true }),
      position: null,
    }),
  );
  check("DAY_SETTLED：出现『进入下一交易日』", buttonState(settled, "进入下一交易日") === "enabled");
  check("DAY_SETTLED：没有『结算今日』按钮", buttonAttrs(settled, "结算今日") === null);

  // 末日 DAY_SETTLED：结束本局
  const lastDay = renderBar(
    makeSnapshot({
      session: makeSession({
        stage: "DAY_SETTLED",
        stageActionCompleted: true,
        confirmedToday: true,
        dayIndex: 22,
        totalDays: 22,
        nextDate: null,
      }),
      position: null,
    }),
  );
  check("末日：出现『结束本局并查看结算』", buttonState(lastDay, "结束本局并查看结算") === "enabled");
  check(
    "末日：没有『进入下一交易日』按钮（已到日历末尾）",
    buttonAttrs(lastDay, "进入下一交易日") === null,
  );

  // CLOSE_ANIMATION：渲染收盘动画（自动推进，无手动按钮）
  const anim = renderBar(
    makeSnapshot({
      session: makeSession({ stage: "CLOSE_ANIMATION", stageActionCompleted: true }),
      position: null,
    }),
  );
  check("CLOSE_ANIMATION：渲染收盘动画", anim.includes("今日收盘价公布中"));
  check("CLOSE_ANIMATION：无动作按钮", buttonState(anim, "买入") === "absent");
}

function testStageBanner(): void {
  console.log("\n[5] StageBanner（阶段标签 / 成交价口径 / 剩余额度）");

  const openHtml = renderToStaticMarkup(
    React.createElement(StageBanner, { snapshot: makeSnapshot({ session: makeSession({ stage: "OPEN" }) }) }),
  );
  check("OPEN：显示『开盘阶段』", openHtml.includes("开盘阶段"));
  check("OPEN：提示按开盘价成交", openHtml.includes("按开盘价成交"));
  check("OPEN：显示今日可买 2 次", openHtml.includes("可买") && openHtml.includes("2"));
  check("OPEN：显示今日可卖 2 次", openHtml.includes("可卖"));
  /* 2026-09-24：观望取消后，可消耗操作的只剩「买2+卖2」= 最多 4 次，总上限 8 永远够不到，
     按用户决定**界面上隐藏总操作额度**，只展示会真正用完的两项配额。 */
  check("OPEN：不再显示总操作额度「操作剩 N/8」", !openHtml.includes("操作剩") && !openHtml.includes("/8"));
  check("OPEN：说明推进时间不消耗操作次数", openHtml.includes("推进时间不消耗操作次数"));

  const closeHtml = renderToStaticMarkup(
    React.createElement(StageBanner, {
      snapshot: makeSnapshot({
        session: makeSession({ stage: "CLOSE", remainingBuy: 1, remainingSell: 2 }),
      }),
    }),
  );
  check("CLOSE：显示『收盘阶段』", closeHtml.includes("收盘阶段"));
  check("CLOSE：提示按收盘价成交", closeHtml.includes("按收盘价成交"));
  check("CLOSE：额度回显 1（剩余买入）", closeHtml.includes("1"));

  const afterHtml = renderToStaticMarkup(
    React.createElement(StageBanner, {
      snapshot: makeSnapshot({
        session: makeSession({ stage: "OPEN_CONFIRMED", stageActionCompleted: true }),
      }),
    }),
  );
  check("OPEN_CONFIRMED：提示已操作可查看收盘", afterHtml.includes("开盘阶段已操作"));

  const animHtml = renderToStaticMarkup(
    React.createElement(StageBanner, {
      snapshot: makeSnapshot({ session: makeSession({ stage: "CLOSE_ANIMATION" }) }),
    }),
  );
  check("CLOSE_ANIMATION：提示收盘价公布中", animHtml.includes("收盘价公布中"));
}

function testNoLookahead(): void {
  console.log("\n[6] 行情块口径与防泄漏（2026-09-24 改版：大字价 + 涨跌 + 高/低/开）");

  /** 一根「已揭示 3 根」的当日动态K：开 10.00 / 高 10.80 / 低 9.90 / 现价 10.60 */
  const dynBar = {
    date: "2026-01-02",
    open: 10,
    high: 10.8,
    low: 9.9,
    close: 10.6,
    volume: 1234,
    amount: 13000,
    changePercent: 6,
    revealedBars: 3,
    finalized: false,
    source: "INTRADAY_30M" as const,
  };

  const openHtml = renderToStaticMarkup(
    React.createElement(PriceBlock, {
      snapshot: makeSnapshot({
        session: makeSession({ stage: "OPEN" }),
        todayBar: dynBar,
      }),
    }),
  );
  check("OPEN：显示「高」", openHtml.includes("高"), "");
  check("OPEN：显示「低」", openHtml.includes("低"), "");
  check("OPEN：显示「开」", openHtml.includes("开"), "");
  check("OPEN：高 = 10.80（动态K已揭示部分极值）", openHtml.includes(formatNumber(10.8)), "");
  check("OPEN：低 = 9.90", openHtml.includes(formatNumber(9.9)), "");
  check("OPEN：开 = 10.00", openHtml.includes(formatNumber(10)), "");
  check("OPEN：当前价 = 10.60（动态K close）", openHtml.includes(formatNumber(10.6)), "");
  check("OPEN：涨跌幅 = +6.00%", openHtml.includes(formatPercent(6)), "");
  check("OPEN：标注「盘中动态」避免误读为最终值", openHtml.includes("盘中动态"), "");
  check("OPEN：大字价用 30px 以上（主视觉）", /text-\[(30|36)px\]/.test(openHtml), "");

  /* ---- 右侧 高/低/开 的着色：必须逐项「与前收比较」（不是整块同色）----
   * 夹具 prevClose = 10，故：高 10.80 → 红；低 9.90 → 绿；开 10.00 → 灰（平盘）。
   * 这一段是必要的：若实现写成「整块用同一个涨跌色」，三种颜色只会出现一种，
   * 断言就能立刻发现 —— 肉眼看 11px 小字颜色并不可靠（实测我自己就看错了）。 */
  check("右栏：高 高于前收 → 红（text-stock-up）", openHtml.includes("text-stock-up"), "");
  check("右栏：低 低于前收 → 绿（text-stock-down）", openHtml.includes("text-stock-down"), "");
  check("右栏：开 等于前收 → 中性（text-stock-flat）", openHtml.includes("text-stock-flat"), "");

  /* ---- 关键正确性锁：涨跌基准必须是「前收」而非「开盘价」 ---- */
  // 夹具刻意让 开盘(10.40) ≠ 前收(10.00)：
  //   正确（前收基准）：(11.00 − 10.00)/10.00 = +10.00%
  //   错误（开盘基准）：(11.00 − 10.40)/10.40 = +5.77%
  const baseHtml = renderToStaticMarkup(
    React.createElement(PriceBlock, {
      snapshot: makeSnapshot({
        session: makeSession({ stage: "OPEN" }),
        prevClose: 10,
        openPrice: 10.4,
        todayBar: { ...dynBar, open: 10.4, close: 11, high: 11, low: 10.4, changePercent: 10 },
      }),
    }),
  );
  check("★ 涨跌幅以前收为基准 = +10.00%（不是相对开盘价的 +5.77%）", baseHtml.includes(formatPercent(10)) && !baseHtml.includes(formatPercent(5.77)), baseHtml.slice(0, 200));
  check("★ 涨跌额 = 现价 − 前收 = +1.00", baseHtml.includes(formatNumber(1)), "");

  /* ---- 涨跌配色：A股 涨红跌绿 ---- */
  const downHtml = renderToStaticMarkup(
    React.createElement(PriceBlock, {
      snapshot: makeSnapshot({
        session: makeSession({ stage: "OPEN" }),
        prevClose: 10,
        todayBar: { ...dynBar, open: 10, close: 9.2, high: 10, low: 9.2, changePercent: -8 },
      }),
    }),
  );
  check("下跌时大字价用 text-stock-down（跌绿）", downHtml.includes("text-stock-down"), "");
  check("上涨时大字价用 text-stock-up（涨红）", baseHtml.includes("text-stock-up"), "");

  // OPEN_CONFIRMED 阶段同理（todayClose 仍为 null，展示的是动态值）
  const confirmedHtml = renderToStaticMarkup(
    React.createElement(PriceBlock, {
      snapshot: makeSnapshot({
        session: makeSession({ stage: "OPEN_CONFIRMED", stageActionCompleted: true }),
        todayBar: dynBar,
      }),
    }),
  );
  check("OPEN_CONFIRMED：仍展示动态值而非收盘价", confirmedHtml.includes(formatNumber(10.6)), "");
  check(
    "OPEN_CONFIRMED：不出现当日收盘价 10.50",
    !confirmedHtml.includes(formatNumber(10.5)),
    "todayClose 此刻为 null，行情块不可能显示它",
  );

  // CLOSE_ANIMATION 起今日收盘定格 → todayBar 换成官方日K口径（finalized=true）
  const animHtml = renderToStaticMarkup(
    React.createElement(PriceBlock, {
      snapshot: makeSnapshot({
        session: makeSession({ stage: "CLOSE_ANIMATION" }),
        todayBar: { ...dynBar, close: 10.5, high: 10.5, low: 9.9, changePercent: 5, revealedBars: 8, finalized: true, source: "DAILY_K" },
      }),
    }),
  );
  check("CLOSE_ANIMATION：当前价 = 10.50（定格后的当日收盘）", animHtml.includes(formatNumber(10.5)), "");
  check("CLOSE_ANIMATION：涨跌幅 = +5.00%", animHtml.includes(formatPercent(5)), "");
  check("CLOSE_ANIMATION：不再显示「盘中动态」", !animHtml.includes("盘中动态"), "");

  // todayBar 缺失（30m 不可用的极端兜底）：高/低必须为 --，不得伪造为开盘价
  const noBarHtml = renderToStaticMarkup(
    React.createElement(PriceBlock, {
      snapshot: makeSnapshot({ session: makeSession({ stage: "OPEN" }), todayBar: null }),
    }),
  );
  check("todayBar 缺失时高/低显示 --（不伪造）", (noBarHtml.match(/--/g) ?? []).length >= 2, "");

  // 快照层：todayClose 在 OPEN / OPEN_CONFIRMED 必须为 null
  check("快照 OPEN：todayClose = null", makeSnapshot({ session: makeSession({ stage: "OPEN" }) }).todayClose === null);
  check(
    "快照 OPEN_CONFIRMED：todayClose = null",
    makeSnapshot({ session: makeSession({ stage: "OPEN_CONFIRMED" }) }).todayClose === null,
  );
  check(
    "快照 CLOSE_ANIMATION：todayClose = 10.5",
    makeSnapshot({ session: makeSession({ stage: "CLOSE_ANIMATION" }) }).todayClose === 10.5,
  );
  // 成交价口径
  check("快照 OPEN：stageFillPrice = 开盘价", makeSnapshot({ session: makeSession({ stage: "OPEN" }) }).stageFillPrice === 10);
  check(
    "快照 CLOSE：stageFillPrice = 收盘价",
    makeSnapshot({ session: makeSession({ stage: "CLOSE" }) }).stageFillPrice === 10.5,
  );
  check(
    "快照 OPEN_CONFIRMED：stageFillPrice = null（不可交易）",
    makeSnapshot({ session: makeSession({ stage: "OPEN_CONFIRMED" }) }).stageFillPrice === null,
  );
}

function testCloseAnimation(): void {
  console.log("\n[7] 收盘动画（开盘价滚动到收盘价）");

  const html = renderToStaticMarkup(
    React.createElement(CloseAnimation, { openPrice: 10, closePrice: 10.5, onDone: () => {} }),
  );
  check("动画：含『今日收盘价公布中』", html.includes("今日收盘价公布中"));
  check("动画：含进度条", html.includes("rounded-full"));
  check("动画：SSR 首帧显示开盘价 ¥10.00（未开始滚动）", html.includes(`¥${formatNumber(10)}`));
}

function testCompactLayout(): void {
  console.log("\n[8] 紧凑布局（账户两行 / 持仓小字 / 开盘价大字）");

  const acctHtml = renderToStaticMarkup(
    React.createElement(AccountSummary, { summary: makeSnapshot().summary, positionRatio: 9.45 }),
  );
  // 需求十二：账户信息收紧，**不得回到 grid-cols-2 的两行大卡片网格**。
  // 2026-09-24（按设计稿对齐）：由「标签·数值横排的单行」改为「一行 4 个紧凑卡片」
  // （标签在上、数值在下，层次更清晰），但**始终保持一行**，垂直占地只增加约 18px，
  // 仍满足「图表是主视觉、辅助信息收紧」的原始意图。
  check("账户：一行 4 列卡片（不使用 grid-cols-2 两行大网格）",
    acctHtml.includes("grid-cols-4") && !acctHtml.includes("grid-cols-2"));
  check("账户：卡片含量化截断（长数字不撑破窄列）", acctHtml.includes("truncate"));
  check("账户：含『总资产』", acctHtml.includes("总资产"));
  check("账户：含『收益』（非旧『收益率』）", acctHtml.includes("收益") && !acctHtml.includes("收益率"));
  check("账户：含『现金』", acctHtml.includes("现金"));
  check("账户：含『仓位』", acctHtml.includes("仓位"));

  const openHtml = renderToStaticMarkup(React.createElement(OpenPriceBlock, { openPrice: 12.34 }));
  check("今日开盘：含『今日开盘』标签", openHtml.includes("今日开盘"));
  check("今日开盘：最大字号 text-3xl", openHtml.includes("text-3xl"));
  check("今日开盘：显示价格 ¥12.34", openHtml.includes(`¥${formatNumber(12.34)}`));

  const posHtml = renderToStaticMarkup(React.createElement(PositionMini, { position: makePosition() }));
  check("持仓小字：含『持仓』", posHtml.includes("持仓"));
  check("持仓小字：含『可卖』", posHtml.includes("可卖"));
  check("持仓小字：含『浮盈』", posHtml.includes("浮盈"));
  check("持仓小字：字号 text-[11px]", posHtml.includes("text-[11px]"));

  const emptyPosHtml = renderToStaticMarkup(React.createElement(PositionMini, { position: null }));
  check("空仓：显示『当前空仓』", emptyPosHtml.includes("当前空仓"));

  // 2026-09-24（按设计稿对齐）：持仓行右侧新增迷你走势图。
  // 关键约束有两条，都必须锁住：
  //   ① 传入历史（>=2 个收盘价）时必须画出内联 SVG 折线；
  //   ② 不传历史时必须**什么都不画** —— 单点连不成线，画出来只会是一条
  //      误导性的水平线（看起来像「持平」），比不画更糟。
  const sparkHtml = renderToStaticMarkup(
    React.createElement(PositionMini, {
      position: makePosition(),
      history: makeSnapshot().history,
    }),
  );
  check("持仓：传入历史时渲染迷你走势图（内联 SVG polyline）",
    sparkHtml.includes("<svg") && sparkHtml.includes("polyline"));
  check("持仓：走势图按 A 股惯例着色（涨红跌绿，取自 --stock-up/--stock-down）",
    sparkHtml.includes("--stock-up") || sparkHtml.includes("--stock-down"));
  check("持仓：不传历史时不渲染走势图（避免单点伪水平线）",
    !posHtml.includes("polyline") && !posHtml.includes("<svg"));
}

function testTodaySettlementNoLookahead(): void {
  console.log("\n[9] 今日结算（取服务端已揭示 todayClose，禁止前瞻）");

  const snap = makeSnapshot({
    session: makeSession({
      stage: "CLOSE_CONFIRMED",
      stageActionCompleted: true,
      confirmedToday: true,
      currentDate: "2024-01-03",
      nextDate: "2024-01-04",
    }),
    lastAction: { date: "2024-01-03", action: "BUY", fillCount: 0, fills: [], amount: 0, dailyPnl: 0, dailyReturn: 0 },
  });
  const html = renderToStaticMarkup(React.createElement(TodaySettlementPanel, { snapshot: snap }));

  check("结算：含『今日收盘』", html.includes("今日收盘"));
  check("结算：含『涨跌』", html.includes("涨跌"));
  check("结算：含『操作』", html.includes("操作"));
  check("结算：含『当日盈亏』", html.includes("当日盈亏"));
  check("结算：含『总资产』", html.includes("总资产"));
  check("结算：含『下一日』", html.includes("下一日"));

  // 收盘取自已揭示的 todayClose = 10.5
  check(`结算：今日收盘 = ¥${formatNumber(10.5)}`, html.includes(`¥${formatNumber(10.5)}`));
  // 涨跌 = (10.5 - 10)/10 = +5.00%（对上一根已揭示 K 线收盘）
  check("结算：涨跌 = +5.00%", html.includes(formatPercent(5)));
  // 当日盈亏 = 100500 - 100000 = ¥500.00
  check("结算：当日盈亏 = ¥500.00", html.includes(formatMoney(500)));
  check("结算：总资产 = ¥100,500.00", html.includes(formatMoney(100500)));
  check("结算：下一日 = 2024-01-04", html.includes("2024-01-04"));

  // 最后一日：下一日显示「最后一日」
  const lastHtml = renderToStaticMarkup(
    React.createElement(TodaySettlementPanel, {
      snapshot: makeSnapshot({
        session: makeSession({
          stage: "CLOSE_CONFIRMED",
          confirmedToday: true,
          currentDate: "2024-01-03",
          nextDate: null,
          dayIndex: 22,
          totalDays: 22,
        }),
      }),
    }),
  );
  check("结算（末日）：下一日显示『最后一日』", lastHtml.includes("最后一日"));
}

function testBoardRegressionGuards(): void {
  console.log("\n[10] 回归守卫（旧比例档位按钮 / 大盘三卡 / 板块分区）");

  const barHtml = renderBar(makeSnapshot({ position: null }));
  const barPicked = renderBar(makeSnapshot({ position: null }), {
    pending: { action: "BUY", percent: 40 },
  });
  for (const [name, html] of [
    ["选择态", barHtml],
    ["确认态", barPicked],
  ] as const) {
    check(`${name}：不再有 10% 档位按钮`, buttonAttrs(html, "10%") === null);
    check(`${name}：不再有 30% 档位按钮`, buttonAttrs(html, "30%") === null);
    check(`${name}：不再有 50% 档位按钮`, buttonAttrs(html, "50%") === null);
    check(`${name}：不再有 100% 档位按钮`, buttonAttrs(html, "100%") === null);
    check(`${name}：不再出现旧文案『确认今日操作』`, !html.includes("确认今日操作"));
  }
  check("确认态：比例控件为滑块（range）", barPicked.includes('type="range"'));
  check("确认态：滑块带当前值 40", /type="range"[^>]*value="40"/.test(barPicked));
  check("选择态：不渲染比例控件（先选动作）", !barHtml.includes('type="range"'));

  // 对局面板：不再渲染大盘三卡
  const boardHtml = renderToStaticMarkup(
    React.createElement(SimTradeBoard, {
      snapshot: makeSnapshot({ session: makeSession({ stage: "OPEN" }) }),
      reveal: null,
      busy: false,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onConfirmPending: () => {},
      onCancelPending: () => {},
      onCancel: () => {},
      onNext: () => {},
      onNextDay: () => {},
      onTick: () => {},
      onReveal: () => {},
      onDelete: () => {},
    }),
  );
  check("面板：不出现『上证指数』", !boardHtml.includes("上证指数"));
  check("面板：不出现『深证成指』", !boardHtml.includes("深证成指"));
  check("面板：不出现『创业板指』", !boardHtml.includes("创业板指"));
  check("面板：含阶段状态条（开盘阶段）", boardHtml.includes("开盘阶段"));
  check("面板：含第 X/N 交易日进度", boardHtml.includes("交易日"));
  // 2026-09-24：行情块改版后不再有「今日开盘 / 今日收盘」标签，
  // 改为「大字当前价 + 涨跌 + 高/低/开」结构，这里断言新结构确实出现在面板里。
  check("面板：含『开』『高』『低』行情块", boardHtml.includes("开") && boardHtml.includes("高") && boardHtml.includes("低"));

  // CLOSE_CONFIRMED 面板：出现今日结算，且不再有指数卡
  const settledBoard = renderToStaticMarkup(
    React.createElement(SimTradeBoard, {
      snapshot: makeSnapshot({
        session: makeSession({
          stage: "CLOSE_CONFIRMED",
          stageActionCompleted: true,
          confirmedToday: true,
        }),
      }),
      reveal: null,
      busy: false,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onConfirmPending: () => {},
      onCancelPending: () => {},
      onCancel: () => {},
      onNext: () => {},
      onNextDay: () => {},
      onTick: () => {},
      onReveal: () => {},
      onDelete: () => {},
    }),
  );
  check("面板（收盘已操作）：出现今日结算", settledBoard.includes("今日结算"));
  check("面板（收盘已操作）：不出现『上证指数』", !settledBoard.includes("上证指数"));
}

function main(): void {
  console.log("=== 模拟炒股 UI 规格测试 · V2 ===");
  testActionBarTradableStage();
  testDailyQuota();
  testTwoStepConfirm();
  testStageProgression();
  testStageBanner();
  testNoLookahead();
  testCloseAnimation();
  testCompactLayout();
  testTodaySettlementNoLookahead();
  testBoardRegressionGuards();

  console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===`);
  if (failed > 0) process.exit(1);
}

main();
