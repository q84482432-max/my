import { NextResponse } from "next/server";
import type { CreateSimTradeInput } from "@/types";
import {
  createSimTradeSession,
  listSimTradeSessions,
} from "@/services/simtradeService";

export const dynamic = "force-dynamic";

/**
 * GET /api/simtrade —— 全部模拟炒股会话（按创建时间倒序）
 *
 * 只返回会话元信息（进度 / 账户上界 currentDate），**不含被隐藏标的的任何身份信息**。
 */
export async function GET() {
  try {
    const items = await listSimTradeSessions();
    return NextResponse.json({ success: true, data: items, count: items.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/simtrade —— 创建「猜股票」模拟炒股会话
 *
 * body: { initialCash?: number, tradingDays?: number, name?: string, pool?: SimTradePool }
 *
 * 服务端会：
 *  1. 在真实交易日中随机定位一个起始交易日（保证前面有 >= 60 根可见历史K线）；
 *  2. 向后取 20~23 个真实交易日作为模拟区间；
 *  3. 从指定**股票池**（STOCK 全部 A 股 / INDEX 指数 / INDUSTRY 行业板块）中
 *     随机抽取一只满足「数据完整、模拟期不停牌、历史充足」的真实标的并**隐藏身份**；
 *  4. 由 tradingEngine 建一个独占账户（Account.simTradeSessionId = 会话 ID）。
 *
 * **不返回标的代码/名称**。
 */
export async function POST(request: Request) {
  try {
    let body: {
      initialCash?: number;
      tradingDays?: number;
      name?: string;
      pool?: string;
    } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }

    const result = await createSimTradeSession({
      initialCash: body.initialCash,
      tradingDays: body.tradingDays,
      name: body.name,
      pool: body.pool as CreateSimTradeInput["pool"],
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
