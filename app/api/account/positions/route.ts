import { NextResponse } from "next/server";
import { ensureDefaultAccount, getPositions } from "@/services/tradingEngine";

export const dynamic = "force-dynamic";

/** GET /api/account/positions —— 持仓列表（市值按最新真实收盘价计算） */
export async function GET() {
  try {
    const accountId = await ensureDefaultAccount();
    const positions = await getPositions(accountId);
    return NextResponse.json({
      success: true,
      data: positions,
      count: positions.length,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
