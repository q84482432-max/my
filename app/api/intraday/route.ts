import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import {
  BARS_PER_DAY,
  INTRADAY_AXIS_TIMES,
  INTRADAY_OPEN_ANCHOR,
  clipBarsToCount,
  computeDailyUnitFactors,
  contaminatedDatesOf,
  getIntradayBars,
  getIntradayCoverage,
  getIntradayDays,
  isContaminated,
  type IntradayBar,
} from "@/lib/intraday30m";
import { isCloseRevealed } from "@/lib/simtradeStage";
import {
  getKlineAt,
  getPrevKlineBefore,
  listDailyDatesForCode,
} from "@/services/marketDataService";
import type { AdjustType, SimTradeIntradayTick, SimTradeStage } from "@/types";

export const dynamic = "force-dynamic";

/**
 * /api/intraday —— 30 分钟 K 线读取接口（Parquet 离线数据集）
 *
 * 三种用法：
 *
 *  1. 单日：`GET /api/intraday?code=600036&date=2026-09-21`
 *  2. 区间：`GET /api/intraday?code=600036&from=2026-09-01&to=2026-09-21`
 *     —— 区间模式下**默认剔除**被污染日期（阶段 6 标记生效）；`&includeContaminated=1` 可显式包含。
 *  3. 会话（防泄漏）：`GET /api/intraday?sessionId=<id>`
 *     —— 返回该会话**当前模拟日**的 30m K，上界锁死在 `currentDate`；
 *        当日是否揭示全部 8 根由服务端阶段决定，**客户端不可干预**；
 *        **不返回标的代码/名称**（沿用 SIMTRADE 的身份隐藏红线）。
 *
 * 标的范围：`code` 模式必须先命中 `dev.db.stocks`（30m 数据只对数据库内已有标的存在）。
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    const codeParam = (url.searchParams.get("code") ?? "").trim();
    const date = (url.searchParams.get("date") ?? "").trim();
    const from = (url.searchParams.get("from") ?? "").trim();
    const to = (url.searchParams.get("to") ?? "").trim();
    const includeContaminated =
      url.searchParams.get("includeContaminated") === "1";

    /* ---------------- 模式 3：会话（防泄漏） ---------------- */
    if (sessionId) {
      const row = await prisma.simTradeSession.findUnique({
        where: { id: sessionId },
        select: {
          // 只取本接口真正用到的列。
          // 2026-09-22 审计：`status` / `revealed` 曾被 select 但从未被读取，
          // 属于无用查询字段（`revealed` 还容易让人误以为本接口会下发身份信息）。
          hiddenStockCode: true,
          currentDate: true,
          stage: true,
          // V3：30m 游标 —— 可见根数的**唯一**依据
          intradayBarCount: true,
          // V3 分时图：前收取数需要与个股同口径，故一并取出
          adjust: true,
        },
      });
      if (!row) {
        return NextResponse.json(
          { success: false, message: "会话不存在" },
          { status: 404 },
        );
      }

      const code = row.hiddenStockCode;
      const currentDate = row.currentDate.toISOString().slice(0, 10);
      const stage = row.stage as SimTradeStage;
      const revealClose = isCloseRevealed(stage);
      /**
       * V3：可见根数由 **30m 游标**决定（唯一来源），不再用「阶段布尔 → 1 根 or 8 根」。
       *  - 进入收盘揭示之后强制 8 根（与 `revealClose` 语义一致，也对历史会话收敛）；
       *  - 开盘阶段游标上限由服务层把控（最多 7 根），此处只做防御性夹取。
       */
      /*
       * ⚠️ 下界必须是 **0**，不能是 1（2026-09-25 修复）。
       *
       * 游标语义已改为「从 0 起算」：`0` = 刚开盘、一根完整 30m K 都还没走完
       * （只知开盘价）。此处若仍用 `Math.max(..., 1)` 兜底，会把 0 悄悄抬回 1，
       * 于是 `safeBars` 多出一根 10:00，分时图就多出一个点、
       * 把本不该存在的 09:30→10:00 曲线画了出来 —— 这正是用户反馈的
       * 「开盘就显示 10:00」。服务层（simtradeService）已同步改为 0，
       * 两处必须一致，否则视图与快照的游标口径会分叉。
       */
      const revealedCount = revealClose
        ? BARS_PER_DAY
        : Math.min(Math.max(row.intradayBarCount, 0), BARS_PER_DAY);

      const rawBars = await getIntradayBars(code, currentDate);
      const bars = clipBarsToCount(rawBars, revealedCount);

      // 被污染日期不得进入任何消费路径：即使该日恰为 currentDate，也只返回空
      const contaminated = isContaminated(code, currentDate);
      const safeBars = contaminated ? [] : bars;

      /* ---------- V3 分时图契约：前收 / 分时点 / 横轴 ---------- */

      // 分时图 0 轴基准 = **严格早于当前日**的最后一根日K收盘价。
      // 必须用 `lt` 语义（getPrevKlineBefore）—— 用 `lte` 会取回当日自己，涨跌幅恒为 0。
      const adjustRaw = row.adjust;
      const adjust: AdjustType | undefined =
        adjustRaw === "qfq" || adjustRaw === "hfq" || adjustRaw === "none"
          ? adjustRaw
          : undefined;
      const prevBar = await getPrevKlineBefore(code, currentDate, adjust);
      const prevClose = prevBar ? Math.round(prevBar.close * 100) / 100 : null;

      const pct = (price: number): number | null =>
        prevClose && prevClose > 0
          ? Math.round(((price - prevClose) / prevClose) * 10000) / 100
          : null;

      /**
       * 量纲换算：30m volume 以「股」计、日K volume 以「手」计（实测比值 1~100，非恒定）。
       * 分时图的成交量必须与日K 图同口径，否则两处展示的「今日成交量」会差约 100 倍。
       */
      const dailyBar = await getKlineAt(code, currentDate, adjust);
      const factors = computeDailyUnitFactors({
        dailyVolume: dailyBar?.volume ?? 0,
        dailyAmount: dailyBar?.amount ?? 0,
        fullDay30mVolume: rawBars.reduce((s, b) => s + b.volume, 0),
        fullDay30mAmount: rawBars.reduce((s, b) => s + b.amount, 0),
      });

      /**
       * 已揭示的分时点。
       *
       * 首点固定是 **09:30 开盘锚点**（价格 = 第 1 根 30m 的 open）——
       * 第 1 根 30m K 覆盖 09:30~10:00，其 open 就是 09:30 的真实成交价，
       * 不是补造数据。其余点依次为各已揭示根的收盘时点 + 收盘价。
       *
       * 因此 `ticks.length === safeBars.length + 1`（无数据时为 0）。
       * 未揭示的时点**根本不存在于本数组** —— 这是分时图的防泄漏边界。
       */
      const ticks: SimTradeIntradayTick[] = safeBars.map((b) => ({
        time: b.time.slice(0, 5),
        price: Math.round(b.close * 100) / 100,
        changePercent: pct(b.close),
        volume: Math.round(b.volume * factors.volumeFactor),
      }));
      /*
       * 开盘锚点（09:30）：**只要当日有可用的 30m 数据就必须给出**，
       * 哪怕一根都还没揭示（游标 0）。
       *
       * 游标 0 = 刚开盘，此时玩家唯一可见的当日价格就是开盘价 ——
       * 也就是第 1 根 30m K 的 `open`（该根覆盖 09:30~10:00）。
       * 若这里用 `safeBars.length > 0` 作条件，游标 0 时 ticks 会是空数组，
       * 分时图退化成「当日暂无分时数据」空态，玩家反而看不到开盘价落在哪。
       *
       * 防泄漏仍然成立：锚点只暴露**开盘价**（唯一允许提前揭示的当日价格），
       * 不含 10:00 及以后的任何信息；`barCount` 依旧如实为 0。
       */
      if (rawBars.length > 0 && !contaminated) {
        const anchor = rawBars[0];
        ticks.unshift({
          time: INTRADAY_OPEN_ANCHOR,
          price: Math.round(anchor.open * 100) / 100,
          changePercent: pct(anchor.open),
          volume: 0,
        });
      }

      /**
       * 已揭示部分的累计成交量（不含 09:30 锚点 —— 锚点没有成交量）。
       *
       * 已换算到日K 口径：第 8 根揭示时它恰好等于官方日K 成交量。
       */
      const cumVolume = Math.round(
        safeBars.reduce((s, b) => s + b.volume * factors.volumeFactor, 0),
      );
      const lastTick = ticks.length > 0 ? ticks[ticks.length - 1] : null;

      return NextResponse.json({
        success: true,
        data: {
          mode: "session",
          sessionId,
          date: currentDate,
          stage,
          /** 当日已揭示的 30m 根数（0 = 该日无 30m 数据或被标记排除） */
          barCount: safeBars.length,
          /** 标准根数，便于前端判断「当日 30m 数据是否可用」 */
          expectedBars: BARS_PER_DAY,
          revealClose,
          /** V3：服务端实际采用的 30m 可见根数（= 会话游标；收盘揭示后恒为 8） */
          intradayBarCount: revealedCount,
          /** 是否已揭示全部 8 根（等价于 revealClose） */
          fullDayRevealed: revealedCount >= BARS_PER_DAY,
          bars: safeBars,
          /** 是否因污染标记被排除 */
          excludedByContamination: contaminated,
          contaminatedDatesInSession: contaminatedDatesOf(code),
          /**
           * 30m 数据是否可用于本会话。为 false 时前端应回落到日K视图。
           * 不返回代码 —— 身份隐藏红线。
           */
          intradayAvailable: safeBars.length > 0,

          /* ---------------- V3 分时图字段 ---------------- */
          /** 分时图 0 轴 = 前一交易日收盘价（不是当日开盘） */
          prevClose,
          /** 已揭示分时点（09:30 锚点 + 各已揭示根收盘点） */
          ticks,
          /** 横轴完整刻度（09:30 + 8 个标准时点，共 9 个） */
          times: [...INTRADAY_AXIS_TIMES],
          /** 已揭示部分累计成交量 */
          cumVolume,
          /** 当前价 = 最后 1 个已揭示根的收盘价 */
          currentPrice: lastTick ? lastTick.price : null,
          /** 当前价相对前收的涨跌幅 % */
          currentChangePercent: lastTick ? lastTick.changePercent : null,
        },
      });
    }

    /* ---------------- 模式 1/2：按代码（需命中 dev.db） ---------------- */
    if (!codeParam) {
      return NextResponse.json(
        { success: false, message: "缺少参数：code 或 sessionId" },
        { status: 400 },
      );
    }

    const stock = await prisma.stock.findUnique({
      where: { code: codeParam },
      select: { code: true, name: true, exchange: true, adjust: true },
    });
    if (!stock) {
      // 30m 数据只覆盖 dev.db 已有个股范围 —— 不在库内的代码一律拒绝
      return NextResponse.json(
        { success: false, message: `标的不在数据库个股范围内：${codeParam}` },
        { status: 404 },
      );
    }

    const coverage = await getIntradayCoverage(codeParam);
    const allContaminated = contaminatedDatesOf(codeParam);

    /* --- 单日 --- */
    if (date) {
      const raw = await getIntradayBars(codeParam, date);
      const contaminated = isContaminated(codeParam, date);
      const bars = contaminated && !includeContaminated ? [] : raw;
      return NextResponse.json({
        success: true,
        data: {
          mode: "day",
          code: stock.code,
          name: stock.name,
          exchange: stock.exchange,
          adjust: stock.adjust,
          date,
          bars,
          barCount: bars.length,
          expectedBars: BARS_PER_DAY,
          contaminated,
          excludedByContamination: contaminated && !includeContaminated,
          coverage,
        },
      });
    }

    /* --- 区间 --- */
    if (from || to) {
      const lo = from || "0000-00-00";
      const hi = to || "9999-99-99";
      if (lo > hi) {
        return NextResponse.json(
          { success: false, message: "区间非法：from > to" },
          { status: 400 },
        );
      }
      // 该股在区间内**真实有日K**的交易日。
      // 2026-09-22 审计：此处原为 `prisma.$queryRawUnsafe` 直接 JOIN klines/stocks，
      // 绕过了 marketDataService「Kline/Stock 表唯一入口」的约定。现下沉到
      // `listDailyDatesForCode`（内部用 Prisma.sql 参数绑定，无字符串拼接）。
      const dates = await listDailyDatesForCode(codeParam, lo, hi);
      const days = await getIntradayDays(codeParam, dates);

      const excluded: string[] = [];
      const kept = days
        .map((d) => {
          const bad = allContaminated.includes(d.date);
          if (bad && !includeContaminated) {
            excluded.push(d.date);
            return null;
          }
          return { date: d.date, bars: d.bars, contaminated: bad };
        })
        .filter((x): x is { date: string; bars: IntradayBar[]; contaminated: boolean } => x !== null);

      return NextResponse.json({
        success: true,
        data: {
          mode: "range",
          code: stock.code,
          name: stock.name,
          exchange: stock.exchange,
          adjust: stock.adjust,
          from: lo,
          to: hi,
          days: kept,
          dayCount: kept.length,
          excludedByContamination: excluded,
          coverage,
        },
      });
    }

    return NextResponse.json(
      { success: false, message: "缺少参数：date 或 from/to" },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
