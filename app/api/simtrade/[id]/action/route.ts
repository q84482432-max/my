import { NextResponse } from "next/server";
import { submitSimTradeAction } from "@/services/simtradeService";
import type { SimTradeAction } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/simtrade/:id/action —— 提交并确认「今日操作」（收盘结算）
 *
 * body: { action: "BUY" | "SELL" | "HOLD", percent?: number }
 *
 * 关键防泄漏点：**成交日 & 行情可见上界由服务端强制为会话 currentDate**，
 * 客户端无法传入任何日期。成交价 = 当日收盘价。
 *
 * 两阶段闭环（本接口为第 1 阶段）：
 *  选择操作 → 本接口按当日收盘价成交 + 刷新资产 + 标记「今日已确认」（**不推进日期**），
 *  返回今日收盘结算快照；玩家看到结果后，再调用 `/next` 进入下一交易日。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      action?: SimTradeAction;
      percent?: number;
    };

    if (body.action !== "BUY" && body.action !== "SELL" && body.action !== "HOLD") {
      return NextResponse.json(
        { success: false, message: "操作类型必须为 BUY / SELL / HOLD" },
        { status: 400 },
      );
    }

    const result = await submitSimTradeAction(id, {
      action: body.action,
      percent: body.percent,
    });

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
