import { NextResponse } from "next/server";
import { ensureDefaultAccount, getTrades } from "@/services/tradingEngine";

export const dynamic = "force-dynamic";

/** GET /api/account/trades?stockCode=&limit= —— 成交记录 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const stockCode = searchParams.get("stockCode") ?? undefined;
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") ?? "100", 10) || 100, 1),
      500,
    );

    const accountId = await ensureDefaultAccount();
    const trades = await getTrades(accountId, { limit, stockCode });

    return NextResponse.json({ success: true, data: trades, count: trades.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
