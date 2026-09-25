import { NextResponse } from "next/server";
import { getStockList, getStockQuotes } from "@/services/marketDataService";
import type { BoardType, Exchange, StockQuote } from "@/types";
import { BOARD_LABELS } from "@/lib/constants";

export const dynamic = "force-dynamic";

const VALID_BOARDS: BoardType[] = ["MAIN", "GEM", "STAR", "BSE"];
const VALID_EXCHANGES: Exchange[] = ["SH", "SZ", "BJ"];
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 200;

/**
 * GET /api/stocks
 *
 * 股票清单 + 搜索（全市场 5558 只）。
 *
 * 查询参数：
 *   keyword   代码或名称模糊匹配（可空，空则返回全市场清单）
 *   board     板块过滤：MAIN(主板) | GEM(创业板) | STAR(科创板) | BSE(北交所)
 *   exchange  交易所过滤：SH | SZ | BJ
 *   page      页码，从 1 开始（默认 1）
 *   pageSize  每页条数（默认 30，上限 200）；兼容旧参数 limit
 *   withQuote 是否附带最新行情（默认 true）
 *   orderBy   code | name | barCount（默认 code）
 *   orderDir  asc | desc（默认 asc）
 *
 * 分层约束：本路由不直接访问数据库，全部经 marketDataService。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const keyword = (searchParams.get("keyword") ?? "").trim();
    const boardParam = searchParams.get("board") ?? "";
    const exchangeParam = searchParams.get("exchange") ?? "";
    const orderByParam = searchParams.get("orderBy") ?? "code";
    const orderDirParam = searchParams.get("orderDir") ?? "asc";
    const withQuote = searchParams.get("withQuote") !== "false";

    const rawPageSize =
      searchParams.get("pageSize") ?? searchParams.get("limit") ?? "";
    const pageSize = Math.min(
      Math.max(parseInt(rawPageSize, 10) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const page = Math.max(parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);

    const board = VALID_BOARDS.includes(boardParam as BoardType)
      ? (boardParam as BoardType)
      : undefined;
    const exchange = VALID_EXCHANGES.includes(exchangeParam as Exchange)
      ? (exchangeParam as Exchange)
      : undefined;
    const orderBy =
      orderByParam === "name" || orderByParam === "barCount"
        ? (orderByParam as "name" | "barCount")
        : "code";
    const orderDir = orderDirParam === "desc" ? "desc" : "asc";

    const { items, total } = await getStockList({
      keyword: keyword || undefined,
      board,
      exchange,
      orderBy,
      orderDir,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;

    if (!withQuote || items.length === 0) {
      return NextResponse.json({
        success: true,
        data: items,
        count: items.length,
        total,
        page,
        pageSize,
        totalPages,
        hasMore: page * pageSize < total,
      });
    }

    // 批量补最新行情（单条窗口函数 SQL，无 N+1）
    const quoteMap = await getStockQuotes(items.map((s) => s.code));

    // getStockQuotes 对库内股票必然有返回；此处兜底仅防御脏数据，
    // 若真缺失则以 StockListItem 的字段合成一条空行情（价格 0）。
    const data: StockQuote[] = items.map((s) => {
      const q = quoteMap[s.code];
      if (q) return q;
      return {
        id: "",
        code: s.code,
        name: s.name,
        exchange: s.exchange,
        board: s.board,
        industry: null,
        listDate: null,
        isActive: true,
        adjust: s.adjust,
        fullWindow: s.fullWindow,
        barCount: s.barCount,
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        lastPrice: 0,
        change: 0,
        changePercent: 0,
        /* 新增的 开/高/低 与 lastPrice 同源，缺失时同样给 0，
           保持「空行情的所有价格字段都为 0」这一不变式（前端按 >0 判定显示 `--`）。 */
        open: 0,
        high: 0,
        low: 0,
        volume: 0,
        amount: 0,
        prevClose: 0,
        lastDate: null,
      };
    });

    return NextResponse.json({
      success: true,
      data,
      count: data.length,
      total,
      page,
      pageSize,
      totalPages,
      hasMore: page * pageSize < total,
      boardLabels: BOARD_LABELS,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: (err as Error).message },
      { status: 500 },
    );
  }
}
