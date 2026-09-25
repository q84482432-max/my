import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatNumber, formatPercent, pnlColorClass } from "@/lib/utils";
import type { IndexQuoteItem } from "@/lib/indexQuotes";

/**
 * 首页「大盘概览」—— 一行指数行情条。
 *
 * 为什么是服务端组件
 * ----------------
 * 数据由 app/page.tsx 在服务端取好后传入，首屏直出、无客户端 fetch 闪烁，
 * 也避免首页多打一次 HTTP 请求。本组件因此不需要 "use client"。
 *
 * 布局
 * ----
 * 移动端：横向可滚动（A 股网站的通行做法，一行放下所有指数、手指滑动查看）；
 * ≥768px：改为网格铺满（5 列两行），不再是滚动条。
 *
 * 颜色遵循 A股习惯：涨红跌绿（pnlColorClass）。
 */
export default function IndexOverview({ quotes }: { quotes: IndexQuoteItem[] }) {
  // 指数数据未就绪（表未建/未导入）时不渲染整块，而不是显示一个空壳卡片
  if (quotes.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">
          大盘概览
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {quotes[0]?.lastDate ?? ""} 收盘
          </span>
        </CardTitle>
        <Link
          href="/indices"
          className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          全部指数 →
        </Link>
      </CardHeader>
      <CardContent>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0 lg:grid-cols-9">
          {quotes.map((q) => (
            <Link
              key={q.code}
              href={`/indices?code=${q.code}`}
              className="min-w-[128px] shrink-0 rounded-lg border bg-background px-3 py-2 transition-colors hover:border-primary"
            >
              <div className="truncate text-[12.5px] font-medium leading-tight">
                {q.name}
              </div>
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
                  "tabular mt-1.5 flex items-center gap-1.5 text-[11.5px] leading-none",
                  pnlColorClass(q.change),
                )}
              >
                <span>
                  {q.change > 0 ? "+" : ""}
                  {formatNumber(q.change)}
                </span>
                <span>{formatPercent(q.changePercent)}</span>
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
