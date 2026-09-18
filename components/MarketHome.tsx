"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatNumber, formatPercent, formatVolume, pnlColorClass } from "@/lib/utils";
import type { StockQuote } from "@/types";

interface MarketData {
  stats: {
    stockCount: number;
    klineCount: number;
    startDate: string | null;
    endDate: string | null;
    byBoard?: Record<string, number>;
    byAdjust?: Record<string, number>;
    fullWindowCount?: number;
  };
  active: StockQuote[];
  gainers: StockQuote[];
  losers: StockQuote[];
}

function QuoteTable({ quotes, emptyText }: { quotes: StockQuote[]; emptyText: string }) {
  if (quotes.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>代码</TableHead>
            <TableHead>名称</TableHead>
            <TableHead className="text-right">最新价</TableHead>
            <TableHead className="text-right">涨跌额</TableHead>
            <TableHead className="text-right">涨跌幅</TableHead>
            <TableHead className="text-right">成交量</TableHead>
            <TableHead className="text-right">成交额</TableHead>
            <TableHead className="text-right">日期</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {quotes.map((q) => (
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
              <TableCell className={`text-right tabular ${pnlColorClass(q.change)}`}>
                {formatNumber(q.lastPrice)}
              </TableCell>
              <TableCell className={`text-right tabular ${pnlColorClass(q.change)}`}>
                {formatNumber(q.change)}
              </TableCell>
              <TableCell className={`text-right tabular ${pnlColorClass(q.change)}`}>
                {formatPercent(q.changePercent)}
              </TableCell>
              <TableCell className="text-right tabular text-muted-foreground">
                {formatVolume(q.volume)}
              </TableCell>
              <TableCell className="text-right tabular text-muted-foreground">
                ¥{formatVolume(q.amount)}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {q.lastDate ?? "--"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * 行情中心首页。
 * 所有行情均来自数据库中的真实历史K线（最新一根即"最新行情"）。
 */
export default function MarketHome() {
  const [data, setData] = React.useState<MarketData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [keyword, setKeyword] = React.useState("");
  const [searchResult, setSearchResult] = React.useState<StockQuote[] | null>(null);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/market?limit=20", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "加载失败");
        setData(json as MarketData);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 搜索（防抖 300ms）
  React.useEffect(() => {
    const kw = keyword.trim();
    if (!kw) {
      setSearchResult(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/stocks?keyword=${encodeURIComponent(kw)}&limit=30&withQuote=true`,
          { cache: "no-store" },
        );
        const json = await res.json();
        setSearchResult(json.success ? (json.data as StockQuote[]) : []);
      } catch {
        setSearchResult([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  const stats = data?.stats;

  return (
    <div className="space-y-6">
      {/* 核心功能入口 */}
      <div className="grid gap-4 md:grid-cols-2">
        <Link href="/simtrade" className="group">
          <Card className="h-full border-primary/40 transition-colors group-hover:border-primary">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                模拟炒股 · 猜股票
                <Badge variant="default" className="text-[10px]">
                  NEW
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                系统随机隐藏一只真实历史个股，只给 K 线与价格。凭盘感逐日做多，
                结束后与「买入持有」比收益，看你能不能猜中并跑赢大盘。
              </p>
              <p className="mt-2 text-xs text-primary">开始一局 →</p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/sim" className="group">
          <Card className="h-full transition-colors group-hover:border-primary">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">历史模拟交易</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                指定历史区间，按真实交易日逐日推进，自由选股买卖，
                查看持仓、委托、成交与收益曲线，验证你的交易策略。
              </p>
              <p className="mt-2 text-xs text-primary">进入模拟 →</p>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* 数据概况 */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              已导入股票
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular">
              {loading ? "--" : (stats?.stockCount ?? 0).toLocaleString("zh-CN")}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">只</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              日K数据量
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular">
              {loading ? "--" : (stats?.klineCount ?? 0).toLocaleString("zh-CN")}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">根（真实历史）</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              数据起始
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold tabular">
              {loading ? "--" : (stats?.startDate ?? "--")}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">最早交易日</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              数据截止
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold tabular">
              {loading ? "--" : (stats?.endDate ?? "--")}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">最新交易日</p>
          </CardContent>
        </Card>
      </div>

      {/* 搜索 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">股票搜索</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            placeholder="输入股票代码或名称，如 600519 / 贵州茅台"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="max-w-md"
          />
          {keyword.trim() && (
            <div className="mt-4">
              {searching ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  搜索中...
                </div>
              ) : searchResult && searchResult.length > 0 ? (
                <QuoteTable quotes={searchResult} emptyText="无结果" />
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  未找到匹配的股票
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="pt-4 text-sm text-destructive">
            加载失败：{error}
          </CardContent>
        </Card>
      )}

      {/* 榜单 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">
            市况榜单
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              覆盖全市场 {loading ? "--" : (stats?.stockCount ?? 0).toLocaleString("zh-CN")} 只，
              按最新交易日收盘数据计算
            </span>
          </CardTitle>
          <Link
            href="/stocks"
            className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            查看全部股票列表 →
          </Link>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="active">
            <TabsList>
              <TabsTrigger value="active">成交活跃</TabsTrigger>
              <TabsTrigger value="gainers">
                涨幅榜 <Badge variant="up" className="ml-1.5">TOP10</Badge>
              </TabsTrigger>
              <TabsTrigger value="losers">
                跌幅榜 <Badge variant="down" className="ml-1.5">TOP10</Badge>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="active">
              <QuoteTable
                quotes={data?.active ?? []}
                emptyText={loading ? "加载中..." : "暂无行情数据，请先导入真实历史K线"}
              />
            </TabsContent>
            <TabsContent value="gainers">
              <QuoteTable
                quotes={data?.gainers ?? []}
                emptyText={loading ? "加载中..." : "暂无数据"}
              />
            </TabsContent>
            <TabsContent value="losers">
              <QuoteTable
                quotes={data?.losers ?? []}
                emptyText={loading ? "加载中..." : "暂无数据"}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
