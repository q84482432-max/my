/**
 * 指数隔离回归测试
 *
 * 验证目标：指数（market_indices / index_klines）与个股（stocks / klines）
 * **双向不可见**。这是分表设计的核心契约，一旦被破坏，症状是静默的数据错误：
 *   · 行情中心「数据窗口」从 2024-11-04 变成 2006-03-01（指数历史长得多）
 *   · 「股票数」5558 → 5567
 *   · 涨幅榜/跌幅榜被指数占据
 *   · 模拟炒股「随机选股」抽到指数，交易规则直接失效（指数不可交易）
 * 所以这里同时断言两个方向，而不只是「指数能查出来」。
 *
 * 运行： npx tsx scripts/testIndexIsolation.ts
 */

import prisma from "@/lib/prisma";
import {
  getMarketStats,
  getStockInfoByCode,
  getStockList,
  listCodesHavingKlines,
  listRandomCodesHavingKlines,
  listStockCodes,
  searchStocks,
} from "@/services/marketDataService";
import {
  getIndexInfo,
  getIndexKlines,
  getIndexStats,
  isIndexCode,
  listIndices,
  listIndicesCoveringRange,
} from "@/services/indexDataService";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  }
}

function section(t: string): void {
  console.log(`\n\x1b[1m\x1b[36m── ${t} ──\x1b[0m`);
}

/** 个股代码：裸 6 位数字。出现 sh/sz/bj 前缀即说明指数泄漏了 */
const STOCK_CODE_RE = /^\d{6}$/;

async function main() {
  // ---------------------------------------------------------------
  section("一、表的存在性与物理分离");
  // ---------------------------------------------------------------
  const tables = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM sqlite_master WHERE type='table'`;
  const names = new Set(tables.map((t) => t.name));
  check("market_indices 表存在", names.has("market_indices"));
  check("index_klines 表存在", names.has("index_klines"));
  check("stocks 表仍存在", names.has("stocks"));
  check("klines 表仍存在", names.has("klines"));

  // 指数必须不在 stocks 表里
  const idxInStocks = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*) AS n FROM stocks
    WHERE code LIKE 'sh%' OR code LIKE 'sz%' OR code LIKE 'bj%'`;
  check(
    "stocks 表中不存在任何带交易所前缀的代码（指数未混入）",
    Number(idxInStocks[0].n) === 0,
    `命中 ${idxInStocks[0].n} 条`,
  );

  // ---------------------------------------------------------------
  section("二、个股口径必须与引入指数前完全一致");
  // ---------------------------------------------------------------
  const stats = await getMarketStats();
  check("stockCount = 5558", stats.stockCount === 5558, `实际 ${stats.stockCount}`);
  check("klineCount = 2379962", stats.klineCount === 2379962, `实际 ${stats.klineCount}`);
  check(
    "个股数据窗口仍为 2024-11-04",
    stats.startDate === "2024-11-04",
    `实际 ${stats.startDate}`,
  );
  check("个股数据窗口末端 = 2026-09-18", stats.endDate === "2026-09-18", `实际 ${stats.endDate}`);

  const boardSum = Object.values(stats.byBoard).reduce((a, b) => a + b, 0);
  check(
    "byBoard 各板块之和 = stockCount（无多余板块）",
    boardSum === stats.stockCount,
    `板块合计 ${boardSum} vs stockCount ${stats.stockCount}`,
  );
  check(
    "byBoard 不含「指数」类目",
    !Object.keys(stats.byBoard).some((k) => k.includes("指数")),
    JSON.stringify(stats.byBoard),
  );
  check(
    "byAdjust 仍为 qfq 5430 / none 128",
    stats.byAdjust.qfq === 5430 && stats.byAdjust.none === 128,
    JSON.stringify(stats.byAdjust),
  );

  // ---------------------------------------------------------------
  section("三、个股枚举类接口不得返回指数");
  // ---------------------------------------------------------------
  const codesHavingKlines = await listCodesHavingKlines();
  check(
    "listCodesHavingKlines() 条数 = 5558",
    codesHavingKlines.length === 5558,
    `实际 ${codesHavingKlines.length}`,
  );
  const leak1 = codesHavingKlines.filter((c) => !STOCK_CODE_RE.test(c));
  check(
    "listCodesHavingKlines() 全部为裸 6 位数字码",
    leak1.length === 0,
    leak1.length ? `异常: ${leak1.slice(0, 5).join(",")}` : "",
  );

  const allCodes = await listStockCodes();
  const leak2 = allCodes.filter((c) => !STOCK_CODE_RE.test(c));
  check("listStockCodes() 无指数泄漏", leak2.length === 0, leak2.length ? leak2.slice(0, 5).join(",") : "");
  check("listStockCodes() 条数 = 5558", allCodes.length === 5558, `实际 ${allCodes.length}`);

  const randomCodes = await listRandomCodesHavingKlines(60);
  const leak3 = randomCodes.filter((c) => !STOCK_CODE_RE.test(c));
  check(
    "listRandomCodesHavingKlines(60) 无指数（模拟炒股随机选股安全）",
    leak3.length === 0,
    leak3.length ? leak3.slice(0, 5).join(",") : "",
  );

  // ---------------------------------------------------------------
  section("四、列表页 / 搜索不得返回指数");
  // ---------------------------------------------------------------
  const list = await getStockList({ take: 10000 });
  check("getStockList() total = 5558", list.total === 5558, `实际 ${list.total}`);
  const leak4 = list.items.filter((i) => !STOCK_CODE_RE.test(i.code));
  check("getStockList() 返回项无指数", leak4.length === 0, leak4.length ? leak4.slice(0, 5).join(",") : "");
  check(
    "getStockList() 板块取值只在 MAIN/GEM/STAR/BSE 内",
    list.items.every((i) => ["MAIN", "GEM", "STAR", "BSE"].includes(i.board)),
  );

  // 用指数名称做关键词搜索，不应该命中任何个股
  const byIndexName = await searchStocks("上证指数", 50);
  check("searchStocks('上证指数') 返回空", byIndexName.length === 0, `命中 ${byIndexName.length} 条`);

  // ---------------------------------------------------------------
  section("五、按代码取数不得混淆（000001 双身份）");
  // ---------------------------------------------------------------
  const stock000001 = await getStockInfoByCode("000001");
  check(
    "000001 优先进个股表 → 平安银行",
    stock000001?.name === "平安银行",
    `实际 ${stock000001?.name}`,
  );
  check("getStockInfoByCode('sh000001') 返回 null（指数不在个股表）", (await getStockInfoByCode("sh000001")) === null);

  // ---------------------------------------------------------------
  section("六、指数侧数据可用");
  // ---------------------------------------------------------------
  const indices = await listIndices();
  check("指数条数 = 9", indices.length === 9, `实际 ${indices.length}`);
  check("指数代码全部带交易所前缀", indices.every((i) => isIndexCode(i.code)));

  const idxStats = await getIndexStats();
  check("指数 K 线总数 = 34558", idxStats.barCount === 34558, `实际 ${idxStats.barCount}`);
  check("指数最早日 = 2006-03-01", idxStats.startDate === "2006-03-01", `实际 ${idxStats.startDate}`);
  check("指数最新日 = 2026-09-18", idxStats.endDate === "2026-09-18", `实际 ${idxStats.endDate}`);

  const sh = await getIndexInfo("sh000001");
  check("sh000001 = 上证指数", sh?.name === "上证指数", `实际 ${sh?.name}`);
  check("上证指数 barCount = 5000", sh?.barCount === 5000, `实际 ${sh?.barCount}`);

  const bars = await getIndexKlines("sh000001");
  check("getIndexKlines('sh000001') 返回 5000 根", bars.length === 5000, `实际 ${bars.length}`);
  check("首根日期 = 2006-03-01", bars[0]?.date === "2006-03-01", `实际 ${bars[0]?.date}`);
  check("末根日期 = 2026-09-18", bars[bars.length - 1]?.date === "2026-09-18");
  check("升序排列", bars.every((b, i) => i === 0 || bars[i - 1].date < b.date));
  check(
    "价格为正且 high >= low",
    bars.every((b) => b.close > 0 && b.high >= b.low),
  );

  // 指数取数路径必须拒绝裸码
  check("getIndexKlines('000001') 返回空（裸码不被当指数）", (await getIndexKlines("000001")).length === 0);
  check("getIndexInfo('000001') 返回 null", (await getIndexInfo("000001")) === null);
  check("getIndexKlines('sh999999') 返回空（不存在的指数）", (await getIndexKlines("sh999999")).length === 0);

  check("isIndexCode('sh000001') = true", isIndexCode("sh000001"));
  check("isIndexCode('000001') = false", !isIndexCode("000001"));
  check("isIndexCode('600036') = false", !isIndexCode("600036"));

  // 区间查询：主库窗口内每个指数都该有 459 根
  const inWindow = await listIndicesCoveringRange("2024-11-04", "2026-09-18", 400);
  check(
    "覆盖主库窗口（≥400根）的指数 = 9 个",
    inWindow.length === 9,
    `实际 ${inWindow.length}`,
  );
  check(
    "每个指数在主库窗口内均恰好 459 根",
    inWindow.every((i) => i.barCount === 459),
    inWindow.map((i) => `${i.code}:${i.barCount}`).join(" "),
  );

  // 区间过滤生效
  const ranged = await getIndexKlines("sh000001", {
    startDate: "2024-11-04",
    endDate: "2026-09-18",
  });
  check("区间查询 2024-11-04→2026-09-18 得 459 根", ranged.length === 459, `实际 ${ranged.length}`);

  // ---------------------------------------------------------------
  section("七、孤儿数据");
  // ---------------------------------------------------------------
  const orphan = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*) AS n FROM index_klines
    WHERE indexId NOT IN (SELECT id FROM market_indices)`;
  check("index_klines 无孤儿行", Number(orphan[0].n) === 0, `实际 ${orphan[0].n}`);

  const dup = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*) AS n FROM (
      SELECT indexId, tradeDate FROM index_klines
      GROUP BY indexId, tradeDate HAVING COUNT(*) > 1)`;
  check("index_klines 无重复 (indexId, tradeDate)", Number(dup[0].n) === 0);

  // ---------------------------------------------------------------
  console.log(`\n\x1b[1m结果：\x1b[32m${passed} 通过\x1b[0m / \x1b[31m${failed} 失败\x1b[0m`);
  if (failed) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
