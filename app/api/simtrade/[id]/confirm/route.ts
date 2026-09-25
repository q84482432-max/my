import { NextResponse } from "next/server";
import {
  cancelSimTradeAction,
  confirmSimTradeAction,
} from "@/services/simtradeService";

export const dynamic = "force-dynamic";

/**
 * POST /api/simtrade/:id/confirm —— 确认并执行「待确认操作」（V3 确认模式）
 *
 * 链路：`POST /action {mode:"CONFIRM"}` 落 pending → **本接口** → 服务端重新校验 → 成交。
 *
 * 服务端在确认时会重新校验（客户端无法绕过任何一项）：
 *   - 会话仍为 `ACTIVE`；
 *   - pending 仍在（未被执行 / 未取消）；
 *   - **阶段未变**、**交易日未变**（跨阶段 / 跨日的 pending 一律作废）；
 *   - 之后交给与「立即模式」**完全相同**的执行路径，再校验总操作额度、买入/卖出
 *     配额、比例合法性、当日行情（停牌）、资金 / 持仓 / T+1，并由服务端决定**成交价**。
 *
 * 请求体不需要任何参数：要执行什么完全来自服务端落库的 pending。
 * 客户端**不能**传 action / percent / price —— 传了也不生效。
 *
 * 并发：pending 先被 CAS 取走，双击 confirm 只有一次能成交。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await confirmSimTradeAction(id);
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

/**
 * DELETE /api/simtrade/:id/confirm —— 取消待确认操作
 *
 * 取消**不消耗**任何操作次数与买卖配额；取消后可重新提交。
 * 没有待确认操作时返回 400（带有明确文案），而不是静默成功。
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await cancelSimTradeAction(id);
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
