import { NextResponse } from "next/server";
import { deleteBacktest, getBacktestById } from "@/services/backtestService";

export const dynamic = "force-dynamic";

/**
 * GET /api/backtest/:id —— 回测详情
 *
 * 返回完整结果：指标 / 资金曲线 / 回撤曲线 / 买卖点 / 交易明细 /
 * 事件日志 / 日K（现取，用于 K 线标注）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const detail = await getBacktestById(id);
    if (!detail) {
      return NextResponse.json(
        { success: false, message: "回测记录不存在" },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: detail });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}

/** DELETE /api/backtest/:id —— 删除回测记录 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await deleteBacktest(id);
    if (!result.success) {
      return NextResponse.json(result, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
