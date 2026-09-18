import { NextResponse } from "next/server";
import { getKlines } from "@/services/marketDataService";
import { DEFAULT_ADJUST } from "@/lib/constants";
import type { AdjustType, KlinePeriod } from "@/types";

export const dynamic = "force-dynamic";

const VALID_PERIODS: KlinePeriod[] = ["1d", "1w", "1M"];
const VALID_ADJUST: AdjustType[] = ["qfq", "hfq", "none"];

/**
 * GET /api/stocks/:code/klines?period=1d&adjust=qfq&start=&end=&limit=1000
 *
 * K线数据接口。周K/月K 由日K 实时聚合（在 marketDataService 内完成）。
 * 数据全部来自数据库中的**真实历史数据**，不做任何生成。
 *
 * 复权口径说明：真实数据以**前复权（qfq）**为主（5430/5558 只），
 * 另有 128 只为不复权（none）；两者以 adjust 字段隔离存储。
 * 因此默认 adjust=qfq；调用方也可显式传 none 查询不复权标的。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await params;
    const { searchParams } = new URL(request.url);

    const periodParam = (searchParams.get("period") ?? "1d") as KlinePeriod;
    const adjustParam = (searchParams.get("adjust") ?? DEFAULT_ADJUST) as AdjustType;

    const period = VALID_PERIODS.includes(periodParam) ? periodParam : "1d";
    const adjust = VALID_ADJUST.includes(adjustParam) ? adjustParam : DEFAULT_ADJUST;
    const startDate = searchParams.get("start") ?? undefined;
    const endDate = searchParams.get("end") ?? undefined;
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") ?? "1000", 10) || 1000, 1),
      5000,
    );

    const bars = await getKlines(code, {
      period,
      adjust,
      startDate,
      endDate,
      limit,
    });

    return NextResponse.json({
      success: true,
      data: bars,
      count: bars.length,
      period,
      adjust,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
