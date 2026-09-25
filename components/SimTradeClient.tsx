"use client";

import * as React from "react";
import type {
  EquityPoint,
  SimTradeAction,
  SimTradeExecutionMode,
  SimTradeIntradayInfo,
  SimTradeReveal,
  SimTradeSnapshot,
  SimTradeStage,
  SimTradeInfo,
} from "@/types";
import { cn, formatMoney, formatNumber, formatPercent, formatVolume, pnlColorClass } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import KlineChart from "@/components/charts/KlineChart";
import IntradayLineChart, { type IntradayFillMark } from "@/components/charts/IntradayLineChart";
import type { KlineMarkerInput } from "@/lib/klineChartOption";
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

/** V2 阶段 → 中文标签 */
export const STAGE_LABEL: Record<SimTradeStage, string> = {
  OPEN: "开盘阶段",
  OPEN_CONFIRMED: "开盘已操作",
  CLOSE_ANIMATION: "公布收盘价",
  CLOSE: "收盘阶段",
  CLOSE_CONFIRMED: "收盘已操作",
  DAY_SETTLED: "今日已结算",
};

/** 比例默认值（滑块初始位置） */
const DEFAULT_PERCENT = 50;

/** 收盘动画时长（ms） */
const CLOSE_ANIM_DURATION = 1600;

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
 * 模拟炒股（猜股票）客户端 · V2。
 *
 * 玩法：服务端随机隐藏一只真实历史个股，玩家只看得到 K 线与价格，
 * 凭盘感做多，最终与「买入持有」比收益。
 *
 * V2 阶段状态机（每交易日拆为两个独立交易阶段，每阶段只能操作 1 次）：
 *   OPEN（按开盘价成交）→ OPEN_CONFIRMED → CLOSE_ANIMATION（公布收盘价，播动画）
 *   → CLOSE（按收盘价成交）→ CLOSE_CONFIRMED → DAY_SETTLED → 下一交易日 OPEN
 *
 * 防未来数据泄露（前端侧约束）：
 *  - 所有行情/持仓/账户数据均来自 `/api/simtrade/*`，可见上界由服务端按会话
 *    `currentDate` 强制，前端不传任何日期参数（下单日期也由服务端决定）；
 *  - 本页**不提供**跳转到 `/stocks/[code]` 的链接；K 线只走模拟专用接口，
 *    **OPEN 阶段当日 K 线仅含开盘价**（服务端已抹去 high/low/close），
 *    收盘价在 CLOSE_ANIMATION 阶段才由服务端揭示；
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

  // 待确认的操作（选择 → 确认 → 成交）
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

  /** 切换会话即清空待确认操作，避免「串单」 */
  React.useEffect(() => {
    setPending(null);
  }, [selectedId]);

  /** 阶段变化即清空待确认操作（避免把上一阶段的选择带进下一阶段） */
  const stageKey = snapshot ? `${snapshot.session.id}:${snapshot.session.currentDate}:${snapshot.stage}` : "";
  React.useEffect(() => {
    setPending(null);
  }, [stageKey]);

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
   * 提交操作（成交价由服务端决定）。
   *
   * `mode` 决定执行时机，但**不影响交易规则**：
   *  - `INSTANT` → 服务端校验后立即成交；
   *  - `CONFIRM` → 服务端落库为待确认（pending），由 `confirmPendingAction` 成交。
   */
  const confirmAction = React.useCallback(
    async (mode: SimTradeExecutionMode) => {
      if (!selectedId || !pending) return;
      setBusy(true);
      setMsg(null);
      try {
        const json = await api<{
          success: boolean;
          message: string;
          finished?: boolean;
          pending?: boolean;
          snapshot?: SimTradeSnapshot;
        }>(`/api/simtrade/${selectedId}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: pending.action, percent: pending.percent, mode }),
        });
        if (!json.success) {
          setMsg({ kind: "err", text: json.message });
          return;
        }
        setMsg({ kind: "ok", text: json.message });
        // 立即模式：已成交 → 清空本地选择；确认模式：保留选择，等用户确认/取消
        if (!json.pending) setPending(null);
        if (json.snapshot) setSnapshot(json.snapshot);
        else await loadSnapshot(selectedId);
        if (!json.pending) await loadList();
      } catch (err) {
        setMsg({ kind: "err", text: (err as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [selectedId, pending, loadSnapshot, loadList],
  );

  /** 确认并执行服务端落库的待确认操作（V3 确认模式）。请求体不带任何参数 —— 执行什么以服务端 pending 为准 */
  const confirmPendingAction = React.useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message: string;
        finished?: boolean;
        snapshot?: SimTradeSnapshot;
      }>(`/api/simtrade/${selectedId}/confirm`, { method: "POST" });
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

  /** 取消待确认操作（不消耗任何操作次数与买卖配额） */
  const cancelPendingAction = React.useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message: string;
        snapshot?: SimTradeSnapshot;
      }>(`/api/simtrade/${selectedId}/confirm`, { method: "DELETE" });
      setMsg(
        json.success ? { kind: "ok", text: json.message } : { kind: "err", text: json.message },
      );
      setPending(null);
      if (json.snapshot) setSnapshot(json.snapshot);
      else await loadSnapshot(selectedId);
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedId, loadSnapshot]);

  /** 推进交易阶段 / 进入下一交易日（V3：时间推进不消耗操作次数） */
  const advanceStage = React.useCallback(async () => {
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

  /**
   * 「结算并进入下一交易日」——**原子操作**（`POST /api/simtrade/:id/next-day`）。
   *
   * 为什么不在前端连调两次 `/next`（防未来数据泄露）：
   *   `/next` 每次只走一格（`CLOSE → DAY_SETTLED → 下一日`）。前端盲连两次时，
   *   若会话已因另一标签页/重试先走了一格，第二次调用会从**新交易日的 OPEN**
   *   继续推进到 `CLOSE_ANIMATION` —— 等于**提前揭示新一天的收盘价**。
   *   服务端以「日期是否变化」为硬终止条件，可精确停在下一交易日 OPEN，不会越界。
   */
  const settleAndNextDay = React.useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message: string;
        finished?: boolean;
        snapshot?: SimTradeSnapshot;
      }>(`/api/simtrade/${selectedId}/next-day`, { method: "POST" });
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

  /**
   * 推进「30m 时间轴」一格（V3）。
   *
   * 与 `advanceStage` 是两条**互相独立**的轴：本动作只多揭示一根 30m K，
   * **不消耗操作次数**、也不改变 `stage`。可见上界由服务端按会话游标决定；
   * 客户端只传 sessionId，无法伪根据数 / 阶段 / 日期。
   */
  const advanceIntraday = React.useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    try {
      const json = await api<{
        success: boolean;
        message: string;
        finished?: boolean;
        snapshot?: SimTradeSnapshot;
      }>(`/api/simtrade/${selectedId}/tick`, { method: "POST" });
      if (!json.success) {
        setMsg({ kind: "err", text: json.message });
        return;
      }
      setMsg({ kind: "ok", text: json.message });
      if (json.snapshot) setSnapshot(json.snapshot);
      else await loadSnapshot(selectedId);
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedId, loadSnapshot]);

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
    <div className="space-y-3 pb-44 md:space-y-4 md:pb-6">
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
          onConfirmPending={confirmPendingAction}
          onCancelPending={cancelPendingAction}
          onCancel={() => setPending(null)}
          onNext={advanceStage}
          onNextDay={settleAndNextDay}
          onTick={advanceIntraday}
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
  /** 提交操作；`mode` 决定立即执行还是落库为待确认 */
  onConfirm: (mode: SimTradeExecutionMode) => void;
  /** 确认服务端落库的待确认操作 */
  onConfirmPending: () => void;
  /** 取消待确认操作 */
  onCancelPending: () => void;
  onCancel: () => void;
  onNext: () => void;
  /**
   * 结算并进入下一交易日（**原子操作**，服务端 `/next-day`）。
   * 与 `onNext`（每次只走一格）不同：一次调用即从 CLOSE / DAY_SETTLED 走到下一交易日 OPEN，
   * 且服务端保证**不越过新交易日的 OPEN**（否则会提前揭示新日收盘价）。
   */
  onNextDay: () => void;
  /** 推进 30m 时间轴一格（V3，不消耗操作次数） */
  onTick: () => void;
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
  onConfirmPending,
  onCancelPending,
  onCancel,
  onNext,
  onNextDay,
  onTick,
  onReveal,
  onDelete,
}: BoardProps) {
  const { session, summary, position, positionRatio } = snapshot;
  const finished = session.status === "FINISHED";
  const stage = snapshot.stage;

  /**
   * 当日 30m 日内 K（V3：**只读接入**，不参与成交计价 —— 计价在阶段 6 另行切换）。
   *
   * 防泄漏设计（关键）：
   *  - 只传 `sessionId`，**不传日期 / 阶段 / 根数**。可见上界完全由服务端按会话
   *    30m 游标（`intradayBarCount`）决定 —— 客户端无法通过参数伪造未来 K；
   *  - 因此本组件**不需要也没有**自行裁剪未来 K 的逻辑：拿到的就是服务端已裁剪的结果；
   *  - 依赖 `session.id + currentDate + stage + intradayBarCount`：**游标推进也会触发重取**，
   *    否则点击「推进 30m」后图表不会更新。
   *
   * 容错：30m 属于**增强视图**。Parquet 缺失 / 读取失败 / 非 200 时只隐藏该面板，
   * 绝不影响日K 与下单主流程。
   */
  const [intraday, setIntraday] = React.useState<SimTradeIntradayInfo | null>(null);
  const cursor = snapshot.intradayBarCount;
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const json = await api<{
          success: boolean;
          data?: SimTradeIntradayInfo;
          message?: string;
        }>(`/api/intraday?sessionId=${encodeURIComponent(session.id)}`);
        if (!cancelled) setIntraday(json.success && json.data ? json.data : null);
      } catch {
        if (!cancelled) setIntraday(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id, session.currentDate, stage, cursor]);

  return (
    <div className="space-y-3 md:space-y-4">
      {/* 1) 顶部进度：模拟炒股 + 第 X/N 交易日 + 日期 */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold tracking-tight md:text-lg">模拟炒股</h1>
          <Badge
            variant={finished ? "secondary" : "default"}
            className="tabular border-border bg-card text-foreground"
          >
            第 {session.dayIndex}/{session.totalDays} 交易日
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground tabular">{session.currentDate}</span>
      </div>

      {/* 2) 阶段状态：V2 核心 —— 每阶段只能操作 1 次 */}
      {!finished && <StageBanner snapshot={snapshot} />}

      {/* 3) 价格区（当前行情） */}
      <PriceBlock snapshot={snapshot} />

      {/* 4) 图表区（主视觉）：`[ 分时图 ] [ 日K ]` 二级 Tab（需求 五 / 十一）
          — 默认「分时图」，是交易主视觉；「日K」是历史走势参考。
          — 切换为**纯 UI 行为**：不消耗操作次数、不推进 30m 节点、不改持仓/现金、
            不触发结算、不换日、不重置走势。ChartTabs 内部没有任何 fetch。
          需求十二要求的信息顺序是「股票信息 → 分时图/日K → 当前行情 → 操作次数 → 持仓 → 交易按钮」，
          因此**图表提到账户汇总之前**，让图表成为首屏主视觉（此前的顺序把大块账户卡片挡在图表上方）。 */}
      <ChartTabs
        snapshot={snapshot}
        intraday={intraday && intraday.sessionId === session.id ? intraday : null}
        maxRevealableBars={snapshot.maxRevealableBars}
        currentTime={snapshot.currentIntradayTime}
        canTick={!finished && stage === "OPEN" && cursor < snapshot.maxRevealableBars}
        busy={busy}
        onTick={onTick}
      />

      {/* 5) 账户信息：总资产 / 收益 / 现金 / 仓位 —— 收紧为紧凑单行，不再占据首屏 */}
      <AccountSummary summary={summary} positionRatio={positionRatio} />

      {/* 6) 持仓 / 可卖 / 浮盈 + 迷你走势图 */}
      <PositionMini position={position} history={snapshot.history} />

      {/* 7) 当日结算（CLOSE_CONFIRMED / DAY_SETTLED 展示） */}
      {(stage === "CLOSE_CONFIRMED" || stage === "DAY_SETTLED") && !finished && (
        <TodaySettlementPanel snapshot={snapshot} />
      )}

      {/* 8) 上一交易日结算结果 */}
      {stage === "OPEN" && snapshot.lastAction && !finished && (
        <ActionRecordPanel snapshot={snapshot} />
      )}

      {/* 9) 最终结算 */}
      {finished && snapshot.settlement && (
        <SettlementPanel snapshot={snapshot} reveal={reveal} busy={busy} onReveal={onReveal} />
      )}

      {/* 10) 底部固定操作区 */}
      {!finished && (
        <TradeActionBar
          snapshot={snapshot}
          busy={busy}
          pending={pending}
          onPick={onPick}
          onConfirm={onConfirm}
          onConfirmPending={onConfirmPending}
          onCancelPending={onCancelPending}
          onCancel={onCancel}
          onNext={onNext}
          onNextDay={onNextDay}
        />
      )}

      {/* 11) 进行中的「删除本局」入口 */}
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

/** 阶段状态条：显示当前阶段、当日剩余操作/买卖额度 */
export function StageBanner({ snapshot }: { snapshot: SimTradeSnapshot }) {
  const stage = snapshot.stage;
  const tradable = snapshot.tradable;
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2",
        tradable ? "border-primary/40 bg-primary/5" : "border-border bg-muted/40",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px] font-semibold",
              tradable ? "bg-primary text-primary-foreground" : "bg-muted-foreground/20 text-foreground",
            )}
          >
            {STAGE_LABEL[stage]}
          </span>
          <span className="text-xs text-muted-foreground">
            {tradable
              ? `可连续操作（按${stage === "OPEN" ? "开盘价" : "收盘价"}成交），推进时间不消耗操作次数`
              : stage === "OPEN_CONFIRMED"
                ? "开盘阶段已操作，可查看今日收盘"
                : stage === "CLOSE_ANIMATION"
                  ? "收盘价公布中…"
                  : stage === "OPEN" || stage === "CLOSE"
                    ? "今日操作次数已用完，可推进时间"
                    : "本阶段已操作，可推进"}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular">
          {/* 2026-09-24：不再显示「操作剩 N/8」总操作额度（观望取消后它永远够不到，
              详见 TradeActionBar 里的说明）。只保留真正会用完的两项配额。 */}
          <span>
            可买 <b className="text-foreground">{snapshot.remainingBuy}</b> 次
          </span>
          <span>
            可卖 <b className="text-foreground">{snapshot.remainingSell}</b> 次
          </span>
        </div>
      </div>
    </div>
  );
}

/** 价格区：开盘价常显；收盘价仅在 CLOSE_ANIMATION 及之后显示 */
/**
 * 行情块（2026-09-24 改版）：**大字当前价 + 涨跌额 / 涨跌幅% + 高 / 低 / 开**
 *
 * ## 口径修正（重要，属正确性修复而非美化）
 *
 * 旧实现拿「**今日开盘价**」当涨跌基准算 `(收盘 − 开盘)/开盘`。这是错的 ——
 * 行情软件的涨跌幅**一律以「前一交易日收盘价」为基准**。
 * 用用户给的案例可反证：`17.67 / (1 + 10.02%) ≈ 16.06`，而当日开盘是 `16.57`；
 * 若基准是开盘价，涨跌幅应是 `17.67/16.57 − 1 = +6.64%`，与图中的 `+10.02%` 不符。
 * 因此本实现改用 `snapshot.prevClose`（前收）作基准，并把百分比直接取
 * 服务端已算好的 `todayBar.changePercent`（口径唯一来源，避免前端二次推导漂移）。
 *
 * ## 防泄漏
 *
 * `高 / 低` 取自 `todayBar.high / low` —— 它们是**已揭示的 30m 前 N 根**的极值，
 * 不含任何未来棒。收盘未揭示时展示的是**盘中动态值**，这与真实行情软件行为一致
 * （盘中本来就实时显示当日最高/最低）。进入 `CLOSE_ANIMATION` 后 `todayBar`
 * 定格为官方日K，三者自动变为当日最终值。
 *
 * ## 缺失值的处理
 *
 * 30m 数据不可用时 `todayBar` 退化为 `DAILY_K` 口径（`high/low` 仍可用）；
 * 极端情况下 `todayBar` 为 `null`，此时高/低显示 `--` 而**不伪造为开盘价**。
 */
export function PriceBlock({ snapshot }: { snapshot: SimTradeSnapshot }) {
  const bar = snapshot.todayBar;
  const prev = snapshot.prevClose;

  /** 当前价：当日动态K的 close（= 已揭示的最新 30m 收盘）；退化到本阶段成交价 */
  const cur = bar?.close ?? snapshot.stageFillPrice ?? null;
  const hasCur = cur !== null && Number.isFinite(cur) && cur > 0;
  const hasPrev = prev !== null && Number.isFinite(prev) && prev > 0;

  /** 涨跌额（相对前收） */
  const diff = hasCur && hasPrev ? (cur as number) - (prev as number) : null;
  /** 涨跌幅%：优先用服务端口径，缺失时按前收自算 */
  const pct =
    bar?.changePercent ?? (diff !== null && hasPrev ? (diff / (prev as number)) * 100 : null);
  const colorOf = (v: number | null) =>
    v === null ? "text-muted-foreground" : pnlColorClass(v);

  const open = bar?.open ?? (snapshot.openPrice > 0 ? snapshot.openPrice : null);
  const high = bar?.high ?? null;
  const low = bar?.low ?? null;

  /** 高/低/开：按「与前收比较」着色（行情软件惯例；无前收时用中性色） */
  const row = (label: string, v: number | null) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("tabular font-medium", hasPrev && v !== null ? pnlColorClass(v - (prev as number)) : "text-muted-foreground")}>
        {v === null ? "--" : formatNumber(v)}
      </span>
    </div>
  );

  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 md:px-4 md:py-3">
      <div className="flex items-start justify-between gap-4">
        {/* 左：当前价（主视觉）+ 涨跌额 / 涨跌幅 */}
        <div className="min-w-0">
          <div
            className={cn(
              "text-[30px] font-semibold leading-none tabular md:text-[36px]",
              colorOf(diff),
            )}
          >
            {hasCur ? formatNumber(cur as number) : "--"}
          </div>
          <div
            className={cn(
              "mt-2 flex flex-wrap items-baseline gap-x-2 text-sm font-medium tabular",
              colorOf(diff),
            )}
          >
            <span>{diff === null ? "--" : `${diff >= 0 ? "+" : ""}${formatNumber(diff)}`}</span>
            <span>{pct === null ? "--" : formatPercent(pct)}</span>
          </div>
        </div>

        {/* 右：高 / 低 / 开（顺序与用户给出的案例图一致） */}
        <div className="grid w-[104px] shrink-0 grid-cols-1 gap-y-0.5 text-xs">
          {row("高", high)}
          {row("低", low)}
          {row("开", open)}
        </div>
      </div>

      {/* 盘中提示：避免用户把动态值误读为当日最终值。
          定格（收盘已公布）后不再显示。 */}
      {bar !== null && !bar.finalized && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          盘中动态 · 高/低为已揭示 {bar.revealedBars}/8 根的极值
        </p>
      )}
    </div>
  );
}

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

/**
 * 账户汇总：总资产 / 收益 / 现金 / 仓位 —— **紧凑单行**（需求十二：其他信息尽量收紧）。
 *
 * 为什么从「2×2 卡片网格」改成单行：
 *   原实现是 4 个 `StatCard` 组成的 `grid-cols-2` 两行网格，垂直占地约 2 个卡片高度。
 *   而需求十二要求「图表是主视觉，其他信息尽量收紧」，且信息顺序为
 *   「股票信息 → 分时图/日K → 当前行情 → 操作次数 → 持仓 → 交易按钮」——
 *   账户汇总属于辅助信息，压在图表下方一行即可，不应再占据首屏大块面积。
 */
export function AccountSummary({
  summary,
  positionRatio,
}: {
  summary: SimTradeSnapshot["summary"];
  positionRatio: number;
}) {
  /*
    卡片化（2026-09-24，按设计稿对齐）：
      每个指标独立成卡，**标签在上、数值在下** —— 与设计稿一致，信息层次比
      「标签·数值横排」更清晰（一眼分辨哪个数字属于哪个标签）。

    为什么仍然满足「需求十二：图表是主视觉、其他信息收紧」：
      1. 四项**始终一行**（`grid-cols-4`），不回到 `grid-cols-2` 的两行大网格 ——
         垂直占地只比原先的单行多约 18px，远小于原大网格；
      2. 卡片 padding 压到 `px-2 py-1.5`、圆角 `rounded-md`，是无边框溢出的紧凑卡；
      3. `truncate` 保证长数字（如 ¥1,234,567.89）在窄屏 4 列下不撑破布局。

    因此这是「同一块面积内的信息重排」，不是把账户区重新放大。
  */
  const item = (label: string, value: string, valueClass?: string) => (
    <div className="min-w-0 rounded-md border bg-card px-2 py-1.5">
      <div className="truncate text-[10px] leading-tight text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate text-xs font-semibold tabular", valueClass)}>
        {value}
      </div>
    </div>
  );
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {item("总资产", `¥${formatMoney(summary.totalAsset)}`)}
      {item("收益", `¥${formatMoney(summary.totalProfit)}`, pnlColorClass(summary.totalProfit))}
      {item("现金", `¥${formatMoney(summary.availableCash)}`)}
      {item("仓位", `${formatNumber(positionRatio)}%`)}
    </div>
  );
}

/** 今日开盘：最大字号（兼容旧调用点） */
export function OpenPriceBlock({ openPrice }: { openPrice: number }) {
  return (
    <div className="flex items-end gap-2">
      <span className="mb-1 text-xs text-muted-foreground">今日开盘</span>
      <span className="text-3xl font-bold leading-none tabular md:text-4xl">
        {openPrice > 0 ? `¥${formatNumber(openPrice)}` : "--"}
      </span>
    </div>
  );
}

/** 持仓 / 可卖 / 浮盈：小字 */
/**
 * 迷你走势图（sparkline）：持仓行右侧的走势缩略（按设计稿对齐）。
 *
 * 为什么用**内联 SVG** 而不是引入图表库：
 *   这是一个约 64×18px 的装饰性缩略图。ECharts 的实例化开销（运行时体积 +
 *   canvas 初始化 + resize/dispose 生命周期）与它提供的价值完全不成比例；
 *   原生 SVG 一条 polyline 只需几十个字符，且随父容器自动缩放。
 *
 * 颜色遵循 **A 股惯例（涨红跌绿）**，与全站 `--stock-up / --stock-down` 同源，
 * 不另起一套色值，避免与其它涨跌文字产生色差。
 *
 * `values.length < 2` 时**不渲染** —— 单点连不成线，画出来只会是一条
 * 误导性的水平线（看起来像"持平"）。
 */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  /* span 为 0（所有值相同）时用 1 兜底，否则除以 0 会得到 NaN 坐标 */
  const span = max - min || 1;
  const W = 64;
  const H = 18;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((v - min) / span) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[18px] w-16 shrink-0" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke={rising ? "hsl(var(--stock-up))" : "hsl(var(--stock-down))"}
      />
    </svg>
  );
}

export function PositionMini({
  position,
  history,
}: {
  position: SimTradeSnapshot["position"];
  /**
   * 历史日K，仅用于右侧迷你走势图（取最近 20 根收盘价）。
   * **可选**：不传则不画图 —— 既有调用点与 SSR 测试无需改动即可继续工作。
   */
  history?: SimTradeSnapshot["history"];
}) {
  if (!position || position.quantity <= 0) {
    return <div className="text-[11px] text-muted-foreground">当前空仓</div>;
  }
  const closes = (history ?? []).slice(-20).map((b) => b.close);
  return (
    <div className="flex items-center justify-between gap-3">
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
      <Sparkline values={closes} />
    </div>
  );
}

/**
 * 今日结算面板（CLOSE_CONFIRMED / DAY_SETTLED 时展示）。
 *
 * 收盘/涨跌取服务端已揭示的 `todayClose`（防泄漏：只在收盘公布后才有值）。
 */
export function TodaySettlementPanel({ snapshot }: { snapshot: SimTradeSnapshot }) {
  const { session, summary, lastAction } = snapshot;
  const close = snapshot.todayClose ?? 0;
  const prevClose = snapshot.history.length >= 2
    ? snapshot.history[snapshot.history.length - 2].close
    : snapshot.openPrice;
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

/**
 * 图表区：`[ 分时图 ] [ 日K ]` 二级 Tab（需求 五 / 十一 / 二十一）。
 *
 * 定位（需求 十一）：**分时图是交易主视觉**，日K 是「历史走势参考」。
 *
 * ⚠️ Tab 切换是**纯 UI 行为**（需求 五 的硬约束）：
 *   只改本地 `useState`，**不调用任何 API**，因此不可能：
 *   消耗操作次数 / 推进 30m 节点 / 改持仓或现金 / 触发结算 / 换日 / 重置走势。
 *   本组件内部**没有任何 fetch**，这是结构性保证，而不是靠自觉。
 *
 * 防泄漏（需求 四 / 七 / 九）：
 *   - 分时图的 `ticks` 由服务端按会话 30m 游标裁剪后下发，**未揭示时点根本不在数组里**；
 *   - 日K 图的 `snapshot.history` 末根（当日）由服务端用**已揭示的 30m 现场合成**
 *     （OHLC 与成交量都只反映已揭示部分），因此 MA5/20 也自动基于动态日K 计算。
 *   两处都是「服务端裁剪 + 前端不推算」，不存在前端自行切片导致漂移的可能。
 */
export function ChartTabs({
  snapshot,
  intraday,
  maxRevealableBars,
  currentTime,
  canTick,
  busy,
  onTick,
  initialTab = "intraday",
}: {
  snapshot: SimTradeSnapshot;
  intraday: SimTradeIntradayInfo | null;
  maxRevealableBars: number;
  currentTime: string;
  canTick: boolean;
  busy: boolean;
  onTick: () => void;
  /**
   * 初始选中的 Tab，**默认 `"intraday"`（分时图）** —— 这是产品要求。
   * 该参数只为 SSR 测试能覆盖「日K」分支而存在（服务端渲染无法点击切换），
   * 生产调用一律不传。
   */
  initialTab?: "intraday" | "daily";
}) {
  const [tab, setTab] = React.useState<"intraday" | "daily">(initialTab);
  const todayBar = snapshot.todayBar;
  const ticks = intraday?.ticks ?? [];
  const times = intraday?.times ?? [];
  const prevClose = intraday?.prevClose ?? snapshot.prevClose;

  /* ---------------- 交易标记（B/S）与成本线 ----------------
   * 数据全部来自快照，**不新增任何请求**：
   *   · `snapshot.fills` 只含已发生的成交 —— 不存在「未来的买卖点」；
   *   · `snapshot.position.avgCost` 是持仓成本价。
   *
   * 两个图各取所需：
   *   · 分时图只吃**当日**成交 —— 30m 时点（`barTime`）只在当日有意义，
   *     跨日的成交拿到它会是 null（服务端只对当前日反推时点）；
   *   · 日K 要**全部**成交 —— 它按日期定位，正好用 `tradedAt`。 */
  const todayStr = snapshot.session.currentDate;
  const todayMarks: IntradayFillMark[] = snapshot.fills
    .filter((f) => f.tradedAt === todayStr)
    .map((f) => ({
      side: f.side,
      price: f.price,
      time: f.barTime ?? null,
      quantity: f.quantity,
    }));
  const klineMarkers: KlineMarkerInput[] = snapshot.fills.map((f) => ({
    date: f.tradedAt,
    type: f.side,
    price: f.price,
    quantity: f.quantity,
  }));
  const costPrice = snapshot.position?.avgCost ?? null;
  const hasMarks = todayMarks.length > 0 || klineMarkers.length > 0;

  const tabBtn = (key: "intraday" | "daily", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      onClick={() => setTab(key)}
      className={cn(
        "rounded-md px-3 py-1 text-xs font-medium transition-colors",
        tab === key
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5" role="tablist">
          {tabBtn("intraday", "分时图")}
          {tabBtn("daily", "日K")}
        </div>
        {/* 需求 十五：操作次数放在图表附近，必须醒目。
            2026-09-24 调整：观望取消后「总操作次数」永远够不到上限，故不再展示它，
            改为展示**真正会用完**的买入/卖出配额（仍然是「操作次数」信息，仍然醒目）。 */}
        <span className="text-xs tabular text-muted-foreground">
          买入 <b className="text-foreground">{2 - snapshot.remainingBuy}/2</b>
          <span className="mx-1.5">·</span>
          卖出 <b className="text-foreground">{2 - snapshot.remainingSell}/2</b>
        </span>
      </CardHeader>
      <CardContent className="px-1 pb-3 md:px-3">
        {tab === "intraday" ? (
          <>
            <IntradayLineChart
              ticks={ticks}
              times={times}
              prevClose={prevClose}
              currentTime={currentTime}
              height={280}
              fills={todayMarks}
              costPrice={costPrice}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-1">
              <span className="text-[11px] text-muted-foreground">
                当前时点 <b className="tabular text-foreground">{currentTime}</b>
                {intraday
                  ? `（已揭示 ${intraday.barCount}/${intraday.expectedBars} 根，上限 ${maxRevealableBars}）`
                  : ""}
              </span>
              {canTick && (
                <Button
                  variant="outline"
                  className="h-8 px-3 text-[11px]"
                  onClick={onTick}
                  disabled={busy}
                >
                  {busy ? "处理中..." : "推进 30 分钟"}
                </Button>
              )}
            </div>
            <p className="px-2 pt-0.5 text-[11px] text-muted-foreground">
              {intraday?.excludedByContamination
                ? "该交易日被标记为数据污染日，已整体排除。"
                : intraday?.revealClose
                  ? "当日 8 根已全部揭示。"
                  : canTick
                    ? "「推进 30 分钟」逐根揭示当日行情；推进时间不是玩家操作，不消耗操作次数。未揭示的时点不会出现在图上。"
                    : maxRevealableBars === 7
                      ? "开盘阶段最多揭示到 14:30（第 7 根）；当日收盘价需点「看收盘」后才公布。"
                      : "本阶段不可继续推进。"}
            </p>
          </>
        ) : (
          <>
            {/* 需求 六/七：明确告知当日这根是「动态形成中」的K线，成交量在累计 */}
            <p className="px-2 pb-1 text-[11px] text-muted-foreground">
              {!todayBar
                ? "30 分钟数据不可用，当日按日K口径显示。"
                : todayBar.finalized
                  ? `当日已收盘（成交量 ${formatVolume(todayBar.volume)}）`
                  : `当日动态K线 · 已形成 ${todayBar.revealedBars}/8 根 · 成交量累计中（${formatVolume(todayBar.volume)}）`}
            </p>
            <KlineChart
              bars={snapshot.history}
              showVolume
              maPeriods={[5, 20]}
              height={280}
              markers={klineMarkers}
              costLine={costPrice}
              zoomStart={Math.max(
                0,
                100 - Math.round((60 / Math.max(snapshot.history.length, 1)) * 100),
              )}
              zoomEnd={100}
            />
          </>
        )}

        {/* 交易标记说明（B/S + 成本线 + 做T）
            只在**确实有标记**时渲染：空仓且无成交时完全不占位，避免图表区被一行
            永不变化的图例撑高。做T 用高亮 chip 单独突出 —— 它是当日的一个策略特征，
            而不是一条静态说明。 */}
        {(hasMarks || costPrice !== null) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pt-1.5 text-[11px] text-muted-foreground">
            <span>标记：</span>
            <span>
              <b className="text-stock-up">B</b> 买入
            </span>
            <span>
              <b className="text-stock-down">S</b> 卖出
            </span>
            {costPrice !== null && (
              <span>
                橙色虚线 = 持仓成本{" "}
                <b className="tabular text-foreground">¥{formatNumber(costPrice)}</b>
              </span>
            )}
            {snapshot.todayTrades.isDayTrade && (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary">
                今日做T · 买 {snapshot.todayTrades.buyCount} 卖 {snapshot.todayTrades.sellCount}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 当日 30m 日内 K 面板（V3 阶段 2）。
 *
 * 与日K 图**并存且互不覆盖**：日K 走 `snapshot.history`，日内图走 `/api/intraday`。
 * 这里显示的「已揭示 n/8 根」是**服务端下发的根数**，不是前端推断 ——
 * 未揭示收盘时服务端只给当日第一根（10:00），所以盘前/盘中不可能出现未来棒。
 *
 * 不传 `maPeriods` 之外的任何裁剪参数，也不做本地过滤：一旦前端开始「自己裁剪」，
 * 就又多了一处可能与服务端漂移的真相。
 */
export function IntradayPanel({
  intraday,
  maxRevealableBars,
  currentTime,
  canTick,
  busy,
  onTick,
}: {
  intraday: SimTradeIntradayInfo | null;
  /** 当前阶段允许揭示的 30m 根数上限（开盘 7 / 其余 8） */
  maxRevealableBars: number;
  /** 当前 30m 时点文案，如 `10:30` */
  currentTime: string;
  /** 是否允许继续推进 30m 游标 */
  canTick: boolean;
  busy: boolean;
  onTick: () => void;
}) {
  if (!intraday) return null;

  const { bars, expectedBars, revealClose, excludedByContamination, intradayAvailable } = intraday;

  // 不可用时明确说明原因，而不是渲染一张空图让人猜
  if (!intradayAvailable) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">日内 30 分钟 K（{intraday.date}）</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {excludedByContamination
            ? "该交易日被标记为数据污染日，已整体排除，本次不提供日内 30 分钟 K。"
            : "该交易日暂无 30 分钟数据，请以日K 为准。"}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">日内 30 分钟 K（{intraday.date}）</CardTitle>
        <Badge variant={revealClose ? "default" : "secondary"} className="text-[10px]">
          已揭示 {bars.length}/{expectedBars} 根
        </Badge>
      </CardHeader>
      <CardContent className="px-1 pb-3 md:px-3">
        <KlineChart
          bars={bars}
          showVolume
          maPeriods={[]}
          height={220}
          zoomStart={0}
          zoomEnd={100}
          xAxisMode="time"
        />
        {/* V3：30m 时间轴与操作次数是两条独立的轴 —— 这里提供逐根推进入口，
            并显式说明「推进不消耗操作次数」，避免玩家误以为推一根 K 花一次机会。 */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-1">
          <span className="text-[11px] text-muted-foreground">
            当前 30m 时点 <b className="tabular text-foreground">{currentTime}</b>
            <span className="text-muted-foreground">
              （上限 {maxRevealableBars} 根 / 共 {expectedBars} 根）
            </span>
          </span>
          {canTick && (
            <Button
              variant="outline"
              className="h-8 px-3 text-[11px]"
              onClick={onTick}
              disabled={busy}
            >
              {busy ? "处理中..." : "推进 30 分钟（不消耗操作次数）"}
            </Button>
          )}
        </div>
        {!revealClose && (
          <p className="px-2 pt-0.5 text-[11px] text-muted-foreground">
            {canTick
              ? "「推进 30 分钟」逐根揭示当日行情：推进时间不是玩家操作，不消耗操作次数。"
              : "开盘阶段最多揭示到 14:30；当日收盘价需结束开盘阶段后才公布。"}
          </p>
        )}
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

        <div className="pt-1">
          <div className="mb-1 text-xs text-muted-foreground">资产净值曲线</div>
          <EquityChart points={points} height={240} />
        </div>

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
 * 收盘动画：数字从开盘价滚动到收盘价，播完自动回调 onDone。
 * 仅在服务端已进入 CLOSE_ANIMATION（已揭示收盘价）时渲染。
 *
 * ⚠️ 死锁修复记录（2026-09-23）：
 *   本组件的 `useEffect` 依赖数组是 `[]`（动画只该跑一次），因此它**只会在挂载时
 *   捕获一次 `onDone`**。而调用方原先写成 `onDone={() => { if (!busy) onNext(); }}`，
 *   等于把**挂载那一刻的 `busy`** 一起冻进了闭包。进入 CLOSE_ANIMATION 的
 *   `advanceStage()` 会先 `setBusy(true)` 再 `setSnapshot()` —— 若面板恰在 `busy===true`
 *   时挂载，动画播完后 `onNext()` 就被静默跳过，而该面板当时没有任何其他按钮，
 *   于是**永久停在当天、日期不变**（用户报的「结算后卡在当天」）。
 *   因为是竞态，表现为「有时卡、有时不卡」。
 *
 *   修法：把 `onDone` 存进 ref 并**每次渲染后刷新**，effect 内只调 `cbRef.current()`，
 *   从而永远拿到**最新**的回调，不受 `[]` 依赖影响。调用方也不再需要用 `busy` 做门。
 */
export function CloseAnimation({
  openPrice,
  closePrice,
  onDone,
}: {
  openPrice: number;
  closePrice: number;
  onDone: () => void;
}) {
  const [progress, setProgress] = React.useState(0);
  const doneRef = React.useRef(false);
  /** 始终指向最新的 onDone（免疫 `[]` 依赖造成的闭包冻结） */
  const cbRef = React.useRef(onDone);
  React.useEffect(() => {
    cbRef.current = onDone;
  });

  React.useEffect(() => {
    let raf = 0;
    const t0 = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - t0) / CLOSE_ANIM_DURATION);
      setProgress(p);
      if (p >= 1) {
        if (!doneRef.current) {
          doneRef.current = true;
          // 用 ref 取最新回调：即使挂载时 busy 为 true 也不会被跳过
          cbRef.current();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // 动画只跑一次：progress 由内部 rAF 驱动，回调走 cbRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = openPrice + (closePrice - openPrice) * progress;
  const diff = closePrice - openPrice;
  const pct = openPrice > 0 ? (diff / openPrice) * 100 : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">今日收盘价公布中</span>
        <span className="text-xs text-muted-foreground">（{Math.round(progress * 100)}%）</span>
      </div>
      <div className="flex items-end gap-3">
        <span
          className={cn("text-3xl font-bold leading-none tabular md:text-4xl", pnlColorClass(diff))}
        >
          ¥{formatNumber(shown)}
        </span>
        {progress >= 1 && (
          <span className={cn("mb-1 text-sm tabular", pnlColorClass(diff))}>
            {diff >= 0 ? "+" : ""}
            {formatNumber(diff)}（{formatPercent(pct)}）
          </span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-100"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** 比例滑块 + 数字双向同步（1~100%） */
export function RatioSlider({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const clamp = (v: number) => Math.min(100, Math.max(1, Math.round(v)));
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-xs text-muted-foreground">比例</span>
      <input
        type="range"
        min={1}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="h-11 min-w-0 flex-1 accent-primary disabled:opacity-50"
        aria-label="操作比例"
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <input
          type="number"
          min={1}
          max={100}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(clamp(v));
          }}
          className="h-9 w-16 rounded-md border bg-background px-2 text-right text-sm tabular disabled:opacity-50"
          aria-label="操作比例数字"
        />
        <span className="text-sm text-muted-foreground">%</span>
      </div>
    </div>
  );
}

/**
 * 「今日结算」摘要 —— 收盘价 / 今日涨跌 / 总资产。
 *
 * 数据全部来自**服务端已揭示值**，前端不自行推算未来：
 *  - 收盘价：`snapshot.todayClose`（仅 `CLOSE_ANIMATION` 起非 null）
 *  - 今日涨跌：相对 `snapshot.prevClose`（前一交易日收盘，非当日开盘）
 *  - 总资产：`snapshot.summary.totalAsset`
 *
 * 收盘价缺失时显示 `—`，**绝不**退化为用当日开盘价冒充收盘价。
 */
export function SettlementSummary({ snapshot }: { snapshot: SimTradeSnapshot }) {
  const close = snapshot.todayClose;
  const prev = snapshot.prevClose;
  const pct = close !== null && prev && prev > 0 ? ((close - prev) / prev) * 100 : null;
  const diff = close !== null && prev ? close - prev : null;

  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">今日结算</div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm tabular">
        <span>
          <span className="text-muted-foreground">收盘价 </span>
          <b>{close !== null ? `¥${formatNumber(close)}` : "—"}</b>
        </span>
        <span className={cn("font-medium", pct === null ? "text-muted-foreground" : pnlColorClass(pct))}>
          今日涨跌 {pct === null ? "—" : formatPercent(pct)}
          {diff !== null && ` (${diff >= 0 ? "+" : ""}${formatNumber(diff)})`}
        </span>
        <span>
          <span className="text-muted-foreground">总资产 </span>
          <b>¥{formatMoney(snapshot.summary.totalAsset)}</b>
        </span>
      </div>
    </div>
  );
}

/**
 * 底部操作区（移动端固定在底部，含 safe-area；桌面 static）。
 *
 * 按阶段渲染多态：
 *   OPEN / CLOSE（可交易）→ 买入 / 卖出 + 比例滑块 + 确认
 *     （**观望已于 2026-09-24 取消**：推进 30 分钟 K 线不消耗操作次数，
 *      它才是「什么都不做」的正确表达，观望属于冗余的一次消耗）
 *   OPEN_CONFIRMED        → 「查看今日收盘」
 *   CLOSE_ANIMATION       → 收盘动画（播完自动推进）**+ 手动兜底按钮**
 *   CLOSE_CONFIRMED / DAY_SETTLED → 结算卡 +「进入下一交易日」
 */
export function TradeActionBar({
  snapshot,
  busy,
  pending,
  onPick,
  onConfirm,
  onConfirmPending,
  onCancelPending,
  onCancel,
  onNext,
  onNextDay,
}: {
  snapshot: SimTradeSnapshot;
  busy: boolean;
  pending: { action: SimTradeAction; percent: number } | null;
  onPick: (p: { action: SimTradeAction; percent: number } | null) => void;
  onConfirm: (mode: SimTradeExecutionMode) => void;
  onConfirmPending: () => void;
  onCancelPending: () => void;
  onCancel: () => void;
  onNext: () => void;
  /**
   * 「结算并进入下一交易日」—— **原子操作**（服务端 `/next-day`）。
   *
   * 可选：不传时退化为 `onNext`（保持既有调用方/测试可用）。
   * 之所以不让前端连调两次 `/next`：若会话已因另一标签页先走了一格，
   * 第二次调用会从新交易日的 OPEN 继续推进到 CLOSE_ANIMATION，
   * 等于**提前揭示新一天的收盘价**。服务端以「日期是否变化」为硬终止条件，可精确避免。
   */
  onNextDay?: () => void;
}) {
  const goNextDay = onNextDay ?? onNext;
  const hasPosition = !!snapshot.position && snapshot.position.quantity > 0;
  const sellableQty = snapshot.position?.availableQty ?? 0;
  const stage = snapshot.stage;
  const tradable = snapshot.tradable;
  const isLastDay = snapshot.session.dayIndex >= snapshot.session.totalDays;
  const noBuyLeft = snapshot.remainingBuy <= 0;
  const noSellLeft = snapshot.remainingSell <= 0;
  /** V3：当日总操作次数已用完（上限 8）→ 当天操作锁定 */
  const noOpsLeft = snapshot.remainingOps <= 0;
  /**
   * V3 执行模式开关（**只是「何时执行」，不是「如何执行」**）：
   *  - 立即执行 → 服务端校验后直接成交；
   *  - 需要确认 → 服务端先落 pending，再由 /confirm 成交。
   * 默认「需要确认」（更安全）。
   */
  const [execMode, setExecMode] = React.useState<SimTradeExecutionMode>("CONFIRM");
  /** 服务端落库的待确认操作 —— 前端 pending 以它为准，不持有真相 */
  const serverPending = snapshot.pendingAction;

  const pickAction = (action: SimTradeAction) => {
    if (action === "HOLD") {
      onPick({ action, percent: 0 });
      return;
    }
    const pct =
      pending && pending.action === action && pending.percent > 0
        ? pending.percent
        : DEFAULT_PERCENT;
    onPick({ action, percent: pct });
  };

  const priceLabel = stage === "OPEN" ? "开盘价" : "收盘价";

  let body: React.ReactNode;

  if (serverPending) {
    /* -------- V3 确认模式：服务端已有待确认操作，等待「确认成交 / 取消」 --------
     * 注意：此刻**尚未成交、也未消耗任何次数**；确认时服务端会再完整校验一遍
     * （阶段 / 交易日 / 额度 / 资金 / 持仓 / T+1 / 成交价），任一项不满足即拒绝。 */
    body = (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">待确认操作</span>
          <span className="font-semibold">
            {ACTION_NAME[serverPending]}
            {serverPending !== "HOLD" && snapshot.pendingPercent !== null
              ? ` · ${snapshot.pendingPercent}%`
              : ""}
          </span>
          <span className="text-xs text-muted-foreground">
            （{snapshot.session.currentDate}，按今日{priceLabel}成交；确认前未成交、未消耗次数）
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            className="h-11 flex-1 text-sm md:h-9 md:flex-none md:px-8"
            onClick={onConfirmPending}
            disabled={busy}
          >
            {busy ? "提交中..." : "确认成交"}
          </Button>
          <Button variant="outline" className="h-11 md:h-9" onClick={onCancelPending} disabled={busy}>
            取消
          </Button>
        </div>
        {!tradable && (
          <p className="text-[10px] text-muted-foreground">
            当前已不可交易（额度用完或阶段已推进）—— 确认时服务端会再次校验并拒绝。
          </p>
        )}
      </div>
    );
  } else if (tradable) {
    /* ---------------- 可交易阶段：选择 + 确认 ---------------- */
    body = pending ? (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">{STAGE_LABEL[stage]}操作</span>
          <span className="font-semibold">
            {ACTION_NAME[pending.action]}
            {pending.action !== "HOLD" && ` · ${pending.percent}%`}
          </span>
          <span className="text-xs text-muted-foreground">
            （{snapshot.session.currentDate}，按今日{priceLabel}成交）
          </span>
        </div>
        {pending.action !== "HOLD" && (
          <RatioSlider
            value={pending.percent || DEFAULT_PERCENT}
            disabled={busy}
            onChange={(v) =>
              onPick({ action: pending.action === "HOLD" ? "BUY" : pending.action, percent: v })
            }
          />
        )}
        {/* V3 执行方式：两种模式走**同一套**交易规则，差别只在「是否先落 pending」 */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">执行方式</span>
          <Button
            variant={execMode === "INSTANT" ? "default" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setExecMode("INSTANT")}
            disabled={busy}
          >
            立即执行
          </Button>
          <Button
            variant={execMode === "CONFIRM" ? "default" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setExecMode("CONFIRM")}
            disabled={busy}
          >
            需要确认
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            className="h-11 flex-1 text-sm md:h-9 md:flex-none md:px-8"
            onClick={() => onConfirm(execMode)}
            disabled={busy}
          >
            {busy
              ? "提交中..."
              : execMode === "CONFIRM"
                ? `提交待确认${STAGE_LABEL[stage]}操作`
                : `确认${STAGE_LABEL[stage]}操作`}
          </Button>
          <Button variant="outline" className="h-11 md:h-9" onClick={onCancel} disabled={busy}>
            取消
          </Button>
        </div>
      </div>
    ) : (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="w-8 shrink-0 text-xs text-muted-foreground">动作</span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {/* 核心按钮：买入 / 卖出。
                「加仓」与「买入」是同一个 BUY 动作（同样消耗 1 次、同样受买入 ≤2 限制），
                故合并为一个「买入」按钮，不再按是否持仓拆成两个按钮。
                **观望（HOLD）已于 2026-09-24 取消**：玩家可直接「推进 30 分钟 K 线」
                而不消耗任何操作次数，「什么都不做」已由推进时间承担，观望是冗余的。 */}
            <Button
              variant="buy"
              className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9"
              disabled={busy || noBuyLeft}
              onClick={() => pickAction("BUY")}
            >
              买入
            </Button>
            <Button
              variant="sell"
              className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9"
              disabled={busy || !hasPosition || sellableQty <= 0 || noSellLeft}
              onClick={() => pickAction("SELL")}
            >
              卖出
            </Button>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          比例按「可用资金 / 可卖份额」口径（非目标总仓位）；先选动作，再用滑块定比例，点确认才成交。
          {hasPosition && sellableQty <= 0 && " 当日买入份额 T+1 后才可卖。"}
          {noBuyLeft && " 今日买入次数已用完。"}
          {noSellLeft && " 今日卖出次数已用完。"}
        </p>
        {/* V3：操作次数是玩家行为计数，推进时间不消耗操作 —— 因此这里提供显式推进入口，
            否则玩家必须在用完 8 次操作后才走得动。
            V3（2026-09-23）：`CLOSE` 已是「收盘后」，直接给结算卡 + 一步换日。 */}
        {stage === "CLOSE" && <SettlementSummary snapshot={snapshot} />}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {/* 2026-09-24：**不再显示「今日操作 X/8」**。
              观望取消后，能消耗操作的只剩「买 ≤2 + 卖 ≤2」，实际可达上限是 4，
              而总操作上限是 8 —— 展示一个永远够不到的额度只会让人困惑。
              按用户决定：保留后端 8 次作为安全上限，界面只展示真正会用完的两项配额。 */}
          <span className="tabular text-xs text-muted-foreground">
            买入 <b className="text-foreground">{2 - snapshot.remainingBuy}/2</b>
            <span className="mx-1.5">·</span>
            卖出 <b className="text-foreground">{2 - snapshot.remainingSell}/2</b>
          </span>
          <Button
            variant="outline"
            className="h-8 px-3 text-[11px]"
            onClick={stage === "CLOSE" ? goNextDay : onNext}
            disabled={busy}
          >
            {stage === "OPEN" ? "看收盘" : "进入下一交易日"}
          </Button>
        </div>
      </div>
    );
  } else if (stage === "OPEN_CONFIRMED") {
    /* ---------------- 开盘已操作：查看收盘 ---------------- */
    body = (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">开盘阶段已完成</span>
          <span className="text-xs text-muted-foreground">
            （点击后公布今日收盘价，进入收盘阶段）
          </span>
        </div>
        <Button
          variant="default"
          className="h-11 w-full text-sm md:h-9 md:w-auto md:px-8"
          onClick={onNext}
          disabled={busy}
        >
          {busy ? "加载中..." : "查看今日收盘"}
        </Button>
      </div>
    );
  } else if (stage === "CLOSE_ANIMATION") {
    /* ---------------- 收盘动画 ----------------
     * 死锁修复（2026-09-23）：
     *   1. `onDone` 不再用 `busy` 做门 —— 该值会被 CloseAnimation 的 `[]` effect
     *      冻结在挂载那一刻，若挂载时 busy===true 就会静默跳过推进，导致永久卡在当天。
     *      服务端 `advanceSimTradeStage` 自带 CAS + 幂等兜底，重复调用是安全的。
     *   2. 面板**必须**提供一个手动出口：只有自动跳转、没有手动入口的面板，
     *      一次异常就变成死胡同。这里补一个「进入收盘阶段」按钮作为兜底。 */
    body = (
      <div className="space-y-2">
        <CloseAnimation
          openPrice={snapshot.openPrice}
          closePrice={snapshot.todayClose ?? snapshot.openPrice}
          onDone={onNext}
        />
        <Button
          variant="outline"
          className="h-9 w-full text-xs md:w-auto md:px-6"
          onClick={onNext}
          disabled={busy}
        >
          {busy ? "处理中..." : "进入收盘阶段"}
        </Button>
      </div>
    );
  } else if ((stage === "OPEN" || stage === "CLOSE") && noOpsLeft) {
    /* -------- 当日操作额度用尽，阶段仍停在 OPEN/CLOSE --------
     * 旧模型下「阶段未完成」= 本阶段没操作过；新模型下可操作与否只由总操作数决定，
     * 因此必须单独处理「额度耗尽但时间未推进」这一状态，否则会掉进下面
     * 「收盘阶段已完成」的错误文案里。
     * V3（2026-09-23）：`CLOSE` 阶段已是「当日收盘后」，直接给结算卡 + 一步换日。
     *
     * 注（2026-09-24）：观望取消后，实际操作数上限 = 买 2 + 卖 2 = 4 < 8，
     * **本分支在正常玩法下已不可达**，保留它只作安全兜底（防御规则变更或非常规调用）。 */
    const atClose = stage === "CLOSE";
    body = (
      <div className="space-y-2">
        {atClose && <SettlementSummary snapshot={snapshot} />}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-medium text-destructive">今日操作次数已用完</span>
          <span className="text-xs text-muted-foreground">
            （{snapshot.session.currentDate}；推进时间不消耗操作次数）
          </span>
        </div>
        {/* 按钮**保留但全部禁用**（而不是隐藏），让用户明确看到被锁定 */}
        <div className="flex items-center gap-1.5">
          <span className="w-8 shrink-0 text-xs text-muted-foreground">动作</span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            <Button variant="buy" className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9" disabled>
              买入
            </Button>
            <Button variant="sell" className="h-11 min-w-0 flex-1 px-1 text-xs md:h-9" disabled>
              卖出
            </Button>
          </div>
        </div>
        <Button
          variant="default"
          className="h-11 w-full text-sm md:h-9 md:w-auto md:px-8"
          onClick={atClose ? goNextDay : onNext}
          disabled={busy}
        >
          {busy ? "处理中..." : atClose ? "进入下一交易日" : "看收盘"}
        </Button>
      </div>
    );
  } else {
    /* -------- 已收盘 / 已结算 → 结算卡 + 一步进入下一交易日 --------
     * V3（2026-09-23）合并了原先的「结算今日 → 进入下一交易日」两步：
     * 用户需求（十九）是「第 8 个节点后 → 公布收盘 → 结算 → 结算卡 → [进入下一交易日]」，
     * 一次点击即完成换日。此处走**原子接口** `onNextDay`（服务端保证不越过新日 OPEN），
     * 因此不必再让用户先点一次「结算今日」。
     * `CLOSE_CONFIRMED` 属历史数据兼容分支，同样一跳到下一交易日。 */
    const settled = stage === "DAY_SETTLED";
    body = (
      <div className="space-y-2">
        <SettlementSummary snapshot={snapshot} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            {settled ? "今日已结算" : "收盘阶段已完成"}
          </span>
          <span className="text-xs text-muted-foreground">
            （{snapshot.session.currentDate}，可进入下一交易日）
          </span>
        </div>
        <Button
          variant="default"
          className="h-11 w-full text-sm md:h-9 md:w-auto md:px-8"
          onClick={goNextDay}
          disabled={busy}
        >
          {busy
            ? "处理中..."
            : isLastDay
              ? "结束本局并查看结算"
              : "进入下一交易日"}
        </Button>
      </div>
    );
  }

  return (
    <div
      /* 移动端底部**堆叠**：底部 tab bar 占据最底一层，其高度为
         `--tabbar-h + env(safe-area-inset-bottom)`。本操作栏必须整体上移同样的距离，
         否则「买入 / 卖出」两个按钮会被 tab bar 盖住 —— 这是加了底部导航后
         最容易漏掉的一处。
         安全区（home indicator）已由 tab bar 消费，因此这里不再重复留 safe-area，
         只保留常规内边距 `pb-2.5`。
         桌面端 `md:static` 还原为普通文档流元素，不受影响。 */
      className="fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] z-30 border-t bg-background/95 pb-2.5 backdrop-blur md:static md:bottom-auto md:rounded-md md:border md:shadow-sm"
    >
      <div className="mx-auto max-w-[1320px] px-3 py-2.5 md:px-4 md:py-3">{body}</div>
    </div>
  );
}
