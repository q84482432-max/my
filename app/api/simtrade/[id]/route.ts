import { NextResponse } from "next/server";
import {
  deleteSimTradeSession,
  getSimTradeSnapshot,
} from "@/services/simtradeService";

export const dynamic = "force-dynamic";

/**
 * GET /api/simtrade/:id —— 会话全量快照
 *
 * 返回账户汇总 / 唯一持仓 / 可见历史K线（只到 currentDate） / 当日开盘价 /
 * 最近操作 / 资产曲线 / 绩效 / （已结束时）最终结算。
 *
 * **防泄漏**：
 *  - 接口不接受任何日期参数，可见上界由服务端 currentDate 强制；
 *  - 返回的 K 线不含未来数据，当日K线仅含 open；
 *  - 出参不含被隐藏标的的代码/名称。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const snapshot = await getSimTradeSnapshot(id);
    if (!snapshot) {
      return NextResponse.json(
        { success: false, message: "模拟炒股会话不存在" },
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

/** DELETE /api/simtrade/:id —— 删除会话（级联清空其独占账户与全部交易数据） */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await deleteSimTradeSession(id);
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
