"use client";

import * as React from "react";
import type {
  EquityPoint,
  SimTradeAction,
  SimTradeInfo,
  SimTradeReveal,
  SimTradeSnapshot,
} from "@/types";
import { cn, formatMoney, formatNumber, formatPercent, pnlColorClass } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import KlineChart from "@/components/charts/KlineChart";
import EquityChart from "@/components/charts/EquityChart";

/* ------------------------------------------------------------------ */
/*                              工具                                   */
/* ------------------------------------------------------------------ */

/** 缓存安全的 JSON 请求 */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  return (await res.json()) as T;
}

/** DailyAsset 曲线 → 净值点（以首日为基准归一化，不估算填充） */
function toEquityPoints(curve: SimTradeSnapshot["curve"]): EquityPoint[] {
  if (curve.length === 0) return [];
  const base = curve[0].totalAsset || 1;
  return curve.map((d) => ({
    date: d.date,
    totalAsset: d.totalAsset,
    nav: +(d.totalAsset / base).toFixed(6),
    returnPercent: d.totalReturn,
  }));
}

/** 当日操作类型 → 中文文案（仅用于结算/记录展示） */
const ACTION_NAME: Record<SimTradeAction, string> = {
  BUY: "买入",
  SELL: "卖出",
  HOLD: "观望",
};

/** 比例档位（买入 / 卖出 共用：10 / 30 / 50 / 100；HOLD 比例固定为 0） */
const RATIOS = [10, 30, 50, 100] as const;

/**
 * 当日盈亏（原计算口径，不可改动）：
 * 当日总资产 − 上一交易日总资产（首日为初始资金）。
 */
function calcDailyPnl(snapshot: SimTradeSnapshot): { pnl: number; ret: number } {
  const curve = snapshot.curve;
  const last = curve.length > 0 ? curve[curve.length - 1] : null;
  const prevAsset =
    curve.length >= 2 ? curve[curve.length - 2].totalAsset : snapshot.session.initialCash;
  const pnl = last ? last.totalAsset - prevAsset : 0;
  const ret = last ? last.dailyReturn : 0;
  return { pnl, ret };
}

/* ------------------------------------------------------------------ */
/*                          主组件                                     */
/* ------------------------------------------------------------------ */

/**
 * 模拟炒股（猜股票）客户端。
 *
 * 玩法：服务端随机隐藏一只真实历史个股，玩家只看得到 K 线与价格，
 * 凭盘感做多，最终与「买入持有」比收益。
 *
 * 防未来数据泄露（前端侧约束）：
 *  - 所有行情/持仓/账户数据均来自 `/api/simtrade/*`，可见上界由服务端按会话
 *    `currentDate` 强制，前端不传任何日期参数（下单日期也由服务端决定）。
 *  - 本页**不提供**跳转到 `/stocks/[code]` 的链接；K 线只走模拟专用接口，
 *    当日 K 线仅含开盘价（服务端已抹去 high/low/close）。
 *  - 标的身份在揭晓前不存在于任何数据中（连「未知」占位也不需要）。
 */
export default function SimTradeClient() {
  const [sessions, setSessions] = React.useState<SimTradeInfo[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<SimTradeSnapshot | null>(null);
  const [reveal, setReveal] = React.useState<SimTradeReveal | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 创建参数
  const [initialCash, setInitialCash] = React.useState("100000");
  const [tradingDays, setTradingDays] = React.useState("22");

  // 待确认的操作（交易确认机制：选择 → 确认 → 推进收盘）
  const [pending, setPending] = React.useState<{ action: SimTradeAction; percent: number } | null>(
    null,
  );

  /* ------------------------------ 加载 ------------------------------ */

  const loadList = React.useCallback(async () => {
    const json = await api<{ success: boolean; data?: SimTradeInfo[]; message?: string }>(
      "/api/simtrade",
    );
    if (!json.success) {
      setMsg({ kind: "err", text: json.message ?? "加载列表失败" });
      return;
    }
    const list = json.data ?? [];
    setSessions(list);
    setSelectedId((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  const loadSnapshot = React.useCallback(async (id: string) => {
    const json = await api<{ success: boolean; data?: SimTradeSnapshot; message?: string }>(
      `/api/simtrade/${id}`,
    );
    if (!json.success || !json.data) {
      setMsg({ kind: "err", text: json.message ?? "加载快照失败" });
      return;
    }
    setSnapshot(json.data);
    setReveal(null);
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

  /**
   * 切换会话即清空待确认操作，避免「串单」：
   * 上一局选了一半的动作不会带到新会话。独立 effect，不改动既有函数体。
   */
  React.useEffect(() => {
    setPending(null);
  }, [selectedId]);

  /* ------------------------------ 操作 ------------------------------ */

  const createSession = React.useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        session?: SimTradeInfo;
        message: string;
      }>("/api/simtrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initialCash: Number(initialCash) || 100000,
          tradingDays: Number(tradingDays) || 22,
        }),
      });
      if (!json.success || !json.session) {
        setMsg({ kind: "err", text: json.message ?? "创建失败" });
        return;
      }
      setMsg({ kind: "ok", text: json.message });
      setSelectedId(json.session.id);
      await loadList();
      await loadSnapshot(json.session.id);
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [initialCash, tradingDays, loadList, loadSnapshot]);

  const deleteSession = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setMsg(null);
      try {
        const json = await api<{ success: boolean; message: string }>(`/api/simtrade/${id}`, {
          method: "DELETE",
        });
        setMsg(json.success ? { kind: "ok", text: json.message } : { kind: "err", text: json.message });
        if (selectedId === id) setSelectedId(null);
        await loadList();
      } finally {
        setBusy(false);
      }
    },
    [selectedId, loadList],
  );

  /**
   * 阶段一：确认今日操作（按今日收盘价成交，停留当日，不推进日期）。
   * 服务端在返回快照中把 confirmedDate 置为今日、tradable 置为 false、
   * lastAction 指向今日已结算的成交记录。
   */
  const confirmAction = React.useCallback(async () => {
    if (!selectedId || !pending) return;
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message: string;
        finished?: boolean;
        snapshot?: SimTradeSnapshot;
      }>(`/api/simtrade/${selectedId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: pending.action, percent: pending.percent }),
      });
      if (!json.success) {
        setMsg({ kind: "err", text: json.message });
        return;
      }
      setMsg({ kind: "ok", text: json.message });
      setPending(null);
      if (json.snapshot) setSnapshot(json.snapshot);
      else await loadSnapshot(selectedId);
      await loadList();
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedId, pending, loadSnapshot, loadList]);

  /**
   * 阶段二：推进到下一交易日（T+1 结算 + currentDate 前进 + 清空确认态）。
   * 仅在 confirmedToday = true 时可调用；最后一日的推进将触发最终结算。
   */
  const advanceDay = React.useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message: string;
        finished?: boolean;
        snapshot?: SimTradeSnapshot;
      }>(`/api/simtrade/${selectedId}/next`, { method: "POST" });
      if (!json.success) {
        setMsg({ kind: "err", text: json.message });
        return;
      }
      setMsg({ kind: "ok", text: json.message });
      setPending(null);
      if (json.snapshot) setSnapshot(json.snapshot);
      else await loadSnapshot(selectedId);
      await loadList();
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedId, loadSnapshot, loadList]);

  const doReveal = React.useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message: string;
        reveal?: SimTradeReveal;
      }>(`/api/simtrade/${selectedId}/reveal`, { method: "POST" });
      if (!json.success || !json.reveal) {
        setMsg({ kind: "err", text: json.message });
        return;
      }
      setReveal(json.reveal);
      setMsg({ kind: "ok", text: json.message });
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedId]);

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <div className="space-y-3 pb-40 md:space-y-4 md:pb-6">
      {/* 次级菜单：创建配置 + 会话切换（折叠即返回页面，不删除任何数据） */}
      <details className="group rounded-lg border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium">
          <span>创建新局 / 切换会话</span>
          <span className="text-[10px] text-muted-foreground">点击展开 ▾</span>
        </summary>
        <div className="space-y-3 border-t px-3 py-3">
          {/* 创建配置 */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28">
              <Label htmlFor="st-cash" className="text-[10px] text-muted-foreground">
                初始资金
              </Label>
              <Input
                id="st-cash"
                inputMode="numeric"
                value={initialCash}
                onChange={(e) => setInitialCash(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="w-24">
              <Label htmlFor="st-days" className="text-[10px] text-muted-foreground">
                交易日数
              </Label>
              <Input
                id="st-days"
                inputMode="numeric"
                value={tradingDays}
                onChange={(e) => setTradingDays(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <Button className="h-8" size="sm" onClick={createSession} disabled={busy}>
              开始一局
            </Button>
          </div>

          {/* 会话切换（多局时） */}
          {sessions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    s.id === selectedId
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {s.status === "FINISHED" ? "已结束" : `${s.dayIndex}/${s.totalDays}`}
                  <span className="ml-1.5 text-[10px] opacity-70">{s.startDate}</span>
                </button>
              ))}
            </div>
          )}

          {/* 明确删除语义（保留，仅在此处，需二次确认） */}
          {selectedId && (
            <div className="border-t pt-3">
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (
                    typeof window !== "undefined" &&
                    window.confirm("确认删除本局？此操作不可恢复，将一并删除本局账户与成交记录。")
                  ) {
                    void deleteSession(selectedId);
                  }
                }}
              >
                删除本局（不可恢复）
              </Button>
            </div>
          )}
        </div>
      </details>

      {msg && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            msg.kind === "ok"
              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
              : "border-destructive/40 bg-destructive/5 text-destructive",
          )}
        >
          {msg.text}
        </div>
      )}

      {!snapshot ? (
        <Card>
          <CardContent className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <div>还没有进行中的对局，在上方「创建新局 / 切换会话」中随机抽取一只隐藏股票。</div>
            <div className="text-xs">全程只显示K线与价格，结束前不透露任何身份信息。</div>
          </CardContent>
        </Card>
      ) : (
        <SimTradeBoard
          snapshot={snapshot}
          reveal={reveal}
          busy={busy}
          pending={pending}
          onPick={setPending}
          onConfirm={confirmAction}
          onCancel={() => setPending(null)}
          onNext={advanceDay}
          onReveal={doReveal}
          onDelete={() => selectedId && deleteSession(selectedId)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*                       对局主面板（单日一屏）                         */
/* ------------------------------------------------------------------ */

interface BoardProps {
  snapshot: SimTradeSnapshot;
  reveal: SimTradeReveal | null;
  busy: boolean;
  pending: { action: SimTradeAction; percent: number } | null;
  onPick: (p: { action: SimTradeAction; percent: number } | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onNext: () => void;
  onReveal: () => void;
  onDelete: () => void;
}

export function SimTradeBoard({
  snapshot,
  reveal,
  busy,
  pending,
  onPick,
  onConfirm,
  onCancel,
  onNext,
  onReveal,
  onDelete,
}: BoardProps) {
  const { session, summary, position, positionRatio } = snapshot;
  const finished = session.status === "FINISHED";
  const confirmedToday = session.confirmedToday;

  return (
    <div className="space-y-3 md:space-y-4">
      {/* 1) 顶部进度：模拟炒股 + 第 X/N 交易日 + 日期 */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold tracking-tight md:text-lg">模拟炒股</h1>
          <Badge variant={finished ? "secondary" : "default"} className="tabular">
            第 {session.dayIndex}/{session.totalDays} 交易日
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground tabular">{session.currentDate}</span>
      </div>

      {/* 2) 账户信息：总资产 / 收益 / 现金 / 仓位，两行紧凑排列 */}
      <AccountSummary summary={summary} positionRatio={positionRatio} />

      {/* 3) 今日开盘：最大字号，置于 K 线上方 */}
      <OpenPriceBlock openPrice={snapshot.openPrice} />

      {/* 4) K 线图（只到当前日；当日仅开盘；不显示成交量；MA[5,20]） */}
      <Card className="overflow-hidden">
        <CardContent className="px-1 pb-3 md:px-3">
          <KlineChart
            bars={snapshot.history}
            showVolume={false}
            maPeriods={[5, 20]}
            height={220}
            zoomStart={Math.max(
              0,
              100 - Math.round((60 / Math.max(snapshot.history.length, 1)) * 100),
            )}
            zoomEnd={100}
          />
        </CardContent>
      </Card>

      {/* 5) 持仓 / 可卖 / 浮盈：小字 */}
      <PositionMini position={position} />

      {/* 6) 今日结算（仅 confirmedToday 展示；收盘/涨跌取自已揭示 history，禁止前瞻） */}
      {confirmedToday && !finished && <TodaySettlementPanel snapshot={snapshot} />}

      {/* 7) 上一交易日结算结果（未确认今日时，展示最近已结算日；含成交明细） */}
      {!confirmedToday && snapshot.lastAction && !finished && (
        <ActionRecordPanel snapshot={snapshot} />
      )}

      {/* 8) 最终结算 */}
      {finished && snapshot.settlement && (
        <SettlementPanel snapshot={snapshot} reveal={reveal} busy={busy} onReveal={onReveal} />
      )}

      {/* 9) 底部固定操作区 */}
      {!finished && (
        <TradeActionBar
          snapshot={snapshot}
          busy={busy}
          pending={pending}
          onPick={onPick}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onNext={onNext}
        />
      )}

      {/* 10) 进行中的「删除本局」入口（明确删除语义） */}
      {!finished && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="text-[11px] text-muted-foreground transition-colors hover:text-destructive"
          >
            删除本局（不可恢复）
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 子组件 ------------------------------ */

function StatCard({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-md border bg-card px-2.5 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate text-sm font-semibold tabular", valueClass)}>{value}</div>
    </div>
  );
}

/** 账户汇总：总资产 / 收益 / 现金 / 仓位，两行紧凑排列 */
export function AccountSummary({
  summary,
  positionRatio,
}: {
  summary: SimTradeSnapshot["summary"];
  positionRatio: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 md:gap-3">
      <StatCard label="总资产" value={formatMoney(summary.totalAsset)} />
      <StatCard
        label="收益"
        value={formatMoney(summary.totalProfit)}
        valueClass={pnlColorClass(summary.totalProfit)}
      />
      <StatCard label="现金" value={formatMoney(summary.availableCash)} />
      <StatCard label="仓位" value={`${formatNumber(positionRatio)}%`} />
    </div>
  );
}

/** 今日开盘：最大字号 */
export function OpenPriceBlock({ openPrice }: { openPrice: number }) {
  return (
    <div className="flex items-end gap-2">
      <span className="mb-1 text-xs text-muted-foreground">今日开盘</span>
      <span className="text-3xl font-bold leading-none tabular md:text-4xl">
        {openPrice > 0 ? `¥${formatNumber(openPrice)}` : "--"}
      </span>
      <span className="mb-1 text-[10px] text-muted-foreground">
        （每日只提前公布开盘价，收盘价在确认操作后结算）
      </span>
    </div>
  );
}

/** 持仓 / 可卖 / 浮盈：小字 */
export function PositionMini({
  position,
}: {
  position: SimTradeSnapshot["position"];
}) {
  if (!position || position.quantity <= 0) {
    return <div className="text-[11px] text-muted-foreground">当前空仓</div>;
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
      <span>
        持仓{" "}
        <b className="font-medium tabular text-foreground">{position.quantity} 股</b>
      </span>
      <span>
        可卖{" "}
        <b className="font-medium tabular text-foreground">{position.availableQty} 股</b>
      </span>
      <span>
        浮盈{" "}
        <b className={cn("font-medium tabular", pnlColorClass(position.unrealizedPnl))}>
          {formatMoney(position.unrealizedPnl)}（{formatPercent(position.unrealizedPnlPercent)}）
        </b>
      </span>
    </div>
  );
}

/**
 * 今日结算面板（confirmedToday 时展示）。
 *
 * 字段：今日收盘 / 涨跌 / 操作 / 当日盈亏 / 总资产 / 下一日。
 *  - 收盘、涨跌取自「已揭示」的 history[currentDate]（确认后服务端已放开当日完整
 *    OHLC），绝不读取未来行情；
 *  - 当日盈亏沿用原 calcDailyPnl（当日总资产 − 上一交易日总资产）；
 *  - 操作取自 lastAction。
 */
export function TodaySettlementPanel({ snapshot }: { snapshot: SimTradeSnapshot }) {
  const { session, summary, lastAction } = snapshot;
  const hist = snapshot.history;
  const idx = hist.findIndex((h) => h.date === session.currentDate);
  const cur = idx >= 0 ? hist[idx] : null;
  const close = cur ? cur.close : 0;
  const prevClose = idx > 0 ? hist[idx - 1].close : cur ? cur.open : 0;
  const pctChg = prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0;
  const { pnl, ret } = calcDailyPnl(snapshot);
  const isLastDay = session.dayIndex >= session.totalDays;
  const nextLabel = isLastDay ? "最后一日" : session.nextDate ?? "最后一日";

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">今日结算（{session.currentDate}）</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs md:grid-cols-3">
        <SettleItem label="今日收盘" value={`¥${formatNumber(close)}`} />
        <SettleItem
          label="涨跌"
          value={`${pctChg >= 0 ? "+" : ""}${formatPercent(pctChg)}`}
          valueClass={pnlColorClass(close - prevClose)}
        />
        <SettleItem label="操作" value={lastAction ? ACTION_NAME[lastAction.action] : "--"} />
        <SettleItem
          label="当日盈亏"
          value={`${formatMoney(pnl)}（${formatPercent(ret)}）`}
          valueClass={pnlColorClass(pnl)}
        />
        <SettleItem label="总资产" value={formatMoney(summary.totalAsset)} />
        <SettleItem label="下一日" value={nextLabel} />
      </CardContent>
    </Card>
  );
}

function SettleItem({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular", valueClass)}>{value}</span>
    </div>
  );
}

/** 上一交易日结算结果（含成交明细） */
function ActionRecordPanel({ snapshot }: { snapshot: SimTradeSnapshot }) {
  const rec = snapshot.lastAction;
  if (!rec) return null;
  const { pnl, ret } = calcDailyPnl(snapshot);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">上一交易日结算（{rec.date}）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">操作</span>
          <span className="font-medium">{ACTION_NAME[rec.action]}</span>
          {rec.fillCount > 0 && (
            <>
              <span className="text-muted-foreground">成交笔数</span>
              <span className="tabular">{rec.fillCount}</span>
              <span className="text-muted-foreground">成交金额</span>
              <span className="tabular">{formatMoney(rec.amount)}</span>
            </>
          )}
          <span className="text-muted-foreground">当日盈亏</span>
          <span className={cn("tabular font-medium", pnlColorClass(pnl))}>
            {formatMoney(pnl)}（{formatPercent(ret)}）
          </span>
        </div>
        {rec.fills.length > 0 && (
          <div className="space-y-1 border-t pt-2">
            {rec.fills.map((f) => (
              <div
                key={f.id}
                className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground"
              >
                <span
                  className={cn(
                    "font-medium",
                    f.side === "BUY" ? "text-stock-up" : "text-stock-down",
                  )}
                >
                  {f.side === "BUY" ? "买入" : "卖出"}
                </span>
                <span>
                  {f.quantity} 股 @ ¥{formatNumber(f.price)}
                </span>
                <span>金额 {formatMoney(f.amount)}</span>
                <span>费用 {formatMoney(f.totalFee)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 最终结算面板（含揭晓 + 收益对照 + 净值曲线） */
function SettlementPanel({
  snapshot,
  reveal,
  busy,
  onReveal,
}: {
  snapshot: SimTradeSnapshot;
  reveal: SimTradeReveal | null;
  busy: boolean;
  onReveal: () => void;
}) {
  const s = snapshot.settlement;
  if (!s) return null;
  const points = toEquityPoints(snapshot.curve);

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">本局结束 · 最终结算</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="初始资金" value={formatMoney(s.initialCash, 0)} />
          <StatCard label="最终资产" value={formatMoney(s.finalAsset)} />
          <StatCard
            label="总盈亏"
            value={formatMoney(s.totalProfit)}
            valueClass={pnlColorClass(s.totalProfit)}
          />
          <StatCard
            label="收益率"
            value={formatPercent(s.totalReturn)}
            valueClass={pnlColorClass(s.totalReturn)}
          />
          <StatCard label="交易次数" value={`${s.tradeCount} 笔`} />
          <StatCard label="最大仓位" value={`${formatNumber(s.maxPositionRatio)}%`} />
          <StatCard
            label="最大回撤"
            value={formatPercent(s.maxDrawdown)}
            valueClass={pnlColorClass(s.maxDrawdown)}
          />
          <StatCard
            label="买入持有收益"
            value={`${formatMoney(s.buyHoldProfit)}（${formatPercent(s.buyHoldReturn)}）`}
            valueClass={pnlColorClass(s.buyHoldProfit)}
          />
        </div>

        {/* 收益对照 */}
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            s.beatBuyHold
              ? "border-stock-up/40 bg-stock-up/5 text-stock-up"
              : "border-stock-down/40 bg-stock-down/5 text-stock-down",
          )}
        >
          你的交易收益 <b className="tabular">{formatPercent(s.totalReturn)}</b> ·
          买入持有收益 <b className="tabular">{formatPercent(s.buyHoldReturn)}</b> ——
          {s.beatBuyHold ? " 跑赢买入持有 🎉" : " 跑输买入持有"}
        </div>
        <div className="text-xs text-muted-foreground">
          区间首日开盘 ¥{formatNumber(s.startClose)} → 末日收盘 ¥{formatNumber(s.endClose)}
        </div>

        {/* 净值曲线 */}
        <div className="pt-1">
          <div className="mb-1 text-xs text-muted-foreground">资产净值曲线</div>
          <EquityChart points={points} height={240} />
        </div>

        {/* 揭晓按钮 */}
        <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
          {reveal ? (
            <div className="text-sm">
              本局标的：
              <span className="ml-1 font-semibold">
                {reveal.name}（{reveal.code} · {reveal.exchange} / {reveal.board}）
              </span>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              想知道这是哪只股票吗？点击右侧揭晓（揭晓后将展示代码与名称）。
            </div>
          )}
          {!reveal && (
            <Button size="sm" onClick={onReveal} disabled={busy} className="shrink-0">
              揭晓股票
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 底部操作区（移动端固定在底部，含 safe-area；桌面 static）。
 * 单操作面板：观望 / 买入 / 加仓 / 卖出。
 *  - 空仓：仅「买入」可用；有仓：仅「加仓」可用（两者均为 BUY）；
 *  - 比例 10 / 30 / 50 / 100（HOLD=0）；比例按「可用资金 / 可卖份额」口径，非目标仓位；
 *  - 选择动作不自动成交，点「确认今日操作」才调用原 onConfirm；
 *  - 保留 busy / tradable / T+1（可卖为 0 时卖出禁用）。
 */
export function TradeActionBar({
  snapshot,
  busy,
  pending,
  onPick,
  onConfirm,
  onCancel,
  onNext,
}: {
  snapshot: SimTradeSnapshot;
  busy: boolean;
  pending: { action: SimTradeAction; percent: number } | null;
  onPick: (p: { action: SimTradeAction; percent: number } | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const hasPosition = !!snapshot.position && snapshot.position.quantity > 0;
  const sellableQty = snapshot.position?.availableQty ?? 0;
  const confirmedToday = snapshot.session.confirmedToday;
  const tradable = snapshot.tradable;
  const isLastDay = snapshot.session.dayIndex >= snapshot.session.totalDays;

  // 选择动作（不自动成交）
  const pickAction = (action: SimTradeAction) => {
    if (action === "HOLD") {
      onPick({ action, percent: 0 });
      return;
    }
    const pct =
      pending && pending.action === action && pending.percent > 0 ? pending.percent : 10;
    onPick({ action, percent: pct });
  };
  const pickRatio = (pct: number) => {
    // 未选动作或选了观望时，按比例默认落到「买入」（空仓建仓 / 有仓加仓，均为 BUY）
    const action: SimTradeAction = pending && pending.action !== "HOLD" ? pending.action : "BUY";
    onPick({ action, percent: pct });
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur md:static md:rounded-md md:border md:shadow-sm"
      style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto max-w-[1400px] px-3 py-2.5 md:px-4 md:py-3">
        {confirmedToday ? (
          /* 阶段二：今日已结算 → 进入下一交易日（最后一日则结束本局） */
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-muted-foreground">今日已按收盘价结算</span>
              <span className="text-xs text-muted-foreground">（{snapshot.session.currentDate}）</span>
            </div>
            <Button
              variant="default"
              className="h-11 w-full text-sm md:h-9 md:w-auto md:px-8"
              onClick={onNext}
              disabled={busy}
            >
              {busy ? "结算中..." : isLastDay ? "结束本局并查看结算" : "进入下一交易日"}
            </Button>
          </div>
        ) : pending ? (
          /* 已选择动作 → 确认区（含比例） */
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-muted-foreground">今日操作</span>
              <span className="font-semibold">
                {ACTION_NAME[pending.action]}
                {pending.action !== "HOLD" && ` · ${pending.percent}%`}
              </span>
              <span className="text-xs text-muted-foreground">
                （{snapshot.session.currentDate}，按今日收盘价结算）
              </span>
            </div>
            {pending.action !== "HOLD" && (
              <div className="flex items-center gap-1.5">
                <span className="w-8 shrink-0 text-xs text-muted-foreground">比例</span>
                <div className="flex flex-1 flex-wrap gap-1.5">
                  {RATIOS.map((p) => (
                    <Button
                      key={`ratio-${p}`}
                      variant={pending.percent === p ? "default" : "outline"}
                      className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9"
                      disabled={busy}
                      onClick={() => pickRatio(p)}
                    >
                      {p}%
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                className="h-11 flex-1 text-sm md:h-9 md:flex-none md:px-8"
                onClick={onConfirm}
                disabled={busy}
              >
                {busy ? "结算中..." : "确认今日操作"}
              </Button>
              <Button
                variant="outline"
                className="h-11 md:h-9"
                onClick={onCancel}
                disabled={busy}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          /* 选择动作阶段 */
          <div className="space-y-2">
            {/* 动作行：观望 / 买入 / 加仓 / 卖出 */}
            <div className="flex items-center gap-1.5">
              <span className="w-8 shrink-0 text-xs text-muted-foreground">动作</span>
              <div className="flex flex-1 flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9"
                  disabled={busy || !tradable}
                  onClick={() => pickAction("HOLD")}
                >
                  观望
                </Button>
                <Button
                  variant="buy"
                  className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9"
                  disabled={busy || !tradable || hasPosition}
                  onClick={() => pickAction("BUY")}
                >
                  买入
                </Button>
                <Button
                  variant="buy"
                  className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9"
                  disabled={busy || !tradable || !hasPosition}
                  onClick={() => pickAction("BUY")}
                >
                  加仓
                </Button>
                <Button
                  variant="sell"
                  className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9"
                  disabled={busy || !tradable || !hasPosition || sellableQty <= 0}
                  onClick={() => pickAction("SELL")}
                >
                  卖出
                </Button>
              </div>
            </div>
            {/* 比例行（仅 BUY / SELL 可用；HOLD 无需比例） */}
            <div className="flex items-center gap-1.5">
              <span className="w-8 shrink-0 text-xs text-muted-foreground">比例</span>
              <div className="flex flex-1 flex-wrap gap-1.5">
                {RATIOS.map((p) => (
                  <Button
                    key={`buy-ratio-${p}`}
                    variant="outline"
                    className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9"
                    disabled={busy || !tradable}
                    onClick={() => pickRatio(p)}
                  >
                    {p}%
                  </Button>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">
              比例按「可用资金 / 可卖份额」口径（非目标总仓位）；选动作后点「确认今日操作」才成交。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
