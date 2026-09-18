import { NextResponse } from "next/server";
import {
  getSimulationAccountId,
  getSimulationInfo,
  getSimulationSnapshot,
} from "@/services/simulationService";
import { getOrders, placeOrder } from "@/services/tradingEngine";
import type { OrderSide, OrderType } from "@/types";

export const dynamic = "force-dynamic";

/**
 * 校验会话处于可交易状态（轻量查询：不计算持仓/行情）。
 * 已结束（FINISHED）的会话不允许再下单 —— 否则相当于在历史终点继续开仓。
 */
async function resolveTradable(simulationId: string) {
  const info = await getSimulationInfo(simulationId);
  if (!info) return { error: "模拟会话不存在" as const };
  if (info.status !== "ACTIVE") {
    return { error: "该模拟已结束，无法继续交易" as const };
  }
  return { info };
}

/**
 * GET /api/sim/:id/orders —— 该会话的委托记录
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const accountId = await getSimulationAccountId(id);
    if (!accountId) {
      return NextResponse.json(
        { success: false, message: "模拟会话不存在" },
        { status: 404 },
      );
    }
    const orders = await getOrders(accountId, { limit: 200 });
    return NextResponse.json({ success: true, data: orders, count: orders.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/sim/:id/orders —— 在当前模拟交易日下单
 *
 * body: { stockCode, side, orderType?, price?, quantity }
 *
 * 关键防泄漏点：**成交日由服务端强制为会话的 currentDate**，
 * 并同时作为 `asOfDate` 下沉给 tradingEngine —— 引擎会拒绝晚于该日的成交日，
 * 也会拒绝「该股当日无行情（停牌/未上市）」的委托。客户端无法指定成交日期。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      stockCode?: string;
      side?: OrderSide;
      orderType?: OrderType;
      price?: number;
      quantity?: number;
    };

    const resolved = await resolveTradable(id);
    if ("error" in resolved) {
      return NextResponse.json(
        { success: false, message: resolved.error },
        { status: 400 },
      );
    }
    const { info } = resolved;

    if (!body.stockCode) {
      return NextResponse.json(
        { success: false, message: "缺少股票代码" },
        { status: 400 },
      );
    }
    if (body.side !== "BUY" && body.side !== "SELL") {
      return NextResponse.json(
        { success: false, message: "交易方向必须为 BUY 或 SELL" },
        { status: 400 },
      );
    }
    if (
      typeof body.quantity !== "number" ||
      !Number.isInteger(body.quantity) ||
      body.quantity <= 0
    ) {
      return NextResponse.json(
        { success: false, message: "委托数量必须为正整数" },
        { status: 400 },
      );
    }

    const result = await placeOrder({
      accountId: info.accountId,
      stockCode: body.stockCode,
      side: body.side,
      orderType: body.orderType ?? "MARKET",
      price: body.price,
      quantity: body.quantity,
      // 成交日 = 当前模拟交易日；同时作为行情可见上界下沉引擎（双重防泄漏）
      tradeDate: info.currentDate,
      asOfDate: info.currentDate,
    });

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }

    // 下单后回传最新快照，前端可一次性刷新三视图 + 账户
    const snapshot = await getSimulationSnapshot(id);
    return NextResponse.json({ ...result, snapshot });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
