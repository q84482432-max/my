"use client";

import * as React from "react";
import type {
  BacktestDetail,
  BacktestEvent,
  BacktestEventType,
  BacktestRoundTrip,
  BacktestStrategyId,
  BacktestSummary,
  BacktestTrade,
} from "@/types";
import {
  cn,
  formatMoney,
  formatNumber,
  formatPercent,
  pnlColorClass,
} from "@/lib/utils";
import { DEFAULT_INITIAL_CASH } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import KlineChart from "@/components/charts/KlineChart";
import BacktestEquityChart from "@/components/charts/BacktestEquityChart";
import BacktestDrawdownChart from "@/components/charts/BacktestDrawdownChart";

/* ------------------------------------------------------------------ */
/*                              工具                                   */
/* ------------------------------------------------------------------ */

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  return (await res.json()) as T;
}

const EVENT_META: Record<
  BacktestEventType,
  { label: string; cls: string; title: string }
> = {
  GOLDEN_CROSS: {
    label: "金叉",
    cls: "border-red-300 bg-red-50 text-red-700",
    title: "MA 快线上穿慢线（信号在收盘产生）",
  },
  DEATH_CROSS: {
    label: "死叉",
    cls: "border-green-300 bg-green-50 text-green-700",
    title: "MA 快线下穿慢线（信号在收盘产生）",
  },
  BUY: {
    label: "买入",
    cls: "border-red-400 bg-red-100 text-red-800",
    title: "以次日开盘价买入成交",
    },
  SELL: {
    label: "卖出",
    cls: "border-green-400 bg-green-100 text-green-800",
    title: "以次日开盘价卖出成交",
  },
  SKIP: {
    label: "未成交",
    cls: "border-zinc-300 bg-zinc-100 text-zinc-600",
    title: "信号未被执行（资金不足 / 空仓 / 已到区间末尾）",
  },
};

/* ------------------------------------------------------------------ */
/*                          主组件                                     */
/* ------------------------------------------------------------------ */

/**
 * 策略回测客户端（第一批：MA5 / MA20 金叉死叉）。
 *
 * 数据全部来自 `/api/backtest`：
 *  - POST 运行回测（引擎读真实日K，纯内存推演）并落库；
 *  - GET/:id 读取历史结果（K 线按记录区间现取，不落第二份）。
 * 页面**只做展示**，不含任何交易规则计算 —— 费用、盈亏、指标全部由
 * BacktestEngine 计算后返回，避免前端与引擎口径漂移。
 */
export default function BacktestClient() {
  /* ------------------------------ 表单 ------------------------------ */
  const [symbol, setSymbol] = React.useState("000001");
  const [pickedName, setPickedName] = React.useState<string | null>("平安银行");
  const [startDate, setStartDate] = React.useState("2024-11-04");
  const [endDate, setEndDate] = React.useState("2026-09-10");
  const [initialCash, setInitialCash] = React.useState(String(DEFAULT_INITIAL_CASH));
  const [fast, setFast] = React.useState("5");
  const [slow, setSlow] = React.useState("20");
  const [name, setName] = React.useState("");

  /* ------------------------------ 状态 ------------------------------ */
  const [detail, setDetail] = React.useState<BacktestDetail | null>(null);
  const [history, setHistory] = React.useState<BacktestSummary[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [dataWindow, setDataWindow] = React.useState<{
    startDate: string | null;
    endDate: string | null;
  }>({ startDate: null, endDate: null });

  /* --------------------------- 股票搜索 --------------------------- */
  const [keyword, setKeyword] = React.useState("");
  const [results, setResults] = React.useState<
    { code: string; name: string; adjust: string }[]
  >([]);
  const [searching, setSearching] = React.useState(false);

  const loadHistory = React.useCallback(async () => {
    const json = await api<{ success: boolean; data?: BacktestSummary[]; message?: string }>(
      "/api/backtest",
    );
    if (!json.success) {
      setMsg({ kind: "err", text: json.message ?? "加载回测历史失败" });
      return;
    }
    setHistory(json.data ?? []);
  }, []);

  // 数据窗口：默认区间取自库内真实日K 覆盖范围（不硬编码）
  React.useEffect(() => {
    void (async () => {
      try {
        const json = await api<{
          success: boolean;
          stats?: { startDate: string | null; endDate: string | null };
        }>("/api/market?limit=1");
        if (json.success && json.stats) {
          setDataWindow(json.stats);
          if (json.stats.startDate) setStartDate(json.stats.startDate);
          if (json.stats.endDate) setEndDate(json.stats.endDate);
        }
      } catch {
        /* 保持默认值 */
      }
    })();
    void loadHistory();
  }, [loadHistory]);

  const doSearch = React.useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    try {
      const json = await api<{
        success: boolean;
        data?: { code: string; name: string; adjust: string }[];
        message?: string;
      }>(`/api/stocks?keyword=${encodeURIComponent(kw)}&pageSize=15&withQuote=false`);
      if (!json.success) {
        setMsg({ kind: "err", text: json.message ?? "搜索失败" });
        setResults([]);
        return;
      }
      setResults(json.data ?? []);
    } finally {
      setSearching(false);
    }
  }, [keyword]);

  /* ---------------------------- 历史详情 ---------------------------- */
  const loadDetail = React.useCallback(async (id: string) => {
    const json = await api<{
      success: boolean;
      data?: BacktestDetail;
      message?: string;
    }>(`/api/backtest/${id}`);
    if (!json.success || !json.data) {
      setMsg({ kind: "err", text: json.message ?? "加载回测详情失败" });
      return;
    }
    const d = json.data;
    setDetail(d);
    setSymbol(d.symbol);
    setPickedName(d.stockName);
    setStartDate(d.startDate);
    setEndDate(d.endDate);
    setInitialCash(String(d.initialCash));
    setFast(String(d.params.fast));
    setSlow(String(d.params.slow));
    setName(d.name);
  }, []);

  /* ---------------------------- 运行回测 ---------------------------- */
  const runBacktest = React.useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message: string;
        id?: string;
        data?: BacktestDetail;
      }>("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: symbol.trim(),
          startDate,
          endDate,
          initialCash: Number(initialCash),
          strategy: "MA_CROSS" as BacktestStrategyId,
          params: { fast: Number(fast), slow: Number(slow) },
          name: name.trim() || undefined,
        }),
      });

      if (!json.success) {
        setMsg({ kind: "err", text: json.message });
        return;
      }
      setMsg({ kind: "ok", text: json.message });
      if (json.id) {
        await loadDetail(json.id);
        await loadHistory();
      }
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [
    symbol,
    startDate,
    endDate,
    initialCash,
    fast,
    slow,
    name,
    loadDetail,
    loadHistory,
  ]);

  const removeHistory = React.useCallback(
    async (id: string) => {
      const json = await api<{ success: boolean; message: string }>(
        `/api/backtest/${id}`,
        { method: "DELETE" },
      );
      if (!json.success) {
        setMsg({ kind: "err", text: json.message });
        return;
      }
      setDetail((prev) => (prev?.id === id ? null : prev));
      setMsg({ kind: "ok", text: json.message });
      await loadHistory();
    },
    [loadHistory],
  );

  const m = detail?.metrics;

  return (
    <div className="space-y-5">
      {/* ============================ 参数区 ============================ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            回测参数
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              第一批策略：MA 快慢线金叉 / 死叉（信号在 T 日收盘产生，T+1 开盘成交）
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            {/* 股票选择 */}
            <div className="space-y-3 rounded-md border p-3">
              <div>
                <Label className="text-xs">回测标的</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    value={keyword}
                    placeholder="输入代码或名称搜索，如 000001 / 平安"
                    onChange={(e) => setKeyword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doSearch();
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void doSearch()}
                    disabled={searching}
                  >
                    {searching ? "搜索中…" : "搜索"}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">当前标的：</span>
                <Badge variant="secondary" className="tabular">
                  {symbol || "—"}
                </Badge>
                <span className="font-medium">{pickedName ?? "未指定名称"}</span>
                <span className="text-xs text-muted-foreground">
                  （回测结束会以库内名称为准）
                </span>
              </div>

              {results.length > 0 && (
                <div className="max-h-44 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        <TableHead>代码</TableHead>
                        <TableHead>名称</TableHead>
                        <TableHead className="text-right">复权口径</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.map((r) => (
                        <TableRow
                          key={r.code}
                          className={cn(
                            "cursor-pointer",
                            symbol === r.code && "bg-accent/60",
                          )}
                          onClick={() => {
                            setSymbol(r.code);
                            setPickedName(r.name);
                          }}
                        >
                          <TableCell className="tabular">{r.code}</TableCell>
                          <TableCell>{r.name}</TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {r.adjust}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                库内真实日K 覆盖：
                {dataWindow.startDate
                  ? `${dataWindow.startDate} ~ ${dataWindow.endDate}`
                  : "读取中…"}
              </p>
            </div>

            {/* 参数表单 */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">开始日期</Label>
                <Input
                  className="mt-1"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  placeholder="YYYY-MM-DD"
                />
              </div>
              <div>
                <Label className="text-xs">结束日期</Label>
                <Input
                  className="mt-1"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  placeholder="YYYY-MM-DD"
                />
              </div>
              <div>
                <Label className="text-xs">初始资金（元）</Label>
                <Input
                  className="mt-1"
                  value={initialCash}
                  onChange={(e) => setInitialCash(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">策略</Label>
                <Input className="mt-1" value="MA 金叉死叉（MA_CROSS）" readOnly />
              </div>
              <div>
                <Label className="text-xs">快线周期（默认 5）</Label>
                <Input
                  className="mt-1"
                  value={fast}
                  onChange={(e) => setFast(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">慢线周期（默认 20）</Label>
                <Input
                  className="mt-1"
                  value={slow}
                  onChange={(e) => setSlow(e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs">备注名称（可选）</Label>
                <Input
                  className="mt-1"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="留空则自动生成"
                />
              </div>
              <div className="flex items-end sm:col-span-2">
                <Button onClick={() => void runBacktest()} disabled={busy}>
                  {busy ? "回测中…" : "运行回测"}
                </Button>
              </div>
            </div>
          </div>

          {msg && (
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-sm",
                msg.kind === "ok"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "border-red-300 bg-red-50 text-red-700",
              )}
            >
              {msg.text}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ============================ 结果区 ============================ */}
      {detail && m && (
        <>
          {/* 警告 */}
          {detail.warnings.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p className="mb-1 font-medium">回测提示</p>
              <ul className="list-disc space-y-1 pl-5">
                {detail.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 概览 */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6 text-sm">
              <span>
                <span className="text-muted-foreground">记录：</span>
                {detail.name}
              </span>
              <span>
                <span className="text-muted-foreground">策略：</span>MA
                {detail.params.fast} / MA{detail.params.slow}（{detail.strategy}）
              </span>
              <span>
                <span className="text-muted-foreground">区间：</span>
                {detail.firstBarDate} ~ {detail.lastBarDate}
              </span>
              <span>
                <span className="text-muted-foreground">交易日：</span>
                {detail.barCount}
              </span>
              <span>
                <span className="text-muted-foreground">均线预热：</span>
                {detail.warmupBars} 根
              </span>
              <span>
                <span className="text-muted-foreground">首个信号：</span>
                {detail.firstSignalDate ?? "无"}
              </span>
              <span>
                <span className="text-muted-foreground">复权口径：</span>
                {detail.adjust}
              </span>
              <Badge variant="outline" className="text-xs">
                成交模型 {detail.executionModel}（信号次日开盘成交）
              </Badge>
            </CardContent>
          </Card>

          {/* 九项核心指标 */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <StatCard
              label="总收益率"
              value={
                <span className={pnlColorClass(m.totalReturn)}>
                  {formatPercent(m.totalReturn)}
                </span>
              }
              hint={`${formatMoney(m.initialAsset)} → ${formatMoney(m.finalAsset)}`}
            />
            <StatCard
              label="年化收益率"
              value={
                <span className={pnlColorClass(m.annualReturn)}>
                  {formatPercent(m.annualReturn)}
                </span>
              }
              hint={`按 ${m.tradingDays} 交易日折算（244/年）`}
            />
            <StatCard
              label="最大回撤"
              value={
                <span className="text-stock-down">
                  {m.maxDrawdown.toFixed(2)}%
                </span>
              }
              hint={
                m.maxDrawdownStart && m.maxDrawdownEnd
                  ? `${m.maxDrawdownStart} → ${m.maxDrawdownEnd}`
                  : "无回撤区间"
              }
            />
            <StatCard
              label="交易次数"
              value={`${m.tradeCount} 次`}
              hint={`盈利 ${m.winCount} / 亏损 ${m.lossCount}${
                m.flatCount > 0 ? ` / 持平 ${m.flatCount}` : ""
              }`}
            />
            <StatCard
              label="胜率"
              value={`${formatNumber(m.winRate, 2)}%`}
              hint={`${m.winCount} / ${m.tradeCount}`}
            />
            <StatCard
              label="平均盈利"
              value={
                <span className="text-stock-up">
                  {m.winCount > 0 ? formatMoney(m.avgWin) : "—"}
                </span>
              }
              hint={`累计盈利 ${formatMoney(m.totalWin)}`}
            />
            <StatCard
              label="平均亏损"
              value={
                <span className="text-stock-down">
                  {m.lossCount > 0 ? formatMoney(m.avgLoss) : "—"}
                </span>
              }
              hint={`累计亏损 ${formatMoney(m.totalLoss)}`}
            />
            <StatCard
              label="盈亏比"
              value={
                m.profitFactor === null
                  ? "∞"
                  : formatNumber(m.profitFactor, 2)
              }
              hint={
                m.profitFactor === null
                  ? "无亏损单（数学上为无穷）"
                  : `赔率 ${m.payoffRatio === null ? "∞" : formatNumber(m.payoffRatio, 2)}（平均盈利/平均亏损）`
              }
            />
            <StatCard
              label="夏普比率"
              value={formatNumber(m.sharpeRatio, 2)}
              hint={`年化波动率 ${formatNumber(m.volatility, 2)}%`}
            />
            <StatCard
              label="买入持有基准"
              value={
                detail.benchmark ? (
                  <span className={pnlColorClass(detail.benchmark.returnPercent)}>
                    {formatPercent(detail.benchmark.returnPercent)}
                  </span>
                ) : (
                  "—"
                )
              }
              hint={
                detail.benchmark
                  ? `同期同费用口径 · ${m.totalReturn >= detail.benchmark.returnPercent ? "策略跑赢基准" : "策略跑输基准"}`
                  : "区间过短，无法建仓对照"
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="期末资产"
              value={formatMoney(m.finalAsset)}
              hint={`初始 ${formatMoney(m.initialAsset)}`}
            />
            <StatCard
              label="累计手续费"
              value={formatMoney(m.totalFee)}
              hint={`占初始资金 ${formatNumber(m.feeRatio, 2)}%`}
            />
            <StatCard
              label="平均持有"
              value={`${formatNumber(m.avgHoldDays, 2)} 个交易日`}
              hint={`共 ${m.tradeCount} 次配对往返`}
            />
            <StatCard
              label="成交笔数"
              value={`${detail.trades.length} 笔`}
              hint={`买卖点标记 ${detail.markers.length} 个`}
            />
          </div>

          {/* 资金曲线 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                资金曲线
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  总资产按当日收盘价估值；虚线为初始资金与买入持有期末参考
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BacktestEquityChart
                points={detail.equityCurve}
                initialCash={detail.initialCash}
                benchmarkFinalAsset={detail.benchmark?.finalAsset ?? null}
              />
            </CardContent>
          </Card>

          {/* 回撤曲线 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                回撤曲线
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  运行峰值只向后看，曲线最低点 = 最大回撤 {m.maxDrawdown.toFixed(2)}%
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BacktestDrawdownChart points={detail.drawdownCurve} />
            </CardContent>
          </Card>

          {/* K线 + 买卖点 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                K 线图与买卖点
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  红色▲ = 买入（信号次日开盘成交），绿色▼ = 卖出；均线 MA
                  {detail.params.fast}/MA{detail.params.slow} 可在图例中开关
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <KlineChart
                bars={detail.bars}
                markers={detail.markers}
                height={520}
                zoomStart={0}
                zoomEnd={100}
              />
            </CardContent>
          </Card>

          {/* 明细 */}
          <Tabs defaultValue="trades">
            <TabsList>
              <TabsTrigger value="trades">
                交易明细 <span className="ml-1 text-xs opacity-70">{detail.trades.length}</span>
              </TabsTrigger>
              <TabsTrigger value="rounds">
                配对往返 <span className="ml-1 text-xs opacity-70">{detail.roundTrips.length}</span>
              </TabsTrigger>
              <TabsTrigger value="events">
                事件日志 <span className="ml-1 text-xs opacity-70">{detail.events.length}</span>
              </TabsTrigger>
              <TabsTrigger value="equity">
                每日净值 <span className="ml-1 text-xs opacity-70">{detail.equityCurve.length}</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="trades">
              <TradesTable trades={detail.trades} />
            </TabsContent>
            <TabsContent value="rounds">
              <RoundTripsTable rows={detail.roundTrips} />
            </TabsContent>
            <TabsContent value="events">
              <EventsTable events={detail.events} />
            </TabsContent>
            <TabsContent value="equity">
              <EquityTable detail={detail} />
            </TabsContent>
          </Tabs>
        </>
      )}

      {/* ============================ 历史记录 ============================ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            回测历史 <span className="ml-1 text-xs opacity-70">{history.length}</span>
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              与模拟交易系统完全隔离，回测不读写任何账户 / 持仓 / 委托 / 成交表
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              暂无回测记录，先运行一次回测吧
            </p>
          ) : (
            <div className="max-h-[420px] overflow-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>记录</TableHead>
                    <TableHead>标的</TableHead>
                    <TableHead className="text-right">区间</TableHead>
                    <TableHead className="text-right">初始资金</TableHead>
                    <TableHead className="text-right">总收益率</TableHead>
                    <TableHead className="text-right">年化</TableHead>
                    <TableHead className="text-right">最大回撤</TableHead>
                    <TableHead className="text-right">胜率</TableHead>
                    <TableHead className="text-right">夏普</TableHead>
                    <TableHead className="text-right">交易</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((h) => (
                    <TableRow
                      key={h.id}
                      className={cn(
                        "cursor-pointer",
                        detail?.id === h.id && "bg-accent/60",
                      )}
                      onClick={() => void loadDetail(h.id)}
                    >
                      <TableCell className="max-w-[220px] truncate text-xs">
                        {h.name}
                        <div className="text-[10px] text-muted-foreground tabular">
                          {new Date(h.createdAt).toLocaleString("zh-CN")}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {h.stockName ?? h.symbol}
                        <div className="text-[10px] text-muted-foreground tabular">
                          {h.symbol} · MA{h.params.fast}/{h.params.slow}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular">
                        {h.startDate}
                        <div className="text-[10px] text-muted-foreground">
                          {h.endDate}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {formatMoney(h.initialCash, 0)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular",
                          h.totalReturn === null
                            ? ""
                            : pnlColorClass(h.totalReturn),
                        )}
                      >
                        {h.totalReturn === null ? "—" : formatPercent(h.totalReturn)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular",
                          h.annualReturn === null
                            ? ""
                            : pnlColorClass(h.annualReturn),
                        )}
                      >
                        {h.annualReturn === null ? "—" : formatPercent(h.annualReturn)}
                      </TableCell>
                      <TableCell className="text-right tabular text-stock-down">
                        {h.maxDrawdown === null
                          ? "—"
                          : `${h.maxDrawdown.toFixed(2)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {h.winRate === null ? "—" : `${h.winRate.toFixed(2)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {h.sharpeRatio === null ? "—" : h.sharpeRatio.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {h.tradeCount}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeHistory(h.id);
                          }}
                        >
                          删除
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*                            子组件                                   */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-2 text-xl font-semibold tabular">{value}</p>
        {hint && (
          <p className="mt-1 text-xs text-muted-foreground tabular">{hint}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** 交易明细（仅成交笔） —— 对应「记录每一次：价格 / 数量 / 手续费 / 成交 / 现金 / 持仓 / 资产」 */
function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  if (trades.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        区间内没有产生任何成交
      </p>
    );
  }
  return (
    <div className="max-h-[520px] overflow-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead className="text-right">#</TableHead>
            <TableHead>成交日</TableHead>
            <TableHead>信号日</TableHead>
            <TableHead>方向</TableHead>
            <TableHead className="text-right">成交价</TableHead>
            <TableHead className="text-right">数量</TableHead>
            <TableHead className="text-right">成交金额</TableHead>
            <TableHead className="text-right">手续费</TableHead>
            <TableHead className="text-right">费用拆分</TableHead>
            <TableHead className="text-right">实现盈亏</TableHead>
            <TableHead className="text-right">成交后现金</TableHead>
            <TableHead className="text-right">成交后持仓</TableHead>
            <TableHead className="text-right">成本均价</TableHead>
            <TableHead className="text-right">成交后总资产</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((t) => (
            <TableRow key={t.seq}>
              <TableCell className="text-right tabular">{t.seq}</TableCell>
              <TableCell className="tabular">{t.date}</TableCell>
              <TableCell className="tabular text-xs text-muted-foreground">
                {t.signalDate}
              </TableCell>
              <TableCell>
                <span
                  className={cn(
                    "font-medium",
                    t.side === "BUY" ? "text-stock-up" : "text-stock-down",
                  )}
                >
                  {t.side === "BUY" ? "买入" : "卖出"}
                </span>
              </TableCell>
              <TableCell className="text-right tabular">
                {formatNumber(t.price, 2)}
              </TableCell>
              <TableCell className="text-right tabular">{t.quantity}</TableCell>
              <TableCell className="text-right tabular">
                {formatMoney(t.amount)}
              </TableCell>
              <TableCell className="text-right tabular">
                {formatNumber(t.fee, 2)}
              </TableCell>
              <TableCell className="text-right text-xs tabular text-muted-foreground">
                {formatNumber(t.feeDetail.commission, 2)}/
                {formatNumber(t.feeDetail.stampTax, 2)}/
                {formatNumber(t.feeDetail.transferFee, 2)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right tabular",
                  t.realizedPnl === null ? "" : pnlColorClass(t.realizedPnl),
                )}
              >
                {t.realizedPnl === null
                  ? "—"
                  : `${t.realizedPnl > 0 ? "+" : ""}${formatNumber(t.realizedPnl, 2)}`}
              </TableCell>
              <TableCell className="text-right tabular">
                {formatMoney(t.cash)}
              </TableCell>
              <TableCell className="text-right tabular">{t.positionQty}</TableCell>
              <TableCell className="text-right tabular">
                {t.positionQty > 0 ? formatNumber(t.positionAvgCost, 4) : "—"}
              </TableCell>
              <TableCell className="text-right tabular">
                {formatMoney(t.totalAsset)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** 配对往返（一买一卖为一笔完整交易） —— 胜率 / 平均盈亏 / 盈亏比的计算基础 */
function RoundTripsTable({ rows }: { rows: BacktestRoundTrip[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        没有完成的配对往返（区间内买卖未成对）
      </p>
    );
  }
  return (
    <div className="max-h-[520px] overflow-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead className="text-right">#</TableHead>
            <TableHead>买入日</TableHead>
            <TableHead className="text-right">买入价</TableHead>
            <TableHead>卖出日</TableHead>
            <TableHead className="text-right">卖出价</TableHead>
            <TableHead className="text-right">数量</TableHead>
            <TableHead className="text-right">持有(交易日)</TableHead>
            <TableHead className="text-right">买入费用</TableHead>
            <TableHead className="text-right">卖出费用</TableHead>
            <TableHead className="text-right">合计费用</TableHead>
            <TableHead className="text-right">盈亏</TableHead>
            <TableHead className="text-right">盈亏率</TableHead>
            <TableHead className="text-right">结果</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.seq}>
              <TableCell className="text-right tabular">{r.seq}</TableCell>
              <TableCell className="tabular">{r.entryDate}</TableCell>
              <TableCell className="text-right tabular">
                {formatNumber(r.entryPrice, 2)}
              </TableCell>
              <TableCell className="tabular">{r.exitDate}</TableCell>
              <TableCell className="text-right tabular">
                {formatNumber(r.exitPrice, 2)}
              </TableCell>
              <TableCell className="text-right tabular">{r.quantity}</TableCell>
              <TableCell className="text-right tabular">
                {r.holdBars}
                <span className="ml-1 text-[10px] text-muted-foreground">
                  ({r.holdDays}自然日)
                </span>
              </TableCell>
              <TableCell className="text-right tabular">
                {formatNumber(r.buyFee, 2)}
              </TableCell>
              <TableCell className="text-right tabular">
                {formatNumber(r.sellFee, 2)}
              </TableCell>
              <TableCell className="text-right tabular">
                {formatNumber(r.totalFee, 2)}
              </TableCell>
              <TableCell className={cn("text-right tabular", pnlColorClass(r.pnl))}>
                {r.pnl > 0 ? "+" : ""}
                {formatNumber(r.pnl, 2)}
              </TableCell>
              <TableCell className={cn("text-right tabular", pnlColorClass(r.pnl))}>
                {formatPercent(r.pnlPercent)}
              </TableCell>
              <TableCell className="text-right">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs",
                    r.win
                      ? "border-red-300 bg-red-50 text-red-700"
                      : r.pnl < 0
                        ? "border-green-300 bg-green-50 text-green-700"
                        : "border-zinc-300 bg-zinc-100 text-zinc-600",
                  )}
                >
                  {r.win ? "盈利" : r.pnl < 0 ? "亏损" : "持平"}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** 逐笔事件日志（信号 + 成交 + 跳过），带账户状态快照 */
function EventsTable({ events }: { events: BacktestEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        区间内没有任何事件（信号或成交）
      </p>
    );
  }
  return (
    <div className="max-h-[520px] overflow-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead className="text-right">#</TableHead>
            <TableHead>日期</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>说明</TableHead>
            <TableHead className="text-right">价格</TableHead>
            <TableHead className="text-right">数量</TableHead>
            <TableHead className="text-right">手续费</TableHead>
            <TableHead className="text-right">现金</TableHead>
            <TableHead className="text-right">持仓</TableHead>
            <TableHead className="text-right">总资产</TableHead>
            <TableHead className="text-right">MA快/慢</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e) => {
            const meta = EVENT_META[e.type];
            return (
              <TableRow key={e.seq}>
                <TableCell className="text-right tabular">{e.seq}</TableCell>
                <TableCell className="tabular">{e.date}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn("text-xs", meta.cls)}
                    title={meta.title}
                  >
                    {meta.label}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[320px] text-xs">{e.reason}</TableCell>
                <TableCell className="text-right tabular">
                  {formatNumber(e.price, 2)}
                </TableCell>
                <TableCell className="text-right tabular">
                  {e.quantity || "—"}
                </TableCell>
                <TableCell className="text-right tabular">
                  {e.fee > 0 ? formatNumber(e.fee, 2) : "—"}
                </TableCell>
                <TableCell className="text-right tabular">
                  {formatMoney(e.cash)}
                </TableCell>
                <TableCell className="text-right tabular">{e.positionQty}</TableCell>
                <TableCell className="text-right tabular">
                  {formatMoney(e.totalAsset)}
                </TableCell>
                <TableCell className="text-right text-xs tabular text-muted-foreground">
                  {e.maFast === null
                    ? "—"
                    : `${e.maFast.toFixed(2)} / ${e.maSlow?.toFixed(2) ?? "—"}`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** 每日净值（资金曲线的表格形式） */
function EquityTable({ detail }: { detail: BacktestDetail }) {
  const rows = detail.equityCurve;
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">暂无净值数据</p>
    );
  }
  return (
    <div className="max-h-[520px] overflow-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead>日期</TableHead>
            <TableHead className="text-right">收盘价</TableHead>
            <TableHead className="text-right">现金</TableHead>
            <TableHead className="text-right">持仓</TableHead>
            <TableHead className="text-right">持仓市值</TableHead>
            <TableHead className="text-right">总资产</TableHead>
            <TableHead className="text-right">净值</TableHead>
            <TableHead className="text-right">当日收益率</TableHead>
            <TableHead className="text-right">累计收益率</TableHead>
            <TableHead className="text-right">回撤</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => {
            const dd = detail.drawdownCurve.find((d) => d.date === p.date);
            return (
              <TableRow key={p.date}>
                <TableCell className="tabular">{p.date}</TableCell>
                <TableCell className="text-right tabular">
                  {formatNumber(p.close, 2)}
                </TableCell>
                <TableCell className="text-right tabular">
                  {formatMoney(p.cash)}
                </TableCell>
                <TableCell className="text-right tabular">{p.positionQty}</TableCell>
                <TableCell className="text-right tabular">
                  {formatMoney(p.marketValue)}
                </TableCell>
                <TableCell className="text-right tabular">
                  {formatMoney(p.totalAsset)}
                </TableCell>
                <TableCell className="text-right tabular">
                  {p.nav.toFixed(4)}
                </TableCell>
                <TableCell
                  className={cn("text-right tabular", pnlColorClass(p.dailyReturn))}
                >
                  {formatPercent(p.dailyReturn)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular",
                    pnlColorClass(p.returnPercent),
                  )}
                >
                  {formatPercent(p.returnPercent)}
                </TableCell>
                <TableCell className="text-right tabular text-stock-down">
                  {dd ? `${dd.drawdownPercent.toFixed(2)}%` : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
