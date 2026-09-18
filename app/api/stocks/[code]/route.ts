import { NextResponse } from "next/server";
import {
  getStockInfo,
  getStockQuote,
  getKlineRange,
} from "@/services/marketDataService";

export const dynamic = "force-dynamic";

/**
 * GET /api/stocks/:code
 * 返回股票基础信息 + 最新行情 + 数据库内K线覆盖区间。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await params;
    const [info, quote, range] = await Promise.all([
      getStockInfo(code),
      getStockQuote(code),
      getKlineRange(code),
    ]);

    if (!info) {
      return NextResponse.json(
        { success: false, message: `未找到股票 ${code}` },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: { info, quote, range } });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
