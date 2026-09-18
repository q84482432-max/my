import { NextResponse } from "next/server";
import {
  ensureDefaultAccount,
  getAccountSummary,
  getPositions,
  getOrders,
  getTrades,
} from "@/services/tradingEngine";

export const dynamic = "force-dynamic";

/**
 * GET /api/account
 *
 * 返回当前账户的完整快照（汇总 + 持仓 + 委托 + 成交）。
 * 账户不存在时自动创建默认账户（首次访问即可用）。
 *
 * 所有交易相关计算均委托给 services/tradingEngine.ts，
 * API 层只做数据聚合与序列化。
 */
export async function GET() {
  try {
    const accountId = await ensureDefaultAccount();

    const [summary, positions, orders, trades] = await Promise.all([
      getAccountSummary(accountId),
      getPositions(accountId),
      getOrders(accountId, { limit: 100 }),
      getTrades(accountId, { limit: 100 }),
    ]);

    return NextResponse.json({
      success: true,
      accountId,
      summary,
      positions,
      orders,
      trades,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
