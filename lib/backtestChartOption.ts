/**
 * 回测图表 ECharts 配置构建 —— 纯函数（无 React / DOM 依赖）
 *
 * 抽出的理由与 `lib/klineChartOption.ts` 一致：
 *   图表配置（双轴绑定、参考线、回撤面积、dataZoom 联动）属于功能正确性的一部分，
 *   但这些图表原先只能靠肉眼看图确认。抽成纯函数后可直接对配置结构断言，
 *   做到**确定性验证** —— 不需要启动浏览器。
 *
 * 口径约束（与 BacktestEngine 严格一致）：
 *  - 资金曲线：总资产按**当日收盘价**估值，累计收益率 = (总资产 − 初始资金)/初始资金。
 *  - 参考线只画**水平线**（初始资金 / 买入持有期末值），**不虚构基准的中间路径**。
 *  - 回撤曲线：`peak_i = max(asset_0..asset_i)`（只向后看），取值恒 ≤ 0，
 *    最低点即最大回撤；A股习惯用绿色表现「跌」。
 */

import type { EChartsOption } from "echarts";
import type { BacktestDrawdownPoint, BacktestEquityPoint } from "@/types";
import { CHART } from "@/lib/chartPalette";

/** K线同款涨跌色（深底上略提亮，A股涨红跌绿） */
const UP_COLOR = CHART.up;
const DOWN_COLOR = CHART.down;
/** 初始资金参考线：中性灰 */
const NEUTRAL_COLOR = CHART.textMuted;
const BENCH_COLOR = CHART.benchmark;

const AXIS_LABEL = { fontSize: 10, color: CHART.textMuted };
const AXIS_LINE = { lineStyle: { color: CHART.axisLine } };

/** 统一的深色主题 tooltip（深底浅字，与 K 线图一致） */
function lightTooltip(formatter: (params: unknown) => string) {
  return {
    trigger: "axis" as const,
    backgroundColor: CHART.surface,
    borderColor: CHART.border,
    borderWidth: 1,
    padding: 10,
    textStyle: { color: CHART.textPrimary, fontSize: 11 },
    extraCssText: "box-shadow: 0 4px 16px rgba(0,0,0,0.45); border-radius: 6px;",
    formatter,
  };
}

function rowHtml(label: string, value: string, color?: string): string {
  return `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.7"><span style="color:${CHART.textMuted}">${label}</span><span style="color:${color ?? CHART.textPrimary}">${value}</span></div>`;
}

export interface BuildEquityOptionInput {
  points: BacktestEquityPoint[];
  /** 初始资金（画保本参考线） */
  initialCash: number;
  /** 买入持有基准的期末资产（画横向参考线，画不出中间路径就不画） */
  benchmarkFinalAsset?: number | null;
}

/**
 * 资金曲线配置。
 *  - 左轴：总资产（line + area），双 yAxis 的 0 号轴；
 *  - 右轴：累计收益率 %（line），yAxisIndex = 1；
 *  - markLine：初始资金（灰虚线）+ 买入持有期末（橙虚线）。
 */
export function buildBacktestEquityOption({
  points,
  initialCash,
  benchmarkFinalAsset,
}: BuildEquityOptionInput): EChartsOption {
  const dates = points.map((p) => p.date);
  const assets = points.map((p) => p.totalAsset);
  const rets = points.map((p) => p.returnPercent);

  const refLines: { yAxis: number; label: string; color: string }[] = [
    { yAxis: initialCash, label: "初始资金", color: NEUTRAL_COLOR },
  ];
  if (benchmarkFinalAsset && benchmarkFinalAsset > 0) {
    refLines.push({
      yAxis: benchmarkFinalAsset,
      label: "买入持有期末",
      color: BENCH_COLOR,
    });
  }

  return {
    animation: false,
    textStyle: { fontSize: 11, color: CHART.textMuted },
    tooltip: lightTooltip((params) => {
      const arr = params as { dataIndex: number }[];
      if (!arr || arr.length === 0) return "";
      const p = points[arr[0].dataIndex];
      if (!p) return "";
      const cls = p.totalAsset >= initialCash ? CHART.up : CHART.down;
      const sign = p.returnPercent >= 0 ? "+" : "";
      return `
        <div style="min-width:190px">
          <div style="font-weight:600;margin-bottom:6px;color:${CHART.textPrimary}">${p.date}</div>
          ${rowHtml("收盘价", p.close.toFixed(2))}
          ${rowHtml("现金", `¥${p.cash.toFixed(2)}`)}
          ${rowHtml("持仓", `${p.positionQty} 股`)}
          ${rowHtml("持仓市值", `¥${p.marketValue.toFixed(2)}`)}
          ${rowHtml("总资产", `¥${p.totalAsset.toFixed(2)}`, cls)}
          ${rowHtml("累计收益率", `${sign}${p.returnPercent.toFixed(2)}%`, cls)}
          ${rowHtml("当日收益率", `${p.dailyReturn >= 0 ? "+" : ""}${p.dailyReturn.toFixed(2)}%`)}
        </div>`;
    }),
    legend: {
      data: ["总资产", "累计收益率"],
      top: 0,
      right: 10,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { fontSize: 11, color: CHART.textMuted },
    },
    grid: { left: 66, right: 60, top: 30, bottom: 46 },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLine: AXIS_LINE,
      axisLabel: { ...AXIS_LABEL, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value",
        scale: true,
        name: "总资产",
        nameTextStyle: { fontSize: 10, color: CHART.textMuted },
        axisLabel: {
          ...AXIS_LABEL,
          formatter: (v: number) =>
            Math.abs(v) >= 1e4 ? `${(v / 1e4).toFixed(1)}万` : v.toFixed(0),
        },
        splitLine: { lineStyle: { type: "dashed", color: CHART.splitLine } },
        axisLine: { show: false },
      },
      {
        type: "value",
        scale: true,
        name: "收益率%",
        nameTextStyle: { fontSize: 10, color: CHART.textMuted },
        axisLabel: { ...AXIS_LABEL, formatter: "{value}%" },
        splitLine: { show: false },
        axisLine: { show: false },
      },
    ],
    dataZoom: [
      { type: "inside", start: 0, end: 100 },
      {
        type: "slider",
        height: 18,
        bottom: 6,
        start: 0,
        end: 100,
        borderColor: "transparent",
        backgroundColor: CHART.surfaceAlt,
        fillerColor: "rgba(21, 26, 33, 0.5)",
        handleStyle: { color: CHART.textFaint },
        textStyle: { fontSize: 10, color: CHART.textMuted },
      },
    ],
    series: [
      {
        name: "总资产",
        type: "line",
        data: assets,
        smooth: false,
        showSymbol: false,
        lineStyle: { width: 1.6, color: CHART.equity },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(91, 147, 245, 0.20)" },
              { offset: 1, color: "rgba(91, 147, 245, 0.02)" },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: "none",
          data: refLines.map((r) => ({
            yAxis: r.yAxis,
            lineStyle: { color: r.color, type: "dashed" as const, width: 1 },
            label: {
              formatter: r.label,
              fontSize: 9,
              color: r.color,
              position: "insideEndTop" as const,
            },
          })),
        },
      },
      {
        name: "累计收益率",
        type: "line",
        yAxisIndex: 1,
        data: rets,
        smooth: false,
        showSymbol: false,
        lineStyle: { width: 1.4, color: CHART.loss },
      },
    ],
  } as EChartsOption;
}

export interface BuildDrawdownOptionInput {
  points: BacktestDrawdownPoint[];
}

/** 回撤曲线配置：面积向下、绿色（A股跌色）、markLine 标注最大回撤。 */
export function buildBacktestDrawdownOption({
  points,
}: BuildDrawdownOptionInput): EChartsOption {
  const dates = points.map((p) => p.date);
  const dd = points.map((p) => p.drawdownPercent);
  const low = points.reduce((a, p) => Math.min(a, p.drawdownPercent), 0);
  const lowDate = points.find((p) => p.drawdownPercent === low)?.date;

  return {
    animation: false,
    textStyle: { fontSize: 11, color: CHART.textMuted },
    tooltip: lightTooltip((params) => {
      const arr = params as { dataIndex: number }[];
      if (!arr || arr.length === 0) return "";
      const p = points[arr[0].dataIndex];
      if (!p) return "";
      return `
        <div style="min-width:180px">
          <div style="font-weight:600;margin-bottom:6px;color:${CHART.textPrimary}">${p.date}</div>
          ${rowHtml("总资产", `¥${p.totalAsset.toFixed(2)}`)}
          ${rowHtml("运行峰值", `¥${p.peak.toFixed(2)}`)}
          ${rowHtml("回撤", `${p.drawdownPercent.toFixed(2)}%`, DOWN_COLOR)}
        </div>`;
    }),
    grid: { left: 66, right: 60, top: 22, bottom: 34 },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLine: AXIS_LINE,
      axisLabel: { ...AXIS_LABEL, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      // 回撤恒 ≤ 0，纵轴上限锁 0
      max: 0,
      axisLabel: { ...AXIS_LABEL, formatter: "{value}%" },
      splitLine: { lineStyle: { type: "dashed", color: CHART.splitLine } },
      axisLine: { show: false },
    },
    dataZoom: [{ type: "inside", start: 0, end: 100 }],
    series: [
      {
        name: "回撤",
        type: "line",
        data: dd,
        smooth: false,
        showSymbol: false,
        lineStyle: { width: 1.4, color: DOWN_COLOR },
        areaStyle: { color: "rgba(47, 184, 119, 0.16)" },
        markLine: {
          silent: true,
          symbol: "none",
          data: [
            {
              yAxis: low,
              lineStyle: { color: DOWN_COLOR, type: "dashed" as const, width: 1 },
              label: {
                formatter: `最大回撤 ${low.toFixed(2)}%${lowDate ? ` (${lowDate})` : ""}`,
                fontSize: 9,
                color: CHART.profit,
                position: "insideEndBottom" as const,
              },
            },
          ],
        },
      },
    ],
  } as EChartsOption;
}

/** 供测试断言的颜色常量（避免测试里硬编码魔数） */
export const BACKTEST_CHART_COLORS = {
  up: UP_COLOR,
  down: DOWN_COLOR,
  neutral: NEUTRAL_COLOR,
  benchmark: BENCH_COLOR,
} as const;
