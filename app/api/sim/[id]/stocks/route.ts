import { NextResponse } from "next/server";
import { searchSimulationStocks } from "@/services/simulationService";

export const dynamic = "force-dynamic";

/**
 * GET /api/sim/:id/stocks?q=关键词&limit=20 —— 模拟模式下的股票搜索
 *
 * 只返回「截至会话 currentDate」的行情（价格 / 涨跌幅）：
 * 关键词只匹配代码与名称，价格由 getQuotesAsOf 以 `tradeDate <= currentDate`
 * 为硬上界取回，**绝不返回未来行情**。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const keyword = searchParams.get("q") ?? "";
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") ?? "20", 10) || 20, 1),
      50,
    );

    const result = await searchSimulationStocks(id, keyword, limit);
    if (!result) {
      return NextResponse.json(
        { success: false, message: "模拟会话不存在" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      success: true,
      currentDate: result.currentDate,
      data: result.items,
      count: result.items.length,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
