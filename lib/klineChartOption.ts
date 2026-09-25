/**
 * K 线图 ECharts 配置构建 —— 纯函数
 *
 * 抽出的理由：
 *  图表配置（缩放、拖动、十字光标、成交量联动、均线绑定）属于功能正确性的一部分，
 *  但它原本内联在组件里，只能靠肉眼看图确认。抽成纯函数后可直接对配置结构断言，
 *  做到确定性验证，无需启动浏览器。
 *
 * 本模块不含任何 React / DOM 依赖。
 */

import type { EChartsOption } from "echarts";
import type { KlineBar } from "@/types";
import { CHART } from "@/lib/chartPalette";
import { MA_CONFIG, MA_PALETTE, calcMAs } from "@/lib/indicators";
import { formatVolume } from "@/lib/utils";

/** A股涨跌色（与 globals.css 的 --stock-up / --stock-down 一致，深底上略提亮） */
export const KLINE_UP_COLOR = CHART.up;
export const KLINE_DOWN_COLOR = CHART.down;
/** 折线形态（chartType="line"）的主线颜色：中性蓝，避免与涨跌红绿混淆 */
export const INDEX_LINE_COLOR = CHART.index;

/**
 * K 线上的买卖点标记（回测用，可选）。
 *
 * `date` 必须存在于 bars 的日期序列中（回测的买卖点取自**实际成交日**，
 * 必然是某个日K 的交易日）；`price` 为实际成交价，会落在该根K线的高低区间内。
 */
export interface KlineMarkerInput {
  date: string;
  type: "BUY" | "SELL";
  price: number;
  quantity?: number;
  reason?: string;
}

/**
 * 图表可接受的最小 K 线形状。
 *
 * 与 `KlineBar` 的唯一差别是 `amount`（成交额）**可选** ——
 * 指数不披露成交额（见 types/index.ts 的 `IndexBar` 注释），图表在缺失时
 * 直接不显示该行，而不是补 0：补 0 会凭空造出「成交额为零」的假数据。
 */
export type ChartBar = Omit<KlineBar, "amount"> & { amount?: number };

export interface BuildKlineOptionInput {
  /** 必须按交易日期升序 */
  bars: ChartBar[];
  /** 是否显示成交量副图（默认 true） */
  showVolume?: boolean;
  /**
   * 主图形态（默认 "candle"）。
   *  - "candle"：蜡烛图（个股 K 线）
   *  - "line"  ：收盘价折线（指数对照用，不画 K 线形态，只看趋势/相对强弱）
   * 其余部分（成交量副图、均线、dataZoom 联动、十字光标、tooltip）两种形态完全一致。
   */
  chartType?: "candle" | "line";
  /** 主图系列名（图例/提示用；默认 candle→"K线"、line→"指数"） */
  seriesName?: string;
  /**
   * 均线周期集合（可选）。不传时使用默认 MA_CONFIG（MA5/10/20/60）；
   * 传入则按给定周期绘制均线（如 [5, 20]）。
   */
  maPeriods?: number[];
  /** dataZoom 初始窗口起点百分比（默认 55，即默认显示最近 45%） */
  zoomStart?: number;
  /** dataZoom 初始窗口终点百分比（默认 100） */
  zoomEnd?: number;
  /**
   * 买卖点标记（可选）。不传时图表与第三阶段完全一致 ——
   * 标记只作为**附加图层**叠在蜡烛图上，不新增 series、不改动既有结构。
   */
  markers?: KlineMarkerInput[];
  /**
   * 持仓成本价（可选）：在图上画一条横向「成本线」。
   *
   * 不传或非正数时**不挂载 markLine** —— 图表结构与本改动之前完全一致，
   * 因此既有调用方（回测、指数对照）零影响。
   */
  costLine?: number | null;
  /**
   * x 轴标签取法（默认 "date"）。
   *  - "date"：直接用交易日 `YYYY-MM-DD`（日K / 周K / 月K）
   *  - "time"：用 30 分钟棒的收盘时刻 `HH:MM`（**仅用于单一交易日的日内 30m 图**）
   *
   * ⚠️ "time" 模式只在 bars 同属**一个交易日**时成立：跨日的 30m 序列每天都出现
   * 相同的 `10:00`/`10:30`，category 轴会把它们当成同一类别而横向塌陷成一根。
   * 该约束由调用方保证（SimTradeClient 只取会话当前日，天然单日）。
   */
  xAxisMode?: "date" | "time";
}

/**
 * 构建 K 线图配置。
 *
 * 关键约束：
 *  - xAxis 为 category，数据源为 bars 的日期序列。
 *  - 主图与成交量副图共用 xAxisIndex（[0] 与 [0,1]），dataZoom 同时作用于两者，
 *    因此缩放/拖动时成交量天然联动。
 *  - tooltip.axisPointer.type = "cross" 提供十字光标。
 *  - 蜡烛图数据顺序遵循 ECharts 约定：[open, close, low, high]。
 *  - 均线由 lib/indicators 的 calcMAs 计算（MA5/10/20/60），不在此处重复实现。
 */
export function buildKlineOption({
  bars,
  showVolume = true,
  chartType = "candle",
  seriesName,
  maPeriods,
  zoomStart = 55,
  zoomEnd = 100,
  markers = [],
  costLine = null,
  xAxisMode = "date",
}: BuildKlineOptionInput): EChartsOption {
  const dates = bars.map((b) => b.date);
  // x 轴类别：日内 30m 用 HH:MM，其余用交易日。
  // `dates` 始终保留，用于买卖点索引 —— 标记按**交易日**给出，与 x 标签解耦。
  const xLabels =
    xAxisMode === "time"
      ? bars.map((b) => (b.time ? b.time.slice(0, 5) : b.date))
      : dates;
  // ECharts candlestick 数据顺序：[open, close, low, high]
  const candle = bars.map((b) => [b.open, b.close, b.low, b.high]);

  // 均线周期：未传（undefined）则沿用默认 MA_CONFIG；显式传**空数组**表示不画均线。
  // （日内 8 根 30m 场景下 MA5/10/20/60 几乎全为 null —— 只有图例没有线，属噪音。）
  const maConfigs =
    maPeriods === undefined
      ? MA_CONFIG
      : maPeriods.map((n, i) => ({ n, color: MA_PALETTE[i % MA_PALETTE.length] }));
  const maSeries = calcMAs(bars, maConfigs);

  // 买卖点按日期索引，供 tooltip 按 dataIndex 直接取用（不按日期反查，避免重复日期错位）
  const dateIndex = new Map<string, number>();
  dates.forEach((d, i) => {
    if (!dateIndex.has(d)) dateIndex.set(d, i);
  });
  const markersByDate = new Map<string, KlineMarkerInput[]>();
  for (const m of markers) {
    const list = markersByDate.get(m.date);
    if (list) list.push(m);
    else markersByDate.set(m.date, [m]);
  }

  // 买卖点：小方块 + 白色字母（B/S）
  //
  // 造型与分时图（IntradayLineChart 的 scatter 买卖点）保持一致，对齐主流行情软件：
  //   · 方块比三角更容易承载字母，缩放到 11~14px 时字母仍可辨认；
  //   · 买点列在 K 线**下方**、卖点列在**上方**，避免遮住蜡烛实体与影线；
  //   · 颜色沿用涨红跌绿（买=红、卖=绿）。
  // 该样式对回测页的买卖点**同时生效** —— 回测与模拟交易用同一套视觉语言更一致。
  const markPoints = markers.map((m) => {
    const isBuy = m.type === "BUY";
    return {
      name: isBuy ? "买入" : "卖出",
      coord: [m.date, m.price],
      value: m.type,
      symbol: "roundRect",
      symbolSize: 14,
      symbolOffset: [0, isBuy ? 14 : -14],
      itemStyle: { color: isBuy ? KLINE_UP_COLOR : KLINE_DOWN_COLOR },
      label: {
        show: true,
        formatter: isBuy ? "B" : "S",
        fontSize: 10,
        fontWeight: "bold" as const,
        color: "#ffffff",
        position: "inside" as const,
      },
    };
  });

  const volumeBars = bars.map((b) => ({
    value: b.volume,
    itemStyle: {
      color: b.close >= b.open ? KLINE_UP_COLOR : KLINE_DOWN_COLOR,
    },
  }));

  const isLine = chartType === "line";
  const mainName = seriesName ?? (isLine ? "指数" : "K线");
  const legendData = [mainName, ...maConfigs.map((c) => `MA${c.n}`)];
  const xAxisIndex = showVolume ? [0, 1] : [0];

  return {
    animation: false,
    textStyle: { fontSize: 11, color: CHART.textMuted },
    tooltip: {
      trigger: "axis",
      // 十字光标
      axisPointer: { type: "cross", crossStyle: { color: CHART.crosshair } },
      backgroundColor: CHART.surface,
      borderColor: CHART.border,
      borderWidth: 1,
      padding: 10,
      textStyle: { color: CHART.textPrimary, fontSize: 11 },
      extraCssText:
        "box-shadow: 0 4px 16px rgba(0,0,0,0.45); border-radius: 6px;",
      formatter: (params: unknown) => {
        const arr = params as { dataIndex: number }[];
        if (!arr || arr.length === 0) return "";
        // 直接取 dataIndex，避免按日期反查（O(n) 且遇重复日期会错位）
        const idx = arr[0].dataIndex;
        const bar = bars[idx];
        if (!bar) return "";

        const prev = idx > 0 ? bars[idx - 1] : null;
        const chg = prev ? bar.close - prev.close : 0;
        const chgPct = prev && prev.close > 0 ? (chg / prev.close) * 100 : 0;
        const cls = chg >= 0 ? CHART.up : CHART.down;
        const sign = chg >= 0 ? "+" : "";

        const row = (label: string, value: string, color?: string) =>
          `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.7">
             <span style="color:${CHART.textMuted}">${label}</span>
             <span style="color:${color ?? CHART.textPrimary}">${value}</span>
           </div>`;

        const maRows = maSeries
          .map((m) => {
            const v = m.data[idx];
            if (v === null || v === undefined) return "";
            return row(`MA${m.n}`, v.toFixed(2), m.color);
          })
          .join("");

        // 买卖点：按 dataIndex 取当日标记（回测场景才有）
        const dayMarkers = markersByDate.get(bar.date) ?? [];
        const markerRows =
          dayMarkers.length === 0
            ? ""
            : `<div style="border-top:1px solid ${CHART.splitLine};margin:6px 0 4px"></div>` +
              dayMarkers
                .map((mk) => {
                  const isBuy = mk.type === "BUY";
                  const label = isBuy ? "买入" : "卖出";
                  const color = isBuy ? KLINE_UP_COLOR : KLINE_DOWN_COLOR;
                  const qty =
                    mk.quantity === undefined ? "" : ` ${mk.quantity} 股`;
                  return row(
                    label,
                    `@${mk.price.toFixed(2)}${qty}`,
                    color,
                  );
                })
                .join("");

        // 日内 30m 棒带上时刻，避免同一交易日的 8 根 K 在提示框里看起来一模一样
        const header = bar.time ? `${bar.date} ${bar.time.slice(0, 5)}` : bar.date;

        return `
          <div style="min-width:180px">
            <div style="font-weight:600;margin-bottom:6px;color:${CHART.textPrimary}">${header}</div>
            ${row("开盘", bar.open.toFixed(2))}
            ${row("最高", bar.high.toFixed(2))}
            ${row("最低", bar.low.toFixed(2))}
            ${row("收盘", bar.close.toFixed(2), cls)}
            ${row("涨跌幅", `${sign}${chgPct.toFixed(2)}%`, cls)}
            ${row("成交量", `${formatVolume(bar.volume)}股`)}
            ${bar.amount == null ? "" : row("成交额", `¥${formatVolume(bar.amount)}`)}
            <div style="border-top:1px solid ${CHART.splitLine};margin:6px 0 4px"></div>
            ${maRows}
            ${markerRows}
          </div>`;
      },
    },
    legend: {
      data: legendData,
      top: 0,
      right: 10,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { fontSize: 11, color: CHART.textMuted },
    },
    grid: showVolume
      ? [
          { left: 56, right: 18, top: 30, height: "52%" },
          { left: 56, right: 18, top: "70%", height: "16%" },
        ]
      : [{ left: 56, right: 18, top: 30, bottom: 48 }],
    xAxis: showVolume
      ? [
          {
            type: "category",
            data: xLabels,
            boundaryGap: true,
            axisLine: { lineStyle: { color: CHART.axisLine } },
            axisLabel: { fontSize: 10, color: CHART.textMuted, hideOverlap: true },
            splitLine: { show: false },
          },
          {
            type: "category",
            gridIndex: 1,
            data: xLabels,
            boundaryGap: true,
            axisLine: { lineStyle: { color: CHART.axisLine } },
            axisTick: { show: false },
            axisLabel: { show: false },
            splitLine: { show: false },
          },
        ]
      : [
          {
            type: "category",
            data: xLabels,
            boundaryGap: true,
            axisLine: { lineStyle: { color: CHART.axisLine } },
            axisLabel: { fontSize: 10, color: CHART.textMuted, hideOverlap: true },
            splitLine: { show: false },
          },
        ],
    yAxis: showVolume
      ? [
          {
            scale: true,
            splitLine: { lineStyle: { type: "dashed", color: CHART.splitLine } },
            axisLabel: { fontSize: 10, color: CHART.textMuted },
            axisLine: { show: false },
          },
          {
            gridIndex: 1,
            scale: true,
            splitNumber: 2,
            axisLabel: {
              fontSize: 9,
              color: CHART.textMuted,
              formatter: (v: number) => formatVolume(v),
            },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { show: false },
          },
        ]
      : [
          {
            scale: true,
            splitLine: { lineStyle: { type: "dashed", color: CHART.splitLine } },
            axisLabel: { fontSize: 10, color: CHART.textMuted },
            axisLine: { show: false },
          },
        ],
    // 缩放 + 拖动：主图与成交量副图共享 xAxisIndex，天然联动
    dataZoom: [
      {
        type: "inside",
        xAxisIndex,
        start: zoomStart,
        end: zoomEnd,
        // 滚轮缩放 + 拖拽平移
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
      },
      {
        type: "slider",
        xAxisIndex,
        height: 20,
        bottom: 8,
        start: zoomStart,
        end: zoomEnd,
        borderColor: "transparent",
        backgroundColor: CHART.surfaceAlt,
        fillerColor: "rgba(21, 26, 33, 0.5)",
        handleStyle: { color: CHART.textFaint },
        dataBackground: {
          lineStyle: { color: CHART.textFaint },
          areaStyle: { color: CHART.splitLine },
        },
        selectedDataBackground: {
          lineStyle: { color: CHART.textMuted },
          areaStyle: { color: CHART.axisLine },
        },
        textStyle: { fontSize: 10, color: CHART.textMuted },
      },
    ],
    series: [
      isLine
        ? {
            name: mainName,
            type: "line" as const,
            // 折线只看收盘趋势，不画 K 线形态
            data: bars.map((b) => b.close),
            smooth: false,
            showSymbol: false,
            connectNulls: false,
            lineStyle: { width: 1.4, color: INDEX_LINE_COLOR },
            itemStyle: { color: INDEX_LINE_COLOR },
            emphasis: { disabled: true },
          }
        : {
            name: mainName,
            type: "candlestick" as const,
            data: candle,
            itemStyle: {
              // A股习惯：阳线红、阴线绿
              color: KLINE_UP_COLOR,
              color0: KLINE_DOWN_COLOR,
              borderColor: KLINE_UP_COLOR,
              borderColor0: KLINE_DOWN_COLOR,
            },
            // 无标记时不写 markPoint，保持与第三阶段完全一致的结构
            ...(markPoints.length > 0
              ? {
                  markPoint: {
                    silent: true,
                    data: markPoints,
                  },
                }
              : {}),
            /* 成本线（持仓均价）：横向水平虚线 + 价格标签。
               颜色复用「基准线」橙 —— 与分时图的成本线同色，两图对照时一眼能对上，
               且不与阳线红 / 阴线绿冲突。仅在成本价合法时挂载。 */
            ...(typeof costLine === "number" && Number.isFinite(costLine) && costLine > 0
              ? {
                  markLine: {
                    silent: true,
                    symbol: "none",
                    lineStyle: { type: "dashed", color: CHART.benchmark, width: 1 },
                    label: {
                      formatter: `成本 ${costLine.toFixed(2)}`,
                      fontSize: 10,
                      color: CHART.benchmark,
                      position: "insideEndTop",
                    },
                    data: [{ yAxis: costLine }],
                  },
                }
              : {}),
          },
      ...maSeries.map((m) => ({
        name: `MA${m.n}`,
        type: "line" as const,
        data: m.data,
        smooth: true,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 1.2, color: m.color },
        itemStyle: { color: m.color },
        emphasis: { disabled: true },
      })),
      ...(showVolume
        ? [
            {
              name: "成交量",
              type: "bar" as const,
              xAxisIndex: 1,
              yAxisIndex: 1,
              data: volumeBars,
              barWidth: "60%",
            },
          ]
        : []),
    ],
  } as EChartsOption;
}
