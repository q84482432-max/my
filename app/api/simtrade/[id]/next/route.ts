import { NextResponse } from "next/server";
import { advanceSimTradeDay } from "@/services/simtradeService";

export const dynamic = "force-dynamic";

/**
 * POST /api/simtrade/:id/next —— 进入下一交易日（收盘结算后推进）
 *
 * 两阶段闭环（本接口为第 2 阶段）：
 *  前置：今日必须已通过 `/action` 确认操作（confirmedToday=true），否则拒绝。
 *  执行：T+1 结算（昨日买入解冻可卖）→ 推进 currentDate（行情可见上界前移）
 *       → 清空确认标记 → 刷新资产快照；已到日历末尾则标记 FINISHED。
 *
 * 防泄漏：新交易日的行情上界由服务端按固化的真实交易日历推导，客户端无法干预。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await advanceSimTradeDay(id);
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
