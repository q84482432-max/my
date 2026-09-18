import { NextResponse } from "next/server";
import { advanceSimulationDay } from "@/services/simulationService";

export const dynamic = "force-dynamic";

/**
 * POST /api/sim/:id/next —— 推进到下一个交易日
 *
 * 推进目标由服务端按会话固化的交易日历决定，**不接受客户端传入日期**：
 *  1. tradingEngine.settleT1 —— 昨日买入份额解冻为可卖（T+1）
 *  2. 更新 currentDate（行情可见上界随之推进）
 *  3. refreshDailyAsset —— 重算现金 / 市值 / 总资产 / 当日收益 / 累计收益
 *
 * 已到区间末尾时返回 finished=true，不再推进。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await advanceSimulationDay(id);
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
