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
import { MA_CONFIG, calcMAs } from "@/lib/indicators";
import { formatVolume } from "@/lib/utils";

/** A股涨跌色（与 globals.css 的 --stock-up / --stock-down 一致） */
export const KLINE_UP_COLOR = "hsl(0, 84%, 50%)";
export const KLINE_DOWN_COLOR = "hsl(142, 71%, 40%)";

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

export interface BuildKlineOptionInput {
  /** 必须按交易日期升序 */
  bars: KlineBar[];
  /** 是否显示成交量副图（默认 true） */
  showVolume?: boolean;
  /** dataZoom 初始窗口起点百分比（默认 55，即默认显示最近 45%） */
  zoomStart?: number;
  /** dataZoom 初始窗口终点百分比（默认 100） */
  zoomEnd?: number;
  /**
   * 买卖点标记（可选）。不传时图表与第三阶段完全一致 ——
   * 标记只作为**附加图层**叠在蜡烛图上，不新增 series、不改动既有结构。
   */
  markers?: KlineMarkerInput[];
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
  zoomStart = 55,
  zoomEnd = 100,
  markers = [],
}: BuildKlineOptionInput): EChartsOption {
  const dates = bars.map((b) => b.date);
  // ECharts candlestick 数据顺序：[open, close, low, high]
  const candle = bars.map((b) => [b.open, b.close, b.low, b.high]);
  const maSeries = calcMAs(bars);

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

  // 买卖点图钉：买入 = 红三角朝上（置于K线下方），卖出 = 绿三角朝下（置于K线上方）
  const markPoints = markers.map((m) => {
    const isBuy = m.type === "BUY";
    return {
      name: isBuy ? "买入" : "卖出",
      coord: [m.date, m.price],
      value: m.type,
      symbol: "triangle",
      symbolSize: 11,
      symbolRotate: isBuy ? 0 : 180,
      symbolOffset: [0, isBuy ? 15 : -15],
      itemStyle: {
        color: isBuy ? KLINE_UP_COLOR : KLINE_DOWN_COLOR,
        borderColor: "#ffffff",
        borderWidth: 1,
      },
    };
  });

  const volumeBars = bars.map((b) => ({
    value: b.volume,
    itemStyle: {
      color: b.close >= b.open ? KLINE_UP_COLOR : KLINE_DOWN_COLOR,
    },
  }));

  const legendData = ["K线", ...MA_CONFIG.map((c) => `MA${c.n}`)];
  const xAxisIndex = showVolume ? [0, 1] : [0];

  return {
    animation: false,
    textStyle: { fontSize: 11, color: "#3f3f46" },
    tooltip: {
      trigger: "axis",
      // 十字光标
      axisPointer: { type: "cross", crossStyle: { color: "#a1a1aa" } },
      backgroundColor: "rgba(255, 255, 255, 0.98)",
      borderColor: "#e4e4e7",
      borderWidth: 1,
      padding: 10,
      textStyle: { color: "#18181b", fontSize: 11 },
      extraCssText:
        "box-shadow: 0 4px 16px rgba(0,0,0,0.12); border-radius: 6px;",
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
        const cls = chg >= 0 ? "#dc2626" : "#16a34a";
        const sign = chg >= 0 ? "+" : "";

        const row = (label: string, value: string, color?: string) =>
          `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.7">
             <span style="color:#71717a">${label}</span>
             <span style="color:${color ?? "#18181b"}">${value}</span>
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
            : `<div style="border-top:1px solid #e4e4e7;margin:6px 0 4px"></div>` +
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

        return `
          <div style="min-width:180px">
            <div style="font-weight:600;margin-bottom:6px;color:#18181b">${bar.date}</div>
            ${row("开盘", bar.open.toFixed(2))}
            ${row("最高", bar.high.toFixed(2))}
            ${row("最低", bar.low.toFixed(2))}
            ${row("收盘", bar.close.toFixed(2), cls)}
            ${row("涨跌幅", `${sign}${chgPct.toFixed(2)}%`, cls)}
            ${row("成交量", `${formatVolume(bar.volume)}股`)}
            ${row("成交额", `¥${formatVolume(bar.amount)}`)}
            <div style="border-top:1px solid #e4e4e7;margin:6px 0 4px"></div>
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
      textStyle: { fontSize: 11, color: "#52525b" },
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
            data: dates,
            boundaryGap: true,
            axisLine: { lineStyle: { color: "#d4d4d8" } },
            axisLabel: { fontSize: 10, color: "#71717a", hideOverlap: true },
            splitLine: { show: false },
          },
          {
            type: "category",
            gridIndex: 1,
            data: dates,
            boundaryGap: true,
            axisLine: { lineStyle: { color: "#d4d4d8" } },
            axisTick: { show: false },
            axisLabel: { show: false },
            splitLine: { show: false },
          },
        ]
      : [
          {
            type: "category",
            data: dates,
            boundaryGap: true,
            axisLine: { lineStyle: { color: "#d4d4d8" } },
            axisLabel: { fontSize: 10, color: "#71717a", hideOverlap: true },
            splitLine: { show: false },
          },
        ],
    yAxis: showVolume
      ? [
          {
            scale: true,
            splitLine: { lineStyle: { type: "dashed", color: "#e4e4e7" } },
            axisLabel: { fontSize: 10, color: "#71717a" },
            axisLine: { show: false },
          },
          {
            gridIndex: 1,
            scale: true,
            splitNumber: 2,
            axisLabel: {
              fontSize: 9,
              color: "#71717a",
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
            splitLine: { lineStyle: { type: "dashed", color: "#e4e4e7" } },
            axisLabel: { fontSize: 10, color: "#71717a" },
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
        backgroundColor: "#f4f4f5",
        fillerColor: "rgba(24, 24, 27, 0.08)",
        handleStyle: { color: "#a1a1aa" },
        dataBackground: {
          lineStyle: { color: "#a1a1aa" },
          areaStyle: { color: "#e4e4e7" },
        },
        selectedDataBackground: {
          lineStyle: { color: "#71717a" },
          areaStyle: { color: "#d4d4d8" },
        },
        textStyle: { fontSize: 10, color: "#71717a" },
      },
    ],
    series: [
      {
        name: "K线",
        type: "candlestick",
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
