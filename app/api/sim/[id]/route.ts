import { NextResponse } from "next/server";
import { deleteSimulation, getSimulationSnapshot } from "@/services/simulationService";

export const dynamic = "force-dynamic";

/**
 * GET /api/sim/:id —— 会话全量快照
 *
 * 返回账户汇总 / 持仓 / 委托 / 成交 / 每日资产曲线 / 绩效指标，
 * **全部以会话的 currentDate 为上界**计算；接口不接受任何日期参数，
 * 因此调用方无法通过请求读取未来行情。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const snapshot = await getSimulationSnapshot(id);
    if (!snapshot) {
      return NextResponse.json(
        { success: false, message: "模拟会话不存在" },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: snapshot });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}

/** DELETE /api/sim/:id —— 删除会话（级联清空其独占账户与全部交易数据） */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await deleteSimulation(id);
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
