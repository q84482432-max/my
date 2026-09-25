"use client";

import * as React from "react";
import Link from "next/link";
import type {
  KlineBar,
  KlinePeriod,
  OrderSide,
  OrderType,
  StockInfo,
  StockQuote,
} from "@/types";
import { cn, formatMoney, formatNumber, formatVolume, pnlColorClass } from "@/lib/utils";
import { EXCHANGE_LABELS, BOARD_LABELS, PERIOD_LABELS, ADJUST_LABELS } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import KlineChart from "@/components/charts/KlineChart";

interface StockDetailProps {
  stock: StockInfo;
  quote: StockQuote | null;
  initialBars: KlineBar[];
  initialPeriod: KlinePeriod;
  initialBarCount: number;
}

const PERIODS: KlinePeriod[] = ["1d", "1w", "1M"];

/**
 * 股票详情客户端组件
 *
 * 职责：
 *  - 展示股票基础信息与最新行情（真实历史数据）
 *  - 周期切换时向 /api/stocks/[code]/klines 拉取对应周期K线
 *  - 提供下单面板，调用 /api/account/orders（交易逻辑全在服务端 tradingEngine）
 *
 * 本组件不包含任何交易规则实现，仅做表单与展示。
 */
export default function StockDetail({
  stock,
  quote,
  initialBars,
  initialPeriod,
  initialBarCount,
}: StockDetailProps) {
  const [period, setPeriod] = React.useState<KlinePeriod>(initialPeriod);
  const [bars, setBars] = React.useState<KlineBar[]>(initialBars);
  const [loading, setLoading] = React.useState(false);
  const [barCount, setBarCount] = React.useState(initialBarCount);

  // 下单表单状态
  const [side, setSide] = React.useState<OrderSide>("BUY");
  const [orderType, setOrderType] = React.useState<OrderType>("MARKET");
  const [priceInput, setPriceInput] = React.useState<string>(
    quote ? String(quote.lastPrice) : "",
  );
  const [qtyInput, setQtyInput] = React.useState<string>("100");
  /**
   * 模拟交易日（可选）。留空 = 以最新交易日收盘价成交。
   * 选择更早的交易日可模拟「买入 → 次日卖出」的完整 T+1 往返。
   */
  const [tradeDateInput, setTradeDateInput] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // 周期切换：拉取真实K线（日K 由服务端聚合为周/月K）
  const switchPeriod = React.useCallback(
    async (next: KlinePeriod) => {
      if (next === period && bars.length > 0) return;
      setPeriod(next);
      setLoading(true);
      try {
        const res = await fetch(
          `/api/stocks/${stock.code}/klines?period=${next}&adjust=${stock.adjust}&limit=2000`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          success: boolean;
          data?: KlineBar[];
          message?: string;
        };
        if (json.success && json.data) {
          setBars(json.data);
          setBarCount(json.data.length);
        } else {
          setBars([]);
          setBarCount(0);
        }
      } catch {
        setBars([]);
        setBarCount(0);
      } finally {
        setLoading(false);
      }
    },
    [period, bars.length, stock.code, stock.adjust],
  );

  // 理论金额估算（仅用于展示提示，真实费用由服务端计算）
  const estPrice = orderType === "MARKET" ? (quote?.lastPrice ?? 0) : Number(priceInput) || 0;
  const estQty = Number(qtyInput) || 0;
  const estAmount = estPrice * estQty;

  const submitOrder = async () => {
    setFeedback(null);

    if (!Number.isInteger(estQty) || estQty <= 0) {
      setFeedback({ ok: false, message: "委托数量必须为正整数" });
      return;
    }
    if (orderType === "LIMIT" && !(Number(priceInput) > 0)) {
      setFeedback({ ok: false, message: "限价单必须填写有效价格" });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/account/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stockCode: stock.code,
          side,
          orderType,
          price: orderType === "LIMIT" ? Number(priceInput) : undefined,
          quantity: estQty,
          // 留空则由服务端按最新交易日成交
          tradeDate: tradeDateInput || undefined,
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        trade?: { price: number; quantity: number };
      };
      setFeedback({
        ok: json.success,
        message:
          json.message ??
          (json.success ? "委托已成交" : "委托失败"),
      });
      if (json.success && json.trade) {
        setQtyInput("100");
      }
    } catch (err) {
      setFeedback({ ok: false, message: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const changeClass = quote ? pnlColorClass(quote.change) : "";
  const changeSign = quote && quote.change > 0 ? "+" : "";

  return (
    <div className="space-y-6">
      {/* 头部：股票信息 + 最新行情 */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{stock.name}</h1>
            <span className="text-lg text-muted-foreground tabular">{stock.code}</span>
            <Badge variant="outline">{EXCHANGE_LABELS[stock.exchange]}</Badge>
            <Badge variant="secondary">{BOARD_LABELS[stock.board]}</Badge>
          </div>
          {quote && (
            <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
              {/* 左：最新价（大字）+ 涨跌额 / 涨跌幅 */}
              <div className="flex flex-wrap items-baseline gap-4">
                <span className={cn("text-3xl font-semibold tabular", changeClass)}>
                  {formatNumber(quote.lastPrice, 2)}
                </span>
                <span className={cn("text-base tabular", changeClass)}>
                  {changeSign}
                  {formatNumber(quote.change, 2)} ({changeSign}
                  {formatNumber(quote.changePercent, 2)}%)
                </span>
              </div>

              {/* 右：高 / 低 / 开（顺序与用户给出的案例图一致）
                  按「与前收比较」着色 —— 行情软件惯例，能让用户一眼看出
                  当日是跳空高开还是低开。无前收数据时退化为中性色。 */}
              <div className="grid w-[92px] shrink-0 grid-cols-1 gap-y-0.5 text-xs">
                {(
                  [
                    ["高", quote.high],
                    ["低", quote.low],
                    ["开", quote.open],
                  ] as const
                ).map(([label, v]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3">
                    <span className="text-muted-foreground">{label}</span>
                    <span
                      className={cn(
                        "tabular font-medium",
                        v > 0 && quote.prevClose > 0
                          ? pnlColorClass(v - quote.prevClose)
                          : "text-muted-foreground",
                      )}
                    >
                      {v > 0 ? formatNumber(v, 2) : "--"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {quote && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>
                最新交易日{" "}
                <span className="tabular text-foreground">
                  {quote.lastDate ?? "—"}
                </span>
              </span>
              <span>
                成交量{" "}
                <span className="tabular text-foreground">
                  {formatVolume(quote.volume)}股
                </span>
              </span>
              <span>
                成交额{" "}
                <span className="tabular text-foreground">
                  ¥{formatVolume(quote.amount)}
                </span>
              </span>
              <span>
                较前一交易日{" "}
                <span className="tabular text-foreground">
                  {formatNumber(quote.prevClose, 2)}
                </span>{" "}
                收盘
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/">返回行情中心</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/account">模拟账户</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* 左：K线图 */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              K线图
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {PERIOD_LABELS[period]} · {barCount} 根
              </span>
            </CardTitle>
            <div className="flex gap-1 rounded-md border p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => switchPeriod(p)}
                  className={cn(
                    "rounded px-3 py-1 text-xs transition-colors",
                    p === period
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <KlineChart bars={bars} period={period} height={460} loading={loading} />
            <p className="mt-3 text-xs text-muted-foreground">
              数据来源：本机导入的真实历史日K。周K / 月K 由日K实时聚合得出
              （open 取周期首个交易日、close 取最后一个交易日、high/low 取周期极值、
              volume/amount 求和），不额外读取周月线数据。复权口径：
              {ADJUST_LABELS[stock.adjust] ?? stock.adjust}。
            </p>
          </CardContent>
        </Card>

        {/* 右：下单面板 */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">模拟下单</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 买卖方向 */}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={side === "BUY" ? "buy" : "outline"}
                  size="sm"
                  onClick={() => setSide("BUY")}
                >
                  买入
                </Button>
                <Button
                  variant={side === "SELL" ? "sell" : "outline"}
                  size="sm"
                  onClick={() => setSide("SELL")}
                >
                  卖出
                </Button>
              </div>

              {/* 委托类型 */}
              <div>
                <Label className="text-xs">委托类型</Label>
                <div className="mt-1.5 flex gap-1 rounded-md border p-0.5">
                  {(["MARKET", "LIMIT"] as OrderType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setOrderType(t)}
                      className={cn(
                        "flex-1 rounded px-2 py-1 text-xs transition-colors",
                        t === orderType
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {t === "MARKET" ? "市价（最新收盘价）" : "限价"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label htmlFor="price" className="text-xs">
                  委托价格
                </Label>
                <Input
                  id="price"
                  type="number"
                  step="0.01"
                  className="tabular"
                  value={priceInput}
                  disabled={orderType === "MARKET"}
                  onChange={(e) => setPriceInput(e.target.value)}
                />
                {orderType === "MARKET" && quote && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    市价单按最新收盘价 {formatNumber(quote.lastPrice, 2)} 成交
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="qty" className="text-xs">
                  委托数量（股，100 股整数倍）
                </Label>
                <Input
                  id="qty"
                  type="number"
                  step="100"
                  min="100"
                  className="tabular"
                  value={qtyInput}
                  onChange={(e) => setQtyInput(e.target.value)}
                />
                <div className="mt-1.5 flex gap-1">
                  {[100, 500, 1000, 2000].map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setQtyInput(String(q))}
                      className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label htmlFor="tradeDate" className="text-xs">
                  模拟交易日（可选）
                </Label>
                <Input
                  id="tradeDate"
                  type="date"
                  className="tabular"
                  value={tradeDateInput}
                  onChange={(e) => setTradeDateInput(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  留空 = 按最新交易日 {quote?.lastDate ?? "—"} 收盘价成交。
                  选择更早的交易日可模拟「买入 → 次日卖出」的 T+1 往返
                  （买入后需到「模拟账户」执行一次 T+1 结算）。
                </p>
              </div>

              <div className="rounded-md bg-muted/50 p-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">预估金额</span>
                  <span className="tabular">{formatMoney(estAmount)}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-muted-foreground">预估数量</span>
                  <span className="tabular">{estQty} 股</span>
                </div>
                <p className="mt-2 text-muted-foreground">
                  实际费用（佣金万三最低5元 / 印花税千一卖出 / 过户费万0.1）由服务端计算。
                </p>
              </div>

              <Button
                className="w-full"
                variant={side === "BUY" ? "buy" : "sell"}
                disabled={submitting || !quote}
                onClick={submitOrder}
              >
                {submitting ? "提交中…" : side === "BUY" ? "买入下单" : "卖出下单"}
              </Button>

              {feedback && (
                <div
                  className={cn(
                    "rounded-md border p-2 text-xs",
                    feedback.ok
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "border-destructive/40 bg-destructive/10 text-destructive",
                  )}
                >
                  {feedback.message}
                </div>
              )}

              {!quote && (
                <p className="text-xs text-destructive">
                  该股票暂无行情数据，无法下单。请先确认已导入对应K线。
                </p>
              )}
            </CardContent>
          </Card>

          {/* 基础资料 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">基础资料</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <InfoRow label="代码" value={stock.code} mono />
              <InfoRow label="名称" value={stock.name} />
              <InfoRow label="交易所" value={EXCHANGE_LABELS[stock.exchange]} />
              <InfoRow label="板块" value={BOARD_LABELS[stock.board]} />
              <InfoRow label="行业" value={stock.industry ?? "—"} />
              <InfoRow label="上市日期" value={stock.listDate ?? "—"} mono />
              <InfoRow label="状态" value={stock.isActive ? "正常交易" : "已停牌"} />
              <InfoRow
                label="复权口径"
                value={ADJUST_LABELS[stock.adjust] ?? stock.adjust}
              />
              <InfoRow
                label="数据窗口"
                value={
                  stock.windowStart && stock.windowEnd
                    ? `${stock.windowStart} ~ ${stock.windowEnd}`
                    : "—"
                }
                mono
              />
              <InfoRow label="日K根数" value={`${stock.barCount} 根`} mono />
              <InfoRow
                label="窗口完整性"
                value={stock.fullWindow ? "覆盖完整窗口" : "不足（次新股）"}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(mono && "tabular")}>{value}</span>
    </div>
  );
}
