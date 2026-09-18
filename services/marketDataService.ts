/**
 * marketDataService —— 行情数据访问层
 *
 * 职责边界（重要）：
 *  - 本文件是**唯一**允许直接读写 Kline / Stock 表的入口。
 *  - React 组件、API Route、tradingEngine 一律通过本服务获取行情，
 *    不得直接 prisma.kline.findMany()。
 *
 * 设计要点：
 *  - 日K 是**唯一存储源**，周K / 月K 由日K 实时聚合（保证与真实数据一致，
 *    且用户后续导入真实日K 后无需额外导入周月线）。
 *  - 聚合口径遵循行情惯例：
 *      周K  open = 周内首日 open, close = 周内末日 close,
 *           high = 周内 max, low = 周内 min, volume/amount = 周内求和
 *      月K  同理按自然月分组
 *  - 数据源可替换：getKlines 内部只依赖数据库，未来接实时行情
 *    只需在 fetchLatestQuote 处增加远端适配器。
 */

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type {
  AdjustType,
  BoardType,
  KlineBar,
  KlinePeriod,
  StockInfo,
  StockListItem,
  StockQuote,
} from "@/types";
import {
  inferExchangeAndBoard,
  resolveExchangeAndBoard,
  toDateStr,
} from "@/lib/utils";
import { DEFAULT_ADJUST, boardStatLabel } from "@/lib/constants";

/** Prisma Decimal / BigInt 转 number 的安全包装 */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return parseFloat(v) || 0;
  // Prisma.Decimal
  const anyV = v as { toNumber?: () => number; toString?: () => string };
  if (typeof anyV.toNumber === "function") return anyV.toNumber();
  if (typeof anyV.toString === "function") return parseFloat(anyV.toString()) || 0;
  return 0;
}

/** 将 Date 归一到 UTC 零点，保证 Kline 唯一索引稳定 */
export function normalizeDate(d: Date | string): Date {
  const date = typeof d === "string" ? new Date(`${d.slice(0, 10)}T00:00:00.000Z`) : d;
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** ISO 周键：YYYY-Www（用于周K 分组） */
function isoWeekKey(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7; // 周一 = 1 ... 周日 = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 移到本周四
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** 月键：YYYY-MM */
function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 把日K 聚合为目标周期。
 * @param daily 已按日期升序排列的日K
 */
export function aggregateKlines(
  daily: KlineBar[],
  period: KlinePeriod,
): KlineBar[] {
  if (period === "1d" || daily.length === 0) return daily;

  const keyOf = period === "1w" ? isoWeekKey : monthKey;
  const buckets = new Map<string, KlineBar[]>();

  for (const bar of daily) {
    const key = keyOf(new Date(`${bar.date}T00:00:00.000Z`));
    const list = buckets.get(key);
    if (list) list.push(bar);
    else buckets.set(key, [bar]);
  }

  const result: KlineBar[] = [];
  for (const bars of buckets.values()) {
    // bars 内部已按日期升序
    const first = bars[0];
    const last = bars[bars.length - 1];
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let amount = 0;
    for (const b of bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
      amount += b.amount;
    }
    result.push({
      // 周期K 以该周期**最后一个**交易日作为日期（行情软件惯例）
      date: last.date,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      amount,
    });
  }
  return result;
}

export interface GetKlinesOptions {
  period?: KlinePeriod;
  adjust?: AdjustType;
  /** 起始日期（含） */
  startDate?: string;
  /** 结束日期（含） */
  endDate?: string;
  /** 最多返回多少根，默认 1000 */
  limit?: number;
}

/**
 * 获取指定股票的 K 线。
 * 周K/月K 由日K 聚合得出；因此 startDate/endDate 过滤在日K 阶段完成，
 * 保证周K/月K 的完整性（不会因截断导致首尾周期失真）。
 */
export async function getKlines(
  stockCode: string,
  options: GetKlinesOptions = {},
): Promise<KlineBar[]> {
  const {
    period = "1d",
    adjust = DEFAULT_ADJUST,
    startDate,
    endDate,
    limit = 1000,
  } = options;

  const stock = await prisma.stock.findUnique({
    where: { code: stockCode },
    select: { id: true },
  });
  if (!stock) return [];

  const where: Record<string, unknown> = {
    stockId: stock.id,
    // 永远从日K 聚合，保证多种周期口径一致
    period: "1d",
    adjust,
  };
  if (startDate || endDate) {
    const range: Record<string, Date> = {};
    if (startDate) range.gte = normalizeDate(startDate);
    if (endDate) range.lte = normalizeDate(endDate);
    where.tradeDate = range;
  }

  const rows = await prisma.kline.findMany({
    where,
    orderBy: { tradeDate: "asc" },
    select: {
      tradeDate: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      amount: true,
    },
  });

  const daily: KlineBar[] = rows.map((r) => ({
    date: toDateStr(r.tradeDate),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    volume: num(r.volume),
    amount: num(r.amount),
  }));

  const aggregated = aggregateKlines(daily, period);
  // 只截取尾部 limit 根（K线图只关心最近 N 根）
  return aggregated.length > limit ? aggregated.slice(-limit) : aggregated;
}

/**
 * 获取某只股票在指定日期（或之前最近一个交易日）的日K，用于模拟交易成交价。
 *
 * 口径处理：不传 adjust 时，**按该股票自身的复权口径**取数
 * （klines.adjust = stocks.adjust）。库内 qfq 与 none 两种口径并存且
 * 同一只股票只有一种，故自身口径即唯一正确口径。
 * 若写死单一默认值，会导致另一口径的股票查不到数据
 * （原先默认 qfq 时，128 只 raw 标的全部返回 null）。
 */
export async function getKlineAt(
  stockCode: string,
  date: string,
  adjust?: AdjustType,
): Promise<KlineBar | null> {
  const stock = await prisma.stock.findUnique({
    where: { code: stockCode },
    select: { id: true, adjust: true },
  });
  if (!stock) return null;

  const useAdjust = adjust ?? (stock.adjust as AdjustType);

  const row = await prisma.kline.findFirst({
    where: {
      stockId: stock.id,
      period: "1d",
      adjust: useAdjust,
      tradeDate: { lte: normalizeDate(date) },
    },
    orderBy: { tradeDate: "desc" },
    select: {
      tradeDate: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      amount: true,
    },
  });
  if (!row) return null;

  return {
    date: toDateStr(row.tradeDate),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    close: num(row.close),
    volume: num(row.volume),
    amount: num(row.amount),
  };
}

/**
 * 获取最新一根日K（即最新行情）。
 *
 * 口径处理同 getKlineAt：不传 adjust 时按该股票自身口径取数。
 *
 * ⚠️ 缺陷修复记录（第四阶段）：
 *   原默认值为 `"none"`（第一阶段数据全为不复权时遗留），第二阶段把全站默认
 *   口径改成 qfq 后此处**漏改**。后果是 getLatestBar 对 5430 只 qfq 标的
 *   全部返回 null —— 直接导致市价单报「无行情数据，无法成交」，
 *   且 getAccountSummary / getPositions 的持仓市值恒为 0。
 *   现改为按股票自身口径，两种口径标的均可正常取价。
 */
export async function getLatestBar(
  stockCode: string,
  adjust?: AdjustType,
): Promise<KlineBar | null> {
  const stock = await prisma.stock.findUnique({
    where: { code: stockCode },
    select: { id: true, adjust: true },
  });
  if (!stock) return null;

  const useAdjust = adjust ?? (stock.adjust as AdjustType);

  const row = await prisma.kline.findFirst({
    where: { stockId: stock.id, period: "1d", adjust: useAdjust },
    orderBy: { tradeDate: "desc" },
    select: {
      tradeDate: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      amount: true,
    },
  });
  if (!row) return null;

  return {
    date: toDateStr(row.tradeDate),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    close: num(row.close),
    volume: num(row.volume),
    amount: num(row.amount),
  };
}

/** Stock 行 → StockInfo DTO 的统一映射（避免各处 select 字段漂移） */
function toStockInfo(r: {
  id: string;
  code: string;
  name: string;
  exchange: string;
  board: string;
  industry: string | null;
  listDate: Date | null;
  isActive: boolean;
  adjust: string;
  fullWindow: boolean;
  barCount: number;
  windowStart: Date | null;
  windowEnd: Date | null;
}): StockInfo {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    exchange: r.exchange as StockInfo["exchange"],
    board: r.board as BoardType,
    industry: r.industry,
    listDate: r.listDate ? toDateStr(r.listDate) : null,
    isActive: r.isActive,
    adjust: r.adjust as AdjustType,
    fullWindow: r.fullWindow,
    barCount: r.barCount,
    windowStart: r.windowStart ? toDateStr(r.windowStart) : null,
    windowEnd: r.windowEnd ? toDateStr(r.windowEnd) : null,
  };
}

/** Stock 行 → StockListItem DTO */
function toStockListItem(r: {
  code: string;
  name: string;
  exchange: string;
  board: string;
  barCount: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  adjust: string;
  fullWindow: boolean;
}): StockListItem {
  return {
    code: r.code,
    name: r.name,
    exchange: r.exchange as StockListItem["exchange"],
    board: r.board as BoardType,
    barCount: r.barCount,
    windowStart: r.windowStart ? toDateStr(r.windowStart) : null,
    windowEnd: r.windowEnd ? toDateStr(r.windowEnd) : null,
    adjust: r.adjust as AdjustType,
    fullWindow: r.fullWindow,
  };
}

/** Stock 表通用 select 片段 */
const STOCK_SELECT = {
  id: true,
  code: true,
  name: true,
  exchange: true,
  board: true,
  industry: true,
  listDate: true,
  isActive: true,
  adjust: true,
  fullWindow: true,
  barCount: true,
  windowStart: true,
  windowEnd: true,
} as const;

// ================================================================
// 核心公开方法（第二阶段验收项）
// ================================================================

/**
 * getStockList —— 全市场股票清单（分页 / 板块过滤 / 关键词搜索）。
 *
 * 与 searchStocks 的区别：本方法面向「列表页」，返回轻量 DTO（含 K 线根数、
 * 数据窗口、复权口径），不含行情计算，因此可对 5558 只标的一次性分页拉取而
 * 不产生 N+1 查询。
 */
export async function getStockList(options: {
  /** 关键词：代码或名称模糊匹配 */
  keyword?: string;
  /** 板块过滤（英文枚举） */
  board?: BoardType;
  /** 交易所过滤 */
  exchange?: StockInfo["exchange"];
  /** 分页：跳过条数 */
  skip?: number;
  /** 分页：返回条数，默认 100 */
  take?: number;
  /** 排序字段，默认按代码升序 */
  orderBy?: "code" | "name" | "barCount";
  orderDir?: "asc" | "desc";
} = {}): Promise<{ items: StockListItem[]; total: number }> {
  const {
    keyword,
    board,
    exchange,
    skip = 0,
    take = 100,
    orderBy = "code",
    orderDir = "asc",
  } = options;

  const kw = keyword?.trim();
  const where: Record<string, unknown> = { isActive: true };
  if (kw) {
    where.OR = [{ code: { contains: kw } }, { name: { contains: kw } }];
  }
  if (board) where.board = board;
  if (exchange) where.exchange = exchange;

  const [rows, total] = await Promise.all([
    prisma.stock.findMany({
      where,
      orderBy: { [orderBy]: orderDir },
      skip,
      take,
      select: {
        code: true,
        name: true,
        exchange: true,
        board: true,
        barCount: true,
        windowStart: true,
        windowEnd: true,
        adjust: true,
        fullWindow: true,
      },
    }),
    prisma.stock.count({ where }),
  ]);

  return { items: rows.map(toStockListItem), total };
}

/**
 * getStockInfo —— 单只股票基础信息（含复权口径与窗口完整性标记）。
 * 不存在返回 null。
 */
export async function getStockInfoByCode(
  code: string,
): Promise<StockInfo | null> {
  const r = await prisma.stock.findUnique({
    where: { code },
    select: STOCK_SELECT,
  });
  return r ? toStockInfo(r) : null;
}

/**
 * getKline —— 获取 K 线（周期聚合 + 可选区间 + 尾部截断）。
 *
 * 语义等价于 getKlines，但显式以「该股自身的复权口径」为默认，
 * 而非固定 "none"，避免调用方忘记传参导致查不到数据。
 */
export async function getKline(
  stockCode: string,
  options: GetKlinesOptions = {},
): Promise<KlineBar[]> {
  return getKlines(stockCode, options);
}

/**
 * getHistoricalKline —— 按「股票代码 + 交易日期区间」查询历史 K 线。
 *
 * 与 getKlines 的差异：
 *  - 必填 startDate / endDate，语义上强调「区间查询」，不做尾部截断的默认行为；
 *  - 返回结果**严格按交易日期升序**（唯一索引 + orderBy 双重保证）；
 *  - 默认 limit 放宽到 5000（完整窗口约 453 根，留足余量）。
 *
 * 这是回测引擎按时间推进取数的关键入口。
 */
export async function getHistoricalKline(
  stockCode: string,
  startDate: string,
  endDate: string,
  options: {
    period?: KlinePeriod;
    adjust?: AdjustType;
    limit?: number;
  } = {},
): Promise<KlineBar[]> {
  return getKlines(stockCode, {
    ...options,
    startDate,
    endDate,
    limit: options.limit ?? 5000,
  });
}

/** 获取单只股票基础信息（第一阶段遗留签名，内部委托给 getStockInfoByCode） */
export async function getStockInfo(code: string): Promise<StockInfo | null> {
  return getStockInfoByCode(code);
}

/** 股票列表（支持关键词搜索：代码或名称） */
export async function searchStocks(
  keyword = "",
  limit = 50,
): Promise<StockInfo[]> {
  const kw = keyword.trim();
  const where = kw
    ? {
        OR: [
          { code: { contains: kw } },
          { name: { contains: kw } },
        ],
        isActive: true,
      }
    : { isActive: true };

  const rows = await prisma.stock.findMany({
    where,
    orderBy: { code: "asc" },
    take: limit,
    select: STOCK_SELECT,
  });

  return rows.map(toStockInfo);
}

/**
 * 批量获取股票最新行情（含涨跌幅、成交量、成交额）。
 * 用于首页榜单 / 搜索 / 列表页的行情展示。
 *
 * 口径处理（重要）：
 *   库内真实数据有两种口径——qfq（前复权，5430 只）与 none（不复权，128 只），
 *   且**同一只股票只有一种口径**。因此默认按「每只股票自身的 adjust」取数
 *   （等价于 `klines.adjust = stocks.adjust`），避免统一传 qfq 时把 raw 标的
 *   查成 0 根、行情显示成全 0 的缺陷。
 *   如需强制统一口径（例如做口径对照），可显式传 adjustOverride。
 *
 * 性能：用单条窗口函数 SQL 一次取回全部目标股票的最近两根日K，
 *       避免逐只查询造成 N+1（400 只 → 1 次查询）。
 */
export async function getStockQuotes(
  codes: string[],
  adjustOverride?: AdjustType,
): Promise<Record<string, StockQuote>> {
  const result: Record<string, StockQuote> = {};
  if (codes.length === 0) return result;

  const stocks = await prisma.stock.findMany({
    where: { code: { in: codes } },
    select: STOCK_SELECT,
  });
  if (stocks.length === 0) return result;

  // 一次取回每只股票最近两根日K（rn = 1 最新，rn = 2 上一交易日）
  const adjustFilter = adjustOverride
    ? Prisma.sql`k."adjust" = ${adjustOverride}`
    : Prisma.sql`k."adjust" = s."adjust"`;

  const rows = await prisma.$queryRaw<
    Array<{
      code: string;
      tradeDate: Date | string;
      close: unknown;
      volume: unknown;
      amount: unknown;
      rn: bigint | number;
    }>
  >(Prisma.sql`
    SELECT code, "tradeDate", close, volume, amount, rn FROM (
      SELECT s."code" AS code,
             k."tradeDate" AS "tradeDate",
             k."close" AS close,
             k."volume" AS volume,
             k."amount" AS amount,
             ROW_NUMBER() OVER (
               PARTITION BY k."stockId" ORDER BY k."tradeDate" DESC
             ) AS rn
      FROM "klines" k
      JOIN "stocks" s ON s."id" = k."stockId"
      WHERE k."period" = '1d' AND ${adjustFilter}
        AND s."code" IN (${Prisma.join(stocks.map((s) => s.code))})
    ) WHERE rn <= 2
  `);

  const latest = new Map<string, (typeof rows)[number]>();
  const prev = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (Number(r.rn) === 1) latest.set(r.code, r);
    else prev.set(r.code, r);
  }

  for (const s of stocks) {
    const l = latest.get(s.code);
    const p = prev.get(s.code);
    const lastPrice = l ? num(l.close) : 0;
    const prevClose = p ? num(p.close) : lastPrice;
    const change = lastPrice - prevClose;
    const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;

    result[s.code] = {
      ...toStockInfo(s),
      lastPrice,
      change,
      changePercent,
      volume: l ? num(l.volume) : 0,
      amount: l ? num(l.amount) : 0,
      prevClose,
      lastDate: l ? toDateStr(l.tradeDate) : null,
    };
  }

  return result;
}

/** 获取单只股票最新行情（按该股自身口径） */
export async function getStockQuote(
  code: string,
  adjustOverride?: AdjustType,
): Promise<StockQuote | null> {
  const map = await getStockQuotes([code], adjustOverride);
  return map[code] ?? null;
}

/** 数据库内该股票的日K 范围（用于前端提示数据覆盖区间） */
export async function getKlineRange(
  stockCode: string,
  adjust?: AdjustType,
): Promise<{ start: string | null; end: string | null; count: number }> {
  const stock = await prisma.stock.findUnique({
    where: { code: stockCode },
    select: { id: true, adjust: true },
  });
  if (!stock) return { start: null, end: null, count: 0 };

  // 口径处理同 getKlineAt / getLatestBar：不传 adjust 时按该股票自身口径取数。
  // 原实现写死 DEFAULT_ADJUST(qfq)，导致 128 只 adjust="none" 的标的
  // 明明有 K 线却返回 count: 0，前端据此显示「无数据覆盖」。
  const useAdjust = adjust ?? (stock.adjust as AdjustType);

  const [first, last, count] = await Promise.all([
    prisma.kline.findFirst({
      where: { stockId: stock.id, period: "1d", adjust: useAdjust },
      orderBy: { tradeDate: "asc" },
      select: { tradeDate: true },
    }),
    prisma.kline.findFirst({
      where: { stockId: stock.id, period: "1d", adjust: useAdjust },
      orderBy: { tradeDate: "desc" },
      select: { tradeDate: true },
    }),
    prisma.kline.count({ where: { stockId: stock.id, period: "1d", adjust: useAdjust } }),
  ]);

  return {
    start: first ? toDateStr(first.tradeDate) : null,
    end: last ? toDateStr(last.tradeDate) : null,
    count,
  };
}

/**
 * 导入/更新 K 线（供 scripts/importKline.ts 调用）。
 * 采用 upsert，保证重复导入幂等。
 */
export async function upsertKlines(
  stockCode: string,
  bars: KlineBar[],
  options: {
    period?: KlinePeriod;
    adjust?: AdjustType;
    /** 数据源 setcode（0=深 1=沪 2=北），优先于代码前缀推断 */
    setcode?: string | number | null;
    /** 股票名称，避免 upsert 时用代码占位 */
    name?: string;
  } = {},
): Promise<number> {
  const { period = "1d", adjust = "none", setcode, name } = options;
  const market = resolveExchangeAndBoard(stockCode, setcode);
  const stock = await prisma.stock.upsert({
    where: { code: stockCode },
    update: {
      // 仅在显式传入时覆盖，避免用代码占位符把已有名称冲掉
      ...(name ? { name } : {}),
      // setcode 是权威市场归属，允许纠正此前由前缀误判的记录
      ...(setcode !== undefined && setcode !== null ? market : {}),
    },
    create: {
      code: stockCode,
      name: name ?? stockCode, // 名称由调用方通过 ensureStock / name 覆盖
      ...market,
    },
    select: { id: true },
  });

  let n = 0;
  for (const bar of bars) {
    await prisma.kline.upsert({
      where: {
        stockId_period_tradeDate_adjust: {
          stockId: stock.id,
          period,
          tradeDate: normalizeDate(bar.date),
          adjust,
        },
      },
      update: {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: BigInt(Math.round(bar.volume)),
        amount: bar.amount,
      },
      create: {
        stockId: stock.id,
        period,
        tradeDate: normalizeDate(bar.date),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: BigInt(Math.round(bar.volume)),
        amount: bar.amount,
        adjust,
      },
    });
    n += 1;
  }
  return n;
}

/**
 * 取「晚于 afterDate」的最近一个真实交易日（交易日历代理）。
 *
 * 用途：T+1 结算需要把日期推进到「次一交易日」。本库只有真实日K，
 * 因此以 K 线中实际存在的交易日为准，而不是简单 +1 自然日
 * （否则周末/节假日会推进到一个并不存在的交易日）。
 *
 * @param afterDate  基准日期 YYYY-MM-DD（不含）
 * @param stockCodes 限定股票范围（缺省为全市场，即用「任一只股票有交易」作为日历）
 * @returns 交易日 YYYY-MM-DD；数据窗口内不存在更晚交易日时返回 null
 */
export async function getNextTradeDate(
  afterDate: string,
  stockCodes?: string[],
): Promise<string | null> {
  const row = await prisma.kline.findFirst({
    where: {
      period: "1d",
      tradeDate: { gt: normalizeDate(afterDate) },
      ...(stockCodes && stockCodes.length > 0
        ? { stock: { code: { in: stockCodes } } }
        : {}),
    },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true },
  });
  return row ? toDateStr(row.tradeDate) : null;
}

/** 截至某日的行情快照（**保证不含未来数据**） */
export interface QuoteAsOf {
  code: string;
  name: string;
  /** 截至 asOfDate（含）的最后一个交易日；该股在此日之前无K线时为 null */
  lastDate: string | null;
  /** 该日收盘价 */
  close: number;
  /** 前一交易日收盘价（无更早数据时退化为 close） */
  prevClose: number;
  volume: number;
}

/**
 * 批量取「截至 asOfDate（含）」的最新两根日K —— 历史模拟模式的唯一取价入口。
 *
 * 与 getStockQuotes 的差异：多一个 `tradeDate <= asOfDate` 的**硬上界**，
 * 保证模拟日期为 2025-10-01 时，绝不会返回 2025-10-02 及以后的任何行情
 * （防未来数据泄露）。查询走 Prisma 类型化 API，日期比较不依赖裸 SQL 的
 * 存储格式假设；每只股票 1 条 findMany(take: 2) 覆盖「最新 + 前一交易日」。
 */
export async function getQuotesAsOf(
  codes: string[],
  asOfDate: string,
): Promise<Record<string, QuoteAsOf>> {
  const result: Record<string, QuoteAsOf> = {};
  if (codes.length === 0) return result;

  const asOf = normalizeDate(asOfDate);
  const stocks = await prisma.stock.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true, adjust: true },
  });

  for (const s of stocks) {
    const rows = await prisma.kline.findMany({
      where: {
        stockId: s.id,
        period: "1d",
        adjust: s.adjust,
        // 上界：只允许读到 asOfDate 当天及以前
        tradeDate: { lte: asOf },
      },
      orderBy: { tradeDate: "desc" },
      take: 2,
      select: { tradeDate: true, close: true, volume: true },
    });
    const last = rows[0];
    const prev = rows[1];
    const close = last ? num(last.close) : 0;
    result[s.code] = {
      code: s.code,
      name: s.name,
      lastDate: last ? toDateStr(last.tradeDate) : null,
      close,
      prevClose: prev ? num(prev.close) : close,
      volume: last ? num(last.volume) : 0,
    };
  }
  return result;
}

/**
 * 取「不早于 date」的第一个真实交易日（全市场口径）。
 * 用于把用户选择的开始日期对齐到真实交易日。
 */
export async function getFirstTradeDateOnOrAfter(date: string): Promise<string | null> {
  const row = await prisma.kline.findFirst({
    where: { period: "1d", tradeDate: { gte: normalizeDate(date) } },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true },
  });
  return row ? toDateStr(row.tradeDate) : null;
}

/**
 * 列出 [from, to] 区间内的全部真实交易日（升序、跨全市场去重）。
 *
 * 历史模拟模式据此明确「下一个交易日」，保证推进落在真实交易日上
 * （不会推进到周末/节假日）。口径为全市场：任一股票有 K 线即视为交易日，
 * 避免单只股票停牌造成日历缺口。
 *
 * ⚠️ 性能红线（2026-09-12 修复）：
 * 原实现用 `distinct: ["tradeDate"]` + 全区间（1900~2999）查询。Prisma 在 SQLite
 * 上的 `distinct` 是**内存去重**——它先把命中的全部行取回 Node 再筛，等于每次调用
 * 把 234 万行的 tradeDate 全读进内存。在生产小内存机（2G）上实测单次耗时 **78 秒**，
 * 是「创建模拟炒股会话需 60~90 秒」的唯一根因。
 *
 * 现改为：**先挑一只 K 线数量最多的股票**（其交易日历即全市场日历，因为交易日是
 * 全局属性），再用 `(stockId, period, tradeDate)` 索引做覆盖扫描，返回行数与交易日数
 * 同阶（约 453 行），耗时降到毫秒级，且不产生大内存瞬时分配。
 *
 * 若主标的在区间内停牌导致个别交易日缺失（罕见），追加一次「区间端点探测」兜底：
 * 用全市场首尾交易日补齐边界。日常调用（模拟炒股创建）不需要。
 */
export async function listTradingDates(from: string, to: string): Promise<string[]> {
  const fromD = normalizeDate(from);
  const toD = normalizeDate(to);

  // 选一只 K 线最多的股票作为日历基准：交易日是全局属性，单只股票的完整日历
  // 就是全市场日历（停牌日除外，见下）。
  const anchor = await prisma.stock.findFirst({
    where: { isActive: true, klines: { some: {} } },
    orderBy: { klines: { _count: "desc" } },
    select: { id: true },
  });
  if (!anchor) return [];

  const rows = await prisma.kline.findMany({
    where: {
      stockId: anchor.id,
      period: "1d",
      tradeDate: { gte: fromD, lte: toD },
    },
    distinct: ["tradeDate"],
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true },
  });
  return rows.map((r) => toDateStr(r.tradeDate));
}

/** 创建或更新股票基础信息 */
export async function ensureStock(input: {
  code: string;
  name?: string;
  industry?: string;
  listDate?: string;
  /** 数据源 setcode（0=深 1=沪 2=北），优先于代码前缀推断 */
  setcode?: string | number | null;
}): Promise<string> {
  const inferred = resolveExchangeAndBoard(input.code, input.setcode);
  const row = await prisma.stock.upsert({
    where: { code: input.code },
    update: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.industry ? { industry: input.industry } : {}),
      ...(input.listDate ? { listDate: normalizeDate(input.listDate) } : {}),
      // 提供 setcode 即视为权威市场归属，允许纠正前缀误判
      ...(input.setcode !== undefined && input.setcode !== null ? inferred : {}),
    },
    create: {
      code: input.code,
      name: input.name ?? input.code,
      industry: input.industry ?? null,
      listDate: input.listDate ? normalizeDate(input.listDate) : null,
      ...inferred,
    },
    select: { id: true },
  });
  return row.id;
}

/** 清空某股票的 K 线（重新导入时使用） */
export async function clearKlines(
  stockCode: string,
  period: KlinePeriod = "1d",
  adjust: AdjustType = DEFAULT_ADJUST,
): Promise<number> {
  const stock = await prisma.stock.findUnique({
    where: { code: stockCode },
    select: { id: true },
  });
  if (!stock) return 0;
  const res = await prisma.kline.deleteMany({
    where: { stockId: stock.id, period, adjust },
  });
  return res.count;
}

/** 全市场股票代码列表（用于批量同步行情） */
export async function listStockCodes(): Promise<string[]> {
  const rows = await prisma.stock.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
    select: { code: true },
  });
  return rows.map((r) => r.code);
}

/**
 * 数据集统计概况 —— 供市场概览页展示数据覆盖范围。
 * 集中在此以满足「API 层不得直接访问数据库」的架构约束。
 */
export async function getMarketStats(): Promise<{
  stockCount: number;
  klineCount: number;
  startDate: string | null;
  endDate: string | null;
  byBoard: Record<string, number>;
  byAdjust: Record<string, number>;
  fullWindowCount: number;
}> {
  const [stockCount, klineCount, rangeAgg, boardAgg, adjustAgg, fullWindowCount] =
    await Promise.all([
      prisma.stock.count({ where: { isActive: true } }),
      prisma.kline.count(),
      prisma.kline.aggregate({
        _min: { tradeDate: true },
        _max: { tradeDate: true },
      }),
      prisma.stock.groupBy({
        by: ["board", "exchange"],
        where: { isActive: true },
        _count: { _all: true },
      }),
      prisma.stock.groupBy({
        by: ["adjust"],
        where: { isActive: true },
        _count: { _all: true },
      }),
      prisma.stock.count({ where: { isActive: true, fullWindow: true } }),
    ]);

  const byBoard: Record<string, number> = {};
  for (const b of boardAgg) {
    const label = boardStatLabel(b.board, b.exchange);
    byBoard[label] = (byBoard[label] ?? 0) + b._count._all;
  }
  const byAdjust: Record<string, number> = {};
  for (const a of adjustAgg) byAdjust[a.adjust] = a._count._all;

  return {
    stockCount,
    klineCount,
    startDate: rangeAgg._min.tradeDate
      ? toDateStr(rangeAgg._min.tradeDate)
      : null,
    endDate: rangeAgg._max.tradeDate ? toDateStr(rangeAgg._max.tradeDate) : null,
    byBoard,
    byAdjust,
    fullWindowCount,
  };
}

/** 取「已有 K 线数据」的股票代码（可选数量上限），供行情列表使用 */
/**
 * 取「已有 K 线数据」的股票代码，供行情榜单/概览使用。
 *
 * @param take 数量上限。**不传则返回全市场**（当前 5558 只）。
 *   注意：旧实现默认只取 code 升序前 400 只，导致榜单实际只覆盖 000 段
 *   深主板，并非全市场；现改为不传即全量。
 */
export async function listCodesHavingKlines(take?: number): Promise<string[]> {
  const rows = await prisma.stock.findMany({
    where: { isActive: true, klines: { some: {} } },
    orderBy: { code: "asc" },
    ...(take ? { take } : {}),
    select: { code: true },
  });
  return rows.map((r) => r.code);
}

/**
 * 随机抽取 `take` 只「已有 K 线数据」的股票代码（无放回、等概率）。
 *
 * 供模拟炒股「随机选股」使用：在 SQLite 层用 `ORDER BY RANDOM()` 完成抽样，
 * 只把 N 行（默认 60）带回 Node，避免旧实现「取全市场 5558 只 → 内存洗牌 → 再取前 N」
 * 带来的传输与 GC 开销（生产小内存机上实测 3.8 秒 / 每次创建会话）。
 *
 * 注意 `ORDER BY RANDOM()` 在 stocks 表（5558 行）上代价很低，可放心用于交互式创建。
 */
export async function listRandomCodesHavingKlines(take: number): Promise<string[]> {
  if (!Number.isFinite(take) || take <= 0) return [];
  const rows = await prisma.$queryRaw<Array<{ code: string }>>`
    SELECT code FROM stocks
    WHERE isActive = 1
      AND EXISTS (SELECT 1 FROM klines WHERE klines.stockId = stocks.id)
    ORDER BY RANDOM()
    LIMIT ${Math.floor(take)}
  `;
  return rows.map((r) => r.code);
}

/**
 * 批量预筛模拟炒股候选标的（**一次查询**，不打 N 次往返）。
 *
 * 对给定代码集合，返回满足以下条件的候选及其 K 线窗口：
 *   - `isActive` 且 K 线根数 >= `minBars`；
 *   - 数据窗口末端 >= `needEnd`（模拟结束日必须有数据可用）。
 *
 * 用于替代旧实现中「for 循环里逐只调用 getStockInfoByCode + getKlineRange」的写法：
 * 60 只候选 × 2~3 次串行往返 ≈ 25 秒，改为单次聚合查询后降到毫秒级。
 *
 * @param codes 候选代码（来自 listRandomCodesHavingKlines）
 * @param needEnd 模拟结束日（YYYY-MM-DD），窗口必须覆盖到该日
 * @param minBars K 线根数下限
 */
export async function listCandidatesCoveringRange(
  codes: string[],
  needEnd: string,
  minBars: number,
): Promise<Array<{ code: string; adjust: string; start: string; end: string; barCount: number }>> {
  if (codes.length === 0) return [];

  // 用 Prisma 聚合一次取回：每只候选的 K 线根数 + 首末交易日。
  // groupBy 走 (stockId, period, tradeDate) 索引，仅扫命中的 N 只，代价极低。
  const rows = await prisma.kline.groupBy({
    by: ["stockId"],
    where: {
      period: "1d",
      stock: { code: { in: codes }, isActive: true },
    },
    _count: { _all: true },
    _min: { tradeDate: true },
    _max: { tradeDate: true },
  });
  if (rows.length === 0) return [];

  const idToCode = new Map(
    (
      await prisma.stock.findMany({
        where: { id: { in: rows.map((r) => r.stockId) } },
        select: { id: true, code: true, adjust: true },
      })
    ).map((s) => [s.id, s] as const),
  );

  const out: Array<{ code: string; adjust: string; start: string; end: string; barCount: number }> = [];
  for (const r of rows) {
    const stock = idToCode.get(r.stockId);
    if (!stock) continue;
    const count = r._count?._all ?? 0;
    if (count < minBars) continue;
    const minD = r._min?.tradeDate;
    const maxD = r._max?.tradeDate;
    if (!minD || !maxD) continue;
    const end = toDateStr(maxD);
    if (end < needEnd) continue;
    out.push({
      code: stock.code,
      adjust: stock.adjust ?? "qfq",
      start: toDateStr(minD),
      end,
      barCount: count,
    });
  }
  return out;
}
