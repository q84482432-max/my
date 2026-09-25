/**
 * 把服务器导出的 JSON（由 deploy/export-to-local.py 产出）导入本机开发库。
 *
 * 用途
 * ----
 * 本机开发库常年落后于线上（线上有 market-update.timer 日更）。做指数前端时撞上了：
 * 本机 `market_indices` / `index_klines` 是空表，页面没数据、`test:index` 也会因
 * 「数据缺失」失败（不是代码问题）。本脚本把线上导出的数据补进本机。
 *
 * 用法
 * ----
 *   # 1) 在服务器上导出（见 deploy/export-to-local.py）
 *   # 2) 下载到 .tmp-run/market-export.json
 *   # 3) 导入本机
 *   npx tsx scripts/importServerExport.ts [文件路径]
 *
 * 幂等性
 * ------
 * - `market_indices` / `index_klines`：**先清空再整表导入**（这两张表在本机属于
 *   「从线上同步」的只读副本，整表替换比逐行 upsert 更简单也更不容易漏）。
 * - `klines`（个股增量）：按 `tradeDate >= since` **先删后插**，避免重复行。
 *   注意只动增量区间，本机更早的历史不受影响。
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const FILE = process.argv[2] ?? ".tmp-run/market-export.json";

/** SQLite 里 DateTime 有「整数毫秒」与「"YYYY-MM-DD HH:mm:ss" 文本」两种写法，都要认。 */
function toDate(v: unknown): Date {
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    const m = v.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/,
    );
    // 库内文本时间戳不含时区，按本地时间解析（与写入端一致）
    if (m) {
      return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    return new Date(v);
  }
  return new Date();
}

function toNullableDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return toDate(v);
}

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v);
  return 0n;
}

async function inBatches<T>(
  rows: T[],
  size: number,
  fn: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
    process.stdout.write(
      `\r  已处理 ${Math.min(i + size, rows.length)}/${rows.length}`,
    );
  }
  if (rows.length > 0) process.stdout.write("\n");
}

async function main() {
  const raw = JSON.parse(readFileSync(FILE, "utf8")) as {
    meta: { exportedAt: string; dbPath: string; since: string | null; counts: Record<string, number> };
    indices: Record<string, unknown>[];
    indexKlines: Record<string, unknown>[];
    klines: Record<string, unknown>[];
  };

  console.log("=== 导入服务器导出数据 ===");
  console.log(`源文件      : ${FILE}`);
  console.log(`导出时间    : ${raw.meta.exportedAt}`);
  console.log(`源库        : ${raw.meta.dbPath}`);
  console.log(`个股增量起点: ${raw.meta.since ?? "(未导出)"}`);
  console.log("");

  /* ---------------- 指数主表 ---------------- */
  console.log(`[1/3] market_indices (${raw.indices.length} 行) —— 整表替换`);
  await prisma.indexKline.deleteMany();
  await prisma.marketIndex.deleteMany();
  if (raw.indices.length > 0) {
    await inBatches(raw.indices, 500, (batch) =>
      prisma.marketIndex.createMany({
        data: batch.map((r) => ({
          id: String(r.id),
          code: String(r.code),
          name: String(r.name),
          exchange: String(r.exchange),
          category: String(r.category),
          source: String(r.source),
          barCount: Number(r.barCount),
          windowStart: toNullableDate(r.windowStart),
          windowEnd: toNullableDate(r.windowEnd),
          createdAt: toDate(r.createdAt),
          updatedAt: toDate(r.updatedAt),
        })),
      }),
    );
  }
  console.log(`      -> 完成，当前 ${await prisma.marketIndex.count()} 行`);

  /* ---------------- 指数 K 线 ---------------- */
  console.log(`[2/3] index_klines (${raw.indexKlines.length} 行) —— 整表导入`);
  if (raw.indexKlines.length > 0) {
    await inBatches(raw.indexKlines, 2000, (batch) =>
      prisma.indexKline.createMany({
        data: batch.map((r) => ({
          id: String(r.id),
          indexId: String(r.indexId),
          tradeDate: toDate(r.tradeDate),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: toBigInt(r.volume),
          createdAt: toDate(r.createdAt),
        })),
      }),
    );
  }
  console.log(`      -> 完成，当前 ${await prisma.indexKline.count()} 行`);

  /* ---------------- 个股增量 ---------------- */
  console.log(`[3/3] klines 增量 (${raw.klines.length} 行)`);
  if (raw.klines.length > 0 && raw.meta.since) {
    const since = new Date(
      `${raw.meta.since}T00:00:00`,
    );
    const removed = await prisma.kline.deleteMany({
      where: { tradeDate: { gte: since } },
    });
    console.log(`      先删除同区间旧行：${removed.count} 行`);

    await inBatches(raw.klines, 2000, (batch) =>
      prisma.kline.createMany({
        data: batch.map((r) => ({
          id: String(r.id),
          stockId: String(r.stockId),
          period: String(r.period),
          tradeDate: toDate(r.tradeDate),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: toBigInt(r.volume),
          // klines.amount 在 schema 里是 `Decimal @default(0)`（非空），
          // 缺失时传 undefined 让 default 生效 —— 不能传 null（类型不接受）。
          amount: r.amount == null ? undefined : Number(r.amount),
          adjust: String(r.adjust),
        })),
      }),
    );
    console.log(`      -> 完成，当前 klines 共 ${await prisma.kline.count()} 行`);
  } else {
    console.log("      -> 跳过（导出文件未含个股增量）");
  }

  /* ---------------- 校验 ---------------- */
  const stockCount = await prisma.stock.count();
  const klineCount = await prisma.kline.count();
  const agg = await prisma.kline.aggregate({
    _min: { tradeDate: true },
    _max: { tradeDate: true },
  });
  const fmt = (d: Date | null | undefined) =>
    d ? d.toISOString().slice(0, 10) : "--";

  console.log("\n=== 本机库现状 ===");
  console.log(`  股票数      : ${stockCount}`);
  console.log(`  个股 K 线    : ${klineCount}`);
  console.log(`  个股窗口     : ${fmt(agg._min.tradeDate)} → ${fmt(agg._max.tradeDate)}`);
  console.log(`  指数数      : ${await prisma.marketIndex.count()}`);
  console.log(`  指数 K 线    : ${await prisma.indexKline.count()}`);
}

main()
  .catch((e) => {
    console.error("\n导入失败：", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
