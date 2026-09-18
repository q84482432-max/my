import { NextResponse } from "next/server";
import {
  ensureDefaultAccount,
  placeOrder,
  getAccountSummary,
  getPositions,
} from "@/services/tradingEngine";
import type { OrderSide, OrderType } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/account/orders
 *
 * body: { stockCode, side, orderType?, price?, quantity, tradeDate? }
 *
 * 下单接口。accountId 由服务端解析（默认账户），前端无需传递，
 * 避免伪造他人账户。全部校验与撮合逻辑在 tradingEngine 内完成。
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      stockCode?: string;
      side?: OrderSide;
      orderType?: OrderType;
      price?: number;
      quantity?: number;
      tradeDate?: string;
    };

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

    // 账户由服务端解析（默认账户），不接受客户端传入 accountId ——
    // 否则任意调用方都能指定他人账户下单。（其余 /api/account/* 路由同样由服务端解析）
    const accountId = await ensureDefaultAccount();

    const result = await placeOrder({
      accountId,
      stockCode: body.stockCode,
      side: body.side,
      orderType: body.orderType ?? "MARKET",
      price: body.price,
      quantity: body.quantity,
      tradeDate: body.tradeDate,
    });

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }

    // 下单成功后回传最新账户状态，前端可直接刷新
    const [summary, positions] = await Promise.all([
      getAccountSummary(accountId),
      getPositions(accountId),
    ]);

    return NextResponse.json({ ...result, accountId, summary, positions });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}

/** GET /api/account/orders —— 委托记录查询（按状态可选过滤） */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") ?? undefined;
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") ?? "100", 10) || 100, 1),
      500,
    );

    const accountId = await ensureDefaultAccount();
    const { getOrders } = await import("@/services/tradingEngine");
    const orders = await getOrders(accountId, { limit, status });

    return NextResponse.json({ success: true, data: orders, count: orders.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
