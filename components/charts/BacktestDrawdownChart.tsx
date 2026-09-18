"use client";

import * as React from "react";
import ReactECharts from "echarts-for-react";
import type { BacktestDrawdownPoint } from "@/types";
import { buildBacktestDrawdownOption } from "@/lib/backtestChartOption";

interface BacktestDrawdownChartProps {
  points: BacktestDrawdownPoint[];
  height?: number;
}

/**
 * 回测回撤曲线（ECharts 薄壳）。
 *
 * 全部配置由纯函数 `buildBacktestDrawdownOption` 构建
 * （见 lib/backtestChartOption.ts），组件只负责渲染与空态。
 *
 * 口径（与最大回撤严格同源）：`peak_i = max(asset_0..asset_i)` —— 运行峰值
 * **只向后看**，因此 `min(drawdownPercent)` 恒等于 `metrics.maxDrawdown`。
 * 曲线全部 ≤ 0，纵轴上限锁 0；越深表示距历史峰值跌得越多。
 */
export default function BacktestDrawdownChart({
  points,
  height = 260,
}: BacktestDrawdownChartProps) {
  const option = React.useMemo(
    () => buildBacktestDrawdownOption({ points }),
    [points],
  );

  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
        style={{ height }}
      >
        暂无回撤数据
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
