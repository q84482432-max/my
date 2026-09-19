import { NextResponse } from "next/server";
import { getIndexStats, listIndices } from "@/services/indexDataService";
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
 *
 * 说明：本路由只读 market_indices / index_klines。个股数据仍由 /api/market、
 * /api/stocks 提供，两侧不会互相出现对方的数据。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const catParam = searchParams.get("category") ?? "";
    const withStats = searchParams.get("stats") === "1";

    const category = VALID_CATEGORIES.includes(catParam as IndexCategory)
      ? (catParam as IndexCategory)
      : undefined;

    const [items, stats] = await Promise.all([
      listIndices(category),
      withStats ? getIndexStats() : Promise.resolve(undefined),
    ]);

    return NextResponse.json({
      success: true,
      total: items.length,
      categories: VALID_CATEGORIES,
      items,
      ...(stats ? { stats } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
