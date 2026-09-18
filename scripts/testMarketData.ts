/**
 * MarketDataService 端到端测试（第二阶段验收）
 *
 * 验证目标（对齐用户指令）：
 *   1. getStockList()          — 列表查询（分页 / 板块过滤 / 关键词）
 *   2. getStockInfo()          — 单只股票元信息（含 adjust / fullWindow）
 *   3. getKline()              — K 线查询，按交易日期升序
 *   4. getHistoricalKline()    — 历史区间查询，严格升序
 *   5. 真实数据落地校验（非 mock）+ 板块/口径分布与源索引一致
 *   6. 跨层一致性：Service 结果 vs 数据库直查
 *
 * 运行： npx tsx scripts/testMarketData.ts
 */

import { prisma } from "@/lib/prisma";
import {
  getStockList,
  getStockInfo,
  getStockInfoByCode,
  getKline,
  getHistoricalKline,
  getMarketStats,
  searchStocks,
} from "@/services/marketDataService";
import { toDateStr } from "@/lib/utils";
import type { AdjustType } from "@/types";

/* ------------------------------------------------------------------ */
/* 测试框架（轻量，无外部依赖）                                          */
/* ------------------------------------------------------------------ */

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

function section(title: string): void {
  console.log(`\n\x1b[1m\x1b[36m── ${title} ──\x1b[0m`);
}

/** 断言数组按日期严格升序 */
function assertAscending(dates: string[]): { ok: boolean; badAt?: number } {
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] <= dates[i - 1]) return { ok: false, badAt: i };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("\n\x1b[1m第二阶段验收测试 — MarketDataService 端到端\x1b[0m");
  console.log("═".repeat(64));

  /* ============================================================ */
  section("0. 数据库基线（真实数据落地确认）");

  const dbStockCount = await prisma.stock.count();
  const dbKlineCount = await prisma.kline.count();
  check("Stock 表非空", dbStockCount > 0, `stocks=${dbStockCount}`);
  check("Kline 表非空", dbKlineCount > 0, `klines=${dbKlineCount}`);
  check(
    "全市场股票数 ≥ 5000（真实全量，非 mock）",
    dbStockCount >= 5000,
    `实得 ${dbStockCount}`
  );
  check(
    "K 线总量 ≥ 2,000,000",
    dbKlineCount >= 2_000_000,
    `实得 ${dbKlineCount.toLocaleString()}`
  );

  const stats = await getMarketStats();
  check(
    "getMarketStats 口径分布 = qfq 5430 / none 128",
    stats.byAdjust["qfq"] === 5430 && stats.byAdjust["none"] === 128,
    JSON.stringify(stats.byAdjust)
  );
  check(
    "getMarketStats 板块分布（中文标签）沪主板1700/深主板1492/创业板1407/科创板616/北交所343",
    stats.byBoard["沪主板"] === 1700 &&
      stats.byBoard["深主板"] === 1492 &&
      stats.byBoard["创业板"] === 1407 &&
      stats.byBoard["科创板"] === 616 &&
      stats.byBoard["北交所"] === 343,
    JSON.stringify(stats.byBoard)
  );
  check(
    "fullWindow=true 共 4782 只（次新股 776 只 = false）",
    stats.fullWindowCount === 4782,
    `实得 ${stats.fullWindowCount}`
  );
  check(
    "K 线日期区间覆盖 20241104 ~ 20260910",
    stats.startDate === "2024-11-04" && stats.endDate === "2026-09-10",
    `${stats.startDate} ~ ${stats.endDate}`
  );

  /* ============================================================ */
  section("1. getStockList() — 列表查询");

  const page1 = await getStockList({ take: 20, skip: 0 });
  check("返回 20 条（默认分页）", page1.items.length === 20, `实得 ${page1.items.length}`);
  check("total = 全库股票数", page1.total === dbStockCount, `total=${page1.total}`);
  check(
    "出参字段完整（code/name/exchange/board/barCount/windowStart/windowEnd/adjust/fullWindow）",
    page1.items.every(
      (s) =>
        typeof s.code === "string" &&
        typeof s.name === "string" &&
        typeof s.exchange === "string" &&
        typeof s.board === "string" &&
        typeof s.barCount === "number" &&
        s.adjust !== undefined &&
        typeof s.fullWindow === "boolean"
    )
  );
  console.log(
    `    样例: ${page1.items
      .slice(0, 3)
      .map((s) => `${s.code}/${s.name}/${s.board}/${s.adjust}/${s.barCount}根`)
      .join("  ")}`
  );

  const page2 = await getStockList({ take: 20, skip: 20 });
  check(
    "分页不重复（page1 与 page2 code 无交集）",
    !page1.items.some((a) => page2.items.some((b) => b.code === a.code))
  );

  const gemList = await getStockList({ board: "GEM", take: 5 });
  check(
    "板块过滤 board=GEM 生效（total=1407）",
    gemList.total === 1407 && gemList.items.every((s) => s.board === "GEM"),
    `total=${gemList.total}`
  );

  const bseList = await getStockList({ board: "BSE", take: 5 });
  check(
    "板块过滤 board=BSE 生效（total=343）",
    bseList.total === 343 && bseList.items.every((s) => s.exchange === "BJ"),
    `total=${bseList.total}`
  );

  const mainList = await getStockList({ board: "MAIN", take: 5 });
  check(
    "板块过滤 board=MAIN 生效（total=3192）",
    mainList.total === 3192,
    `total=${mainList.total}`
  );

  const exList = await getStockList({ exchange: "SH", take: 5 });
  check(
    "交易所过滤 exchange=SH 生效（total=2316）",
    exList.total === 2316,
    `total=${exList.total}`
  );

  const kwList = await getStockList({ keyword: "600519", take: 5 });
  check(
    "关键词搜索命中 600519 贵州茅台",
    kwList.items.some((s) => s.code === "600519" && s.name === "贵州茅台"),
    kwList.items.map((s) => `${s.code}/${s.name}`).join(", ")
  );

  /* ============================================================ */
  section("2. getStockInfo() — 单只股票元信息");

  const maotai = await getStockInfo("600519");
  check("getStockInfo('600519') 返回非空", maotai !== null);
  if (maotai) {
    check("code 正确", maotai.code === "600519", maotai.code);
    check("name = 贵州茅台", maotai.name === "贵州茅台", maotai.name);
    check("board 内部枚举 = MAIN", maotai.board === "MAIN", maotai.board);
    check("exchange = SH", maotai.exchange === "SH", maotai.exchange);
    check("adjust 字段存在且为 qfq", maotai.adjust === "qfq", maotai.adjust);
    check(
      "fullWindow 字段存在（bool）",
      typeof maotai.fullWindow === "boolean",
      String(maotai.fullWindow)
    );
    check(
      "barCount 与源索引 bars 一致（600519 = 255，源自 2025-08-25）",
      maotai.barCount === 255,
      `barCount=${maotai.barCount} 窗口 ${maotai.windowStart}~${maotai.windowEnd}`
    );
    check(
      "windowStart/windowEnd 与源索引一致（2025-08-25 ~ 2026-09-10）",
      maotai.windowStart === "2025-08-25" && maotai.windowEnd === "2026-09-10",
      `${maotai.windowStart} ~ ${maotai.windowEnd}`
    );
    console.log(
      `    元信息: ${maotai.name}(${maotai.code}) ${maotai.board}/${maotai.exchange} ` +
        `窗口 ${maotai.windowStart}~${maotai.windowEnd} ` +
        `${maotai.barCount}根 @${maotai.adjust} fullWindow=${maotai.fullWindow}`
    );
  }

  const gemStock = await getStockInfoByCode("300750");
  check(
    "getStockInfoByCode('300750') 命中宁德时代（创业板 GEM）",
    gemStock !== null && gemStock.name === "宁德时代" && gemStock.board === "GEM",
    gemStock ? `${gemStock.name}/${gemStock.board}` : "null"
  );

  const bseStock = await getStockInfoByCode("920047");
  check(
    "北交所股票可查（920047）",
    bseStock !== null && bseStock.exchange === "BJ",
    bseStock ? `${bseStock.code}/${bseStock.name}/${bseStock.exchange}` : "null"
  );

  const notFound = await getStockInfo("999999");
  check("不存在代码返回 null（不抛错）", notFound === null);

  const searchRes = await searchStocks("茅台", 5);
  check(
    "searchStocks('茅台') 命中",
    searchRes.some((s) => s.code === "600519"),
    searchRes.map((s) => `${s.code}/${s.name}`).join(", ")
  );

  /* ============================================================ */
  section("3. getKline() — 日 K 查询（升序校验）");

  const klines = await getKline("600519", { period: "1d" });
  check("getKline('600519') 返回非空", klines.length > 0, `${klines.length} 根`);
  check(
    "KlineBar 出参字段完整（date/open/high/low/close/volume/amount）",
    klines.every(
      (k) =>
        typeof k.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(k.date) &&
        typeof k.open === "number" &&
        typeof k.high === "number" &&
        typeof k.low === "number" &&
        typeof k.close === "number" &&
        typeof k.volume === "number" &&
        typeof k.amount === "number"
    )
  );

  const kDates = klines.map((k) => k.date);
  const ascK = assertAscending(kDates);
  check(
    "K 线按交易日期严格升序",
    ascK.ok,
    ascK.ok ? `${kDates[0]} → ${kDates[kDates.length - 1]}` : `第 ${ascK.badAt} 根乱序`
  );
  check(
    "无重复交易日",
    new Set(kDates).size === kDates.length,
    `${kDates.length} 根 / ${new Set(kDates).size} 唯一`
  );
  check(
    "OHLC 数值合法（正数 / high≥low / high≥max(o,c) / low≤min(o,c)）",
    klines.every(
      (k) =>
        k.open > 0 &&
        k.close > 0 &&
        k.high > 0 &&
        k.low > 0 &&
        k.high >= k.low &&
        k.high >= Math.max(k.open, k.close) &&
        k.low <= Math.min(k.open, k.close)
    )
  );
  check(
    "volume / amount 字段可用（amount 由 close×volume 推导 > 0）",
    klines.every((k) => k.volume > 0 && k.amount > 0)
  );
  console.log(
    `    首根 ${kDates[0]} O=${klines[0].open} C=${klines[0].close} ` +
      `H=${klines[0].high} L=${klines[0].low}`
  );
  console.log(
    `    末根 ${kDates[kDates.length - 1]} O=${klines[klines.length - 1].open} ` +
      `C=${klines[klines.length - 1].close}`
  );

  const limitK = await getKline("600519", { limit: 10 });
  check(
    "limit 生效且返回最近 10 根（仍升序）",
    limitK.length === 10 && assertAscending(limitK.map((k) => k.date)).ok,
    `${limitK.length} 根`
  );
  check(
    "limit 返回的是最新段（末根 = 全量末根）",
    limitK[limitK.length - 1].date === kDates[kDates.length - 1],
    limitK[limitK.length - 1].date
  );

  /* ============================================================ */
  section("4. getHistoricalKline() — 历史区间（严格升序）");

  const hist = await getHistoricalKline("600519", "2025-01-01", "2025-12-31");
  check("区间查询返回非空", hist.length > 0, `${hist.length} 根`);
  const histDates = hist.map((k) => k.date);
  const ascH = assertAscending(histDates);
  check(
    "区间 K 线严格升序（相邻两根日期递增）",
    ascH.ok,
    ascH.ok ? `${histDates[0]} → ${histDates[histDates.length - 1]}` : `第 ${ascH.badAt} 根乱序`
  );
  check(
    "区间边界正确（全部落在 2025-01-01 ~ 2025-12-31 内）",
    histDates.every((d) => d >= "2025-01-01" && d <= "2025-12-31"),
    `${histDates[0]} ~ ${histDates[histDates.length - 1]}`
  );
  check(
    "区间内无重复交易日",
    new Set(histDates).size === histDates.length
  );
  // 600519 真实数据仅自 2025-08-25 起（源索引 bars=255），故 2025 年内区间根数
  // 应为「2025-08-25 ~ 2025-12-31」的交易日数，而非全年。
  // 用全窗口区间做量级校验更稳健：2024-11-04 ~ 2026-09-10 应 ≈ 453 根。
  const fullHist = await getHistoricalKline("600519", "2024-11-04", "2026-09-10");
  check(
    "全窗口区间根数 = 该股 barCount（255）",
    fullHist.length === 255,
    `${fullHist.length} 根`
  );
  check(
    "区间裁剪生效：2025 年区间根数 < 全窗口根数",
    hist.length > 0 && hist.length < fullHist.length,
    `区间 ${hist.length} / 全窗口 ${fullHist.length}`
  );

  // 与数据库直查对比（跨层一致性）
  const dbHist = await prisma.kline.findMany({
    where: {
      stock: { code: "600519" },
      period: "1d",
      adjust: "qfq",
      tradeDate: {
        gte: new Date(Date.UTC(2025, 0, 1)),
        lte: new Date(Date.UTC(2025, 11, 31)),
      },
    },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, close: true },
  });
  check(
    "Service 区间结果与 DB 直查根数一致",
    hist.length === dbHist.length,
    `service=${hist.length} db=${dbHist.length}`
  );
  check(
    "Service 区间结果与 DB 直查日期序列完全一致",
    histDates.join(",") === dbHist.map((r) => toDateStr(r.tradeDate)).join(",")
  );

  // 跨区间：两个相邻区间拼起来仍应严格升序
  const h1 = await getHistoricalKline("600519", "2025-01-01", "2025-06-30");
  const h2 = await getHistoricalKline("600519", "2025-07-01", "2025-12-31");
  const joined = [...h1, ...h2].map((k) => k.date);
  check(
    "相邻两区间拼接后仍严格升序（无边界重叠）",
    assertAscending(joined).ok,
    `h1=${h1.length} h2=${h2.length}`
  );

  // 不同口径交叉验证（raw 股票）
  const rawInfo = await prisma.stock.findFirst({
    where: { adjust: "none" },
    select: { code: true, name: true, board: true },
  });
  if (rawInfo) {
    const rawK = await getKline(rawInfo.code, { adjust: "none" });
    check(
      `raw 口径股票可查（${rawInfo.code}/${rawInfo.name}/${rawInfo.board}）`,
      rawK.length > 0 && assertAscending(rawK.map((k) => k.date)).ok,
      `${rawK.length} 根 @none`
    );
  }

  /* ============================================================ */
  section("5. 跨板块抽样（每板块一只，验证升序与出参）");

  const samples: Array<{ board: string; code: string; name: string }> = [
    { board: "沪主板", code: "600519", name: "贵州茅台" },
    { board: "深主板", code: "000001", name: "平安银行" },
    { board: "创业板", code: "300750", name: "宁德时代" },
    { board: "科创板", code: "688981", name: "中芯国际" },
    { board: "北交所", code: "920047", name: "" },
  ];

  for (const s of samples) {
    const info = await getStockInfoByCode(s.code);
    if (!info) {
      check(`${s.board} ${s.code} 可查询`, false, "未命中");
      continue;
    }
    // 关键：必须传该股自身 adjust。服务默认 qfq，而科创/北交（extra 目录）为 none，
    // 不传口径会返回 0 根 —— 这是口径隔离的正确表现，不是数据缺失。
    const bars = await getKline(s.code, { period: "1d", adjust: info.adjust });
    const dates = bars.map((k) => k.date);
    const ok = bars.length > 0 && assertAscending(dates).ok;
    check(
      `${s.board} ${info.code}/${info.name} 升序校验`,
      ok,
      `${bars.length} 根 ${dates[0] ?? "-"} → ${dates[dates.length - 1] ?? "-"} @${info.adjust}`
    );
    // barCount 与实取根数一致性
    const typeCheck = await prisma.kline.count({
      where: { stock: { code: s.code }, period: "1d", adjust: info.adjust },
    });
    check(
      `${s.board} ${info.code} barCount(${info.barCount}) = DB 实计(${typeCheck})`,
      info.barCount === typeCheck
    );
  }

  /* ============================================================ */
  section("6. 周 K / 月 K 聚合（日 K 派生，仍升序）");

  const weekly = await getKline("600519", { period: "1w" });
  const weeklyDates = weekly.map((k) => k.date);
  check(
    "周 K 非空且升序",
    weekly.length > 0 && assertAscending(weeklyDates).ok,
    `${weekly.length} 根`
  );
  check(
    "周 K 根数 < 日 K 根数（聚合生效）",
    weekly.length < klines.length,
    `周 ${weekly.length} vs 日 ${klines.length}`
  );

  const monthly = await getKline("600519", { period: "1M" });
  const monthlyDates = monthly.map((k) => k.date);
  check(
    "月 K 非空且升序",
    monthly.length > 0 && assertAscending(monthlyDates).ok,
    `${monthly.length} 根`
  );
  check(
    "月 K 根数 < 周 K 根数",
    monthly.length < weekly.length,
    `月 ${monthly.length} vs 周 ${weekly.length}`
  );

  /* ============================================================ */
  section("7. 复权口径隔离（qfq / raw 不互相污染）");

  // 688981 中芯国际属 raw(none) 口径，用默认 qfq 查询应返回空 —— 证明口径被严格隔离，
  // 不会把 raw 的 K 线冒充成前复权数据返回（回测污染的关键防线）。
  const crossQuote = await getKline("688981", { period: "1d" });
  check(
    "raw 口径股票用默认 qfq 查询返回空（口径严格隔离）",
    crossQuote.length === 0,
    `${crossQuote.length} 根`
  );
  const ownQuote = await getKline("688981", { period: "1d", adjust: "none" });
  check(
    "raw 口径股票用自身 adjust=none 可正常取到",
    ownQuote.length > 0 && assertAscending(ownQuote.map((k) => k.date)).ok,
    `${ownQuote.length} 根`
  );
  check(
    "全库无任何股票同时存在 qfq 与 none 两套 K 线",
    (await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*) AS c FROM (
         SELECT "stockId" FROM klines GROUP BY "stockId" HAVING COUNT(DISTINCT "adjust") > 1
       )`
    ).then((r) => Number(r[0].c))) === 0
  );

  /* ============================================================ */
  section("8. 全库升序性抽样（50 只随机股票）");

  const spotStocks = await prisma.stock.findMany({
    take: 50,
    skip: 1200,
    select: { code: true, name: true, adjust: true },
    orderBy: { code: "asc" },
  });

  let ascFail = 0;
  let emptyCount = 0;
  for (const st of spotStocks) {
    const bars = await getHistoricalKline(st.code, "2024-11-04", "2026-09-10", {
      period: "1d",
      adjust: st.adjust as AdjustType,
      limit: 5000,
    });
    if (bars.length === 0) {
      emptyCount++;
      continue;
    }
    if (!assertAscending(bars.map((k) => k.date)).ok) {
      ascFail++;
      console.log(`    \x1b[31m乱序: ${st.code}/${st.name}\x1b[0m`);
    }
  }
  check(
    "50 只抽样全部升序（0 乱序）",
    ascFail === 0,
    `乱序 ${ascFail} 只 / 空 ${emptyCount} 只`
  );

  /* ============================================================ */
  section("9. 性能基准（查询延迟）");

  const t0 = Date.now();
  await getKline("600519", { period: "1d" });
  const tSingle = Date.now() - t0;

  const t1 = Date.now();
  await getHistoricalKline("600519", "2025-01-01", "2025-12-31");
  const tRange = Date.now() - t1;

  const t2 = Date.now();
  await getStockList({ take: 50 });
  const tList = Date.now() - t2;

  const t3 = Date.now();
  await getStockInfo("600519");
  const tInfo = Date.now() - t3;

  check("单只全量日 K < 150ms", tSingle < 150, `${tSingle}ms`);
  check("区间查询 < 100ms", tRange < 100, `${tRange}ms`);
  check("列表分页 < 100ms", tList < 100, `${tList}ms`);
  check("单只元信息 < 60ms", tInfo < 60, `${tInfo}ms`);

  /* ============================================================ */
  console.log("\n" + "═".repeat(64));
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `\x1b[1m\x1b[32m✔ 全部通过：${passed}/${total}\x1b[0m  ` +
        `(MarketDataService 四个核心方法 + 升序性 + 数据完整性)`
    );
  } else {
    console.log(`\x1b[1m\x1b[31m✗ 失败 ${failed}/${total}\x1b[0m`);
    failures.forEach((f) => console.log(`    - ${f}`));
  }
  console.log("═".repeat(64) + "\n");
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("\n\x1b[31m测试执行异常:\x1b[0m", e);
    await prisma.$disconnect();
    process.exit(1);
  });
