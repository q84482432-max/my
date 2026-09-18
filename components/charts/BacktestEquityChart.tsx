"use client";

import * as React from "react";
import ReactECharts from "echarts-for-react";
import type { BacktestEquityPoint } from "@/types";
import { buildBacktestEquityOption } from "@/lib/backtestChartOption";

interface BacktestEquityChartProps {
  points: BacktestEquityPoint[];
  /** 初始资金（画一条保本参考线） */
  initialCash: number;
  /** 买入持有基准的期末资产（画一条横向参考线，非曲线 —— 不编造路径） */
  benchmarkFinalAsset?: number | null;
  height?: number;
}

/**
 * 回测资金曲线（ECharts 薄壳）。
 *
 * 全部配置由纯函数 `buildBacktestEquityOption` 构建（见 lib/backtestChartOption.ts），
 * 组件只负责渲染与空态，便于脱离浏览器做确定性单测。
 *
 * 口径：总资产 = 现金 + 持仓市值（按当日收盘价），逐交易日一行；
 * 累计收益率 = (总资产 − 初始资金) / 初始资金。参考线只画水平线。
 */
export default function BacktestEquityChart({
  points,
  initialCash,
  benchmarkFinalAsset,
  height = 340,
}: BacktestEquityChartProps) {
  const option = React.useMemo(
    () => buildBacktestEquityOption({ points, initialCash, benchmarkFinalAsset }),
    [points, initialCash, benchmarkFinalAsset],
  );

  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
        style={{ height }}
      >
        暂无资金曲线
      </div>
    );
  }

  return (
    <ReactECharts
      option={option}
      style={{ height, width: "100%" }}
      notMerge
      lazyUpdate
      opts={{ renderer: "canvas" }}
    />
  );
}
