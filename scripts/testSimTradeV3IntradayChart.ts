/**
 * testSimTradeV3IntradayChart —— 分时图与双 Tab 的图表层验收（SSR + 纯函数）
 *
 * 覆盖用户指定的：
 *   测试5（未来数据泄露）：分时图**不得**含未揭示时点；日K 不得泄露全天成交量
 *   测试2（Tab 切换）：默认 Tab 必须是「分时图」；日K 分支可渲染
 *
 * 本文件测的是**图表层**：
 *   - `alignTicksToAxis` / `buildIntradayOption`（纯函数，可直接断言数据数组）
 *   - `ChartTabs`（SSR 渲染，断言默认 Tab 与分支内容）
 *
 * 运行：DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testSimTradeV3IntradayChart.ts')"
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AccountInfo,
  KlineBar,
  SimTradeInfo,
  SimTradeIntradayInfo,
  SimTradeIntradayTick,
  SimTradeSnapshot,
  SimTradeStage,
  SimTradeTodayBar,
} from "@/types";
import {
  alignTicksToAxis,
  buildIntradayOption,
  splitBySign,
} from "@/components/charts/IntradayLineChart";
import { CHART } from "@/lib/chartPalette";
import { buildKlineOption } from "@/lib/klineChartOption";
import { ChartTabs } from "@/components/SimTradeClient";

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
const near = (a: number | null | undefined, b: number, tol = 1e-3) =>
  a !== null && a !== undefined && Math.abs(a - b) <= tol;

/* ---------------- 夹具 ---------------- */

/** 横轴 9 个刻度（与服务端 INTRADAY_AXIS_TIMES 一致） */
const TIMES = ["09:30", "10:00", "10:30", "11:00", "11:30", "13:30", "14:00", "14:30", "15:00"];

const PREV_CLOSE = 10.0;

/** 造 N 个已揭示分时点（含 09:30 锚点），价格按给定序列 */
function makeTicks(prices: number[]): SimTradeIntradayTick[] {
  const times = TIMES.slice(0, prices.length);
  return times.map((time, i) => ({
    time,
    price: prices[i],
    changePercent: +(((prices[i] - PREV_CLOSE) / PREV_CLOSE) * 100).toFixed(2),
    volume: time === "09:30" ? 0 : 100 * (i + 1),
  }));
}

function makeIntraday(ticks: SimTradeIntradayTick[]): SimTradeIntradayInfo {
  const revealedBars = Math.max(0, ticks.length - 1);
  return {
    mode: "session",
    sessionId: "s1",
    date: "2025-03-24",
    stage: "OPEN",
    barCount: revealedBars,
    expectedBars: 8,
    revealClose: false,
    intradayBarCount: Math.max(1, revealedBars),
    fullDayRevealed: false,
    bars: [],
    excludedByContamination: false,
    contaminatedDatesInSession: [],
    intradayAvailable: ticks.length > 0,
    prevClose: PREV_CLOSE,
    ticks,
    times: TIMES,
    cumVolume: ticks.reduce((s, t) => s + t.volume, 0),
    currentPrice: ticks.length > 0 ? ticks[ticks.length - 1].price : null,
    currentChangePercent: ticks.length > 0 ? ticks[ticks.length - 1].changePercent : null,
  };
}

function makeTodayBar(over: Partial<SimTradeTodayBar> = {}): SimTradeTodayBar {
  return {
    date: "2025-03-24",
    open: 10.1,
    high: 10.3,
    low: 10.0,
    close: 10.2,
    volume: 1234,
    amount: 12586.8,
    changePercent: 2,
    revealedBars: 3,
    finalized: false,
    source: "INTRADAY_30M",
    ...over,
  };
}

function makeSnapshot(over: Partial<SimTradeSnapshot> = {}): SimTradeSnapshot {
  const stage: SimTradeStage = over.stage ?? "OPEN";
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
    confirmedToday: false,
    accountId: "a1",
    revealed: false,
    createdAt: "2025-03-20T00:00:00.000Z",
    stage,
    stageActionCompleted: false,
    remainingBuy: 2,
    remainingSell: 2,
    operationCount: 3,
    remainingOps: 5,
    intradayBarCount: 3,
    maxRevealableBars: 7,
    currentIntradayTime: "10:30",
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
  const history: KlineBar[] = [
    { date: "2025-03-21", open: 9.9, high: 10.1, low: 9.8, close: 10.0, volume: 900, amount: 9000 },
    { date: "2025-03-24", open: 10.1, high: 10.3, low: 10.0, close: 10.2, volume: 1234, amount: 12586.8 },
  ];
  return {
    session,
    summary,
    positionRatio: 10.4,
    position: null,
    history,
    benchmarks: [],
    openPrice: 10.1,
    prevClose: PREV_CLOSE,
    todayBar: makeTodayBar(),
    todayClose: null,
    stage,
    stageFillPrice: 10.2,
    fillPriceSource: "INTRADAY_30M",
    fillPriceTime: "10:30",
    stageActionCompleted: false,
    remainingBuy: 2,
    remainingSell: 2,
    operationCount: 3,
    remainingOps: 5,
    intradayBarCount: 3,
    maxRevealableBars: 7,
    currentIntradayTime: "10:30",
    pendingAction: null,
    pendingPercent: null,
    tradable: true,
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

function renderTabs(over: {
  snapshot?: SimTradeSnapshot;
  intraday?: SimTradeIntradayInfo | null;
  initialTab?: "intraday" | "daily";
}): string {
  return renderToStaticMarkup(
    React.createElement(ChartTabs, {
      snapshot: over.snapshot ?? makeSnapshot(),
      intraday: over.intraday === undefined ? makeIntraday(makeTicks([10.0, 10.1, 10.2])) : over.intraday,
      maxRevealableBars: 7,
      currentTime: "10:30",
      canTick: true,
      busy: false,
      onTick: () => {},
      initialTab: over.initialTab,
    }),
  );
}

/* ---------------- 测试 ---------------- */

function main(): void {
  console.log("\n=== A. alignTicksToAxis：未揭示时点必须为 null（防泄露核心）===");
  {
    // 只揭示 3 个点（09:30 / 10:00 / 10:30）—— 对应游标 2 根
    const ticks = makeTicks([10.0, 10.1, 10.2]);
    const { base, pctData, volData, revealedPoints } = alignTicksToAxis({
      ticks,
      times: TIMES,
      prevClose: PREV_CLOSE,
    });

    check("0 轴基准 == prevClose", near(base, PREV_CLOSE), `实际=${base}`);
    check("数组长度 == 横轴刻度数(9)", pctData.length === 9 && volData.length === 9, `pct=${pctData.length} vol=${volData.length}`);
    check("已揭示点数 == ticks 数(3)", revealedPoints === 3, `实际=${revealedPoints}`);

    // 关键断言：索引 0..2 有值，3..8 必须为 null
    check("idx0-2 有值（已揭示）", pctData.slice(0, 3).every((v) => v !== null), `实际=${JSON.stringify(pctData)}`);
    check(
      "idx3-8 必须为 null【防泄露：不得出现未来时点】",
      pctData.slice(3).every((v) => v === null),
      `实际=${JSON.stringify(pctData)}`,
    );
    check(
      "未来成交量必须为 null【防泄露】",
      volData.slice(3).every((v) => v === null),
      `实际=${JSON.stringify(volData)}`,
    );

    // 涨跌幅口径：(price - prevClose)/prevClose*100
    check("pct[0] == 0（09:30 价 == 前收）", near(pctData[0], 0), `实际=${pctData[0]}`);
    check("pct[1] == +1.00", near(pctData[1], 1.0), `实际=${pctData[1]}`);
    check("pct[2] == +2.00", near(pctData[2], 2.0), `实际=${pctData[2]}`);
  }

  console.log("\n=== B. 不同揭示进度下都不泄露未来 ===");
  {
    for (const n of [1, 2, 4, 5, 8, 9]) {
      const prices = Array.from({ length: n }, (_, i) => 10 + i * 0.05);
      const ticks = makeTicks(prices);
      const { pctData } = alignTicksToAxis({ ticks, times: TIMES, prevClose: PREV_CLOSE });
      const nonNull = pctData.filter((v) => v !== null).length;
      check(
        `揭示 ${n} 点：非空值数 == ${n}，其余为 null`,
        nonNull === n && pctData.slice(n).every((v) => v === null),
        `非空=${nonNull} 数组=${JSON.stringify(pctData)}`,
      );
    }
  }

  console.log("\n=== C. prevClose 缺失时不伪造基准 ===");
  {
    const ticks = makeTicks([8, 8.2]);
    const { base, pctData } = alignTicksToAxis({ ticks, times: TIMES, prevClose: null });
    check("退化基准 = 首个已揭示点价格", near(base, 8), `实际=${base}`);
    check("此时首点涨跌幅 = 0", near(pctData[0], 0), `实际=${pctData[0]}`);
    check("仍不泄露未来", pctData.slice(2).every((v) => v === null), "");
  }

  console.log("\n=== D. buildIntradayOption：0 轴与横轴结构 ===");
  {
    const ticks = makeTicks([10.0, 10.1, 10.2]);
    const opt = buildIntradayOption({ ticks, times: TIMES, prevClose: PREV_CLOSE, height: 260 }) as unknown as {
      xAxis: { data: string[] }[];
      yAxis: { min?: number; max?: number; axisLabel?: { customValues?: unknown } }[];
      series: { type: string; name?: string; data: unknown; lineStyle?: { color?: string } }[];
      visualMap?: unknown;
    };
    check("xAxis[0].data == times(9)", opt.xAxis[0].data.length === 9, `实际=${opt.xAxis[0].data.length}`);
    check("xAxis[1].data == times(9)", opt.xAxis[1].data.length === 9, "");
    check("y 轴对称（min == -max）", opt.yAxis[0].min === -(opt.yAxis[0].max ?? 0), `min=${opt.yAxis[0].min} max=${opt.yAxis[0].max}`);
    check("0 轴包含在范围内", (opt.yAxis[0].min ?? 0) <= 0 && (opt.yAxis[0].max ?? 0) >= 0, "");
    check("涨侧为折线 series", opt.series[0].type === "line", `实际=${opt.series[0].type}`);
    check("跌侧为折线 series", opt.series[1].type === "line", `实际=${opt.series[1].type}`);
    /* 2026-09-24：B/S 买卖点是**附加图层**，会让其后 series 的下标整体后移，
       因此这里不再按固定下标断言，改为**按 name 查找** —— 与位置解耦，
       以后再加图层也不会误伤这条断言。 */
    check(
      "存在成交量柱 series（bar）",
      opt.series.some((s) => s.name === "成交量" && s.type === "bar"),
      `series=${opt.series.map((s) => `${s.name ?? "?"}:${s.type}`).join(",")}`,
    );
    check(
      "涨侧线色 == CHART.up（A股涨红）",
      opt.series[0].lineStyle?.color === CHART.up,
      `实际=${opt.series[0].lineStyle?.color} 期望=${CHART.up}`,
    );
    check(
      "跌侧线色 == CHART.down（A股跌绿）",
      opt.series[1].lineStyle?.color === CHART.down,
      `实际=${opt.series[1].lineStyle?.color} 期望=${CHART.down}`,
    );
    check(
      "涨/跌序列等长且尾部为 null【防泄露】",
      (opt.series[0].data as unknown[]).length === 9 &&
        (opt.series[1].data as unknown[]).length === 9 &&
        (opt.series[0].data as unknown[]).slice(3).every((v) => v === null) &&
        (opt.series[1].data as unknown[]).slice(3).every((v) => v === null),
      "",
    );

    /* ---- 回归锁（2026-09-23 实测到的两个真实缺陷）---- */
    // 缺陷 1：曾用「单线 + visualMap 按值着色」。实测在 category 轴 + 二维数据下
    //         **visualMap 完全不生效且不报错**，价格线退化为固定红色，
    //         表现为「当日下跌 1.04% 却是红线」（A股应为绿）。
    //         现改为两条固定颜色 series（见 splitBySign），因此**必须没有 visualMap**。
    check("不使用 visualMap（实测其在此配置下不生效）", opt.visualMap === undefined, `实际=${JSON.stringify(opt.visualMap)}`);

    // 缺陷 2：y 轴 axisLabel 曾写 customValues:[0]。该选项语义是「**只显示**这些值」，
    //         导致涨跌幅刻度全部消失、只剩一个 0.00% 标签。
    const y0 = opt.yAxis[0];
    check(
      "y 轴不设 customValues（否则只剩 0.00% 一个刻度）",
      y0.axisLabel?.customValues === undefined,
      `实际=${JSON.stringify(y0.axisLabel?.customValues)}`,
    );
  }

  console.log("\n=== D2. splitBySign：按线段拆色（不伪造点、不画双线）===");
  {
    /* ============================================================
       回归锁 A：用户线上反馈「为啥有两条分时线」的真实案例
       前收 18.84，仅揭示 2 个点：09:30 = +0.37%、10:00 = −0.11%
       旧实现补 0 → up=[+0.37, 0]、down=[0, −0.11]，同一段 x 上画了两条线，
       且把 09:30 真实值 +0.37% 伪造成 0.00%。
       ============================================================ */
    const USER_CASE = [0.3715, -0.1062];
    const uc = splitBySign(USER_CASE);
    check(
      "★ 用户案例：跌侧序列全为 null（**只有一条线**）",
      uc.down.every((v) => v === null),
      JSON.stringify(uc.down),
    );
    check(
      "★ 用户案例：涨侧首点保留真实值 +0.37%（**未被伪造成 0**）",
      uc.up[0] !== null && Math.abs(uc.up[0] - 0.3715) < 1e-9,
      JSON.stringify(uc.up),
    );
    check(
      "★ 用户案例：不得出现 pct 中不存在的 0（伪造点）",
      !uc.up.includes(0) && !uc.down.includes(0),
      `up=${JSON.stringify(uc.up)} down=${JSON.stringify(uc.down)}`,
    );

    /* ============================================================
       回归锁 B：**任何**非 null 值都必须原样来自 pct（通用防伪造）
       ============================================================ */
    const cases: number[][] = [
      [0.37, -0.11],
      [1, -1],
      [-1, 1],
      [0, 1, 2],
      [0, -1, -2],
      [-0.0845, -0.3378, -0.5068, 0.2111, 0.2956, 0.0845, -0.2111, 0.0422, 0.1267],
      [2, 1, -1, -2, 3, -3],
    ];
    let fabricate = 0;
    for (const pct of cases) {
      const s = splitBySign(pct);
      const allowed = new Set(pct);
      for (const v of [...s.up, ...s.down]) {
        if (v !== null && !allowed.has(v)) fabricate += 1;
      }
    }
    check("★ 通用：拆分结果中不存在任何 pct 里没有的值（杜绝伪造点）", fabricate === 0, `伪造 ${fabricate} 处`);

    /* ============================================================
       回归锁 C：两条序列必须「相邻而不重叠」
       仅当某点是**换色顶点**（左右两段归属不同）时才允许同时出现在两条序列里。
       ============================================================ */
    const signOfSeg = (a: number, b: number) => (a + b) / 2 >= 0;
    let overlapBad = 0;
    for (const pct of cases) {
      const s = splitBySign(pct);
      for (let i = 0; i < pct.length; i += 1) {
        const both = s.up[i] !== null && s.down[i] !== null;
        if (!both) continue;
        // 换色顶点：左右两段都存在且归属不同
        const hasPrev = i >= 1 && pct[i - 1] !== null && pct[i] !== null;
        const hasNext = i + 1 < pct.length && pct[i] !== null && pct[i + 1] !== null;
        const isTransition =
          hasPrev && hasNext && signOfSeg(pct[i - 1], pct[i]) !== signOfSeg(pct[i], pct[i + 1]);
        if (!isTransition) overlapBad += 1;
      }
    }
    check("★ 通用：两条序列只在换色顶点处重合（不再出现同段双线）", overlapBad === 0, `非法重合 ${overlapBad} 处`);

    // 全正 / 全负：另一侧必须完全为空（这是最直观的「只有一条线」）
    const allUp = splitBySign([0, 1, 2, null]);
    check("全正：涨侧有值", allUp.up.slice(0, 3).every((v) => v !== null), JSON.stringify(allUp.up));
    check("全正：跌侧全为 null", allUp.down.every((v) => v === null), JSON.stringify(allUp.down));

    const allDown = splitBySign([0, -1, -2]);
    check("全负：跌侧有值", allDown.down.every((v) => v !== null), JSON.stringify(allDown.down));
    check("全负：涨侧全为 null", allDown.up.every((v) => v === null), JSON.stringify(allDown.up));

    // 换色顶点：两条序列应在该点重合，且该点值原样来自 pct。
    // pct = [-1, -2, 1, 2]，按**段中点**归属：
    //   段1 (-1→-2) 中点 -1.5 → 跌侧
    //   段2 (-2→+1) 中点 -0.5 → 跌侧（跨 0 轴，按中点仍归跌）
    //   段3 (+1→+2) 中点 +1.5 → 涨侧
    // ⇒ 换色顶点是 **index 2**（值 +1），它同时属于跌侧（段2 的终点）与涨侧（段3 的起点）。
    const cross = splitBySign([-1, -2, 1, 2]);
    check(
      "换色顶点同时出现在两条序列中（index 2，值 +1）",
      cross.up[2] === 1 && cross.down[2] === 1,
      `up=${JSON.stringify(cross.up)} down=${JSON.stringify(cross.down)}`,
    );
    check(
      "换色前后：段2 归跌侧、段3 归涨侧",
      cross.down[0] === -1 &&
        cross.down[1] === -2 &&
        cross.down[2] === 1 &&
        cross.up[2] === 1 &&
        cross.up[3] === 2,
      `up=${JSON.stringify(cross.up)} down=${JSON.stringify(cross.down)}`,
    );

    /* 已知固有限制，**显式锁定**为预期行为（避免日后被当成 bug 或被悄悄改掉）
       横轴是类目轴，无法在「一段的中间」插入零穿越顶点，因此当某一段跨越 0 轴时，
       该段整体按中点取色 → 会有至多一段（≈30 分钟）的颜色越过 0 轴。
       `[-2, +1]` 单段：中点 -0.5 → 整段归跌侧（绿），绿线会画到 +1%。
       真实行情软件用逐分钟数值轴可精确落点；本项目 30 分钟粒度做不到。
       我们选择「宁可轻微越轴，也不伪造点、不画双线」。 */
    const overshoot = splitBySign([-2, 1]);
    check(
      "已知限制（锁定）：单段跨越 0 轴时整段按中点取色",
      overshoot.down[0] === -2 && overshoot.down[1] === 1 && overshoot.up.every((v) => v === null),
      `up=${JSON.stringify(overshoot.up)} down=${JSON.stringify(overshoot.down)}`,
    );

    // null 不得被填值（防泄露 / 防伪造）
    const withNull = splitBySign([1, null, -1]);
    check(
      "null 位置不得被填值【防伪造】",
      withNull.up[1] === null && withNull.down[1] === null,
      `up=${JSON.stringify(withNull.up)} down=${JSON.stringify(withNull.down)}`,
    );
    check("被 null 隔断的两侧各自成段（孤立点按自身符号）", withNull.up[0] === 1 && withNull.down[2] === -1, `up=${JSON.stringify(withNull.up)} down=${JSON.stringify(withNull.down)}`);

    // 长度一致性：两条序列必须与入参等长（否则与横轴错位）
    const len = 9;
    const arr = Array.from({ length: len }, (_, i) => (i < 4 ? 1 : null));
    const s = splitBySign(arr);
    check("两侧序列与入参等长", s.up.length === len && s.down.length === len, `${s.up.length}/${s.down.length}`);
  }

  console.log("\n=== E. ChartTabs：默认必须是「分时图」 ===");
  {
    const html = renderTabs({});
    check("渲染出分时图容器 data-testid=intraday-chart", html.includes('data-testid="intraday-chart"'), "");
    check("data-tick-count == ticks 数(3)", html.includes('data-tick-count="3"'), "");
    // 注意：测试运行器把 `echarts-for-react` 替换成了同一个占位组件，两个图都会输出
    // `kline-chart-stub`，因此**不能**用它区分分支。改用「日K 分支专属提示语」判定。
    check("默认不进入日K分支（无「当日动态K线」提示）", !html.includes("当日动态K线"), "");
    check("含 Tab 按钮「分时图」", html.includes("分时图"), "");
    check("含 Tab 按钮「日K」", html.includes("日K"), "");
    // 2026-09-24：观望取消后「今日操作 X/8」永远够不到上限，界面改显示**真正会用完**的
    // 买卖配额（仍是「操作次数」信息，仍放在图表右侧保持醒目）。断言同步到新文案。
    check(
      "含操作次数（醒目）",
      /买入[\s\S]{0,40}\/\s*2/.test(html) && /卖出[\s\S]{0,40}\/\s*2/.test(html),
      "",
    );
    check("含当前时点 10:30", html.includes("10:30"), "");
    check("含「推进 30 分钟」入口（可推进时）", html.includes("推进 30 分钟"), "");
  }

  console.log("\n=== F. ChartTabs：日K 分支（含当日动态K线提示） ===");
  {
    const html = renderTabs({ initialTab: "daily" });
    check("日K 分支渲染出图表", html.includes("kline-chart-stub"), "");
    check("提示「当日动态K线」", html.includes("当日动态K线"), "");
    check("提示已形成根数 3/8", /已形成[\s\S]{0,20}3[\s\S]{0,10}\/\s*8/.test(html), "");
    check("提示成交量累计中", html.includes("成交量累计中"), "");
    check("不渲染分时图容器", !html.includes('data-testid="intraday-chart"'), "");
  }

  console.log("\n=== G. ChartTabs：已收盘时提示「当日已收盘」 ===");
  {
    const html = renderTabs({
      initialTab: "daily",
      snapshot: makeSnapshot({ todayBar: makeTodayBar({ finalized: true, revealedBars: 8 }) }),
    });
    check("提示「当日已收盘」", html.includes("当日已收盘"), "");
    check("不再提示「动态K线」", !html.includes("当日动态K线"), "");
  }

  console.log("\n=== H. ChartTabs：30m 数据不可用时的兜底 ===");
  {
    const html = renderTabs({
      initialTab: "daily",
      snapshot: makeSnapshot({ todayBar: null }),
    });
    check("提示 30 分钟数据不可用", html.includes("30 分钟数据不可用"), "");
    check("仍渲染日K图（不空白）", html.includes("kline-chart-stub"), "");
  }

  console.log("\n=== I. ChartTabs：无分时数据时的空态 ===");
  {
    const html = renderTabs({ intraday: makeIntraday([]) });
    check("显示空态文案", html.includes("当日暂无分时数据"), "");
    check("空态 data-tick-count=0", html.includes('data-tick-count="0"'), "");
  }

  /* ============================ 2026-09-24 新增：B/S 买卖点 + 成本线 ============================
   * 需求：买入在分时图上打 B 点、卖出打 S 点，并显示持仓成本线。
   * 这里测的是 `buildIntradayOption` 这个**纯函数**的输出结构 ——
   * 比截图比对可重复、且能精确断言落点坐标。 */
  type Opt = {
    series: Array<{
      name?: string;
      type?: string;
      data?: Array<{ value?: unknown[] }>;
      itemStyle?: { color?: string };
      label?: { formatter?: unknown };
      markLine?: { data?: Array<{ yAxis?: number }> };
      symbol?: string;
      symbolOffset?: number[];
      silent?: boolean;
    }>;
    yAxis?: Array<{ max?: number }>;
  };
  const NINE = [10.0, 10.2, 9.8, 10.1, 10.3, 10.4, 10.5, 10.6, 10.7];

  console.log("\n=== J. 分时图：B/S 买卖点（当日成交） ===");
  {
    const opt = buildIntradayOption({
      ticks: makeTicks(NINE),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
      fills: [
        { side: "BUY", price: 10.2, time: "10:00", quantity: 1000 },
        { side: "SELL", price: 9.8, time: "10:30", quantity: 500 },
      ],
    }) as unknown as Opt;

    const buy = opt.series.find((s) => s.name === "买入点");
    const sell = opt.series.find((s) => s.name === "卖出点");
    check("存在「买入点」series", !!buy, "");
    check("存在「卖出点」series", !!sell, "");
    check(
      "买入点落在 10:00、y=+2%（10.2 相对前收 10.0）",
      buy?.data?.[0]?.value?.[0] === "10:00" &&
        Math.abs((buy.data[0].value[1] as number) - 2) < 0.001,
      JSON.stringify(buy?.data?.[0]?.value),
    );
    check(
      "卖出点落在 10:30、y=−2%（9.8 相对前收 10.0）",
      sell?.data?.[0]?.value?.[0] === "10:30" &&
        Math.abs((sell.data[0].value[1] as number) + 2) < 0.001,
      JSON.stringify(sell?.data?.[0]?.value),
    );
    check("买点标 B / 卖点标 S", buy?.label?.formatter === "B" && sell?.label?.formatter === "S", "");
    check(
      "买红卖绿（沿用 A 股涨跌色，不另起一套）",
      buy?.itemStyle?.color === CHART.up && sell?.itemStyle?.color === CHART.down,
      `${buy?.itemStyle?.color} / ${sell?.itemStyle?.color}`,
    );
    /* 造型对齐主流行情软件（2026-09-24 用户反馈后调整）：
       小方块 + 白色字母，而不是三角 —— 方块在 11~14px 下仍能承载清楚字母。 */
    check(
      "B/S 用方块（roundRect）而非三角",
      buy?.symbol === "roundRect" && sell?.symbol === "roundRect",
      `${buy?.symbol} / ${sell?.symbol}`,
    );
    check(
      "B 贴在价格线下方、S 在上方（不遮住成交价那条线）",
      (buy?.symbolOffset?.[1] ?? 0) > 0 && (sell?.symbolOffset?.[1] ?? 0) < 0,
      `buyOffset=${JSON.stringify(buy?.symbolOffset)} sellOffset=${JSON.stringify(sell?.symbolOffset)}`,
    );
  }

  console.log("\n=== K. 分时图：定位不了的成交不得画点（宁可少画，不猜位置） ===");
  {
    const opt = buildIntradayOption({
      ticks: makeTicks(NINE),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
      fills: [
        { side: "BUY", price: 10.2, time: null, quantity: 100 }, // 时点未知（barTime 为 null）
        { side: "BUY", price: 10.3, time: "12:00", quantity: 100 }, // 不在横轴 9 个刻度内
      ],
    }) as unknown as Opt;
    const buy = opt.series.find((s) => s.name === "买入点");
    check(
      "时点 null / 不在刻度内 → 该点被丢弃",
      (buy?.data?.length ?? 0) === 0,
      `实际 ${buy?.data?.length}`,
    );
    const noFills = buildIntradayOption({
      ticks: makeTicks(NINE),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    check(
      "不传 fills 时不产生买卖点数据",
      (noFills.series.find((s) => s.name === "买入点")?.data?.length ?? 0) === 0,
      "",
    );
  }

  console.log("\n=== L. 分时图：成本线（持仓均价） ===");
  {
    const withCost = buildIntradayOption({
      ticks: makeTicks(NINE),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
      costPrice: 10.5,
    }) as unknown as Opt;
    const data = withCost.series.find((s) => s.name === "涨")?.markLine?.data ?? [];
    check("markLine 含 2 项（前收 + 成本）", data.length === 2, `实际 ${data.length}`);
    check("前收线仍在 y=0", data[0]?.yAxis === 0, String(data[0]?.yAxis));
    check(
      "成本线 y = +5%（10.5 相对前收 10.0）",
      Math.abs((data[1]?.yAxis ?? 0) - 5) < 0.001,
      String(data[1]?.yAxis),
    );

    const noCost = buildIntradayOption({
      ticks: makeTicks(NINE),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    check(
      "无持仓时只剩前收一项（结构与改动前完全一致）",
      (noCost.series.find((s) => s.name === "涨")?.markLine?.data ?? []).length === 1,
      "",
    );
  }

  console.log("\n=== M. 分时图：y 轴必须把成本线包进来（否则成本线看不见） ===");
  {
    // 当日波动极小（±0.3% 以内），成本价却在 +8% —— 若 y 轴不扩边，成本线会被裁掉
    const flat = [10.01, 10.02, 10.0, 10.02, 10.03, 10.01, 10.02, 10.03, 10.02];
    const opt = buildIntradayOption({
      ticks: makeTicks(flat),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
      costPrice: 10.8,
    }) as unknown as Opt;
    const bound = opt.yAxis?.[0]?.max ?? 0;
    check("y 轴上限已被成本线撑到包含 +8%", bound >= 8, `bound=${bound}`);
  }

  console.log("\n=== N. 开盘未推进（游标 0）：只有开盘价一个点，不画曲线 ===");
  {
    /* 游标 0 = 一根 30m K 都没走完 → ticks 只有 09:30 一个点。
       此时**不能画曲线**（09:30→10:00 那段还没发生），
       但**必须画出这个点** —— 否则图上空空如也，玩家看不到开盘价在哪。 */
    const one = buildIntradayOption({
      ticks: makeTicks([10.5]),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    const up1 = one.series.find((s) => s.name === "涨");
    const down1 = one.series.find((s) => s.name === "跌");
    check(
      "单点时折线**显示符号**（否则图上啥都没有）",
      up1?.symbol === "circle" && down1?.symbol === "circle",
      `${up1?.symbol} / ${down1?.symbol}`,
    );
    check(
      "单点只占一个横轴刻度（09:30），不会向右延伸",
      // 注意：series 数据里未揭示的位置是**裸 null**，不是 {value:null}，判空要先看 d 本身
      (up1?.data ?? []).filter((d) => d != null).length === 1,
      JSON.stringify(up1?.data),
    );

    // 两点以上 → 只留折线、隐藏符号（与真实分时图一致，避免点太密）
    const two = buildIntradayOption({
      ticks: makeTicks([10.5, 10.8]),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    check(
      "两点以上时符号隐藏（symbol=none，只留折线）",
      two.series.find((s) => s.name === "涨")?.symbol === "none",
      String(two.series.find((s) => s.name === "涨")?.symbol),
    );
  }

  console.log("\n=== N. 日K：成本线（markLine，价格口径） ===");
  {
    const bars: KlineBar[] = [
      { date: "2025-03-20", open: 10, high: 11, low: 9.5, close: 10.5, volume: 1000, amount: 10500 },
      { date: "2025-03-21", open: 10.5, high: 11.5, low: 10, close: 11, volume: 1200, amount: 13200 },
    ];
    type KOpt = {
      series: Array<{ name?: string; markLine?: { data?: Array<{ yAxis?: number }> } }>;
    };
    const withCost = buildKlineOption({ bars, costLine: 12.34 }) as unknown as KOpt;
    const ml = withCost.series.find((s) => s.name === "K线")?.markLine?.data ?? [];
    check(
      "日K 成本线已挂载，且 y 值为**价格**口径（12.34）",
      ml.length === 1 && Math.abs((ml[0]?.yAxis ?? 0) - 12.34) < 0.001,
      JSON.stringify(ml),
    );

    const noCost = buildKlineOption({ bars }) as unknown as {
      series: Array<{ markLine?: unknown }>;
    };
    check(
      "不传 costLine 时完全不挂 markLine（回测/指数等既有调用方零影响）",
      noCost.series.every((s) => s.markLine === undefined),
      "",
    );

    // 买卖点造型与分时图保持一致（2026-09-24 用户反馈后统一为方块 + 字母）
    const withMarkers = buildKlineOption({
      bars,
      markers: [
        { date: "2025-03-20", type: "BUY", price: 10 },
        { date: "2025-03-21", type: "SELL", price: 11 },
      ],
    }) as unknown as {
      series: Array<{
        name?: string;
        markPoint?: {
          data?: Array<{
            symbol?: string;
            symbolOffset?: number[];
            label?: { formatter?: unknown };
          }>;
        };
      }>;
    };
    const mp = withMarkers.series.find((s) => s.name === "K线")?.markPoint?.data ?? [];
    check("日K 买卖点已挂载（2 个）", mp.length === 2, `实际 ${mp.length}`);
    check(
      "日K 买卖点同样是方块 + 字母（与分时图视觉语言一致）",
      mp.every((p) => p.symbol === "roundRect") &&
        mp[0]?.label?.formatter === "B" &&
        mp[1]?.label?.formatter === "S",
      JSON.stringify(mp.map((p) => `${p.symbol}:${String(p.label?.formatter)}`)),
    );
    check(
      "日K 买点在下方、卖点在上方（不遮住蜡烛实体）",
      (mp[0]?.symbolOffset?.[1] ?? 0) > 0 && (mp[1]?.symbolOffset?.[1] ?? 0) < 0,
      JSON.stringify(mp.map((p) => p.symbolOffset)),
    );

    /* dataZoom 受控化的基础：option 必须**原样采用**调用方给的窗口。
       组件层（KlineChart）把用户拖动后的 start/end 存进 state 再传进来，
       因此这里若不尊重入参，拖动位置就会在 option 重建时丢失
       —— 那正是用户反馈的「拖到 5 月、一下单又跳回」缺陷。 */
    const zoomed = buildKlineOption({ bars, zoomStart: 10, zoomEnd: 40 }) as unknown as {
      dataZoom: Array<{ start?: number; end?: number }>;
    };
    check(
      "dataZoom 原样采用传入窗口（受控化前提）",
      zoomed.dataZoom.length > 0 && zoomed.dataZoom.every((z) => z.start === 10 && z.end === 40),
      JSON.stringify(zoomed.dataZoom.map((z) => [z.start, z.end])),
    );
  }

  console.log("\n=== O. 分时图：当前时点红点（30m 时间轴指示器） ===");
  {
    /* 需求（2026-09-25 用户）：时间线走到哪，就在那根 30m K 的末端画一颗小红点。
       例：已揭示到 10:00 → 红点在 10:00；收盘后 → 红点停在 15:00。 */

    // 场景 1：只揭示 3 个点（09:30 / 10:00 / 10:30）→ 红点必须在 10:30
    const opt3 = buildIntradayOption({
      ticks: makeTicks([10.0, 10.1, 10.2]),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    const cur3 = opt3.series.find((s) => s.name === "当前时点");
    check("存在「当前时点」series（scatter）", !!cur3 && cur3.type === "scatter", `实际=${cur3?.type}`);
    check(
      "红点恰有 1 个",
      (cur3?.data?.length ?? 0) === 1,
      `实际=${cur3?.data?.length}`,
    );
    check(
      "揭示 3 点 → 红点落在 10:30（最后一个已揭示点）",
      cur3?.data?.[0]?.value?.[0] === "10:30",
      JSON.stringify(cur3?.data?.[0]?.value),
    );
    check(
      "红点 y == 该点涨跌幅 +2%（10.2 相对前收 10.0，不引入新数值）",
      Math.abs((cur3?.data?.[0]?.value?.[1] as number) - 2) < 0.001,
      String(cur3?.data?.[0]?.value?.[1]),
    );
    check(
      "红点颜色 == CHART.up（固定红：时间指示器语义，不随涨跌变色）",
      cur3?.itemStyle?.color === CHART.up,
      `实际=${cur3?.itemStyle?.color}`,
    );
    check("红点为实心圆（circle）", cur3?.symbol === "circle", `实际=${cur3?.symbol}`);
    check("红点不拦截鼠标（silent）", cur3?.silent === true, `实际=${String(cur3?.silent)}`);

    // 场景 2：全天 9 点全部揭示 → 红点停在 15:00
    const opt9 = buildIntradayOption({
      ticks: makeTicks(NINE),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    const cur9 = opt9.series.find((s) => s.name === "当前时点");
    check(
      "全天揭示 → 红点停在 15:00",
      cur9?.data?.[0]?.value?.[0] === "15:00",
      JSON.stringify(cur9?.data?.[0]?.value),
    );

    // 场景 3：游标 0（只有 09:30 锚点）→ 红点在 09:30
    const opt0 = buildIntradayOption({
      ticks: makeTicks([10.5]),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    const cur0 = opt0.series.find((s) => s.name === "当前时点");
    check(
      "游标 0 → 红点落在 09:30 开盘锚点",
      cur0?.data?.[0]?.value?.[0] === "09:30",
      JSON.stringify(cur0?.data?.[0]?.value),
    );

    // 场景 4：空 ticks（纯函数层兜底）→ 红点数据为空数组，不报错
    const optEmpty = buildIntradayOption({
      ticks: [],
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    const curEmpty = optEmpty.series.find((s) => s.name === "当前时点");
    check(
      "空 ticks → 红点 data 为空（组件层另有空态分支）",
      !!curEmpty && (curEmpty.data?.length ?? 0) === 0,
      `实际=${curEmpty?.data?.length}`,
    );

    // 场景 5：红点绝不画在未揭示位置（防泄露推论）
    // 中间断档的情况：只有 09:30 与 10:30（模拟 ticks 缺 10:00 的极端入参）
    const gap = buildIntradayOption({
      ticks: makeTicks([10.0, 10.2]).map((t, i) =>
        i === 1 ? { ...t, time: "10:30" } : t,
      ),
      times: TIMES,
      prevClose: PREV_CLOSE,
      height: 260,
    }) as unknown as Opt;
    const curGap = gap.series.find((s) => s.name === "当前时点");
    check(
      "断档时红点只落在最后一个已揭示点（10:30），不落在空洞处",
      curGap?.data?.[0]?.value?.[0] === "10:30",
      JSON.stringify(curGap?.data?.[0]?.value),
    );
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
