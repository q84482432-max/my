"use client";

import * as React from "react";
import ReactECharts from "echarts-for-react";
import type { KlinePeriod } from "@/types";
import { buildKlineOption, type ChartBar, type KlineMarkerInput } from "@/lib/klineChartOption";

interface KlineChartProps {
  /**
   * K 线数据（升序）。
   *
   * 用 `ChartBar` 而非 `KlineBar`：指数不披露成交额，其 `IndexBar` 没有 `amount` 字段，
   * 图表会自动省略 tooltip 的成交额行（详见 lib/klineChartOption.ts 的 ChartBar）。
   */
  bars: ChartBar[];
  period?: KlinePeriod;
  /** 图表高度（px） */
  height?: number;
  /** 是否显示成交量副图 */
  showVolume?: boolean;
  /**
   * 主图形态（默认 "candle"）。
   *  - "candle"：蜡烛图（个股 K 线）
   *  - "line"  ：收盘价折线（指数对照用）
   * 成交量副图、均线、缩放联动在两种形态下完全一致。
   */
  chartType?: "candle" | "line";
  /** 主图系列名（图例用；默认 candle→"K线"、line→"指数"） */
  seriesName?: string;
  /** 均线周期集合（可选，默认 MA5/10/20/60；如 [5, 20]） */
  maPeriods?: number[];
  loading?: boolean;
  /** 买卖点标记（回测用，可选） */
  markers?: KlineMarkerInput[];
  /** 持仓成本价（可选）：画一条横向成本线 */
  costLine?: number | null;
  /** dataZoom 初始窗口（默认 55~100，即显示最近 45%；回测建议 0~100 全览） */
  zoomStart?: number;
  zoomEnd?: number;
  /**
   * x 轴标签取法（默认 "date"）。
   * 日内 30m 图传 "time"（显示 HH:MM）；**仅限单交易日的 bars**，
   * 约束与理由见 lib/klineChartOption.ts 的 `BuildKlineOptionInput.xAxisMode`。
   */
  xAxisMode?: "date" | "time";
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
  chartType = "candle",
  seriesName,
  maPeriods,
  loading = false,
  markers,
  costLine,
  /* 默认值与 buildKlineOption 内部保持一致（55~100 = 显示最近 45%）。
     在这里显式给出而不是沿用 undefined：dataZoom 受控化后，组件层需要持有
     start/end 的**具体数值**（state 的类型不能是 undefined）。 */
  zoomStart = 55,
  zoomEnd = 100,
  xAxisMode,
}: KlineChartProps) {
  /*
   * dataZoom **受控化**（2026-09-24 修复用户反馈的缺陷）。
   *
   * 缺陷：本组件用 `notMerge` 渲染，option 重建会**整体替换** ECharts 状态 ——
   * 包括 dataZoom。于是玩家在日K 上把时间条拖到较早日期后，只要发生一次下单
   * （`fills` 变化 → option 重建），时间条就跳回默认窗口，拖到的位置丢失。
   *
   * 解法：把 start/end 提升为组件 state，由 `datazoom` 事件回写。
   * 重建 option 时传的是**玩家拖到的位置**，因此下单不再影响缩放。
   *
   * 为什么不能简单去掉 `notMerge`：那会让新旧 option 合并，切换数据源
   * （如日K ↔ 30m、回测/指数复用同一组件）时可能残留上一份的 series 配置。
   * 受控化是更可控的做法 —— 状态由我们掌握，而不是交给 ECharts 的合并规则。
   */
  const [zoom, setZoom] = React.useState<{ start: number; end: number }>({
    start: zoomStart,
    end: zoomEnd,
  });

  // 数据窗口变化（换日 / 换会话）→ 回到默认窗口：新的一天应当看到最新行情，
  // 而不是停留在上一局拖到的历史位置。**只在 bars 长度变化时触发** ——
  // 下单（fills 变化）不会重置，这正是本次修复要保住的行为。
  const prevLenRef = React.useRef(bars.length);
  React.useEffect(() => {
    if (prevLenRef.current !== bars.length) {
      prevLenRef.current = bars.length;
      setZoom({ start: zoomStart, end: zoomEnd });
    }
  }, [bars.length, zoomStart, zoomEnd]);

  const option = React.useMemo(
    () =>
      buildKlineOption({
        bars,
        showVolume,
        chartType,
        seriesName,
        maPeriods,
        markers,
        costLine,
        zoomStart: zoom.start,
        zoomEnd: zoom.end,
        xAxisMode,
      }),
    [
      bars,
      showVolume,
      chartType,
      seriesName,
      maPeriods,
      markers,
      costLine,
      zoom.start,
      zoom.end,
      xAxisMode,
    ],
  );

  /*
   * 把 ECharts 的 datazoom 事件写回 state。
   * 拖动时会**高频触发**，因此这里做了判重：值没变就原样返回同一个对象，
   * React 会跳过重渲染，避免拖动过程被 setState 拖慢。
   */
  const onEvents = React.useMemo(
    () => ({
      datazoom: (params: unknown) => {
        const batch = (params as { batch?: unknown[] } | undefined)?.batch;
        const p = (Array.isArray(batch) ? batch[0] : params) as
          | { start?: number; end?: number }
          | undefined;
        if (typeof p?.start !== "number" || typeof p?.end !== "number") return;
        const next = { start: p.start, end: p.end };
        setZoom((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
      },
    }),
    [],
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
      onEvents={onEvents}
      style={{ height, width: "100%" }}
      showLoading={loading}
      notMerge
      lazyUpdate
      opts={{ renderer: "canvas" }}
    />
  );
}
