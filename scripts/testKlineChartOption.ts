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

import {
  buildKlineOption,
  INDEX_LINE_COLOR,
  KLINE_UP_COLOR,
  KLINE_DOWN_COLOR,
} from "@/lib/klineChartOption";
import { getKlines, getStockInfoByCode } from "@/services/marketDataService";
import type { KlineBar } from "@/types";
import { CHART } from "@/lib/chartPalette";

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
    "tooltip 采用深底浅字（符合深色主题）",
    tooltip.backgroundColor === CHART.surface &&
      (tooltip.textStyle as Record<string, string>).color === CHART.textPrimary
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
  section('9. 折线形态（chartType="line"，模拟炒股页的大盘参照用）');

  const line = buildKlineOption({
    bars: daily,
    chartType: "line",
    seriesName: "上证指数",
    maPeriods: [5, 20],
  });
  const lSeries = asArray(line.series as unknown as Record<string, unknown>[]);
  const lMain = lSeries[0];
  const lLegend = ((line.legend as { data?: string[] })?.data ?? []).slice();

  check("主体系列为折线（不是 candlestick）", lMain?.type === "line", String(lMain?.type));
  check(
    "折线数据 = 收盘价序列（逐点对齐、非 OHLC 数组）",
    (lMain?.data as number[]).length === daily.length &&
      (lMain?.data as number[])[0] === daily[0].close &&
      typeof (lMain?.data as number[])[0] === "number",
    `${(lMain?.data as number[]).length} 点，首点 ${(lMain?.data as number[])[0]}`,
  );
  check(
    "折线使用中性蓝主线色（不与涨跌红绿混淆）",
    (lMain?.lineStyle as { color?: string })?.color === INDEX_LINE_COLOR,
  );
  check(
    "图例名取 seriesName（上证指数），不再是「K线」",
    lLegend[0] === "上证指数" && !lLegend.includes("K线"),
    lLegend.join(","),
  );
  check("折线形态仍保留均线", lLegend.includes("MA5") && lLegend.includes("MA20"), lLegend.join(","));
  check("折线形态仍保留成交量副图", lSeries.some((s) => s.name === "成交量" && s.type === "bar"));
  check("折线形态仍是双 grid（主图 + 量能）", asArray(line.grid as never).length === 2);
  check("折线形态 xAxis 仍为 2 条", asArray(line.xAxis as never).length === 2);
  check("折线形态 yAxis 仍为 2 条", asArray(line.yAxis as never).length === 2);
  const lZoom = asArray(line.dataZoom as never)[0] as { xAxisIndex?: number[] } | undefined;
  check(
    "dataZoom 仍同时作用于主轴与量能轴（联动不丢）",
    Array.isArray(lZoom?.xAxisIndex) &&
      lZoom?.xAxisIndex[0] === 0 &&
      lZoom?.xAxisIndex[1] === 1,
    JSON.stringify(lZoom?.xAxisIndex),
  );
  const cSeries = asArray(
    buildKlineOption({ bars: daily }).series as unknown as Record<string, unknown>[],
  );
  check("默认形态仍是 candlestick（未破坏既有行为）", cSeries[0]?.type === "candlestick");

  /* ============================================================ */
  section("10. 日内 30m：x 轴用时刻、均线可关闭（V3 阶段 2 新增）");

  // 同一个交易日的 8 根 30m 棒：date 相同、time 递增 —— 日内图的真实形状。
  // 这正是「x 轴若只取 date，8 根会塌成同一个类别」的复发场景。
  const INTRADAY_TIMES = [
    "10:00:00",
    "10:30:00",
    "11:00:00",
    "11:30:00",
    "13:30:00",
    "14:00:00",
    "14:30:00",
    "15:00:00",
  ];
  const intradayBars: KlineBar[] = INTRADAY_TIMES.map((t, i) => ({
    date: "2025-04-24",
    time: t,
    open: 10 + i,
    high: 10.5 + i,
    low: 9.5 + i,
    close: 10.2 + i,
    volume: 1000 * (i + 1),
    amount: 10000 * (i + 1),
  }));

  const intraday = buildKlineOption({
    bars: intradayBars,
    showVolume: true,
    maPeriods: [],
    xAxisMode: "time",
    zoomStart: 0,
    zoomEnd: 100,
  });
  const iAxes = asArray(intraday.xAxis as never);
  const iLabels = (iAxes[0] as { data?: string[] } | undefined)?.data ?? [];

  check(
    "xAxisMode='time' → x 轴为 8 个时刻",
    iLabels.length === 8 && iLabels[0] === "10:00" && iLabels[7] === "15:00",
    JSON.stringify(iLabels),
  );
  check(
    "x 轴标签互不相同（category 轴不会把 8 根折成 1 根）",
    new Set(iLabels).size === iLabels.length,
    `unique=${new Set(iLabels).size}`,
  );
  check(
    "量能副图 x 轴同样用时刻（主图/副图对齐）",
    JSON.stringify(
      (asArray(intraday.xAxis as never)[1] as { data?: string[] } | undefined)?.data,
    ) === JSON.stringify(iLabels),
  );
  const iCandle = asArray(intraday.series as never)[0] as {
    type?: string;
    data?: unknown[];
  };
  check(
    "蜡烛线仍为 8 根（未被裁剪）",
    iCandle?.type === "candlestick" && (iCandle.data ?? []).length === 8,
    `type=${iCandle?.type} n=${(iCandle.data ?? []).length}`,
  );

  // 默认行为不得被改变：不传 xAxisMode 时仍用交易日
  const defaultAxis = buildKlineOption({ bars: daily, showVolume: true });
  const dLabels =
    (asArray(defaultAxis.xAxis as never)[0] as { data?: string[] } | undefined)?.data ?? [];
  check(
    "不传 xAxisMode 时 x 轴仍为交易日（默认行为未变）",
    dLabels.length > 0 && dLabels.every((l) => /^\d{4}-\d{2}-\d{2}$/.test(l)),
    `首=${dLabels[0]} 末=${dLabels[dLabels.length - 1]}`,
  );

  // 均线开关：undefined = 默认 MA_CONFIG；[] = 完全不画
  const withMA = buildKlineOption({ bars: daily, showVolume: true });
  const withoutMA = buildKlineOption({ bars: daily, showVolume: true, maPeriods: [] });
  const maCount = (o: ReturnType<typeof buildKlineOption>) =>
    asArray(o.series as never).filter((s) =>
      /^MA\d+$/.test(String((s as { name?: string }).name ?? "")),
    ).length;
  const legendOf = (o: ReturnType<typeof buildKlineOption>) =>
    (o.legend as { data?: string[] } | undefined)?.data ?? [];

  check(
    "maPeriods=[] → 不生成任何 MA 系列（日内 8 根不再出现空均线）",
    maCount(withoutMA) === 0,
    `MA 系列=${maCount(withoutMA)}`,
  );
  check(
    "maPeriods=[] → 图例中也不再出现 MA 项",
    legendOf(withoutMA).every((l) => !/^MA\d+$/.test(l)),
    legendOf(withoutMA).join(","),
  );
  check(
    "不传 maPeriods → 仍生成默认 4 条均线（未破坏既有行为）",
    maCount(withMA) === 4,
    `MA 系列=${maCount(withMA)}`,
  );


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
