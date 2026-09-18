import Link from "next/link";
import { getStockList, getStockQuotes } from "@/services/marketDataService";
import { BOARD_LABELS, EXCHANGE_LABELS } from "@/lib/constants";
import {
  cn,
  formatNumber,
  formatPercent,
  formatVolume,
  pnlColorClass,
} from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BoardType, Exchange, StockQuote } from "@/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

/** 板块筛选项（含「全部」） */
const BOARD_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部板块" },
  { value: "MAIN", label: BOARD_LABELS.MAIN },
  { value: "GEM", label: BOARD_LABELS.GEM },
  { value: "STAR", label: BOARD_LABELS.STAR },
  { value: "BSE", label: BOARD_LABELS.BSE },
];

/** 交易所筛选项（含「全部」） */
const EXCHANGE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部市场" },
  { value: "SH", label: "沪市" },
  { value: "SZ", label: "深市" },
  { value: "BJ", label: "北交所" },
];

interface PageProps {
  searchParams: Promise<{
    keyword?: string;
    board?: string;
    exchange?: string;
    page?: string;
  }>;
}

/** 构造带当前筛选条件的 URL（省略空参数，保证链接干净） */
function buildUrl(params: {
  keyword?: string;
  board?: string;
  exchange?: string;
  page?: number;
}): string {
  const sp = new URLSearchParams();
  if (params.keyword) sp.set("keyword", params.keyword);
  if (params.board) sp.set("board", params.board);
  if (params.exchange) sp.set("exchange", params.exchange);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const q = sp.toString();
  return `/stocks${q ? `?${q}` : ""}`;
}

/**
 * 股票列表页（服务端组件）
 *
 * 覆盖**全市场 5558 只**真实标的：关键词搜索 + 板块/交易所筛选 + 分页。
 * 每行展示：代码 / 名称 / 板块 / 最新收盘价 / 涨跌额 / 涨跌幅 / 成交量 / 成交额。
 *
 * 行情口径：由 marketDataService 按每只股票**自身复权口径**取数
 * （qfq 5430 只 / none 128 只），不会出现 raw 标的行情为 0 的情况。
 *
 * 采用服务端渲染 + 原生 GET 表单，翻页与筛选均为链接跳转，无需客户端状态。
 */
export default async function StockListPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const keyword = (sp.keyword ?? "").trim();
  const boardParam = sp.board ?? "";
  const exchangeParam = sp.exchange ?? "";
  const page = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);

  const VALID_BOARDS: BoardType[] = ["MAIN", "GEM", "STAR", "BSE"];
  const VALID_EXCHANGES: Exchange[] = ["SH", "SZ", "BJ"];

  const board = VALID_BOARDS.includes(boardParam as BoardType)
    ? (boardParam as BoardType)
    : undefined;
  const exchange = VALID_EXCHANGES.includes(exchangeParam as Exchange)
    ? (exchangeParam as Exchange)
    : undefined;

  const { items, total } = await getStockList({
    keyword: keyword || undefined,
    board,
    exchange,
    orderBy: "code",
    orderDir: "asc",
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  const quoteMap =
    items.length > 0
      ? await getStockQuotes(items.map((s) => s.code))
      : ({} as Record<string, StockQuote>);
  const rows = items.map((s) => quoteMap[s.code]).filter(Boolean) as StockQuote[];

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const filterState = { keyword, board: boardParam, exchange: exchangeParam };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">股票列表</h1>
        <p className="text-sm text-muted-foreground">
          全市场 {total.toLocaleString("zh-CN")} 只标的 · 行情为数据库中真实历史日K 的最新一根
        </p>
      </div>

      {/* 筛选与搜索 */}
      <Card>
        <CardContent className="space-y-4 pt-4">
          <form method="GET" action="/stocks" className="flex flex-wrap items-center gap-2">
            {boardParam && <input type="hidden" name="board" value={boardParam} />}
            {exchangeParam && (
              <input type="hidden" name="exchange" value={exchangeParam} />
            )}
            <input
              type="text"
              name="keyword"
              defaultValue={keyword}
              placeholder="输入股票代码或名称，如 600519 / 贵州茅台"
              className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <button
              type="submit"
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              搜索
            </button>
            {(keyword || boardParam || exchangeParam) && (
              <Link
                href="/stocks"
                className="h-9 rounded-md border px-4 text-sm leading-9 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                重置
              </Link>
            )}
          </form>

          {/* 板块筛选 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">板块</span>
            {BOARD_FILTERS.map((f) => {
              const active = (boardParam || "") === f.value;
              return (
                <Link
                  key={f.value || "all"}
                  href={buildUrl({ ...filterState, board: f.value, page: 1 })}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {f.label}
                </Link>
              );
            })}
          </div>

          {/* 交易所筛选 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">市场</span>
            {EXCHANGE_FILTERS.map((f) => {
              const active = (exchangeParam || "") === f.value;
              return (
                <Link
                  key={f.value || "all"}
                  href={buildUrl({ ...filterState, exchange: f.value, page: 1 })}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {f.label}
                </Link>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* 列表 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">
            {keyword ? `搜索「${keyword}」` : "全部标的"}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              共 {total.toLocaleString("zh-CN")} 只
              {totalPages > 1 && ` · 第 ${page} / ${totalPages} 页`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              未找到匹配的股票
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>代码</TableHead>
                    <TableHead>名称</TableHead>
                    <TableHead>板块</TableHead>
                    <TableHead className="text-right">最新价</TableHead>
                    <TableHead className="text-right">涨跌额</TableHead>
                    <TableHead className="text-right">涨跌幅</TableHead>
                    <TableHead className="text-right">成交量</TableHead>
                    <TableHead className="text-right">成交额</TableHead>
                    <TableHead className="text-right">最新交易日</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((q) => (
                    <TableRow key={q.code}>
                      <TableCell className="font-mono text-xs">{q.code}</TableCell>
                      <TableCell>
                        <Link
                          href={`/stocks/${q.code}`}
                          className="font-medium hover:text-primary hover:underline"
                        >
                          {q.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Badge variant="secondary" className="text-[10px]">
                            {BOARD_LABELS[q.board]}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            {q.exchange === "SH" ? "沪" : q.exchange === "SZ" ? "深" : "北"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn("text-right tabular", pnlColorClass(q.change))}
                      >
                        {q.lastPrice > 0 ? formatNumber(q.lastPrice) : "—"}
                      </TableCell>
                      <TableCell
                        className={cn("text-right tabular", pnlColorClass(q.change))}
                      >
                        {q.lastPrice > 0
                          ? `${q.change > 0 ? "+" : ""}${formatNumber(q.change)}`
                          : "—"}
                      </TableCell>
                      <TableCell
                        className={cn("text-right tabular", pnlColorClass(q.change))}
                      >
                        {q.lastPrice > 0 ? formatPercent(q.changePercent) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular text-muted-foreground">
                        {q.volume > 0 ? formatVolume(q.volume) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular text-muted-foreground">
                        {q.amount > 0 ? `¥${formatVolume(q.amount)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {q.lastDate ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground">
                第 {(page - 1) * PAGE_SIZE + 1} – {Math.min(page * PAGE_SIZE, total)} 条，
                共 {total.toLocaleString("zh-CN")} 条
              </span>
              <div className="flex items-center gap-2">
                {hasPrev ? (
                  <Link
                    href={buildUrl({ ...filterState, page: page - 1 })}
                    className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-accent"
                  >
                    上一页
                  </Link>
                ) : (
                  <span className="rounded-md border px-3 py-1 text-xs text-muted-foreground opacity-50">
                    上一页
                  </span>
                )}
                <span className="text-xs tabular text-muted-foreground">
                  {page} / {totalPages}
                </span>
                {hasNext ? (
                  <Link
                    href={buildUrl({ ...filterState, page: page + 1 })}
                    className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-accent"
                  >
                    下一页
                  </Link>
                ) : (
                  <span className="rounded-md border px-3 py-1 text-xs text-muted-foreground opacity-50">
                    下一页
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
