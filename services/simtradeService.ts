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
import { SIM_TRADE_BENCHMARKS } from "@/lib/constants";
import {
  BARS_PER_DAY,
  INTRADAY_OPEN_ANCHOR,
  INTRADAY_TIMES,
  aggregateDayBars,
  clipBarsToCount,
  computeDailyUnitFactors,
  contaminatedInRange,
  getIntradayBars,
  isContaminated,
} from "@/lib/intraday30m";
import { isCloseRevealed, isTradableStage } from "@/lib/simtradeStage";
import { getIndexKlines } from "@/services/indexDataService";
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
  SimTradeBenchmark,
  SimTradeDayRecord,
  SimTradeExecutionMode,
  SimTradeFill,
  SimTradeTodayTrades,
  SimTradeInfo,
  SimTradePosition,
  SimTradePool,
  SimTradeReveal,
  SimTradeSettlement,
  SimTradeSnapshot,
  SimTradeStage,
  SimTradeStatus,
  SimTradeTodayBar,
  SubmitSimTradeActionInput,
  TradeInfo,
} from "@/types";
import {
  calcBuyOutlay,
  calcFees,
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
/** 随机选股候选池上限（单批最多尝试的股票数，防止极端情况下过长扫描） */
const MAX_CANDIDATE_TRIES = 60;
/**
 * 随机选股最多换几批候选。
 *
 * 起始交易日是随机落在全历史里的，单批 60 只候选有小概率集体不覆盖该窗口；
 * 换批重试可把「整局创建失败」压到可忽略，而单批查询本身是毫秒级，代价很低。
 */
const MAX_CANDIDATE_BATCHES = 4;

/** 每日**成功买入**次数上限（只统计 BUY；上限 2） */
const MAX_BUY_PER_DAY = 2;
/** 每日**成功卖出**次数上限（只统计 SELL；上限 2） */
const MAX_SELL_PER_DAY = 2;
/**
 * 每日**总操作**次数上限（V3）：BUY / SELL / HOLD **统一计数**，上限 8。
 *
 * 为什么必须独立于买入/卖出配额 —— 三者是**并列**约束，必须同时成立：
 *     总操作 ≤ 8   且   买入 ≤ 2   且   卖出 ≤ 2
 *
 * ⚠️ 绝对**不要**把 `MAX_BUY_PER_DAY` / `MAX_SELL_PER_DAY` 改成 8：
 * 那等于删掉「买入 ≤ 2 / 卖出 ≤ 2」这两条规则，变成「最多买 8 次」。
 *
 * 语义边界（V3 核心，勿混）：
 *  - 操作次数 = **玩家行为计数器**（买/卖各 +1，上限 8）；
 *    注：观望已于 2026-09-24 取消（与「推进时间」等价），故实际可达上限为 4。
 *  - 30m K 线 = **行情时间轴**（推进时间不消耗操作）。
 *  二者解耦：**8 根 30m K 绝不等于 8 次操作**。
 */
const MAX_OPERATIONS_PER_DAY = 8;

/**
 * 开盘阶段可揭示的 30m K 根数上限（= 7，即最晚揭示到 14:30）。
 *
 * 第 8 根是 15:00，其 close **就是当日收盘价** —— 若开盘阶段就放出去，玩家即可从
 * 30m 通道读到当日收盘，绕过 V2「OPEN 阶段不得揭示当日收盘」的红线。
 * 因此 8 根只有在进入 `CLOSE_ANIMATION` 之后才允许揭示。
 */
const MAX_REVEALED_BARS_IN_OPEN = 7;

/** 某阶段允许揭示的 30m 根数上限 */
function maxRevealableBars(stage: SimTradeStage): number {
  return stage === "OPEN" ? MAX_REVEALED_BARS_IN_OPEN : BARS_PER_DAY;
}

/**
 * 30m 游标对应的**当前时点**文案。
 *
 * 游标语义（2026-09-25 调整）：
 *   · `0` = **尚未揭示任何一根完整的 30m K**（刚开盘，只知开盘价）→ 时点为 `09:30`；
 *   · `1~8` = 已揭示 N 根，时点为其收盘时刻（10:00 ~ 15:00）。
 *
 * 之所以引入 0：开盘阶段按**开盘价**成交（第 1 根 30m K 的 open），
 * 此时那根 K 还没走完，把它的 close（10:00 价）提前揭示既无依据、
 * 又会在分时图上画出一段本不该存在的 09:30→10:00 曲线。
 */
function intradayTimeLabel(barCount: number): string {
  if (barCount <= 0) return INTRADAY_OPEN_ANCHOR;
  const i = Math.min(barCount, BARS_PER_DAY) - 1;
  return INTRADAY_TIMES[i].slice(0, 5);
}

/**
 * 解析「当前合法成交价」—— **V3 阶段 6 起唯一的成交价来源**。
 *
 * 规则（每一条都是硬约束）：
 *  1. 以**当前已揭示的 30m K**为准，取该根的 **close**；
 *  2. 上界严格等于「当前阶段允许揭示的根数」，**绝不读未来棒**
 *     （开盘阶段上限 7；进入收盘揭示后为 8）；
 *  3. **只用 close，不用 high/low** —— 阶段 8 的数据复核确认：34 对北交所污染样本
 *     的影线曾被 `same-bar-bound` 夹成**合成值**，intraday 极值不可信；close 才是
 *     可用于成交的价（且这些 (标的,日期) 已在选股阶段整体排除，属双重保险）；
 *  4. 若 30m 数据不可用（例如服务器尚未部署 parquet 数据集），**退化为日K 的
 *     开盘/收盘价**，并在返回值里标明来源 —— 绝不静默换用另一套价。
 *
 * 本函数只负责**取价**，不判断阶段是否可交易（那是调用方的职责）。
 * 客户端传入的任何价格字段都不会被读取 —— 本函数根本没有价格入参。
 */
async function resolveFillPrice(input: {
  code: string;
  date: string;
  stage: SimTradeStage;
  /** 会话 30m 游标（当日已揭示根数） */
  revealedCount: number;
  /** 当日日K（30m 不可用时的退化来源） */
  todayBar: KlineBar;
}): Promise<{ price: number; source: "INTRADAY_30M" | "DAILY_K"; time: string | null }> {
  const { code, date, stage, revealedCount, todayBar } = input;

  // 先按阶段夹取，再按收盘揭示与否夹取（进入 CLOSE_ANIMATION 时游标已置 8）
  const capped = Math.min(Math.max(revealedCount, 0), maxRevealableBars(stage));
  const effective = isCloseRevealed(stage) ? BARS_PER_DAY : capped;

  /*
   * 【开盘价口径】（2026-09-25 按用户要求调整）
   *
   * 游标 `0` = **尚未揭示任何一根完整的 30m K**（刚开盘，一根都没走完）。
   * 此刻唯一已知的当日价格是**开盘价**：
   *   · 它就是第 1 根 30m K 的 `open`（该根覆盖 09:30~10:00）；
   *   · 也是本玩法唯一允许提前揭示的当日价格 —— 快照的 `openPrice` 用的就是
   *     日K 的 open，分时图横轴第一个刻度同样取自它（`INTRADAY_OPEN_ANCHOR`）。
   *
   * 为什么用**日K 的 open** 而不是 30m 第 1 根的 open：两者在数据源上存在
   * 0.01 级差异（线上实测 14.87 vs 14.88）。既然界面上标示的开盘价来自日K，
   * 成交价就必须与它**严格一致**，整条链路只能有一个「开盘价」。
   */
  if (effective <= 0) {
    if (todayBar.open > 0) {
      return {
        price: round(todayBar.open, 2),
        source: "INTRADAY_30M",
        time: INTRADAY_OPEN_ANCHOR,
      };
    }
  }

  if (effective > 0) {
    const bars = await getIntradayBars(code, date);
    const revealed = clipBarsToCount(bars, effective);
    const last = revealed[revealed.length - 1];
    if (last && last.close > 0) {
      /* 揭示 ≥1 根后，时间确实走到了该 30m 时点，按**最后一根的收盘价**成交
         （CLOSE 阶段即 15:00 那根 = 当日收盘价）。 */
      return { price: round(last.close, 2), source: "INTRADAY_30M", time: last.time.slice(0, 5) };
    }
  }

  // 30m 不可用 → 退化为日K 口径（并标明来源，便于测试与排查）
  return {
    price: round(stage === "OPEN" ? todayBar.open : todayBar.close, 2),
    source: "DAILY_K",
    time: null,
  };
}

/**
 * 阶段谓词（能否下单 / 收盘是否已揭示）**不在本文件定义** —— 见 `lib/simtradeStage.ts`。
 *
 * 2026-09-22 审计发现：`app/api/intraday/route.ts` 曾复制一份 `isCloseRevealedStage`，
 * 与本文件的 `isCloseRevealed` 构成两份可能漂移的真相。现已收敛为唯一实现，
 * 两处共同 import，避免「改了一处忘了另一处」导致的收盘价泄漏。
 */

/** 阶段不可操作时的提示文案 */
function stageHint(stage: SimTradeStage): string {
  switch (stage) {
    case "OPEN_CONFIRMED":
      return "开盘阶段已完成操作，请查看今日收盘";
    case "CLOSE_ANIMATION":
      return "收盘动画播放中，请稍候";
    case "CLOSE_CONFIRMED":
      return "收盘阶段已完成操作，请进入下一交易日";
    case "DAY_SETTLED":
      return "今日已结算，请进入下一交易日";
    default:
      return "当前阶段不可操作";
  }
}

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
  stage: true,
  stageActionCompleted: true,
  buyCountToday: true,
  sellCountToday: true,
  operationCountToday: true,
  intradayBarCount: true,
  // V3 确认模式（pending → confirm → execute）
  pendingAction: true,
  pendingPercent: true,
  pendingStage: true,
  pendingDate: true,
  pool: true,
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
  stage: string;
  stageActionCompleted: boolean;
  buyCountToday: number;
  sellCountToday: number;
  operationCountToday: number;
  intradayBarCount: number;
  pendingAction: string | null;
  pendingPercent: number | null;
  pendingStage: string | null;
  pendingDate: Date | null;
  pool: string;
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

/** 收敛阶段枚举（非法值退化为 OPEN） */
function toStage(v: string | null | undefined): SimTradeStage {
  return v === "OPEN_CONFIRMED" ||
    v === "CLOSE_ANIMATION" ||
    v === "CLOSE" ||
    v === "CLOSE_CONFIRMED" ||
    v === "DAY_SETTLED"
    ? v
    : "OPEN";
}

/** 收敛股票池枚举（非法值退化为 STOCK） */
function toPool(v: string | null | undefined): SimTradePool {
  return v === "INDEX" || v === "INDUSTRY" ? v : "STOCK";
}

/** Session 行 → SimTradeInfo DTO（**不含被隐藏标的的任何身份信息**） */
function toSimTradeInfo(row: SessionRow): SimTradeInfo {
  const calendar = parseCalendar(row.calendar, row.currentDate);
  const current = toDateStr(row.currentDate);
  const idx = calendar.indexOf(current);
  const confirmedToday = row.confirmedDate !== null && toDateStr(row.confirmedDate) === current;

  // 旧会话兼容：V2 之前创建的会话没有阶段信息（stage 默认 OPEN），
  // 若其 confirmedDate 已是今日，说明「当日已结算」，视为 CLOSE_CONFIRMED，
  // 避免旧局卡在 OPEN 无法推进。
  let stage = toStage(row.stage);
  if (stage === "OPEN" && confirmedToday) stage = "CLOSE_CONFIRMED";

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
    confirmedToday,
    accountId: row.account?.id ?? "",
    revealed: row.revealed,
    createdAt: row.createdAt.toISOString(),
    stage,
    stageActionCompleted: row.stageActionCompleted,
    remainingBuy: Math.max(0, MAX_BUY_PER_DAY - row.buyCountToday),
    remainingSell: Math.max(0, MAX_SELL_PER_DAY - row.sellCountToday),
    operationCount: row.operationCountToday,
    remainingOps: Math.max(0, MAX_OPERATIONS_PER_DAY - row.operationCountToday),
    /**
     * 30m 游标（**0~8**）：当前能看到当日几根完整的 30m K。
     *
     * `0` 表示刚开盘 —— 一根都没走完，只知开盘价（分时图上只有 09:30 一个点）。
     *
     * 对历史会话做一次收敛：进入收盘揭示之后的阶段必须视为已揭示满 8 根 ——
     * 否则老会话在 `CLOSE_ANIMATION` 下只返回少量根，行为会倒退。
     */
    intradayBarCount: isCloseRevealed(stage)
      ? BARS_PER_DAY
      : Math.min(Math.max(row.intradayBarCount, 0), BARS_PER_DAY),
    /** 当前阶段允许揭示的根数上限（开盘 7 / 其余 8） */
    maxRevealableBars: maxRevealableBars(stage),
    /** 当前 30m 时点文案，如 `10:30` */
    currentIntradayTime: intradayTimeLabel(
      isCloseRevealed(stage) ? BARS_PER_DAY : row.intradayBarCount,
    ),
    /** V3 确认模式：服务端待确认操作（前端 pending 以服务端为准，不再自持真相） */
    pendingAction: (row.pendingAction as SimTradeAction | null) ?? null,
    pendingPercent: row.pendingPercent,
    pool: toPool(row.pool),
  };
}

/* ------------------------------------------------------------------ */
/*                          随机选股                                   */
/* ------------------------------------------------------------------ */

/** 抽中的隐藏标的（不含任何可暴露身份的字段） */
type PickedTarget = {
  code: string;
  adjust: AdjustType;
  historyStart: string;
  historyEnd: string;
};

interface PickTargetInput {
  /** 模拟区间第一个交易日 */
  simStart: string;
  /** 模拟区间最后一个交易日 */
  simEnd: string;
  /** 模拟区间的真实交易日数组（升序） */
  simCalendar: string[];
}

/**
 * 随机抽取一只符合条件的标的（**单批**）。
 *
 * 过滤条件（全部基于**真实数据**，绝不伪造）：
 *  1. 该股为活跃标的且有 K 线，且名称不含 ST（V2 股票池硬约束）；
 *  2. 在 [historyStart, endDate] 区间内，**模拟起始日之前至少有 MIN_HISTORY_BARS 根**，
 *     模拟区间内每个真实交易日都得有 K 线（保证不因停牌导致无法交易）；
 *  3. 数据完整、无缺口（区间内 K 线根数 = 真实交易日数）。
 *
 * 实现策略：随机抽 MAX_CANDIDATE_TRIES 只候选代码，批量预筛后逐个校验；
 * 校验失败自动换下一只。本批全部失败返回 null（由 pickRandomTarget 换批重试）。
 */
async function pickRandomTargetOnce(input: PickTargetInput): Promise<PickedTarget | null> {
  // 随机候选池：用 SQL 层随机排序直接取 N 只，避免把全市场 5558 只代码拉进内存再洗牌。
  // 随机性由 ORDER BY RANDOM() 保证，等价于「从全市场无放回等概率抽取 MAX_CANDIDATE_TRIES 只」。
  // excludeSt：排除 ST / *ST / 退市整理期标的（V2 股票池硬约束）。
  const allCodes = await listRandomCodesHavingKlines(MAX_CANDIDATE_TRIES, { excludeSt: true });
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

    // 30m 数据污染排除（阶段 6 标记）：
    // 北交所 34 只在 2026-06-30 的 14:00（少数含 13:30）棒被灌入量级错误的价格，
    // 且无任何独立源可恢复（腾讯 m30 对北交所返回 0 根）→ 只标记、不修复。
    // 只要**模拟区间**与该标的的污染日期有交集，就跳过该候选：
    // 否则玩家推进到那天时，读到的 30m 行情是可证明损坏的。
    // 注意：这里只拦截「30m 消费链路」，**不影响该标的的日K数据本身**（日K是正常的）。
    if (contaminatedInRange(code, input.simStart, input.simEnd).length > 0) {
      continue;
    }

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

/**
 * 随机抽取一只符合条件的标的（**多批重试**）。
 *
 * 单批只抽 MAX_CANDIDATE_TRIES 只候选。若某一批里没有任何一只满足「K 线根数充足
 * + 模拟期逐日完备 + 历史段紧邻起始日」，那是**这一批运气不好**，而不是市场上没有
 * 合格标的 —— 因为模拟起始日是随机落在全历史里的，某些窗口恰好被这一批候选集体
 * 错过。此时换一批重新抽，最多 MAX_CANDIDATE_BATCHES 批。
 *
 * 实测单批失败率约 1%（40 次创建 0 失败，但 QA 连跑多局时可见），4 批后整局创建
 * 失败的概率降到可忽略，避免把「换一批就好」的小概率事件直接抛给玩家当报错。
 *
 * 全部批次都失败才返回 null，由上层报错 —— 绝不退回造假数据。
 */
async function pickRandomTarget(input: PickTargetInput): Promise<PickedTarget | null> {
  for (let batch = 0; batch < MAX_CANDIDATE_BATCHES; batch += 1) {
    const hit = await pickRandomTargetOnce(input);
    if (hit) return hit;
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

  const pool = toPool(input.pool);

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

  // 股票池校验：当前架构下只有「全部 A 股」池可用。
  //  - INDEX：指数在 market_index / index_klines 物理分表，与 stocks 无外键关联，
  //    而 tradingEngine 的 Position / Order / Trade 均以 stockId 外键落库，
  //    无法承载指数标的（这是当初刻意做的物理隔离设计）；
  //  - INDUSTRY：库中 stocks.industry 尚未导入（全为 null），无真实板块数据。
  // 两者一律**明确拒绝**，绝不退回造假数据。
  if (pool !== "STOCK") {
    return {
      success: false,
      message:
        pool === "INDEX"
          ? "指数池暂不可用：指数与个股物理分表，交易引擎仅支持个股标的"
          : "行业板块池暂不可用：尚未导入行业分类数据",
    };
  }

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
      stage: "OPEN",
      stageActionCompleted: false,
      buyCountToday: 0,
      sellCountToday: 0,
      operationCountToday: 0,
      /* 初始游标 0 = 刚开盘，一根 30m K 都还没走完（只知开盘价）。
         推进一次 → 1（揭示 10:00），依此类推。 */
      intradayBarCount: 0,
      pool,
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
/**
 * V3：合成「当日动态形成中的日K」。
 *
 * 三条互斥分支（顺序即优先级）：
 *  ① **未揭示收盘 且 30m 可用** → 由已揭示的 30m 根现场合成 OHLCV（`INTRADAY_30M`）。
 *     这是 V3 主路径：开盘价恒为第 1 根 open；高低为已揭示极值；收盘为当前价；
 *     成交量为已揭示部分之和 —— **天然不可能提前给出全天量**。
 *  ② **未揭示收盘 且 30m 不可用** → 退化占位：OHLC 全等于当日开盘价，**成交量归零**。
 *     绝不能沿用数据库那根全天 volume（最典型的未来数据泄露）。
 *  ③ **已揭示收盘**（CLOSE_ANIMATION 及之后）→ 采用数据库的官方日K。
 *     理由：此时当日已是既成事实，且**必须与所有历史日以及换日后的口径完全一致**，
 *     否则「上一交易日」在换日前后会跳变。
 *
 * 不变量：返回值（若非 null）与 `buildVisibleHistory` 写入 history 末根的
 * OHLCV **逐字段相等** —— 不允许存在两套真相。
 */
function buildTodayBar(input: {
  date: string;
  revealClose: boolean;
  /** 数据库里的当日日K（可能不存在，例如停牌） */
  dailyBar: KlineBar | null;
  /** 已揭示的 30m 根（已按游标裁剪；被污染时传空数组） */
  revealedBars: KlineBar[];
  /** 前一交易日收盘价（算涨跌幅用） */
  prevClose: number | null;
  /**
   * 30m → 日K 的**量纲换算因子**（见 `computeDailyUnitFactors`）。
   *
   * 必须传入：30m volume 以「股」计、日K volume 以「手」计，
   * 不换算会让当日成交量柱与历史柱差 100 倍，并在 15:00 定格时塌陷。
   */
  volumeFactor: number;
  amountFactor: number;
}): SimTradeTodayBar | null {
  const { date, revealClose, dailyBar, revealedBars, prevClose, volumeFactor, amountFactor } = input;

  const pct = (close: number): number | null =>
    prevClose && prevClose > 0 ? round(((close - prevClose) / prevClose) * 100, 4) : null;

  // ③ 已揭示 → 官方日K（口径与历史/换日后完全一致）
  if (revealClose) {
    if (!dailyBar) return null;
    return {
      date,
      open: round(dailyBar.open, 4),
      high: round(dailyBar.high, 4),
      low: round(dailyBar.low, 4),
      close: round(dailyBar.close, 4),
      volume: dailyBar.volume,
      amount: dailyBar.amount,
      changePercent: pct(dailyBar.close),
      revealedBars: BARS_PER_DAY,
      finalized: true,
      source: "DAILY_K",
    };
  }

  // ① 未揭示 + 30m 可用 → 动态合成（V3 主路径）
  const agg = aggregateDayBars(revealedBars as never);
  if (agg) {
    return {
      date,
      open: round(agg.open, 4),
      high: round(agg.high, 4),
      low: round(agg.low, 4),
      close: round(agg.close, 4),
      // 量纲换算到日K 口径（「手」），保证与历史成交量柱可比，
      // 且第 8 根揭示时恰好等于官方日K 成交量（无跳变）。
      volume: Math.round(agg.volume * volumeFactor),
      amount: round(agg.amount * amountFactor, 2),
      changePercent: pct(agg.close),
      revealedBars: agg.bars,
      finalized: false,
      source: "INTRADAY_30M",
    };
  }

  // ② 未揭示 + 无 30m → 占位（成交量归零，绝不泄露全天量）
  if (!dailyBar) return null;
  return {
    date,
    open: round(dailyBar.open, 4),
    high: round(dailyBar.open, 4),
    low: round(dailyBar.open, 4),
    close: round(dailyBar.open, 4),
    volume: 0,
    amount: 0,
    changePercent: pct(dailyBar.open),
    revealedBars: 0,
    finalized: false,
    source: "DAILY_K",
  };
}

/**
 * 组装可见历史 K 线。
 *
 * 防泄漏核心（V3 变更）：
 *  - 当日**未揭示**时，末根**不再是「open 占位 + 全天成交量」** ——
 *    旧实现只把 OHLC 压成 open，却原样下发了数据库里的**全天 volume**，
 *    等于把当日最终成交量提前给了玩家（已确认为 Bug）。
 *  - 现在末根直接采用 `buildTodayBar` 的结果（动态合成 / 占位零量 / 官方日K），
 *    因此「日K成交量随 30m 节点累计」这件事由服务端保证，前端无需也不能干预。
 */
function buildVisibleHistory(
  bars: KlineBar[],
  currentDate: string,
  _revealClose: boolean,
  todayBar: SimTradeTodayBar | null,
): KlineBar[] {
  const visible = bars.filter((b) => b.date <= currentDate);
  if (!todayBar) return visible;
  return visible.map((b) => {
    if (b.date !== currentDate) return b;
    return {
      ...b,
      open: todayBar.open,
      high: todayBar.high,
      low: todayBar.low,
      close: todayBar.close,
      volume: todayBar.volume,
      amount: todayBar.amount,
    };
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

  // 防泄漏红线：只有进入 CLOSE_ANIMATION 及之后，才允许对外揭示「当日收盘价」
  const closeRevealed = isCloseRevealed(info.stage);
  // 可交易 = 进行中 && 处于 OPEN/CLOSE 阶段 && **当日总操作额度尚未用完**
  //
  // V3 语义变更：门从「本阶段是否已操作过」改为「当日操作额度是否用完」。
  // 原因：每日允许 ≤8 次操作，而阶段只表示**时间窗**（开盘/收盘），不再限制操作次数。
  // 若继续用 `!stageActionCompleted` 当门，玩家当天最多只能操作 2 次（每阶段 1 次），
  // 「总操作 ≤8」这条规则将永远无法触达。
  const tradable =
    info.status === "ACTIVE" && isTradableStage(info.stage) && info.remainingOps > 0;

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

  // 可见历史 K 线：从 historyStart 到 currentDate（右端点即防泄漏上界）
  const histBars = await getKlines(code, {
    period: "1d",
    adjust,
    startDate: info.historyStart,
    endDate: info.currentDate, // ← 防泄漏：右端点 = currentDate
    limit: 100000,
  });

  // 前一交易日收盘价（分时图 0 轴 / 顶部「前收」）。
  // 只允许取 **currentDate 之前** 的最后一根 —— 全是已结算的历史数据，不构成泄露。
  const prevBars = histBars.filter((b) => b.date < info.currentDate);
  const prevClose = prevBars.length > 0 ? round(prevBars[prevBars.length - 1].close, 2) : null;

  // 当日数据库日K（可能是已收盘的完整日K —— 不可直接下发，见 buildTodayBar）
  const dailyBar = await getKlineAt(code, info.currentDate, adjust);

  /**
   * 当日**已揭示**的 30m 根（V3 动态日K 与分时图的唯一数据源）。
   *
   * 上界 = 会话游标（收盘揭示后恒为 8）；被污染日期一律视为不可用（返回空），
   * 与 `/api/intraday` 的处置完全一致 —— 避免「图表走空、日K 却用了污染数据」的分叉。
   */
  const revealedCount = closeRevealed
    ? BARS_PER_DAY
    : Math.min(Math.max(info.intradayBarCount, 0), BARS_PER_DAY);
  const todayContaminated = isContaminated(code, info.currentDate);
  // 取**全天** 8 根（不裁剪）：既用于按游标裁剪出已揭示部分，也用于推算量纲换算因子。
  const todayAllBars: KlineBar[] = todayContaminated
    ? []
    : await getIntradayBars(code, info.currentDate);
  const revealedBars: KlineBar[] = clipBarsToCount(todayAllBars as never, revealedCount);

  const factors = computeDailyUnitFactors({
    dailyVolume: dailyBar?.volume ?? 0,
    dailyAmount: dailyBar?.amount ?? 0,
    fullDay30mVolume: todayAllBars.reduce((s, b) => s + b.volume, 0),
    fullDay30mAmount: todayAllBars.reduce((s, b) => s + b.amount, 0),
  });

  const todayBarInfo = buildTodayBar({
    date: info.currentDate,
    revealClose: closeRevealed,
    dailyBar: dailyBar ?? null,
    revealedBars,
    prevClose,
    volumeFactor: factors.volumeFactor,
    amountFactor: factors.amountFactor,
  });

  const history = buildVisibleHistory(
    histBars,
    info.currentDate,
    closeRevealed,
    todayBarInfo,
  );

  // 大盘参照（上证指数 / 深证成指 / 创业板指）：只取「最新可见点位 + 涨跌」这几个数，
  // 与个股共用同一条防泄漏红线 —— 右端点锁在 currentDate；当日未结算时，
  // 最新点位取**当日开盘**（当日收盘不揭示），与个股 history 的口径完全一致。
  const benchmarkRaw = await Promise.all(
    SIM_TRADE_BENCHMARKS.map((b) =>
      getIndexKlines(b.code, {
        startDate: info.historyStart,
        endDate: info.currentDate,
        limit: 100000,
      }),
    ),
  );
  const benchmarks: SimTradeBenchmark[] = SIM_TRADE_BENCHMARKS.map((b, i) => {
    const bars = benchmarkRaw[i].filter((bar) => bar.date <= info.currentDate);
    const last = bars[bars.length - 1];
    if (!last) {
      return { code: b.code, name: b.name, date: "", value: 0, change: 0, changePercent: 0 };
    }
    const prev = bars.length > 1 ? bars[bars.length - 2] : null;
    const useOpen = last.date === info.currentDate && !closeRevealed;
    const value = useOpen ? last.open : last.close;
    const change = prev ? value - prev.close : 0;
    const changePercent = prev && prev.close > 0 ? (change / prev.close) * 100 : 0;
    return {
      code: b.code,
      name: b.name,
      date: last.date,
      value: round(value, 2),
      change: round(change, 2),
      changePercent: round(changePercent, 2),
    };
  });

  // 当日开盘价（唯一允许提前揭示的当日价格）
  const openPrice = dailyBar ? round(dailyBar.open, 2) : 0;

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

  /* -------- 成交明细（图表买卖点）+ 当日「做T」概览 --------
   * 只在**当日**成交上反推 30m 时点：跨日的时点没有意义（每根 30m K 只属于某一天），
   * 而日K 图只需要日期（`tradedAt` 本身）即可定位，不必做跨日反查。
   *
   * 防泄漏：`fills` 全部来自 trades 表，只含已发生的成交 —— 不存在「未来的买卖点」。 */
  const fillBarTimes = deriveFillBarTimes(
    trades.filter((t) => t.tradedAt === info.currentDate),
    todayAllBars,
    dailyBar?.open ?? 0,
  );
  const fills: SimTradeFill[] = [...trades]
    .sort((a, b) =>
      a.tradedAt < b.tradedAt
        ? -1
        : a.tradedAt > b.tradedAt
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    )
    .map((t) => toSimTradeFill(t, fillBarTimes.get(t.id) ?? null));

  const todayFills = fills.filter((f) => f.tradedAt === info.currentDate);
  const todayBuyFills = todayFills.filter((f) => f.side === "BUY");
  const todaySellFills = todayFills.filter((f) => f.side === "SELL");
  const todayTrades: SimTradeTodayTrades = {
    count: todayFills.length,
    buyCount: todayBuyFills.length,
    sellCount: todaySellFills.length,
    buyAmount: round(
      todayBuyFills.reduce((s, f) => s + f.amount, 0),
      2,
    ),
    sellAmount: round(
      todaySellFills.reduce((s, f) => s + f.amount, 0),
      2,
    ),
    hasBuy: todayBuyFills.length > 0,
    hasSell: todaySellFills.length > 0,
    /** 「做T」= 当日双向都发生过（见 SimTradeTodayTrades 的说明） */
    isDayTrade: todayBuyFills.length > 0 && todaySellFills.length > 0,
  };

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

  // 当日收盘价：仅在 CLOSE_ANIMATION 及之后才允许揭示（防泄漏硬约束）
  const todayClose = closeRevealed && dailyBar ? round(dailyBar.close, 2) : null;
  /**
   * 本阶段成交价：V3 起与**下单路径共用同一个取价函数**（`resolveFillPrice`），
   * 保证「界面显示的价」与「实际成交的价」永远不会是两套口径。
   * 30m 不可用时它内部退化为日K 口径，并通过 `fillPriceSource` 标明来源。
   */
  const fillInfo =
    tradable && dailyBar
      ? await resolveFillPrice({
          code: row.hiddenStockCode,
          date: info.currentDate,
          stage: info.stage,
          revealedCount: info.intradayBarCount,
          todayBar: dailyBar,
        })
      : null;
  const stageFillPrice = fillInfo && fillInfo.price > 0 ? fillInfo.price : null;

  return {
    session: info,
    summary,
    positionRatio,
    position,
    history,
    benchmarks,
    openPrice,
    prevClose,
    todayBar: todayBarInfo,
    todayClose,
    stage: info.stage,
    stageFillPrice,
    /** V3：成交价来源（`INTRADAY_30M` = 当前已揭示的 30m K；`DAILY_K` = 30m 不可用时的退化） */
    fillPriceSource: fillInfo?.source ?? null,
    /** V3：30m 成交价对应的时点（如 `10:30`）；退化时为 null */
    fillPriceTime: fillInfo?.time ?? null,
    stageActionCompleted: info.stageActionCompleted,
    remainingBuy: info.remainingBuy,
    remainingSell: info.remainingSell,
    operationCount: info.operationCount,
    remainingOps: info.remainingOps,
    intradayBarCount: info.intradayBarCount,
    maxRevealableBars: info.maxRevealableBars,
    currentIntradayTime: info.currentIntradayTime,
    pendingAction: info.pendingAction,
    pendingPercent: info.pendingPercent,
    tradable,
    lastAction,
    tradeCount,
    fills,
    todayTrades,
    curve,
    metrics,
    settlement,
  };
}

/** 成交记录 → 对外 DTO（抹去标的身份；`barTime` 为反推所得的 30m 时点） */
function toSimTradeFill(t: TradeInfo, barTime: string | null = null): SimTradeFill {
  return {
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
    barTime,
  };
}

/**
 * 由**成交价反推**每笔成交所在的 30m 时点（`SimTradeFill.barTime`）。
 *
 * 依据（确定性事实，不是猜测）：成交价就是「成交那一刻那根 30m K 的 close」——
 * 服务端下单路径正是用 `resolveFillPrice()` 从**当前已揭示的 30m K** 取 close 定价
 * （见本文件 `submitSimTradeAction`）。因此「成交价 == 某根 30m K 的 close」必然成立，
 * 反查即可还原时点。这也解释了为什么不另立数据库字段：**时点本就是价格的函数**，
 * 落库反而会引入「两个真相」。
 *
 * 消歧：同一天内可能出现两根 30m K 的 close 完全相同（横盘），此时单看价格有歧义。
 * 处理办法是利用 `Trade.id` 是 **cuid**（前缀时间单调递增）这一性质还原成交先后，
 * 并施加「后发生的成交，其时点不早于前一笔」的单调约束 —— 因为会话的 30m 游标
 * 只会前进、不会回退。这样绝大多数歧义都能唯一确定。
 *
 * 残留局限（如实记录）：若同一天内**多根 K 的 close 完全相同**，且成交恰好落在
 * 其中较晚的一根，则可能被定位到较早的同价根上 —— 价格标注仍然正确，只有
 * 横轴位置偏移。此时宁可偏移也不伪造：**找不到匹配一律返回 null，不猜位置**。
 *
 * 适用边界：**只对调用方传入的那一天（= 会话当前日）的成交有效**。跨日的成交不会
 * 被传进来（每根 30m K 只属于某一天），因此这些成交的 `barTime` 为 null ——
 * 这不影响任何展示：分时图只画**当日**买卖点，日K 只用日期（`tradedAt`）定位。
 *
 * @param fills 待反推的成交（同一交易日内）
 * @param bars  该交易日的 30m K（升序，带 `time`）
 */
function deriveFillBarTimes(
  fills: TradeInfo[],
  bars: KlineBar[],
  /**
   * 当日开盘价（**日K 的 open**，即快照的 `openPrice`）。
   *
   * 必须与 `resolveFillPrice` 用同一个值：开盘价成交的那笔，其价格就是日K 的 open，
   * 若这里改用 30m 第 1 根的 open，会因两者 0.01 级差异而**匹配不上**，
   * 该笔的 `barTime` 变成 null、分时图上的 B/S 点随之消失。
   */
  dayOpen: number,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const usable = bars.filter((b) => typeof b.time === "string" && b.time.length > 0);
  if (usable.length === 0 || fills.length === 0) {
    for (const f of fills) out.set(f.id, null);
    return out;
  }

  /*
   * 候选「时点 → 价格」序列（按时间升序），必须把**两种定价口径都列入**：
   *   · `09:30` = **日K 的 open** —— 刚开盘（未推进）时下单按开盘价成交；
   *   · 其余时点 = 对应 30m 根的 **close** —— 推进过之后按该根收盘价成交。
   *
   * 只列 close 是不够的：开盘价（open）通常不等于任何一根的 close，
   * 那样「开盘就下单」的成交会永远匹配不到、`barTime` 变成 null，
   * 分时图上的 B/S 点随之消失。
   */
  const candidates: Array<{ time: string; price: number }> = [];
  if (dayOpen > 0) {
    candidates.push({ time: INTRADAY_OPEN_ANCHOR, price: round(dayOpen, 2) });
  }
  for (const b of usable) {
    if (b.close > 0) {
      candidates.push({ time: (b.time as string).slice(0, 5), price: round(b.close, 2) });
    }
  }
  // `HH:MM` 定长，字典序即时间序
  candidates.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  // cuid 前缀单调 → 字符串升序即真实成交先后
  const ordered = [...fills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let floor = 0;
  for (const f of ordered) {
    const target = round(f.price, 2);
    let hit = -1;
    for (let i = floor; i < candidates.length; i += 1) {
      if (candidates[i].price === target) {
        hit = i;
        break;
      }
    }
    // 单调约束下没找到 → 放宽到全量再找一次（防御性；正常不会走到）
    if (hit === -1) {
      for (let i = 0; i < candidates.length; i += 1) {
        if (candidates[i].price === target) {
          hit = i;
          break;
        }
      }
    }
    if (hit === -1) {
      out.set(f.id, null);
      continue;
    }
    out.set(f.id, candidates[hit].time);
    floor = hit;
  }
  return out;
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
      // 费用口径统一走 tradingEngine 的 calcFees（与玩家交易完全一致，
      // 杜绝「第二套费用规则」导致的规则漂移与舍入不一致）
      const buyFees = calcFees(buyAmount, "BUY");
      const sellFees = calcFees(sellAmount, "SELL");
      const cashLeft = info.initialCash - buyAmount - buyFees.total;
      buyHoldProfit = round(
        cashLeft + sellAmount - sellFees.total - info.initialCash,
        2,
      );
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
  /**
   * V3 确认模式：为 true 表示「只是落库为待确认，**尚未成交**」。
   * 前端据此提示「待确认」而不是「已成交」。
   */
  pending?: boolean;
}

/**
 * 提交一次操作（买入 / 卖出 / 观望）。
 *
 * V3 规则（硬约束）：
 *  - **每日总操作 ≤ 8**：BUY / SELL / HOLD **统一计数**（`operationCountToday`）；
 *    与买卖配额**并列**成立 —— 总操作 ≤ 8 且 买入 ≤ 2 且 卖出 ≤ 2；
 *  - **时间与操作解耦**：`stage` 只表示时间窗（OPEN 开盘 / CLOSE 收盘），
 *    一个时间窗内允许连续操作多次；**推进时间不消耗操作次数**
 *    （推进由 `advanceSimTradeStage` 负责，那里已不要求「本阶段必须操作过」）；
 *  - 阶段由服务端 `session.stage` 唯一决定，客户端不可干预；
 *  - 成交价由服务端按阶段决定（阶段 6 起改为取当前已揭示的 30m K，客户端传价无效）；
 *  - 交易失败（资金/持仓/T+1/停牌）→ **回滚操作占位**：既不消耗操作额度、也不消耗
 *    买卖配额，允许玩家重新选择（失败不会「吃掉」一次操作机会）；
 *  - 成交日 & 行情可见上界 = currentDate（服务端强制，客户端不可覆盖）；
 *  - 一切资金/持仓/T+1/费用校验仍全部下沉 tradingEngine，本文件不复制交易规则。
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

  const stage = info.stage;
  // 阶段校验：只有 OPEN（开盘）/ CLOSE（收盘）两个阶段允许下单
  if (!isTradableStage(stage)) {
    return { success: false, message: stageHint(stage) };
  }
  // V3 额度校验：每日**总操作** ≤ 8（BUY / SELL 统一计数）
  //
  // 这里**不再**用 `stageActionCompleted` 拦截：一个阶段（时间窗）内允许连续操作多次，
  // 「当天是否还能操作」只由总操作计数决定。买入/卖出的 2 次配额在下面单独校验。
  //
  // 注（2026-09-24）：观望取消后，实际可达的操作数上限 = 买 2 + 卖 2 = 4 < 8，
  // 因此这条分支成为**纯安全上限**（防御未来的规则变更或非常规调用），正常玩法碰不到。
  // 文案里**不再暴露具体数字** —— 界面上已按需求隐藏了总操作次数，接口文案保持一致。
  if (info.remainingOps <= 0) {
    return {
      success: false,
      message: "今日操作次数已用完，请推进到下一交易日",
    };
  }

  const action: SimTradeAction = input.action;

  /* 观望（HOLD）已取消 —— 2026-09-24
   *
   * 理由：玩家可以**免费推进 30 分钟 K 线**（`advanceSimTradeIntraday` 不消耗任何操作次数），
   * 「什么都不做」这件事因此已经由「推进时间」承担，观望只是多消耗一次操作的冗余动作。
   *
   * ⚠️ `SimTradeAction` 类型**仍保留 `"HOLD"`**，有两处依赖它，不能一起删：
   *   1. 结算当日时，若玩家全天无成交，系统会自动补一条 `action: "HOLD"` 的记录
   *      （见本文件 `action: hasBuy ? "BUY" : hasSell ? "SELL" : "HOLD"`）；
   *   2. 历史库里已存在的观望记录仍需正常展示。
   * 这里只关闭**玩家提交入口**，不动记录类型。
   */
  if (action === "HOLD") {
    return {
      success: false,
      message: "观望已取消：想「什么都不做」请直接推进 30 分钟 K 线（推进不消耗操作次数）",
    };
  }
  if (action !== "BUY" && action !== "SELL") {
    return { success: false, message: "操作类型必须为 BUY / SELL" };
  }

  /**
   * 执行模式（V3）：`INSTANT` 立即执行 / `CONFIRM` 落库为 pending。
   *
   * 默认 **INSTANT**：`mode` 是 V3 新增的可选参数，缺省时必须与旧行为一致，
   * 否则所有既有调用方（含既有测试）会从「立即成交」静默变成「只落 pending 不成交」。
   * 前端会**显式**传 `mode`，不依赖该默认值。
   */
  const mode: SimTradeExecutionMode = input.mode === "CONFIRM" ? "CONFIRM" : "INSTANT";

  const code = row.hiddenStockCode;
  const adjust = toAdjust(row.adjust);
  const today = info.currentDate;

  // 当日必须有行情（真实交易日），否则无法成交（停牌/非交易日直接拒绝）
  const todayBar = await getKlineAt(code, today, adjust);
  if (!todayBar) {
    return { success: false, message: "当前交易日该标的无行情，无法操作" };
  }

  /**
   * 成交价（V3 阶段 6）：由服务端按**当前已揭示的 30m K** 决定。
   *
   * 客户端**无法提供价格** —— 本函数不接受任何价格入参；即使请求体里带了 `price`
   * 字段也不会被读取。上界由会话 30m 游标与阶段共同夹取，因此不可能用到未来棒。
   */
  const fill = await resolveFillPrice({
    code,
    date: today,
    stage,
    revealedCount: info.intradayBarCount,
    todayBar,
  });
  const fillPrice = fill.price;
  if (fillPrice <= 0) return { success: false, message: "成交价异常，无法操作" };

  // 每日买卖次数额度校验（开盘 + 收盘共享；观望 HOLD 不消耗次数）
  if (action === "BUY" && info.remainingBuy <= 0) {
    return {
      success: false,
      message: `今日买入次数已用完（每日上限 ${MAX_BUY_PER_DAY} 次），可卖出或推进时间`,
    };
  }
  if (action === "SELL" && info.remainingSell <= 0) {
    return {
      success: false,
      message: `今日卖出次数已用完（每日上限 ${MAX_SELL_PER_DAY} 次），可买入或推进时间`,
    };
  }

  /* -------- 1) 交易前校验：全部在「占位」之前完成，避免占位后回滚 -------- */
  /* 观望已取消（2026-09-24）后，能走到这里的 `action` 只可能是 BUY / SELL，
     因此 `side` 直接确定为非空 —— 原先那层 `if (action !== "HOLD")` 包裹已无意义。 */
  const side: OrderSide = action === "BUY" ? "BUY" : "SELL";
  let quantity = 0;

  // 比例校验：BUY / SELL 必须**显式**给出 1~100 的数字，非法值一律拒绝。
  // 绝不 `?? 100` 静默退化为满仓 —— 那会让一个畸形请求变成全仓买入，
  // 属危险的隐式行为（缺省/NaN/null/越界 全部拒绝）。
  const rawPercent = input.percent;
  if (typeof rawPercent !== "number" || !Number.isFinite(rawPercent)) {
    return { success: false, message: "操作比例必须是 1~100 之间的数字" };
  }
  if (rawPercent < 1 || rawPercent > 100) {
    return { success: false, message: "操作比例必须在 1~100 之间" };
  }
  const percent = Math.floor(rawPercent);

  quantity = await resolveQuantity({
    accountId: info.accountId,
    side,
    percent,
    price: fillPrice,
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

  /* -------- 1.5) 确认模式：落库为 pending，**不消耗任何计数** --------
   * 此处已完成全部前置校验（阶段 / 总操作额度 / 买卖配额 / 比例合法性 / 可成交性），
   * 因此 pending 必然是一份「提交当时可执行」的请求。
   *
   * 真正的成交发生在 `/confirm`：届时会**再次完整校验**并走与立即模式
   * **完全相同**的执行路径 —— 两种模式不共享「何时执行」，但共享「如何执行」，
   * 不存在第二套交易规则、不存在第二套费用或 T+1 实现。
   *
   * 并发：用「以旧 pending 为条件」的 CAS 写入，双击不会写出两份不同的 pending。 */
  if (mode === "CONFIRM") {
    const pendingPercent = Math.floor(percent);
    const claimed = await prisma.simTradeSession.updateMany({
      where: { id: sessionId, pendingAction: row.pendingAction },
      data: {
        pendingAction: action,
        pendingPercent,
        pendingStage: stage,
        pendingDate: normalizeDate(today),
      },
    });
    if (claimed.count !== 1) {
      return { success: false, message: "待确认操作正在写入，请刷新后重试" };
    }
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message:
        `已提交待确认：${action === "BUY" ? "买入" : "卖出"} ${pendingPercent}%（尚未成交，请确认）`,
      finished: false,
      pending: true,
      snapshot: snapshot ?? undefined,
    };
  }

  /* -------- 2) 原子占位（compare-and-swap）：并发防护 --------
   * 「读后判断」在并发下不可靠：两次请求可能都读到 `operationCountToday = k` 而双双成交
   * （双击 / 网络重试即可触发）。这里改为**以旧计数为条件的自增**做原子占位：
   * SQLite 写操作串行化，并发双提交时只有一个能拿到 count=1，另一个被拒。
   *
   * 买入/卖出还额外把各自计数纳入条件 —— 否则「买入 ≤ 2」在并发下仍可能被突破。 */
  const prevOps = row.operationCountToday;
  const prevStageActionCompleted = row.stageActionCompleted;
  const claim = await prisma.simTradeSession.updateMany({
    where: {
      id: sessionId,
      operationCountToday: prevOps,
      ...(action === "BUY" ? { buyCountToday: row.buyCountToday } : {}),
      ...(action === "SELL" ? { sellCountToday: row.sellCountToday } : {}),
    },
    data: {
      operationCountToday: prevOps + 1,
      stageActionCompleted: true,
      stageActionAt: new Date(),
    },
  });
  if (claim.count !== 1) {
    return { success: false, message: "操作过于频繁，请刷新后重试" };
  }

  /* -------- 3) 执行交易；失败则释放占位（不结束阶段、不消耗额度） -------- */
  if (side) {
    // 用「限价单 + 阶段成交价」把价格精确下沉给引擎：引擎仍完整负责
    // 资金 / 持仓 / T+1 / 停牌校验与费用计算，本文件不复制任何交易规则。
    const result = await placeOrder({
      accountId: info.accountId,
      stockCode: code,
      side,
      orderType: "LIMIT",
      price: fillPrice,
      quantity,
      // 成交日 = 当前模拟交易日；同时作为行情可见上界下沉引擎（双重防泄漏）
      tradeDate: today,
      asOfDate: today,
    });
    if (!result.success) {
      // 交易失败：**回滚占位** —— 不消耗操作额度、不消耗买卖配额，允许玩家重新选择。
      // 条件用「自增后的值」做 CAS，避免把并发的另一次成功操作误回滚。
      await prisma.simTradeSession.updateMany({
        where: { id: sessionId, operationCountToday: prevOps + 1 },
        data: {
          operationCountToday: prevOps,
          stageActionCompleted: prevStageActionCompleted,
        },
      });
      return { success: false, message: result.message };
    }
  }

  /* -------- 4) 计入买卖配额（总操作数已在第 2 步原子自增） --------
   * V3：**操作不再改变 `stage`** —— 阶段只表示时间窗（开盘 / 收盘），由玩家显式推进；
   * 一个阶段内允许多次操作，能否继续操作由总操作计数把关。
   * 历史遗留：HOLD（观望）曾**同样消耗一次操作**，但不消耗买入/卖出配额；
   * 该入口已于 2026-09-24 关闭，历史记录仍照常展示。
   * 计数一律走 `{ increment: 1 }`（SQL 层自增），避免「读后写」在并发下少计。 */
  const data: {
    buyCountToday?: { increment: number };
    sellCountToday?: { increment: number };
    pendingAction: null;
    pendingPercent: null;
    pendingStage: null;
    pendingDate: null;
  } = {
    // 成交即清空 pending：本次无论来自立即模式还是确认模式，都不应残留待确认操作
    pendingAction: null,
    pendingPercent: null,
    pendingStage: null,
    pendingDate: null,
  };
  if (action === "BUY") data.buyCountToday = { increment: 1 };
  if (action === "SELL") data.sellCountToday = { increment: 1 };
  await prisma.simTradeSession.updateMany({ where: { id: sessionId }, data });
  await refreshDailyAsset(info.accountId, today);

  const snapshot = await getSimTradeSnapshot(sessionId);
  const stageName = stage === "OPEN" ? "开盘阶段" : "收盘阶段";
  const actName = action === "BUY" ? "买入" : "卖出";
  const remainingOps = Math.max(0, MAX_OPERATIONS_PER_DAY - (prevOps + 1));
  // 在文案里显式标明成交价来源：便于玩家理解，也让测试能断言「用的是哪套价」。
  // 09:30 锚点单独措辞为「开盘价」—— 它不是任何一根 30m K 的收盘时点，
  // 写成「30m 09:30 价」会让人误以为存在一根 09:30 收盘的 K 线。
  const priceSourceLabel =
    fill.source !== "INTRADAY_30M"
      ? "日K 价（30m 数据不可用）"
      : fill.time === INTRADAY_OPEN_ANCHOR
        ? "开盘价"
        : `30m ${fill.time} 价`;
  return {
    success: true,
    message: `${stageName}已按 ¥${fillPrice.toFixed(2)} 完成${actName}（${priceSourceLabel}；今日剩余操作 ${remainingOps} 次）`,
    finished: false,
    snapshot: snapshot ?? undefined,
  };
}

/* ------------------------------------------------------------------ */
/*                  V3：确认模式（pending → confirm → execute）          */
/* ------------------------------------------------------------------ */

/**
 * 确认并执行业已落库的待确认操作。
 *
 * 链路：`/action(mode=CONFIRM)` 落 pending → **本函数** → 服务端重新校验 → 成交。
 *
 * 服务端重新校验的内容（一项都不能省）：
 *  1. 会话存在且 `ACTIVE`；
 *  2. pending 仍在（未被执行 / 未取消）；
 *  3. **阶段未变**（`pendingStage === 当前 stage`）—— 拒绝跨阶段 confirm；
 *  4. **交易日未变**（`pendingDate === currentDate`）—— 拒绝跨日 confirm；
 *  5. 之后交给 `submitSimTradeAction(mode="INSTANT")` 再次完整校验：
 *     阶段可交易、总操作额度、买入/卖出配额、比例合法、当日有行情（停牌）、
 *     资金 / 持仓 / T+1，以及**成交价** —— 全部由服务端决定，客户端传价无效。
 *
 * 并发：先以 CAS 把 pending「取走」，双击 confirm 只有一次能拿到（另一次被拒），
 * 因此不会出现「一次提交、两次成交」。
 */
export async function confirmSimTradeAction(
  sessionId: string,
): Promise<SubmitActionResult> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!row) return { success: false, message: "模拟炒股会话不存在" };

  const pending = (row.pendingAction as SimTradeAction | null) ?? null;
  if (!pending || (pending !== "BUY" && pending !== "SELL" && pending !== "HOLD")) {
    return { success: false, message: "当前没有待确认的操作" };
  }

  const info = toSimTradeInfo(row);
  if (info.status !== "ACTIVE") {
    return { success: false, message: "该模拟炒股已结束，无法继续操作" };
  }

  const clearPending = {
    pendingAction: null,
    pendingPercent: null,
    pendingStage: null,
    pendingDate: null,
  } as const;

  /* 观望已取消（2026-09-24）：历史遗留的 pending HOLD 无法再成交。
     这里**主动清掉**并明确告知原因，而不是把它一直挂在「待确认」状态里
     —— 否则玩家会看到一个点了没反应、也说不清为什么的按钮。 */
  if (pending === "HOLD") {
    await prisma.simTradeSession.updateMany({
      where: { id: sessionId, pendingAction: "HOLD" },
      data: clearPending,
    });
    return {
      success: false,
      message: "观望已取消，该待确认操作已自动清除；想「什么都不做」请直接推进 30 分钟 K 线",
    };
  }

  // 跨阶段 / 跨交易日 → pending 已失效：先清掉再拒，避免它一直挂在那里
  const sameStage = row.pendingStage === info.stage;
  const sameDate = !!row.pendingDate && toDateStr(row.pendingDate) === info.currentDate;
  if (!sameStage || !sameDate) {
    await prisma.simTradeSession.updateMany({
      where: { id: sessionId, pendingAction: pending },
      data: clearPending,
    });
    return {
      success: false,
      message: "阶段或交易日已变化，待确认操作已失效，请重新选择",
    };
  }

  // 原子取走 pending：并发双击时只有一个请求能拿到 count=1
  const claimed = await prisma.simTradeSession.updateMany({
    where: { id: sessionId, pendingAction: pending, pendingStage: row.pendingStage },
    data: clearPending,
  });
  if (claimed.count !== 1) {
    return { success: false, message: "待确认操作已被处理，请刷新后重试" };
  }

  // 走与「立即模式」**完全相同**的执行路径（含服务端全部重新校验）
  const percent = row.pendingPercent ?? undefined;
  return submitSimTradeAction(sessionId, { action: pending, percent, mode: "INSTANT" });
}

/** 取消待确认操作（不消耗任何计数） */
export async function cancelSimTradeAction(
  sessionId: string,
): Promise<SubmitActionResult> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: { id: true, pendingAction: true },
  });
  if (!row) return { success: false, message: "模拟炒股会话不存在" };
  if (!row.pendingAction) {
    return { success: false, message: "当前没有待确认的操作" };
  }
  await prisma.simTradeSession.updateMany({
    where: { id: sessionId, pendingAction: row.pendingAction },
    data: {
      pendingAction: null,
      pendingPercent: null,
      pendingStage: null,
      pendingDate: null,
    },
  });
  const snapshot = await getSimTradeSnapshot(sessionId);
  return {
    success: true,
    message: "已取消待确认操作",
    finished: false,
    snapshot: snapshot ?? undefined,
  };
}

/**
 * 按比例换算委托数量。
 *
 *  - BUY：可用现金 × percent% 为预算 → 在「成交额 + 实际买入费用 ≤ 预算」约束下
 *    取最大的整手数量（费用随金额变化，故逐手回退求最大可买量，不预留整手成本）；
 *  - SELL：可卖份额 × percent% → 非 100% 时按比例取整手；若比例低于 1 手，
 *    因 A 股卖出允许零股，则取至少 1 股；100% 时直接取全部可卖份额。
 *
 * 数量最终仍需通过 tradingEngine 的资金/持仓校验，这里只做「按比例换算」。
 */
async function resolveQuantity(input: {
  accountId: string;
  side: OrderSide;
  percent: number;
  /** 本阶段成交价（OPEN = 开盘价 / CLOSE = 收盘价） */
  price: number;
  currentDate: string;
}): Promise<number> {
  const { accountId, side, percent, price, currentDate } = input;
  if (price <= 0) return 0;

  if (side === "BUY") {
    const summary = await getAccountSummary(accountId, currentDate);
    if (!summary) return 0;

    // A 股按 100 股整手买入，买入需支付佣金(万三，最低 5 元) + 过户费(万 0.1)。
    //
    // 费用随成交额**线性变化**（不是常数），所以「固定预留一手费用」的估算在大额
    // 预算下会严重低估费用（例：5000 万预算实际费用约 1.55 万，而一手费用仅约 5 元），
    // 导致 100% 档被误判为「可用资金不足」而整单拒绝；反过来在小额/高价股下又会
    // 多扣一手成本、使满仓明显不满。
    //
    // 因此这里改为从「忽略费用的理论上限」起步逐手回退，直到
    // 「成交额 + 实际买入支出」落进本次比例预算为止：
    //   - 上限严格取 `<= totalBudget`（不留 epsilon），保证引擎事务内的
    //     资金校验必然通过，不会出现「本地算过、下单被拒」；
    //   - 费用一律取自 tradingEngine 的 calcFees / calcBuyOutlay，
    //     本文件不重复任何费用规则（避免规则漂移）。
    const totalBudget = (summary.availableCash * percent) / 100;
    if (totalBudget <= 0) return 0;

    let qty = Math.floor(totalBudget / price / 100) * 100;
    while (qty > 0) {
      const amount = round(qty * price, 2);
      if (calcBuyOutlay(amount, calcFees(amount, "BUY")) <= totalBudget) return qty;
      qty -= 100;
    }
    return 0;
  }

  // SELL
  const positions = await getPositions(accountId, currentDate);
  if (positions.length === 0) return 0;
  const sellable = positions[0].availableQty;
  if (sellable <= 0) return 0;
  if (percent >= 100) return sellable;
  // 按比例折算后不足一手时，仍应允许卖出至少 1 股；A 股卖出允许零股，
  // 否则持有 100 股时卖 50% 会被错误地折算为 0 股并拒绝。
  const proportional = Math.floor((sellable * percent) / 100);
  if (proportional <= 0) return 0;
  if (proportional < 100) return proportional;
  return Math.floor(proportional / 100) * 100;
}

/**
 * 推进交易阶段 / 进入下一交易日（V2 阶段状态机，服务端唯一权威）。
 *
 * 状态流转：
 *   OPEN_CONFIRMED  --①--> CLOSE_ANIMATION   揭示当日收盘价，前端播放收盘动画
 *   CLOSE_ANIMATION --②--> CLOSE             动画结束，开放收盘阶段交易
 *   CLOSE_CONFIRMED --③--> DAY_SETTLED       当日结算（重算资产快照）
 *   DAY_SETTLED     --④--> 下一日 OPEN        T+1 解冻 + 推进 currentDate + 计数清零
 *                          （若已是日历末尾 → FINISHED）
 *
 * 防泄漏：① 之前一律不返回当日 high/low/close；① 起才揭示（见 isCloseRevealed）。
 * 幂等：已 FINISHED 时直接返回 finished=true；处于 OPEN / CLOSE（尚未操作）时拒绝推进。
 */
/**
 * 阶段并发保护的兜底返回：条件更新未命中，说明另一个并发请求已经推进了阶段。
 *
 * 此时**不是失败** —— 状态确实前进了，只是不是本次请求推的。因此重新读取快照，
 * 按幂等成功返回，避免前端把「双击的第二下」显示成红色报错。
 */
async function staleStageResult(sessionId: string): Promise<SubmitActionResult> {
  const snapshot = await getSimTradeSnapshot(sessionId);
  return {
    success: true,
    message: "阶段已推进",
    finished: snapshot?.session.status === "FINISHED",
    snapshot: snapshot ?? undefined,
  };
}

export async function advanceSimTradeStage(sessionId: string): Promise<SubmitActionResult> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!row) return { success: false, message: "模拟炒股会话不存在" };

  const info = toSimTradeInfo(row);
  if (!info.accountId) return { success: false, message: "模拟炒股账户缺失" };

  // 幂等：已结束
  if (info.status === "FINISHED") {
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: "本局已结束",
      finished: true,
      snapshot: snapshot ?? undefined,
    };
  }

  const stage = info.stage;

  // ⓪ V3：开盘阶段 → 直接进入收盘动画（**推进时间不消耗操作次数**）
  //
  // 旧规则要求「先在开盘阶段操作 1 次」才允许推进；V3 把时间与操作解耦：
  // 玩家可在开盘这个时间窗内操作 0~8 次，然后自主推进时间。可操作与否由
  // `operationCountToday` 把关，不再要求「本阶段必须操作过」。
  if (stage === "OPEN") {
    const moved = await prisma.simTradeSession.updateMany({
      where: { id: sessionId, stage: "OPEN" },
      data: {
        stage: "CLOSE_ANIMATION",
        stageActionCompleted: false,
        // 进入收盘揭示 → 30m 游标拉满：第 8 根（15:00）即当日收盘价，此处才允许揭示
        intradayBarCount: BARS_PER_DAY,
      },
    });
    if (moved.count !== 1) return staleStageResult(sessionId);
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: "开盘阶段结束，今日收盘价已公布",
      finished: false,
      snapshot: snapshot ?? undefined,
    };
  }

  // ①（兼容历史数据）开盘阶段已操作 → 进入收盘动画
  if (stage === "OPEN_CONFIRMED") {
    const moved = await prisma.simTradeSession.updateMany({
      where: { id: sessionId, stage: "OPEN_CONFIRMED" },
      data: {
        stage: "CLOSE_ANIMATION",
        stageActionCompleted: false,
        // 进入收盘揭示 → 30m 游标拉满：第 8 根（15:00）即当日收盘价，此处才允许揭示
        intradayBarCount: BARS_PER_DAY,
      },
    });
    if (moved.count !== 1) return staleStageResult(sessionId);
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: "今日收盘价已公布",
      finished: false,
      snapshot: snapshot ?? undefined,
    };
  }

  // ② 收盘动画结束 → 开放收盘阶段交易
  if (stage === "CLOSE_ANIMATION") {
    const moved = await prisma.simTradeSession.updateMany({
      where: { id: sessionId, stage: "CLOSE_ANIMATION" },
      data: { stage: "CLOSE", stageActionCompleted: false },
    });
    if (moved.count !== 1) return staleStageResult(sessionId);
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: "进入收盘阶段",
      finished: false,
      snapshot: snapshot ?? undefined,
    };
  }

  // ③b V3：收盘阶段 → 当日结算（同样**不消耗操作次数**）
  if (stage === "CLOSE") {
    const moved = await prisma.simTradeSession.updateMany({
      where: { id: sessionId, stage: "CLOSE" },
      data: { stage: "DAY_SETTLED", confirmedDate: normalizeDate(info.currentDate) },
    });
    if (moved.count !== 1) return staleStageResult(sessionId);
    await refreshDailyAsset(info.accountId, info.currentDate);
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: "今日已结算",
      finished: false,
      snapshot: snapshot ?? undefined,
    };
  }

  // ③（兼容历史数据）收盘阶段已操作 → 当日结算
  if (stage === "CLOSE_CONFIRMED") {
    const moved = await prisma.simTradeSession.updateMany({
      where: { id: sessionId, stage: "CLOSE_CONFIRMED" },
      data: { stage: "DAY_SETTLED" },
    });
    if (moved.count !== 1) return staleStageResult(sessionId);
    await refreshDailyAsset(info.accountId, info.currentDate);
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: "今日已结算",
      finished: false,
      snapshot: snapshot ?? undefined,
    };
  }

  // ④ 当日已结算 → 进入下一交易日（或结束本局）
  if (stage === "DAY_SETTLED") {
    if (!info.nextDate) {
      const moved = await prisma.simTradeSession.updateMany({
        where: { id: sessionId, stage: "DAY_SETTLED" },
        data: { status: "FINISHED" },
      });
      if (moved.count !== 1) return staleStageResult(sessionId);
      const snapshot = await getSimTradeSnapshot(sessionId);
      return {
        success: true,
        message: "已到达模拟末尾，本局结束",
        finished: true,
        snapshot: snapshot ?? undefined,
      };
    }

    const nextDate = info.nextDate;
    // T+1 结算：把「非当日买入」的份额置为可卖
    await settleT1(info.accountId, nextDate);
    // 推进行情可见上界 + 重置阶段与当日额度
    // （条件更新兜住并发：另一个请求已推进时不再重复写，直接返回最新快照）
    const moved = await prisma.simTradeSession.updateMany({
      where: { id: sessionId, stage: "DAY_SETTLED" },
      data: {
        currentDate: normalizeDate(nextDate),
        confirmedDate: null,
        stage: "OPEN",
        stageActionCompleted: false,
        stageActionAt: null,
        buyCountToday: 0,
        sellCountToday: 0,
        // V3：进入新交易日必须重置**总操作**计数，否则第二天一上来就被锁死
        operationCountToday: 0,
        // V3：30m 游标回到当日第 1 根（可见上界随新交易日重新开始）
        intradayBarCount: 1,
      },
    });
    if (moved.count !== 1) return staleStageResult(sessionId);
    await refreshDailyAsset(info.accountId, nextDate);
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: `已进入下一交易日 ${nextDate}`,
      finished: false,
      snapshot: snapshot ?? undefined,
    };
  }

  // 防御性兜底：6 个阶段已在上方全部分支处理，理论不可达。
  // （V3 起 OPEN / CLOSE 已可直接推进 —— 时间推进不要求「本阶段已操作过」。）
  return { success: false, message: stageHint(stage) };
}

/* ------------------------------------------------------------------ */
/*              V3：结算并进入下一交易日（原子合并操作）                   */
/* ------------------------------------------------------------------ */

/** `settleAndAdvanceToNextDay` 允许的起始阶段 */
const SETTLE_THEN_NEXT_STAGES: readonly SimTradeStage[] = [
  "CLOSE",
  "CLOSE_CONFIRMED",
  "DAY_SETTLED",
];

/**
 * 「收盘结算 + 进入下一交易日」—— **原子合并操作**（用户需求：结算卡上的
 * `[进入下一交易日]` 一次点击即完成换日）。
 *
 * 为什么做成服务端单一操作，而不是让前端连调两次 `/next`：
 *   `/next` 是**每次只走一格**的状态机（CLOSE → DAY_SETTLED → 下一日）。
 *   前端盲连两次有真实风险：若会话已因另一标签页/重试先走了一格，
 *   第二次调用就会从**新交易日的 OPEN** 继续推进 → 直接跳到 `CLOSE_ANIMATION`，
 *   把新一天的收盘价提前揭示（**未来数据泄露**）。
 *   服务端知道日历与当前阶段，可以精确地「只走到换日为止」，不会越界。
 *
 * 行为：
 *   - 起始 `CLOSE` / `CLOSE_CONFIRMED` → 结算为 `DAY_SETTLED`，再换日；
 *   - 起始 `DAY_SETTLED` → 直接换日；
 *   - 起始 `OPEN` / `OPEN_CONFIRMED` → **拒绝**（当日尚未收盘，必须先看收盘，
 *     否则等于跳过「公布收盘价」这一步，与需求 二/十九 的流程不符）；
 *   - 已 `FINISHED` → 幂等返回 finished。
 *
 * 幂等与并发：内部逐步复用 `advanceSimTradeStage`（自带 CAS + `staleStageResult`），
 * 并以「日期是否已变化」为终止条件，重复点击不会多走一天。
 */
export async function settleAndAdvanceToNextDay(
  sessionId: string,
): Promise<SubmitActionResult> {
  const first = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!first) return { success: false, message: "模拟炒股会话不存在" };

  if (first.status === "FINISHED") {
    const snapshot = await getSimTradeSnapshot(sessionId);
    return {
      success: true,
      message: "本局已结束",
      finished: true,
      snapshot: snapshot ?? undefined,
    };
  }

  const firstStage = toStage(first.stage);
  if (!SETTLE_THEN_NEXT_STAGES.includes(firstStage)) {
    return {
      success: false,
      message: "当日尚未收盘，请先点击「看收盘」公布当日收盘价",
    };
  }

  const startDate = toDateStr(first.currentDate);
  let lastMessage = "";

  // 最多 3 格：CLOSE → DAY_SETTLED → 下一日。以「日期已变化」为硬终止条件。
  for (let i = 0; i < 4; i += 1) {
    const row = await prisma.simTradeSession.findUnique({
      where: { id: sessionId },
      select: { currentDate: true, status: true, stage: true },
    });
    if (!row) break;
    if (row.status === "FINISHED") break;
    // 日期已经变了说明换日完成 —— 立刻停，避免在新交易日继续推进（会提前揭示新日收盘）
    if (i > 0 && toDateStr(row.currentDate) !== startDate) break;

    const step = await advanceSimTradeStage(sessionId);
    lastMessage = step.message;
    if (!step.success) {
      // 推进失败：把真实原因透出（例如额度/并发提示），但保留已有快照
      const snapshot = await getSimTradeSnapshot(sessionId);
      return { ...step, snapshot: snapshot ?? undefined };
    }
    if (step.finished) {
      const snapshot = await getSimTradeSnapshot(sessionId);
      return { ...step, snapshot: snapshot ?? undefined };
    }
  }

  const snapshot = await getSimTradeSnapshot(sessionId);
  const finished = snapshot?.session.status === "FINISHED";
  const changed = snapshot ? snapshot.session.currentDate !== startDate : false;

  return {
    success: true,
    message: finished
      ? "已到达模拟末尾，本局结束"
      : changed
        ? `已进入下一交易日 ${snapshot?.session.currentDate}`
        : lastMessage || "已结算",
    finished,
    snapshot: snapshot ?? undefined,
  };
}

/* ------------------------------------------------------------------ */
/*                     V3：30m 时间轴（与操作解耦）                      */
/* ------------------------------------------------------------------ */

/**
 * 推进「30m 时间轴」一格：当日已揭示的 30m K 从 n 根变为 n+1 根。
 *
 * 设计要点（V3 核心，勿混）：
 *  - **与操作计数完全解耦**：推进 30m 不消耗 `operationCountToday`，
 *    也**不要求**玩家先操作 —— 时间轴与玩家行为是两条独立的轴；
 *  - 一根 30m K **不等于**一次操作（8 根 ≠ 8 次）；玩家可以只看不操作，
 *    也可以在一个已揭示的时点上连续操作多次（受总操作 ≤8 约束）；
 *  - 开盘阶段上限 **7 根**：第 8 根是 15:00，其 close 即当日收盘价，
 *    必须等 `CLOSE_ANIMATION` 才揭示（防泄漏红线，不可放宽）；
 *  - 用「以旧游标为条件」的 CAS 自增：并发重复点击不会多推进一格。
 */
export async function advanceSimTradeIntraday(
  sessionId: string,
): Promise<SubmitActionResult> {
  const row = await prisma.simTradeSession.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!row) return { success: false, message: "模拟炒股会话不存在" };

  const info = toSimTradeInfo(row);
  if (info.status !== "ACTIVE") {
    return { success: false, message: "该模拟炒股已结束，无法继续操作" };
  }
  if (!isTradableStage(info.stage)) {
    return { success: false, message: stageHint(info.stage) };
  }

  const cap = maxRevealableBars(info.stage);
  if (info.intradayBarCount >= cap) {
    return {
      success: false,
      message:
        info.stage === "OPEN"
          ? `开盘阶段最多揭示到 ${INTRADAY_TIMES[MAX_REVEALED_BARS_IN_OPEN - 1].slice(0, 5)}，当日收盘价需进入收盘阶段后才公布`
          : `当日 ${BARS_PER_DAY} 根 30 分钟 K 已全部揭示`,
    };
  }

  const moved = await prisma.simTradeSession.updateMany({
    where: { id: sessionId, intradayBarCount: row.intradayBarCount },
    data: { intradayBarCount: row.intradayBarCount + 1 },
  });
  if (moved.count !== 1) {
    return { success: false, message: "操作过于频繁，请刷新后重试" };
  }

  const next = row.intradayBarCount + 1;
  const snapshot = await getSimTradeSnapshot(sessionId);
  return {
    success: true,
    message: `已揭示 30 分钟 K：${intradayTimeLabel(next)}（第 ${next}/${BARS_PER_DAY} 根，不消耗操作次数）`,
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
