/**
 * testStockQuoteOhlc —— 行情快照新增「开 / 高 / 低」字段的验收
 *
 * 背景：个股页头部要展示与同花顺一致的「价 + 涨跌 + 高/低/开」行情块，
 * 而 `StockQuote` 原先只有 `lastPrice/change/changePercent/prevClose`，缺开高低。
 * 本次给 `getStockQuotes` 的窗口函数补选了 `open/high/low` 三列。
 *
 * 本测试重点证明的不是「字段存在」，而是**四者同源**：
 * `lastPrice/open/high/low` 必须全部来自**同一根最新日K**。
 * 这类「价格来自 A 日、开高低来自 B 日」的错配在界面上完全看不出来
 * （数字都合理），只能靠独立取那根K线逐字段比对才能发现 —— 因此值得单测。
 *
 * 运行：DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testStockQuoteOhlc.ts')"
 */
import prisma from "@/lib/prisma";
import { getKlineAt, getStockQuote, getStockQuotes } from "@/services/marketDataService";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

async function main(): Promise<void> {
  console.log("\n=== A. 单只：字段存在且自洽 ===");
  const code = "600000"; // 浦发银行，K线必然存在
  const q = await getStockQuote(code);
  check(`可取到 ${code} 的行情`, q !== null, "返回 null");
  if (!q) throw new Error("行情为空");

  check("含 open 字段", typeof q.open === "number", `${typeof q.open}`);
  check("含 high 字段", typeof q.high === "number", `${typeof q.high}`);
  check("含 low 字段", typeof q.low === "number", `${typeof q.low}`);
  check("open/high/low 均 > 0", q.open > 0 && q.high > 0 && q.low > 0, `o=${q.open} h=${q.high} l=${q.low}`);

  // 区间自洽：low ≤ {open, close} ≤ high
  check("low ≤ open ≤ high", q.low <= q.open + 1e-6 && q.open <= q.high + 1e-6, `l=${q.low} o=${q.open} h=${q.high}`);
  check(
    "low ≤ lastPrice（收盘） ≤ high",
    q.low <= q.lastPrice + 1e-6 && q.lastPrice <= q.high + 1e-6,
    `l=${q.low} c=${q.lastPrice} h=${q.high}`,
  );

  console.log("\n=== B. ★ 四者同源：与最新那根日K 逐字段一致 ===");
  {
    check("lastDate 非空（有最新交易日）", q.lastDate !== null, `${q.lastDate}`);
    if (q.lastDate) {
      const bar = await getKlineAt(code, q.lastDate);
      check("能独立取到该日的日K（对照用）", bar !== null, `date=${q.lastDate}`);
      if (bar) {
        check("open 与日K open 一致", near(q.open, bar.open, 1e-6), `quote=${q.open} bar=${bar.open}`);
        check("high 与日K high 一致", near(q.high, bar.high, 1e-6), `quote=${q.high} bar=${bar.high}`);
        check("low 与日K low 一致", near(q.low, bar.low, 1e-6), `quote=${q.low} bar=${bar.low}`);
        check("lastPrice 与日K close 一致", near(q.lastPrice, bar.close, 1e-6), `quote=${q.lastPrice} bar=${bar.close}`);
      }
    }
  }

  console.log("\n=== C. 批量与单只结果一致（同一套 SQL 口径）===");
  {
    const map = await getStockQuotes([code, "000001"]);
    check("批量返回两只", Object.keys(map).length === 2, JSON.stringify(Object.keys(map)));
    const q2 = map[code];
    check("批量中该股的 open 与单只一致", q2 !== undefined && near(q2.open, q.open, 1e-9), `${q2?.open} vs ${q.open}`);
    check("批量中该股的 high 与单只一致", q2 !== undefined && near(q2.high, q.high, 1e-9), `${q2?.high} vs ${q.high}`);
    check("批量中该股的 low 与单只一致", q2 !== undefined && near(q2.low, q.low, 1e-9), `${q2?.low} vs ${q.low}`);

    // 000001 上证指数代码与深发展冲突，这里只验证它若有数据则同样自洽
    const sz = map["000001"];
    if (sz && sz.lastPrice > 0) {
      check("第二只同样满足 low ≤ open ≤ high", sz.low <= sz.open + 1e-6 && sz.open <= sz.high + 1e-6, `l=${sz.low} o=${sz.open} h=${sz.high}`);
    }
  }

  console.log("\n=== D. 不存在的代码 → null（不伪造空行情）===");
  {
    const bad = await getStockQuote("999999");
    check("不存在的代码返回 null", bad === null, JSON.stringify(bad));
    const emptyMap = await getStockQuotes([]);
    check("空数组返回空对象", Object.keys(emptyMap).length === 0, JSON.stringify(emptyMap));
  }

  console.log("\n=== E. 与数据库直读交叉验证（防止 SQL 选错列）===");
  {
    /* 直接查库拿最新一根日K，绕过 service，验证 service 用的确实是 `close` 而不是别的列
       —— 历史上出现过「SELECT 少写一列导致 NaN」的事故类型。 */
    const rows = await prisma.$queryRaw<Array<{ open: unknown; high: unknown; low: unknown; close: unknown }>>`
      SELECT k."open" AS open, k."high" AS high, k."low" AS low, k."close" AS close
      FROM "klines" k
      JOIN "stocks" s ON s."id" = k."stockId"
      WHERE s."code" = ${code} AND k."period" = '1d'
      ORDER BY k."tradeDate" DESC
      LIMIT 1
    `;
    const r = rows[0];
    check("数据库直读取到一行", !!r, "无结果");
    if (r) {
      const n = (v: unknown) => (typeof v === "number" ? v : Number(v));
      check("high 与库内一致（SQL 未选错列）", near(q.high, n(r.high), 1e-6), `quote=${q.high} db=${n(r.high)}`);
      check("low 与库内一致", near(q.low, n(r.low), 1e-6), `quote=${q.low} db=${n(r.low)}`);
      check("open 与库内一致", near(q.open, n(r.open), 1e-6), `quote=${q.open} db=${n(r.open)}`);
      check("lastPrice 与库内 close 一致", near(q.lastPrice, n(r.close), 1e-6), `quote=${q.lastPrice} db=${n(r.close)}`);
    }
  }

  console.log("\n" + "=".repeat(64));
  console.log(`通过 ${passed} / 失败 ${failed}`);
  if (failures.length > 0) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log("=".repeat(64));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("ERR", e);
    await prisma.$disconnect();
    process.exit(1);
  });
