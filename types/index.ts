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
  /** 当日开盘价（唯一允许提前揭示的当日价格） */
  openPrice: number;
  /** 当日是否可交易（当前日为真实交易日且未结束） */
  tradable: boolean;
  /** 最近一次操作记录（用于「结算结果」展示）；无操作为 null */
  lastAction: SimTradeDayRecord | null;
  /** 累计交易笔数 */
  tradeCount: number;
  /** 每日资产快照曲线（升序，仅含 currentDate 及以前） */
  curve: DailyAssetInfo[];
  /** 绩效指标 */
  metrics: PerformanceMetrics;
  /** 最终结算（仅 FINISHED 时给出）：买入持有基准对照 */
  settlement: SimTradeSettlement | null;
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
}

/** 每日提交操作入参 */
export interface SubmitSimTradeActionInput {
  /** 操作类型 */
  action: SimTradeAction;
  /** BUY/SELL 时的比例档位（0~100，整数） */
  percent?: number;
}

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
