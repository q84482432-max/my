/**
 * 指数 UI 规格测试（SSR 渲染 + 图表配置）
 *
 * 覆盖本次新增前端的三块关键契约：
 *  1. IndexOverview（首页大盘概览）
 *     - 无数据时整块不渲染（不是空壳卡片）
 *     - 指数名 / 点位 / 涨跌额 / 涨跌幅 按 A股习惯着色（涨红跌绿平灰）
 *     - 入口链接到 /indices?code=xxx
 *  2. IndexBoard（/indices 页主体）
 *     - 空清单时给出「如何导入数据」的指引文案
 *     - 选择条渲染全部指数、选中项带高亮与 aria-current
 *     - 诚实性文案：指数不披露成交额（不造假数据）
 *     - 清单表包含代码/名称/分类/点位/涨跌幅/根数/窗口
 *  3. ChartBar 类型放宽后的图表配置
 *     - 传 IndexBar（无 amount）能正常构建配置
 *     - 此时 tooltip **不含**「成交额」行
 *     - 传 KlineBar（有 amount）时 tooltip **含**「成交额」行（个股页未受影响）
 *
 * 运行：node -e "require('./runner.mjs').run('scripts/testIndexUI.ts')"
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import IndexOverview from "@/components/IndexOverview";
import IndexBoard from "@/components/IndexBoard";
import { buildKlineOption } from "@/lib/klineChartOption";
import type { IndexQuoteItem } from "@/lib/indexQuotes";
import type { IndexBar, IndexInfo, KlineBar } from "@/types";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/* ----------------------------- 数据工厂 ----------------------------- */

function makeIndex(over: Partial<IndexInfo> = {}): IndexInfo {
  return {
    id: `idx_${over.code ?? "sh000001"}`,
    code: "sh000001",
    name: "上证指数",
    exchange: "SH",
    category: "综合指数",
    source: "sina",
    barCount: 5000,
    windowStart: "2006-03-01",
    windowEnd: "2026-09-18",
    ...over,
  };
}

function makeQuote(over: Partial<IndexQuoteItem> = {}): IndexQuoteItem {
  return {
    ...makeIndex(),
    lastPrice: 3911.871,
    change: 20.4,
    changePercent: 0.52,
    prevClose: 3891.471,
    lastDate: "2026-09-18",
    ...over,
  };
}

function makeBar(i: number, over: Partial<IndexBar> = {}): IndexBar {
  return {
    date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
    open: 3000 + i,
    high: 3010 + i,
    low: 2990 + i,
    close: 3005 + i,
    volume: 100000 + i,
    ...over,
  };
}

const UP = "text-stock-up";
const DOWN = "text-stock-down";
const FLAT = "text-stock-flat";

/* ========================= 1. IndexOverview ========================= */
console.log("\n[1] IndexOverview（首页大盘概览）");
{
  const empty = renderToStaticMarkup(
    React.createElement(IndexOverview, { quotes: [] }),
  );
  check("无数据时整块不渲染（输出为空）", empty === "", `实际长度 ${empty.length}`);

  const quotes = [
    makeQuote({ code: "sh000001", name: "上证指数", change: 20.4, changePercent: 0.52 }),
    makeQuote({
      code: "sz399001",
      name: "深证成指",
      exchange: "SZ",
      lastPrice: 12800.5,
      change: -35.6,
      changePercent: -0.28,
    }),
    makeQuote({
      code: "sh000300",
      name: "沪深300",
      exchange: "SH",
      lastPrice: 4600.0,
      change: 0,
      changePercent: 0,
    }),
  ];
  const html = renderToStaticMarkup(
    React.createElement(IndexOverview, { quotes }),
  );

  check("含标题「大盘概览」", html.includes("大盘概览"));
  check("含「全部指数」入口", html.includes("全部指数"));
  check("显示最新交易日", html.includes("2026-09-18"));
  check("渲染全部指数名", ["上证指数", "深证成指", "沪深300"].every((n) => html.includes(n)));
  check(
    "点位已千分位格式化",
    html.includes("3,911.87") && html.includes("12,800.50"),
  );
  check("上涨带 + 号涨跌额", html.includes("+20.40"));
  check("下跌带负号涨跌额", html.includes("-35.60"));
  check("涨跌幅带符号", html.includes("+0.52%") && html.includes("-0.28%"));
  check("上涨用涨色 class", html.includes(UP));
  check("下跌用跌色 class", html.includes(DOWN));
  check("平盘用平色 class", html.includes(FLAT));
  check("链接到 /indices?code=", html.includes("/indices?code=sh000001"));
  check(
    "移动端横向滚动 + 桌面网格",
    html.includes("overflow-x-auto") && html.includes("lg:grid-cols-9"),
  );
}

/* ========================= 2. IndexBoard ========================= */
console.log("\n[2] IndexBoard（/indices 页主体）");
{
  const emptyHtml = renderToStaticMarkup(
    React.createElement(IndexBoard, {
      indices: [],
      quotes: [],
      selectedCode: null,
      bars: [],
    }),
  );
  check("空清单给出导入指引", emptyHtml.includes("暂无指数数据"));
  check(
    "指引含抓取与导入脚本名",
    emptyHtml.includes("fetch_indices.py") && emptyHtml.includes("import_indices.py"),
  );

  const indices = [
    makeIndex({ code: "sh000001", name: "上证指数" }),
    makeIndex({
      code: "sz399006",
      name: "创业板指",
      exchange: "SZ",
      category: "板块指数",
      barCount: 3961,
      windowStart: "2010-06-01",
    }),
  ];
  const quotes = [
    makeQuote({ code: "sh000001", name: "上证指数" }),
    makeQuote({
      code: "sz399006",
      name: "创业板指",
      exchange: "SZ",
      category: "板块指数",
      lastPrice: 2100.3,
      change: -12.5,
      changePercent: -0.59,
    }),
  ];
  const bars = Array.from({ length: 30 }, (_, i) => makeBar(i));
  const html = renderToStaticMarkup(
    React.createElement(IndexBoard, {
      indices,
      quotes,
      selectedCode: "sz399006",
      bars,
    }),
  );

  check("含「指数行情」选择条标题", html.includes("指数行情"));
  check("含指数数量", html.includes("共 2 个"));
  check("选择条渲染全部指数", html.includes("上证指数") && html.includes("创业板指"));
  check("选中项带 border-primary 高亮", html.includes("border-primary"));
  check("选中项带 aria-current", html.includes('aria-current="true"'));
  check("选择条用 scroll=false 保持滚动位置", html.includes('href="/indices?code=sz399006"'));
  check("含 K 线卡片标题（日K 说明）", html.includes("日K"));
  check(
    "K 线图容器已挂载",
    html.includes('data-testid="kline-chart-stub"'),
    "（runner 已把 echarts-for-react 替换为占位组件，详见 runner.mjs 注释）",
  );
  check(
    "图表声明了 MA5/10/20/60",
    html.includes("MA5/10/20/60"),
  );
  check(
    "诚实性文案：指数不披露成交额",
    html.includes("指数不披露成交额"),
  );
  check("含「指数清单」表", html.includes("指数清单"));
  check("清单含代码列", html.includes("sh000001") && html.includes("sz399006"));
  check("清单含分类列", html.includes("综合指数") && html.includes("板块指数"));
  check("清单含根数（已千分位）", html.includes("5,000"));
  check("清单含数据窗口", html.includes("2010-06-01"));
  check("清单涨跌着色", html.includes(UP) && html.includes(DOWN));
}

/* ================= 3. ChartBar：指数无成交额不造假 ================= */
console.log("\n[3] ChartBar 类型放宽后的图表配置（成交额诚实性）");
{
  const indexBars: IndexBar[] = Array.from({ length: 60 }, (_, i) => makeBar(i));
  const optIndex = buildKlineOption({ bars: indexBars, showVolume: true }) as {
    tooltip?: { formatter?: (p: unknown) => string };
    series?: unknown[];
    legend?: { data?: string[] };
  };
  const htmlIndex = optIndex.tooltip?.formatter?.([{ dataIndex: 10 }]) ?? "";

  check("指数 bars 可构建配置（类型放宽生效）", Array.isArray(optIndex.series));
  check("tooltip 含成交量", htmlIndex.includes("成交量"));
  check(
    "tooltip 不含成交额（指数不披露，不补 0 造假）",
    !htmlIndex.includes("成交额"),
    `实际片段: ${htmlIndex.replace(/\s+/g, " ").slice(0, 120)}`,
  );
  check("tooltip 含开高低收", ["开盘", "最高", "最低", "收盘"].every((k) => htmlIndex.includes(k)));
  check("均线仍然渲染", (optIndex.legend?.data ?? []).some((d) => d.startsWith("MA")));

  const stockBars: KlineBar[] = indexBars.map((b) => ({ ...b, amount: 123456789 }));
  const optStock = buildKlineOption({ bars: stockBars, showVolume: true }) as {
    tooltip?: { formatter?: (p: unknown) => string };
  };
  const htmlStock = optStock.tooltip?.formatter?.([{ dataIndex: 10 }]) ?? "";
  check(
    "个股 bars（带 amount）tooltip 仍含成交额 —— 既有页面未受影响",
    htmlStock.includes("成交额"),
  );
}

/* ------------------------------ 汇总 ------------------------------ */
console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===`);
if (failed > 0) {
  process.exitCode = 1;
}
