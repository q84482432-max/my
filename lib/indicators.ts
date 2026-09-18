/**
 * 技术指标计算 —— 纯函数，无 DOM / 无框架依赖
 *
 * 抽出到此处的理由：
 *  - 指标口径属于业务正确性核心，必须可被单元测试直接验证，
 *    而不应内联在 React 组件里只能靠肉眼核对图表。
 *  - 纯函数便于服务端与客户端复用（未来回测引擎同样需要 MA）。
 */

import type { KlineBar } from "@/types";

/** 均线配置：周期 → 图线颜色（浅色主题下可辨识） */
export interface MAConfig {
  /** 周期长度（如 5 表示 MA5） */
  n: number;
  /** 图线颜色 */
  color: string;
}

/**
 * 本系统使用的均线周期集合。
 * 第三阶段要求：MA5 / MA10 / MA20 / MA60（不含 MACD、RSI 等复杂指标）。
 */
export const MA_CONFIG: MAConfig[] = [
  { n: 5, color: "#f59e0b" }, // 橙
  { n: 10, color: "#3b82f6" }, // 蓝
  { n: 20, color: "#a855f7" }, // 紫
  { n: 60, color: "#14b8a6" }, // 青
];

/**
 * 简单移动平均（SMA）。
 *
 * - 采用滑动窗口累加，时间复杂度 O(n)、空间 O(n)。
 * - 前 n-1 根因样本不足返回 `null`（图线上表现为断点，非 0）。
 * - **不做小数位截断**：前复权价本身有三位小数（如 1418.029），
 *   若在计算阶段就 toFixed(2) 会给均线引入系统性偏差。显示精度由展示层处理。
 * - 不修改入参。
 *
 * @param bars 按交易日期**升序**排列的 K 线
 * @param n    周期长度，必须为正整数
 */
export function calcMA(bars: KlineBar[], n: number): (number | null)[] {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`calcMA: 周期必须为正整数，收到 ${n}`);
  }
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/** 一次性计算全部配置的均线，返回可直接喂给 ECharts 的 series 数据 */
export function calcMAs(
  bars: KlineBar[],
  configs: MAConfig[] = MA_CONFIG,
): { n: number; color: string; data: (number | null)[] }[] {
  return configs.map((c) => ({
    n: c.n,
    color: c.color,
    data: calcMA(bars, c.n),
  }));
}
