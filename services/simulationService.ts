/**
 * simulationService —— 历史模拟交易会话
 *
 * 职责边界：
 *  - 本文件只负责「会话生命周期 + 交易日推进 + 快照/绩效读取」；
 *    **一切交易规则（费用、T+1、资金校验、持仓、盈亏）仍只在 tradingEngine.ts**，
 *    本文件不复制任何买卖逻辑，也不直接改写 Account / Position 表。
 *  - 每个会话独占一个 Account（`Account.simulationId`），与普通模拟账户完全解耦。
 *
 * 防未来数据泄露（核心约束）：
 *  - 会话的 `currentDate` 是**唯一**允许读取行情的上界，服务端强制，接口不接受
 *    客户端覆盖；所有取价都走 `getAccountSummary(id, asOf)` / `getPositions(id, asOf)`
 *    / `getQuotesAsOf(codes, asOf)` / `getKlineAt(code, tradeDate)`（均为 <= 语义）。
 *  - 下单时把 `asOfDate = currentDate` 下沉给引擎，引擎会拒绝晚于该日的成交日，
 *    并拒绝「该股当日无行情（停牌）」的委托 —— 从源头阻断泄漏。
 *  - 交易日历在创建会话时**固化**（区间内真实交易日数组），推进只按该日历走。
 */

import prisma from "@/lib/prisma";
import type {
  DailyAssetInfo,
  KlineBar,
  KlinePeriod,
  SimulationInfo,
  SimulationQuote,
  SimulationSnapshot,
  SimulationStatus,
  StockListItem,
} from "@/types";

/** 对外沿用同一份 DTO（唯一定义在 types/index.ts，避免接口/前端口径漂移） */
export type { SimulationQuote };
import {
  calcPerformance,
  createAccount,
  getAccountSummary,
  getOrders,
  getPositions,
  getTrades,
  refreshDailyAsset,
  settleT1,
} from "@/services/tradingEngine";
import {
  getKlines,
  getQuotesAsOf,
  getStockInfoByCode,
  listTradingDates,
  normalizeDate,
  searchStocks,
} from "@/services/marketDataService";
import { toDateStr } from "@/lib/utils";

/** 模拟会话归属的演示用户（与普通模拟账户共用同一 demo 用户） */
const SIM_USERNAME = "demo";

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

/** 会话查询统一字段（避免各处 select 漂移） */
const SIM_SELECT = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  initialCash: true,
  currentDate: true,
  calendar: true,
  status: true,
  createdAt: true,
  account: { select: { id: true } },
} as const;

type SimRow = {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  initialCash: unknown;
  currentDate: Date;
  calendar: string;
  status: string;
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

/** Simulation 行 → SimulationInfo DTO */
function toSimulationInfo(row: SimRow): SimulationInfo {
  const calendar = parseCalendar(row.calendar, row.currentDate);
  const current = toDateStr(row.currentDate);
  const idx = calendar.indexOf(current);
  return {
    id: row.id,
    name: row.name,
    startDate: toDateStr(row.startDate),
    endDate: toDateStr(row.endDate),
    initialCash: dec(row.initialCash),
    currentDate: current,
    status: (row.status as SimulationStatus) ?? "ACTIVE",
    totalDays: calendar.length,
    dayIndex: idx >= 0 ? idx + 1 : 0,
    nextDate: idx >= 0 && idx + 1 < calendar.length ? calendar[idx + 1] : null,
    accountId: row.account?.id ?? "",
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*                          创建 / 管理                                */
/* ------------------------------------------------------------------ */

export interface CreateSimulationInput {
  name?: string;
  startDate: string;
  endDate: string;
  initialCash: number;
}

export interface CreateSimulationResult {
  success: boolean;
  message: string;
  simulation?: SimulationInfo;
}

/**
 * 创建历史模拟会话。
 *
 * 步骤：校验入参 → 取区间内真实交易日历（空则拒绝）→ 建会话 →
 * 由 tradingEngine 建绑定该会话的专用账户（失败则回滚会话）→ 初始化首日快照。
 */
export async function createSimulation(
  input: CreateSimulationInput,
): Promise<CreateSimulationResult> {
  const startDate = (input.startDate ?? "").slice(0, 10);
  const endDate = (input.endDate ?? "").slice(0, 10);
  const initialCash = Number(input.initialCash);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { success: false, message: "开始/结束日期格式必须为 YYYY-MM-DD" };
  }
  if (startDate > endDate) {
    return { success: false, message: "开始日期不能晚于结束日期" };
  }
  if (!Number.isFinite(initialCash) || initialCash <= 0) {
    return { success: false, message: "初始资金必须为正数" };
  }
  if (initialCash > 1_000_000_000) {
    return { success: false, message: "初始资金过大（上限 10 亿）" };
  }

  // 交易日历（真实数据）：区间内没有任何交易日则无从模拟
  const calendar = await listTradingDates(startDate, endDate);
  if (calendar.length === 0) {
    return { success: false, message: "所选区间内没有真实交易日数据，无法创建模拟" };
  }
  const firstDate = calendar[0];

  const user = await prisma.user.upsert({
    where: { username: SIM_USERNAME },
    update: {},
    create: { username: SIM_USERNAME, nickname: "模拟投资者" },
    select: { id: true },
  });

  const name = input.name?.trim() || `${startDate} ~ ${endDate}`;

  // 先建会话，再由引擎建账户并直接绑定 simulationId（唯一键），
  // 保证这类账户绝不会被 ensureDefaultAccount 误解析为普通模拟账户。
  const sim = await prisma.simulation.create({
    data: {
      userId: user.id,
      name,
      startDate: normalizeDate(startDate),
      endDate: normalizeDate(endDate),
      initialCash,
      currentDate: normalizeDate(firstDate),
      calendar: JSON.stringify(calendar),
      status: "ACTIVE",
    },
    select: { id: true },
  });

  try {
    await createAccount({
      username: SIM_USERNAME,
      accountName: `模拟账户 · ${name}`,
      initialCash,
      simulationId: sim.id,
    });
  } catch (err) {
    await prisma.simulation.delete({ where: { id: sim.id } }).catch(() => undefined);
    return { success: false, message: `创建模拟账户失败：${(err as Error).message}` };
  }

  // 初始化首个交易日的资产快照（总资产 = 初始资金，收益 0）
  const accountId = await getSimulationAccountId(sim.id);
  if (!accountId) {
    await prisma.simulation.delete({ where: { id: sim.id } }).catch(() => undefined);
    return { success: false, message: "创建模拟账户失败：账户未正确绑定" };
  }
  await refreshDailyAsset(accountId, firstDate);

  const row = await prisma.simulation.findUnique({
    where: { id: sim.id },
    select: SIM_SELECT,
  });
  return {
    success: true,
    message: `模拟已创建：${name}（${calendar.length} 个交易日）`,
    simulation: row ? toSimulationInfo(row) : undefined,
  };
}

/** 单个会话的元信息（轻量查询：不计算持仓/行情/绩效） */
export async function getSimulationInfo(
  simulationId: string,
): Promise<SimulationInfo | null> {
  const row = await prisma.simulation.findUnique({
    where: { id: simulationId },
    select: SIM_SELECT,
  });
  return row ? toSimulationInfo(row) : null;
}

/** 取会话的专用账户 ID */
export async function getSimulationAccountId(simulationId: string): Promise<string | null> {
  const row = await prisma.simulation.findUnique({
    where: { id: simulationId },
    select: { account: { select: { id: true } } },
  });
  return row?.account?.id ?? null;
}

/** 全部模拟会话（按创建时间倒序） */
export async function listSimulations(): Promise<SimulationInfo[]> {
  const rows = await prisma.simulation.findMany({
    orderBy: { createdAt: "desc" },
    select: SIM_SELECT,
  });
  return rows.map(toSimulationInfo);
}

/** 删除会话（级联删除其专用账户与全部持仓/委托/成交/快照） */
export async function deleteSimulation(
  simulationId: string,
): Promise<{ success: boolean; message: string }> {
  const row = await prisma.simulation.findUnique({
    where: { id: simulationId },
    select: { id: true },
  });
  if (!row) return { success: false, message: "模拟会话不存在" };
  // Account.simulationId 为 onDelete: Cascade，账户删除再级联清空子表
  await prisma.simulation.delete({ where: { id: simulationId } });
  return { success: true, message: "模拟会话已删除" };
}

/* ------------------------------------------------------------------ */
/*                          快照 / 推进                                */
/* ------------------------------------------------------------------ */

/**
 * 会话快照：账户汇总 / 持仓 / 委托 / 成交 / 每日快照曲线 / 绩效指标，
 * **全部以 currentDate 为上界**计算，不含任何未来数据。
 */
export async function getSimulationSnapshot(
  simulationId: string,
): Promise<SimulationSnapshot | null> {
  const row = await prisma.simulation.findUnique({
    where: { id: simulationId },
    select: SIM_SELECT,
  });
  if (!row) return null;

  const info = toSimulationInfo(row);
  const accountId = info.accountId;
  if (!accountId) return null;

  const [summary, positions, orders, trades] = await Promise.all([
    getAccountSummary(accountId, info.currentDate),
    getPositions(accountId, info.currentDate),
    getOrders(accountId, { limit: 200 }),
    getTrades(accountId, { limit: 200 }),
  ]);
  if (!summary) return null;

  // 每日资产快照：显式限制 date <= currentDate（防未来快照混入）
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

  // 当日盈亏 = 当前交易日总资产 − 上一交易日总资产（无上一日则以初始资金为基准）
  const last = curve.length > 0 ? curve[curve.length - 1] : null;
  const prevAsset =
    curve.length >= 2 ? curve[curve.length - 2].totalAsset : info.initialCash;
  const dailyPnl = last ? Math.round((last.totalAsset - prevAsset) * 100) / 100 : 0;

  return {
    simulation: info,
    summary,
    positions,
    orders,
    trades,
    curve,
    metrics,
    dailyPnl,
    dailyReturn: last ? last.dailyReturn : 0,
  };
}

export interface AdvanceResult {
  success: boolean;
  message: string;
  /** 本次是否已到区间末尾（未推进） */
  finished?: boolean;
  snapshot?: SimulationSnapshot;
}

/**
 * 推进到下一交易日。
 *
 * 步骤（严格按真实交易日）：
 *  1. 交易日历取 `currentDate` 的下一个交易日（日历在创建时固化）
 *  2. tradingEngine.settleT1 —— 跨日后昨日买入份额解冻为可卖
 *  3. 更新 currentDate（行情可见上界随之推进）
 *  4. refreshDailyAsset —— 重算 现金 / 持仓市值 / 总资产 / 当日收益 / 累计收益
 *     （最大回撤由快照序列在读取时导出）
 *  5. 已到日历末尾时把会话标记为 FINISHED
 */
export async function advanceSimulationDay(
  simulationId: string,
): Promise<AdvanceResult> {
  const row = await prisma.simulation.findUnique({
    where: { id: simulationId },
    select: SIM_SELECT,
  });
  if (!row) return { success: false, message: "模拟会话不存在" };

  const info = toSimulationInfo(row);
  if (!info.accountId) return { success: false, message: "模拟账户缺失" };

  // 已在区间末尾（日历无更晚交易日）：**幂等返回**，不报错。
  // 这样界面重复点击「下一交易日」或并发触发时不会弹出误导性的失败提示。
  if (!info.nextDate) {
    if (info.status !== "FINISHED") {
      await prisma.simulation.update({
        where: { id: simulationId },
        data: { status: "FINISHED" },
      });
    }
    const snapshot = await getSimulationSnapshot(simulationId);
    return {
      success: true,
      message: "已到达区间末尾（无更晚的真实交易日），模拟结束",
      finished: true,
      snapshot: snapshot ?? undefined,
    };
  }

  // 异常态：已标记结束却仍有下一交易日（正常流程不会出现）
  if (info.status !== "ACTIVE") {
    return { success: false, message: "该模拟已结束，无法继续推进交易日" };
  }

  const nextDate = info.nextDate;

  // 1) T+1 结算：把「非当日买入」的份额置为可卖
  await settleT1(info.accountId, nextDate);

  // 2) 推进当前模拟交易日（行情可见上界）
  await prisma.simulation.update({
    where: { id: simulationId },
    data: { currentDate: normalizeDate(nextDate) },
  });

  // 3) 按新交易日的收盘价重算资产快照
  await refreshDailyAsset(info.accountId, nextDate);

  // 4) 若已推进到日历最后一个交易日，标记为已结束
  const calendar = parseCalendar(row.calendar, row.currentDate);
  if (calendar[calendar.length - 1] === nextDate) {
    await prisma.simulation.update({
      where: { id: simulationId },
      data: { status: "FINISHED" },
    });
  }

  const snapshot = await getSimulationSnapshot(simulationId);
  return {
    success: true,
    message: `已推进到 ${nextDate}`,
    snapshot: snapshot ?? undefined,
  };
}

/* ------------------------------------------------------------------ */
/*                     模拟模式下的行情读取                            */
/* ------------------------------------------------------------------ */

/**
 * 模拟模式下搜索股票 —— 只返回「截至 currentDate」的行情，绝不返回未来数据。
 * 关键词匹配只针对代码/名称（不含价格），因此搜索本身不会泄露任何行情。
 */
export async function searchSimulationStocks(
  simulationId: string,
  keyword: string,
  limit = 20,
): Promise<{ currentDate: string; items: SimulationQuote[] } | null> {
  const row = await prisma.simulation.findUnique({
    where: { id: simulationId },
    select: SIM_SELECT,
  });
  if (!row) return null;
  const info = toSimulationInfo(row);

  const stocks: StockListItem[] = (await searchStocks(keyword, limit)).map((s) => ({
    code: s.code,
    name: s.name,
    exchange: s.exchange,
    board: s.board,
    barCount: s.barCount,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    adjust: s.adjust,
    fullWindow: s.fullWindow,
  }));

  const quotes = await getQuotesAsOf(
    stocks.map((s) => s.code),
    info.currentDate,
  );

  return {
    currentDate: info.currentDate,
    items: stocks.map((s) => {
      const q = quotes[s.code];
      const close = q?.close ?? 0;
      const prevClose = q?.prevClose ?? close;
      return {
        code: s.code,
        name: s.name,
        lastDate: q?.lastDate ?? null,
        close,
        prevClose,
        changePercent:
          prevClose > 0 ? Math.round(((close - prevClose) / prevClose) * 10000) / 100 : 0,
      };
    }),
  };
}

/**
 * 模拟模式下的 K 线：**强制以 currentDate 为右端点**（不接受客户端覆盖），
 * 用户只能看到截至当前模拟交易日的行情。
 */
export async function getSimulationKlines(
  simulationId: string,
  stockCode: string,
  period: KlinePeriod = "1d",
  limit = 1000,
): Promise<{ currentDate: string; bars: KlineBar[] } | null> {
  const row = await prisma.simulation.findUnique({
    where: { id: simulationId },
    select: SIM_SELECT,
  });
  if (!row) return null;
  const info = toSimulationInfo(row);

  // 复权口径：按该股自身口径取数（库内 qfq 5430 只 / none 128 只，同股唯一）。
  // getKlines 的 adjust 默认写死 qfq，若照抄默认值，128 只 raw 标的会返回空数组。
  const stock = await getStockInfoByCode(stockCode);

  const bars = await getKlines(stockCode, {
    period,
    adjust: stock?.adjust,
    endDate: info.currentDate, // ← 防泄漏：右端点由服务端强制
    limit,
  });
  return { currentDate: info.currentDate, bars };
}
