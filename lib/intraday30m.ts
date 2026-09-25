/**
 * intraday30m —— 30 分钟 K 线（Parquet）服务端访问层
 *
 * 定位：把 `D:\AStockData\minutes_30\<code>.parquet` 这层**离线数据集**接进 App，
 * 并让阶段 6 产出的污染标记（`contaminated_days.json`）在**真正消费 30m 数据的链路**上生效。
 *
 * 为什么单独一层而不是塞进 marketDataService：
 *  - 30m 数据**不在 SQLite 里**（`klines.period` 目前只有 1d/1w/1M），走的是文件系统 + Parquet；
 *  - 读取路径、缓存策略、可用性判定（文件是否存在）与数据库查询完全不同；
 *  - 显式化「读 30m」这件事，避免在 getKlines 里靠 period 字符串猜数据源。
 *
 * 关键约束（与 SIMTRADE 的防泄漏红线一致）：
 *  - 本模块**只负责取数**，不做任何可见性/阶段判断；上界一律由调用方（API 路由）传入。
 *  - 标的范围天然受限：文件按 `dev.db.stocks.code` 命名，调用方必须先用 Prisma 校验代码存在。
 *
 * 数据规格（与 `scripts/fetch_30m_kline.py` 产物一致）：
 *  - 列：tradeDate(str `YYYY-MM-DD`) / time(str `HH:MM:SS`) / open/high/low/close(float4dp)
 *        / volume(int64) / amount(double)
 *  - 每交易日固定 8 根：10:00 10:30 11:00 11:30 13:30 14:00 14:30 15:00
 *  - 价格为**前复权**（factor(d) = dev.db 日K收盘(d) / 新浪原始 30m 当日末日收盘(d)）
 *
 * ⚠️ 已知数据缺陷（阶段 2/3 实测，详见 `D:\AStockData\logs\contaminated_marks.md`）：
 *    北交所 34 只标的在 **2026-06-30** 的 14:00（少数含 13:30）棒被灌入量级错误的价格。
 *    无任何独立源可恢复（腾讯 m30 对北交所返回 0 根）。因此这 34 个 (股票,日期) 对
 *    **只标记、不修复**，并由本模块统一拦截，禁止进入任何 30m 消费路径。
 */

import fs from "node:fs";
import path from "node:path";

import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

import type { IntradayBar } from "@/types";

/* ------------------------------------------------------------------ */
/*                              配置                                    */
/* ------------------------------------------------------------------ */

/** 离线数据根目录（与 scripts/fetch_30m_kline.py 的 ROOT 一致） */
const DATA_ROOT = process.env.ASTOCK_DATA_ROOT ?? "D:\\AStockData";

/** 30 分钟 K 线目录 */
export const INTRADAY_DIR =
  process.env.INTRADAY_30M_DIR ?? path.join(DATA_ROOT, "minutes_30");

/** 阶段 6 污染标记文件 */
export const CONTAMINATED_DAYS_FILE =
  process.env.CONTAMINATED_DAYS_FILE ??
  path.join(DATA_ROOT, "metadata", "contaminated_days.json");

/** 每个交易日固定的 8 个 30 分钟时点（收盘时刻标注） */
export const INTRADAY_TIMES = [
  "10:00:00",
  "10:30:00",
  "11:00:00",
  "11:30:00",
  "13:30:00",
  "14:00:00",
  "14:30:00",
  "15:00:00",
] as const;

/** 首个可揭示时点（= 开盘阶段可见的第一根） */
export const FIRST_INTRADAY_TIME = INTRADAY_TIMES[0];

/** 每交易日标准根数 */
export const BARS_PER_DAY = INTRADAY_TIMES.length;

/* ------------------------------------------------------------------ */
/*                              类型                                    */
/* ------------------------------------------------------------------ */

/**
 * 30 分钟 K 线 DTO。
 *
 * **统一在 `types/index.ts` 定义**（= `KlineBar` + 必需的 `time`），此处只做
 * re-export，保持 `@/lib/intraday30m` 这一既有 import 路径与类型名不变。
 *
 * 2026-09-22 审计：这里原本另立了一份与 `KlineBar` 字段完全重复的 interface，
 * 属于「双 DTO」维护风险；现收敛为单一来源。
 */
export type { IntradayBar };

export interface ContaminatedEntry {
  code: string;
  date: string;
  exchange: string;
  severity?: string;
  dailyOvershootPct?: number;
  barViolationCount?: number;
  reason?: string;
}

export interface ContaminatedIndex {
  /** 生成时间（来自文件） */
  generatedAt: string | null;
  /** code -> Set<'YYYY-MM-DD'> */
  byCode: Map<string, Set<string>>;
  entries: ContaminatedEntry[];
  /** 文件是否成功加载 */
  loaded: boolean;
}

/* ------------------------------------------------------------------ */
/*                        Parquet 读取与缓存                            */
/* ------------------------------------------------------------------ */

interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  bars: IntradayBar[];
  byDate: Map<string, IntradayBar[]>;
}

/** 按 code 缓存已解析的整份文件（单只 ~3600 行 / 66KB，解析 ~20ms） */
const fileCache = new Map<string, FileCacheEntry>();
const MAX_CACHED_FILES = 64;

function parquetPath(code: string): string {
  return path.join(INTRADAY_DIR, `${code}.parquet`);
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return 0;
}

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) {
    // parquet 里 tradeDate 为字符串，但防御性兼容 Date
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v ?? "");
}

function loadFile(code: string): FileCacheEntry | null {
  const p = parquetPath(code);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return null;
  }
  const hit = fileCache.get(code);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit;
  }
  return null;
}

async function readFile(code: string): Promise<FileCacheEntry | null> {
  const cached = loadFile(code);
  if (cached) return cached;

  const p = parquetPath(code);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return null;
  }

  const buf = fs.readFileSync(p);
  // hyparquet 需要 ArrayBuffer（Node Buffer 是 Uint8Array 视图，需切出真实缓冲）
  const ab = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
  const rows = (await parquetReadObjects({
    file: ab,
    compressors,
  })) as Record<string, unknown>[];

  const bars: IntradayBar[] = rows
    .map((r) => ({
      date: toStr(r.tradeDate),
      time: toStr(r.time),
      open: toNum(r.open),
      high: toNum(r.high),
      low: toNum(r.low),
      close: toNum(r.close),
      volume: toNum(r.volume),
      amount: toNum(r.amount),
    }))
    .filter((b) => b.date && b.time);

  bars.sort((a, b) =>
    a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date),
  );

  const byDate = new Map<string, IntradayBar[]>();
  for (const b of bars) {
    const arr = byDate.get(b.date);
    if (arr) arr.push(b);
    else byDate.set(b.date, [b]);
  }

  const entry: FileCacheEntry = { mtimeMs: stat.mtimeMs, size: stat.size, bars, byDate };

  // 简单 LRU：超出上限时淘汰最早插入的一个
  if (fileCache.size >= MAX_CACHED_FILES) {
    const oldest = fileCache.keys().next();
    if (!oldest.done) fileCache.delete(oldest.value);
  }
  fileCache.set(code, entry);
  return entry;
}

/*
 * 注意：此处**刻意不提供** `clearIntradayCache()`。
 * 文件缓存以 `(mtimeMs, size)` 为键（见 `loadFile`），数据文件被增量更新后
 * 缓存会自动失效；再加一个手动清理入口只会成为零调用者的死导出
 * （2026-09-22 审计确认它无任何外部调用）。将来确实需要主动清理再加回。
 */

/* ------------------------------------------------------------------ */
/*                          对外取数接口                                 */
/* ------------------------------------------------------------------ */

/** 某标的某日的 8 根 30m K（缺失/停牌返回空数组） */
export async function getIntradayBars(
  code: string,
  date: string,
): Promise<IntradayBar[]> {
  const entry = await readFile(code);
  if (!entry) return [];
  return entry.byDate.get(date) ?? [];
}

/** 某标的在给定日期集合上的 30m K，按日期升序返回 */
export async function getIntradayDays(
  code: string,
  dates: string[],
): Promise<{ date: string; bars: IntradayBar[] }[]> {
  const entry = await readFile(code);
  if (!entry) return [];
  const want = new Set(dates);
  const out: { date: string; bars: IntradayBar[] }[] = [];
  for (const [d, bars] of entry.byDate) {
    if (want.has(d)) out.push({ date: d, bars });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** 某标的 30m 数据的覆盖摘要（供诊断接口使用） */
export async function getIntradayCoverage(code: string): Promise<{
  code: string;
  available: boolean;
  bars: number;
  days: number;
  first: string | null;
  last: string | null;
  barsPerDayOk: boolean;
}> {
  const entry = await readFile(code);
  if (!entry) {
    return { code, available: false, bars: 0, days: 0, first: null, last: null, barsPerDayOk: false };
  }
  const dates = [...entry.byDate.keys()].sort();
  const barsPerDayOk = [...entry.byDate.values()].every(
    (b) => b.length === BARS_PER_DAY,
  );
  return {
    code,
    available: true,
    bars: entry.bars.length,
    days: dates.length,
    first: dates[0] ?? null,
    last: dates[dates.length - 1] ?? null,
    barsPerDayOk,
  };
}

/* ------------------------------------------------------------------ */
/*                      污染标记（阶段 6 排除项）                        */
/* ------------------------------------------------------------------ */

let contamCache: { mtimeMs: number; idx: ContaminatedIndex } | null = null;

const EMPTY_INDEX: ContaminatedIndex = {
  generatedAt: null,
  byCode: new Map(),
  entries: [],
  loaded: false,
};

/**
 * 读取污染标记索引（按 mtime 缓存）。
 *
 * 文件结构（`D:\AStockData\metadata\contaminated_days.json`）：
 *  { generatedAt, stats, excludeStockDates:[{code,date,exchange,severity,...}],
 *    excludeIndex:{ code:[date,...] }, watchlistNonBj:[...], relatedEvidence:{...} }
 */
export function getContaminatedIndex(): ContaminatedIndex {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(CONTAMINATED_DAYS_FILE);
  } catch {
    contamCache = { mtimeMs: -1, idx: EMPTY_INDEX };
    return EMPTY_INDEX;
  }
  if (contamCache && contamCache.mtimeMs === stat.mtimeMs) return contamCache.idx;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONTAMINATED_DAYS_FILE, "utf8"));
  } catch {
    contamCache = { mtimeMs: stat.mtimeMs, idx: EMPTY_INDEX };
    return EMPTY_INDEX;
  }

  const obj = (raw ?? {}) as Record<string, unknown>;
  const entries = (Array.isArray(obj.excludeStockDates)
    ? obj.excludeStockDates
    : []) as ContaminatedEntry[];

  const byCode = new Map<string, Set<string>>();

  // 优先用文件里预建的 excludeIndex（O(1) 查表）
  const excludeIndex = obj.excludeIndex;
  if (excludeIndex && typeof excludeIndex === "object") {
    for (const [code, dates] of Object.entries(
      excludeIndex as Record<string, unknown>,
    )) {
      if (Array.isArray(dates) && dates.length > 0) {
        byCode.set(code, new Set(dates.map((d) => String(d))));
      }
    }
  }
  // 兜底：从明细条目重建
  if (byCode.size === 0) {
    for (const e of entries) {
      if (!e?.code || !e?.date) continue;
      const set = byCode.get(e.code) ?? new Set<string>();
      set.add(e.date);
      byCode.set(e.code, set);
    }
  }

  const idx: ContaminatedIndex = {
    generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : null,
    byCode,
    entries,
    loaded: true,
  };
  contamCache = { mtimeMs: stat.mtimeMs, idx };
  return idx;
}

/** 该 (股票, 日期) 是否被标记为污染 */
export function isContaminated(code: string, date: string): boolean {
  return getContaminatedIndex().byCode.get(code)?.has(date) ?? false;
}

/** 该标的被标记的全部污染日期（升序） */
export function contaminatedDatesOf(code: string): string[] {
  const set = getContaminatedIndex().byCode.get(code);
  return set ? [...set].sort() : [];
}

/**
 * 模拟区间 [from, to]（含端点，YYYY-MM-DD 字符串比较）是否与污染日期有交集。
 *
 * 这是「标记生效」的唯一入口：**只要有交集，该标的就不能被选为模拟目标**
 * —— 因为模拟期内一旦走到该日期，30m 数据就是可证明损坏的。
 */
export function contaminatedInRange(
  code: string,
  from: string,
  to: string,
): string[] {
  const set = getContaminatedIndex().byCode.get(code);
  if (!set || set.size === 0) return [];
  const hits: string[] = [];
  for (const d of set) {
    if (d >= from && d <= to) hits.push(d);
  }
  return hits.sort();
}

/* ------------------------------------------------------------------ */
/*                       防泄漏边界（供 API 复用）                       */
/* ------------------------------------------------------------------ */

/**
 * 按「已揭示根数」裁剪当日 30m K —— **V3 唯一的裁剪入口**。
 *
 * V3 把可见性从「阶段布尔」升级为「30m 游标」（`session.intradayBarCount`）：
 * 游标 = 玩家当前能看到当日几根 30m K（1~8）。这样同一阶段内也能逐步揭示，
 * 而不必在「只给 1 根」与「一次给满 8 根」之间二选一。
 *
 * 实现要点：按**标准时点表**取上界，而不是简单 `slice(0, n)`。
 *  - n = 1 → 上界 10:00，只给第 1 根（与 V2「当日仅暴露 open」的信息量对齐）；
 *  - n = 8 → 上界 15:00，给满当日 8 根；
 *  - 若某日数据异常（例如只存在盘后棒），n=1 时自然返回空，**不会**误把 13:30 的棒
 *    当成「第一根」发出去。
 *
 * 本函数只做裁剪、不判断阶段；上界由服务端服务层传入，客户端无法影响。
 */
export function clipBarsToCount(
  bars: IntradayBar[],
  revealedCount: number,
): IntradayBar[] {
  if (!Number.isFinite(revealedCount) || revealedCount <= 0) return [];
  const n = Math.min(Math.floor(revealedCount), BARS_PER_DAY);
  const cutoff = INTRADAY_TIMES[n - 1];
  return bars.filter((b) => b.time <= cutoff);
}

/**
 * 「是否已揭示当日收盘」语义下的裁剪（V2 兼容入口）。
 *
 * 等价于 `clipBarsToCount(bars, revealClose ? 8 : 1)`：
 *  - 未揭示收盘 → 只给当日**第一根**（10:00，其 close 是开盘后 30 分钟价，
 *    与 V2「只暴露 open」的信息量对齐：前端只用它画当日起点）；
 *  - 已揭示收盘 → 给当日全部 8 根。
 *
 * 保留它是因为 V2 的语义红线（当日未结算只暴露 open）仍需一个直白入口；
 * **V3 会话读取走 `clipBarsToCount`**，可以合法地给到 2~7 根。
 */
export function clipBarsForReveal(
  bars: IntradayBar[],
  revealClose: boolean,
): IntradayBar[] {
  return clipBarsToCount(bars, revealClose ? BARS_PER_DAY : 1);
}

/* ------------------------------------------------------------------ */
/*                     V3：当日动态日K 与分时轴                          */
/* ------------------------------------------------------------------ */

/**
 * 计算「30m 成交量 / 成交额」→「日K 成交量 / 成交额」的**单位换算因子**。
 *
 * 为什么需要（2026-09-23 实测确认的数据源缺陷）：
 *   `klines.volume`（日K）以**手**计（1 手 = 100 股，A股惯例）；
 *   而 30m parquet 的 `volume` 以**股**计（源自新浪原始分钟线）。
 *   实测比值：`600000` = 100.0000、`000001` = 99.89、`300050` = 99.24；
 *   但 `688002`（科创板）= **1.0000** —— 并非恒定的 100。
 *
 * 若直接把 30m 累加量画进日K 成交量柱，会出现两个后果：
 *   ① 当日柱比历史柱高约 100 倍（量纲不同，图不可读）；
 *   ② **15:00 定格瞬间成交量柱塌陷 100 倍**（从 30m 的「股」切到日K 的「手」）——
 *      这是最典型的「数据看着对、图上是错的」类缺陷。
 *
 * 因此统一换算到**日K 口径**：用当日（或参考日）的日K 值除以 30m 全天值作为因子，
 * 使第 8 根揭示时**恰好等于官方日K 成交量**，与所有历史日可比。
 *
 * 泄漏性说明：因子是**单位常数**（每股固定的量纲比），但为稳妥起见它由**当日**日K 推出；
 * 该值只用于缩放，**从不出现在任何响应中**，玩家无法据此反推当日剩余成交量。
 * 选当日而非前一日作为参考，是为了保证「第 8 根 == 官方日K」这一硬一致性。
 */
export function computeDailyUnitFactors(input: {
  dailyVolume: number;
  dailyAmount: number;
  fullDay30mVolume: number;
  fullDay30mAmount: number;
}): { volumeFactor: number; amountFactor: number } {
  const { dailyVolume, dailyAmount, fullDay30mVolume, fullDay30mAmount } = input;
  return {
    volumeFactor:
      dailyVolume > 0 && fullDay30mVolume > 0 ? dailyVolume / fullDay30mVolume : 1,
    amountFactor:
      dailyAmount > 0 && fullDay30mAmount > 0 ? dailyAmount / fullDay30mAmount : 1,
  };
}

/**
 * 分时图的**开盘锚点**时刻。
 *
 * 第 1 根 30 分钟 K 覆盖 09:30~10:00，其 `open` 就是 09:30 的真实成交价 ——
 * 因此分时图横轴自 09:30 起是有真实数据支撑的，不是补出来的。
 */
export const INTRADAY_OPEN_ANCHOR = "09:30";

/**
 * 分时图横轴的完整刻度 = `09:30` + 8 个标准收盘时点，共 **9** 个。
 *
 * 只用于画横轴；未揭示的时点在 `ticks` 里并不存在（防泄漏）。
 */
export const INTRADAY_AXIS_TIMES: readonly string[] = [
  INTRADAY_OPEN_ANCHOR,
  ...INTRADAY_TIMES.map((t) => t.slice(0, 5)),
];

/** 单日聚合结果（由已揭示的 30m 根现场合成） */
export interface IntradayDayAggregate {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  /** 参与合成的 30m 根数 */
  bars: number;
}

/**
 * 把某日**已揭示**的 30m 根合成为一根日K（OHLCV）。
 *
 * 这是 V3「当日动态日K」的唯一合成入口：
 *  - `open`  = 第 1 根（**不随揭示进度变化**，因为开盘价一开始就已确定）
 *  - `high`  = 已揭示各根 high 的最大值
 *  - `low`   = 已揭示各根 low 的最小值
 *  - `close` = 最后 1 根已揭示的 close（= 当前价）
 *  - `volume`/`amount` = 已揭示各根之和（**因此天然不会提前给出全天量**）
 *
 * 空数组返回 null（该日无 30m 数据 / 被污染排除 / 尚未揭示任何一根）。
 */
export function aggregateDayBars(
  bars: IntradayBar[],
): IntradayDayAggregate | null {
  if (bars.length === 0) return null;
  let high = bars[0].high;
  let low = bars[0].low;
  let volume = 0;
  let amount = 0;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
    amount += b.amount;
  }
  const last = bars[bars.length - 1];
  return {
    open: bars[0].open,
    high,
    low,
    close: last.close,
    volume,
    amount,
    bars: bars.length,
  };
}
