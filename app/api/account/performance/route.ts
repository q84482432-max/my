import { NextResponse } from "next/server";
import {
  ensureDefaultAccount,
  getEquityCurve,
  getPerformance,
} from "@/services/tradingEngine";

export const dynamic = "force-dynamic";

/**
 * GET /api/account/performance
 *
 * 收益分析：净值曲线 + 绩效指标（收益率/年化/最大回撤/波动率/夏普）。
 * 全部基于真实成交与真实行情计算，不做任何估算填充。
 */
export async function GET() {
  try {
    const accountId = await ensureDefaultAccount();
    const [curve, metrics] = await Promise.all([
      getEquityCurve(accountId),
      getPerformance(accountId),
    ]);

    return NextResponse.json({ success: true, curve, metrics });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
