/**
 * simtradeService —— 模拟炒股（猜股票）会话
 *
 * 玩法定位：
 *  - 服务端从**真实历史日K**中随机抽取 1 只标的并**隐藏身份**；
 *    玩家只看得到 K 线与价格，猜不出是哪只股票，凭盘感做多/做空（本玩法仅做多）。
 *  - 复用同一套交易规则：一切费用/T+1/资金校验/持仓/盈亏**只在 tradingEngine.ts**，
 *    本文件不复制任何买卖逻辑，只负责：随机选股 / 会话推进 / 快照读取 / 身份隐藏。
 *
 * 防未来数据泄露（核心约束，比历史模拟更严格）：
 *  - 会话 `currentDate` 是**唯一**允许读取行情的上界，服务端强制，接口不接受
 *    客户端覆盖；所有取价都走 <= 语义的 marketDataService / tradingEngine 接口。
 *  - 下单时把 `asOfDate = currentDate` 下沉给引擎；引擎拒绝晚于该日的成交日，
 *    也拒绝「该股当日无行情（停牌）」的委托。
 *  - **返回给前端的 K 线只到 currentDate 为止**；当日这根K线只暴露 **open**，
 *    其 high/low/close 用 open 占位（前端只展示开盘信息），
 *    避免玩家在「今日未结算」时从图表读到今日收盘——那会提前泄露当日操作依据。
 *  - **被隐藏标的的代码/名称绝不出现在任何 DTO 中**（除非玩家主动揭晓）。
 *
 * 交易日历：创建会话时固化「可见历史 + 模拟区间」的真实交易日数组，推进只走该日历。
 */

import prisma from "@/lib/prisma";
import type {
  AccountInfo,
  AdjustType,
  CreateSimTradeInput,
  DailyAssetInfo,
  Exchange,
  BoardType,
  KlineBar,
  OrderSide,
  PerformanceMetrics,
  SimTradeAction,
  SimTradeDayRecord,
  SimTradeFill,
  SimTradeInfo,
  SimTradePosition,
  SimTradeReveal,
  SimTradeSettlement,
  SimTradeSnapshot,
  SimTradeStatus,
  SubmitSimTradeActionInput,
  TradeInfo,
} from "@/types";
import {
  calcPerformance,
  createAccount,
  getAccountSummary,
  getPositions,
  getTrades,
  placeOrder,
  refreshDailyAsset,
  settleT1,
} from "@/services/tradingEngine";
import {
  getKlineAt,
  getKlineRange,
  getKlines,
  getStockInfoByCode,
  listCandidatesCoveringRange,
  listCodesHavingKlines,
  listRandomCodesHavingKlines,
  listTradingDates,
  normalizeDate,
} from "@/services/marketDataService";
import { toDateStr } from "@/lib/utils";
import { DEFAULT_INITIAL_CASH } from "@/lib/constants";

/** 模拟炒股会话归属的演示用户（与其它玩法共用 demo 用户） */
const SIMTRADE_USERNAME = "demo";

/** 默认模拟交易日数（约 1 个月），约束在 [MIN,MAX] */
const DEFAULT_TRADING_DAYS = 22;
const MIN_TRADING_DAYS = 20;
const MAX_TRADING_DAYS = 23;
/** 模拟开始日前必须保留的可见历史K线根数（供玩家研判） */
const MIN_HISTORY_BARS = 60;
/** 抽中标的必须具备的最少K线根数（含历史 + 模拟期） */
const MIN_TOTAL_BARS = MIN_HISTORY_BARS + MAX_TRADING_DAYS;
/** 随机选股候选池上限（每次创建会话最多尝试的股票数，防止极端情况下过长扫描） */
const MAX_CANDIDATE_TRIES = 60;

/** Prisma Decimal/BigInt -> number */
function dec(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return parseFloat(v) || 0;
  const anyV = v as { toNumber?: () => number; toString?: () => string };
  if (typeof anyV.toNumber === "function") return anyV.toNumber();
  if (typeof anyV.toString === "function") return parseFloat(anyV.toString()) || 0;
  return 0;
}

/** 四舍五入到 n 位 */
function round(v: number, digits = 2): number {
  const p = Math.pow(10, digits);
  return Math.round(v * p) / p;
}

/**
 * 把库中存储的复权口径字符串收敛为 `AdjustType`。
 * 数据库列类型为 String，取值只可能是 qfq/hfq/none；非法值退化为 qfq。
 */
function toAdjust(v: string | null | undefined): AdjustType {
  return v === "qfq" || v === "hfq" || v === "none" ? v : "qfq";
}

/** 会话查询统一字段（避免各处 select 漂移） */
const SESSION_SELECT = {
  id: true,
  name: true,
  hiddenStockCode: true,
  adjust: true,
  initialCash: true,
  startDate: true,
  endDate: true,
  historyStart: true,
  historyEnd: true,
  currentDate: true,
  confirmedDate: true,
  calendar: true,
  totalDays: true,
  status: true,
  revealed: true,
  createdAt: true,
  account: { select: { id: true } },
} as const;

type SessionRow = {
  id: string;
  name: string;
  hiddenStockCode: string;
  adjust: string;
  initialCash: unknown;
  startDate: Date;
  endDate: Date;
  historyStart: Date;
  historyEnd: Date;
  currentDate: Date;
  confirmedDate: Date | null;
  calendar: string;
  totalDays: number;
  status: string;
  revealed: boolean;
  createdAt: Date;
  account: { id: string } | null;
};

/** 解析固化的交易日历（容错：JSON 解析失败时退化为单日） */
function parseCalendar(raw: string, fallback: Date): string[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "string") {
      return arr as string[];
    }
  } catch {
    /* 忽略，走 fallback */
  }
  return [toDateStr(fallback)];
}

/** Session 行 → SimTradeInfo DTO（**不含被隐藏标的的任何身份信息**） */
function toSimTradeInfo(row: SessionRow): SimTradeInfo {
  const calendar = parseCalendar(row.calendar, row.currentDate);
  const current = toDateStr(row.currentDate);
  const idx = calendar.indexOf(current);
  return {
    id: row.id,
    name: row.name,
    initialCash: dec(row.initialCash),
    startDate: toDateStr(row.startDate),
    endDate: toDateStr(row.endDate),
    currentDate: current,
    historyStart: toDateStr(row.historyStart),
    status: (row.status as SimTradeStatus) ?? "ACTIVE",
    totalDays: row.totalDays > 0 ? row.totalDays : calendar.length,
    dayIndex: idx >= 0 ? idx + 1 : 0,
    nextDate: idx >= 0 && idx + 1 < calendar.length ? calendar[idx + 1] : null,
    prevDate: idx > 0 ? calendar[idx - 1] : null,
    confirmedToday: row.confirmedDate !== null && toDateStr(row.confirmedDate) === current,
    accountId: row.account?.id ?? "",
    revealed: row.revealed,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*                          随机选股                                   */
/* ------------------------------------------------------------------ */

/**
 * 随机抽取一只符合条件的标的。
 *
 * 过滤条件（全部基于**真实数据**，绝不伪造）：
 *  1. 该股为活跃标的且有 K 线；
 *  2. 在 [historyStart, endDate] 区间内，**模拟起始日之前至少有 MIN_HISTORY_BARS 根**，
 *     模拟区间内每个真实交易日都得有 K 线（保证不因停牌导致无法交易）；
 *  3. 数据完整、无缺口（区间内 K 线根数 = 真实交易日数）。
 *
 * 实现策略：先随机打乱候选股票代码池，逐个校验；校验失败自动换下一只。
 * 全部失败（极端情况）返回 null，由上层报错，绝不退回造假数据。
 */
async function pickRandomTarget(input: {
  /** 模拟区间第一个交易日 */
  simStart: string;
  /** 模拟区间最后一个交易日 */
  simEnd: string;
  /** 模拟区间的真实交易日数组（升序） */
  simCalendar: string[];
}): Promise<{ code: string; adjust: AdjustType; historyStart: string; historyEnd: string } | null> {
  // 随机候选池：用 SQL 层随机排序直接取 N 只，避免把全市场 5558 只代码拉进内存再洗牌。
  // 随机性由 ORDER BY RANDOM() 保证，等价于「从全市场无放回等概率抽取 MAX_CANDIDATE_TRIES 只」。
  const allCodes = await listRandomCodesHavingKlines(MAX_CANDIDATE_TRIES);
  if (allCodes.length === 0) return null;

  // 候选预筛：一次性批量取回「K 线根数 >= MIN_TOTAL_BARS」的候选，以及其数据窗口
  // 是否覆盖模拟结束日。避免在 for 循环里对每只股票做 2~3 次串行往返。
  //
  // 命中候选（通常 10~40 只）才做完整的 K 线拉取与「模拟期逐日完备性」校验。
  const prefiltered = await listCandidatesCoveringRange(
    allCodes,
    input.simEnd,
    MIN_TOTAL_BARS,
  );
  if (prefiltered.length === 0) return null;

  const simStartMs = new Date(`${input.simStart}T00:00:00`).getTime();

  // 随机顺序遍历命中候选（预筛已用随机池，此处保持池内顺序即可）
  for (let k = 0; k < prefiltered.length; k += 1) {
    const cand = prefiltered[k];
    const code = cand.code;
    const adjust: AdjustType = toAdjust(cand.adjust);

    // 取 [range.start, simEnd] 区间的日K（用于切分历史段 / 模拟段）
    const bars = await getKlines(code, {
      period: "1d",
      adjust,
      startDate: cand.start,
      endDate: input.simEnd,
      limit: 100000,
    });
    if (bars.length < MIN_TOTAL_BARS) continue;

    // 切分：模拟起始日之前的K线为历史段
    const historyBars = bars.filter((b) => b.date < input.simStart);
    const simBars = bars.filter((b) => b.date >= input.simStart && b.date <= input.simEnd);

    // 历史段至少 MIN_HISTORY_BARS 根
    if (historyBars.length < MIN_HISTORY_BARS) continue;

    // 模拟段必须**逐日都有K线**（不停牌、不退市），且与真实交易日历完全对齐
    const simDates = new Set(simBars.map((b) => b.date));
    const simCalendar = input.simCalendar;
    if (simCalendar.length === 0) continue;
    let complete = simCalendar.length === simBars.length;
    if (complete) {
      for (const d of simCalendar) {
        if (!simDates.has(d)) {
          complete = false;
          break;
        }
      }
    }
    if (!complete) continue;

    const historyStart = historyBars[0].date;
    const historyEnd = historyBars[historyBars.length - 1].date;
    if (!historyStart || !historyEnd) continue;
    // 历史段末端必须紧邻模拟起始日（不得跨越过长空档，避免「视觉跳空」异常）
    if (new Date(`${historyEnd}T00:00:00`).getTime() >= simStartMs) continue;

    return { code, adjust, historyStart, historyEnd };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*                          创建会话                                   */
/* ------------------------------------------------------------------ */

export interface CreateSimTradeResult {
  success: boolean;
  message: string;
  session?: SimTradeInfo;
}

/**
 * 创建模拟炒股（猜股票）会话。
 *
 * 步骤：
 *  1. 归一化参数（初始资金 / 交易日数）；
 *  2. 在全市场真实交易日中，取一个「不早于数据最早 + MIN_HISTORY_BARS 根」的
 *     随机起始交易日（保留足够可见历史）；
 *  3. 由模拟起始日向后取 `tradingDays` 个真实交易日作为模拟区间；
 *  4. 随机抽取满足条件的标的（隐藏身份）；
 *  5. 建会话 + 由 tradingEngine 建独占账户 + 初始化首日快照。
 */
export async function createSimTradeSession(
  input: CreateSimTradeInput = {},
): Promise<CreateSimTradeResult> {
  const initialCashRaw = Number(input.initialCash ?? DEFAULT_INITIAL_CASH);
  const initialCash = Number.isFinite(initialCashRaw) ? initialCashRaw : DEFAULT_INITIAL_CASH;
  if (!Number.isFinite(initialCash) || initialCash <= 0) {
    return { success: false, message: "初始资金必须为正数" };
  }
  if (initialCash > 1_000_000_000) {
    return { success: false, message: "初始资金过大（上限 10 亿）" };
  }

  let tradingDays = Math.floor(Number(input.tradingDays ?? DEFAULT_TRADING_DAYS));
  if (!Number.isFinite(tradingDays) || tradingDays <= 0) tradingDays = DEFAULT_TRADING_DAYS;
  tradingDays = Math.min(MAX_TRADING_DAYS, Math.max(MIN_TRADING_DAYS, tradingDays));

  // 全市场真实交易日（跨全市场去重升序）。取宽区间以保证有足够历史与模拟期。
  const ALL_START = "1900-01-01";
  const ALL_END = "2999-12-31";
  const allDates = await listTradingDates(ALL_START, ALL_END);
  if (allDates.length < MIN_TOTAL_BARS + 1) {
    return { success: false, message: "真实交易日数据不足，无法创建模拟炒股" };
  }

  // 起始交易日：必须在 [0, len - tradingDays - MIN_HISTORY_BARS) 范围内随机，
  // 保证起始日之前有 >= MIN_HISTORY_BARS 根真实K线，之后有 tradingDays 个交易日。
  const maxStartIdx = allDates.length - tradingDays - MIN_HISTORY_BARS;
  if (maxStartIdx <= MIN_HISTORY_BARS) {
    return { success: false, message: "真实交易日数据不足，无法保留足够历史K线" };
  }
  // 起始下标下限 = MIN_HISTORY_BARS（保证前面有足够历史）
  const minStartIdx = MIN_HISTORY_BARS;
  const startIdx =
    minStartIdx + Math.floor(Math.random() * (maxStartIdx - minStartIdx + 1));

  const simStart = allDates[startIdx];
  const simEnd = allDates[startIdx + tradingDays - 1];
  const simCalendar = allDates.slice(startIdx, startIdx + tradingDays);
  if (simCalendar.length < MIN_TRADING_DAYS) {
    return { success: false, message: "无法在真实数据中定位足够长的模拟区间" };
  }
  // 历史段末端 = 起始日的上一个真实交易日
  const historyEndGuess = allDates[startIdx - 1];

  const target = await pickRandomTarget({ simStart, simEnd, simCalendar });
  if (!target) {
    return {
      success: false,
      message: "本次随机选股未找到满足条件的标的，请重试",
    };
  }

  const user = await prisma.user.upsert({
    where: { username: SIMTRADE_USERNAME },
    update: {},
    create: { username: SIMTRADE_USERNAME, nickname: "模拟投资者" },
    select: { id: true },
  });

  const name = input.name?.trim() || `猜股票 · ${simStart} ~ ${simEnd}`;

  // 先建会话，再由引擎建账户并绑定 simTradeSessionId（唯一键）。
  const session = await prisma.simTradeSession.create({
    data: {
      userId: user.id,
      name,
      hiddenStockCode: target.code,
      adjust: target.adjust,
      initialCash,
      startDate: normalizeDate(simStart),
      endDate: normalizeDate(simEnd),
      historyStart: normalizeDate(target.historyStart),
      historyEnd: normalizeDate(target.historyEnd || historyEndGuess),
      currentDate: normalizeDate(simStart),
      calendar: JSON.stringify(simCalendar),
      totalDays: simCalendar.length,
      status: "ACTIVE",
      revealed: false,
    },
    select: { id: true },
  });

  try {
    await createAccount({
      username: SIMTRADE_USERNAME,
      accountName: `模拟炒股账户 · ${name}`,
      initialCash,
      simTradeSessionId: session.id,
    });
  } catch (err) {
    await prisma.simTradeSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return { success: false, message: `创建模拟炒股账户失败：${(err as Error).message}` };
  }

  const accountId = await getSimTradeAccountId(session.id);
  if (!accountId) {
    await prisma.simTradeSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return { success: false, message: "创建模拟炒股账户失败：账户未正确绑定" };
  }
  await refreshDailyAsset(accountId, simStart);

  const row = await prisma.simTradeSession.findUnique({
    where: { id: session.id },
    select: SESSION_SELECT,
  });
  return {
    success: true,
    message: `模拟炒股已创建（${simCalendar.length} 个交易日，标的已隐藏）`,
    session: row ? toSimTradeInfo(row) : undefined,
  };
}

/** 取会话的专用账户 ID */
export async function getSimTradeAccountId(sessionId: string): Promise<string | null> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: { account: { select: { id: true } } },
  });
  return row?.account?.id ?? null;
}

/** 单个会话的元信息（轻量查询，不含行情/持仓） */
export async function getSimTradeInfo(sessionId: string): Promise<SimTradeInfo | null> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  return row ? toSimTradeInfo(row) : null;
}

/** 全部模拟炒股会话（按创建时间倒序） */
export async function listSimTradeSessions(): Promise<SimTradeInfo[]> {
  const rows = await prisma.simTradeSession.findMany({
    orderBy: { createdAt: "desc" },
    select: SESSION_SELECT,
  });
  return rows.map(toSimTradeInfo);
}

/** 删除会话（级联删除其独占账户与全部持仓/委托/成交/快照） */
export async function deleteSimTradeSession(
  sessionId: string,
): Promise<{ success: boolean; message: string }> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });
  if (!row) return { success: false, message: "模拟炒股会话不存在" };
  await prisma.simTradeSession.delete({ where: { id: sessionId } });
  return { success: true, message: "模拟炒股会话已删除" };
}

/* ------------------------------------------------------------------ */
/*                          快照读取                                   */
/* ------------------------------------------------------------------ */

/**
 * 裁切「可见 K 线」：
 *  - 只保留 date <= currentDate 的日K（**杜绝未来数据**）；
 *  - 当日（= currentDate）这根：
 *      · 尚未确认操作（`revealToday=false`）→ 只暴露 open，high/low/close 用 open 占位，
 *        避免玩家在结算前从图表读到今日收盘价（那会提前泄露操作依据）；
 *      · 已确认操作（`revealToday=true`）→ 揭示完整 OHLC（此刻已结算，收盘价即操作结果）。
 */
function buildVisibleHistory(
  bars: KlineBar[],
  currentDate: string,
  revealToday: boolean,
): KlineBar[] {
  const visible = bars.filter((b) => b.date <= currentDate);
  return visible.map((b) => {
    if (b.date === currentDate && !revealToday) {
      // 当日未确认：仅揭示开盘价
      return { ...b, high: b.open, low: b.open, close: b.open };
    }
    return b;
  });
}

/**
 * 会话快照 —— 一个交易日的完整可见视图。
 *
 * 全部行情/估值以 `currentDate` 为上界；返回的 `history` 只到 currentDate，
 * 且当日仅含 open，**不含任何未来K线**。标的身份信息一律不出现在出参中。
 */
export async function getSimTradeSnapshot(
  sessionId: string,
): Promise<SimTradeSnapshot | null> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!row) return null;

  const info = toSimTradeInfo(row);
  const accountId = info.accountId;
  if (!accountId) return null;

  const code = row.hiddenStockCode;
  const adjust = toAdjust(row.adjust);

  const [summary, positions, trades] = await Promise.all([
    getAccountSummary(accountId, info.currentDate),
    getPositions(accountId, info.currentDate),
    getTrades(accountId, { limit: 500 }),
  ]);
  if (!summary) return null;

  // 唯一持仓（本玩法只有一只隐藏标的）
  const rawPos = positions.length > 0 ? positions[0] : null;
  const position: SimTradePosition | null = rawPos
    ? {
        quantity: rawPos.quantity,
        availableQty: rawPos.availableQty,
        todayQty: Math.max(0, rawPos.quantity - rawPos.availableQty),
        avgCost: rawPos.avgCost,
        lastPrice: rawPos.lastPrice,
        prevClose: rawPos.prevClose,
        marketValue: rawPos.marketValue,
        unrealizedPnl: rawPos.unrealizedPnl,
        unrealizedPnlPercent: rawPos.unrealizedPnlPercent,
        todayPnl: rawPos.todayPnl,
      }
    : null;

  // 可见历史 K 线（含当前日，仅 open）：从 historyStart 到 currentDate
  const histBars = await getKlines(code, {
    period: "1d",
    adjust,
    startDate: info.historyStart,
    endDate: info.currentDate, // ← 防泄漏：右端点 = currentDate
    limit: 100000,
  });
  const history = buildVisibleHistory(histBars, info.currentDate, info.confirmedToday);

  // 当日开盘价（唯一允许提前揭示的当日价格）
  const todayBar = await getKlineAt(code, info.currentDate, adjust);
  const openPrice = todayBar ? round(todayBar.open, 2) : 0;

  // 仓位比 % = 持仓市值 / 总资产
  const positionRatio =
    summary.totalAsset > 0 ? round((summary.marketValue / summary.totalAsset) * 100, 2) : 0;

  // 每日资产快照曲线（显式限制 date <= currentDate，防未来快照混入）
  const assetRows = await prisma.dailyAsset.findMany({
    where: { accountId, date: { lte: normalizeDate(info.currentDate) } },
    orderBy: { date: "asc" },
    select: {
      date: true,
      cash: true,
      marketValue: true,
      totalAsset: true,
      totalPnl: true,
      dailyReturn: true,
      totalReturn: true,
    },
  });
  const curve: DailyAssetInfo[] = assetRows.map((r) => ({
    date: toDateStr(r.date),
    cash: dec(r.cash),
    marketValue: dec(r.marketValue),
    totalAsset: dec(r.totalAsset),
    totalPnl: dec(r.totalPnl),
    dailyReturn: dec(r.dailyReturn),
    totalReturn: dec(r.totalReturn),
  }));

  const metrics = calcPerformance(
    curve.map((c) => ({
      date: c.date,
      totalAsset: c.totalAsset,
      dailyReturn: c.dailyReturn,
    })),
    info.initialCash,
  );

  // 累计交易笔数
  const tradeCount = trades.length;

  // 最近一次操作记录（**最近已结算的交易日**）。
  // - 今日已确认：结算日 = 今日（currentDate），展示今日收盘结果；
  // - 今日未确认：结算日 = 上一交易日（prevDate），展示昨日结果；
  // - 首日且未确认：null（还没有任何已结算的操作）。
  // 注意：不可用 nextDate，因为「下一交易日」尚未结算。
  const settledDate = info.confirmedToday ? info.currentDate : info.prevDate;
  let lastAction = settledDate ? buildLastActionRecord(trades, settledDate) : null;
  // 回填该交易日的当日盈亏 / 当日收益率（来自资产曲线，真实数据）
  if (lastAction && settledDate) {
    const rowAt = curve.find((c) => c.date === settledDate);
    if (rowAt) {
      lastAction = { ...lastAction, dailyPnl: round(rowAt.totalPnl, 2), dailyReturn: round(rowAt.dailyReturn, 2) };
    }
  }

  // 最终结算（仅 FINISHED）
  let settlement: SimTradeSettlement | null = null;
  if (info.status === "FINISHED") {
    settlement = await buildSettlement({
      code,
      adjust,
      info,
      summary,
      curve,
      metrics,
      tradeCount,
      maxPositionRatio: positionRatio,
    });
  }

  return {
    session: info,
    summary,
    positionRatio,
    position,
    history,
    openPrice,
    tradable: info.status === "ACTIVE" && !info.confirmedToday,
    lastAction,
    tradeCount,
    curve,
    metrics,
    settlement,
  };
}

/**
 * 组装「最近一次已结算交易日的操作记录」。
 * 仅取 trades 中成交日为 `settledDate` 的成交（当日操作），映射为不含身份的 DTO。
 * 无成交（玩家当日选择观望/HOLD）时返回 fillCount=0 的 HOLD 记录。
 *
 * dailyPnl / dailyReturn 由调用方用资产曲线在该日的差值回填，此处置 0 占位。
 */
function buildLastActionRecord(
  trades: TradeInfo[],
  settledDate: string,
): SimTradeDayRecord | null {
  const todayFills = trades.filter((t) => t.tradedAt === settledDate);
  if (todayFills.length === 0) {
    return {
      date: settledDate,
      action: "HOLD",
      fillCount: 0,
      fills: [],
      amount: 0,
      dailyPnl: 0,
      dailyReturn: 0,
    };
  }

  const fills: SimTradeFill[] = todayFills.map((t) => ({
    id: t.id,
    side: t.side,
    price: t.price,
    quantity: t.quantity,
    amount: t.amount,
    commission: t.commission,
    stampTax: t.stampTax,
    transferFee: t.transferFee,
    totalFee: t.totalFee,
    realizedPnl: t.realizedPnl,
    tradedAt: t.tradedAt,
  }));

  const totalAmount = fills.reduce((s, f) => s + f.amount, 0);
  const hasBuy = fills.some((f) => f.side === "BUY");
  const hasSell = fills.some((f) => f.side === "SELL");
  const action: SimTradeAction = hasBuy ? "BUY" : hasSell ? "SELL" : "HOLD";

  return {
    date: settledDate,
    action,
    fillCount: fills.length,
    fills,
    amount: round(totalAmount, 2),
    dailyPnl: 0, // 由快照层用曲线差值回填
    dailyReturn: 0,
  };
}

/**
 * 组装最终结算：玩家收益 vs 买入持有基准。
 *
 * 买入持有口径：模拟**第一个交易日开盘价**全仓买入、最后一个交易日**收盘价**卖出，
 * 并扣除同口径费用（与玩家交易完全一致的费用规则由 tradingEngine 提供）。
 * 这里为简化且避免跨引擎调用，采用「首日开盘价 → 末日收盘价」的价格收益率，
 * 同时给出费用后的净收益率（按单边买入 + 单边卖出费用估算，取整手）。
 */
async function buildSettlement(input: {
  code: string;
  adjust: AdjustType;
  info: SimTradeInfo;
  summary: AccountInfo;
  curve: DailyAssetInfo[];
  metrics: PerformanceMetrics;
  tradeCount: number;
  maxPositionRatio: number;
}): Promise<SimTradeSettlement> {
  const { code, adjust, info, summary, curve, metrics, tradeCount } = input;

  // 首日开盘价 / 末日收盘价（真实数据）
  const firstBar = await getKlineAt(code, info.startDate, adjust);
  const lastBar = await getKlineAt(code, info.endDate, adjust);
  const startClose = firstBar ? round(firstBar.open, 2) : 0; // 以首日开盘价作为买入基准
  const endClose = lastBar ? round(lastBar.close, 2) : 0;

  // 买入持有：初始资金全仓（整手）买入，末日收盘卖出
  let buyHoldProfit = 0;
  let buyHoldReturn = 0;
  if (startClose > 0 && endClose > 0) {
    // 整手可买数量（不复用引擎内部实现，避免耦合；费用按引擎口径近似：买卖各按金额比例）
    const lots = Math.floor(info.initialCash / startClose / 100);
    const qty = lots * 100;
    if (qty > 0) {
      const buyAmount = round(startClose * qty, 2);
      const sellAmount = round(endClose * qty, 2);
      // 费用口径（与 lib/constants 一致）：佣金万三（最低 5，双向）+ 印花税千一（卖出）+ 过户费万0.1（双向）
      const commissionBuy = Math.max(5, round(buyAmount * 0.0003, 2));
      const commissionSell = Math.max(5, round(sellAmount * 0.0003, 2));
      const stampSell = round(sellAmount * 0.001, 2);
      const transferBuy = round(buyAmount * 0.00001, 2);
      const transferSell = round(sellAmount * 0.00001, 2);
      const cashLeft = info.initialCash - buyAmount - commissionBuy - transferBuy;
      buyHoldProfit = round(cashLeft + sellAmount - commissionSell - stampSell - transferSell - info.initialCash, 2);
      buyHoldReturn = info.initialCash > 0 ? round((buyHoldProfit / info.initialCash) * 100, 2) : 0;
    }
  }

  const totalProfit = round(summary.totalProfit, 2);
  const totalReturn = round(summary.totalProfitRate, 2);

  // 最大仓位：取历史每日市值的最高占比（用曲线中的市值/总资产峰值近似）
  let maxPositionRatio = input.maxPositionRatio;
  for (const c of curve) {
    if (c.totalAsset > 0) {
      const ratio = round((c.marketValue / c.totalAsset) * 100, 2);
      if (ratio > maxPositionRatio) maxPositionRatio = ratio;
    }
  }

  return {
    initialCash: info.initialCash,
    finalAsset: round(summary.totalAsset, 2),
    totalProfit,
    totalReturn,
    tradeCount,
    maxPositionRatio,
    maxDrawdown: round(metrics.maxDrawdown, 2),
    maxDrawdownStart: metrics.maxDrawdownStart,
    maxDrawdownEnd: metrics.maxDrawdownEnd,
    buyHoldProfit,
    buyHoldReturn,
    beatBuyHold: totalProfit > buyHoldProfit,
    startClose,
    endClose,
  };
}

/* ------------------------------------------------------------------ */
/*                          每日操作 / 推进                             */
/* ------------------------------------------------------------------ */

export interface SubmitActionResult {
  success: boolean;
  message: string;
  /** 是否已到模拟末尾 */
  finished?: boolean;
  snapshot?: SimTradeSnapshot;
}

/**
 * 提交「今日操作」并推进到收盘结算。
 *
 * 闭环：看开盘信息 → 选择操作 → 确认 → 按今日收盘价成交 → 结算 → 下一交易日。
 * 规则（硬约束）：
 *  - 成交价 = 当日收盘价（`placeOrder` 以 tradeDate=currentDate 撮合）；
 *  - 成交日 & 行情可见上界 = currentDate（服务端强制，客户端不可覆盖）；
 *  - 操作比例档位由前端给出整数百分比，服务端换算为可用资金/可卖份额对应数量；
 *  - 校验全部下沉 tradingEngine（资金/持仓/T+1），失败直接返回，不推进日期。
 */
export async function submitSimTradeAction(
  sessionId: string,
  input: SubmitSimTradeActionInput,
): Promise<SubmitActionResult> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!row) return { success: false, message: "模拟炒股会话不存在" };

  const info = toSimTradeInfo(row);
  if (!info.accountId) return { success: false, message: "模拟炒股账户缺失" };
  if (info.status !== "ACTIVE") {
    return { success: false, message: "该模拟炒股已结束，无法继续操作" };
  }

  const code = row.hiddenStockCode;
  const adjust = toAdjust(row.adjust);
  const today = info.currentDate;

  const action: SimTradeAction = input.action;
  if (action !== "BUY" && action !== "SELL" && action !== "HOLD") {
    return { success: false, message: "操作类型必须为 BUY / SELL / HOLD" };
  }

  // 幂等/防重复：今日已确认过则拒绝再次确认（必须先进入下一交易日）
  if (info.confirmedToday) {
    return { success: false, message: "今日操作已确认，请点击「下一交易日」继续" };
  }

  // 当日必须有行情（真实交易日），否则无法成交（停牌/非交易日直接拒绝）
  const todayBar = await getKlineAt(code, today, adjust);
  if (!todayBar) {
    return { success: false, message: "当前交易日该标的无行情，无法操作" };
  }
  const closePrice = round(todayBar.close, 2);

  // 执行交易（HOLD 不动仓）
  if (action !== "HOLD") {
    const side: OrderSide = action === "BUY" ? "BUY" : "SELL";

    // 比例档位显式校验：非法值一律拒绝，绝不静默退化为 100% 满仓
    // （静默退化会让一个畸形请求变成全仓买入，属危险的隐式行为）
    const rawPercent = input.percent ?? 100;
    if (typeof rawPercent !== "number" || !Number.isFinite(rawPercent)) {
      return { success: false, message: "操作比例必须是 1~100 之间的数字" };
    }
    if (rawPercent < 1 || rawPercent > 100) {
      return { success: false, message: "操作比例必须在 1~100 之间" };
    }
    const percent = Math.floor(rawPercent);

    const quantity = await resolveQuantity({
      accountId: info.accountId,
      side,
      percent,
      closePrice,
      currentDate: today,
    });
    if (quantity <= 0) {
      return {
        success: false,
        message:
          side === "BUY"
            ? "可用资金不足，无法按该比例买入"
            : "可卖持仓不足，无法按该比例卖出",
      };
    }

    const result = await placeOrder({
      accountId: info.accountId,
      stockCode: code,
      side,
      orderType: "MARKET",
      quantity,
      // 成交日 = 当前模拟交易日；同时作为行情可见上界下沉引擎（双重防泄漏）
      tradeDate: today,
      asOfDate: today,
    });
    if (!result.success) {
      return { success: false, message: result.message };
    }
  }

  // 收盘结算：按今日收盘价刷新资产快照，并标记「今日已确认」。
  // 注意：此处**不推进日期** —— 玩家先看到今日收盘结果，再手动进入下一交易日
  // （否则当日新买份额会被立即解冻、todayQty 恒为 0，且看不到结算结果）。
  await refreshDailyAsset(info.accountId, today);
  await prisma.simTradeSession.update({
    where: { id: sessionId },
    data: { confirmedDate: normalizeDate(today) },
  });

  const snapshot = await getSimTradeSnapshot(sessionId);
  return {
    success: true,
    message: `已按 ${today} 收盘价结算`,
    finished: false,
    snapshot: snapshot ?? undefined,
  };
}

/**
 * 按比例换算委托数量。
 *
 *  - BUY：可用现金 × percent% → 按收盘价整手向下取整；
 *  - SELL：可卖份额 × percent% → 整手向下取整；100% 时直接取全部可卖份额
 *    （A股允许零股一次性清仓，避免因不足一手而无法卖出）。
 *
 * 数量最终仍需通过 tradingEngine 的资金/持仓校验，这里只做「按比例换算」。
 */
async function resolveQuantity(input: {
  accountId: string;
  side: OrderSide;
  percent: number;
  closePrice: number;
  currentDate: string;
}): Promise<number> {
  const { accountId, side, percent, closePrice, currentDate } = input;
  if (closePrice <= 0) return 0;

  if (side === "BUY") {
    const summary = await getAccountSummary(accountId, currentDate);
    if (!summary) return 0;

    // A 股按 100 股整手交易，买入需支付佣金(万三,最低5元)+过户费(万0.1)。
    // 若直接按 cash*percent 折算，把整手向下取整后残留的零钱无法再买 1 手，
    // 100% 档会明显不满仓（视股价可闲置数千元）。这里对「费用 + 一手成本」做
    // 保守预留，使 100% 档尽量贴近满仓，同时保证成交后现金不会被扣成负数。
    const totalBudget = (summary.availableCash * percent) / 100;
    // 一手成本 + 其对应费用（佣金万三最低 5 元、过户费万0.1）
    const oneLotCost = closePrice * 100;
    const oneLotFee = Math.max(5, oneLotCost * 0.0003) + oneLotCost * 0.00001;
    const budget = Math.max(0, totalBudget - (oneLotCost + oneLotFee));
    const rawQty = Math.floor(budget / closePrice / 100) * 100;
    if (rawQty <= 0) return 0;
    // 成交金额上限校验：成交额 + 费用不得超出可用资金的该比例预算
    const amount = rawQty * closePrice;
    const fee = Math.max(5, amount * 0.0003) + amount * 0.00001;
    if (amount + fee > totalBudget + 0.01) return 0;
    return rawQty;
  }

  // SELL
  const positions = await getPositions(accountId, currentDate);
  if (positions.length === 0) return 0;
  const sellable = positions[0].availableQty;
  if (sellable <= 0) return 0;
  if (percent >= 100) return sellable;
  const lots = Math.floor((sellable * percent) / 100 / 100) * 100;
  return Math.max(0, lots);
}

/**
 * 推进到下一交易日（收盘结算后进入新一日）。
 *
 * 步骤（严格按真实交易日）：
 *  0. 前置：今日必须已确认操作（`confirmedToday`），否则不允许推进
 *     —— 保证「选择动作 → 确认 → 看收盘结果 → 下一交易日」闭环顺序；
 *  1. 交易日历取 currentDate 的下一个交易日（创建时固化）；
 *  2. tradingEngine.settleT1 —— 跨日后昨日买入份额解冻为可卖（T+1）；
 *  3. 更新 currentDate（行情可见上界随之推进），并清空 confirmedDate；
 *  4. refreshDailyAsset —— 重算 现金 / 市值 / 总资产 / 当日收益 / 累计收益；
 *  5. 已到日历末尾时标记 FINISHED。
 *
 * 幂等：已在末尾时直接返回 finished=true；未确认时返回失败提示。
 */
export async function advanceSimTradeDay(sessionId: string): Promise<SubmitActionResult> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!row) return { success: false, message: "模拟炒股会话不存在" };

  const info = toSimTradeInfo(row);
  if (!info.accountId) return { success: false, message: "模拟炒股账户缺失" };

  // 已在末尾（currentDate 已是日历最后一天）：结算并结束本局
  if (!info.nextDate) {
    if (info.status === "FINISHED") {
      const snapshot = await getSimTradeSnapshot(sessionId);
      return {
        success: true,
        message: "本局已结束",
        finished: true,
        snapshot: snapshot ?? undefined,
      };
    }
    // 末尾日也必须先确认操作，才允许收尾结束
    if (!info.confirmedToday) {
      return { success: false, message: "请先确认今日操作，再结束本局" };
    }
    await prisma.simTradeSession.update({
      where: { id: sessionId },
      data: { status: "FINISHED" },
    });
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: "已到达模拟末尾，本局结束",
      finished: true,
      snapshot: snapshot ?? undefined,
    };
  }

  if (info.status !== "ACTIVE") {
    return { success: false, message: "该模拟炒股已结束，无法继续推进" };
  }

  // 前置：今日必须已确认操作，才能进入下一交易日
  if (!info.confirmedToday) {
    return { success: false, message: "请先确认今日操作，再进入下一交易日" };
  }

  const nextDate = info.nextDate;

  // 1) T+1 结算：把「非当日买入」的份额置为可卖
  await settleT1(info.accountId, nextDate);

  // 2) 推进当前模拟交易日（行情可见上界），并清空今日确认标记
  await prisma.simTradeSession.update({
    where: { id: sessionId },
    data: { currentDate: normalizeDate(nextDate), confirmedDate: null },
  });

  // 3) 按新交易日收盘价重算资产快照
  await refreshDailyAsset(info.accountId, nextDate);

  // 4) 不在此处标记 FINISHED：即使 nextDate 已是日历最后一天，
  //    玩家仍须对该日「确认操作」后再次触发推进，才结束本局
  //    （保证最后一日也有完整的 选动作→确认→看收盘 闭环）。
  const snapshot = await getSimTradeSnapshot(sessionId);
  return {
    success: true,
    message: `已推进到 ${nextDate}`,
    finished: false,
    snapshot: snapshot ?? undefined,
  };
}

/* ------------------------------------------------------------------ */
/*                          揭晓股票                                   */
/* ------------------------------------------------------------------ */

export interface RevealResult {
  success: boolean;
  message: string;
  /** 仅当揭晓成功时返回标的身份 */
  reveal?: SimTradeReveal;
}

/**
 * 揭晓被隐藏的股票（**仅允许在会话结束后**）。
 *
 * 这是唯一会返回标的代码/名称的入口；调用后会话 `revealed` 置 true（幂等）。
 * 会话进行中一律拒绝 —— 防止玩家中途揭晓后照抄未来行情。
 */
export async function revealSimTradeStock(sessionId: string): Promise<RevealResult> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!row) return { success: false, message: "模拟炒股会话不存在" };

  const info = toSimTradeInfo(row);
  if (info.status !== "FINISHED") {
    return { success: false, message: "本局尚未结束，暂不可揭晓股票" };
  }

  // 取标的基础信息（揭晓后允许返回身份）
  const stock = await getStockInfoByCode(row.hiddenStockCode);
  if (!stock) return { success: false, message: "标的信息缺失" };

  // 持仓成本（揭晓展示用），以当前币值口径读取（此时已结束，无未来数据）
  let avgCost = 0;
  if (info.accountId) {
    const positions = await getPositions(info.accountId, info.currentDate);
    if (positions.length > 0) avgCost = positions[0].avgCost;
  }

  if (!row.revealed) {
    await prisma.simTradeSession.update({
      where: { id: sessionId },
      data: { revealed: true, revealedAt: new Date() },
    });
  }

  return {
    success: true,
    message: "已揭晓本局标的",
    reveal: {
      code: stock.code,
      name: stock.name,
      exchange: stock.exchange as Exchange,
      board: stock.board as BoardType,
      avgCost: round(avgCost, 4),
    },
  };
}
