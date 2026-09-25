/**
 * 技术指标计算 —— 纯函数，无 DOM / 无框架依赖
 *
 * 抽出到此处的理由：
 *  - 指标口径属于业务正确性核心，必须可被单元测试直接验证，
 *    而不应内联在 React 组件里只能靠肉眼核对图表。
 *  - 纯函数便于服务端与客户端复用（未来回测引擎同样需要 MA）。
 */

import type { KlineBar } from "@/types";
import { CHART } from "@/lib/chartPalette";

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
  { n: 5, color: CHART.ma[0] }, // 橙 MA5
  { n: 10, color: CHART.ma[1] }, // 蓝 MA10
  { n: 20, color: CHART.ma[2] }, // 紫 MA20
  { n: 60, color: CHART.ma[3] }, // 青 MA60
];

/** 自定义均线周期的取色调色板（按周期顺序循环取色） */
export const MA_PALETTE: string[] = [
  CHART.ma[0], // 橙 MA5
  CHART.ma[1], // 蓝 MA10
  CHART.ma[2], // 紫 MA20
  CHART.ma[3], // 青 MA60
  CHART.ma[4], // 红
  CHART.ma[5], // 绿
  CHART.ma[6], // 靛
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
export function calcMA(bars: Pick<KlineBar, "close">[], n: number): (number | null)[] {
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

/**
 * 一次性计算全部配置的均线，返回可直接喂给 ECharts 的 series 数据。
 *
 * 参数只要求 `close`：均线用不到成交量/成交额，放宽后指数（`IndexBar`，
 * 无 amount 字段）也能直接传入 —— 见 lib/klineChartOption.ts 的 ChartBar。
 */
export function calcMAs(
  bars: Pick<KlineBar, "close">[],
  configs: MAConfig[] = MA_CONFIG,
): { n: number; color: string; data: (number | null)[] }[] {
  return configs.map((c) => ({
    n: c.n,
    color: c.color,
    data: calcMA(bars, c.n),
  }));
}

/* ------------------------------------------------------------------ */
/*                    二期扩展：成交量均线 / MACD                       */
/* ------------------------------------------------------------------ */

/**
 * 指数移动平均（EMA）—— MACD 的基础组件。
 *
 * ## 口径选择（重要，影响与行情软件的对齐）
 *
 * EMA 有「种子值」的自由度：第一根用 `close[0]` 递推、还是先用前 n 根 SMA 播种，
 * 会让前 20~30 根出现可见差异。**国内行情软件（通达信 / 同花顺）采用前者**：
 * `EMA[0] = close[0]`，随后 `EMA[i] = EMA[i-1] + k × (close[i] − EMA[i-1])`，
 * `k = 2 / (n + 1)`。本函数按此实现，以便与用户熟悉的软件读数一致。
 *
 * ⚠️ 由于是递推，**前 `n` 根的 EMA 尚不稳定**（种子效应衰减中）。
 * 图表上不必隐藏，但不宜据此做交易判断 —— 这一点在 MACD 里会继承。
 *
 * 无未来函数：`EMA[i]` 只依赖 `close[0..i]`。
 *
 * @param values 收盘价序列（长度 ≥ 1）
 * @param n 周期
 * @returns 与入参等长的 EMA 序列；空输入返回空数组
 */
export function calcEMA(values: number[], n: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (n + 1);
  const out: number[] = new Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i += 1) {
    out[i] = out[i - 1] + k * (values[i] - out[i - 1]);
  }
  return out;
}

/** MACD 参数（国内默认 12 / 26 / 9） */
export interface MACDConfig {
  /** 快线周期，默认 12 */
  fast: number;
  /** 慢线周期，默认 26 */
  slow: number;
  /** 信号线周期，默认 9 */
  signal: number;
}

export const MACD_CONFIG: MACDConfig = { fast: 12, slow: 26, signal: 9 };

/** MACD 计算结果（三条序列，均与入参等长） */
export interface MACDResult {
  /** 快慢线之差：`EMA(fast) − EMA(slow)` */
  dif: number[];
  /** DIF 的 EMA(signal)，即信号线 DEA */
  dea: number[];
  /** 柱状值。**按国内习惯 = 2 × (DIF − DEA)**（欧美软件常不乘 2） */
  macd: number[];
}

/**
 * MACD(12, 26, 9) —— 因果指标，无未来函数。
 *
 * 计算链：`DIF = EMA12 − EMA26` → `DEA = EMA9(DIF)` → `柱 = 2 × (DIF − DEA)`。
 *
 * ## 为什么柱状值乘 2
 *
 * `DIF − DEA` 的绝对量级很小（尤其低价股），乘 2 是国内行情软件的统一做法，
 * 使柱子的高度与主图价格尺度更协调。这与「MACD 是放大版 DIF-DEA」的直觉一致，
 * 但**不改变零轴穿越位置**（乘正常数不改变符号），因此不影响到多空判读。
 *
 * ## 柱状值的着色约定
 *
 * 返回的 `macd[i]` 只给数值。**着色规则由展示层决定**：
 *   - 柱 > 0 → 红（A股上涨色）；柱 < 0 → 绿
 *   - 但同花顺等软件还会进一步区分「柱子比前一根长/短」的深浅（放量/缩量）。
 *     本项目只做「按符号着色」这一层，不做深浅分级 —— 理由见 `lib/klineChartOption.ts`。
 *
 * @param bars 日K 等序列（只取 `close`）
 * @param config 可选，覆盖默认的 12/26/9
 */
export function calcMACD(
  bars: Pick<KlineBar, "close">[],
  config: MACDConfig = MACD_CONFIG,
): MACDResult {
  const { fast, slow, signal } = config;
  const closes = bars.map((b) => b.close);
  if (closes.length === 0) return { dif: [], dea: [], macd: [] };

  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const dif = emaFast.map((v, i) => v - emaSlow[i]);
  const dea = calcEMA(dif, signal);
  const macd = dif.map((v, i) => 2 * (v - dea[i]));

  return { dif, dea, macd };
}

/**
 * 取各条均线的**最新值**，供图表上方的「均线数值图例行」使用
 * （如同花顺日K 上方的 `M5:15.82 M10:15.84 M20:12.93 M30:11.23`）。
 *
 * 返回的最后一项是**最后一个非 null 值**而非数组末位 —— 因为当数据长度
 * 小于均线周期时末尾会是 null，直接取末位会让图例显示成 `--`（实际有值可用时不该如此）。
 * 全部为 null 时 `value` 为 `null`。
 */
export function latestMAValues(
  bars: Pick<KlineBar, "close">[],
  configs: MAConfig[] = MA_CONFIG,
): { n: number; color: string; value: number | null }[] {
  return configs.map((c) => {
    const series = calcMA(bars, c.n);
    let value: number | null = null;
    for (let i = series.length - 1; i >= 0; i -= 1) {
      if (series[i] !== null) {
        value = series[i];
        break;
      }
    }
    return { n: c.n, color: c.color, value };
  });
}

/**
 * 对**任意数值序列**计算简单移动平均 —— 成交量均线（`量 M5 / M10`）复用此函数。
 *
 * 为什么不复用 `calcMA`：`calcMA` 的入参类型是 `Pick<KlineBar,"close">`，
 * 只认 `close` 字段；成交量均线需要按 `volume` 计算。为了让两者共用同一套
 * 滑动窗口逻辑（而不是复制一份、日后口径漂移），这里提供按序列计算的版本。
 *
 * 窗口内出现 `null` 时该点返回 `null`（与 `calcMA` 在样本不足时的行为一致）。
 * 不做小数位截断；不修改入参。
 */
export function calcMAFromValues(values: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null) as (number | null)[];
  if (n <= 0) return out;
  let sum = 0;
  let validCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v !== null) {
      sum += v;
      validCount += 1;
    }
    if (i >= n) {
      const drop = values[i - n];
      if (drop !== null) {
        sum -= drop;
        validCount -= 1;
      }
    }
    if (i >= n - 1 && validCount === n) out[i] = sum / n;
  }
  return out;
}
