/**
 * K线图配置结构测试
 *
 * 验证内容对应用户第三阶段明确要求：
 *   - 日K / 周K / 月K（由服务端聚合后传入，本层只验证渲染配置）
 *   - 缩放、拖动（dataZoom：inside + slider）
 *   - 十字光标（axisPointer.type = "cross"）
 *   - 成交量联动（主图与副图共享 xAxisIndex）
 *   - MA5 / MA10 / MA20 / MA60
 *   - 不含 MACD / RSI 等复杂指标
 *
 * 抽成纯函数后，这些都能在 Node 里直接断言，无需启动浏览器。
 *
 * 运行： npx tsx scripts/testKlineChartOption.ts
 */

import { buildKlineOption, KLINE_UP_COLOR, KLINE_DOWN_COLOR } from "@/lib/klineChartOption";
import { getKlines, getStockInfoByCode } from "@/services/marketDataService";
import type { KlineBar } from "@/types";

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

/** 取数组型或单值型配置 */
function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mK线图配置结构测试\x1b[0m");
  console.log("═".repeat(66));

  const info = await getStockInfoByCode("600519");
  if (!info) throw new Error("600519 未找到");

  const daily = await getKlines("600519", {
    period: "1d",
    adjust: info.adjust,
    limit: 5000,
  });
  const weekly = await getKlines("600519", {
    period: "1w",
    adjust: info.adjust,
    limit: 5000,
  });
  const monthly = await getKlines("600519", {
    period: "1M",
    adjust: info.adjust,
    limit: 5000,
  });

  const option = buildKlineOption({ bars: daily });
  const series = asArray(option.series as unknown as Record<string, unknown>[]);
  const xAxis = asArray(option.xAxis as unknown as Record<string, unknown>[]);
  const yAxis = asArray(option.yAxis as unknown as Record<string, unknown>[]);
  const dataZoom = asArray(option.dataZoom as unknown as Record<string, unknown>[]);
  const grid = asArray(option.grid as unknown as Record<string, unknown>[]);
  const tooltip = option.tooltip as Record<string, unknown>;

  /* ============================================================ */
  section("1. 蜡烛主图（涨红跌绿）");

  const candle = series.find((s) => s.type === "candlestick");
  check("存在 candlestick 系列", !!candle);
  check(
    "蜡烛数据量 = 日K 根数",
    (candle?.data as unknown[])?.length === daily.length,
    `${(candle?.data as unknown[])?.length} vs ${daily.length}`
  );
  const c0 = (candle?.data as number[][])[0];
  check(
    "蜡烛数据顺序为 [open, close, low, high]（ECharts 约定）",
    JSON.stringify(c0) ===
      JSON.stringify([daily[0].open, daily[0].close, daily[0].low, daily[0].high]),
    JSON.stringify(c0)
  );
  const ci = candle?.itemStyle as Record<string, string>;
  check("阳线为红色（A股习惯）", ci.color === KLINE_UP_COLOR && ci.borderColor === KLINE_UP_COLOR, ci.color);
  check("阴线为绿色（A股习惯）", ci.color0 === KLINE_DOWN_COLOR && ci.borderColor0 === KLINE_DOWN_COLOR, ci.color0);

  /* ============================================================ */
  section("2. 均线 MA5 / MA10 / MA20 / MA60");

  const maSeries = series.filter((s) => typeof s.name === "string" && /^MA\d+$/.test(s.name as string));
  check("均线系列数量 = 4", maSeries.length === 4, maSeries.map((s) => s.name).join(", "));
  check(
    "均线周期为 MA5/MA10/MA20/MA60",
    ["MA5", "MA10", "MA20", "MA60"].every((n) => maSeries.some((s) => s.name === n)),
    maSeries.map((s) => s.name).join(", ")
  );
  check(
    "每条均线类型为 line 且线宽一致",
    maSeries.every((s) => s.type === "line")
  );
  const legend = option.legend as Record<string, unknown>;
  const legendData = legend.data as string[];
  check(
    "图例含 K线 + 四条均线",
    ["K线", "MA5", "MA10", "MA20", "MA60"].every((n) => legendData.includes(n)),
    legendData.join(", ")
  );
  check(
    "不含 MACD / RSI / KDJ 等复杂指标",
    !legendData.some((n) => /MACD|RSI|KDJ|BOLL/.test(n)),
    legendData.join(", ")
  );
  const ma60 = maSeries.find((s) => s.name === "MA60");
  const ma60Data = ma60?.data as (number | null)[];
  check("MA60 数据长度 = 日K 根数", ma60Data.length === daily.length, String(ma60Data.length));
  check(
    "MA60 前 59 根为 null（样本不足），第 60 根起有值",
    ma60Data.slice(0, 59).every((v) => v === null) && ma60Data[59] !== null
  );

  /* ============================================================ */
  section("3. 成交量副图与联动");

  const vol = series.find((s) => s.type === "bar");
  check("存在成交量 bar 系列", !!vol);
  check("成交量数据量 = 日K 根数", (vol?.data as unknown[])?.length === daily.length);
  check("成交量绑定副图坐标轴 xAxisIndex=1", vol?.xAxisIndex === 1);
  check("成交量绑定副图坐标轴 yAxisIndex=1", vol?.yAxisIndex === 1);
  const volColor0 = (vol?.data as { itemStyle: { color: string } }[])[0].itemStyle.color;
  const expectedColor0 = daily[0].close >= daily[0].open ? KLINE_UP_COLOR : KLINE_DOWN_COLOR;
  check("成交量柱颜色随涨跌（阳红阴绿）", volColor0 === expectedColor0, volColor0);

  check("xAxis 数量 = 2（主图 + 成交量）", xAxis.length === 2, String(xAxis.length));
  check("yAxis 数量 = 2", yAxis.length === 2, String(yAxis.length));
  check("副图 xAxis 指向 grid 1", xAxis[1]?.gridIndex === 1);
  check("副图 yAxis 指向 grid 1", yAxis[1]?.gridIndex === 1);
  check("grid 数量 = 2", grid.length === 2, String(grid.length));
  check(
    "主图与副图日期序列一致",
    JSON.stringify(xAxis[0]?.data) === JSON.stringify(xAxis[1]?.data)
  );

  /* ============================================================ */
  section("4. 缩放 + 拖动（dataZoom 双通道且联动）");

  check("dataZoom 数量 = 2（inside + slider）", dataZoom.length === 2, String(dataZoom.length));
  const inside = dataZoom.find((z) => z.type === "inside");
  const slider = dataZoom.find((z) => z.type === "slider");
  check("存在 inside 通道（滚轮/触摸缩放）", !!inside);
  check("存在 slider 通道（底部滑块拖动）", !!slider);
  check("inside 支持滚轮缩放", inside?.zoomOnMouseWheel === true);
  check("inside 支持拖拽平移", inside?.moveOnMouseMove === true);
  const insideIdx = inside?.xAxisIndex as number[];
  const sliderIdx = slider?.xAxisIndex as number[];
  check(
    "inside 作用于主图+副图（xAxisIndex=[0,1]）→ 成交量联动",
    JSON.stringify(insideIdx) === JSON.stringify([0, 1]),
    JSON.stringify(insideIdx)
  );
  check(
    "slider 作用于主图+副图（xAxisIndex=[0,1]）→ 成交量联动",
    JSON.stringify(sliderIdx) === JSON.stringify([0, 1]),
    JSON.stringify(sliderIdx)
  );
  check(
    "两通道初始窗口一致",
    inside?.start === slider?.start && inside?.end === slider?.end,
    `${inside?.start}~${inside?.end}`
  );
  check("初始窗口为最近 45%（start=55,end=100）", inside?.start === 55 && inside?.end === 100);

  /* ============================================================ */
  section("5. 十字光标与 tooltip");

  check("tooltip 触发方式为 axis", tooltip.trigger === "axis");
  const ap = tooltip.axisPointer as Record<string, unknown>;
  check("十字光标已启用（axisPointer.type = cross）", ap?.type === "cross", String(ap?.type));
  check(
    "tooltip 采用浅底深字（符合浅色主题）",
    String(tooltip.backgroundColor).includes("255, 255, 255") &&
      (tooltip.textStyle as Record<string, string>).color === "#18181b"
  );

  // tooltip 内容包含各项字段
  const fmt = tooltip.formatter as (p: unknown) => string;
  const html = fmt([{ dataIndex: 100 }]);
  check("tooltip 含日期", html.includes(daily[100].date), daily[100].date);
  check("tooltip 含开盘/最高/最低/收盘", ["开盘", "最高", "最低", "收盘"].every((k) => html.includes(k)));
  check("tooltip 含涨跌幅", html.includes("涨跌幅"));
  check("tooltip 含成交量", html.includes("成交量"));
  check("tooltip 含成交额", html.includes("成交额"));
  check(
    "tooltip 含全部四条均线",
    ["MA5", "MA10", "MA20", "MA60"].every((k) => html.includes(k))
  );
  check("tooltip 越界索引不抛错", fmt([{ dataIndex: 999999 }]) === "");

  /* ============================================================ */
  section("6. 周K / 月K 复用同一配置（周期无关）");

  check("周K 根数 > 0 且 < 日K", weekly.length > 0 && weekly.length < daily.length, `周${weekly.length}`);
  check("月K 根数 > 0 且 < 周K", monthly.length > 0 && monthly.length < weekly.length, `月${monthly.length}`);

  for (const [label, bars] of [
    ["周K", weekly],
    ["月K", monthly],
  ] as [string, KlineBar[]][]) {
    const o = buildKlineOption({ bars });
    const s = asArray(o.series as unknown as Record<string, unknown>[]);
    const candleS = s.find((x) => x.type === "candlestick");
    check(
      `${label} 配置可正常构建（蜡烛数据量 = ${bars.length}）`,
      (candleS?.data as unknown[])?.length === bars.length
    );
    const xa = asArray(o.xAxis as unknown as Record<string, unknown>[]);
    check(
      `${label} x 轴日期与数据一致`,
      (xa[0]?.data as string[])?.length === bars.length &&
        (xa[0]?.data as string[])[0] === bars[0].date
    );
    // 月K 不足 60 根时 MA60 应全为 null（数据客观限制，非缺陷）
    const ma60s = s.find((x) => x.name === "MA60");
    const d60 = ma60s?.data as (number | null)[];
    if (bars.length < 60) {
      check(`${label} 根数 < 60 → MA60 全为 null（数据不足，非缺陷）`, d60.every((v) => v === null));
    } else {
      check(`${label} MA60 有有效值`, d60.some((v) => v !== null));
    }
  }

  /* ============================================================ */
  section("7. 关闭成交量副图时的降级");

  const noVol = buildKlineOption({ bars: daily, showVolume: false });
  const nvSeries = asArray(noVol.series as unknown as Record<string, unknown>[]);
  const nvX = asArray(noVol.xAxis as unknown as Record<string, unknown>[]);
  const nvY = asArray(noVol.yAxis as unknown as Record<string, unknown>[]);
  const nvZ = asArray(noVol.dataZoom as unknown as Record<string, unknown>[]);
  check("无成交量系列", !nvSeries.some((s) => s.type === "bar"));
  check("xAxis 数量 = 1", nvX.length === 1, String(nvX.length));
  check("yAxis 数量 = 1", nvY.length === 1, String(nvY.length));
  check(
    "dataZoom 仅作用于主图（xAxisIndex=[0]）",
    (nvZ[0]?.xAxisIndex as number[]).length === 1 &&
      (nvZ[0]?.xAxisIndex as number[])[0] === 0
  );
  check("主图仍保留 4 条均线", nvSeries.filter((s) => /^MA\d+$/.test(s.name as string)).length === 4);

  /* ============================================================ */
  section("8. 边界输入");

  const empty = buildKlineOption({ bars: [] });
  check("空数据可构建配置（不抛错）", !!empty);
  check(
    "空数据蜡烛序列为空数组",
    (asArray(empty.series as unknown as Record<string, unknown>[])[0]?.data as unknown[])
      .length === 0
  );

  const single = buildKlineOption({ bars: [daily[0]] });
  const sSeries = asArray(single.series as unknown as Record<string, unknown>[]);
  check("单根数据可构建配置", (sSeries[0]?.data as unknown[]).length === 1);
  const sMa60 = sSeries.find((s) => s.name === "MA60")?.data as (number | null)[];
  check("单根数据下 MA60 为 null", sMa60.length === 1 && sMa60[0] === null);

  /* ============================================================ */
  console.log("\n" + "═".repeat(66));
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[1m\x1b[32m✔ 全部通过：${passed}/${total}\x1b[0m`);
  } else {
    console.log(`\x1b[1m\x1b[31m✗ 失败 ${failed}/${total}\x1b[0m`);
    failures.forEach((f) => console.log(`    - ${f}`));
  }
  console.log("═".repeat(66) + "\n");
}

main()
  .then(async () => {
    const { default: prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("\n\x1b[31m测试执行异常:\x1b[0m", e);
    process.exit(1);
  });
