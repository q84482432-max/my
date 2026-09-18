"use client";

import * as React from "react";
import Link from "next/link";
import type {
  AccountInfo,
  DailyAssetInfo,
  EquityPoint,
  OrderInfo,
  PerformanceMetrics,
  PositionInfo,
  TradeInfo,
} from "@/types";
import { cn, formatMoney, formatNumber, formatPercent, pnlColorClass, toDateStr } from "@/lib/utils";
import { ORDER_STATUS_LABELS } from "@/lib/constants";
import { useAccountStore } from "@/store/accountStore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import EquityChart from "@/components/charts/EquityChart";

interface PerformancePayload {
  curve: DailyAssetInfo[];
  metrics: PerformanceMetrics;
}

/**
 * DailyAsset 快照 → EquityPoint（净值曲线入参）
 * 净值以首日为基准归一化为 1，不做任何估算填充。
 */
function toEquityPoints(curve: DailyAssetInfo[]): EquityPoint[] {
  if (curve.length === 0) return [];
  const base = curve[0].totalAsset || 1;
  return curve.map((d) => ({
    date: d.date,
    totalAsset: d.totalAsset,
    nav: +(d.totalAsset / base).toFixed(6),
    returnPercent: d.totalReturn,
  }));
}

/**
 * 模拟账户客户端组件
 *
 * 职责：展示账户汇总、持仓、委托、成交，以及收益分析曲线。
 * 所有交易数据来自 /api/account*，所有交易计算在服务端完成。
 */
export default function AccountClient() {
  const {
    summary,
    positions,
    orders,
    trades,
    loading,
    error,
    refresh,
  } = useAccountStore();

  const [perf, setPerf] = React.useState<PerformancePayload | null>(null);
  const [perfLoading, setPerfLoading] = React.useState(false);

  // 首次加载 + 手动刷新
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadPerf = React.useCallback(async () => {
    setPerfLoading(true);
    try {
      const res = await fetch("/api/account/performance", { cache: "no-store" });
      const json = (await res.json()) as {
        success: boolean;
        curve?: DailyAssetInfo[];
        metrics?: PerformanceMetrics;
      };
      if (json.success && json.curve && json.metrics) {
        setPerf({ curve: json.curve, metrics: json.metrics });
      }
    } catch {
      // 忽略：下次切页签重试
    } finally {
      setPerfLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadPerf();
  }, [loadPerf]);

  const [settling, setSettling] = React.useState(false);
  const [settleMsg, setSettleMsg] = React.useState<string | null>(null);

  /**
   * T+1 结算：请求服务端把结算日推进到次一交易日，解锁当日买入的份额。
   * 结算日由 tradingEngine 依据真实 K 线交易日解析，前端不参与计算。
   */
  const settleT1 = React.useCallback(async () => {
    setSettling(true);
    setSettleMsg(null);
    try {
      const res = await fetch("/api/account/settle", { method: "POST" });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        asOfDate?: string;
        isTradingDay?: boolean;
        updated?: number;
      };
      if (!json.success) {
        setSettleMsg(json.message ?? "T+1 结算失败");
        return;
      }
      setSettleMsg(
        `已按 T+1 结算至 ${json.asOfDate}` +
          (json.isTradingDay === false
            ? "（数据窗口已到最新交易日，无更晚行情，此为推算日期；卖出仍按最新收盘价成交）"
            : "") +
          `，更新 ${json.updated ?? 0} 条持仓的可卖数量。`,
      );
      await refresh();
    } catch (err) {
      setSettleMsg((err as Error).message);
    } finally {
      setSettling(false);
    }
  }, [refresh]);

  return (
    <div className="space-y-6">
      {/* 资金概览 */}
      <SummaryCards summary={summary} loading={loading} />

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          加载失败：{error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">资产与交易</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void settleT1()}
            disabled={settling || loading}
            title="按 A股 T+1 规则，将结算日推进到最近一次买入日之后的下一交易日，使当日买入份额变为可卖"
          >
            {settling ? "结算中…" : "T+1 结算（解锁可卖）"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refresh();
              void loadPerf();
            }}
            disabled={loading}
          >
            {loading ? "刷新中…" : "刷新数据"}
          </Button>
        </div>
      </div>

      {settleMsg && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">{settleMsg}</div>
      )}

      <p className="text-xs text-muted-foreground">
        T+1 规则：当日买入的份额当日不可卖，需先执行「T+1 结算」推进到次一交易日。
      </p>

      <Tabs defaultValue="positions">
        <TabsList>
          <TabsTrigger value="positions">
            持仓 <span className="ml-1 text-xs opacity-70">{positions.length}</span>
          </TabsTrigger>
          <TabsTrigger value="orders">
            委托 <span className="ml-1 text-xs opacity-70">{orders.length}</span>
          </TabsTrigger>
          <TabsTrigger value="trades">
            成交 <span className="ml-1 text-xs opacity-70">{trades.length}</span>
          </TabsTrigger>
          <TabsTrigger value="performance">收益分析</TabsTrigger>
        </TabsList>

        <TabsContent value="positions">
          <PositionsTable positions={positions} />
        </TabsContent>

        <TabsContent value="orders">
          <OrdersTable orders={orders} />
        </TabsContent>

        <TabsContent value="trades">
          <TradesTable trades={trades} />
        </TabsContent>

        <TabsContent value="performance">
          <PerformancePanel perf={perf} loading={perfLoading} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ============================ 概览卡片 ============================ */

function SummaryCards({
  summary,
  loading,
}: {
  summary: AccountInfo | null;
  loading: boolean;
}) {
  if (!summary) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6">
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              <div className="mt-3 h-7 w-32 animate-pulse rounded bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const pnlCls = pnlColorClass(summary.totalProfit);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="总资产"
        value={formatMoney(summary.totalAsset)}
        hint={`期初 ${formatMoney(summary.initialCash)}`}
        loading={loading}
      />
      <StatCard
        label="可用资金"
        value={formatMoney(summary.availableCash)}
        hint={
          summary.frozenCash > 0
            ? `冻结 ${formatMoney(summary.frozenCash)}`
            : `现金总额 ${formatMoney(summary.cash)}`
        }
        loading={loading}
      />
      <StatCard
        label="持仓市值"
        value={formatMoney(summary.marketValue)}
        hint="按最新收盘价计算"
        loading={loading}
      />
      <StatCard
        label="累计盈亏"
        value={
          <span className={pnlCls}>
            {summary.totalProfit > 0 ? "+" : ""}
            {formatMoney(summary.totalProfit)}
          </span>
        }
        hint={
          <span className={pnlCls}>
            {summary.totalProfitRate > 0 ? "+" : ""}
            {formatPercent(summary.totalProfitRate)}
          </span>
        }
        loading={loading}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn("mt-2 text-2xl font-semibold tabular", loading && "opacity-60")}>
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-muted-foreground tabular">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/* ============================ 持仓表 ============================ */

function PositionsTable({ positions }: { positions: PositionInfo[] }) {
  if (positions.length === 0) {
    return <EmptyHint text="暂无持仓。请到行情中心选择股票后下单。" />;
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>股票</TableHead>
                <TableHead>代码</TableHead>
                <TableHead className="text-right">持仓数量</TableHead>
                <TableHead className="text-right">可卖数量</TableHead>
                <TableHead className="text-right">平均成本</TableHead>
                <TableHead className="text-right">当前价格</TableHead>
                <TableHead className="text-right">持仓市值</TableHead>
                <TableHead className="text-right">浮动盈亏</TableHead>
                <TableHead className="text-right">浮动盈亏率</TableHead>
                <TableHead className="text-right">今日盈亏</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link
                      href={`/stocks/${p.stockCode}`}
                      className="font-medium hover:underline"
                    >
                      {p.stockName}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    {p.stockCode}
                  </TableCell>
                  <TableCell className="text-right tabular">{p.quantity}</TableCell>
                  <TableCell className="text-right tabular">
                    {p.availableQty}
                    {p.availableQty === 0 && p.quantity > 0 && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        (T+1)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatNumber(p.avgCost, 3)}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatNumber(p.lastPrice, 2)}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatMoney(p.marketValue)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular", pnlColorClass(p.unrealizedPnl))}>
                    {p.unrealizedPnl > 0 ? "+" : ""}
                    {formatMoney(p.unrealizedPnl)}
                  </TableCell>
                  <TableCell
                    className={cn("text-right tabular", pnlColorClass(p.unrealizedPnlPercent))}
                  >
                    {formatPercent(p.unrealizedPnlPercent)}
                  </TableCell>
                  <TableCell
                    className={cn("text-right tabular", pnlColorClass(p.todayPnl))}
                    title={`昨收 ${formatNumber(p.prevClose, 2)}`}
                  >
                    {p.todayPnl > 0 ? "+" : ""}
                    {formatMoney(p.todayPnl)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ 委托表 ============================ */

/**
 * 委托表。
 *
 * 「价格」列的口径：限价单展示委托价；市价单委托价为空，展示实际成交均价
 * （本系统市价单以当日收盘价成交）。下单类型以方向下方的小字标注，避免误读。
 */
function OrdersTable({ orders }: { orders: OrderInfo[] }) {
  if (orders.length === 0) {
    return <EmptyHint text="暂无委托记录。" />;
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>订单编号</TableHead>
                <TableHead>股票</TableHead>
                <TableHead>方向</TableHead>
                <TableHead className="text-right">价格</TableHead>
                <TableHead className="text-right">数量</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>创建时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => {
                const shownPrice = o.orderType === "LIMIT" ? o.price : o.filledPrice;
                return (
                  <TableRow key={o.id}>
                    <TableCell
                      className="font-mono text-[11px] text-muted-foreground"
                      title={o.id}
                    >
                      {o.id}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Link href={`/stocks/${o.stockCode}`} className="hover:underline">
                        {o.stockName}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground tabular">
                        {o.stockCode}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={o.side === "BUY" ? "up" : "down"}>
                        {o.side === "BUY" ? "买入" : "卖出"}
                      </Badge>
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {o.orderType === "MARKET" ? "市价" : "限价"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {shownPrice === null ? "—" : formatNumber(shownPrice, 2)}
                    </TableCell>
                    <TableCell className="text-right tabular">{o.quantity}</TableCell>
                    <TableCell>
                      <span className="text-xs">
                        {ORDER_STATUS_LABELS[o.status] ?? o.status}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                      {o.orderTime}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ 成交表 ============================ */

/**
 * 成交表。
 *
 * 「手续费」为合计（佣金 + 印花税 + 过户费，由 tradingEngine 计算），
 * 明细以括号小字展示，避免拆成多列后与需求列不一致。
 */
function TradesTable({ trades }: { trades: TradeInfo[] }) {
  if (trades.length === 0) {
    return <EmptyHint text="暂无成交记录。" />;
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成交时间</TableHead>
                <TableHead>股票</TableHead>
                <TableHead>方向</TableHead>
                <TableHead className="text-right">成交价格</TableHead>
                <TableHead className="text-right">成交数量</TableHead>
                <TableHead className="text-right">成交金额</TableHead>
                <TableHead className="text-right">手续费</TableHead>
                <TableHead className="text-right">已实现盈亏</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                    {t.tradedAt}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/stocks/${t.stockCode}`} className="hover:underline">
                      {t.stockName}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground tabular">
                      {t.stockCode}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.side === "BUY" ? "up" : "down"}>
                      {t.side === "BUY" ? "买入" : "卖出"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatNumber(t.price, 2)}
                  </TableCell>
                  <TableCell className="text-right tabular">{t.quantity}</TableCell>
                  <TableCell className="text-right tabular">
                    {formatMoney(t.amount)}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatNumber(t.totalFee, 2)}
                    <div className="text-[10px] text-muted-foreground">
                      佣 {formatNumber(t.commission, 2)} · 印 {formatNumber(t.stampTax, 2)} ·
                      过 {formatNumber(t.transferFee, 2)}
                    </div>
                  </TableCell>
                  <TableCell className={cn("text-right tabular", pnlColorClass(t.realizedPnl))}>
                    {t.side === "SELL"
                      ? `${t.realizedPnl > 0 ? "+" : ""}${formatMoney(t.realizedPnl)}`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ 收益分析 ============================ */

function PerformancePanel({
  perf,
  loading,
}: {
  perf: PerformancePayload | null;
  loading: boolean;
}) {
  if (loading) {
    return <EmptyHint text="收益数据加载中…" />;
  }
  if (!perf || perf.curve.length === 0) {
    return (
      <EmptyHint text="暂无净值数据。完成至少一笔交易并生成每日资产快照后可见。" />
    );
  }

  const m = perf.metrics;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="累计收益率"
          value={formatPercent(m.totalReturn)}
          cls={pnlColorClass(m.totalReturn)}
        />
        <MetricCard
          label="年化收益率"
          value={formatPercent(m.annualReturn)}
          cls={pnlColorClass(m.annualReturn)}
        />
        <MetricCard
          label="最大回撤"
          value={`-${formatNumber(Math.abs(m.maxDrawdown), 2)}%`}
          cls="text-emerald-500"
          hint={
            m.maxDrawdownStart && m.maxDrawdownEnd
              ? `${m.maxDrawdownStart} → ${m.maxDrawdownEnd}`
              : undefined
          }
        />
        <MetricCard
          label="夏普比率"
          value={formatNumber(m.sharpeRatio, 2)}
          hint={`波动率 ${formatNumber(m.volatility, 2)}%`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            净值曲线
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {m.tradingDays} 个交易日 · 期初 {formatMoney(m.initialAsset)} → 期末{" "}
              {formatMoney(m.finalAsset)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EquityChart points={toEquityPoints(perf.curve)} height={360} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">每日资产快照</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[420px] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead className="text-right">现金</TableHead>
                  <TableHead className="text-right">持仓市值</TableHead>
                  <TableHead className="text-right">总资产</TableHead>
                  <TableHead className="text-right">当日收益</TableHead>
                  <TableHead className="text-right">累计收益率</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...perf.curve].reverse().map((d) => (
                  <TableRow key={d.date}>
                    <TableCell className="tabular">{d.date}</TableCell>
                    <TableCell className="text-right tabular">
                      {formatMoney(d.cash)}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {formatMoney(d.marketValue)}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {formatMoney(d.totalAsset)}
                    </TableCell>
                    <TableCell
                      className={cn("text-right tabular", pnlColorClass(d.dailyReturn))}
                    >
                      {d.dailyReturn > 0 ? "+" : ""}
                      {formatPercent(d.dailyReturn)}
                    </TableCell>
                    <TableCell
                      className={cn("text-right tabular", pnlColorClass(d.totalReturn))}
                    >
                      {d.totalReturn > 0 ? "+" : ""}
                      {formatPercent(d.totalReturn)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  label,
  value,
  cls,
  hint,
}: {
  label: string;
  value: string;
  cls?: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn("mt-2 text-2xl font-semibold tabular", cls)}>{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground tabular">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex min-h-[160px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {text}
    </div>
  );
}
