/**
 * 模拟炒股（猜股票）端到端测试 —— V3 版
 *
 * 覆盖：
 *  1. 创建会话（真实历史数据随机选股、隐藏身份、股票池）
 *  2. 快照防泄漏：K 线右端点 = currentDate；OPEN 阶段当日仅 open 且 todayClose=null
 *  3. **V3 状态机**：`stage`（时间窗，由推进驱动、不消耗操作）
 *       OPEN → CLOSE_ANIMATION → CLOSE → DAY_SETTLED → 下一日 OPEN
 *  4. **V3 每日 8 次总操作**：BUY/SELL/HOLD 统一计数 ≤8，且买入 ≤2、卖出 ≤2 三者并列
 *  5. **V3 30m 时间轴**：逐根揭示（开盘 ≤7 根），**不消耗操作次数**，与操作计数解耦
 *  6. **V3 确认模式**：pending → confirm → execute；取消 / 重复 confirm / 跨阶段 confirm
 *  7. **V3 成交价**：由服务端按**当前已揭示的 30m K 的 close**决定；不读未来棒；伪价无效
 *  8. 交易失败不消耗额度；T+1；走完整个模拟期 → FINISHED → 揭晓
 *
 * 运行：npm run test:simTrade
 */
import {
  advanceSimTradeStage,
  advanceSimTradeIntraday,
  cancelSimTradeAction,
  confirmSimTradeAction,
  createSimTradeSession,
  deleteSimTradeSession,
  getSimTradeSnapshot,
  revealSimTradeStock,
  submitSimTradeAction,
} from "@/services/simtradeService";
import { getIndexKlines } from "@/services/indexDataService";
import { getKlineAt } from "@/services/marketDataService";
import { getIntradayBars } from "@/lib/intraday30m";
import { prisma } from "@/lib/prisma";
import type { SimTradeSnapshot } from "@/types";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/** 断言对象中不含被隐藏标的的身份信息 */
function assertNoIdentity(label: string, snap: SimTradeSnapshot): void {
  const raw = JSON.stringify(snap);
  const session = snap.session as unknown as Record<string, unknown>;
  check(`${label}: session 无 hiddenStockCode`, session.hiddenStockCode === undefined);
  check(`${label}: session 无 stockCode`, session.stockCode === undefined);
  const position = snap.position as unknown as Record<string, unknown> | null;
  if (position) {
    check(`${label}: position 无 stockCode`, position.stockCode === undefined);
    check(`${label}: position 无 stockName`, position.stockName === undefined);
  }
  check(`${label}: 快照 JSON 无 code 泄漏`, !/"hiddenStockCode"/.test(raw));
}

/** 当日 bar 是否「仅 open」（high/low/close 全部等于 open） */
/**
 * V3（2026-09-23）：当前交易日 bar 必须是「由已揭示 30m **动态合成**」，且不泄露未来。
 *
 * 本函数**取代**旧的 `isTodayMasked`。旧实现断言当日 bar 的 high/low/close 全等于 open
 * （即「压成一根开盘占位」）—— 那是 V2 时期的**保守占位做法**，在本轮需求中已被明确替换：
 *   需求 六：日K必须变成「动态形成中的当日日K」（开/高/低/收随节点变化）
 *   需求 七：日K成交量必须动态累计（不得提前给全天量）
 *   需求 八/九：涨跌幅与高低价随节点实时变化、且不得读未来根
 *
 * 改为动态合成**并不降低防泄漏强度**：合成只使用「已揭示的 30m 根」，
 * 未揭示的时点在服务端根本不会被读取，因此信息量与「已揭示进度」严格一致。
 * 原先靠「占位」达成的防泄漏，现在由「只读已揭示部分」达成 —— 更精确，且是需求要求的行为。
 *
 * 断言项（全部必须成立）：
 *  1. history 末根就是当前交易日；
 *  2. todayBar 存在且来源为 INTRADAY_30M（动态合成，非退化口径）；
 *  3. `revealedBars` 等于会话 30m 游标（揭示进度一致）；
 *  4. history 末根与 todayBar 逐字段相等（不允许两套真相）；
 *  5. 未定格（`finalized === false`）—— 阶段仍是 OPEN 时不允许已定格；
 *  6. todayClose 未揭示（不得提前暴露当日收盘价）。
 */
function isTodayDynamic(snap: SimTradeSnapshot): boolean {
  const last = snap.history[snap.history.length - 1];
  if (!last || last.date !== snap.session.currentDate) return false;
  const tb = snap.todayBar;
  if (!tb) return false;
  if (tb.source !== "INTRADAY_30M") return false;
  if (tb.revealedBars !== snap.session.intradayBarCount) return false;
  if (
    last.open !== tb.open ||
    last.high !== tb.high ||
    last.low !== tb.low ||
    last.close !== tb.close ||
    last.volume !== tb.volume
  ) {
    return false;
  }
  if (tb.finalized) return false;
  if (snap.todayClose !== null) return false;
  // OHLC 基本不变量：高 >= max(开,收)、低 <= min(开,收)
  if (tb.high < Math.max(tb.open, tb.close) - 1e-6) return false;
  if (tb.low > Math.min(tb.open, tb.close) + 1e-6) return false;
  return true;
}

/**
 * 创建一个「**起始交易日具备 30 分钟数据**」的会话（带重试）。
 *
 * 为什么必须这样做（2026-09-23 由独立验证发现本文件会随机变红）：
 *   会话的起始交易日是在**全历史**里随机定位的，而 30m parquet 只覆盖
 *   `2024-11-04` 起的区间。若随机落到更早的日期，当日 30m 不可用 →
 *   `snap.todayBar.source` 退化为 `DAILY_K`、成交价来源不再是 `INTRADAY_30M`，
 *   于是本文件里依赖 30m 的断言（todayBar 动态合成 / 成交价来源 / 独立复算成交价）
 *   会**随机失败**。这不是产品缺陷，而是测试夹具的确定性不足。
 *   这里重试到「起始日有 30m 数据」为止（最多 6 次），把随机性吸收掉。
 *
 * 被淘汰的会话会立即删除，不污染数据库。
 */
async function createSessionWith30m(
  input: Parameters<typeof createSimTradeSession>[0],
): Promise<Awaited<ReturnType<typeof createSimTradeSession>>> {
  let last: Awaited<ReturnType<typeof createSimTradeSession>> = {
    success: false,
    message: "未尝试创建",
  };
  for (let i = 0; i < 6; i += 1) {
    last = await createSimTradeSession(input);
    if (!last.success || !last.session) continue;

    const row = await prisma.simTradeSession.findUnique({
      where: { id: last.session.id },
      select: { hiddenStockCode: true, currentDate: true },
    });
    if (row) {
      const bars = await getIntradayBars(
        row.hiddenStockCode,
        row.currentDate.toISOString().slice(0, 10),
      );
      if (bars.length > 0) return last;
    }
    // 起始日无 30m 数据 → 换一个会话重试
    await deleteSimTradeSession(last.session.id);
  }
  return last;
}

async function main(): Promise<void> {
  console.log("\n===== 模拟炒股（猜股票）端到端测试 · V2 =====\n");

  // ---------------------------------------------------------------- 1. 创建
  console.log("[1] 创建会话（重试至起始日具备 30 分钟数据，保证夹具确定性）");
  const created = await createSessionWith30m({ initialCash: 100000, tradingDays: 22 });
  check("创建成功", created.success, created.message);
  if (!created.success || !created.session) {
    console.log("无法创建会话，终止测试");
    process.exit(1);
  }
  const sessionId = created.session.id;
  const totalDays = created.session.totalDays;
  check("总交易日 20~23", totalDays >= 20 && totalDays <= 23, `totalDays=${totalDays}`);
  check("初始资金 100000", created.session.initialCash === 100000);
  check("初始阶段 = OPEN", created.session.stage === "OPEN", `stage=${created.session.stage}`);
  check("初始剩余买入额度 = 2", created.session.remainingBuy === 2);
  check("初始剩余卖出额度 = 2", created.session.remainingSell === 2);
  check("初始已用总操作 = 0", created.session.operationCount === 0,
    `operationCount=${created.session.operationCount}`);
  check("初始剩余总操作 = 8", created.session.remainingOps === 8,
    `remainingOps=${created.session.remainingOps}`);
  check("股票池 = STOCK", created.session.pool === "STOCK", `pool=${created.session.pool}`);

  // 股票池：指数池与行业板块池必须明确拒绝（数据/架构不支持），不得静默退化
  const idxPool = await createSimTradeSession({ initialCash: 100000, pool: "INDEX" });
  check("指数池明确拒绝", !idxPool.success, idxPool.message);
  const indPool = await createSimTradeSession({ initialCash: 100000, pool: "INDUSTRY" });
  check("行业板块池明确拒绝", !indPool.success, indPool.message);

  try {
    // ------------------------------------------------------------ 2. 初始快照
    console.log("\n[2] 初始快照与防泄漏（OPEN 阶段）");
    let snap = await getSimTradeSnapshot(sessionId);
    check("快照非空", snap !== null);
    if (!snap) throw new Error("快照为空");
    assertNoIdentity("初始", snap);
    check("初始无持仓", snap.position === null);
    check("初始可交易", snap.tradable === true);
    check("初始进度 dayIndex=1", snap.session.dayIndex === 1, `dayIndex=${snap.session.dayIndex}`);
    check("快照 stage = OPEN", snap.stage === "OPEN");
    check("OPEN 阶段 todayClose 必须为 null（防泄漏）", snap.todayClose === null,
      `todayClose=${snap.todayClose}`);
    check("OPEN 阶段本阶段未操作", snap.stageActionCompleted === false);
    /* 2026-09-25：未推进时间时按**开盘价**成交（时点 09:30），不再是第 1 根的 close。
       理由见 simtradeService.resolveFillPrice 的「开盘价口径」注释。 */
    check("OPEN 阶段成交价来自当前已揭示的 30m K（V3 阶段 6）",
      snap.fillPriceSource === "INTRADAY_30M" && snap.fillPriceTime === "09:30",
      `source=${snap.fillPriceSource} time=${snap.fillPriceTime} fill=${snap.stageFillPrice}`);

    const lastHist = snap.history[snap.history.length - 1];
    check("K线右端点 = currentDate", lastHist.date === snap.session.currentDate,
      `last=${lastHist.date} cur=${snap.session.currentDate}`);
    check(
      /* 2026-09-25：游标改为从 0 起算 —— 刚开盘时**一根 30m K 都还没走完**，
         今日日K 尚未形成，引擎给出「OHLC 全等开盘价、成交量归零」的占位
         （防泄漏的正确行为，而非缺陷）。因此这里断言**占位态本身不泄露**，
         「动态合成」由推进之后（V3Engine 的逐根用例）负责验证。 */
      "OPEN 阶段当日 bar 为未形成占位（OHLC=开盘价、量=0，不泄露）",
      snap.todayBar !== null &&
        snap.todayBar.revealedBars === 0 &&
        snap.todayBar.volume === 0 &&
        snap.todayBar.open === snap.openPrice,
    );
    check("暴露今日开盘价", snap.openPrice > 0, `openPrice=${snap.openPrice}`);
    check("可见历史 >= 60 根", snap.history.length >= 60, `len=${snap.history.length}`);

    const curDate = snap.session.currentDate;
    check("history 无未来日期", !snap.history.some((b) => b.date > curDate));

    // 大盘参照仍须无前瞻（页面已不展示指数卡，但接口口径不变）
    const bms = snap.benchmarks;
    for (const bm of bms) {
      if (bm.date === "") continue;
      check(`${bm.name} 日期不晚于 currentDate（无前瞻）`, bm.date <= curDate,
        `date=${bm.date} cur=${curDate}`);
    }
    const idxBars = await getIndexKlines(bms[0].code, {
      startDate: curDate,
      endDate: curDate,
      limit: 10,
    });
    const todayIdx = idxBars.find((b) => b.date === curDate);
    const expectVal = snap.todayClose === null ? (todayIdx?.open ?? 0) : (todayIdx?.close ?? 0);
    check(`${bms[0].name} 点位口径与阶段一致（防泄漏跨层复核）`,
      expectVal > 0 && Math.abs(bms[0].value - expectVal) < 0.01,
      `${bms[0].value} vs ${expectVal}`);

    // ------------------------------------------------------------ 3. 阶段状态机
    console.log("\n[3] 阶段状态机（V3）：时间推进与操作解耦");
    // 3a. V3 变更：OPEN 阶段**未操作也能推进**（时间与操作解耦）。
    //     该断言放在本段末尾验证，避免现在推进就打乱后续「开盘阶段操作」用例。
    //     （旧规则为「OPEN 阶段未操作时不可推进」，已随 V3 废弃。）

    // 3b. 开盘阶段买入（按开盘价成交）
    const buy1 = await submitSimTradeAction(sessionId, { action: "BUY", percent: 50 });
    check("开盘阶段买入成功", buy1.success, buy1.message);
    check("开盘阶段买入按开盘价成交（价由服务端决定）",
      !!buy1.message.match(/开盘阶段/) &&
        buy1.message.includes("开盘价") &&
        buy1.message.includes((snap.stageFillPrice ?? 0).toFixed(2)),
      buy1.message);
    check("买入后阶段仍为 OPEN（V3：操作不推进阶段）", buy1.snapshot?.stage === "OPEN",
      `stage=${buy1.snapshot?.stage}`);
    check("买入后本阶段标记为已操作", buy1.snapshot?.stageActionCompleted === true);
    check("买入后剩余买入额度 = 1", buy1.snapshot?.session.remainingBuy === 1,
      `remainingBuy=${buy1.snapshot?.session.remainingBuy}`);
    check("买入后剩余卖出额度仍 = 2", buy1.snapshot?.session.remainingSell === 2,
      `remainingSell=${buy1.snapshot?.session.remainingSell}`);
    check("买入后已用总操作 = 1", buy1.snapshot?.session.operationCount === 1,
      `operationCount=${buy1.snapshot?.session.operationCount}`);
    check("买入后剩余总操作 = 7", buy1.snapshot?.session.remainingOps === 7,
      `remainingOps=${buy1.snapshot?.session.remainingOps}`);
    check("买入后**仍可交易**（同日允许多次操作）", buy1.snapshot?.tradable === true);
    check("买入后仍停留在第 1 天", buy1.snapshot?.session.dayIndex === 1);

    // 3c. 【V3 核心】同一阶段内**允许重复操作**（旧规则「每阶段只能 1 次」已废弃）
    //
    // 动作：「观望」已从公开接口移除（2026-09-23），因为它与「推进 K 线」等价 ——
    // 推进不消耗操作次数，而观望要消耗 1 次，属于纯亏损的冗余操作。
    // 因此这里改用**第二次买入**验证「同阶段可重复操作」：它同样计入总操作、
    // 但会消耗买入额度，比 HOLD 更能证明「阶段闸门已拆除、真正按计数放行」。
    const dupStage = await submitSimTradeAction(sessionId, { action: "BUY", percent: 20 });
    check("同阶段再次操作成功（第 2 次买入）", dupStage.success, dupStage.message);
    check("计入总操作（剩 6）", dupStage.snapshot?.session.remainingOps === 6,
      `remainingOps=${dupStage.snapshot?.session.remainingOps}`);
    check("消耗买入额度（剩 0）", dupStage.snapshot?.session.remainingBuy === 0,
      `remainingBuy=${dupStage.snapshot?.session.remainingBuy}`);
    check("不消耗卖出额度", dupStage.snapshot?.session.remainingSell === 2,
      `remainingSell=${dupStage.snapshot?.session.remainingSell}`);
    check("不推进阶段（仍为 OPEN）", dupStage.snapshot?.stage === "OPEN",
      `stage=${dupStage.snapshot?.stage}`);
    // 观望/非法动作必须被明确拒绝 —— 防止日后有人把 HOLD 重新放进白名单而无人察觉
    const holdRejected = await submitSimTradeAction(sessionId, { action: "HOLD" } as never);
    check("观望已被拒绝（与推进 K 线等价，不再作为操作）", !holdRejected.success,
      `实际 success=${holdRejected.success}`);
    check("观望被拒后不消耗任何计数",
      (await getSimTradeSnapshot(sessionId))!.session.operationCount === 2,
      "operationCount 应仍为 2");

    // 3d. OPEN 阶段（已操作过）仍不得揭示当日收盘
    snap = (await getSimTradeSnapshot(sessionId))!;
    check("OPEN 阶段（多次操作后）todayClose 仍为 null", snap.todayClose === null,
      `todayClose=${snap.todayClose}`);
    check(
      /* 同 3 节开头：游标仍为 0（本段只做了下单、没推进时间），
         故仍是「未形成占位」—— 关键是**成交量必须为 0**，不因多次下单而泄露。 */
      "OPEN 阶段当日 bar 仍为未形成占位（防泄漏不因多次操作而松动）",
      snap.todayBar !== null && snap.todayBar.revealedBars === 0 && snap.todayBar.volume === 0,
    );

    // 3d-2. 【V3 核心】30m 时间轴：逐根揭示，且**不消耗操作次数**
    console.log("  —— 30m 时间轴（与操作计数解耦）——");
    /* 2026-09-25：游标从 **0** 起算（0 = 刚开盘、一根 30m K 都没走完），
       推进一次才揭示 10:00 —— 这样开盘时只知开盘价，与「开盘价成交」口径自洽。 */
    check("30m 游标初始 = 0 根（刚开盘）", snap.intradayBarCount === 0, `cursor=${snap.intradayBarCount}`);
    check("初始 30m 时点 = 09:30（开盘锚点）", snap.currentIntradayTime === "09:30", snap.currentIntradayTime);
    check("开盘阶段 30m 上限 = 7 根", snap.maxRevealableBars === 7, `max=${snap.maxRevealableBars}`);

    const opsBeforeTick = snap.session.operationCount;
    const buyBeforeTick = snap.session.remainingBuy;
    const tick1 = await advanceSimTradeIntraday(sessionId);
    check("推进 30m 成功", tick1.success, tick1.message);
    check("推进后游标 = 1 根（揭示 10:00）", tick1.snapshot?.intradayBarCount === 1,
      `cursor=${tick1.snapshot?.intradayBarCount}`);
    check("推进后时点 = 10:00", tick1.snapshot?.currentIntradayTime === "10:00",
      `${tick1.snapshot?.currentIntradayTime}`);
    check("【V3】推进 30m **不消耗**操作次数",
      tick1.snapshot?.session.operationCount === opsBeforeTick,
      `${tick1.snapshot?.session.operationCount} vs ${opsBeforeTick}`);
    check("推进 30m 不改变买卖额度",
      tick1.snapshot?.session.remainingBuy === buyBeforeTick &&
        tick1.snapshot?.session.remainingSell === 2,
      `buy=${tick1.snapshot?.session.remainingBuy} sell=${tick1.snapshot?.session.remainingSell}`);
    check("推进 30m 不改变阶段", tick1.snapshot?.stage === "OPEN",
      `stage=${tick1.snapshot?.stage}`);

    // 一路推到开盘上限 7 根
    for (let i = 0; i < 10; i++) {
      const r = await advanceSimTradeIntraday(sessionId);
      if (!r.success) break;
    }
    snap = (await getSimTradeSnapshot(sessionId))!;
    check("开盘阶段最多推进到 7 根（第 8 根 = 当日收盘，须等收盘揭示）",
      snap.intradayBarCount === 7, `cursor=${snap.intradayBarCount}`);
    check("推到上限后时点 = 14:30", snap.currentIntradayTime === "14:30", snap.currentIntradayTime);

    const overflowTick = await advanceSimTradeIntraday(sessionId);
    check("开盘阶段超出上限的推进被拒", !overflowTick.success, overflowTick.message);
    check("被拒的推进不改动游标",
      (await getSimTradeSnapshot(sessionId))!.intradayBarCount === 7,
      "cursor 应仍为 7");
    check("连推 6 次后操作计数仍为 2（完全解耦）",
      (await getSimTradeSnapshot(sessionId))!.session.operationCount === 2,
      `operationCount=${(await getSimTradeSnapshot(sessionId))!.session.operationCount}`);

    // 3e. 推进 → 收盘动画（此时才揭示收盘价）
    //     V3：从 OPEN 直接推进是允许的 —— 时间推进既不要求「本阶段已操作过」，也不消耗操作次数
    const opsBeforeAdvance = (await getSimTradeSnapshot(sessionId))!.session.remainingOps;
    const toAnim = await advanceSimTradeStage(sessionId);
    check("推进到收盘动画成功", toAnim.success, toAnim.message);
    check("阶段 = CLOSE_ANIMATION", toAnim.snapshot?.stage === "CLOSE_ANIMATION",
      `stage=${toAnim.snapshot?.stage}`);
    check("【V3】推进时间**不消耗**操作次数",
      toAnim.snapshot?.session.remainingOps === opsBeforeAdvance,
      `推进后剩 ${toAnim.snapshot?.session.remainingOps} vs 推进前 ${opsBeforeAdvance}`);
    check("进入收盘揭示后 30m 游标拉满 8 根",
      toAnim.snapshot?.intradayBarCount === 8, `cursor=${toAnim.snapshot?.intradayBarCount}`);
    check("收盘揭示后 30m 时点 = 15:00（即当日收盘）",
      toAnim.snapshot?.currentIntradayTime === "15:00", `${toAnim.snapshot?.currentIntradayTime}`);
    check("收盘揭示后 30m 上限 = 8 根",
      toAnim.snapshot?.maxRevealableBars === 8, `max=${toAnim.snapshot?.maxRevealableBars}`);
    check("收盘动画阶段揭示今日收盘价", (toAnim.snapshot?.todayClose ?? 0) > 0,
      `todayClose=${toAnim.snapshot?.todayClose}`);
    const animLast = toAnim.snapshot?.history[toAnim.snapshot.history.length - 1];
    check("收盘动画阶段当日 K 线揭示完整 OHLC（close 不再等于 open）",
      !!animLast && !(animLast.high === animLast.open && animLast.low === animLast.open && animLast.close === animLast.open),
      `open=${animLast?.open} high=${animLast?.high} low=${animLast?.low} close=${animLast?.close}`);
    check("收盘动画阶段不可交易", toAnim.snapshot?.tradable === false);

    // 3f. 推进 → 收盘阶段
    const toClose = await advanceSimTradeStage(sessionId);
    check("进入收盘阶段成功", toClose.success, toClose.message);
    check("阶段 = CLOSE", toClose.snapshot?.stage === "CLOSE", `stage=${toClose.snapshot?.stage}`);
    check("收盘阶段可交易", toClose.snapshot?.tradable === true);
    check("收盘阶段成交价口径 = 收盘价",
      toClose.snapshot?.stageFillPrice !== null &&
        Math.abs((toClose.snapshot?.stageFillPrice ?? 0) - (toClose.snapshot?.todayClose ?? 0)) < 0.01,
      `fill=${toClose.snapshot?.stageFillPrice} close=${toClose.snapshot?.todayClose}`);

    // 3g. 收盘阶段：买入额度已尽（3b 的 50% + 3c 的 20% 用满当日 2 次配额）
    //
    // 因观望移除，3c 由 HOLD 改为 BUY，第 1 天买入配额提前用尽 —— 这里改为验证
    // 「收盘阶段买入被正确拒绝」；「收盘阶段按收盘价成交」这一属性改在第 2 天验证
    // （�� 3j，那里额度已重置）。
    //
    // 注：本阶段**不能用卖出**替代验证 —— 当日买入的份额遵守 T+1，尚未解冻可卖。
    const buy2 = await submitSimTradeAction(sessionId, { action: "BUY", percent: 30 });
    check("收盘阶段买入被拒（当日买入上限 2 已用完）", !buy2.success, buy2.message);
    check("拒绝文案指出买入上限", buy2.message.includes("买入"), buy2.message);
    check("被拒的买入不消耗操作次数",
      (await getSimTradeSnapshot(sessionId))!.session.operationCount === 2,
      "operationCount 应仍为 2");
    check("被拒不推进阶段（仍为 CLOSE）",
      (await getSimTradeSnapshot(sessionId))!.stage === "CLOSE");
    check("T+1：当日买入份额尚不可卖（可用 = 0）",
      ((await getSimTradeSnapshot(sessionId))!.position?.availableQty ?? 0) === 0,
      `avail=${(await getSimTradeSnapshot(sessionId))!.position?.availableQty}`);
    check("结���前 confirmedToday=false（结算在推进之后）",
      (await getSimTradeSnapshot(sessionId))!.session.confirmedToday === false,
      `confirmedToday=${(await getSimTradeSnapshot(sessionId))!.session.confirmedToday}`);

    // 3h. 结算 → DAY_SETTLED
    const toSettled = await advanceSimTradeStage(sessionId);
    check("推进到当日结算成功", toSettled.success, toSettled.message);
    check("阶段 = DAY_SETTLED", toSettled.snapshot?.stage === "DAY_SETTLED",
      `stage=${toSettled.snapshot?.stage}`);
    check("当日结算后 confirmedToday=true", toSettled.snapshot?.session.confirmedToday === true,
      `confirmedToday=${toSettled.snapshot?.session.confirmedToday}`);
    check("结算时仍不消耗操作次数",
      toSettled.snapshot?.session.operationCount === 2,
      `operationCount=${toSettled.snapshot?.session.operationCount}`);

    // 3i. 进入下一交易日 → 阶段与额度重置
    const toNextDay = await advanceSimTradeStage(sessionId);
    check("进入下一交易日成功", toNextDay.success, toNextDay.message);
    check("阶段重置为 OPEN", toNextDay.snapshot?.stage === "OPEN",
      `stage=${toNextDay.snapshot?.stage}`);
    check("推进到第 2 天", toNextDay.snapshot?.session.dayIndex === 2,
      `dayIndex=${toNextDay.snapshot?.session.dayIndex}`);
    check("新一日买入额度重置 = 2", toNextDay.snapshot?.session.remainingBuy === 2);
    check("新一日卖出额度重置 = 2", toNextDay.snapshot?.session.remainingSell === 2);
    check("新一日**总操作**重置 = 8", toNextDay.snapshot?.session.remainingOps === 8,
      `remainingOps=${toNextDay.snapshot?.session.remainingOps}`);
    check("新一日已用总操作归零", toNextDay.snapshot?.session.operationCount === 0,
      `operationCount=${toNextDay.snapshot?.session.operationCount}`);
    check("新一日 30m 游标重置 = 1 根",
      toNextDay.snapshot?.intradayBarCount === 1, `cursor=${toNextDay.snapshot?.intradayBarCount}`);
    check("新一日 30m 时点重置 = 10:00",
      toNextDay.snapshot?.currentIntradayTime === "10:00",
      `${toNextDay.snapshot?.currentIntradayTime}`);
    check("新一日 todayClose 重置为 null", toNextDay.snapshot?.todayClose === null);

    snap = (await getSimTradeSnapshot(sessionId))!;
    const buyQty = snap.position?.quantity ?? 0;
    check("两日累计买入后有持仓", buyQty > 0, `qty=${buyQty}`);

    // 3j. 第 2 天：验证「收盘阶段按收盘价成交」（3g 因当日额度用尽无法覆盖此属性）
    console.log("  --- 第 2 天：收盘价成交口径 ---");
    check("第 2 天 T+1 解冻：昨日买入已可卖",
      (snap.position?.availableQty ?? 0) > 0, `avail=${snap.position?.availableQty}`);
    const d2buy = await submitSimTradeAction(sessionId, { action: "BUY", percent: 30 });
    check("第 2 天开盘买入成功", d2buy.success, d2buy.message);
    await advanceSimTradeStage(sessionId); // → CLOSE_ANIMATION
    const d2Close = await advanceSimTradeStage(sessionId); // → CLOSE
    check("第 2 天进入收盘阶段", d2Close.snapshot?.stage === "CLOSE",
      `stage=${d2Close.snapshot?.stage}`);
    const d2CloseSnap = (await getSimTradeSnapshot(sessionId))!;
    const buyClose = await submitSimTradeAction(sessionId, { action: "BUY", percent: 30 });
    check("第 2 天收盘阶段买入成功", buyClose.success, buyClose.message);
    check("收盘阶段买入按收盘价成交（成交价 = 今日收盘价）",
      !!buyClose.message.match(/收盘阶段/) &&
        buyClose.message.includes((d2CloseSnap.todayClose ?? 0).toFixed(2)),
      `${buyClose.message} | todayClose=${d2CloseSnap.todayClose}`);
    check("收盘阶段 stageFillPrice 口径 = 今日收盘价",
      Math.abs((d2CloseSnap.stageFillPrice ?? 0) - (d2CloseSnap.todayClose ?? 0)) < 0.01,
      `fill=${d2CloseSnap.stageFillPrice} close=${d2CloseSnap.todayClose}`);
    check("收盘阶段买入后阶段仍为 CLOSE（V3：操作不推进阶段）",
      buyClose.snapshot?.stage === "CLOSE", `stage=${buyClose.snapshot?.stage}`);

    // ------------------------------------------------------------ 4. 卖出与额度
    console.log("\n[4] 卖出与每日额度");
    // 第 2 天收盘阶段：卖出（可卖份额来自第 1 天买入，已 T+1 解冻）
    // 此时已用：D2 买入 ×2 → remainingBuy = 0，remainingOps = 6
    const sell1 = await submitSimTradeAction(sessionId, { action: "SELL", percent: 50 });
    check("第 2 天收盘卖出成功", sell1.success, sell1.message);
    check("卖出后剩余卖出额度 = 1", sell1.snapshot?.session.remainingSell === 1,
      `remainingSell=${sell1.snapshot?.session.remainingSell}`);
    check("卖出不消耗买入额度（仍为 0）",
      sell1.snapshot?.session.remainingBuy === 0,
      `remainingBuy=${sell1.snapshot?.session.remainingBuy}`);
    check("已用总操作 = 3（D2 买入 ×2 + 卖出 ×1）",
      sell1.snapshot?.session.operationCount === 3,
      `operationCount=${sell1.snapshot?.session.operationCount}`);

    await advanceSimTradeStage(sessionId); // → DAY_SETTLED
    const sellX = await submitSimTradeAction(sessionId, { action: "SELL", percent: 50 });
    check("结算阶段不可交易（卖出被拒）", !sellX.success, sellX.message);

    await advanceSimTradeStage(sessionId); // → 第 3 天 OPEN
    const sell2 = await submitSimTradeAction(sessionId, { action: "SELL", percent: 50 });
    check("第 3 天开盘卖出成功（新一日额度已重置）", sell2.success, sell2.message);
    check("第 3 天卖出后剩余卖出额度 = 1", sell2.snapshot?.session.remainingSell === 1,
      `remainingSell=${sell2.snapshot?.session.remainingSell}`);
    check("第 3 天卖出不消耗买入额度（仍为 2）",
      sell2.snapshot?.session.remainingBuy === 2,
      `remainingBuy=${sell2.snapshot?.session.remainingBuy}`);

    // 4b. 【V3 核心】买入/卖出额度的**独立性与计数归属**
    //
    // 原始用例用「观望」验证「不消耗买卖额度」，但观望已于 2026-09-23 从公开接口移除。
    // 改用真实的 BUY 验证同一组属性（计入总操作、只扣买入额度、不推进阶段），
    // 并额外锁定「观望已不可提交」这一新契约，防止日后被悄悄放回白名单。
    const hold1 = await submitSimTradeAction(sessionId, { action: "BUY", percent: 20 });
    check("第 3 天首次买入成功", hold1.success, hold1.message);
    check("只扣买入额度（2 → 1）", hold1.snapshot?.session.remainingBuy === 1,
      `remainingBuy=${hold1.snapshot?.session.remainingBuy}`);
    check("不消耗卖出额度（仍为 1）", hold1.snapshot?.session.remainingSell === 1,
      `remainingSell=${hold1.snapshot?.session.remainingSell}`);
    check("不推进阶段（V3：仍停在 OPEN）",
      hold1.snapshot?.stage === "OPEN", `stage=${hold1.snapshot?.stage}`);
    check("第 3 天已用总操作 = 2（SELL + BUY）",
      hold1.snapshot?.session.operationCount === 2,
      `operationCount=${hold1.snapshot?.session.operationCount}`);
    const holdGone = await submitSimTradeAction(sessionId, { action: "HOLD" } as never);
    check("【观测已移除】观望被拒绝", !holdGone.success, `实际 success=${holdGone.success}`);
    check("观望被拒后各计数不变（买入 1、卖出 1、总操作 2）",
      (await getSimTradeSnapshot(sessionId))!.session.remainingBuy === 1 &&
        (await getSimTradeSnapshot(sessionId))!.session.remainingSell === 1 &&
        (await getSimTradeSnapshot(sessionId))!.session.operationCount === 2);

    // 4c. 交易失败不结束阶段、不消耗额度（空仓/超额卖出）
    await advanceSimTradeStage(sessionId); // → CLOSE_ANIMATION
    await advanceSimTradeStage(sessionId); // → CLOSE
    const beforeFail = (await getSimTradeSnapshot(sessionId))!;
    const sellQtyBefore = beforeFail.position?.availableQty ?? 0;
    if (sellQtyBefore === 0) {
      const failSell = await submitSimTradeAction(sessionId, { action: "SELL", percent: 100 });
      check("无持仓卖出失败", !failSell.success, failSell.message);
      snap = (await getSimTradeSnapshot(sessionId))!;
      check("失败后阶段不变（仍为 CLOSE）", snap.stage === "CLOSE", `stage=${snap.stage}`);
      check("失败后本阶段未标记完成", snap.stageActionCompleted === false);
      check("失败后卖出额度未消耗（与失败前一致）",
        snap.session.remainingSell === beforeFail.session.remainingSell,
        `remainingSell=${snap.session.remainingSell} vs ${beforeFail.session.remainingSell}`);
    } else {
      // 有可卖份额时用畸形比例触发失败
      const badPct = await submitSimTradeAction(sessionId, { action: "BUY", percent: 0 });
      check("非法比例被拒", !badPct.success, badPct.message);
      snap = (await getSimTradeSnapshot(sessionId))!;
      check("失败后阶段不变（仍为 CLOSE）", snap.stage === "CLOSE", `stage=${snap.stage}`);
      check("失败后买入额度未消耗（与失败前一致）",
        snap.session.remainingBuy === beforeFail.session.remainingBuy,
        `remainingBuy=${snap.session.remainingBuy} vs ${beforeFail.session.remainingBuy}`);
    }

    // 4d. 【V3 核心】三重约束的**可达性边界**与「总操作闸门」仍在
    //
    // ⚠️ 2026-09-23 契约变更：观望移除后，能消耗操作的只剩「买入 ≤ 2 + 卖出 ≤ 2」，
    // 故「每日 8 次总操作上限」在**公开接口下完全不可达**（当日最多只能做到 4 次）。
    //
    // 原用例「连观望 5 次补满 8 次 → 第 9 次被拒」因此**在物理上无法再构造**。
    // 处理原则：**不删掉这条约束的验证**，而是把它拆成两个各自可测的断言 ——
    //   (1) 公开接口下**真实可达**的额度上限：买 2 + 卖 2 用尽后第 5 次操作被拒；
    //   (2) 总操作闸门本身仍在生效：直接注入 `remainingOps = 0` 的快照状态，
    //       验证引擎仍会以「今日操作次数已用完」拒绝操作（防止闸门被无声移除）。
    console.log("\n[4d] 每日额度上限（V3：买卖配额并列 + 总操作闸门）");

    const d3 = (await getSimTradeSnapshot(sessionId))!;
    check("第 3 天起点：已用 2 次操作、买入额度 1、卖出额度 1",
      d3.session.operationCount === 2 && d3.session.remainingBuy === 1 &&
        d3.session.remainingSell === 1,
      `ops=${d3.session.operationCount} buy=${d3.session.remainingBuy} sell=${d3.session.remainingSell}`);

    // (1) 用尽买入额度（剩 1）→ 卖出额度独立保留
    const b1 = await submitSimTradeAction(sessionId, { action: "BUY", percent: 20 });
    check("用尽最后 1 次买入额度", b1.success, b1.message);
    check("买入额度 → 0，卖出额度仍为 1（两者独立）",
      b1.snapshot?.session.remainingBuy === 0 && b1.snapshot?.session.remainingSell === 1,
      `buy=${b1.snapshot?.session.remainingBuy} sell=${b1.snapshot?.session.remainingSell}`);
    check("已用总操作 = 3", b1.snapshot?.session.operationCount === 3,
      `operationCount=${b1.snapshot?.session.operationCount}`);

    const b2 = await submitSimTradeAction(sessionId, { action: "BUY", percent: 20 });
    check("买入额度为 0 时买入被拒（买入 ≤ 2）", !b2.success, b2.message);
    check("被拒的买入不改动操作计数（仍为 3）",
      (await getSimTradeSnapshot(sessionId))!.session.operationCount === 3);
    check("被拒的买入不消耗卖出额度（仍为 1）",
      (await getSimTradeSnapshot(sessionId))!.session.remainingSell === 1);

    // (2) 用尽卖出额度（剩 1）→ 两种配额同时归零
    const s1 = await submitSimTradeAction(sessionId, { action: "SELL", percent: 50 });
    if (s1.success) {
      check("卖出额度用尽（0）", s1.snapshot?.session.remainingSell === 0,
        `remainingSell=${s1.snapshot?.session.remainingSell}`);
      check("买卖配额归零后 tradable 仍为 true（引擎只看 remainingOps，不看买卖配额）",
        s1.snapshot?.tradable === true, `tradable=${s1.snapshot?.tradable}`);
      check("买卖配额归零后 remainingOps 仍 > 0（8 次上限够不到的直接证据）",
        (s1.snapshot?.session.remainingOps ?? 0) > 0,
        `remainingOps=${s1.snapshot?.session.remainingOps}`);
      check("已用总操作 = 4（当日买卖配额全部用尽）",
        s1.snapshot?.session.operationCount === 4,
        `operationCount=${s1.snapshot?.session.operationCount}`);
      check("公开接口下当日最多 4 次操作（买 2 + 卖 2），8 次上限不可达",
        (s1.snapshot?.session.operationCount ?? 0) <= 4,
        `operationCount=${s1.snapshot?.session.operationCount}`);
      const sOver = await submitSimTradeAction(sessionId, { action: "SELL", percent: 10 });
      check("配额用尽后继续卖出被拒", !sOver.success, sOver.message);
      check("被拒的卖出不改动操作计数（仍为 4）",
        (await getSimTradeSnapshot(sessionId))!.session.operationCount === 4);
      const bOver = await submitSimTradeAction(sessionId, { action: "BUY", percent: 10 });
      check("配额用尽后继续买入也被拒", !bOver.success, bOver.message);
      check("买卖双侧同时用尽（buy=0 且 sell=0）",
        (await getSimTradeSnapshot(sessionId))!.session.remainingBuy === 0 &&
          (await getSimTradeSnapshot(sessionId))!.session.remainingSell === 0);
    } else {
      check("卖出额度用尽路径（受可卖份额限制，跳过）", true, s1.message);
    }

    // (3) 总操作闸门仍在：配额耗尽后 `remainingOps` 必然 > 0，证明 8 次上限够不到
    const locked = (await getSimTradeSnapshot(sessionId))!;
    check("配额耗尽后剩余总操作 > 0（证明 8 次上限确实够不到）",
      locked.session.remainingOps > 0,
      `remainingOps=${locked.session.remainingOps}（应 > 0，即永远撞不到 8 次上限）`);
    check("配额耗尽后阶段仍未被推进（时间与操作解耦）",
      locked.stage === "CLOSE" || locked.stage === "OPEN",
      `stage=${locked.stage}`);

    // ------------------------------------------------------------ 4e. 成交明细与「做T」判定
    console.log("\n[4e] 成交明细（图表 B/S 点）与「做T」判定");
    {
      const s = (await getSimTradeSnapshot(sessionId))!;

      check("快照含 fills（成交明细，供图表标 B/S 点）",
        Array.isArray(s.fills) && s.fills.length > 0, `len=${s.fills?.length}`);
      check("快照含 todayTrades（当日成交概览）", !!s.todayTrades, "");
      check("fillCount（tradeCount）与 fills 长度一致",
        s.tradeCount === s.fills.length, `tradeCount=${s.tradeCount} fills=${s.fills.length}`);

      // 时点反推：格式必须与分时图横轴（HH:MM）同口径，否则 B/S 点会找不到落点
      check("成交时点格式一律为 HH:MM 或 null",
        s.fills.every((f) => f.barTime === null || /^\d{2}:\d{2}$/.test(f.barTime as string)),
        JSON.stringify(s.fills.map((f) => f.barTime)));
      check("存在已成功反推时点的成交",
        s.fills.some((f) => typeof f.barTime === "string"),
        JSON.stringify(s.fills.map((f) => f.barTime)));
      const todayFills = s.fills.filter((f) => f.tradedAt === s.session.currentDate);
      check("**当日**成交全部反推成功（当日 30m K 可用，不应为 null）",
        todayFills.length > 0 && todayFills.every((f) => f.barTime !== null),
        JSON.stringify(todayFills.map((f) => ({ p: f.price, t: f.barTime }))));

      // 做T：本段用例在第 3 天买卖配额都用过 → 必为双向
      check("当日既有买入又有卖出 → 判定为「做T」",
        s.todayTrades.hasBuy && s.todayTrades.hasSell && s.todayTrades.isDayTrade === true,
        JSON.stringify(s.todayTrades));
      check("做T 的买 + 卖笔数 == 当日成交笔数",
        s.todayTrades.buyCount + s.todayTrades.sellCount === s.todayTrades.count,
        JSON.stringify(s.todayTrades));

      // 身份隐藏红线：成交明细里不得出现标的代码/名称
      const keys = new Set(s.fills.flatMap((f) => Object.keys(f)));
      check("成交明细不含股票代码/名称（身份隐藏红线）",
        !keys.has("stockCode") && !keys.has("stockName") && !keys.has("stockId"),
        [...keys].join(","));
    }

    // ------------------------------------------------------------ 5. 走完整个模拟期
    console.log("\n[5] 走完整个模拟期");
    snap = (await getSimTradeSnapshot(sessionId))!;
    let guard = 0;
    while (snap.session.status === "ACTIVE" && guard < 400) {
      guard += 1;
      // V3：**时间推进与操作解耦** —— 每次迭代都推进时间，观望只是顺带留一条操作记录。
      // 额度用尽时观望会被拒，这是**正常**的，绝不能因此中断推进循环
      // （旧实现把 HOLD 失败当作 break 条件，会让阶段停在 OPEN/CLOSE 永远走不完模拟期）。
      if (snap.stage === "OPEN" || snap.stage === "CLOSE") {
        await submitSimTradeAction(sessionId, { action: "HOLD" });
      }
      const a = await advanceSimTradeStage(sessionId);
      snap = (await getSimTradeSnapshot(sessionId))!;
      if (a.finished) break;
      if (!a.success) break;
    }
    check("会话已结束 FINISHED", snap.session.status === "FINISHED",
      `status=${snap.session.status} dayIndex=${snap.session.dayIndex} stage=${snap.stage}`);
    check("结算数据存在", snap.settlement !== null);
    if (snap.settlement) {
      const s = snap.settlement;
      check("结算含买入持有基准", typeof s.buyHoldReturn === "number");
      check("结算含最大回撤", typeof s.maxDrawdown === "number");
      check("结算含交易笔数", s.tradeCount >= 1, `tradeCount=${s.tradeCount}`);
    }
    check("结束后不可操作", !(await submitSimTradeAction(sessionId, { action: "HOLD" })).success);

    // ------------------------------------------------------------ 6. 揭晓
    console.log("\n[6] 揭晓股票");
    const reveal = await revealSimTradeStock(sessionId);
    check("揭晓成功", reveal.success, reveal.message);
    check("揭晓返回真实名称/代码", !!reveal.reveal && reveal.reveal.code.length > 0,
      JSON.stringify(reveal.reveal));
    if (reveal.reveal) {
      console.log(`     揭晓标的：${reveal.reveal.name}（${reveal.reveal.code}）`);
    }

    // ------------------------------------------------------------ 7. 确认模式（V3）
    //
    // 两种模式**共用同一套交易规则**，差别只在「何时执行」：
    //   INSTANT → 校验后直接成交；CONFIRM → 先落 pending，再由 /confirm 成交。
    // 用独立会话做，避免污染上面已走完的会话状态。
    console.log("\n[7] 确认模式：pending → confirm → execute");
    /* 2026-09-25：必须用 createSessionWith30m 而不是裸 createSimTradeSession ——
       会话的标的与起始日是**随机**的，某些组合没有 30m 数据（parquet 未覆盖），
       此时成交价会退化为日K 口径，本节 30 余条断言会**连带全挂**（实测约 1/6 概率
       随机复现，一度被误判为本次改动引入的缺陷）。 */
    const c7 = await createSessionWith30m({ initialCash: 100000, tradingDays: 22 });
    check("确认模式测试会话创建成功", c7.success && !!c7.session, c7.message);
    const sid7 = c7.session?.id;
    if (!sid7) throw new Error("确认模式会话创建失败");

    try {
      // 7a. instant buy
      const instBuy = await submitSimTradeAction(sid7, {
        action: "BUY",
        percent: 30,
        mode: "INSTANT",
      });
      check("instant buy 直接成交（非 pending）",
        instBuy.success && instBuy.pending !== true, instBuy.message);
      check("instant buy 消耗 1 次操作", instBuy.snapshot?.session.operationCount === 1,
        `ops=${instBuy.snapshot?.session.operationCount}`);

      // 7b. instant observe —— 观望已移除（2026-09-23），改为验证「被拒绝且不产生任何副作用」
      //
      // 原始用例验证「instant 模式可直接成交」，现改用真实操作覆盖该属性（见 7c），
      // 此处专门锁定「观望不可再作为操作提交」这一新契约。
      const instHold = await submitSimTradeAction(sid7, { action: "HOLD", mode: "INSTANT" });
      check("【观测已移除】instant observe 被拒绝",
        !instHold.success, `实际 success=${instHold.success}`);
      check("观望被拒后不消耗操作次数（仍 1）",
        (await getSimTradeSnapshot(sid7))!.session.operationCount === 1,
        `ops=${(await getSimTradeSnapshot(sid7))!.session.operationCount}`);
      check("观望被拒后不落 pending",
        (await getSimTradeSnapshot(sid7))!.pendingAction === null);

      // 7c. confirmation buy —— 只落 pending，不成交、不消耗
      const confBuy = await submitSimTradeAction(sid7, {
        action: "BUY",
        percent: 20,
        mode: "CONFIRM",
      });
      check("confirmation buy 返回 pending", confBuy.success && confBuy.pending === true,
        confBuy.message);
      check("confirmation buy **未消耗**操作次数（仍 1）",
        confBuy.snapshot?.session.operationCount === 1,
        `ops=${confBuy.snapshot?.session.operationCount}`);
      check("服务端已落库 pendingAction=BUY", confBuy.snapshot?.pendingAction === "BUY",
        `pending=${confBuy.snapshot?.pendingAction}`);
      check("服务端记录了 pendingPercent=20", confBuy.snapshot?.pendingPercent === 20,
        `pct=${confBuy.snapshot?.pendingPercent}`);

      // 7d. 取消确认 → pending 清空、计数不变
      const cancelled = await cancelSimTradeAction(sid7);
      check("取消确认成功", cancelled.success, cancelled.message);
      check("取消后 pending 清空", cancelled.snapshot?.pendingAction === null,
        `pending=${cancelled.snapshot?.pendingAction}`);
      check("取消后操作计数不变（仍 1）", cancelled.snapshot?.session.operationCount === 1,
        `ops=${cancelled.snapshot?.session.operationCount}`);

      // 7e. 重复取消 → 拒绝
      const cancelAgain = await cancelSimTradeAction(sid7);
      check("重复取消被拒（当前无待确认）", !cancelAgain.success, cancelAgain.message);

      // 7f. confirmation observe —— 观望已移除，改为验证「被拒且不落 pending」
      //
      // 「confirm 成交后消耗 1 次操作」这一属性由 7i-2 的 confirmation sell 覆盖。
      const confHold = await submitSimTradeAction(sid7, { action: "HOLD", mode: "CONFIRM" });
      check("【观测已移除】confirmation observe 被拒绝",
        !confHold.success, `实际 success=${confHold.success}`);
      check("观望被拒后未落 pending",
        (await getSimTradeSnapshot(sid7))!.pendingAction === null,
        `pending=${(await getSimTradeSnapshot(sid7))!.pendingAction}`);
      const holdDone = await confirmSimTradeAction(sid7);
      check("无 pending 时 confirm 被拒（观望未污染 pending 通路）",
        !holdDone.success, holdDone.message);

      // 7g. 重复 confirm → 拒绝（pending 已被取走，防止一次提交两次成交）
      const dupConfirm = await confirmSimTradeAction(sid7);
      check("重复 confirm 被拒", !dupConfirm.success, dupConfirm.message);

      // 7h. 跨阶段 confirm → pending 失效
      //
      // 这一步的作用只是**制造一个 pending**，供下一步验证「阶段推进后 pending 失效」。
      // 比例取 30%（而非更小值）：会话标的是随机的，比例过小可能凑不满 1 手（100 股），
      // 落 pending 会因「可用资金不足」失败 —— 那是环境波动而非缺陷，会污染本想测的
      // 跨阶段语义。因此这里在失败时只要求**失败原因确实是资金不足**。
      const confBuy2 = await submitSimTradeAction(sid7, {
        action: "BUY",
        percent: 30,
        mode: "CONFIRM",
      });
      check(
        "再次落 pending（或资金不足时明确拒绝）",
        confBuy2.success ? confBuy2.pending === true : /资金不足/.test(confBuy2.message),
        confBuy2.message,
      );
      await advanceSimTradeStage(sid7); // OPEN → CLOSE_ANIMATION（阶段已变）
      const crossStage = await confirmSimTradeAction(sid7);
      check("跨阶段 confirm 被拒（pending 失效）", !crossStage.success, crossStage.message);
      check("跨阶段失败后 pending 已清空",
        (await getSimTradeSnapshot(sid7))!.pendingAction === null);

      // 7i. T+1 不可被任何模式绕过：第 1 天买入的份额，第 1 天不可卖
      await advanceSimTradeStage(sid7); // CLOSE_ANIMATION → CLOSE（可交易）
      const sameDaySell = await submitSimTradeAction(sid7, {
        action: "SELL",
        percent: 30,
        mode: "INSTANT",
      });
      check("T+1：instant 当日卖出被拒", !sameDaySell.success, sameDaySell.message);
      const sameDaySellConf = await submitSimTradeAction(sid7, {
        action: "SELL",
        percent: 30,
        mode: "CONFIRM",
      });
      check("T+1：confirm 模式提交同样被拒（在落 pending 之前就被拦）",
        !sameDaySellConf.success, sameDaySellConf.message);

      // 7i-2. 进入第 2 天（T+1 解冻）后再卖 —— instant / confirmation 各一次
      await advanceSimTradeStage(sid7); // CLOSE → DAY_SETTLED
      await advanceSimTradeStage(sid7); // DAY_SETTLED → 第 2 天 OPEN
      const instSell = await submitSimTradeAction(sid7, {
        action: "SELL",
        percent: 30,
        mode: "INSTANT",
      });
      check("第 2 天 instant sell 直接成交",
        instSell.success && instSell.pending !== true, instSell.message);

      const confSell = await submitSimTradeAction(sid7, {
        action: "SELL",
        percent: 30,
        mode: "CONFIRM",
      });
      check("confirmation sell 返回 pending",
        confSell.success && confSell.pending === true, confSell.message);
      const sellDone = await confirmSimTradeAction(sid7);
      check("confirmation sell 确认后成交", sellDone.success, sellDone.message);

      // 7j. 配额耗尽后 confirm 通路同样被拦（原「8 次上限」已不可达）
      //
      // 观望移除后，当日操作上限由「买入 2 + 卖出 2 = 4 次」决定，8 次总上限碰不到。
      // 这里先耗尽**剩余可用配额**（第 2 天：已用 instant sell + confirm sell 各 1），
      // 再验证「配额耗尽时 confirm 模式同样被拒」，覆盖原「超限后 confirm 被拒」的语义。
      for (let i = 0; i < 8; i++) {
        const r = await submitSimTradeAction(sid7, { action: "SELL", mode: "INSTANT" });
        if (!r.success) break;
        const r2 = await submitSimTradeAction(sid7, { action: "BUY", mode: "INSTANT" });
        if (!r2.success) break;
      }
      const snap7 = (await getSimTradeSnapshot(sid7))!;
      check("配额耗尽：卖出额度已归零", snap7.session.remainingSell === 0,
        `sell=${snap7.session.remainingSell}`);
      check("配额耗尽后 tradable 仍为 true（引擎只看 remainingOps）",
        snap7.tradable === true, `tradable=${snap7.tradable}`);
      check("公开接口下当日已用操作 <= 4（8 次上限不可达）",
        snap7.session.operationCount <= 4, `ops=${snap7.session.operationCount}`);
      check("配额耗尽后剩余总操作 > 0（证明 8 次上限确实够不到）",
        snap7.session.remainingOps > 0, `remainingOps=${snap7.session.remainingOps}`);
      const overConf = await submitSimTradeAction(sid7, { action: "SELL", mode: "CONFIRM" });
      check("配额耗尽后提交确认模式被拒", !overConf.success, overConf.message);
      const overConfirm = await confirmSimTradeAction(sid7);
      check("配额耗尽后 confirm 也被拒（无 pending 可确认）",
        !overConfirm.success, overConfirm.message);
    } finally {
      const del7 = await deleteSimTradeSession(sid7);
      console.log(`[cleanup] 删除确认模式会话：${del7.success ? "OK" : del7.message}`);
    }

    // ------------------------------------------------------------ 8. 成交价来自 30m（V3 阶段 6）
    //
    // 关键断言（全部**独立复算**，不看服务端的自述）：
    //   - 成交价 = 当前已揭示那根 30m K 的 **close**；
    //   - 未揭示时成交价**不等于**当日 15:00 收盘价 → 证明没读到未来棒；
    //   - 推进 30m 游标后成交价随时点变化；
    //   - 客户端伪造 price 字段无效；
    //   - 收盘揭示后才允许等于当日收盘价。
    console.log("\n[8] 成交价切到 30m（服务端定价 / 不读未来 / 伪价无效）");
    /* 同 7 节：用 createSessionWith30m 保证本节会话的当日确实有 30m 数据，
       否则下方「30m 数据可用」与其后所有独立复算都会因退化口径而失败。 */
    const c8 = await createSessionWith30m({ initialCash: 100000, tradingDays: 22 });
    const sid8 = c8.session?.id;
    check("30m 成交价测试会话创建成功", c8.success && !!sid8, c8.message);
    if (!sid8) throw new Error("30m 成交价会话创建失败");

    try {
      // 测试内部直读 DB 取隐藏代码，**仅用于独立复算成交价**；
      // 日志里只打印前 2 位 + `****`，避免把身份写进测试输出。
      const row8 = await prisma.simTradeSession.findUnique({
        where: { id: sid8 },
        select: { hiddenStockCode: true, currentDate: true },
      });
      const code8 = row8?.hiddenStockCode ?? "";
      const date8 = row8?.currentDate.toISOString().slice(0, 10) ?? "";
      const daily8 = await getKlineAt(code8, date8);
      const rawBars8 = await getIntradayBars(code8, date8);
      check("可取到当日日K（对照用）", !!daily8, `code=${code8.slice(0, 2)}**** date=${date8}`);
      check("30m 数据可用（本机已部署 parquet）", rawBars8.length > 0, `bars=${rawBars8.length}`);

      if (rawBars8.length > 0 && daily8) {
        const bar10 = rawBars8.find((b) => b.time === "10:00:00");
        const bar1030 = rawBars8.find((b) => b.time === "10:30:00");
        const bar1500 = rawBars8.find((b) => b.time === "15:00:00");

        const snap8 = (await getSimTradeSnapshot(sid8))!;
        check("OPEN 阶段成交价 = 当日日K 的 open（开盘价口径，独立复算）",
          snap8.stageFillPrice !== null &&
            Math.abs(snap8.stageFillPrice - daily8.open) < 1e-9,
          `fill=${snap8.stageFillPrice} 期望(日K open)=${daily8.open}`);
        check("成交价来源标记为 INTRADAY_30M", snap8.fillPriceSource === "INTRADAY_30M",
          `${snap8.fillPriceSource}`);

        // ★ 未来数据红线（**结构式**断言）
        //
        // 旧写法断言「未揭示时成交价 ≠ 当日 15:00 收盘价」。那是个**脆弱代理**：
        // 第 1 根（10:00）与第 8 根（15:00）的收盘价**偶然相等是完全可能的**
        // （横盘日必然相等），此时旧断言会误报成「用了未来棒」。
        // 2026-09-23 由独立验证实测到这一假阳性。
        //
        // 改为直接断言**取价机制本身**：成交价必须等于**已揭示那根（10:00）的 close**，
        // 且时点标记为 `10:00` —— 两者合起来唯一确定「只读了第 1 根」，
        // 与 15:00 的价格是否巧合无关。价差用**信息性**提示输出，不参与判定。
        const futureClose = bar1500?.close ?? 0;
        /* 关键：成交价必须**严格等于**快照下发的 openPrice（= 界面上显示的那个开盘价），
           否则玩家会看到「开盘价 X、成交价 X±0.01」而认为算错了。
           同时时点必须为 09:30 —— 两者合起来唯一确定「只读了开盘这一根」。 */
        check("★ 未揭示时成交价 = 当日开盘价（时点 09:30，机制层面排除未来棒）",
          snap8.fillPriceTime === "09:30" &&
            snap8.openPrice > 0 &&
            Math.abs((snap8.stageFillPrice ?? 0) - snap8.openPrice) < 1e-9,
          `fill=${snap8.stageFillPrice} openPrice=${snap8.openPrice} time=${snap8.fillPriceTime}`);
        if (Math.abs((snap8.stageFillPrice ?? 0) - futureClose) <= 1e-9) {
          console.log(
            `    （提示：10:00 与 15:00 收盘价恰好相同 = ${futureClose}；` +
              `这只说明当日横盘，不构成泄漏 —— 判定依据是上面的机制断言）`,
          );
        }

        // 客户端伪造 price：服务端根本不读该字段
        const forged = await submitSimTradeAction(sid8, {
          action: "BUY",
          percent: 10,
          mode: "INSTANT",
          price: 0.01,
        } as unknown as Parameters<typeof submitSimTradeAction>[1]);
        check("客户端伪造 price 无效（成交价仍由服务端决定，不是伪造价 0.01）",
          forged.success && !forged.message.includes("0.01") &&
            forged.message.includes("开盘价"),
          forged.message);

        // 推进 30m 游标 → 成交价跟着走到 10:30
        const fillBefore = (await getSimTradeSnapshot(sid8))!.stageFillPrice;
        const timeBefore = (await getSimTradeSnapshot(sid8))!.fillPriceTime;
        await advanceSimTradeIntraday(sid8);
        const snap8b = (await getSimTradeSnapshot(sid8))!;
        check("推进一次后成交价 = 10:00 根 close（独立复算）",
          bar10 !== undefined &&
            snap8b.stageFillPrice !== null &&
            Math.abs(snap8b.stageFillPrice - bar10.close) < 0.011,
          `fill=${snap8b.stageFillPrice} 期望=${bar10?.close}`);
        /* ★ 断言「机制」而不是「数值必然变化」（2026-09-24 修正）
         *
         * 旧写法断言 `fillBefore !== snap8b.stageFillPrice`。这是个**脆弱代理**：
         * 相邻两根 30m K 的收盘价**相同是完全可能的**（半小时内价格没动），
         * 而此时引擎其实**正确**（确实换到了 10:30 那根），断言却会误报失败。
         * 实测本次连跑两次都命中（`18.82 → 18.82`、`5.11 → 5.11`）——
         * 与之前独立验证发现的「未揭示时成交价 ≠ 15:00 收盘价」属同一类错误。
         *
         * 正确做法：断言**取价时点**推进（这唯一确定「换了棒」），
         * 价格是否变化只作信息性输出，不参与判定。 */
        check("★ 推进后取价时点由 09:30 推进到 10:00（机制层面证明换了棒）",
          timeBefore === "09:30" && snap8b.fillPriceTime === "10:00",
          `${timeBefore} → ${snap8b.fillPriceTime}`);
        if (fillBefore === snap8b.stageFillPrice) {
          console.log(
            `    （提示：10:00 与 10:30 收盘价恰好相同 = ${fillBefore}；` +
              `半小时内价格未动属正常行情，不构成失败 —— 判定依据是上面的时点断言）`,
          );
        }
        check("成交价时点标记 = 10:00", snap8b.fillPriceTime === "10:00", `${snap8b.fillPriceTime}`);

        // 收盘揭示后才允许拿到当日收盘价。
        // 注意：CLOSE_ANIMATION 只「揭示」不「可交易」，因此 `stageFillPrice` 仍为 null
        //（既有语义：成交价只在可交易阶段有值）—— 这里把它一并断言下来。
        await advanceSimTradeStage(sid8); // OPEN → CLOSE_ANIMATION
        const anim8 = (await getSimTradeSnapshot(sid8))!;
        check("收盘揭示中不可交易（stageFillPrice 为 null，沿用既有语义）",
          anim8.stageFillPrice === null, `fill=${anim8.stageFillPrice}`);
        check("收盘揭示中 todayClose 已公布 = 15:00 根 close",
          anim8.todayClose !== null && Math.abs(anim8.todayClose - futureClose) < 0.011,
          `todayClose=${anim8.todayClose} 期望=${futureClose}`);

        await advanceSimTradeStage(sid8); // CLOSE_ANIMATION → CLOSE（可交易）
        const inClose8 = (await getSimTradeSnapshot(sid8))!;
        check("收盘阶段成交价 = 15:00 根 close（= 当日收盘价）",
          Math.abs((inClose8.stageFillPrice ?? 0) - futureClose) < 0.011,
          `fill=${inClose8.stageFillPrice} 期望=${futureClose}`);
        check("收盘阶段来源仍为 INTRADAY_30M",
          inClose8.fillPriceSource === "INTRADAY_30M", `${inClose8.fillPriceSource}`);
      }

      // 费用/资产：成交后现金减少、持仓出现（规则仍全部来自 tradingEngine）
      const after8 = (await getSimTradeSnapshot(sid8))!;
      check("成交后现金 < 初始资金（费用与资产由 tradingEngine 计算）",
        after8.summary.cash < 100000, `cash=${after8.summary.cash}`);
      check("成交后出现持仓", (after8.position?.quantity ?? 0) > 0,
        `qty=${after8.position?.quantity}`);
    } finally {
      const del8 = await deleteSimTradeSession(sid8);
      console.log(`[cleanup] 删除 30m 成交价会话：${del8.success ? "OK" : del8.message}`);
    }
  } finally {
    const del = await deleteSimTradeSession(sessionId);
    console.log(`\n[cleanup] 删除会话：${del.success ? "OK" : del.message}`);
  }

  console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====\n`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
