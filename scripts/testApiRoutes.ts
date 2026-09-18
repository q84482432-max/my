/**
 * API 与页面集成测试（需先启动服务）
 *
 * 覆盖：股票列表 API（分页/筛选/搜索）、行情字段完整性、复权口径正确性、
 *       日K/周K/月K 接口、市场概览全市场覆盖、页面 SSR 输出。
 *
 * 运行：
 *   npm run build && npx next start -p 3111     # 另开终端
 *   npm run test:api                            # 默认 http://127.0.0.1:3111
 *   BASE_URL=http://127.0.0.1:3000 npm run test:api
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3111";
let pass = 0;
let fail = 0;
const bad: string[] = [];

function ck(n: string, c: boolean, d?: string): void {
  if (c) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? "  " + d : ""}`);
  } else {
    fail++;
    bad.push(n);
    console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? "  " + d : ""}`);
  }
}

async function get(p: string): Promise<any> {
  const r = await fetch(BASE + p);
  return r.json();
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1mAPI 集成测试\x1b[0m  \x1b[90m${BASE}\x1b[0m`);

  try {
    await fetch(BASE + "/api/market?limit=1");
  } catch {
    console.error(
      `\n\x1b[31m无法连接 ${BASE}。请先启动服务：\x1b[0m\n` +
        `  npm run build && npx next start -p 3111\n`
    );
    process.exit(1);
  }

  console.log("\n\x1b[1m列表 API\x1b[0m");
  const l = await get("/api/stocks?page=1&pageSize=5&withQuote=true");
  ck("success", l.success === true);
  ck("返回 5 条", l.data.length === 5, String(l.data.length));
  ck("total = 5558", l.total === 5558, `total=${l.total}`);
  ck("totalPages 正确", l.totalPages === Math.ceil(5558 / 5), String(l.totalPages));
  const r0 = l.data[0];
  ck("含 amount 字段", typeof r0.amount === "number" && r0.amount > 0, `amount=${r0.amount.toFixed(0)}`);
  ck("含 prevClose 字段", typeof r0.prevClose === "number" && r0.prevClose > 0, `prevClose=${r0.prevClose}`);
  ck("含 volume 字段", typeof r0.volume === "number" && r0.volume > 0, `volume=${r0.volume}`);
  ck(
    "涨跌幅与 prevClose 自洽",
    Math.abs(((r0.lastPrice - r0.prevClose) / r0.prevClose) * 100 - r0.changePercent) < 1e-9,
  );

  console.log("\n\x1b[1m口径修复验证（raw 股票行情不得为 0）\x1b[0m");
  for (const code of ["920047", "688981", "301292"]) {
    const q = await get(`/api/stocks?keyword=${code}&withQuote=true`);
    const d = q.data && q.data[0];
    ck(
      `${code} 行情非 0`,
      !!d && d.lastPrice > 0,
      d ? `${d.name} 价=${d.lastPrice} 口径=${d.adjust} 额=${d.amount.toFixed(0)}` : "无数据",
    );
  }

  console.log("\n\x1b[1m板块筛选\x1b[0m");
  ck("GEM total=1407", (await get("/api/stocks?board=GEM&pageSize=3")).total === 1407);
  ck("BSE total=343", (await get("/api/stocks?board=BSE&pageSize=3")).total === 343);
  ck("MAIN total=3192", (await get("/api/stocks?board=MAIN&pageSize=3")).total === 3192);
  ck("SH total=2316", (await get("/api/stocks?exchange=SH&pageSize=3")).total === 2316);
  ck("MAIN+SZ total=1492（深主板）", (await get("/api/stocks?board=MAIN&exchange=SZ&pageSize=3")).total === 1492);
  ck("MAIN+SH total=1700（沪主板）", (await get("/api/stocks?board=MAIN&exchange=SH&pageSize=3")).total === 1700);

  console.log("\n\x1b[1mK线 API（日/周/月）\x1b[0m");
  const periods: [string, string][] = [
    ["1d", "日K"],
    ["1w", "周K"],
    ["1M", "月K"],
  ];
  for (const [p, label] of periods) {
    const k = await get(`/api/stocks/600519/klines?period=${p}&adjust=qfq&limit=5000`);
    const dates = k.data.map((x: any) => x.date);
    const asc = dates.every((d: string, i: number) => i === 0 || d > dates[i - 1]);
    ck(
      `${label} 返回有效且升序`,
      k.success && k.data.length > 0 && asc,
      `${k.data.length} 根 ${dates[0]}→${dates[dates.length - 1]}`,
    );
  }
  const wk = await get("/api/stocks/600519/klines?period=1w&adjust=qfq&limit=5000");
  const dy = await get("/api/stocks/600519/klines?period=1d&adjust=qfq&limit=5000");
  ck("周K 根数 < 日K 根数", wk.data.length < dy.data.length, `周${wk.data.length} < 日${dy.data.length}`);
  const sumD = dy.data.reduce((a: number, x: any) => a + x.volume, 0);
  const sumW = wk.data.reduce((a: number, x: any) => a + x.volume, 0);
  ck("日K量总和 = 周K量总和", sumD === sumW, `${sumD} vs ${sumW}`);

  console.log("\n\x1b[1m市场概览（全市场覆盖）\x1b[0m");
  const mk = await get("/api/market?limit=20");
  ck("success", mk.success === true);
  ck("stockCount=5558", mk.stats.stockCount === 5558, String(mk.stats.stockCount));
  ck("榜单 20 条", mk.active.length === 20, String(mk.active.length));
  const prefixes = new Set(mk.active.map((x: any) => x.code.slice(0, 3)));
  ck(
    "榜单不只含 000 段（全市场覆盖）",
    prefixes.size > 1,
    mk.active.slice(0, 5).map((x: any) => x.code).join(","),
  );
  ck("榜单含 amount", mk.active.every((x: any) => x.amount > 0));
  const amts = mk.active.map((x: any) => x.amount);
  ck("按成交额降序", amts.every((v: number, i: number) => i === 0 || v <= amts[i - 1]));

  console.log("\n\x1b[1mHTML 渲染检查\x1b[0m");
  const html = await (await fetch(BASE + "/stocks")).text();
  ck("/stocks 含「股票列表」标题", html.includes("股票列表"));
  ck("/stocks 含「成交额」列头", html.includes("成交额"));
  ck("/stocks 含「成交量」列头", html.includes("成交量"));
  ck("/stocks 含分页控件", html.includes("下一页"));
  const det = await (await fetch(BASE + "/stocks/600519")).text();
  ck("详情页含成交额", det.includes("成交额"));
  ck("详情页不再出现写死的「复权口径：不复权」", !det.includes("复权口径：不复权"));
  ck("详情页显示前复权", det.includes("前复权"));
  // 注意：ECharts 图例（MA5/MA60）由 canvas 在浏览器端绘制，
  // SSR 的 HTML 中不存在该文本；均线口径由 testIndicators.ts 单测覆盖。
  ck("详情页含周期切换（日K/周K/月K）", det.includes("日K") && det.includes("周K") && det.includes("月K"));
  ck("详情页初始日K数据已下发到客户端", det.includes("2025-08-25"));
  ck("详情页说明周月K由日K聚合", det.includes("由日K实时聚合") || det.includes("聚合"));

  console.log("\n" + "=".repeat(60));
  console.log(
    fail === 0
      ? `\x1b[32m✔ 全部通过：${pass}/${pass + fail}\x1b[0m`
      : `\x1b[31m✗ 失败 ${fail}/${pass + fail}: ${bad.join(" | ")}\x1b[0m`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main();
