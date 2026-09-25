/**
 * 刷新 Stock 表的冗余元数据（barCount / windowStart / windowEnd）。
 *
 * 为什么需要它：
 *   `Stock.barCount` / `windowStart` / `windowEnd` 是**导入时写下的冗余缓存**
 *   （schema 注释：K 线根数，冗余，便于快速统计与完整性校验），
 *   但每日增量更新只往 `klines` 追加行、**不刷新这三列** —— 于是缓存逐渐与真实行数漂移。
 *   表现：`scripts/testMarketData.ts` 的跨层一致性断言失败，
 *   形如 `沪主板 600519 barCount(255) = DB 实计(261)`（差 6 = 6 个新交易日）。
 *   同时站点列表页显示的是缓存值，会出现"列表说 255 根、详情有 261 根"的不一致。
 *
 * 本脚本以 `klines` 表为唯一事实来源重算这三列：
 *   barCount   = 该股 period='1d' 且 adjust = 该股自身 adjust 的行数
 *   windowStart / windowEnd = 同条件下的 MIN/MAX(date)
 * **只更新派生列，不触碰任何 K 线、交易、账户数据。** 幂等，可反复执行。
 *
 * 运行：
 *   npx tsx scripts/refreshStockMeta.ts            # 直接修复
 *   npx tsx scripts/refreshStockMeta.ts --dry-run  # 只看有多少只不一致
 */

import { prisma } from "@/lib/prisma";

const DRY_RUN = process.argv.includes("--dry-run");

/** 以 klines 为准找出所有元数据不一致的股票 */
async function countMismatch(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`
    SELECT COUNT(*) AS c FROM stocks s
    WHERE EXISTS (
      SELECT 1 FROM klines k
      WHERE k."stockId" = s.id AND k.period = '1d' AND k.adjust = s.adjust
    )
    AND (
      s."barCount" <> (
        SELECT COUNT(*) FROM klines k
        WHERE k."stockId" = s.id AND k.period = '1d' AND k.adjust = s.adjust
      )
      OR s."windowStart" IS NOT (
        SELECT MIN(k."tradeDate") FROM klines k
        WHERE k."stockId" = s.id AND k.period = '1d' AND k.adjust = s.adjust
      )
      OR s."windowEnd" IS NOT (
        SELECT MAX(k."tradeDate") FROM klines k
        WHERE k."stockId" = s.id AND k.period = '1d' AND k.adjust = s.adjust
      )
    )
  `);
  return Number(rows[0].c);
}

/** 抽样打印若干只，便于人工核对改动前后 */
async function sample(limit = 5): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ code: string; barCount: number; live: bigint; windowEnd: number | null; liveEnd: number | null }>
  >(`
    SELECT s.code, s."barCount",
           (SELECT COUNT(*) FROM klines k
             WHERE k."stockId" = s.id AND k.period = '1d' AND k.adjust = s.adjust) AS live,
           s."windowEnd",
           (SELECT MAX(k."tradeDate") FROM klines k
             WHERE k."stockId" = s.id AND k.period = '1d' AND k.adjust = s.adjust) AS "liveEnd"
    FROM stocks s
    WHERE s.code IN ('600519', '000001', '300750', '688981', '920047')
    ORDER BY s.code
  `);
  const fmt = (ms: number | null) =>
    ms === null ? "-" : new Date(Number(ms)).toISOString().slice(0, 10);
  return rows
    .map(
      (r) =>
        `    ${r.code}: barCount ${r.barCount} → ${Number(r.live)}，windowEnd ${fmt(r.windowEnd)} → ${fmt(r.liveEnd)}`
    )
    .join("\n");
}

async function main(): Promise<void> {
  console.log("\n刷新 Stock 冗余元数据（以 klines 表为准）");
  console.log("═".repeat(60));

  const stocks = await prisma.stock.count();
  const klines = await prisma.kline.count();
  const before = await countMismatch();
  console.log(`  stocks=${stocks}  klines=${klines.toLocaleString()}`);
  console.log(`  不一致的股票数（修复前）: ${before}`);
  console.log("  抽样（修复前）:");
  console.log(await sample());

  if (before === 0) {
    console.log("\n✔ 已全部一致，无需修复。");
    return;
  }
  if (DRY_RUN) {
    console.log(`\n[--dry-run] 未写入。需要修复 ${before} 只。`);
    return;
  }

  const changed = await prisma.$executeRawUnsafe(`
    UPDATE stocks
    SET "barCount" = (
          SELECT COUNT(*) FROM klines k
          WHERE k."stockId" = stocks.id AND k.period = '1d' AND k.adjust = stocks.adjust
        ),
        "windowStart" = (
          SELECT MIN(k."tradeDate") FROM klines k
          WHERE k."stockId" = stocks.id AND k.period = '1d' AND k.adjust = stocks.adjust
        ),
        "windowEnd" = (
          SELECT MAX(k."tradeDate") FROM klines k
          WHERE k."stockId" = stocks.id AND k.period = '1d' AND k.adjust = stocks.adjust
        )
    WHERE EXISTS (
      SELECT 1 FROM klines k
      WHERE k."stockId" = stocks.id AND k.period = '1d' AND k.adjust = stocks.adjust
    )
  `);
  console.log(`\n  已更新行数: ${changed}`);

  const after = await countMismatch();
  console.log(`  不一致的股票数（修复后）: ${after}`);
  console.log("  抽样（修复后）:");
  console.log(await sample());
  console.log(after === 0 ? "\n✔ 元数据已与 klines 对齐。" : `\n✗ 仍有 ${after} 只不一致，需排查。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
