/**
 * testSimTradeV3Deadlock —— 底部操作区的「死胡同 / 一步换日」回归测试（SSR）
 *
 * 背景（为什么必须有这个测试）：
 *   用户报「收盘/结算后页面卡在当天，无法进入下一交易日」。
 *   服务端状态机经实测是正确的（`advanceSimTradeStage` 能从 DAY_SETTLED 正确换日），
 *   因此嫌疑落在**前端是否给了用户出口**。审查发现真实死锁：
 *
 *     CLOSE_ANIMATION 分支只渲染 `CloseAnimation`，其 `onDone` 写成
 *     `() => { if (!busy) onNext(); }`，而 `CloseAnimation` 的 useEffect 依赖是 `[]`，
 *     它只捕获**挂载那一刻**的 `onDone`（连同那一刻冻结的 `busy`）。
 *     进入 CLOSE_ANIMATION 的 `advanceStage()` 会先 setBusy(true) 再 setSnapshot()，
 *     若面板恰在 busy===true 时挂载 → 动画播完后 `onNext()` 被静默跳过，
 *     而该分支**没有任何其他按钮** → 页面永久停在当天。竞态导致「有时卡、有时不卡」。
 *
 * 本测试守住两条不变量（对**所有**自动推进会发生的面板）：
 *   A. 任何面板都必须存在**至少一个用户可点的按钮**（不得只有自动跳转、没有手动出口）；
 *   B. CLOSE / DAY_SETTLED 阶段必须提供「进入下一交易日」按钮（且 CLOSE 阶段直接显示结算卡，
 *      不应要求用户先额外点一次「结算今日」）。
 *
 * 运行：DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testSimTradeV3Deadlock.ts')"
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AccountInfo,
  KlineBar,
  SimTradeInfo,
  SimTradeSnapshot,
  SimTradeStage,
} from "@/types";
import { StageBanner, TradeActionBar } from "@/components/SimTradeClient";
import type { SimTradeTodayBar } from "@/types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const HISTORY: KlineBar[] = [
  { date: "2025-03-20", open: 10, high: 10.4, low: 9.9, close: 10.2, volume: 1000, amount: 10200 },
  { date: "2025-03-21", open: 10.2, high: 10.6, low: 10.1, close: 10.4, volume: 1100, amount: 11440 },
];

function makeTodayBar(over: Partial<SimTradeTodayBar> = {}): SimTradeTodayBar {
  return {
    date: "2025-03-24",
    open: 10.4,
    high: 10.6,
    low: 10.3,
    close: 10.5,
    volume: 300,
    amount: 3150,
    changePercent: 0.96,
    revealedBars: 3,
    finalized: false,
    source: "INTRADAY_30M",
    ...over,
  };
}

function makeSnapshot(over: Partial<SimTradeSnapshot> = {}): SimTradeSnapshot {
  const stage: SimTradeStage = over.stage ?? "OPEN";
  const closeRevealed =
    stage === "CLOSE_ANIMATION" || stage === "CLOSE" || stage === "CLOSE_CONFIRMED" || stage === "DAY_SETTLED";

  const session: SimTradeInfo = {
    id: "s1",
    name: "测试局",
    initialCash: 100000,
    startDate: "2025-03-20",
    endDate: "2025-04-18",
    currentDate: "2025-03-24",
    historyStart: "2024-12-01",
    status: "ACTIVE",
    totalDays: 22,
    dayIndex: 3,
    nextDate: "2025-03-25",
    prevDate: "2025-03-21",
    confirmedToday: closeRevealed,
    accountId: "a1",
    revealed: false,
    createdAt: "2025-03-20T00:00:00.000Z",
    stage,
    stageActionCompleted: false,
    remainingBuy: 2,
    remainingSell: 2,
    operationCount: 0,
    remainingOps: 8,
    intradayBarCount: stage === "OPEN" ? 3 : 8,
    maxRevealableBars: stage === "OPEN" ? 7 : 8,
    currentIntradayTime: stage === "OPEN" ? "10:30" : "15:00",
    pendingAction: null,
    pendingPercent: null,
    pool: "STOCK",
  };

  const summary: AccountInfo = {
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
  };

  return {
    session,
    summary,
    positionRatio: 10.4,
    position: null,
    history: HISTORY,
    benchmarks: [],
    openPrice: 10.4,
    prevClose: 10.4,
    todayBar: makeTodayBar(),
    todayClose: closeRevealed ? 10.5 : null,
    stage,
    stageFillPrice: stage === "OPEN" || stage === "CLOSE" ? 10.5 : null,
    fillPriceSource: "INTRADAY_30M",
    fillPriceTime: "10:30",
    stageActionCompleted: false,
    remainingBuy: 2,
    remainingSell: 2,
    operationCount: 0,
    remainingOps: 8,
    intradayBarCount: session.intradayBarCount,
    maxRevealableBars: session.maxRevealableBars,
    currentIntradayTime: session.currentIntradayTime,
    pendingAction: null,
    pendingPercent: null,
    tradable: stage === "OPEN" || stage === "CLOSE",
    lastAction: null,
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
    curve: [],
    metrics: {
      initialAsset: 100000,
      finalAsset: 100500,
      totalReturn: 0.5,
      annualReturn: 6,
      maxDrawdown: 0,
      maxDrawdownStart: null,
      maxDrawdownEnd: null,
      volatility: 0,
      sharpeRatio: 0,
      tradingDays: 3,
    },
    settlement: null,
    ...over,
  };
}

/** 渲染底部操作区，返回 SSR HTML */
/** 渲染阶段状态条（承载「可买 N 次 / 可卖 N 次」等配额显示，与 TradeActionBar 分离） */
function renderBanner(snap: SimTradeSnapshot): string {
  return renderToStaticMarkup(React.createElement(StageBanner, { snapshot: snap }));
}

function renderBar(snap: SimTradeSnapshot, busy = false): string {
  return renderToStaticMarkup(
    React.createElement(TradeActionBar, {
      snapshot: snap,
      busy,
      pending: null,
      onPick: () => {},
      onConfirm: () => {},
      onConfirmPending: () => {},
      onCancelPending: () => {},
      onCancel: () => {},
      onNext: () => {},
    }),
  );
}

/** 统计可点的 <button> 数量 */
function countButtons(html: string): number {
  return (html.match(/<button/g) ?? []).length;
}

/** 该文案的按钮是否 disabled */
function isDisabled(html: string, label: string): boolean {
  const re = new RegExp(`<button([^>]*)>\\s*${label}\\s*</button>`);
  const m = html.match(re);
  if (!m) return false;
  return /\sdisabled(=|"|'|\s|>)/.test(m[1]) || m[1].includes("disabled");
}

function hasButton(html: string, label: string): boolean {
  return new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`).test(html);
}

function main(): void {
  console.log("\n=== A. 不变量：任何阶段都必须有可点按钮（不得死胡同）===");
  const stages: SimTradeStage[] = [
    "OPEN",
    "OPEN_CONFIRMED",
    "CLOSE_ANIMATION",
    "CLOSE",
    "CLOSE_CONFIRMED",
    "DAY_SETTLED",
  ];
  for (const st of stages) {
    const html = renderBar(makeSnapshot({ stage: st }));
    check(`${st} 面板存在至少 1 个按钮【不得死胡同】`, countButtons(html) >= 1, `按钮数=${countButtons(html)}`);
  }

  console.log("\n=== B. CLOSE_ANIMATION 必须有手动兜底出口 ===");
  {
    const html = renderBar(makeSnapshot({ stage: "CLOSE_ANIMATION" }));
    check("CLOSE_ANIMATION 有可点按钮（自动跳转失败时的手动出口）", countButtons(html) >= 1, `按钮数=${countButtons(html)}`);
    check(
      "CLOSE_ANIMATION 含「进入收盘阶段」按钮",
      hasButton(html, "进入收盘阶段"),
      `HTML 片段=${html.slice(0, 200)}`,
    );
  }

  console.log("\n=== C. CLOSE 阶段应直接给出结算卡 + 进入下一交易日 ===");
  {
    const html = renderBar(makeSnapshot({ stage: "CLOSE" }));
    check("CLOSE 显示「今日结算」", html.includes("今日结算"), "");
    check("CLOSE 显示收盘价", html.includes("10.5"), "");
    check("CLOSE 含「进入下一交易日」按钮", hasButton(html, "进入下一交易日"), `按钮数=${countButtons(html)}`);
    check("CLOSE 不再要求先点「结算今日」", !hasButton(html, "结算今日"), "");
  }

  console.log("\n=== D. DAY_SETTLED 保持「进入下一交易日」 ===");
  {
    const html = renderBar(makeSnapshot({ stage: "DAY_SETTLED" }));
    check("DAY_SETTLED 含「进入下一交易日」", hasButton(html, "进入下一交易日"), "");
    check("DAY_SETTLED 显示结算卡", html.includes("今日结算"), "");
  }

  console.log("\n=== E. OPEN 阶段：操作额度用尽 → 按钮全禁用 ===");
  {
    /* 注（2026-09-24）：观望取消后，可消耗操作的只剩「买2+卖2」= 最多 4 次，
       总上限 8 在正常玩法下**已不可达**。本用例直接注入 `remainingOps: 0`
       构造该状态，验证「额度用尽」这条兜底分支仍能正确渲染与禁用按钮。 */
    const html = renderBar(
      makeSnapshot({ stage: "OPEN", remainingOps: 0, operationCount: 8, tradable: false }),
    );
    check("显示「今日操作次数已用完」", html.includes("今日操作次数已用完"), "");
    for (const label of ["买入", "卖出"]) {
      check(`${label} 按钮禁用`, isDisabled(html, label), "");
    }
    check("观望按钮已取消（不存在）", !html.includes("观望"), "");
  }

  console.log("\n=== F. 操作次数展示（只显示真正会用完的两项配额）===");
  {
    // 配额显示位于 StageBanner（而非 TradeActionBar），故此处渲染状态条。
    const html = renderBanner(makeSnapshot({ stage: "OPEN" }));
    // 注意：React SSR 会在相邻文本节点之间插入 <!-- --> 注释，因此不能用朴素 includes。
    // 2026-09-24：界面文案由「买入 已用/上限」改为正向的「可买 N 次 / 可卖 N 次」
    // （剩余次数对玩家更直观），此处断言同步到新文案。
    check("显示 可买 2 次", /可买[\s\S]{0,60}>\s*2\s*<[\s\S]{0,20}次/.test(html), `片段=${html.slice(-600)}`);
    check("显示 可卖 2 次", /可卖[\s\S]{0,60}>\s*2\s*<[\s\S]{0,20}次/.test(html), "");
    /* 2026-09-24：观望取消后总操作上限 8 永远够不到，按用户决定从界面隐藏该额度。 */
    check("不再显示总操作 x/8（避免展示够不到的额度）", !html.includes("/8") && !html.includes("今日操作"), "");
  }

  console.log("\n=== G. OPEN 阶段游标到上限(7) → 主按钮应为「看收盘」 ===");
  {
    const snap = makeSnapshot({ stage: "OPEN" });
    snap.session.intradayBarCount = 7;
    snap.intradayBarCount = 7;
    const html = renderBar(snap);
    check(
      "游标 7/7 时提供「看收盘」（而非只能继续点推进行情撞上限）",
      hasButton(html, "看收盘") || html.includes("看收盘"),
      `按钮数=${countButtons(html)}`,
    );
  }

  console.log("\n=== H. T+1：有持仓但可卖 0 → 卖出禁用 ===");
  {
    const snap = makeSnapshot({ stage: "OPEN" });
    snap.position = {
      quantity: 1000,
      availableQty: 0,
      todayQty: 1000,
      avgCost: 10,
      lastPrice: 10.5,
      prevClose: 10.4,
      marketValue: 10500,
      unrealizedPnl: 500,
      unrealizedPnlPercent: 5,
      todayPnl: 100,
    };
    const html = renderBar(snap);
    check("有持仓且可卖 0 时 卖出 按钮禁用【T+1】", isDisabled(html, "卖出"), "");
    check("有持仓且可卖 0 时 买入/加仓 仍可用", !isDisabled(html, "买入") || !isDisabled(html, "加仓"), "");
  }

  console.log("\n" + "=".repeat(64));
  console.log(`通过 ${passed} / 失败 ${failed}`);
  if (failures.length > 0) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log("=".repeat(64));
}

main();
