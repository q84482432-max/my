import { NextResponse } from "next/server";
import {
  getMarketStats,
  getStockQuotes,
  listCodesHavingKlines,
} from "@/services/marketDataService";

export const dynamic = "force-dynamic";

/**
 * GET /api/market?limit=20
 *
 * 市场概览：返回数据库中**已有真实K线数据**的股票及其最新行情。
 * 注意：这里的"热门"按成交量排序，不是编造的数据，全部来自真实历史数据。
 *
 * 分层约束：本路由不直接访问数据库，全部经 marketDataService。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") ?? "20", 10) || 20, 1),
      200,
    );

    const [stats, codes] = await Promise.all([
      getMarketStats(),
      // 全市场（不传 take 即全部 5558 只）；行情由单条窗口函数 SQL 批量计算，
      // 不会产生 N+1。旧实现只取 code 升序前 400 只，榜单实际仅覆盖 000 段。
      listCodesHavingKlines(),
    ]);

    const quoteMap = await getStockQuotes(codes);
    const quotes = Object.values(quoteMap);

    // 按成交额降序取前 N（"成交活跃"以成交额为度量）
    const active = quotes
      .filter((q) => q.lastPrice > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, limit);

    // 涨幅榜 / 跌幅榜（基于真实最新两根K线）
    const sortedByChange = [...quotes]
      .filter((q) => q.lastPrice > 0 && q.changePercent !== 0)
      .sort((a, b) => b.changePercent - a.changePercent);
    const gainers = sortedByChange.slice(0, 10);
    const losers = sortedByChange.slice(-10).reverse();

    return NextResponse.json({
      success: true,
      stats,
      active,
      gainers,
      losers,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
