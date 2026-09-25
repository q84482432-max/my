import { NextResponse } from "next/server";
import { advanceSimTradeStage } from "@/services/simtradeService";

export const dynamic = "force-dynamic";

/**
 * POST /api/simtrade/:id/next —— 推进交易阶段 / 进入下一交易日
 *
 * V3 阶段状态机（服务端唯一权威）：
 *   OPEN            --⓪--> CLOSE_ANIMATION   揭示当日收盘价（前端播放收盘动画）
 *   OPEN_CONFIRMED  --①--> CLOSE_ANIMATION   （历史数据兼容分支，新代码不再产生该阶段）
 *   CLOSE_ANIMATION --②--> CLOSE             开放收盘阶段交易
 *   CLOSE           --③b--> DAY_SETTLED      当日结算
 *   CLOSE_CONFIRMED --③--> DAY_SETTLED       （历史数据兼容分支）
 *   DAY_SETTLED     --④--> 下一日 OPEN / FINISHED
 *
 * V3 关键变化：**推进时间不消耗操作次数**，也不再要求「本阶段必须先操作过」——
 * 时间轴与「每日 ≤8 次操作」是两条独立的轴（30m 游标另有 `/tick`）。
 *
 * 防泄漏：`CLOSE_ANIMATION` 之前一律不返回当日 high/low/close；行情可见上界由
 * 服务端按固化的真实交易日历推导，客户端无法干预。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await advanceSimTradeStage(id);
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
