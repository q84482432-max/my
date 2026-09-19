/**
 * indexDataService —— 指数数据读写的唯一入口
 *
 * ============================================================================
 * 为什么单独一个 service，而不是并进 marketDataService
 * ----------------------------------------------------------------------------
 * 指数与个股是**物理分表**的（market_indices / index_klines）。本文件就是那条
 * 独立取数路径。刻意不做「用 code 猜是股还是指数」的自动路由：
 *  - 猜错的代价是静默取到错数据（000001 既可能是上证指数也可能是平安银行）；
 *  - 显式调用能让「我在读指数」这件事在代码里可见。
 *
 * 因此 marketDataService 里的任何函数**都不会**返回指数，
 * 本文件里的任何函数**也不会**返回个股。两侧互不可见。
 *
 * ⚠️ 前置条件：新增的 MarketIndex / IndexKline 两个 model 需要
 *   `npx prisma generate` 之后 `prisma.marketIndex` / `prisma.indexKline`
 *   才会出现在 Client 上。部署时 `deploy-inplace.sh` 已内置这一步。
 * ============================================================================
 */
import prisma from "@/lib/prisma";
import { toDateStr } from "@/lib/utils";
import type { IndexBar, IndexCategory, IndexInfo } from "@/types";

/** Prisma Decimal / BigInt 转 number 的安全包装 */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return parseFloat(v) || 0;
  const anyV = v as { toNumber?: () => number; toString?: () => string };
  if (typeof anyV.toNumber === "function") return anyV.toNumber();
  if (typeof anyV.toString === "function") return parseFloat(anyV.toString()) || 0;
  return 0;
}

/**
 * 指数代码：**必须带交易所前缀**。
 * 这个正则是指数的「身份证」—— 任何声称是指数的代码都要先过它，
 * 防止裸码（000001）被当成指数去查，从而绕过个股/指数的边界。
 */
const INDEX_CODE_RE = /^(sh|sz|bj)\d{6}$/i;

/** 判断一个代码是否形如指数代码（带前缀）。注意：只校验形状，不查库。 */
export function isIndexCode(code: string): boolean {
  return INDEX_CODE_RE.test(code.trim());
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

type IndexRow = {
  id: string;
  code: string;
  name: string;
  exchange: string;
  category: string;
  source: string;
  barCount: number;
  windowStart: Date | null;
  windowEnd: Date | null;
};

const INDEX_SELECT = {
  id: true,
  code: true,
  name: true,
  exchange: true,
  category: true,
  source: true,
  barCount: true,
  windowStart: true,
  windowEnd: true,
} as const;

function toIndexInfo(r: IndexRow): IndexInfo {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    exchange: r.exchange as IndexInfo["exchange"],
    category: r.category as IndexCategory,
    source: r.source,
    barCount: r.barCount,
    windowStart: r.windowStart ? toDateStr(r.windowStart) : null,
    windowEnd: r.windowEnd ? toDateStr(r.windowEnd) : null,
  };
}

/**
 * 指数清单。
 *
 * @param category 可选分类过滤
 */
export async function listIndices(
  category?: IndexCategory,
): Promise<IndexInfo[]> {
  const rows = await prisma.marketIndex.findMany({
    where: category ? { category } : undefined,
    orderBy: { code: "asc" },
    select: INDEX_SELECT,
  });
  return rows.map(toIndexInfo);
}

/** 单个指数元信息；不存在或代码形状不合法返回 null */
export async function getIndexInfo(code: string): Promise<IndexInfo | null> {
  if (!isIndexCode(code)) return null;
  const row = await prisma.marketIndex.findUnique({
    where: { code: normalizeCode(code) },
    select: INDEX_SELECT,
  });
  return row ? toIndexInfo(row) : null;
}

/**
 * 指数日K。
 *
 * 与 marketDataService.getKlines 的差异：
 *  - 无 `adjust` / `period` 参数 —— 指数只有日线且无复权概念，给参数就是给误解留口子；
 *  - 返回 `IndexBar`（无 amount），而不是 KlineBar。
 *
 * @param options.startDate 起始日 YYYY-MM-DD（闭区间）
 * @param options.endDate   结束日 YYYY-MM-DD（闭区间）
 * @param options.limit     条数上限，默认 5000（覆盖上证指数全历史）
 */
export async function getIndexKlines(
  code: string,
  options: { startDate?: string; endDate?: string; limit?: number } = {},
): Promise<IndexBar[]> {
  if (!isIndexCode(code)) return [];
  const { startDate, endDate, limit = 5000 } = options;

  const idx = await prisma.marketIndex.findUnique({
    where: { code: normalizeCode(code) },
    select: { id: true },
  });
  if (!idx) return [];

  const where: Record<string, unknown> = { indexId: idx.id };
  if (startDate || endDate) {
    const range: Record<string, Date> = {};
    if (startDate) range.gte = new Date(`${startDate.slice(0, 10)}T00:00:00.000Z`);
    if (endDate) range.lte = new Date(`${endDate.slice(0, 10)}T23:59:59.999Z`);
    where.tradeDate = range;
  }

  const rows = await prisma.indexKline.findMany({
    where,
    orderBy: { tradeDate: "asc" },
    take: limit,
    select: { tradeDate: true, open: true, high: true, low: true, close: true, volume: true },
  });

  return rows.map((r) => ({
    date: toDateStr(r.tradeDate),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    volume: num(r.volume),
  }));
}

/** 指数最新行情（最新一根 + 涨跌幅，基于真实相邻两根日K） */
export async function getIndexQuote(
  code: string,
): Promise<(IndexInfo & { lastPrice: number; change: number; changePercent: number; prevClose: number; lastDate: string }) | null> {
  const info = await getIndexInfo(code);
  if (!info) return null;

  // 只取末尾两根即可算涨跌幅，避免把 5000 根都拉回 Node
  const rows = await prisma.indexKline.findMany({
    where: { indexId: info.id },
    orderBy: { tradeDate: "desc" },
    take: 2,
    select: { tradeDate: true, close: true },
  });
  if (rows.length === 0) return null;

  const last = rows[0];
  const prev = rows[1];
  const lastPrice = num(last.close);
  const prevClose = prev ? num(prev.close) : lastPrice;
  const change = lastPrice - prevClose;

  return {
    ...info,
    lastPrice,
    change,
    changePercent: prevClose === 0 ? 0 : (change / prevClose) * 100,
    prevClose,
    lastDate: toDateStr(last.tradeDate),
  };
}

/**
 * 指数数据概况 —— 供概览页展示，与 getMarketStats（个股口径）**分开**。
 *
 * 刻意不合并进 getMarketStats：那个函数的每个字段都是「个股」语义
 * （stockCount / klineCount / byBoard），混进指数会让口径变得不可解释。
 * 宁可让调用方多调一次，也不要制造一个语义含混的返回值。
 */
export async function getIndexStats(): Promise<{
  indexCount: number;
  barCount: number;
  startDate: string | null;
  endDate: string | null;
  byCategory: Record<string, number>;
}> {
  const [indexCount, barCount, rangeAgg, catAgg] = await Promise.all([
    prisma.marketIndex.count(),
    prisma.indexKline.count(),
    prisma.indexKline.aggregate({
      _min: { tradeDate: true },
      _max: { tradeDate: true },
    }),
    prisma.marketIndex.groupBy({
      by: ["category"],
      _count: { _all: true },
    }),
  ]);

  const byCategory: Record<string, number> = {};
  for (const c of catAgg) byCategory[c.category] = c._count._all;

  return {
    indexCount,
    barCount,
    startDate: rangeAgg._min.tradeDate ? toDateStr(rangeAgg._min.tradeDate) : null,
    endDate: rangeAgg._max.tradeDate ? toDateStr(rangeAgg._max.tradeDate) : null,
    byCategory,
  };
}

/**
 * 取「在指定区间内每个交易日都有数据」的指数代码。
 * 用于给个股回测/模拟配一个同步的大盘基准 —— 区间必须完整，
 * 否则基准曲线会出现断点，回撤计算会被污染。
 */
export async function listIndicesCoveringRange(
  startDate: string,
  endDate: string,
  minBars = 1,
): Promise<Array<{ code: string; name: string; barCount: number; start: string; end: string }>> {
  const rows = await prisma.indexKline.groupBy({
    by: ["indexId"],
    where: {
      tradeDate: {
        gte: new Date(`${startDate.slice(0, 10)}T00:00:00.000Z`),
        lte: new Date(`${endDate.slice(0, 10)}T23:59:59.999Z`),
      },
    },
    _count: { _all: true },
    _min: { tradeDate: true },
    _max: { tradeDate: true },
  });
  if (rows.length === 0) return [];

  const infos = await prisma.marketIndex.findMany({
    where: { id: { in: rows.map((r) => r.indexId) } },
    select: { id: true, code: true, name: true },
  });
  const idToInfo = new Map(infos.map((i) => [i.id, i] as const));

  const out: Array<{ code: string; name: string; barCount: number; start: string; end: string }> = [];
  for (const r of rows) {
    const info = idToInfo.get(r.indexId);
    const cnt = r._count?._all ?? 0;
    if (!info || cnt < minBars) continue;
    const minD = r._min?.tradeDate;
    const maxD = r._max?.tradeDate;
    if (!minD || !maxD) continue;
    out.push({
      code: info.code,
      name: info.name,
      barCount: cnt,
      start: toDateStr(minD),
      end: toDateStr(maxD),
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}
