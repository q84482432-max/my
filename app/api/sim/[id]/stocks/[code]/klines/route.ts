import { NextResponse } from "next/server";
import { getSimulationKlines } from "@/services/simulationService";
import type { KlinePeriod } from "@/types";

export const dynamic = "force-dynamic";

const VALID_PERIODS: KlinePeriod[] = ["1d", "1w", "1M"];

/**
 * GET /api/sim/:id/stocks/:code/klines?period=1d&limit=1000
 *
 * 模拟模式下的 K 线：**右端点由服务端强制为会话的 currentDate**，
 * 不接受任何 end / start 参数 —— 模拟日期为 2025-10-01 时绝不会返回
 * 2025-10-02 及以后的数据。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; code: string }> },
) {
  try {
    const { id, code } = await params;
    const { searchParams } = new URL(request.url);

    const periodParam = (searchParams.get("period") ?? "1d") as KlinePeriod;
    const period = VALID_PERIODS.includes(periodParam) ? periodParam : "1d";
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") ?? "1000", 10) || 1000, 1),
      5000,
    );

    const result = await getSimulationKlines(id, code, period, limit);
    if (!result) {
      return NextResponse.json(
        { success: false, message: "模拟会话不存在" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      success: true,
      currentDate: result.currentDate,
      data: result.bars,
      count: result.bars.length,
      period,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
