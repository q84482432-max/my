"use client";

import * as React from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import type { EquityPoint } from "@/types";

interface EquityChartProps {
  points: EquityPoint[];
  height?: number;
  loading?: boolean;
}

/**
 * 净值曲线图（收益分析）
 * 展示账户总资产与累计收益率随时间的走势。
 * 数据来自 tradingEngine.getEquityCurve()（基于真实持仓与真实行情计算）。
 */
export default function EquityChart({
  points,
  height = 320,
  loading = false,
}: EquityChartProps) {
  const option = React.useMemo<EChartsOption>(() => {
    const dates = points.map((p) => p.date);
    const nav = points.map((p) => p.nav);
    const ret = points.map((p) => p.returnPercent);

    return {
      animation: false,
      textStyle: { fontSize: 11 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(24, 24, 27, 0.92)",
        borderWidth: 0,
        textStyle: { color: "#fafafa", fontSize: 11 },
        formatter: (params: unknown) => {
          const arr = params as { axisValue: string }[];
          if (!arr || arr.length === 0) return "";
          const p = points.find((x) => x.date === arr[0].axisValue);
          if (!p) return "";
          const cls = p.returnPercent >= 0 ? "#ef4444" : "#22c55e";
          const sign = p.returnPercent >= 0 ? "+" : "";
          return `
            <div style="min-width:150px">
              <div style="font-weight:600;margin-bottom:6px">${p.date}</div>
              <div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#a1a1aa">总资产</span><span>¥${p.totalAsset.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
              <div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#a1a1aa">净值</span><span>${p.nav.toFixed(4)}</span></div>
              <div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#a1a1aa">收益率</span><span style="color:${cls}">${sign}${p.returnPercent.toFixed(2)}%</span></div>
            </div>`;
        },
      },
      legend: {
        data: ["总资产", "累计收益率"],
        top: 0,
        right: 10,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { fontSize: 11 },
      },
      grid: { left: 62, right: 58, top: 28, bottom: 28 },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLabel: { fontSize: 10, hideOverlap: true },
        axisLine: { lineStyle: { color: "#a1a1aa" } },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: "value",
          scale: true,
          name: "总资产",
          nameTextStyle: { fontSize: 10 },
          axisLabel: {
            fontSize: 10,
            formatter: (v: number) =>
              Math.abs(v) >= 1e4 ? `${(v / 1e4).toFixed(1)}万` : v.toFixed(0),
          },
          splitLine: { lineStyle: { type: "dashed", opacity: 0.35 } },
          axisLine: { show: false },
        },
        {
          type: "value",
          scale: true,
          name: "收益率%",
          nameTextStyle: { fontSize: 10 },
          axisLabel: { fontSize: 10, formatter: "{value}%" },
          splitLine: { show: false },
          axisLine: { show: false },
        },
      ],
      dataZoom: [
        { type: "inside", start: 0, end: 100 },
      ],
      series: [
        {
          name: "总资产",
          type: "line",
          data: points.map((p) => p.totalAsset),
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.6, color: "#3b82f6" },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(59,130,246,0.22)" },
                { offset: 1, color: "rgba(59,130,246,0.02)" },
              ],
            },
          },
        },
        {
          name: "累计收益率",
          type: "line",
          yAxisIndex: 1,
          data: ret,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.6, color: "#f59e0b" },
          markLine: {
            silent: true,
            symbol: "none",
            data: [{ yAxis: 0 }],
            lineStyle: { color: "#a1a1aa", type: "dashed", opacity: 0.6 },
            label: { show: false },
          },
        },
      ],
    } as EChartsOption;
  }, [points]);

  if (!loading && points.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
        style={{ height }}
      >
        暂无净值数据（账户产生交易后将自动生成资产曲线）
      </div>
    );
  }

  return (
    <ReactECharts
      option={option}
      style={{ height, width: "100%" }}
      showLoading={loading}
      notMerge
      lazyUpdate
      opts={{ renderer: "canvas" }}
    />
  );
}
