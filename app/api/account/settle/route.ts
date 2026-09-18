import { NextResponse } from "next/server";
import {
  ensureDefaultAccount,
  getAccountSummary,
  getPositions,
  resolveT1Settlement,
  settleT1,
} from "@/services/tradingEngine";

export const dynamic = "force-dynamic";

/**
 * POST /api/account/settle —— T+1 结算（解锁可卖数量）
 *
 * 背景：市价单以「最新交易日收盘价」成交，而 A股 T+1 规定当日买入的份额
 * 次日才可卖。若不提供推进交易日的入口，买入后「可卖数量」恒为 0，无法卖出。
 *
 * 行为：把结算日推进到「最近一次买入日之后的下一**真实**交易日」
 * （交易日取自 klines，避免落到周末/节假日），随后由 tradingEngine.settleT1
 * 逐股票重算可卖数量。账户仍由服务端解析，不接受客户端传入 accountId。
 *
 * body（可选）：{ asOfDate?: string } —— 显式指定结算日；缺省由引擎解析。
 */
export async function POST(request: Request) {
  try {
    let asOfDate: string | undefined;
    try {
      const body = (await request.json()) as { asOfDate?: string };
      asOfDate = body?.asOfDate;
    } catch {
      // 无请求体：使用引擎解析的默认结算日
    }

    const accountId = await ensureDefaultAccount();

    let resolved: {
      asOfDate: string;
      isTradingDay: boolean;
      latestBuyDate: string;
    } | null = null;

    if (!asOfDate) {
      resolved = await resolveT1Settlement(accountId);
      if (!resolved) {
        return NextResponse.json(
          { success: false, message: "账户暂无买入成交，无需 T+1 结算" },
          { status: 400 },
        );
      }
      asOfDate = resolved.asOfDate;
    }

    const updated = await settleT1(accountId, asOfDate);

    const [summary, positions] = await Promise.all([
      getAccountSummary(accountId),
      getPositions(accountId),
    ]);

    return NextResponse.json({
      success: true,
      asOfDate,
      latestBuyDate: resolved?.latestBuyDate ?? null,
      isTradingDay: resolved?.isTradingDay ?? true,
      updated,
      summary,
      positions,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
