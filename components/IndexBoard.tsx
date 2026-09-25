import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import KlineChart from "@/components/charts/KlineChart";
import { cn, formatNumber, formatPercent, pnlColorClass } from "@/lib/utils";
import type { IndexQuoteItem } from "@/lib/indexQuotes";
import type { IndexBar, IndexInfo } from "@/types";

interface IndexBoardProps {
  indices: IndexInfo[];
  quotes: IndexQuoteItem[];
  selectedCode: string | null;
  bars: IndexBar[];
}

/**
 * 指数页主体：行情选择条 + K 线 + 完整清单。
 *
 * 为什么不需要 "use client"
 * -----------------------
 * 切换指数用 `<Link href="/indices?code=...">` 走 RSC 导航，选中态由 URL 决定，
 * 组件本身无内部状态。这样：
 *   · URL 可分享 / 可收藏（发个链接进去就是那个指数）；
 *   · 数据始终由服务端按选中项取好，不存在「切换后还显示上一个指数」的错位。
 * `scroll={false}` 保证切换时不跳回页面顶部，长页面下滑到 K 线处切换更顺手。
 *
 * 布局：选择条在移动端横向滚动、≥768px 起铺成网格；K 线随后；清单表最后。
 */
export default function IndexBoard({
  indices,
  quotes,
  selectedCode,
  bars,
}: IndexBoardProps) {
  const quoteByCode = new Map(quotes.map((q) => [q.code, q]));
  const selectedQuote = selectedCode ? quoteByCode.get(selectedCode) : undefined;
  const selectedInfo = selectedCode
    ? indices.find((i) => i.code === selectedCode)
    : undefined;
  const latestDate = quotes[0]?.lastDate ?? null;

  if (indices.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          暂无指数数据。
          <br />
          <span className="text-xs">
            请先在服务器执行 <code className="font-mono">fetch_indices.py</code> 抓取、
            再执行 <code className="font-mono">import_indices.py</code> 导入。
          </span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---------- 1. 指数行情选择条 ---------- */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">
            指数行情
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              共 {indices.length} 个{latestDate ? ` · ${latestDate} 收盘` : ""}
            </span>
          </CardTitle>
          <span className="shrink-0 text-xs text-muted-foreground">
            点击切换下方图表
          </span>
        </CardHeader>
        <CardContent>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0 lg:grid-cols-9">
            {indices.map((i) => {
              const q = quoteByCode.get(i.code);
              const active = i.code === selectedCode;
              return (
                <Link
                  key={i.code}
                  href={`/indices?code=${i.code}`}
                  scroll={false}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "min-w-[128px] shrink-0 rounded-lg border px-3 py-2 transition-colors",
                    active
                      ? "border-primary bg-primary/5"
                      : "bg-background hover:border-primary/60",
                  )}
                >
                  <div className="truncate text-[12.5px] font-medium leading-tight">
                    {i.name}
                  </div>
                  {q ? (
                    <>
                      <div
                        className={cn(
                          "tabular mt-1 text-[17px] font-semibold leading-none",
                          pnlColorClass(q.change),
                        )}
                      >
                        {formatNumber(q.lastPrice)}
                      </div>
                      <div
                        className={cn(
                          "tabular mt-1.5 text-[11.5px] leading-none",
                          pnlColorClass(q.change),
                        )}
                      >
                        {q.change > 0 ? "+" : ""}
                        {formatNumber(q.change)} {formatPercent(q.changePercent)}
                      </div>
                    </>
                  ) : (
                    <div className="mt-1 text-xs text-muted-foreground">暂无行情</div>
                  )}
                </Link>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ---------- 2. 选中指数的 K 线 ---------- */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-2 space-y-0 pb-3">
          <CardTitle className="text-sm">
            {selectedInfo?.name ?? "指数"}
            {selectedInfo && (
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                {selectedInfo.code}
              </span>
            )}
            {selectedQuote && (
              <>
                <span
                  className={cn(
                    "tabular ml-3 text-base font-semibold",
                    pnlColorClass(selectedQuote.change),
                  )}
                >
                  {formatNumber(selectedQuote.lastPrice)}
                </span>
                <span
                  className={cn(
                    "tabular ml-2 text-xs",
                    pnlColorClass(selectedQuote.change),
                  )}
                >
                  {selectedQuote.change > 0 ? "+" : ""}
                  {formatNumber(selectedQuote.change)}{" "}
                  {formatPercent(selectedQuote.changePercent)}
                </span>
              </>
            )}
          </CardTitle>
          <span className="shrink-0 text-xs text-muted-foreground">
            日K · 最近 {bars.length} 根 · MA5/10/20/60
          </span>
        </CardHeader>
        <CardContent>
          <KlineChart
            bars={bars}
            height={420}
            showVolume
            maPeriods={[5, 10, 20, 60]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            指数不披露成交额，故 tooltip 只显示成交量；指数亦无复权概念。
          </p>
        </CardContent>
      </Card>

      {/* ---------- 3. 完整清单 ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            指数清单
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              与个股物理分表（market_indices / index_klines），互不混入
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>代码</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>分类</TableHead>
                  <TableHead className="text-right">最新点位</TableHead>
                  <TableHead className="text-right">涨跌额</TableHead>
                  <TableHead className="text-right">涨跌幅</TableHead>
                  <TableHead className="text-right">K线根数</TableHead>
                  <TableHead className="text-right">数据窗口</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {indices.map((i) => {
                  const q = quoteByCode.get(i.code);
                  return (
                    <TableRow key={i.code}>
                      <TableCell className="font-mono text-xs">{i.code}</TableCell>
                      <TableCell>
                        <Link
                          href={`/indices?code=${i.code}`}
                          scroll={false}
                          className={cn(
                            "font-medium hover:text-primary hover:underline",
                            i.code === selectedCode && "text-primary",
                          )}
                        >
                          {i.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {i.category}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tabular text-right",
                          q ? pnlColorClass(q.change) : "text-muted-foreground",
                        )}
                      >
                        {q ? formatNumber(q.lastPrice) : "--"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tabular text-right",
                          q ? pnlColorClass(q.change) : "text-muted-foreground",
                        )}
                      >
                        {q ? `${q.change > 0 ? "+" : ""}${formatNumber(q.change)}` : "--"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tabular text-right",
                          q ? pnlColorClass(q.change) : "text-muted-foreground",
                        )}
                      >
                        {q ? formatPercent(q.changePercent) : "--"}
                      </TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {i.barCount.toLocaleString("zh-CN")}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {i.windowStart ?? "--"} → {i.windowEnd ?? "--"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
