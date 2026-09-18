import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind class 合并工具 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 数字格式化：千分位 */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 金额格式化（¥ 前缀） */
export function formatMoney(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "--";
  return `¥${formatNumber(value, digits)}`;
}

/** 百分比格式化 */
export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

/** 大数字缩写：1.2万 / 3.4亿 */
export function formatVolume(value: number): string {
  if (!Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toString();
}

/**
 * 涨跌颜色类名 —— A股习惯：涨红跌绿
 */
export function pnlColorClass(value: number): string {
  if (value > 0) return "text-stock-up";
  if (value < 0) return "text-stock-down";
  return "text-stock-flat";
}

/** 日期 -> YYYY-MM-DD */
export function toDateStr(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "--";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 根据股票代码推断交易所与板块 */
/**
 * 板块推断（纯代码前缀规则，交易所无关）。
 * 北交所板块只可能来自 920 段；科创板仅沪市 688/689；创业板仅深市 300/301。
 */
function inferBoard(c: string): "MAIN" | "GEM" | "STAR" | "BSE" {
  if (/^(920|43|83|87)/.test(c)) return "BSE";
  if (/^(688|689)/.test(c)) return "STAR";
  if (/^(300|301)/.test(c)) return "GEM";
  return "MAIN";
}

/**
 * 数据源 setcode → 交易所。
 * 本项目真实行情数据（通达信导出）中 setcode 与 universe.csv 的 market 字段一致：
 *   0 = 深市(SZ)  1 = 沪市(SH)  2 = 北交所(BJ)
 */
export function setcodeToExchange(
  setcode: string | number | null | undefined,
): "SH" | "SZ" | "BJ" | null {
  if (setcode === null || setcode === undefined) return null;
  switch (String(setcode).trim()) {
    case "0":
      return "SZ";
    case "1":
      return "SH";
    case "2":
      return "BJ";
    default:
      return null;
  }
}

/**
 * 由代码前缀推断交易所与板块（**无 setcode 时的兜底**）。
 *
 * ⚠️ 注意局限：本函数无法区分「沪市指数 000300」与「深市主板 000001」
 * 这类同前缀跨市场情况。若调用方持有数据源的 setcode，请改用
 * `resolveExchangeAndBoard(code, setcode)`，以 setcode 为权威来源。
 */
export function inferExchangeAndBoard(code: string): {
  exchange: "SH" | "SZ" | "BJ";
  board: "MAIN" | "GEM" | "STAR" | "BSE";
} {
  const c = code.replace(/\D/g, "");
  // 北交所：920 段（原 43/83/87 段已整体平移至 920）
  if (/^(920|43|83|87)/.test(c)) return { exchange: "BJ", board: "BSE" };
  // 科创板：688 / 689
  if (/^(688|689)/.test(c)) return { exchange: "SH", board: "STAR" };
  // 创业板：300 / 301
  if (/^(300|301)/.test(c)) return { exchange: "SZ", board: "GEM" };
  // 沪市主板：600/601/603/605
  if (/^(600|601|603|605)/.test(c)) return { exchange: "SH", board: "MAIN" };
  // 深市主板：000/001/002/003
  if (/^(000|001|002|003)/.test(c)) return { exchange: "SZ", board: "MAIN" };
  // 兜底：深市主板
  return { exchange: "SZ", board: "MAIN" };
}

/**
 * 交易所 + 板块解析（**优先使用数据源 setcode**）。
 *
 * setcode 是数据源给出的权威市场归属，能正确区分同前缀跨市场的情况
 * （如沪市 000300 与深市 000001）。仅当 setcode 缺失或非法时，
 * 才回退到代码前缀推断。
 */
export function resolveExchangeAndBoard(
  code: string,
  setcode?: string | number | null,
): { exchange: "SH" | "SZ" | "BJ"; board: "MAIN" | "GEM" | "STAR" | "BSE" } {
  const c = code.replace(/\D/g, "");
  const fromSetcode = setcodeToExchange(setcode);
  if (fromSetcode) {
    const board = inferBoard(c);
    // 交易所与板块需自洽：北交所板块只可能属于 BJ；
    // 若 setcode 与 920 段冲突，以 920 规则为准（北交所唯一性更强）。
    if (board === "BSE") return { exchange: "BJ", board: "BSE" };
    if (board === "STAR") return { exchange: "SH", board: "STAR" };
    if (board === "GEM") return { exchange: "SZ", board: "GEM" };
    return { exchange: fromSetcode, board };
  }
  return inferExchangeAndBoard(code);
}
