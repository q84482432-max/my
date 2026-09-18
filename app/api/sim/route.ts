import { NextResponse } from "next/server";
import { createSimulation, listSimulations } from "@/services/simulationService";

export const dynamic = "force-dynamic";

/**
 * GET /api/sim —— 全部历史模拟会话（按创建时间倒序）
 *
 * 只返回会话元信息（含 currentDate 行情可见上界），不含行情数据。
 */
export async function GET() {
  try {
    const items = await listSimulations();
    return NextResponse.json({ success: true, data: items, count: items.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/sim —— 创建历史模拟会话
 *
 * body: { name?, startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD", initialCash: number }
 *
 * 会话会：
 *  - 把开始日期对齐到区间内第一个**真实交易日**（日历取自数据库真实日K）；
 *  - 固化区间内全部真实交易日，之后「下一交易日」只按该日历推进；
 *  - 由 tradingEngine 建一个独占账户（Account.simulationId = 会话 ID），
 *    与普通模拟账户完全解耦。
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      startDate?: string;
      endDate?: string;
      initialCash?: number;
    };

    if (!body.startDate || !body.endDate) {
      return NextResponse.json(
        { success: false, message: "缺少开始日期或结束日期" },
        { status: 400 },
      );
    }

    const result = await createSimulation({
      name: body.name,
      startDate: body.startDate,
      endDate: body.endDate,
      initialCash: Number(body.initialCash ?? 100_000),
    });

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
