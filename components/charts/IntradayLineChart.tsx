"use client";

import * as React from "react";
import ReactECharts from "echarts-for-react";
import { CHART } from "@/lib/chartPalette";
import type { SimTradeIntradayTick } from "@/types";

/**
 * 日内分时图（折线）—— 真实炒股软件风格。
 *
 * 设计要点（对应需求 三 / 四 / 十）：
 *  1. **0 轴 = 前一交易日收盘价 `prevClose`**，**不是当日开盘价**。
 *     涨跌幅一律 `(price − prevClose) / prevClose × 100`。
 *  2. **横轴自 09:30 起**（`times` 共 9 个刻度）。09:30 的数据点来自服务端 tick 数组的
 *     首个「开盘锚点」（= 第 1 根 30m K 的 open，即 09:30 真实成交价）。
 *  3. **逐节点揭示 / 不泄露未来**（本组件的核心约束）：
 *     - 数据严格按 `times` 对齐；**未揭示的时点在数据数组中为 `null`**，
 *       曲线因此只画到已揭示的最后一个点为止 —— 不可能提前画出未来走势；
 *     - 未来成交量同样为 `null`，不会提前画出未来的量柱；
 *     - 本组件**不做任何切片/补齐/推算**，也不自行请求数据：
 *       `ticks` 由服务端按会话 30m 游标裁剪后下发，浏览器拿不到未来值。
 *  4. **横轴刻度用完整的 `times`**（而非只画已揭示的几个点），这样横轴不会随揭示进度伸缩抖动。
 *  5. 颜色遵循 A股习惯：涨红跌绿。
 *  6. **当前时点红点**：最后一个已揭示点处画一颗实心小红点（「当前价」指示器），
 *     表示 30m 时间轴此刻走到哪里 —— 游标推进时红点随之右移，收盘后停在 15:00。
 *     颜色固定红（时间指示器语义），不随涨跌变色。
 *
 * 与日K 的关系：本图只画价格与成交量，不显示 MA/MACD（分时图不需要，也就不存在
 * 指标口径的未来数据问题）。
 */

/** A股配色（唯一来源：lib/chartPalette —— 与全站深色主题及各图表保持一致） */
const UP_COLOR = CHART.up;
const DOWN_COLOR = CHART.down;
const FLAT_COLOR = CHART.flat;
const AXIS_COLOR = CHART.axisLine;
const GRID_COLOR = CHART.splitLine;
const MUTED = CHART.textMuted;
const TEXT = CHART.textPrimary;

export interface IntradayLineChartProps {
  /** 已揭示的分时点（服务端已按游标裁剪；首点为 09:30 锚点） */
  ticks: SimTradeIntradayTick[];
  /** 横轴完整刻度（`HH:MM`，9 个） */
  times: string[];
  /** 前一交易日收盘价（0 轴基准） */
  prevClose: number | null;
  /** 图表高度（px） */
  height?: number;
  /** 当前模拟时点（如 `10:30`），仅用于展示 */
  currentTime?: string;
  loading?: boolean;
  /** 当日成交（B/S 点数据源）；不传则不画标记 */
  fills?: IntradayFillMark[];
  /** 持仓成本价（成本线）；null/undefined = 无持仓，不画 */
  costPrice?: number | null;
}

/**
 * 分时图上的买卖标记（B/S 点）。
 *
 * `time` 必须与横轴刻度（`times`）**同口径**（`HH:MM`），否则点会找不到落点而消失。
 * `time === null` 表示无法确定成交时点（例如 30m 数据缺失、退化为日K 口径）——
 * 此时**不画该点**：宁可少一个标记，也不把它随手放在错误的时点上。
 */
export interface IntradayFillMark {
  side: "BUY" | "SELL";
  /** 成交价：会换算成「相对前收的涨跌幅」作为 y 值 */
  price: number;
  /** 成交时点 `HH:MM`；null = 无法定位 */
  time: string | null;
  /** 成交数量（提示框用） */
  quantity?: number;
}

export interface IntradayOptionInput {
  ticks: SimTradeIntradayTick[];
  times: string[];
  prevClose: number | null;
  /** 当日成交（B/S 点） */
  fills?: IntradayFillMark[];
  /** 持仓成本价（成本线） */
  costPrice?: number | null;
}

/** 把 `ticks` 按 `times` 对齐成图表数据；**未揭示时点为 null（绝不补造）** */
export function alignTicksToAxis(input: IntradayOptionInput): {
  base: number;
  /** 与 `times` 等长；未揭示为 null */
  pctData: (number | null)[];
  /** 与 `times` 等长；未揭示为 null */
  volData: (number | null)[];
  /** 已揭示的点数（含 09:30 锚点） */
  revealedPoints: number;
} {
  const { ticks, times, prevClose } = input;
  const byTime = new Map(ticks.map((t) => [t.time, t]));
  // 0 轴基准：优先用前一交易日收盘；缺失时退化为首个已揭示点价格（不伪造）
  const base = prevClose && prevClose > 0 ? prevClose : (ticks[0]?.price ?? 0);

  const pctData: (number | null)[] = [];
  const volData: (number | null)[] = [];
  let revealedPoints = 0;

  for (const t of times) {
    const tick = byTime.get(t);
    if (!tick || base <= 0) {
      pctData.push(null);
      volData.push(null);
      continue;
    }
    pctData.push(+(((tick.price - base) / base) * 100).toFixed(3));
    volData.push(tick.volume);
    revealedPoints += 1;
  }

  return { base, pctData, volData, revealedPoints };
}

/**
 * 按**线段**把涨跌幅序列拆成涨/跌两侧，供两条固定颜色的折线使用。
 *
 * ## 🔴 为什么不是「按点」拆（这是对一处真实缺陷的修复，2026-09-24）
 *
 * 最初实现按**点**的符号拆分：`v >= 0` 归涨侧、`v < 0` 归跌侧，
 * 并在 0 轴穿越处往两侧各补一个 `0`。线上实测（用户直接反馈「为啥有两条分时线」）
 * 暴露了两个问题：
 *
 * 1. **同一段 x 被画了两条线**。以真实案例为例（前收 18.84）：
 *    `09:30 = +0.37%`、`10:00 = −0.11%`，只有 2 个已揭示点。旧实现产出
 *    `up = [+0.37, 0]`、`down = [0, −0.11]` ——
 *    红线从 (09:30,+0.37%) 降到 (10:00,0)，绿线从 (09:30,0) 降到 (10:00,−0.11%)。
 *    两条线叠在同一段 x 上、形成「漏斗」，视觉上就是两条分时线。
 * 2. **补出来的 `0` 是伪造数据**。09:30 真实值是 **+0.37%** 却被画成 **0.00%**；
 *    10:00 是 **−0.11%** 也被画成 0。图表在撒谎，这比"好不好看"严重得多。
 *
 * ## 现方案：按线段归属（不伪造任何点）
 *
 * 对每一段 `[i-1, i]`，用**两端中点值**的符号决定该段属于涨侧还是跌侧；
 * 段的两个端点分别归入对应侧。于是：
 *   · 转折顶点会**同时出现在两条序列里** —— 它本身是真实数据点，重复引用是允许的；
 *   · 两条序列在 x 轴方向上**相邻而不重叠**，视觉上是**一条连续折线在顶点处换色**；
 *   · 序列里的每个值都**原样来自 `pct`**，绝不引入 `pct` 中不存在的数值。
 *
 * ## 已知的固有限制（诚实记录，不掩饰）
 *
 * 横轴是**类目轴**（9 个时点：09:30 / 10:00 / … / 15:00），
 * 无法在「一段的中间」插入一个精确的零穿越顶点。因此当某一段跨越 0 轴时，
 * 该段整体按中点取色，会有**至多一段（≈30 分钟）**的颜色越过 0 轴。
 * 真实行情软件用逐分钟数值轴，可在穿越处精确落点；本项目 30 分钟粒度做不到。
 * 这里的选择是：**宁可轻微越轴，也不伪造点、不画双线**。
 *
 * @returns `up` / `down` 两条与入参等长的序列；未揭示位置恒为 `null`
 */
export function splitBySign(pct: (number | null)[]): {
  up: (number | null)[];
  down: (number | null)[];
} {
  const n = pct.length;
  const up: (number | null)[] = new Array(n).fill(null) as (number | null)[];
  const down: (number | null)[] = new Array(n).fill(null) as (number | null)[];

  /** 段归属：`segUp[k]` 表示「第 k-1 点到第 k 点」这一段是否属于涨侧（k ≥ 1）；null = 该段不成立 */
  const segUp: (boolean | null)[] = new Array(n).fill(null) as (boolean | null)[];
  for (let i = 1; i < n; i += 1) {
    const a = pct[i - 1];
    const b = pct[i];
    // 任一端未揭示 → 这一整段不存在（不能跨 null 连线）
    if (a === null || b === null) continue;
    segUp[i] = (a + b) / 2 >= 0;
  }

  for (let i = 0; i < n; i += 1) {
    const v = pct[i];
    if (v === null) continue;

    const prevSeg = i >= 1 ? segUp[i] : null; // 与左侧点相连的段
    const nextSeg = i + 1 < n ? segUp[i + 1] : null; // 与右侧点相连的段

    if (prevSeg === null && nextSeg === null) {
      // 孤立点（左右都没有成立的段）：按**自身符号**着色，且只进一侧
      if (v >= 0) up[i] = v;
      else down[i] = v;
      continue;
    }
    // 转折顶点会同时进两条序列（真实数据点，允许重复引用）
    for (const s of [prevSeg, nextSeg]) {
      if (s === true) up[i] = v;
      else if (s === false) down[i] = v;
    }
  }

  return { up, down };
}

/** 构建 ECharts option（纯函数，便于脱离浏览器做确定性单测） */
export function buildIntradayOption(input: IntradayOptionInput & { height: number }) {
  const { times } = input;
  const { pctData, volData, base } = alignTicksToAxis(input);
  /** 涨跌双侧序列（确定性双色折线，替代不可靠的 visualMap） */
  const signSplit = splitBySign(pctData);

  /* ---------------- 成本线 & 买卖点（B/S） ----------------
   * 两者都以「相对前收的涨跌幅%」为 y 值 —— 与主图共用同一坐标系，才能落在正确高度。
   * 若各自另起一套坐标系，成本线就会画在错误的位置上。 */
  const toPct = (price: number): number | null =>
    base > 0 ? +(((price - base) / base) * 100).toFixed(3) : null;

  const costPct =
    input.costPrice !== null && input.costPrice !== undefined && input.costPrice > 0
      ? toPct(input.costPrice)
      : null;

  /**
   * 成交 → 落点。
   * **时点不在横轴刻度内的一律丢弃**：分时图横轴只有固定的 9 个刻度，
   * 找不到对应刻度就只能放弃该点（例如 30m 数据缺失导致 barTime 为 null）。
   */
  const marks = (input.fills ?? [])
    .filter((f) => f.time !== null && times.includes(f.time))
    .map((f) => ({
      side: f.side,
      price: f.price,
      time: f.time as string,
      quantity: f.quantity,
      pct: toPct(f.price),
    }))
    .filter((m): m is typeof m & { pct: number } => m.pct !== null);
  const buyMarks = marks.filter((m) => m.side === "BUY");
  const sellMarks = marks.filter((m) => m.side === "SELL");

  const revealed = pctData.filter((v): v is number => v !== null);

  /* ---------------- 当前时点标记（小红点） ----------------
   * 在**最后一个已揭示点**的位置画一颗实心小红点，表示「30m 时间轴此刻走到这里」。
   *
   * 为什么放在最后一个已揭示点：
   *  - 游标 0（刚开盘）→ 只有 09:30 锚点 → 红点落在 09:30；
   *  - 推进 1 根（揭示 10:00）→ 红点落在 10:00 —— 恰好就是「当前 K 线末端」；
   *  - 收盘后 8 根全部揭示 → 红点停在 15:00（与主流行情 App 的当前价点一致）。
   *
   * 数据来源完全复用 `pctData`（相对前收的涨跌幅），**不引入任何新数值** ——
   * 红点的 y 值就是该点的涨跌幅，x 值就是该点的横轴刻度，因此不可能画错位置，
   也不可能借红点泄露任何未揭示信息（未揭示位置为 null，循环自然跳过）。
   */
  let cursorIndex = -1;
  for (let i = pctData.length - 1; i >= 0; i -= 1) {
    if (pctData[i] !== null) {
      cursorIndex = i;
      break;
    }
  }
  const cursorData =
    cursorIndex >= 0
      ? [{ value: [times[cursorIndex], pctData[cursorIndex] as number] }]
      : [];

  /*
   * 点极少时**必须显示符号**：刚开盘（游标 0）只有 09:30 一个数据点，
   * 而折线 series 的 `symbol: "none"` 会让单点**完全不可见** ——
   * 玩家就看不出开盘价落在图上的哪个位置。
   * 两个点以上切回 "none"，只留折线（与真实分时图一致，避免点太密）。
   */
  const revealedPointCount = revealed.length;
  const lineSymbol = revealedPointCount <= 1 ? "circle" : "none";
  /*
   * 对称上下界（真实分时图的习惯）：取已揭示偏离的绝对值最大者，留 15% 余量。
   *
   * ⚠️ 成本线与买卖点**必须一并纳入**，否则它们会落在可视区之外而完全看不见 ——
   * 而玩家最关心的恰恰是「我的成本在哪、我在哪买的」。真实行情软件用固定 ±10%
   * 的坐标轴，天然包含一切；我们是自适应范围，所以必须显式扩边。
   * 代价：成本价离前收很远时，当日波动会被压扁。这是「看得见成本线」与
   * 「看得清当日波动」之间的取舍，当前选择前者。
   */
  const maxAbs = Math.max(
    1,
    ...revealed.map((v) => Math.abs(v)),
    ...(costPct === null ? [] : [Math.abs(costPct)]),
    ...marks.map((m) => Math.abs(m.pct)),
  );
  const bound = Math.max(0.5, +(maxAbs * 1.15).toFixed(2));

  const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

  return {
    animation: false,
    // 全局留白收紧，让图表成为主视觉
    grid: [
      { left: 46, right: 46, top: 10, height: "58%" },
      { left: 46, right: 46, top: "73%", height: "16%" },
    ],
    tooltip: {
      trigger: "axis",
      confine: true,
      textStyle: { fontSize: 11, color: TEXT },
      backgroundColor: CHART.surface,
      borderColor: CHART.border,
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const first = arr[0] as { dataIndex?: number } | undefined;
        const i = typeof first?.dataIndex === "number" ? first.dataIndex : -1;
        if (i < 0) return "";
        const time = times[i];
        const tick = input.ticks.find((t) => t.time === time);
        if (!tick) return `<b>${time}</b><br/><span style="color:${MUTED}">未揭示</span>`;
        const pct = pctData[i];
        const color: string =
          pct === null ? TEXT : pct > 0 ? UP_COLOR : pct < 0 ? DOWN_COLOR : FLAT_COLOR;
        /* 第三个参数必须显式标注为 `string`：`CHART` 用了 `as const`，
           因此 `TEXT` 的类型是字面量 `"#e8edf5"` 而非 `string`，
           若写成 `c = TEXT` 会把参数窄化成该字面量，传入别的颜色就报错。 */
        const row = (label: string, val: string, c: string = TEXT) =>
          `<div><span style="color:${MUTED}">${label}</span> <span style="color:${c}">${val}</span></div>`;
        return (
          `<div style="font-weight:600;margin-bottom:4px;color:${TEXT}">${time}</div>` +
          row("价格", tick.price.toFixed(2), color) +
          row("涨跌", pct === null ? "—" : fmtPct(pct), color) +
          row("成交量", String(tick.volume))
        );
      },
    },
    /* 注意：这里**刻意没有** visualMap。
       涨跌双色由下面的两条固定颜色 series 实现（原因见 `splitBySign` 的注释）。 */
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: [
      {
        type: "category",
        data: times,
        gridIndex: 0,
        boundaryGap: false,
        axisLine: { lineStyle: { color: AXIS_COLOR } },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: "category",
        data: times,
        gridIndex: 1,
        boundaryGap: false,
        axisLine: { lineStyle: { color: AXIS_COLOR } },
        axisTick: { show: false },
        // 横轴刻度只画在成交量副图下方，与真实分时图一致
        axisLabel: { fontSize: 10, color: MUTED, interval: 1, hideOverlap: true },
      },
    ],
    yAxis: [
      {
        type: "value",
        gridIndex: 0,
        min: -bound,
        max: bound,
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { type: "dashed", color: GRID_COLOR } },
        axisLabel: {
          fontSize: 10,
          color: MUTED,
          formatter: (v: number) => fmtPct(v),
          /* ⚠️ 这里**不能**写 `customValues: [0]`。
             本意是「只强调 0 轴」，但该选项的语义是「**只显示**这些值」——
             实测后果是 y 轴只剩一个 `0.00%` 标签，涨跌幅刻度全部消失（已修复）。
             0 轴的标注由 series 的 `markLine`（标签「前收」）承担，不需要 axisLabel 参与。 */
        },
      },
      {
        type: "value",
        gridIndex: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
      },
    ],
    series: [
      /* 涨侧与跌侧各一条折线，颜色**显式写死**，不依赖 visualMap 的维度推断。
         两条线在 0 轴处通过 `splitBySign` 的桥接点精确相接，视觉上是一条连续的曲线。
         只有「涨侧」那条带 0 轴 markLine，避免两条线各画一条虚线重叠。 */
      {
        name: "涨",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: signSplit.up.map((v, i) => (v === null ? null : [times[i], v])),
        // 未揭示处为 null → 曲线到此为止（不画未来）
        connectNulls: false,
        smooth: false,
        symbol: lineSymbol,
        lineStyle: { width: 1.5, color: UP_COLOR },
        z: 3,
        // 0 轴虚线（前收基准线）
        markLine: {
          silent: true,
          symbol: "none",
          label: {
            formatter: "前收",
            fontSize: 10,
            color: MUTED,
            position: "insideEndTop",
          },
          lineStyle: { type: "dashed", color: CHART.crosshair, width: 1 },
          data: [
            { yAxis: 0 },
            /* 成本线：与前收线并置在**同一条** markLine 上，避免两条线各画一次。
               颜色复用「基准线」橙 —— 同为参照线语义，且不与涨红跌绿冲突。
               无持仓（或成本价非法）时 costPct 为 null，数组里只剩前收一项，
               行为与改动前完全一致。 */
            ...(costPct === null
              ? []
              : [
                  {
                    yAxis: costPct,
                    lineStyle: { type: "dashed", color: CHART.benchmark, width: 1 },
                    label: {
                      formatter: "成本",
                      fontSize: 10,
                      color: CHART.benchmark,
                      position: "insideEndTop",
                    },
                  },
                ]),
          ],
        },
      },
      {
        name: "跌",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: signSplit.down.map((v, i) => (v === null ? null : [times[i], v])),
        connectNulls: false,
        smooth: false,
        symbol: lineSymbol,
        lineStyle: { width: 1.5, color: DOWN_COLOR },
        z: 3,
      },
      /* ---------------- 当前时点（小红点） ----------------
       * 为什么用独立 scatter 而不是主线的 markPoint / 末点 symbol：
       *  - 主线有**涨/跌两条**，末点挂在哪条上取决于最后一段的方向，会跳动；
       *  - 独立 series 与两条线解耦，永远稳定落在「最后一个已揭示点」上。
       *
       * 颜色固定用 CHART.up（红）：这是**时间轴指示器**语义（「你在这里」），
       * 不是涨跌语义 —— 参考主流行情 App 的当前价点做法，跌的时候点也是红的。
       * `silent: true` 让红点不拦截鼠标（十字光标与 tooltip 照常工作）；
       * z=9 压在折线（z=3）之上、与 B/S 标记（z=10）同层不互相遮挡：
       * B/S 点有 ±13px 偏移，红点无偏移正中，落在同一时点时也不会重叠。 */
      {
        name: "当前时点",
        type: "scatter",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: cursorData,
        symbol: "circle",
        symbolSize: 8,
        itemStyle: { color: UP_COLOR },
        silent: true,
        z: 9,
      },
      /* ---------------- B/S 买卖点 ----------------
       * 为什么用独立 scatter series 而不是主线的 markPoint：
       *   markPoint 挂靠在某条线上，当那条线整段为 null（例如全未揭示）时会**连带消失**；
       *   独立 series 的数据只受自身控制，不会因为主线的 null 而丢失标记。
       *
       * 造型对齐主流行情软件（同花顺/东方财富）的做法：
       *   **小方块 + 白色字母**，且 B 压在价格线下方、S 压在价格线上方 ——
       *   这样标记不会盖住成交价本身那条线，视觉上「贴在」行情走势上。
       *   颜色沿用涨红跌绿（买=红、卖=绿），与全站其它买卖语义一致。 */
      {
        name: "买入点",
        type: "scatter",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: buyMarks.map((m) => ({
          value: [m.time, m.pct],
          price: m.price,
          quantity: m.quantity,
        })),
        symbol: "roundRect",
        symbolSize: 14,
        // 向下偏移：标记贴在价格线**下方**，不遮挡成交价
        symbolOffset: [0, 13],
        itemStyle: { color: UP_COLOR },
        label: {
          show: true,
          formatter: "B",
          fontSize: 10,
          fontWeight: "bold",
          color: "#ffffff",
          position: "inside",
        },
        z: 10,
      },
      {
        name: "卖出点",
        type: "scatter",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: sellMarks.map((m) => ({
          value: [m.time, m.pct],
          price: m.price,
          quantity: m.quantity,
        })),
        symbol: "roundRect",
        symbolSize: 14,
        // 向上偏移：标记贴在价格线**上方**
        symbolOffset: [0, -13],
        itemStyle: { color: DOWN_COLOR },
        label: {
          show: true,
          formatter: "S",
          fontSize: 10,
          fontWeight: "bold",
          color: "#ffffff",
          position: "inside",
        },
        z: 10,
      },
      {
        name: "成交量",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volData.map((v, i) => {
          const pct = pctData[i];
          const color = pct === null ? FLAT_COLOR : pct > 0 ? UP_COLOR : pct < 0 ? DOWN_COLOR : FLAT_COLOR;
          return { value: v, itemStyle: { color, opacity: 0.65 } };
        }),
        barMaxWidth: 12,
      },
    ],
  };
}

/**
 * 分时图组件（ECharts 薄壳）。
 *
 * 数据契约：`ticks` 必须来自 `/api/intraday?sessionId=`（服务端已按 30m 游标裁剪）。
 * 本组件只渲染，**不请求数据、不切片、不补齐**，因此不可能泄露未来。
 */
export default function IntradayLineChart({
  ticks,
  times,
  prevClose,
  height = 260,
  currentTime,
  loading = false,
  fills,
  costPrice,
}: IntradayLineChartProps) {
  const option = React.useMemo(
    () => buildIntradayOption({ ticks, times, prevClose, height, fills, costPrice }),
    [ticks, times, prevClose, height, fills, costPrice],
  );

  if (!loading && ticks.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground"
        style={{ height }}
        data-testid="intraday-chart"
        data-tick-count="0"
      >
        {currentTime ? `当日暂无分时数据（当前 ${currentTime}）` : "当日暂无分时数据"}
      </div>
    );
  }

  return (
    <div data-testid="intraday-chart" data-tick-count={ticks.length}>
      <ReactECharts
        option={option}
        style={{ height, width: "100%" }}
        showLoading={loading}
        notMerge
        lazyUpdate
        opts={{ renderer: "canvas" }}
      />
    </div>
  );
}
