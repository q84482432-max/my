/**
 * 业务常量 —— 交易规则、费用、周期映射
 * 所有规则集中在此，避免散落在各页面中。
 */

/** 佣金费率（万分之三，双向收取） */
export const COMMISSION_RATE = 0.0003;
/** 佣金最低收取金额（元） */
export const COMMISSION_MIN = 5;
/** 印花税（千分之一，仅卖出） */
export const STAMP_TAX_RATE = 0.001;
/** 过户费（万分之0.1，双向，沪深两市） */
export const TRANSFER_FEE_RATE = 0.00001;

/** 一手 = 100 股 */
export const LOT_SIZE = 100;

/** 默认初始资金（模拟账户） */
export const DEFAULT_INITIAL_CASH = 100_000;

/** 周期中文标签 */
export const PERIOD_LABELS: Record<string, string> = {
  "1d": "日K",
  "1w": "周K",
  "1M": "月K",
};

/** 周期对应的 API 查询参数 */
export const PERIOD_PARAMS = ["1d", "1w", "1M"] as const;

/** 交易所标签 */
export const EXCHANGE_LABELS: Record<string, string> = {
  SH: "上海证券交易所",
  SZ: "深圳证券交易所",
  BJ: "北京证券交易所",
};

/** 板块标签 */
export const BOARD_LABELS: Record<string, string> = {
  MAIN: "主板",
  GEM: "创业板",
  STAR: "科创板",
  BSE: "北交所",
};

/** 复权口径标签 */
export const ADJUST_LABELS: Record<string, string> = {
  qfq: "前复权",
  hfq: "后复权",
  none: "不复权",
};

/**
 * 真实数据源中文板块 → 内部英文枚举 + 交易所 的映射表。
 * 仅供导入适配层使用，保证「数据口径」与「类型系统口径」解耦。
 */
export const BOARD_CN_TO_ENUM: Record<
  string,
  { board: "MAIN" | "GEM" | "STAR" | "BSE"; exchange: "SH" | "SZ" | "BJ" }
> = {
  沪主板: { board: "MAIN", exchange: "SH" },
  深主板: { board: "MAIN", exchange: "SZ" },
  创业板: { board: "GEM", exchange: "SZ" },
  科创板: { board: "STAR", exchange: "SH" },
  北交所: { board: "BSE", exchange: "BJ" },
};

/** 真实数据源复权标记 → 内部 AdjustType 映射 */
export const SOURCE_FQ_TO_ADJUST: Record<string, "qfq" | "none"> = {
  qfq: "qfq",
  raw: "none",
};

/**
 * 内部英文板块枚举 → 中文标签（展示层用）。
 * 注意：MAIN 同时对应「沪主板」与「深主板」，需结合 exchange 才能唯一确定，
 * 因此此处仅作为兜底显示；统计场景请用 BOARD_STAT_LABEL。
 */
export const BOARD_ENUM_TO_LABEL: Record<string, string> = {
  MAIN: "主板",
  GEM: "创业板",
  STAR: "科创板",
  BSE: "北交所",
};

/**
 * 「板块枚举 + 交易所」→ 中文板块标签。
 * 用于把 MAIN 拆回沪深主板，与真实数据源的 5 分类口径对齐。
 */
export function boardStatLabel(board: string, exchange: string): string {
  if (board === "MAIN") return exchange === "SH" ? "沪主板" : "深主板";
  return BOARD_ENUM_TO_LABEL[board] ?? board;
}

/** 默认复权口径（真实数据以 qfq 为主，5430/5558） */
export const DEFAULT_ADJUST = "qfq";

/** 委托状态标签 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "待成交",
  FILLED: "已成交",
  PARTIAL: "部分成交",
  CANCELLED: "已撤单",
  REJECTED: "已拒绝",
};
