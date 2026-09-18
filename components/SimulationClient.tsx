"use client";

import * as React from "react";
import type {
  EquityPoint,
  KlineBar,
  KlinePeriod,
  SimulationInfo,
  SimulationQuote,
  SimulationSnapshot,
} from "@/types";
import {
  cn,
  formatMoney,
  formatNumber,
  formatPercent,
  pnlColorClass,
} from "@/lib/utils";
import { ORDER_STATUS_LABELS } from "@/lib/constants";
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
import EquityChart from "@/components/charts/EquityChart";
import KlineChart from "@/components/charts/KlineChart";

/* ------------------------------------------------------------------ */
/*                              工具                                   */
/* ------------------------------------------------------------------ */

/** DailyAsset 曲线 → 净值点（以首日为基准归一化，不估算填充） */
function toEquityPoints(curve: SimulationSnapshot["curve"]): EquityPoint[] {
  if (curve.length === 0) return [];
  const base = curve[0].totalAsset || 1;
  return curve.map((d) => ({
    date: d.date,
    totalAsset: d.totalAsset,
    nav: +(d.totalAsset / base).toFixed(6),
    returnPercent: d.totalReturn,
  }));
}

/** 缓存安全的 JSON 请求 */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const json = (await res.json()) as T;
  return json;
}

/* ------------------------------------------------------------------ */
/*                          主组件                                     */
/* ------------------------------------------------------------------ */

/**
 * 历史模拟交易客户端。
 *
 * 防未来数据泄露（前端侧约束）：
 *  - 所有行情/持仓/账户数据均来自 `/api/sim/*`，其右端点由服务端按会话
 *    `currentDate` 强制，前端不传任何日期参数（下单日期也由服务端决定）。
 *  - 本页**不提供**跳转到 `/stocks/[code]` 的链接 —— 那是实时行情视图，
 *    会直接泄露未来数据；因此股票名称一律以纯文本展示，K 线也只走
 *    模拟专用接口（强制 endDate = currentDate）。
 */
export default function SimulationClient() {
  const [sims, setSims] = React.useState<SimulationInfo[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<SimulationSnapshot | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 创建表单（默认值即用户示例区间）
  const [form, setForm] = React.useState({
    startDate: "2025-09-11",
    endDate: "2026-09-11",
    initialCash: "100000",
  });

  /* ------------------------------ 加载 ------------------------------ */

  const loadList = React.useCallback(async () => {
    const json = await api<{ success: boolean; data?: SimulationInfo[]; message?: string }>(
      "/api/sim",
    );
    if (!json.success) {
      setMsg({ kind: "err", text: json.message ?? "加载模拟列表失败" });
      return;
    }
    const list = json.data ?? [];
    setSims(list);
    setSelectedId((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  const loadSnapshot = React.useCallback(async (id: string) => {
    const json = await api<{
      success: boolean;
      data?: SimulationSnapshot;
      message?: string;
    }>(`/api/sim/${id}`);
    if (!json.success || !json.data) {
      setMsg({ kind: "err", text: json.message ?? "加载模拟快照失败" });
      return;
    }
    setSnapshot(json.data);
  }, []);

  React.useEffect(() => {
    void loadList();
  }, [loadList]);

  React.useEffect(() => {
    if (!selectedId) {
      setSnapshot(null);
      return;
    }
    void loadSnapshot(selectedId);
  }, [selectedId, loadSnapshot]);

  /* ------------------------------ 操作 ------------------------------ */

  const createSim = React.useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message?: string;
        simulation?: SimulationInfo;
      }>("/api/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: form.startDate,
          endDate: form.endDate,
          initialCash: Number(form.initialCash),
        }),
      });
      if (!json.success) {
        setMsg({ kind: "err", text: json.message ?? "创建失败" });
        return;
      }
      setMsg({ kind: "ok", text: json.message ?? "创建成功" });
      await loadList();
      if (json.simulation) setSelectedId(json.simulation.id);
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [form, loadList]);

  const nextDay = React.useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message?: string;
        finished?: boolean;
        snapshot?: SimulationSnapshot;
      }>(`/api/sim/${selectedId}/next`, { method: "POST" });
      if (!json.success) {
        setMsg({ kind: "err", text: json.message ?? "推进失败" });
        return;
      }
      setMsg({ kind: "ok", text: json.message ?? "已推进" });
      if (json.snapshot) setSnapshot(json.snapshot);
      await loadList();
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedId, loadList]);

  const removeSim = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setMsg(null);
      try {
        const json = await api<{ success: boolean; message?: string }>(`/api/sim/${id}`, {
          method: "DELETE",
        });
        if (!json.success) {
          setMsg({ kind: "err", text: json.message ?? "删除失败" });
          return;
        }
        setMsg({ kind: "ok", text: json.message ?? "已删除" });
        if (selectedId === id) {
          setSelectedId(null);
          setSnapshot(null);
        }
        await loadList();
      } catch (err) {
        setMsg({ kind: "err", text: (err as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [selectedId, loadList],
  );

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <div className="space-y-6">
      <CreatePanel
        form={form}
        setForm={setForm}
        onCreate={createSim}
        busy={busy}
      />

      {msg && (
        <div
          className={cn(
            "rounded-md border p-3 text-sm",
            msg.kind === "err"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "bg-muted/40",
          )}
        >
          {msg.text}
        </div>
      )}

      {sims.length > 0 && (
        <SessionList
          sims={sims}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDelete={removeSim}
          busy={busy}
        />
      )}

      {!snapshot && sims.length === 0 && (
        <div className="flex min-h-[160px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          还没有历史模拟会话。选择开始 / 结束日期与初始资金后点击「创建模拟」。
        </div>
      )}

      {snapshot && (
        <>
          <DayBar
            sim={snapshot.simulation}
            busy={busy}
            onNext={nextDay}
          />
          <MetricsRow snapshot={snapshot} />
          <SimTabs
            snapshot={snapshot}
            busy={busy}
            onTraded={(next) => {
              setSnapshot(next);
              void loadList();
            }}
            onMessage={setMsg}
          />
        </>
      )}
    </div>
  );
}

/* ============================ 创建面板 ============================ */

function CreatePanel({
  form,
  setForm,
  onCreate,
  busy,
}: {
  form: { startDate: string; endDate: string; initialCash: string };
  setForm: React.Dispatch<
    React.SetStateAction<{ startDate: string; endDate: string; initialCash: string }>
  >;
  onCreate: () => void;
  busy: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          新建历史模拟
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            按真实历史交易日逐日推进，只能看到当前交易日及以前的行情
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="sim-start">开始日期</Label>
            <Input
              id="sim-start"
              type="date"
              className="w-[170px]"
              value={form.startDate}
              onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sim-end">结束日期</Label>
            <Input
              id="sim-end"
              type="date"
              className="w-[170px]"
              value={form.endDate}
              onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sim-cash">初始资金</Label>
            <Input
              id="sim-cash"
              type="number"
              min={1}
              step={1000}
              className="w-[150px]"
              value={form.initialCash}
              onChange={(e) => setForm((f) => ({ ...f, initialCash: e.target.value }))}
            />
          </div>
          <Button onClick={onCreate} disabled={busy}>
            {busy ? "处理中…" : "创建模拟"}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          开始日期会向后对齐到区间内第一个真实交易日；系统会固化区间内的真实交易日历，
          「下一交易日」严格按该日历推进，不会落到周末或节假日。
        </p>
      </CardContent>
    </Card>
  );
}

/* ============================ 会话列表 ============================ */

function SessionList({
  sims,
  selectedId,
  onSelect,
  onDelete,
  busy,
}: {
  sims: SimulationInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          模拟会话 <span className="ml-1 text-xs opacity-70">{sims.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>区间</TableHead>
                <TableHead className="text-right">初始资金</TableHead>
                <TableHead>当前交易日</TableHead>
                <TableHead className="text-right">进度</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sims.map((s) => (
                <TableRow
                  key={s.id}
                  className={cn(s.id === selectedId && "bg-accent/50")}
                >
                  <TableCell className="max-w-[220px] truncate whitespace-nowrap">
                    {s.name}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                    {s.startDate} ~ {s.endDate}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatMoney(s.initialCash)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular">{s.currentDate}</TableCell>
                  <TableCell className="text-right tabular">
                    {s.dayIndex} / {s.totalDays}
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.status === "ACTIVE" ? "up" : "flat"}>
                      {s.status === "ACTIVE" ? "进行中" : "已结束"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant={s.id === selectedId ? "secondary" : "outline"}
                      size="sm"
                      className="mr-2"
                      onClick={() => onSelect(s.id)}
                    >
                      {s.id === selectedId ? "当前" : "查看"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm("删除该模拟会话及其全部交易数据？此操作不可撤销。")) {
                          onDelete(s.id);
                        }
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
      </CardContent>
    </Card>
  );
}

/* ============================ 交易日条 ============================ */

function DayBar({
  sim,
  busy,
  onNext,
}: {
  sim: SimulationInfo;
  busy: boolean;
  onNext: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 pt-6">
        <div>
          <p className="text-xs text-muted-foreground">当前模拟交易日</p>
          <p className="text-2xl font-semibold tabular">{sim.currentDate}</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <p>
            第 <span className="tabular">{sim.dayIndex}</span> / {sim.totalDays} 个交易日
          </p>
          <p>下一交易日：{sim.nextDate ?? "（已到区间末尾）"}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {sim.status !== "ACTIVE" && (
            <Badge variant="flat">已结束</Badge>
          )}
          <Button
            onClick={onNext}
            disabled={busy || sim.status !== "ACTIVE"}
            title="按真实交易日推进到下一日：执行 T+1 结算、推进行情可见上界、重算资产"
          >
            {busy ? "推进中…" : "下一交易日 →"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ 指标卡 ============================ */

function MetricsRow({ snapshot }: { snapshot: SimulationSnapshot }) {
  const { summary, metrics, dailyPnl, dailyReturn } = snapshot;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard label="总资产" value={formatMoney(summary.totalAsset)} hint={`期初 ${formatMoney(summary.initialCash)}`} />
      <StatCard
        label="可用资金"
        value={formatMoney(summary.availableCash)}
        hint={`现金总额 ${formatMoney(summary.cash)}`}
      />
      <StatCard label="持仓市值" value={formatMoney(summary.marketValue)} hint="按当前交易日收盘价" />
      <StatCard
        label="当日盈亏"
        value={
          <span className={pnlColorClass(dailyPnl)}>
            {dailyPnl > 0 ? "+" : ""}
            {formatMoney(dailyPnl)}
          </span>
        }
        hint={<span className={pnlColorClass(dailyReturn)}>{formatPercent(dailyReturn)}</span>}
      />
      <StatCard
        label="累计收益"
        value={
          <span className={pnlColorClass(summary.totalProfit)}>
            {summary.totalProfit > 0 ? "+" : ""}
            {formatMoney(summary.totalProfit)}
          </span>
        }
        hint={
          <span className={pnlColorClass(summary.totalProfitRate)}>
            {formatPercent(summary.totalProfitRate)}
          </span>
        }
      />
      <StatCard
        label="最大回撤"
        value={`-${formatNumber(Math.abs(metrics.maxDrawdown), 2)}%`}
        cls="text-emerald-500"
        hint={
          metrics.maxDrawdownStart && metrics.maxDrawdownEnd
            ? `${metrics.maxDrawdownStart} → ${metrics.maxDrawdownEnd}`
            : "尚无回撤区间"
        }
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  cls,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  cls?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn("mt-2 text-xl font-semibold tabular", cls)}>{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground tabular">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/* ============================ 标签页 ============================ */

function SimTabs({
  snapshot,
  busy,
  onTraded,
  onMessage,
}: {
  snapshot: SimulationSnapshot;
  busy: boolean;
  onTraded: (next: SimulationSnapshot) => void;
  onMessage: (m: { kind: "ok" | "err"; text: string } | null) => void;
}) {
  const { positions, orders, trades, curve } = snapshot;

  return (
    <Tabs defaultValue="trade">
      <TabsList>
        <TabsTrigger value="trade">做交易</TabsTrigger>
        <TabsTrigger value="positions">
          持仓 <span className="ml-1 text-xs opacity-70">{positions.length}</span>
        </TabsTrigger>
        <TabsTrigger value="orders">
          委托 <span className="ml-1 text-xs opacity-70">{orders.length}</span>
        </TabsTrigger>
        <TabsTrigger value="trades">
          成交 <span className="ml-1 text-xs opacity-70">{trades.length}</span>
        </TabsTrigger>
        <TabsTrigger value="curve">每日资产</TabsTrigger>
      </TabsList>

      <TabsContent value="trade">
        <TradePanel
          simulationId={snapshot.simulation.id}
          currentDate={snapshot.simulation.currentDate}
          status={snapshot.simulation.status}
          busy={busy}
          onTraded={onTraded}
          onMessage={onMessage}
        />
      </TabsContent>

      <TabsContent value="positions">
        <SimPositionsTable positions={positions} />
      </TabsContent>

      <TabsContent value="orders">
        <SimOrdersTable orders={orders} />
      </TabsContent>

      <TabsContent value="trades">
        <SimTradesTable trades={trades} />
      </TabsContent>

      <TabsContent value="curve">
        <CurvePanel curve={curve} />
      </TabsContent>
    </Tabs>
  );
}

/* ============================ 交易面板 ============================ */

function TradePanel({
  simulationId,
  currentDate,
  status,
  busy,
  onTraded,
  onMessage,
}: {
  simulationId: string;
  currentDate: string;
  status: SimulationInfo["status"];
  busy: boolean;
  onTraded: (next: SimulationSnapshot) => void;
  onMessage: (m: { kind: "ok" | "err"; text: string } | null) => void;
}) {
  const [keyword, setKeyword] = React.useState("");
  const [results, setResults] = React.useState<SimulationQuote[]>([]);
  const [selected, setSelected] = React.useState<SimulationQuote | null>(null);
  const [side, setSide] = React.useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = React.useState<"MARKET" | "LIMIT">("MARKET");
  const [price, setPrice] = React.useState("");
  const [quantity, setQuantity] = React.useState("100");
  const [searching, setSearching] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; text: string } | null>(null);

  // 默认搜索：给出若干标的，避免空白
  React.useEffect(() => {
    void (async () => {
      setSearching(true);
      try {
        const json = await api<{
          success: boolean;
          currentDate?: string;
          data?: SimulationQuote[];
        }>(`/api/sim/${simulationId}/stocks?q=&limit=20`);
        if (json.success) setResults(json.data ?? []);
      } finally {
        setSearching(false);
      }
    })();
  }, [simulationId, currentDate]);

  const doSearch = React.useCallback(async () => {
    setSearching(true);
    try {
      const json = await api<{
        success: boolean;
        data?: SimulationQuote[];
        message?: string;
      }>(`/api/sim/${simulationId}/stocks?q=${encodeURIComponent(keyword)}&limit=20`);
      if (!json.success) {
        onMessage({ kind: "err", text: json.message ?? "搜索失败" });
        return;
      }
      setResults(json.data ?? []);
    } finally {
      setSearching(false);
    }
  }, [simulationId, keyword, onMessage]);

  const submit = React.useCallback(async () => {
    if (!selected) {
      setResult({ ok: false, text: "请先选择股票" });
      return;
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setResult({ ok: false, text: "数量必须为正整数" });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const json = await api<{
        success: boolean;
        message?: string;
        trade?: { price: number; quantity: number; totalFee: number };
        snapshot?: SimulationSnapshot;
      }>(`/api/sim/${simulationId}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stockCode: selected.code,
          side,
          orderType,
          price: orderType === "LIMIT" ? Number(price) : undefined,
          quantity: qty,
          // 成交日不由前端指定：服务端强制为 currentDate
        }),
      });
      if (!json.success) {
        setResult({ ok: false, text: json.message ?? "下单失败" });
        return;
      }
      const t = json.trade;
      setResult({
        ok: true,
        text:
          `${side === "BUY" ? "买入" : "卖出"}成交：${selected.name}（${selected.code}）` +
          (t ? ` ${t.quantity} 股 @ ${formatNumber(t.price, 2)}，手续费 ${formatNumber(t.totalFee, 2)}` : "") +
          `；成交日 ${currentDate}`,
      });
      if (json.snapshot) onTraded(json.snapshot);
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }, [
    simulationId,
    selected,
    side,
    orderType,
    price,
    quantity,
    currentDate,
    onTraded,
  ]);

  const disabled = busy || submitting || status !== "ACTIVE";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* 左：搜索 + 结果 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            行情（截至 {currentDate}）
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              只显示当前交易日及以前的行情，不含未来数据
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              placeholder="输入代码或名称，如 000001 / 平安"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doSearch();
              }}
            />
            <Button variant="outline" onClick={() => void doSearch()} disabled={searching}>
              {searching ? "搜索中…" : "搜索"}
            </Button>
          </div>

          <div className="max-h-[360px] overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>代码</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="text-right">现价</TableHead>
                  <TableHead className="text-right">涨跌幅</TableHead>
                  <TableHead className="text-right">行情日</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                      {searching ? "加载中…" : "无匹配结果"}
                    </TableCell>
                  </TableRow>
                )}
                {results.map((r) => (
                  <TableRow
                    key={r.code}
                    className={cn(
                      "cursor-pointer",
                      selected?.code === r.code && "bg-accent/60",
                    )}
                    onClick={() => {
                      setSelected(r);
                      setPrice(String(r.close || ""));
                    }}
                  >
                    <TableCell className="tabular">{r.code}</TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className="text-right tabular">
                      {r.close > 0 ? formatNumber(r.close, 2) : "—"}
                    </TableCell>
                    <TableCell
                      className={cn("text-right tabular", pnlColorClass(r.changePercent))}
                    >
                      {r.close > 0 ? formatPercent(r.changePercent) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular">
                      {r.lastDate ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {selected && (
            <SimKlinePanel simulationId={simulationId} code={selected.code} name={selected.name} />
          )}
        </CardContent>
      </Card>

      {/* 右：下单 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">下单（成交日 {currentDate}）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            {selected ? (
              <>
                <p className="font-medium">
                  {selected.name}
                  <span className="ml-2 text-xs text-muted-foreground tabular">
                    {selected.code}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground tabular">
                  现价 {selected.close > 0 ? formatNumber(selected.close, 2) : "—"}（
                  {selected.lastDate ?? "无行情"}）· 昨收{" "}
                  {formatNumber(selected.prevClose, 2)}
                </p>
                {selected.close <= 0 && (
                  <p className="mt-1 text-xs text-destructive">
                    该股在当前交易日之前无行情，无法交易
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">请先在左侧选择股票</p>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              variant={side === "BUY" ? "buy" : "outline"}
              className="flex-1"
              onClick={() => setSide("BUY")}
            >
              买入
            </Button>
            <Button
              variant={side === "SELL" ? "sell" : "outline"}
              className="flex-1"
              onClick={() => setSide("SELL")}
            >
              卖出
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label>委托类型</Label>
            <div className="flex gap-2">
              <Button
                variant={orderType === "MARKET" ? "secondary" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => setOrderType("MARKET")}
              >
                市价（当日收盘价）
              </Button>
              <Button
                variant={orderType === "LIMIT" ? "secondary" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => setOrderType("LIMIT")}
              >
                限价
              </Button>
            </div>
          </div>

          {orderType === "LIMIT" && (
            <div className="space-y-1.5">
              <Label htmlFor="sim-price">委托价</Label>
              <Input
                id="sim-price"
                type="number"
                step={0.01}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="sim-qty">数量（股）</Label>
            <Input
              id="sim-qty"
              type="number"
              step={100}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              买入须为 100 股整数倍；卖出可含零股（清仓）。
            </p>
          </div>

          <Button className="w-full" onClick={() => void submit()} disabled={disabled || !selected}>
            {submitting ? "提交中…" : `确认${side === "BUY" ? "买入" : "卖出"}`}
          </Button>

          {result && (
            <div
              className={cn(
                "rounded-md border p-2 text-xs",
                result.ok
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {result.text}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            成交价、费用、T+1 与资金校验全部由服务端交易引擎计算；成交日固定为当前模拟交易日。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ============================ K 线（模拟专用） ============================ */

function SimKlinePanel({
  simulationId,
  code,
  name,
}: {
  simulationId: string;
  code: string;
  name: string;
}) {
  const [period, setPeriod] = React.useState<KlinePeriod>("1d");
  const [bars, setBars] = React.useState<KlineBar[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const json = await api<{ success: boolean; data?: KlineBar[] }>(
          `/api/sim/${simulationId}/stocks/${code}/klines?period=${period}&limit=240`,
        );
        if (!cancelled && json.success) setBars(json.data ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [simulationId, code, period, open]);

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm">
          K线 <span className="text-xs text-muted-foreground">{name} {code}</span>
        </span>
        <div className="flex items-center gap-2">
          {open &&
            (["1d", "1w", "1M"] as KlinePeriod[]).map((p) => (
              <Button
                key={p}
                variant={period === p ? "secondary" : "outline"}
                size="sm"
                onClick={() => setPeriod(p)}
              >
                {p === "1d" ? "日" : p === "1w" ? "周" : "月"}
              </Button>
            ))}
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "收起" : "展开"}
          </Button>
        </div>
      </div>
      {open && (
        <div className="p-2">
          <KlineChart bars={bars} period={period} height={320} loading={loading} />
        </div>
      )}
    </div>
  );
}

/* ============================ 三视图表格 ============================ */

/**
 * 持仓表。
 * 注意：股票名称一律纯文本，不链到 `/stocks/[code]`（那会展示全部未来行情）。
 */
function SimPositionsTable({ positions }: { positions: SimulationSnapshot["positions"] }) {
  if (positions.length === 0) {
    return <EmptyHint text="当前交易日暂无持仓。" />;
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
                  <TableCell className="whitespace-nowrap font-medium">{p.stockName}</TableCell>
                  <TableCell className="tabular text-muted-foreground">{p.stockCode}</TableCell>
                  <TableCell className="text-right tabular">{p.quantity}</TableCell>
                  <TableCell className="text-right tabular">
                    {p.availableQty}
                    {p.availableQty === 0 && p.quantity > 0 && (
                      <span className="ml-1 text-[10px] text-muted-foreground">(T+1)</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular">{formatNumber(p.avgCost, 3)}</TableCell>
                  <TableCell className="text-right tabular">{formatNumber(p.lastPrice, 2)}</TableCell>
                  <TableCell className="text-right tabular">{formatMoney(p.marketValue)}</TableCell>
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

function SimOrdersTable({ orders }: { orders: SimulationSnapshot["orders"] }) {
  if (orders.length === 0) return <EmptyHint text="暂无委托记录。" />;
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
                    <TableCell className="font-mono text-[11px] text-muted-foreground" title={o.id}>
                      {o.id}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {o.stockName}
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
                    <TableCell className="text-xs">
                      {ORDER_STATUS_LABELS[o.status] ?? o.status}
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

function SimTradesTable({ trades }: { trades: SimulationSnapshot["trades"] }) {
  if (trades.length === 0) return <EmptyHint text="暂无成交记录。" />;
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
                    {t.stockName}
                    <span className="ml-2 text-xs text-muted-foreground tabular">
                      {t.stockCode}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.side === "BUY" ? "up" : "down"}>
                      {t.side === "BUY" ? "买入" : "卖出"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular">{formatNumber(t.price, 2)}</TableCell>
                  <TableCell className="text-right tabular">{t.quantity}</TableCell>
                  <TableCell className="text-right tabular">{formatMoney(t.amount)}</TableCell>
                  <TableCell className="text-right tabular">
                    {formatNumber(t.totalFee, 2)}
                    <div className="text-[10px] text-muted-foreground">
                      佣 {formatNumber(t.commission, 2)} · 印 {formatNumber(t.stampTax, 2)} · 过{" "}
                      {formatNumber(t.transferFee, 2)}
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

/* ============================ 每日资产 ============================ */

function CurvePanel({ curve }: { curve: SimulationSnapshot["curve"] }) {
  if (curve.length === 0) return <EmptyHint text="暂无每日资产快照。" />;
  const points = toEquityPoints(curve);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            净值曲线
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {curve.length} 个交易日 · 期初 {formatMoney(curve[0].totalAsset)} → 期末{" "}
              {formatMoney(curve[curve.length - 1].totalAsset)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EquityChart points={points} height={340} />
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
                {[...curve].reverse().map((d) => (
                  <TableRow key={d.date}>
                    <TableCell className="tabular">{d.date}</TableCell>
                    <TableCell className="text-right tabular">{formatMoney(d.cash)}</TableCell>
                    <TableCell className="text-right tabular">
                      {formatMoney(d.marketValue)}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {formatMoney(d.totalAsset)}
                    </TableCell>
                    <TableCell className={cn("text-right tabular", pnlColorClass(d.dailyReturn))}>
                      {d.dailyReturn > 0 ? "+" : ""}
                      {formatPercent(d.dailyReturn)}
                    </TableCell>
                    <TableCell className={cn("text-right tabular", pnlColorClass(d.totalReturn))}>
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

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex min-h-[160px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {text}
    </div>
  );
}
