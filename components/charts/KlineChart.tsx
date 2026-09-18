"use client";

import * as React from "react";
import ReactECharts from "echarts-for-react";
import type { KlineBar, KlinePeriod } from "@/types";
import { buildKlineOption, type KlineMarkerInput } from "@/lib/klineChartOption";

interface KlineChartProps {
  bars: KlineBar[];
  period?: KlinePeriod;
  /** 图表高度（px） */
  height?: number;
  /** 是否显示成交量副图 */
  showVolume?: boolean;
  loading?: boolean;
  /** 买卖点标记（回测用，可选） */
  markers?: KlineMarkerInput[];
  /** dataZoom 初始窗口（默认 55~100，即显示最近 45%；回测建议 0~100 全览） */
  zoomStart?: number;
  zoomEnd?: number;
}

/**
 * K线图组件（ECharts 薄壳）
 *
 * 功能（第三阶段要求）：
 *  - 蜡烛图 + MA5 / MA10 / MA20 / MA60（不含 MACD、RSI 等复杂指标）
 *  - 成交量副图，与主图共享 x 轴、随 dataZoom 联动
 *  - 缩放（滚轮/双指 + 底部滑块）
 *  - 拖动（滑块拖拽 + 主图平移）
 *  - 十字光标（axisPointer.type = "cross"）
 *  - tooltip 展示 OHLC / 涨跌幅 / 成交量 / 成交额 / 各条均线
 *
 * 数据契约：
 *  - bars 必须按交易日期**升序**（由 marketDataService 保证）。
 *  - 周K/月K 由服务端从日K 聚合，本组件不做任何周期换算与数据生成。
 *  - 颜色遵循 A股习惯：涨红跌绿（与欧美相反）。
 *  - 主题：跟随应用浅色主题（浅底深字），不使用深色面板。
 *
 * 说明：全部图表配置由纯函数 buildKlineOption 构建（见 lib/klineChartOption.ts），
 * 便于脱离浏览器做确定性单测；本组件只负责渲染与 loading 态。
 */
export default function KlineChart({
  bars,
  height = 460,
  showVolume = true,
  loading = false,
  markers,
  zoomStart,
  zoomEnd,
}: KlineChartProps) {
  const option = React.useMemo(
    () => buildKlineOption({ bars, showVolume, markers, zoomStart, zoomEnd }),
    [bars, showVolume, markers, zoomStart, zoomEnd],
  );

  if (!loading && bars.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
        style={{ height }}
      >
        暂无K线数据（请先导入真实历史行情）
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
