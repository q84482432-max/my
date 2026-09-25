import { NextResponse } from "next/server";
import { getIndexStats, listIndices } from "@/services/indexDataService";
import { listIndexQuotes } from "@/lib/indexQuotes";
import type { IndexCategory } from "@/types";

export const dynamic = "force-dynamic";

const VALID_CATEGORIES: IndexCategory[] = ["综合指数", "规模指数", "板块指数"];

/**
 * GET /api/indices
 *
 * 指数清单（与 /api/stocks 完全分离的独立端点）。
 *
 * 查询参数：
 *   category  分类过滤：综合指数 | 规模指数 | 板块指数
 *   stats=1   附带指数侧概况（indexCount / barCount / 日期范围 / byCategory）
 *   quotes=1  附带各指数最新行情（点位 / 涨跌额 / 涨跌幅）—— 首页大盘概览用
 *
 * 说明：本路由只读 market_indices / index_klines。个股数据仍由 /api/market、
 * /api/stocks 提供，两侧不会互相出现对方的数据。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const catParam = searchParams.get("category") ?? "";
    const withStats = searchParams.get("stats") === "1";
    const withQuotes = searchParams.get("quotes") === "1";

    const category = VALID_CATEGORIES.includes(catParam as IndexCategory)
      ? (catParam as IndexCategory)
      : undefined;

    const [items, stats, allQuotes] = await Promise.all([
      listIndices(category),
      withStats ? getIndexStats() : Promise.resolve(undefined),
      withQuotes ? listIndexQuotes() : Promise.resolve(undefined),
    ]);

    // category 过滤同样作用于行情列表，避免「列表是规模指数、行情却是全部」的不一致
    const quotes =
      allQuotes && category
        ? allQuotes.filter((q) => q.category === category)
        : allQuotes;

    return NextResponse.json({
      success: true,
      total: items.length,
      categories: VALID_CATEGORIES,
      items,
      ...(stats ? { stats } : {}),
      ...(quotes ? { quotes } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
