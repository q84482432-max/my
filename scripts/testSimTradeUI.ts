/**
 * 模拟炒股 UI 规格测试（SSR 渲染，覆盖按钮状态 / 两阶段 / 紧凑布局 / 今日结算无前瞻）
 *
 * 覆盖用户已确认 UI 规格的关键可渲染契约：
 *  1. TradeActionBar 单一操作面板：观望 / 买入 / 加仓 / 卖出
 *     - 空仓：仅「买入」可用；「加仓」「卖出」禁用
 *     - 有仓：仅「加仓」可用；「买入」禁用；可卖>0 时「卖出」可用
 *     - T+1：有仓但可卖=0 时「卖出」禁用
 *     - 比例档位 10/30/50/100（HOLD=0），且不再有旧的 20% 档
 *  2. 两阶段：选择动作阶段无「确认今日操作」；已选 pending 后出现确认按钮
 *  3. 紧凑布局：账户总资产/收益/现金/仓位两行（grid-cols-2）；今日开盘最大字号（text-3xl）
 *  4. 今日结算（confirmedToday）：今日收盘/涨跌/操作/当日盈亏/总资产/下一日
 *     —— 收盘/涨跌取自「已揭示」history[currentDate]，禁止读取未来行情
 *
 * 运行：node -e "require('./runner.mjs').run('scripts/testSimTradeUI.ts')"
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  DailyAssetInfo,
  KlineBar,
  SimTradeAction,
  SimTradeDayRecord,
  SimTradeInfo,
  SimTradePosition,
  SimTradeSnapshot,
} from "@/types";
import {
  AccountSummary,
  OpenPriceBlock,
  PositionMini,
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

function makeSnapshot(over: Partial<SimTradeSnapshot> = {}): SimTradeSnapshot {
  const history: KlineBar[] = [
    { date: "2024-01-02", open: 9.8, high: 10.2, low: 9.7, close: 10, volume: 1, amount: 1 },
    { date: "2024-01-03", open: 10, high: 11, low: 9, close: 10.5, volume: 1, amount: 1 },
  ];
  const curve: DailyAssetInfo[] = [
    { date: "2024-01-02", cash: 90000, marketValue: 10000, totalAsset: 100000, totalPnl: 0, dailyReturn: 0, totalReturn: 0 },
    { date: "2024-01-03", cash: 90000, marketValue: 10500, totalAsset: 100500, totalPnl: 500, dailyReturn: 0.5, totalReturn: 0.5 },
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
  return {
    session: makeSession(),
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
    openPrice: 10,
    tradable: true,
    lastAction,
    tradeCount: 0,
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

/* ------------------------------- 测试 ------------------------------- */

function testActionBarButtonStates(): void {
  console.log("\n[1] TradeActionBar 按钮状态（空仓 / 有仓 / T+1）");

  // 空仓：仅买入可用
  const emptyHtml = renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot: makeSnapshot({ position: null, tradable: true }),
      busy: false,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      onNext: () => {},
    }),
  );
  check("空仓：买入可用", buttonState(emptyHtml, "买入") === "enabled");
  check("空仓：加仓禁用", buttonState(emptyHtml, "加仓") === "disabled");
  check("空仓：卖出禁用", buttonState(emptyHtml, "卖出") === "disabled");
  check("空仓：观望可用", buttonState(emptyHtml, "观望") === "enabled");

  // 有仓且可卖>0：仅加仓可用
  const holdHtml = renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot: makeSnapshot({ position: makePosition({ availableQty: 1000 }), tradable: true }),
      busy: false,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      onNext: () => {},
    }),
  );
  check("有仓：买入禁用", buttonState(holdHtml, "买入") === "disabled");
  check("有仓：加仓可用", buttonState(holdHtml, "加仓") === "enabled");
  check("有仓：卖出可用", buttonState(holdHtml, "卖出") === "enabled");
  check("有仓：观望可用", buttonState(holdHtml, "观望") === "enabled");

  // T+1：有仓但可卖=0（当日买入未解冻）
  const t1Html = renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot: makeSnapshot({ position: makePosition({ quantity: 1000, availableQty: 0 }), tradable: true }),
      busy: false,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      onNext: () => {},
    }),
  );
  check("T+1：卖出禁用（可卖=0）", buttonState(t1Html, "卖出") === "disabled");
  check("T+1：加仓仍可用", buttonState(t1Html, "加仓") === "enabled");

  // busy：所有动作禁用
  const busyHtml = renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot: makeSnapshot({ position: null, tradable: true }),
      busy: true,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      onNext: () => {},
    }),
  );
  check("busy：买入禁用", buttonState(busyHtml, "买入") === "disabled");
  check("busy：观望禁用", buttonState(busyHtml, "观望") === "disabled");

  // 比例档位 10/30/50/100，且旧的 20% 档已移除（回归守卫：旧实现有 20%）
  check("比例档位含 10%", buttonState(emptyHtml, "10%") === "enabled");
  check("比例档位含 30%", buttonState(emptyHtml, "30%") === "enabled");
  check("比例档位含 50%", buttonState(emptyHtml, "50%") === "enabled");
  check("比例档位含 100%", buttonState(emptyHtml, "100%") === "enabled");
  check("比例档位不再含 20%（旧规格已弃用）", !/>20%<\/button>/.test(emptyHtml));

  // safe-area：移动端 fixed 容器带 env(safe-area-inset-bottom)
  check("操作区含 safe-area inset", emptyHtml.includes("env(safe-area-inset-bottom)"));
  check("操作区移动端 fixed / 桌面 static", emptyHtml.includes("md:static"));
}

function testTwoPhase(): void {
  console.log("\n[2] 两阶段（选择动作 → 确认成交）");

  // 阶段一：pending=null → 仅有动作/比例选择，无「确认今日操作」按钮（提示文案不算）
  const selHtml = renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot: makeSnapshot({ position: null, tradable: true }),
      busy: false,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      onNext: () => {},
    }),
  );
  check("阶段一：无『确认今日操作』按钮", buttonAttrs(selHtml, "确认今日操作") === null);
  check("阶段一：无『取消』按钮", buttonAttrs(selHtml, "取消") === null);

  // 已选动作：pending={BUY,30} → 出现确认/取消，且摘要显示「买入 · 30%」
  const pickHtml = renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot: makeSnapshot({ position: null, tradable: true }),
      busy: false,
      pending: { action: "BUY" as SimTradeAction, percent: 30 },
      onPick: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      onNext: () => {},
    }),
  );
  check("已选动作：出现『确认今日操作』", buttonAttrs(pickHtml, "确认今日操作") !== null);
  check("已选动作：出现『取消』", buttonAttrs(pickHtml, "取消") !== null);
  check("已选动作：摘要显示『买入 · 30%』", pickHtml.includes("买入 · 30%"));

  // confirmedToday：仅出现「进入下一交易日」，无动作按钮
  const nextHtml = renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot: makeSnapshot({ position: null, tradable: false, session: makeSession({ confirmedToday: true }) }),
      busy: false,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      onNext: () => {},
    }),
  );
  check("已结算：出现『进入下一交易日』", nextHtml.includes("进入下一交易日"));
  check("已结算：动作按钮（买入）消失", buttonState(nextHtml, "买入") === "absent");
  check("已结算：无『确认今日操作』", !nextHtml.includes("确认今日操作"));
}

function testCompactLayout(): void {
  console.log("\n[3] 紧凑布局（账户两行 / 今日开盘最大字号 / 持仓小字）");

  const acctHtml = renderToStaticMarkup(
    React.createElement(AccountSummary, {
      summary: makeSnapshot().summary,
      positionRatio: 9.45,
    }),
  );
  check("账户：两行布局 grid-cols-2", acctHtml.includes("grid-cols-2"));
  check("账户：含『总资产』", acctHtml.includes("总资产"));
  check("账户：含『收益』（非旧『收益率』）", acctHtml.includes("收益") && !acctHtml.includes("收益率"));
  check("账户：含『现金』", acctHtml.includes("现金"));
  check("账户：含『仓位』", acctHtml.includes("仓位"));

  const openHtml = renderToStaticMarkup(React.createElement(OpenPriceBlock, { openPrice: 12.34 }));
  check("今日开盘：含『今日开盘』标签", openHtml.includes("今日开盘"));
  check("今日开盘：最大字号 text-3xl", openHtml.includes("text-3xl"));
  check("今日开盘：显示价格 ¥12.34", openHtml.includes(`¥${formatNumber(12.34)}`));

  const posHtml = renderToStaticMarkup(
    React.createElement(PositionMini, { position: makePosition() }),
  );
  check("持仓小字：含『持仓』", posHtml.includes("持仓"));
  check("持仓小字：含『可卖』", posHtml.includes("可卖"));
  check("持仓小字：含『浮盈』", posHtml.includes("浮盈"));
  check("持仓小字：字号 text-[11px]", posHtml.includes("text-[11px]"));

  const emptyPosHtml = renderToStaticMarkup(
    React.createElement(PositionMini, { position: null }),
  );
  check("空仓：显示『当前空仓』", emptyPosHtml.includes("当前空仓"));
}

function testTodaySettlementNoLookahead(): void {
  console.log("\n[4] 今日结算（confirmedToday，收盘/涨跌取自已揭示 history，禁止前瞻）");

  const snap = makeSnapshot({
    session: makeSession({ confirmedToday: true, currentDate: "2024-01-03", nextDate: "2024-01-04" }),
    lastAction: { date: "2024-01-03", action: "BUY", fillCount: 0, fills: [], amount: 0, dailyPnl: 0, dailyReturn: 0 },
  });
  const html = renderToStaticMarkup(React.createElement(TodaySettlementPanel, { snapshot: snap }));

  check("结算：含『今日收盘』", html.includes("今日收盘"));
  check("结算：含『涨跌』", html.includes("涨跌"));
  check("结算：含『操作』", html.includes("操作"));
  check("结算：含『当日盈亏』", html.includes("当日盈亏"));
  check("结算：含『总资产』", html.includes("总资产"));
  check("结算：含『下一日』", html.includes("下一日"));

  // 收盘取自 history[currentDate].close = 10.5（已揭示），非未来
  const closeText = `¥${formatNumber(10.5)}`;
  check(`结算：今日收盘 = ${closeText}（来自已揭示 history）`, html.includes(closeText));
  // 涨跌 = (10.5 - 10)/10 = +5.00%
  check("结算：涨跌 = +5.00%（来自 history 上根收盘）", html.includes(formatPercent(5)));
  // 当日盈亏沿用原计算：cur.totalAsset(100500) - prev.totalAsset(100000) = ¥500.00
  check("结算：当日盈亏 = ¥500.00（原 dailyPnl 口径）", html.includes(formatMoney(500)));
  // 总资产 = 100500
  check("结算：总资产 = ¥100,500.00", html.includes(formatMoney(100500)));
  // 下一日 = 2024-01-04
  check("结算：下一日 = 2024-01-04", html.includes("2024-01-04"));

  // 最后一日：下一日显示「最后一日」
  const lastHtml = renderToStaticMarkup(
    React.createElement(TodaySettlementPanel, {
      snapshot: makeSnapshot({
        session: makeSession({ confirmedToday: true, currentDate: "2024-01-03", nextDate: null, dayIndex: 22, totalDays: 22 }),
      }),
    }),
  );
  check("结算（末日）：下一日显示『最后一日』", lastHtml.includes("最后一日"));
}

function main(): void {
  console.log("=== 模拟炒股 UI 规格测试 ===");
  testActionBarButtonStates();
  testTwoPhase();
  testCompactLayout();
  testTodaySettlementNoLookahead();

  console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===`);
  if (failed > 0) process.exit(1);
}

main();
