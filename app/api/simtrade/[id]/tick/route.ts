import { NextResponse } from "next/server";
import { advanceSimTradeIntraday } from "@/services/simtradeService";

export const dynamic = "force-dynamic";

/**
 * POST /api/simtrade/:id/tick —— 推进「30m 时间轴」一格（V3）
 *
 * 与 `/next`（推进交易日阶段）**互相独立**，这是 V3 的核心解耦：
 *   - `/next`  推进**时间窗**：OPEN → CLOSE_ANIMATION → CLOSE → DAY_SETTLED → 下一日；
 *   - `/tick`  推进**30m 游标**：当日已揭示的 30m K 从 n 根变 n+1 根（1~8）。
 *
 * 规则：
 *   - **不消耗** `operationCountToday`（推进时间不是玩家操作）；
 *   - **不要求**玩家先操作（一根 30m K ≠ 一次操作，8 根 K ≠ 8 次操作）；
 *   - 开盘阶段上限 7 根：第 8 根是 15:00，其 close 即当日收盘价，
 *     必须等 `CLOSE_ANIMATION` 才允许揭示（防泄漏红线）；
 *   - 并发重复点击由服务端 CAS 自增挡掉，不会多推进一格。
 *
 * 客户端只能传 `sessionId`（路径参数），**不能传根数 / 阶段 / 日期** ——
 * 可见上界完全由服务端会话状态决定。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await advanceSimTradeIntraday(id);
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
