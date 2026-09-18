import { NextResponse } from "next/server";
import { revealSimTradeStock } from "@/services/simtradeService";

export const dynamic = "force-dynamic";

/**
 * POST /api/simtrade/:id/reveal —— 揭晓被隐藏的股票
 *
 * **唯一**会返回标的代码/名称的接口，且**仅允许在会话结束后**调用。
 * 会话进行中一律拒绝，防止玩家中途揭晓后照抄未来行情。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await revealSimTradeStock(id);
    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
