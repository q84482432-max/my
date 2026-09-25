import { NextResponse } from "next/server";
import { settleAndAdvanceToNextDay } from "@/services/simtradeService";

export const dynamic = "force-dynamic";

/**
 * POST /api/simtrade/:id/next-day —— **结算并进入下一交易日**（一次点击完成换日）
 *
 * 与 `/next` 的区别：
 *   - `/next` 是「每次走一格」的状态机（`CLOSE → DAY_SETTLED → 下一日`）；
 *   - 本接口是**原子合并操作**：从 `CLOSE` / `CLOSE_CONFIRMED` / `DAY_SETTLED` 出发，
 *     一路走到**下一交易日的 OPEN** 为止，并且**绝不越过新交易日的 OPEN**。
 *
 * 为什么需要它（防未来数据泄露）：
 *   前端若盲连两次 `/next`，在「另一个标签页已先走一格」的情形下，
 *   第二次调用会从新交易日的 `OPEN` 继续推进到 `CLOSE_ANIMATION`，
 *   等于**提前揭示新一天的收盘价**。服务端以「日期是否变化」为硬终止条件，可以精确避免这种情况。
 *
 * 拒绝的情形：当日尚未收盘（`OPEN` / `OPEN_CONFIRMED`）—— 必须先点击「看收盘」，
 * 否则等于跳过「公布收盘价」这一步，与既定流程不符。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await settleAndAdvanceToNextDay(id);
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
