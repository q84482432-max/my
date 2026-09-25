/**
 * 通用类型定义 —— 全项目共享
 * 该文件不依赖任何运行时（可同时被 client / server 引用）
 */

/** K线周期 */
export type KlinePeriod = "1d" | "1w" | "1M";

/** 交易方向 */
export type OrderSide = "BUY" | "SELL";

/** 委托类型 */
export type OrderType = "MARKET" | "LIMIT";

/** 委托状态 */
export type OrderStatus =
  | "PENDING"
  | "FILLED"
  | "PARTIAL"
  | "CANCELLED"
  | "REJECTED";

/** 复权口径 */
export type AdjustType = "qfq" | "hfq" | "none";

/** 交易所 */
export type Exchange = "SH" | "SZ" | "BJ";

/** 板块 */
export type BoardType = "MAIN" | "GEM" | "STAR" | "BSE";

/**
 * 单根 K 线（DTO）
 * 注意：这里一律使用 number，Decimal 只在服务层内部出现，
 * 出参统一转 number，避免前端拿到 Prisma.Decimal 无法序列化。
 */
export interface KlineBar {
  /** 交易日 YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量（股） */
  volume: number;
  /** 成交额（元） */
  amount: number;
  /**
   * 30 分钟 K 的**收盘时刻** `HH:MM:SS`（仅 30m 数据有值）。
   *
   * 日K / 周K / 月K 一律不带该字段（保持 `undefined`），因此新增本字段
   * **不影响任何既有调用方**（向后兼容）。
   *
   * 为什么放在 KlineBar 而不是另立一个结构：30m 棒的其余七个字段与日K 完全同构，
   * 统一后它可以被既有的图表 / 指标 / 序列化代码直接消费，不必维护并行 DTO。
   */
  time?: string;
}

/**
 * 30 分钟 K 线（DTO）。
 *
 * 与 `KlineBar` 是**同一套 DTO**，只是把 `time` 从可选收窄为必需：
 *  - 30m 棒可以直接传给任何接受 `KlineBar` 的函数（复用图表/指标）；
 *  - 30m 专属逻辑里可以安全地依赖 `time` 一定存在。
 *
 * 历史上这是 `lib/intraday30m.ts` 内部另立的一个 interface，八个字段与
 * `KlineBar` 完全重复（2026-09-22 审计发现）；现统一到此处，
 * `lib/intraday30m.ts` 仅做 re-export 以保持既有 import 路径不变。
 */
export interface IntradayBar extends KlineBar {
  /** 该 30 分钟 K 的收盘时刻 HH:MM:SS */
  time: string;
}

/** 股票基础信息 DTO */
export interface StockInfo {
  id: string;
  code: string;
  name: string;
  exchange: Exchange;
  board: BoardType;
  industry: string | null;
  listDate: string | null;
  isActive: boolean;
  /** 该股 K 线复权口径（来自真实数据 fq 字段）：qfq | none */
  adjust: AdjustType;
  /** 是否覆盖完整数据窗口（次新股为 false） */
  fullWindow: boolean;
  /** K 线根数 */
  barCount: number;
  /** 数据窗口起始日 YYYY-MM-DD */
  windowStart: string | null;
  /** 数据窗口结束日 YYYY-MM-DD */
  windowEnd: string | null;
}

/** 股票列表项 DTO（列表页轻量出参，不含行情计算） */
export interface StockListItem {
  code: string;
  name: string;
  exchange: Exchange;
  board: BoardType;
  /** K 线根数 */
  barCount: number;
  /** 数据窗口起止 */
  windowStart: string | null;
  windowEnd: string | null;
  /** 该股复权口径 */
  adjust: AdjustType;
  fullWindow: boolean;
}

/** 带最新行情的股票 DTO */
export interface StockQuote extends StockInfo {
  /** 最新收盘价 */
  lastPrice: number;
  /** 涨跌额 */
  change: number;
  /** 涨跌幅 % */
  changePercent: number;
  /** 最新成交量（股） */
  volume: number;
  /** 最新成交额（元）—— 由 close × volume 推导（源数据无 amount 字段） */
  amount: number;
  /**
   * 最新交易日的 开 / 高 / 低。
   *
   * 与 `lastPrice`（= 同一根日K 的 close）**同源**，因此四者口径天然一致。
   * 供个股页头部的「开/高/低」行情块展示（对标同花顺等行情软件）。
   * 无K线数据时为 0。
   */
  open: number;
  high: number;
  low: number;
  /** 上一交易日收盘价（用于涨跌幅校验） */
  prevClose: number;
  /** 最新交易日 */
  lastDate: string | null;
}

/**
 * 指数分类。
 *
 * 刻意不复用 BoardType —— 指数不存在「主板 / 创业板」这种个股板块概念，
 * 把两者塞进同一个联合类型会让「board=GEM 的指数」这种无意义状态变得合法。
 */
export type IndexCategory = "综合指数" | "规模指数" | "板块指数";

/**
 * 指数元信息 DTO。
 *
 * 注意 `code` 一律带交易所前缀（sh000001），而非裸 6 位数字：
 * 裸码在 A 股会与个股大面积撞车（上证指数 000001 vs 平安银行 000001），
 * 这是指数必须独立建表、独立取数路径的根本原因。
 */
export interface IndexInfo {
  id: string;
  /** 带交易所前缀的代码：sh000001 / sz399001 / bj899050 */
  code: string;
  name: string;
  exchange: Exchange;
  category: IndexCategory;
  /** 数据来源：sina | tencent */
  source: string;
  /** K 线根数 */
  barCount: number;
  /** 数据窗口起始日 YYYY-MM-DD */
  windowStart: string | null;
  /** 数据窗口结束日 YYYY-MM-DD */
  windowEnd: string | null;
}

/**
 * 指数日K DTO。
 *
 * 与 KlineBar 的两点差异：
 *  - 无 `amount`：指数不披露成交额，只能取到成交量，凭空推导会造假数据；
 *  - 成交量单位固定为「股」，且**不含复权概念**（指数没有除权除息）。
 */
export interface IndexBar {
  /** 交易日 YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量（股） */
  volume: number;
}

/**
 * 账户汇总 DTO（虚拟账户对外字段）
 *
 * 字段说明：
 *  - `cash` / `marketValue` / `totalAsset` / `totalProfit` / `totalProfitRate`
 *    均为**派生值**，由 tradingEngine 依据「现金 + 持仓 × 最新收盘价」实时计算，
 *    **不落库**。原因：持仓市值随行情变化，落库会立刻过期并产生不一致。
 *    数据库只保存 source of truth：initialCash / availableCash / frozenCash。
 *
 * 恒等关系（tradingEngine 保证）：
 *  - cash        = availableCash + frozenCash
 *  - totalAsset  = cash + marketValue
 *  - totalProfit = totalAsset − initialCash
 *  - totalProfitRate = totalProfit / initialCash × 100
 */
export interface AccountInfo {
  id: string;
  name: string;
  /** 初始资金 */
  initialCash: number;
  /** 现金总额 = availableCash + frozenCash */
  cash: number;
  /** 可用现金（可立即用于买入的金额） */
  availableCash: number;
  /** 冻结资金（挂单占用，当前即时全额成交模式下恒为 0） */
  frozenCash: number;
  /** 持仓市值（按各持仓最新收盘价计算） */
  marketValue: number;
  /** 总资产 = cash + marketValue */
  totalAsset: number;
  /** 累计盈亏 = totalAsset − initialCash */
  totalProfit: number;
  /** 累计收益率 % */
  totalProfitRate: number;
}

/** 持仓 DTO */
export interface PositionInfo {
  id: string;
  stockId: string;
  stockCode: string;
  stockName: string;
  /** 持仓数量（股） */
  quantity: number;
  /** 可卖数量（T+1 约束下，当日买入部分不可卖） */
  availableQty: number;
  /** 持仓成本均价（含买入费用，按 6 位小数落库，此处收敛到 4 位） */
  avgCost: number;
  /** 当前价格 = 最新交易日收盘价 */
  lastPrice: number;
  /** 上一交易日收盘价（今日盈亏的基准） */
  prevClose: number;
  /** 持仓市值 = lastPrice × quantity */
  marketValue: number;
  /** 浮动盈亏 = 市值 − 成本总额 */
  unrealizedPnl: number;
  /** 浮动盈亏率 % */
  unrealizedPnlPercent: number;
  /**
   * 今日盈亏。
   *
   * 口径（与券商「持仓今日盈亏」一致）：
   *  - 昨日及以前持有的部分：以**昨收价**为基准，即 (lastPrice − prevClose) × 数量；
   *  - 当日买入的部分：以**当日买入成本价（含费）**为基准，
   *    即 (lastPrice − 当日买入均价) × 当日买入数量。
   *
   * 为什么不能统一用昨收：本系统市价单以当日收盘价成交，若买入部分也按昨收
   * 计算，刚建仓的持仓会把「买入之前的当日涨跌」整段算作当日收益 —— 属于虚假盈亏。
   * 数据来源：klines（最新/次新交易日收盘价）+ trades（当日买入）。
   */
  todayPnl: number;
}

/** 委托 DTO */
export interface OrderInfo {
  /**
   * 订单编号 —— 即数据库主键 `Order.id`（cuid），全库唯一，
   * 界面「订单编号」列直接展示该值（不做任何自造编号）。
   */
  id: string;
  stockCode: string;
  stockName: string;
  side: OrderSide;
  orderType: OrderType;
  /** 委托价（市价单为 null） */
  price: number | null;
  quantity: number;
  filledQty: number;
  /** 成交均价 */
  filledPrice: number | null;
  status: OrderStatus;
  /** 创建时间（模拟交易下为成交日 YYYY-MM-DD） */
  orderTime: string;
  remark: string | null;
}

/** 成交 DTO */
export interface TradeInfo {
  id: string;
  stockCode: string;
  stockName: string;
  side: OrderSide;
  price: number;
  quantity: number;
  /** 成交金额 = price × quantity */
  amount: number;
  /** 佣金（万三，最低 5 元，双向） */
  commission: number;
  /** 印花税（千一，仅卖出） */
  stampTax: number;
  /** 过户费（万 0.1，双向） */
  transferFee: number;
  /**
   * 手续费合计 = commission + stampTax + transferFee。
   * 由 tradingEngine 统一计算（费用规则只在该文件内定义），
   * 避免各展示层各自求和导致口径漂移。
   */
  totalFee: number;
  /** 该笔卖出实现的盈亏（买入恒为 0） */
  realizedPnl: number;
  /** 成交时间 */
  tradedAt: string;
}

/** 每日资产快照 DTO */
export interface DailyAssetInfo {
  date: string;
  cash: number;
  marketValue: number;
  totalAsset: number;
  totalPnl: number;
  dailyReturn: number;
  totalReturn: number;
}

/** 下单请求 */
export interface PlaceOrderInput {
  accountId: string;
  stockCode: string;
  side: OrderSide;
  orderType?: OrderType;
  /** 限价单必填 */
  price?: number;
  quantity: number;
  /** 成交日期，缺省为最新交易日（历史模拟交易时传入指定日期） */
  tradeDate?: string;
  /**
   * 行情可见上界（YYYY-MM-DD，历史模拟模式专用）。
   *
   * 提供时：① 缺省成交日取该日而非「最新交易日」；
   *        ② 成交日不得晚于该日（显式传入的 tradeDate 同样受约束）；
   *        ③ 该股在该日必须真实有行情（停牌/未上市一律拒绝成交）。
   * 引擎据此在源头阻断「读到未来行情」，不依赖调用方自觉。
   */
  asOfDate?: string;
}

/** 下单结果 */
export interface PlaceOrderResult {
  success: boolean;
  order?: OrderInfo;
  trade?: TradeInfo;
  message: string;
}

/** 收益分析结果 */
export interface PerformanceMetrics {
  /** 期初资产 */
  initialAsset: number;
  /** 期末资产 */
  finalAsset: number;
  /** 累计收益率 % */
  totalReturn: number;
  /** 年化收益率 % */
  annualReturn: number;
  /** 最大回撤 % */
  maxDrawdown: number;
  /** 最大回撤开始日期 */
  maxDrawdownStart: string | null;
  /** 最大回撤结束日期 */
  maxDrawdownEnd: string | null;
  /** 波动率（年化）% */
  volatility: number;
  /** 夏普比率 */
  sharpeRatio: number;
  /** 交易日数 */
  tradingDays: number;
}

/** 净值曲线点 */
export interface EquityPoint {
  date: string;
  totalAsset: number;
  /** 净值（归一化，期初 = 1） */
  nav: number;
  /** 累计收益率 % */
  returnPercent: number;
}

/* ------------------------------------------------------------------ */
/*                     历史模拟交易（Simulation）                       */
/* ------------------------------------------------------------------ */

/** 模拟会话状态 */
export type SimulationStatus = "ACTIVE" | "FINISHED";

/**
 * 历史模拟会话 DTO。
 *
 * `currentDate` 是**唯一**的行情可见上界：界面与接口均不得读取该日之后的任何数据，
 * 该值由服务端持久化并强制，客户端无法通过请求参数覆盖。
 */
export interface SimulationInfo {
  id: string;
  name: string;
  /** 用户选择的开始日期（已对齐到真实交易日） */
  startDate: string;
  /** 用户选择的结束日期 */
  endDate: string;
  /** 初始资金 */
  initialCash: number;
  /** 当前模拟交易日（行情可见上界，始终为真实交易日） */
  currentDate: string;
  status: SimulationStatus;
  /** 区间内真实交易日总数 */
  totalDays: number;
  /** 当前是第几个交易日（从 1 开始；越界为 0） */
  dayIndex: number;
  /** 下一个真实交易日；已到末尾为 null */
  nextDate: string | null;
  /** 本会话独占的账户 ID（与普通模拟账户解耦） */
  accountId: string;
  createdAt: string;
}

/**
 * 模拟会话快照 —— 一个交易日的完整视图。
 *
 * 全部字段均以 `simulation.currentDate` 为上界计算：账户汇总、持仓市值、
 * 每日快照曲线（`curve`）都做过 `date <= currentDate` 的限制，
 * 因此该 DTO 内部不可能混入未来行情。
 */
export interface SimulationSnapshot {
  simulation: SimulationInfo;
  /** 账户汇总（现金 / 市值 / 总资产 / 累计盈亏） */
  summary: AccountInfo;
  positions: PositionInfo[];
  orders: OrderInfo[];
  trades: TradeInfo[];
  /** 每日资产快照曲线（升序，仅含 currentDate 及以前） */
  curve: DailyAssetInfo[];
  /** 绩效指标（收益率 / 年化 / 最大回撤 / 波动率 / 夏普） */
  metrics: PerformanceMetrics;
  /** 当前交易日的当日盈亏额 = 今日总资产 − 上一交易日总资产 */
  dailyPnl: number;
  /** 当前交易日的当日收益率 % */
  dailyReturn: number;
}

/** 模拟模式下的股票行情（截至 currentDate，不含未来数据） */
export interface SimulationQuote {
  code: string;
  name: string;
  /** 截至 currentDate（含）的最后一个交易日；此前无 K 线时为 null */
  lastDate: string | null;
  /** 该日收盘价 */
  close: number;
  /** 前一交易日收盘价（无更早数据时退化为 close） */
  prevClose: number;
  /** 相对前一交易日的涨跌幅 % */
  changePercent: number;
}

/* ------------------------------------------------------------------ */
/*                  模拟炒股（猜股票 SimTrade）                         */
/* ------------------------------------------------------------------ */

/** 模拟炒股会话状态 */
export type SimTradeStatus = "ACTIVE" | "FINISHED";

/**
 * V2 交易阶段（服务端唯一权威，客户端不可干预）。
 *
 * 每个交易日拆成「开盘阶段 + 收盘阶段」两个**独立交易阶段**，每阶段只能完成 1 次操作：
 *  - `OPEN`            开盘阶段 —— 按**当日开盘价**成交
 *  - `OPEN_CONFIRMED`  开盘阶段已完成 1 次有效操作，等待进入收盘
 *  - `CLOSE_ANIMATION` 收盘动画播放中（服务端已揭示当日收盘价，前端仅做展示）
 *  - `CLOSE`           收盘阶段 —— 按**当日收盘价**成交
 *  - `CLOSE_CONFIRMED` 收盘阶段已完成 1 次有效操作，等待当日结算
 *  - `DAY_SETTLED`     当日结算完成，可进入下一交易日
 */
export type SimTradeStage =
  | "OPEN"
  | "OPEN_CONFIRMED"
  | "CLOSE_ANIMATION"
  | "CLOSE"
  | "CLOSE_CONFIRMED"
  | "DAY_SETTLED";

/**
 * `/api/intraday?sessionId=` **会话模式**出参（V3 日内 30m）。
 *
 * 防泄漏要点（全部由服务端强制，客户端不得干预）：
 *  - `bars` 的上界锁死在会话 `currentDate`；**未揭示收盘时只返回当日第一根**（10:00），
 *    即浏览器在 CLOSE_ANIMATION 之前**拿不到**当日 10:30 及之后的任何 K；
 *  - 被污染标记命中的交易日一律返回空数组（污染优先于揭示）；
 *  - **不返回标的代码/名称**（沿用 SIMTRADE 身份隐藏红线）。
 */
export interface SimTradeIntradayInfo {
  mode: "session";
  sessionId: string;
  /** 会话当前模拟日 YYYY-MM-DD */
  date: string;
  stage: SimTradeStage;
  /** 当日已揭示的 30m 根数（0 = 该日无 30m 数据或被污染排除） */
  barCount: number;
  /** 标准根数（8），供前端判断当日日内数据是否可用 */
  expectedBars: number;
  /** 当日收盘价是否已揭示（CLOSE_ANIMATION 起为 true） */
  revealClose: boolean;
  /** V3：服务端实际采用的 30m 可见根数（= 会话游标；收盘揭示后恒为 8） */
  intradayBarCount: number;
  /** 是否已揭示全部 8 根（等价于 `revealClose`） */
  fullDayRevealed: boolean;
  bars: IntradayBar[];
  /** 是否因污染标记被排除 */
  excludedByContamination: boolean;
  /** 本会话区间内被标记的污染日（升序） */
  contaminatedDatesInSession: string[];
  /** `bars.length > 0`。为 false 时前端应回落日K 视图 */
  intradayAvailable: boolean;

  /* ================= V3 分时图契约（2026-09-23 新增） ================= */

  /**
   * **分时图的 0 轴基准** —— 前一交易日的收盘价（前复权）。
   *
   * 口径硬约束：**不是当日开盘价**。涨跌幅一律按
   * `(price - prevClose) / prevClose * 100` 计算。
   *
   * 该值永远来自**已经结算完的历史交易日**，因此不构成任何未来数据泄露。
   * 若该标的在会话区间内没有前一日（首日无历史）→ 为 null，前端应退化为以
   * 当日开盘为基准。
   */
  prevClose: number | null;

  /**
   * 已揭示的分时点，**升序**。
   *
   * 长度 = `barCount + 1`：首点是 **09:30 开盘锚点**（价格 = 第 1 根 30m 的 open，
   * 即 09:30 的真实成交价 —— 第 1 根 30m K 覆盖 09:30~10:00，其 open 就是 09:30 价），
   * 其后每个点对应一根**已揭示**的 30m K 的收盘时刻与收盘价。
   *
   * 为什么要有 09:30 锚点：真实炒股软件的分时图横轴自 09:30 起，
   * 只有 8 个收盘点会让曲线左侧缺一段。锚点用的 `open` 在**第 1 根揭示之后**
   * 即为已知信息，不构成未来数据泄露。
   *
   * 前端只允许渲染本数组，**不得**自行按 `bars` 再切片或用完整日K 补齐；
   * 服务端已按 `intradayBarCount` 裁剪，越界数据根本不存在于响应中。
   */
  ticks: SimTradeIntradayTick[];

  /**
   * 分时图横轴的完整刻度（`HH:MM`，升序）。
   *
   * = `["09:30", 8 个标准收盘时点]`，共 9 个。
   *
   * 仅供前端**画横轴刻度**（避免横轴随揭示进度伸缩抖动）。
   * 横轴刻度不等于数据：未揭示时点在 `ticks` 中不存在。
   */
  times: string[];

  /** 当日**已揭示部分**的累计成交量（= 各已揭示 30m 根 volume 之和） */
  cumVolume: number;

  /** 当前（最后 1 个已揭示节点）的价格；无数据时 null */
  currentPrice: number | null;

  /** 当前价格相对 `prevClose` 的涨跌幅 %；无数据时 null */
  currentChangePercent: number | null;
}

/**
 * 单个分时点（V3 分时图）。
 *
 * 一个点 = 一根 30 分钟 K 的**收盘时刻**与其收盘价。
 * 之所以不暴露 OHLC：分时图只画价格折线，暴露影线就等于多给了一份日内极值信息。
 */
export interface SimTradeIntradayTick {
  /** 时点 `HH:MM`（如 `10:30`），升序排列 */
  time: string;
  /** 该时点价格 = 该根 30m K 的 close（前复权） */
  price: number;
  /** 相对 `prevClose` 的涨跌幅 %（prevClose 缺失时为 null） */
  changePercent: number | null;
  /** 该根 30m K 的成交量 */
  volume: number;
}

/**
 * **当日动态形成中的日K**（V3 核心防泄漏结构）。
 *
 * 语义：当前正在模拟的交易日，其日K**由已经揭示的 30m K 现场合成**，
 * 绝不是数据库里那根已收盘的完整日K。
 *
 *   open   = 第 1 根 30m 的 open
 *   high   = 已揭示各根 high 的最大值
 *   low    = 已揭示各根 low 的最小值
 *   close  = 最后 1 根已揭示 30m 的 close（= 当前价）
 *   volume = 已揭示各根 volume 之和（**绝不提前给全天量**）
 *
 * 进入 `CLOSE_ANIMATION` 之后（8 根全揭示）它才等于当日最终日K，
 * 此时 `finalized = true`。
 */
export interface SimTradeTodayBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  /** 相对前收的涨跌幅 %（`(close - prevClose) / prevClose * 100`） */
  changePercent: number | null;
  /** 已参与合成的 30m 根数（未揭示收盘时 1~7；揭示后 8） */
  revealedBars: number;
  /** 是否已定格为当日最终日K（进入 CLOSE_ANIMATION 之后为 true） */
  finalized: boolean;
  /** 合成数据来源：`INTRADAY_30M` = 由 30m 现场合成；`DAILY_K` = 30m 不可用时的退化口径 */
  source: "INTRADAY_30M" | "DAILY_K";
}

/**
 * 股票池类型：
 *  - `STOCK`    全部 A 股（默认）
 *  - `INDEX`    指数
 *  - `INDUSTRY` 行业板块
 */
export type SimTradePool = "STOCK" | "INDEX" | "INDUSTRY";

/**
 * 单日操作类型（服务端对每日唯一操作的类型化枚举）。
 *  - BUY   加仓（首次买入或补仓）
 *  - SELL  减仓/清仓
 *  - HOLD  观望（不操作）
 */
export type SimTradeAction = "BUY" | "SELL" | "HOLD";

/**
 * 模拟炒股会话 DTO —— **严格不含被隐藏股票的代码/名称**。
 *
 * 玩家只能看到：进度、账户数字、当前可见 K 线（截至 currentDate）、今日开盘价。
 * 被隐藏标的的任何身份信息（代码/名称/行业/基本面）都不会出现在该 DTO 中。
 */
export interface SimTradeInfo {
  id: string;
  name: string;
  /** 初始资金 */
  initialCash: number;
  /** 模拟起始交易日（真实交易日） */
  startDate: string;
  /** 模拟结束交易日（真实交易日） */
  endDate: string;
  /** 当前模拟交易日（行情可见上界） */
  currentDate: string;
  /** 当前可见历史区间起点（含），用于画历史 K 线 */
  historyStart: string;
  status: SimTradeStatus;
  /** 模拟区间内真实交易日总数（进度分母） */
  totalDays: number;
  /** 当前是第几个交易日（从 1 开始；越界为 0） */
  dayIndex: number;
  /** 下一个真实交易日；已到末尾为 null */
  nextDate: string | null;
  /**
   * 上一个真实交易日（**最近一次已结算的交易日**）；首日为 null。
   * 前端用于展示「刚确认那一日的收盘结果 / 成交明细」。
   */
  prevDate: string | null;
  /**
   * 今日是否已完成「确认操作 → 收盘结算」。
   * true：已结算，今日收盘价可公开、不能再操作，可进入下一交易日；
   * false：尚未确认，只公布今日开盘价。
   */
  confirmedToday: boolean;
  /** 本会话独占的账户 ID */
  accountId: string;
  /** 玩家是否已揭晓股票 */
  revealed: boolean;
  createdAt: string;
  /* ---------------- V2 阶段状态机 ---------------- */
  /** 当前交易阶段（服务端唯一权威） */
  stage: SimTradeStage;
  /**
   * 本阶段（时间窗）内是否已经操作过至少一次。
   *
   * ⚠️ V3 起它**不再表示「本阶段不可再操作」** —— 一个阶段内允许多次操作，
   * 「能否继续操作」由 `remainingOps` 决定；它现在只用于展示与「时间可否推进」。
   */
  stageActionCompleted: boolean;
  /** 当日剩余可**买入**次数（上限 2；观望不消耗） */
  remainingBuy: number;
  /** 当日剩余可**卖出**次数（上限 2） */
  remainingSell: number;
  /** 当日**已用**总操作次数（BUY / SELL / HOLD 统一计数） */
  operationCount: number;
  /** 当日**剩余**总操作次数（上限 8）。为 0 时当天操作锁定 */
  remainingOps: number;
  /** 30m 游标：当日已揭示的 30 分钟 K 根数（1~8）。与操作计数**解耦** */
  intradayBarCount: number;
  /** 当前阶段允许揭示的 30m 根数上限（开盘阶段 7 / 其余 8） */
  maxRevealableBars: number;
  /** 当前 30m 时点文案（如 `10:30`） */
  currentIntradayTime: string;
  /** V3 确认模式：服务端待确认的操作（null = 无）。前端 pending 以服务端为准 */
  pendingAction: SimTradeAction | null;
  /** V3 确认模式：待确认操作的比例（HOLD 为 0） */
  pendingPercent: number | null;
  /** 股票池类型 */
  pool: SimTradePool;
}

/**
 * 揭晓结果 DTO —— **仅当玩家主动点击「揭晓股票」后才返回**。
 * 在此之前，任何接口都不得返回这些字段。
 */
export interface SimTradeReveal {
  code: string;
  name: string;
  exchange: Exchange;
  board: BoardType;
  /** 持仓成本均价（若有持仓） */
  avgCost: number;
}

/**
 * 模拟炒股持仓 DTO —— **不含股票代码/名称**（隐藏身份）。
 * 与 PositionInfo 字段口径一致，仅抹去标识信息。
 */
export interface SimTradePosition {
  quantity: number;
  /** 可卖数量（T+1：当日买入不可卖） */
  availableQty: number;
  /** 当日买入、尚不可卖的份额（= quantity − availableQty） */
  todayQty: number;
  avgCost: number;
  lastPrice: number;
  prevClose: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  todayPnl: number;
}

/**
 * 模拟炒股成交回执 DTO —— **不含股票代码/名称**。
 */
export interface SimTradeFill {
  id: string;
  side: OrderSide;
  price: number;
  quantity: number;
  amount: number;
  commission: number;
  stampTax: number;
  transferFee: number;
  totalFee: number;
  realizedPnl: number;
  tradedAt: string;
  /**
   * 成交对应的 **30 分钟时点** `HH:MM`（如 `10:30`），用于在分时图上定位买卖点。
   *
   * 为什么需要单独一个字段：`tradedAt` 存的是**日期**（`YYYY-MM-DD`），
   * 它无法区分「同日 10:00 买入」与「同日 14:30 卖出」—— 而分时图的横轴
   * 恰恰是时点，没有它就画不出买卖点。
   *
   * 取值来源：**由成交价反推**（见 simtradeService 的 `deriveFillBarTimes`）。
   * 依据是「成交价 = 成交那一刻那根 30m K 的 close」这一确定性事实（服务端即以此定价）。
   * 无法确定时为 `null`（例如 30m 数据缺失、退化为日K 口径）—— 此时**不画该点**，
   * 而不是猜一个位置。
   */
  barTime?: string | null;
}

/**
 * 当日成交概览（供图表标注与「做T」识别）。
 *
 * 「做T」定义：**同一交易日内既有买入又有卖出**。
 * A 股 T+1 制度下当日买入不可卖，因此做T 必然是「先卖后买」或「先买（昨天仓位）后卖」
 * 的组合；这里不做先后顺序判断，只按「双向都发生过」认定 —— 这与玩家对「做T」的
 * 口语理解一致，也避免了用真实时间戳去猜模拟时间顺序（两者无映射关系）。
 */
export interface SimTradeTodayTrades {
  /** 当日成交笔数 */
  count: number;
  /** 当日买入笔数 */
  buyCount: number;
  /** 当日卖出笔数 */
  sellCount: number;
  /** 当日买入金额合计 */
  buyAmount: number;
  /** 当日卖出金额合计 */
  sellAmount: number;
  hasBuy: boolean;
  hasSell: boolean;
  /** 双向交易（做T） */
  isDayTrade: boolean;
}

/**
 * 当日操作记录（供前端展示「今日操作 / 结算结果」闭环）。
 */
export interface SimTradeDayRecord {
  /** 操作对应的交易日 */
  date: string;
  /** 当日操作类型 */
  action: SimTradeAction;
  /** 当日成交笔数 */
  fillCount: number;
  /** 当日成交明细（不含标的身份） */
  fills: SimTradeFill[];
  /** 当日成交金额合计 */
  amount: number;
  /** 当日收益额 = 当日总资产 − 上一交易日总资产 */
  dailyPnl: number;
  /** 当日收益率 % */
  dailyReturn: number;
}

/**
 * 模拟炒股会话快照 —— 一个交易日的完整可见视图。
 *
 * 全部行情/估值均以 `currentDate` 为上界计算；`history` 为可见历史 K 线
 * （含当前日，**仅 open**，当日 high/low/close 用占位以避免泄露未来），
 * `openPrice` 为当日开盘价（唯一允许提前揭示的当日价格）。
 */
/**
 * 大盘参照项：一个指数在当前会话的**最新可见点位**与涨跌（只给数，不给图）。
 *
 * 与个股共用同一套防泄漏规则：未确认当日时，最新点位 = **当日开盘**（当日收盘不揭示），
 * `date` 永远不晚于会话 currentDate。
 */
export interface SimTradeBenchmark {
  /** 带交易所前缀的指数代码（如 sh000001 / sz399001） */
  code: string;
  /** 指数名称（如 上证指数 / 深证成指 / 创业板指） */
  name: string;
  /** 最新可见点位对应的交易日 */
  date: string;
  /** 最新可见点位（未确认当日时 = 当日开盘；已确认时 = 当日收盘） */
  value: number;
  /** 相对上一交易日同口径的涨跌额 */
  change: number;
  /** 涨跌幅 % */
  changePercent: number;
}

export interface SimTradeSnapshot {
  session: SimTradeInfo;
  /** 账户汇总（现金 / 市值 / 总资产 / 累计盈亏 / 收益率 / 仓位） */
  summary: AccountInfo;
  /** 仓位比 % = 持仓市值 / 总资产 × 100 */
  positionRatio: number;
  /** 唯一的（隐藏）标的持仓；未持仓时为 null */
  position: SimTradePosition | null;
  /** 可见历史 K 线（升序，含当前日；只到 currentDate 为止，无未来） */
  history: KlineBar[];
  /**
   * 大盘参照：上证指数 / 创业板指 / 科创50 的可见 K 线（升序）。
   *
   * 每一项与个股 `history` **同窗口、同一条防泄漏红线**：右端点同样是 currentDate，
   * 当日未结算时同样只揭示开盘价（high/low/close 用 open 占位）。
   * 纯展示对照，不参与任何交易/估值计算；库里没有该指数时该项 bars 为空数组。
   */
  benchmarks: SimTradeBenchmark[];
  /** 当日开盘价（唯一允许提前揭示的当日价格） */
  openPrice: number;
  /**
   * V3：**前一交易日收盘价**（前复权）—— 分时图 0 轴基准、顶部「前收」展示用。
   *
   * 永远来自已结算完的历史交易日，不构成未来数据泄露。
   * 会话首日（无前一日）时为最后一根可见历史K的收盘，仍为历史数据。
   */
  prevClose: number | null;
  /**
   * 当日收盘价 —— **仅当阶段进入 `CLOSE_ANIMATION` 及之后才返回**；
   * 在 `OPEN` / `OPEN_CONFIRMED` 阶段恒为 `null`（防泄漏：不得提前暴露当日收盘）。
   */
  todayClose: number | null;
  /** 当前交易阶段（冗余自 session，便于前端直接分支） */
  stage: SimTradeStage;
  /** 本阶段成交价：`OPEN` = 开盘价 / `CLOSE` = 收盘价 / 其它阶段为 `null`（不可交易） */
  stageFillPrice: number | null;
  /**
   * 成交价来源（V3 阶段 6）：
   *  - `"INTRADAY_30M"`：取自当前**已揭示的 30m K**（取 close）；
   *  - `"DAILY_K"`：30m 数据不可用时的退化口径（日K 开盘/收盘价）；
   *  - `null`：当前不可交易。
   */
  fillPriceSource: "INTRADAY_30M" | "DAILY_K" | null;
  /** 30m 成交价对应的时点（如 `10:30`）；非 30m 来源时为 `null` */
  fillPriceTime: string | null;
  /** 本阶段（时间窗）内是否已操作过至少一次（V3 起不再是「不可操作」标志） */
  stageActionCompleted: boolean;
  /** 当日剩余可买入次数（上限 2） */
  remainingBuy: number;
  /** 当日剩余可卖出次数（上限 2） */
  remainingSell: number;
  /** 当日已用总操作次数（BUY / SELL / HOLD 统一计数） */
  operationCount: number;
  /** 当日剩余总操作次数（上限 8） */
  remainingOps: number;
  /** 30m 游标：当日已揭示的 30 分钟 K 根数（1~8）。与操作计数解耦 */
  intradayBarCount: number;
  /** 当前阶段允许揭示的 30m 根数上限（开盘阶段 7 / 其余 8） */
  maxRevealableBars: number;
  /** 当前 30m 时点文案（如 `10:30`） */
  currentIntradayTime: string;
  /** V3 确认模式：服务端待确认的操作（null = 无）。前端 pending 以服务端为准 */
  pendingAction: SimTradeAction | null;
  /** V3 确认模式：待确认操作的比例（HOLD 为 0） */
  pendingPercent: number | null;
  /** 当日是否可交易（ACTIVE 且处于 OPEN / CLOSE 阶段且 `remainingOps > 0`） */
  tradable: boolean;
  /** 最近一次操作记录（用于「结算结果」展示）；无操作为 null */
  lastAction: SimTradeDayRecord | null;
  /** 累计交易笔数 */
  tradeCount: number;
  /**
   * 本会话全部成交明细（升序，含 `barTime` 30m 时点）—— 供图表标注买卖点。
   *
   * 防泄漏：数组内**只含已发生**的成交（来自 trades 表），不存在任何未来交易，
   * 因此可以安全下发；这与会「泄露未来」的行情数据是两类东西。
   */
  fills: SimTradeFill[];
  /** 当日成交概览：买卖笔数、金额，以及是否「做T」（当日双向交易） */
  todayTrades: SimTradeTodayTrades;
  /** 每日资产快照曲线（升序，仅含 currentDate 及以前） */
  curve: DailyAssetInfo[];
  /** 绩效指标 */
  metrics: PerformanceMetrics;
  /** 最终结算（仅 FINISHED 时给出）：买入持有基准对照 */
  settlement: SimTradeSettlement | null;
  /**
   * V3：**当日动态形成中的日K**（防泄漏核心）。
   *
   * 与 `history` 末根的关系：`history` 里的当日那根**就是**由本结构写入的
   * （已同步替换为动态值），因此图表均线（MA5/10/20/60）会自动基于动态日K 计算。
   * 本字段额外把「已揭示根数 / 是否定格 / 涨跌幅 / 数据来源」显式暴露出来，
   * 供前端展示与测试断言，避免前端反推到错误结论。
   *
   * 无 30m 数据且未揭示收盘时为 null（此时 `history` 末根退化为 open 占位且
   * **成交量为 0**，绝不泄露全天量）。
   */
  todayBar: SimTradeTodayBar | null;
}

/**
 * 最终结算 DTO（会话结束后）。
 *  - 玩家数据：初始资金 / 最终资产 / 总盈亏 / 收益率 / 交易次数 / 最大仓位 / 最大回撤；
 *  - 对照：**我的交易收益 vs 买入持有收益**（同区间、同费用口径）。
 */
export interface SimTradeSettlement {
  initialCash: number;
  finalAsset: number;
  totalProfit: number;
  totalReturn: number;
  tradeCount: number;
  /** 最大仓位比 %（历史最高 持仓市值/总资产） */
  maxPositionRatio: number;
  /** 最大回撤 %（负值） */
  maxDrawdown: number;
  maxDrawdownStart: string | null;
  maxDrawdownEnd: string | null;
  /** 买入持有收益额 */
  buyHoldProfit: number;
  /** 买入持有收益率 % */
  buyHoldReturn: number;
  /** 我的交易是否跑赢买入持有 */
  beatBuyHold: boolean;
  /** 起始交易日收盘价 */
  startClose: number;
  /** 结束交易日收盘价 */
  endClose: number;
}

/** 创建模拟炒股会话入参 */
export interface CreateSimTradeInput {
  /** 初始资金（默认 100000） */
  initialCash?: number;
  /** 模拟交易日数（默认 22，约束 20~23） */
  tradingDays?: number;
  /** 会话名（可选，仅内部展示） */
  name?: string;
  /** 股票池类型（默认 STOCK 全部 A 股） */
  pool?: SimTradePool;
}

/** 每日提交操作入参 */
export interface SubmitSimTradeActionInput {
  /** 操作类型 */
  action: SimTradeAction;
  /**
   * 操作比例（1~100 的整数）。
   *
   * **BUY / SELL 必须显式给出**：缺省、null、NaN、越界一律拒绝，
   * 绝不静默退化为 100% 满仓（隐式全仓属危险行为）。HOLD 忽略该字段。
   */
  percent?: number;
  /**
   * 执行模式（V3）：
   *  - `"INSTANT"` 立即执行 —— 服务端校验后直接下单成交；
   *  - `"CONFIRM"` 需要确认 —— 服务端先把它落库为 **pending**，再由 `/confirm` 成交。
   *
   * 默认 `"CONFIRM"`（更安全）：只在两种模式下走**同一套**交易规则，
   * 差别仅在「何时执行」，不在「如何执行」。
   */
  mode?: SimTradeExecutionMode;
}

/** V3 执行模式：立即执行 / 需要确认 */
export type SimTradeExecutionMode = "INSTANT" | "CONFIRM";

/* ------------------------------------------------------------------ */
/*                      策略回测（Backtest，第一批）                    */
/* ------------------------------------------------------------------ */

/** 策略标识。第一批只支持均线金叉死叉。 */
export type BacktestStrategyId = "MA_CROSS";

/** MA 金叉死叉策略参数 */
export interface MaCrossParams {
  /** 快线周期（默认 5） */
  fast: number;
  /** 慢线周期（默认 20） */
  slow: number;
}

/** 逐笔事件类型 */
export type BacktestEventType =
  | "GOLDEN_CROSS"
  | "DEATH_CROSS"
  | "BUY"
  | "SELL"
  | "SKIP";

/**
 * 逐笔事件日志 —— 对应「记录每一次：信号 / 价格 / 数量 / 手续费 / 成交 /
 * 现金 / 持仓 / 资产」。
 *
 * 一行 = 一次事件。信号行（GOLDEN_CROSS / DEATH_CROSS）的
 * `quantity` / `amount` / `fee` 为 0，`price` = 信号依据的当日收盘价；
 * 成交行（BUY / SELL）的 `price` = 实际成交价。
 * 无论哪种行，`cash` / `positionQty` / `positionAvgCost` / `marketValue` /
 * `totalAsset` 都是**该事件发生时点之后**的账户状态快照。
 */
export interface BacktestEvent {
  /** 事件序号（1 起，按时间顺序） */
  seq: number;
  /** 事件发生日（信号日或成交日） */
  date: string;
  type: BacktestEventType;
  /** 成交事件对应的信号日（信号行自身为 null） */
  signalDate: string | null;
  /** 事件说明（如「MA5 上穿 MA20」「资金不足，买不起一手」） */
  reason: string;
  /** 价格：信号行 = 当日收盘价；成交行 = 实际成交价 */
  price: number;
  quantity: number;
  amount: number;
  fee: number;
  feeDetail: { commission: number; stampTax: number; transferFee: number };
  /** 成交后可用现金 */
  cash: number;
  /** 成交后持仓数量 */
  positionQty: number;
  /** 成交后持仓成本均价（含费） */
  positionAvgCost: number;
  /** 成交后按**当日收盘价**计的持仓市值 */
  marketValue: number;
  /** 成交后总资产 = cash + marketValue */
  totalAsset: number;
  /** 信号依据的均线值（便于审计，非信号行为 null） */
  maFast: number | null;
  maSlow: number | null;
  /** 卖出行 = 该笔已实现盈亏；买入/信号行为 null */
  realizedPnl: number | null;
}

/** 成交明细（仅成交行，供「交易明细」表展示） */
export interface BacktestTrade {
  seq: number;
  /** 成交日 */
  date: string;
  /** 触发该笔成交的信号日（信号日 ≠ 成交日，因为信号收盘产生、次日开盘成交） */
  signalDate: string;
  side: OrderSide;
  price: number;
  quantity: number;
  amount: number;
  fee: number;
  feeDetail: { commission: number; stampTax: number; transferFee: number };
  cash: number;
  positionQty: number;
  positionAvgCost: number;
  marketValue: number;
  totalAsset: number;
  realizedPnl: number | null;
  reason: string;
}

/** 配对往返（一买一卖为一笔完整交易，用于胜率 / 平均盈亏 / 盈亏比） */
export interface BacktestRoundTrip {
  seq: number;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  quantity: number;
  buyFee: number;
  sellFee: number;
  totalFee: number;
  /** 持有自然日 */
  holdDays: number;
  /** 持有交易日数 */
  holdBars: number;
  /** 盈亏金额（已扣双边费用） */
  pnl: number;
  /** 盈亏率 %（相对买入实际支出） */
  pnlPercent: number;
  win: boolean;
}

/** 资金曲线点（每日一行，按时间升序） */
export interface BacktestEquityPoint {
  date: string;
  /** 当日收盘价 */
  close: number;
  cash: number;
  positionQty: number;
  marketValue: number;
  totalAsset: number;
  /** 净值（首日归一化为 1） */
  nav: number;
  /** 累计收益率 % */
  returnPercent: number;
  /** 当日收益率 % */
  dailyReturn: number;
}

/** 回撤曲线点 */
export interface BacktestDrawdownPoint {
  date: string;
  totalAsset: number;
  /** 截至该日的运行峰值（只看过去，不含未来） */
  peak: number;
  /** 距峰值的回撤 % （≤ 0） */
  drawdownPercent: number;
}

/** 买卖点（打在 K 线图上，取**实际成交**时点） */
export interface BacktestMarker {
  date: string;
  type: "BUY" | "SELL";
  price: number;
  quantity: number;
  signalDate: string;
  reason: string;
}

/** 回测指标（用户要求的 9 项 + 若干审计用补充项） */
export interface BacktestMetrics {
  initialAsset: number;
  finalAsset: number;
  /** 总收益率 % */
  totalReturn: number;
  /** 年化收益率 %（按 244 交易日/年） */
  annualReturn: number;
  /** 最大回撤 %（负值） */
  maxDrawdown: number;
  maxDrawdownStart: string | null;
  maxDrawdownEnd: string | null;
  /** 年化波动率 % */
  volatility: number;
  /** 夏普比率 */
  sharpeRatio: number;
  /** 参与计算的交易日数 */
  tradingDays: number;
  /** 完成的交易次数（一买一卖计 1 次） */
  tradeCount: number;
  winCount: number;
  lossCount: number;
  /** 盈亏恰好为 0 的往返笔数（极少见，通常来自极端小额） */
  flatCount: number;
  /** 胜率 % = 盈利笔数 / 总交易次数 */
  winRate: number;
  /** 平均盈利（仅盈利单的均值，正数） */
  avgWin: number;
  /** 平均亏损（仅亏损单的均值，**负数**） */
  avgLoss: number;
  /**
   * 盈亏比 = 总盈利 / |总亏损|（gross profit factor）。
   * 无亏损单时为 `null`（数学上为无穷，不塞哨兵值误导读者）。
   */
  profitFactor: number | null;
  /** 赔率 = 平均盈利 / |平均亏损|；无亏损单时为 null */
  payoffRatio: number | null;
  totalWin: number;
  totalLoss: number;
  /** 平均持有交易日数 */
  avgHoldDays: number;
  /** 累计手续费 */
  totalFee: number;
  /** 手续费 / 初始资金 % */
  feeRatio: number;
}

/** 基准（买入持有）对照 */
export interface BacktestBenchmark {
  symbol: string;
  name: string;
  /** 区间内买入持有收益率 %（同样扣双边费用，口径与策略一致） */
  returnPercent: number;
  finalAsset: number;
  /** 建仓价 / 期末价 */
  initialPrice: number;
  finalPrice: number;
}

/** 回测入参（提交给 BacktestEngine） */
export interface BacktestInput {
  symbol: string;
  startDate: string;
  endDate: string;
  initialCash: number;
  strategy?: BacktestStrategyId;
  params?: Partial<MaCrossParams>;
}

/** 回测完整结果 */
export interface BacktestResult {
  symbol: string;
  stockName: string;
  /** 该股 K 线复权口径（回测必须与库内口径一致，不可混用） */
  adjust: AdjustType;
  strategy: BacktestStrategyId;
  params: MaCrossParams;
  startDate: string;
  endDate: string;
  /** 实际参与回测的首 / 末个交易日 */
  firstBarDate: string;
  lastBarDate: string;
  barCount: number;
  /**
   * 预热根数：慢线需要 `slow` 根收盘价才能出第一个 MA 值，
   * 因此区间内前 `slow - 1` 根不产生信号（如实暴露，不做静默处理）。
   */
  warmupBars: number;
  /** 首个信号日（无信号为 null） */
  firstSignalDate: string | null;
  /** 成交价模型：信号在 T 日收盘产生，T+1 日**开盘价**成交（杜绝未来函数） */
  executionModel: "NEXT_OPEN";
  initialCash: number;
  metrics: BacktestMetrics;
  benchmark: BacktestBenchmark | null;
  events: BacktestEvent[];
  trades: BacktestTrade[];
  roundTrips: BacktestRoundTrip[];
  equityCurve: BacktestEquityPoint[];
  drawdownCurve: BacktestDrawdownPoint[];
  markers: BacktestMarker[];
  /** 区间内日K（供 K 线图与买卖点标注使用） */
  bars: KlineBar[];
  /** 提示 / 警告（如区间过短、预热未完成、频繁交易触发最低佣金等） */
  warnings: string[];
}

/**
 * 回测详情（持久化记录 + 完整结果）。
 *
 * DB 只存计算结果（source of truth 的 K 线不落第二份），因此
 * `bars` 由详情接口按 `firstBarDate ~ lastBarDate` + 该股 `adjust` 口径
 * 现取自 MarketDataService —— 与回测当时引擎读到的是同一批数据。
 */
export interface BacktestDetail extends BacktestResult {
  id: string;
  name: string;
  createdAt: string;
}

/** 回测历史记录（列表项，不含大数组） */
export interface BacktestSummary {
  id: string;
  name: string;
  symbol: string;
  stockName: string | null;
  strategy: BacktestStrategyId;
  params: MaCrossParams;
  startDate: string;
  endDate: string;
  initialCash: number;
  finalAsset: number | null;
  totalReturn: number | null;
  annualReturn: number | null;
  maxDrawdown: number | null;
  sharpeRatio: number | null;
  winRate: number | null;
  tradeCount: number;
  status: string;
  createdAt: string;
}
