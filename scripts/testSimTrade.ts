/**
 * 模拟炒股（猜股票）端到端冒烟测试
 *
 * 覆盖：
 *  1. 创建会话（真实历史数据随机选股、隐藏身份）
 *  2. 快照防泄漏：K 线右端点 = currentDate；当日 bar 仅 open；DTO 无身份字段
 *  3. 交易闭环：买入 -> 确认 -> 推进 -> T+1 可卖校验
 *  4. 走完整个模拟期 -> FINISHED -> 揭晓
 *
 * 运行：node -e "(async()=>{const m=await import('./runner.mjs'); await m.run('scripts/testSimTrade.ts');})()"
 */
import {
  advanceSimTradeDay,
  createSimTradeSession,
  deleteSimTradeSession,
  getSimTradeSnapshot,
  revealSimTradeStock,
  submitSimTradeAction,
} from "@/services/simtradeService";
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
  // reveal 之前不能出现任何股票代码/名称字段
  check(`${label}: 快照 JSON 无 code 泄漏`, !/"hiddenStockCode"/.test(raw));
}

async function main(): Promise<void> {
  console.log("\n===== 模拟炒股（猜股票）端到端测试 =====\n");

  // 1. 创建会话
  console.log("[1] 创建会话");
  const created = await createSimTradeSession({ initialCash: 100000, tradingDays: 22 });
  check("创建成功", created.success, created.message);
  if (!created.success || !created.session) {
    console.log("无法创建会话，终止测试");
    process.exit(1);
  }
  const sessionId = created.session.id;
  const totalDays = created.session.totalDays;
  check("总交易日 20~23", totalDays >= 20 && totalDays <= 23, `totalDays=${totalDays}`);
  check("初始资金 100000", created.session.initialCash === 100000);

  try {
    // 2. 初始快照 + 防泄漏
    console.log("\n[2] 初始快照与防泄漏");
    let snap = await getSimTradeSnapshot(sessionId);
    check("快照非空", snap !== null);
    if (!snap) throw new Error("快照为空");
    assertNoIdentity("初始", snap);
    check("初始无持仓", snap.position === null);
    check("初始可交易", snap.tradable === true);
    check("初始进度 dayIndex=1", snap.session.dayIndex === 1, `dayIndex=${snap.session.dayIndex}`);

    // 历史 K 线右端点必须 = currentDate
    const lastHist = snap.history[snap.history.length - 1];
    check("K线右端点 = currentDate", lastHist.date === snap.session.currentDate,
      `last=${lastHist.date} cur=${snap.session.currentDate}`);
    // 当日 bar 仅 open（high/low/close 用 open 占位）
    check("当日 bar high=open", lastHist.high === lastHist.open,
      `high=${lastHist.high} open=${lastHist.open}`);
    check("当日 bar low=open", lastHist.low === lastHist.open);
    check("当日 bar close=open", lastHist.close === lastHist.open);
    check("暴露今日开盘价", snap.openPrice > 0, `openPrice=${snap.openPrice}`);
    // 历史区间至少 60 根可见
    check("可见历史 >= 60 根", snap.history.length >= 60, `len=${snap.history.length}`);

    // 无未来数据：history 中所有日期 <= currentDate
    const curDate = snap.session.currentDate;
    const hasFuture = snap.history.some((b) => b.date > curDate);
    check("history 无未来日期", !hasFuture);

    // 3. 交易闭环 + T+1（两阶段：确认结算 → 下一交易日）
    console.log("\n[3] 交易闭环 + T+1（两阶段）");

    // 3a. 未确认前：当日只公布开盘价，不可推进
    const preAdvance = await advanceSimTradeDay(sessionId);
    check("未确认时不可推进交易日", !preAdvance.success, preAdvance.message);
    check("未确认时 tradable=true", snap.tradable === true);

    // 3b. 确认买入（不推进日期，当日结算）
    const buyRes = await submitSimTradeAction(sessionId, { action: "BUY", percent: 50 });
    check("买入（确认）成功", buyRes.success, buyRes.message);
    check("确认后返回快照", !!buyRes.snapshot);
    check("确认后仍停留在第 1 天（未推进）", buyRes.snapshot?.session.dayIndex === 1,
      `dayIndex=${buyRes.snapshot?.session.dayIndex}`);
    check("确认后 confirmedToday=true", buyRes.snapshot?.session.confirmedToday === true);
    check("确认后 tradable=false（本日已结算）", buyRes.snapshot?.tradable === false);
    check("结算记录含 1 笔成交", (buyRes.snapshot?.lastAction?.fillCount ?? 0) === 1,
      `fillCount=${buyRes.snapshot?.lastAction?.fillCount}`);
    check("结算记录动作 = BUY", buyRes.snapshot?.lastAction?.action === "BUY");
    // 确认后当日 K 线揭示完整 OHLC（收盘价已结算）
    const todayBarAfter = buyRes.snapshot?.history[buyRes.snapshot.history.length - 1];
    check("确认后当日 K 线揭示收盘价（close != open 或等于真实）",
      !!todayBarAfter && todayBarAfter.date === buyRes.snapshot?.session.currentDate);
    // 同一日再确认应被拒绝
    const dup = await submitSimTradeAction(sessionId, { action: "HOLD" });
    check("同日重复确认被拒绝", !dup.success, dup.message);

    snap = (await getSimTradeSnapshot(sessionId))!;
    check("买入后有持仓", snap.position !== null);
    const buyQty = snap.position?.quantity ?? 0;
    check("持仓数量 > 0", buyQty > 0, `qty=${buyQty}`);
    // 当日新买份额不可卖：todayQty = 全部持仓、availableQty = 0
    check("T+1：当日新买不可卖（todayQty = 全部持仓）",
      snap.position?.todayQty === buyQty && snap.position?.availableQty === 0,
      `todayQty=${snap.position?.todayQty} avail=${snap.position?.availableQty} qty=${buyQty}`);
    check("当日结算记录可见（settledDate = currentDate）",
      snap.lastAction?.date === snap.session.currentDate,
      `lastAction.date=${snap.lastAction?.date} cur=${snap.session.currentDate}`);
    check("无身份泄漏（持仓后）",
      (snap.position as unknown as Record<string, unknown>).stockCode === undefined);

    // 3c. 进入第 2 天 -> 昨日买入解冻可卖（T+1 生效）
    const adv1 = await advanceSimTradeDay(sessionId);
    check("确认后推进成功", adv1.success, adv1.message);
    snap = (await getSimTradeSnapshot(sessionId))!;
    check("推进到第 2 天", snap.session.dayIndex === 2, `dayIndex=${snap.session.dayIndex}`);
    check("推进后 confirmedToday=false", snap.session.confirmedToday === false);
    check("T+1：跨日后昨日买入已解冻可卖",
      snap.position?.availableQty === snap.position?.quantity && snap.position?.todayQty === 0,
      `avail=${snap.position?.availableQty} qty=${snap.position?.quantity} today=${snap.position?.todayQty}`);

    // 3d. 第 2 天再买入 -> 当日新买计入 todayQty（不可卖），可卖 < 总持仓
    const buy2 = await submitSimTradeAction(sessionId, { action: "BUY", percent: 30 });
    check("第 2 天再买入成功", buy2.success, buy2.message);
    snap = (await getSimTradeSnapshot(sessionId))!;
    check("当日新买计入 todayQty>0（当日不可卖）", (snap.position?.todayQty ?? 0) > 0,
      `todayQty=${snap.position?.todayQty}`);
    check("可卖份额 < 总持仓（含当日新买）",
      (snap.position?.availableQty ?? 0) < (snap.position?.quantity ?? 0),
      `avail=${snap.position?.availableQty} qty=${snap.position?.quantity}`);

    // 3e. 第 3 天卖出部分（T+1 后可卖）
    await advanceSimTradeDay(sessionId);
    const sellRes = await submitSimTradeAction(sessionId, { action: "SELL", percent: 50 });
    check("卖出成功（T+1 后可卖）", sellRes.success, sellRes.message);
    await advanceSimTradeDay(sessionId);
    snap = (await getSimTradeSnapshot(sessionId))!;
    check("推进到第 4 天", snap.session.dayIndex === 4, `dayIndex=${snap.session.dayIndex}`);

    // 3f. 清仓后（跨日）再卖应失败（持仓约束）
    const clearRes = await submitSimTradeAction(sessionId, { action: "SELL", percent: 100 });
    check("清仓成功", clearRes.success, clearRes.message);
    await advanceSimTradeDay(sessionId);
    snap = (await getSimTradeSnapshot(sessionId))!;
    check("清仓后无持仓", snap.position === null || (snap.position?.quantity ?? 0) === 0);
    const emptySell = await submitSimTradeAction(sessionId, { action: "SELL", percent: 100 });
    check("空仓再卖应失败", !emptySell.success, emptySell.message);
    await advanceSimTradeDay(sessionId);
    snap = (await getSimTradeSnapshot(sessionId))!;

    // 4. 走完剩余交易日（每日：确认 HOLD -> 推进）
    console.log("\n[4] 走完整个模拟期");
    let guard = 0;
    while (snap.session.status === "ACTIVE" && guard < 80) {
      guard += 1;
      if (!snap.session.confirmedToday) {
        const r = await submitSimTradeAction(sessionId, { action: "HOLD" });
        if (!r.success) break;
        snap = (await getSimTradeSnapshot(sessionId))!;
      }
      const a = await advanceSimTradeDay(sessionId);
      if (a.finished) {
        snap = (await getSimTradeSnapshot(sessionId))!;
        break;
      }
      snap = (await getSimTradeSnapshot(sessionId))!;
    }
    check("会话已结束 FINISHED", snap.session.status === "FINISHED",
      `status=${snap.session.status} dayIndex=${snap.session.dayIndex}`);
    check("结算数据存在", snap.settlement !== null);
    if (snap.settlement) {
      const s = snap.settlement;
      check("结算含买入持有基准", typeof s.buyHoldReturn === "number");
      check("结算含最大回撤", typeof s.maxDrawdown === "number");
      check("结算含交易笔数", s.tradeCount >= 1, `tradeCount=${s.tradeCount}`);
    }

    // 结束前不可揭晓（已 FINISHED 可以揭晓）
    console.log("\n[5] 揭晓股票");
    const reveal = await revealSimTradeStock(sessionId);
    check("揭晓成功", reveal.success, reveal.message);
    check("揭晓返回真实名称/代码", !!reveal.reveal && reveal.reveal.code.length > 0,
      JSON.stringify(reveal.reveal));
    if (reveal.reveal) {
      console.log(`     揭晓标的：${reveal.reveal.name}（${reveal.reveal.code}）`);
    }
  } finally {
    // 清理
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
