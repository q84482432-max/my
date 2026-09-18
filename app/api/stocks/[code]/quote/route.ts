import { NextResponse } from "next/server";
import { getStockQuote } from "@/services/marketDataService";

export const dynamic = "force-dynamic";

/** GET /api/stocks/:code/quote —— 最新行情（最新收盘价 + 涨跌幅） */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await params;
    const quote = await getStockQuote(code);
    if (!quote) {
      return NextResponse.json(
        { success: false, message: `未找到股票 ${code} 的行情` },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: quote });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
