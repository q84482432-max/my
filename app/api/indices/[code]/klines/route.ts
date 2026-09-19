import { NextResponse } from "next/server";
import { getIndexInfo, getIndexKlines } from "@/services/indexDataService";

export const dynamic = "force-dynamic";

/**
 * GET /api/indices/:code/klines
 *
 * 指数日K。`code` 必须带交易所前缀（sh000001），不带前缀一律 400 ——
 * 裸 6 位码在 A 股会与个股撞车（000001 = 平安银行），
 * 这里不做「自动补前缀」的猜测，宁可报错也不返回错数据。
 *
 * 查询参数：
 *   startDate  YYYY-MM-DD（闭区间）
 *   endDate    YYYY-MM-DD（闭区间）
 *   limit      条数上限，默认 5000
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await params;
    const { searchParams } = new URL(request.url);

    const info = await getIndexInfo(code);
    if (!info) {
      return NextResponse.json(
        {
          success: false,
          message: `未找到指数 ${code}。注意代码必须带交易所前缀，如 sh000001 / sz399001 / bj899050`,
        },
        { status: 404 },
      );
    }

    const limitParam = parseInt(searchParams.get("limit") ?? "5000", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 5000, 1), 6000);

    const bars = await getIndexKlines(code, {
      startDate: searchParams.get("startDate") ?? undefined,
      endDate: searchParams.get("endDate") ?? undefined,
      limit,
    });

    return NextResponse.json({
      success: true,
      index: info,
      count: bars.length,
      bars,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
