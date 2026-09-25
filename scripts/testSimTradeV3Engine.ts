/**
 * testSimTradeV3Engine —— V3 引擎验收测试（服务端）
 *
 * 覆盖用户指定的 6 项测试中可由服务端判定的部分：
 *   测试1  8 个节点逐步推进（分时/日K 逐节点揭示、成交量累计、涨跌幅、高低价）
 *   测试3  收盘 → 结算 → 下一交易日（含连续走完整个日历经换日不卡死）
 *   测试4  T+1
 *   测试5  未来数据泄露检查（第 3 节点时不得知道第 4~8 节点 / 全天量 / 最终收盘）
 *   测试6  刷新页面（重新读取快照）状态保持
 *
 * 运行：
 *   DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testSimTradeV3Engine.ts')"
 */
import prisma from "@/lib/prisma";
import { getIntradayBars, isContaminated } from "@/lib/intraday30m";
import { getKlineAt } from "@/services/marketDataService";
import {
  advanceSimTradeIntraday,
  advanceSimTradeStage,
  confirmSimTradeAction,
  createSimTradeSession,
  deleteSimTradeSession,
  getSimTradeSnapshot,
  submitSimTradeAction,
} from "@/services/simtradeService";
import type { SimTradeSnapshot } from "@/types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function near(a: number | null | undefined, b: number | null | undefined, tol = 1e-3): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.abs(a - b) <= tol;
}

async function snapOf(id: string): Promise<SimTradeSnapshot> {
  const s = await getSimTradeSnapshot(id);
  if (!s) throw new Error(`快照为空: ${id}`);
  return s;
}

async function main(): Promise<void> {
  /* ============ 主用例：8 节点推进 + 换日 + T+1 前置 ============ */
  console.log("=== 创建会话 ===");
  const created = await createSimTradeSession({ name: "V3-ENGINE-ACCEPT", tradingDays: 20 });
  if (!created.success || !created.session) {
    console.log("创建失败: " + created.message);
    failed += 1;
    return;
  }
  const id = created.session.id;
  const idRow = await prisma.simTradeSession.findUnique({ where: { id } });
  if (!idRow) throw new Error("会话行缺失");
  const code = idRow.hiddenStockCode;
  const startDate = created.session.startDate;
  console.log(`会话 id=${id} 标的=${code} 起始日=${startDate} 区间=${startDate}~${created.session.endDate}`);

  const allBars = await getIntradayBars(code, startDate);
  const contaminated = isContaminated(code, startDate);
  const dailyBar = await getKlineAt(code, startDate);
  const fullDay30mVolume = allBars.reduce((s, b) => s + b.volume, 0);
  // 换算后的「全天成交量」（日K 口径）—— 第 8 根揭示时应恰好等于它
  const finalVolume = dailyBar?.volume ?? 0;
  const volumeFactor = fullDay30mVolume > 0 ? finalVolume / fullDay30mVolume : 1;

  console.log(`当日 30m 根数=${allBars.length} 污染=${contaminated}`);
  console.log(`日K: open=${dailyBar?.open} high=${dailyBar?.high} low=${dailyBar?.low} close=${dailyBar?.close} volume=${finalVolume}`);
  console.log(`30m 全天 volume 合计=${fullDay30mVolume}  换算因子=${volumeFactor.toFixed(6)}（预期≈0.01，即「股」→「手」）`);

  const usable = allBars.length === 8 && !contaminated && !!dailyBar;

  /* ================= 测试 1 + 测试 5：逐节点推进与防泄漏 ================= */
  console.log("\n=== 测试1/5：8 节点逐步推进 + 防泄漏 ===");
  let snap = await snapOf(id);
  check("初始游标 = 0（刚开盘，一根 30m K 都还没走完）", snap.session.intradayBarCount === 0, `实际=${snap.session.intradayBarCount}`);
  check("初始 stage = OPEN", snap.stage === "OPEN", `实际=${snap.stage}`);
  check("初始 todayClose = null（未揭示收盘）", snap.todayClose === null, `实际=${snap.todayClose}`);
  check("prevClose 非空", snap.prevClose !== null, `实际=${snap.prevClose}`);
  const prevClose = snap.prevClose;

  for (let n = 1; n <= 7; n += 1) {
    /* 2026-09-25：游标改为**从 0 起算**（0 = 刚开盘、一根 30m K 都还没走完），
       因此每轮循环都要先推进一根；改前初始即为 1，故只在 n>1 时才推进。 */
    {
      const r = await advanceSimTradeIntraday(id);
      if (!r.success) {
        check(`tick 到第 ${n} 根`, false, r.message);
        break;
      }
    }
    snap = await snapOf(id);
    const tb = snap.todayBar;
    const label = `第${n}根`;

    check(`${label}: 游标 == ${n}`, snap.session.intradayBarCount === n, `实际=${snap.session.intradayBarCount}`);

    if (usable) {
      const revealed = allBars.slice(0, n);
      const expHigh = Math.max(...revealed.map((b) => b.high));
      const expLow = Math.min(...revealed.map((b) => b.low));
      const expClose = revealed[revealed.length - 1].close;
      const expOpen = revealed[0].open;
      const expVol = Math.round(revealed.reduce((s, b) => s + b.volume, 0) * volumeFactor);
      const fullHigh = Math.max(...allBars.map((b) => b.high));
      const fullLow = Math.min(...allBars.map((b) => b.low));

      check(`${label}: todayBar 存在`, tb !== null);
      check(`${label}: source == INTRADAY_30M`, tb?.source === "INTRADAY_30M", `实际=${tb?.source}`);
      check(`${label}: revealedBars == ${n}`, tb?.revealedBars === n, `实际=${tb?.revealedBars}`);
      check(`${label}: open == 第1根open(${expOpen})`, near(tb?.open, expOpen), `实际=${tb?.open}`);
      check(`${label}: high == 前${n}根最高(${expHigh})`, near(tb?.high, expHigh), `实际=${tb?.high}`);
      check(`${label}: low == 前${n}根最低(${expLow})`, near(tb?.low, expLow), `实际=${tb?.low}`);
      check(`${label}: close == 第${n}根close(${expClose})`, near(tb?.close, expClose), `实际=${tb?.close}`);
      check(`${label}: volume == 前${n}根累计(换算后 ${expVol})`, near(tb?.volume, expVol, 1), `实际=${tb?.volume}`);

      // —— 防泄漏：成交量不得达到全天量 ——
      check(`${label}: 成交量 < 全天量(${finalVolume})【防泄露】`, (tb?.volume ?? 0) < finalVolume, `实际=${tb?.volume}`);
      // —— 防泄漏：高低价不得越过全天极值 ——
      check(`${label}: high <= 全天最高(${fullHigh})【防泄露】`, (tb?.high ?? Infinity) <= fullHigh + 1e-6, `实际=${tb?.high}`);
      check(`${label}: low >= 全天最低(${fullLow})【防泄露】`, (tb?.low ?? -Infinity) >= fullLow - 1e-6, `实际=${tb?.low}`);
      // —— 涨跌幅口径 ——
      if (prevClose) {
        const expPct = Math.round(((expClose - prevClose) / prevClose) * 100 * 10000) / 10000;
        check(`${label}: changePercent 口径正确`, near(tb?.changePercent, expPct, 1e-2), `实际=${tb?.changePercent} 期望≈${expPct}`);
      }
      // —— 不能提前知道最终收盘 ——
      check(`${label}: close != 全天收盘(${dailyBar?.close})【防泄露】`, n === 8 ? true : !near(tb?.close, dailyBar?.close, 1e-6) || near(dailyBar?.close, allBars[n - 1].close, 1e-6), `实际=${tb?.close}`);
    } else {
      check(`${label}: todayBar 为退化口径或 null（无 30m）`, tb === null || tb.source === "DAILY_K", `实际=${tb?.source}`);
      if (tb) check(`${label}: 退化口径成交量必须为 0【防泄露】`, tb.volume === 0, `实际=${tb.volume}`);
    }

    // history 末根必须与 todayBar 一致（不允许两套真相）
    const lastHist = snap.history[snap.history.length - 1];
    if (tb && lastHist && lastHist.date === snap.session.currentDate) {
      check(
        `${label}: history末根 与 todayBar 一致`,
        near(lastHist.open, tb.open) &&
          near(lastHist.high, tb.high) &&
          near(lastHist.low, tb.low) &&
          near(lastHist.close, tb.close) &&
          near(lastHist.volume, tb.volume, 1),
        `hist=${JSON.stringify({ o: lastHist.open, h: lastHist.high, l: lastHist.low, c: lastHist.close, v: lastHist.volume })} tb=${JSON.stringify({ o: tb.open, h: tb.high, l: tb.low, c: tb.close, v: tb.volume })}`,
      );
    }

    check(`${label}: todayClose = null【防泄露】`, snap.todayClose === null, `实际=${snap.todayClose}`);

    console.log(
      `    → 时点=${snap.currentIntradayTime} fillPrice=${snap.stageFillPrice}(${snap.fillPriceSource}) ` +
        `todayBar=${tb ? `O${tb.open} H${tb.high} L${tb.low} C${tb.close} V${tb.volume}` : "null"}`,
    );
  }

  // 第 8 根：OPEN 阶段不允许揭示
  const r8 = await advanceSimTradeIntraday(id);
  check("第8根在 OPEN 阶段被拒【防泄露】", !r8.success, `实际 success=${r8.success}`);

  /* ================= 测试 6：刷新页面（重新读取快照）状态保持 ================= */
  console.log("\n=== 测试6：刷新页面（重读快照）状态保持 ===");
  const beforeRefresh = await snapOf(id);
  const afterRefresh = await snapOf(id);
  check("刷新后 currentDate 不变", beforeRefresh.session.currentDate === afterRefresh.session.currentDate);
  check("刷新后 stage 不变", beforeRefresh.stage === afterRefresh.stage);
  check("刷新后 游标不变", beforeRefresh.session.intradayBarCount === afterRefresh.session.intradayBarCount);
  check("刷新后 操作次数不变", beforeRefresh.operationCount === afterRefresh.operationCount);
  check("刷新后 现金不变", near(beforeRefresh.summary.availableCash, afterRefresh.summary.availableCash, 1e-6));
  check("刷新后 持仓不变", beforeRefresh.position?.quantity === afterRefresh.position?.quantity);
  check("刷新后 todayBar 完全一致", JSON.stringify(beforeRefresh.todayBar) === JSON.stringify(afterRefresh.todayBar));

  /* ================= 测试 3：收盘 → 结算 → 下一交易日 ================= */
  console.log("\n=== 测试3：OPEN(7) → CLOSE_ANIMATION(8) → CLOSE → DAY_SETTLED → 下一日 ===");
  const day1Date = (await snapOf(id)).session.currentDate;
  const cashBefore = (await snapOf(id)).summary.availableCash;

  let r = await advanceSimTradeStage(id);
  check("OPEN → CLOSE_ANIMATION 成功", r.success, r.message);
  snap = await snapOf(id);
  check("进入 CLOSE_ANIMATION", snap.stage === "CLOSE_ANIMATION", `实际=${snap.stage}`);
  check("游标拉满 = 8", snap.session.intradayBarCount === 8, `实际=${snap.session.intradayBarCount}`);
  check("todayClose 已揭示【合规】", snap.todayClose !== null, `实际=${snap.todayClose}`);
  const day1Close = snap.todayClose ?? 0;
  check("todayBar.finalized = true", snap.todayBar?.finalized === true, `实际=${snap.todayBar?.finalized}`);
  check("todayBar.source = DAILY_K（定格用官方日K）", snap.todayBar?.source === "DAILY_K", `实际=${snap.todayBar?.source}`);
  if (usable) {
    check(`定格成交量 == 官方日K(${finalVolume})`, snap.todayBar?.volume === finalVolume, `实际=${snap.todayBar?.volume}`);
    check(`定格收盘 == 官方日K收盘(${dailyBar?.close})`, near(snap.todayBar?.close, dailyBar?.close), `实际=${snap.todayBar?.close}`);
  }

  r = await advanceSimTradeStage(id);
  check("CLOSE_ANIMATION → CLOSE 成功", r.success, r.message);
  check("进入 CLOSE", (await snapOf(id)).stage === "CLOSE");

  r = await advanceSimTradeStage(id);
  check("CLOSE → DAY_SETTLED 成功", r.success, r.message);
  check("进入 DAY_SETTLED", (await snapOf(id)).stage === "DAY_SETTLED");

  r = await advanceSimTradeStage(id);
  check("DAY_SETTLED → 下一交易日 成功", r.success, r.message);
  check("未误判为 FINISHED", r.finished !== true, `实际 finished=${r.finished}`);
  snap = await snapOf(id);
  check("已换日（日期变化）", snap.session.currentDate !== day1Date, `仍是 ${snap.session.currentDate}`);
  check("下一日 stage = OPEN", snap.stage === "OPEN", `实际=${snap.stage}`);
  check("下一日 游标重置 = 1", snap.session.intradayBarCount === 1, `实际=${snap.session.intradayBarCount}`);
  check("下一日 总操作重置 = 0", snap.operationCount === 0, `实际=${snap.operationCount}`);
  check("下一日 买入额度重置 = 2", snap.remainingBuy === 2, `实际=${snap.remainingBuy}`);
  check("下一日 卖出额度重置 = 2", snap.remainingSell === 2, `实际=${snap.remainingSell}`);
  check("下一日 todayClose = null", snap.todayClose === null, `实际=${snap.todayClose}`);
  check("下一日 tradable = true", snap.tradable === true, `实际=${snap.tradable}`);
  check("下一日 现金守恒（无交易）", near(snap.summary.availableCash, cashBefore, 0.01), `前=${cashBefore} 后=${snap.summary.availableCash}`);
  check(`下一日 prevClose == 上一日收盘(${day1Close})`, near(snap.prevClose, day1Close, 0.05), `实际=${snap.prevClose}`);
  const prevDayBar = snap.history.find((b) => b.date === day1Date);
  check("上一交易日仍在 history 中", prevDayBar !== undefined);
  check(
    `上一交易日成交量已固定 == 官方日K(${finalVolume})`,
    usable ? prevDayBar?.volume === finalVolume : true,
    `实际=${prevDayBar?.volume}`,
  );

  /* ================= 连续走完整个日历（不卡死） ================= */
  console.log("\n=== 连续换日：走完整个日历 ===");
  let days = 1;
  let stuck = false;
  const stuckAt: string[] = [];
  for (let i = 0; i < 400; i += 1) {
    const s = await snapOf(id);
    if (s.session.status === "FINISHED") break;
    const rr = await advanceSimTradeStage(id);
    if (!rr.success) {
      stuck = true;
      stuckAt.push(`${s.session.currentDate}/${s.stage}: ${rr.message}`);
      break;
    }
    if (s.stage === "DAY_SETTLED") days += 1;
  }
  const fin = await snapOf(id);
  check("连续换日未卡死", !stuck, stuckAt.join("; "));
  check("已走完日历并 FINISHED", fin.session.status === "FINISHED", `实际 status=${fin.session.status} date=${fin.session.currentDate}`);
  console.log(`    → 共走过 ${days} 个交易日，最终 status=${fin.session.status} date=${fin.session.currentDate}`);
  await deleteSimTradeSession(id);

  /* ================= 测试 4：T+1 ================= */
  console.log("\n=== 测试4：T+1 ===");
  const c2 = await createSimTradeSession({ name: "V3-T1", tradingDays: 20 });
  if (!c2.success || !c2.session) {
    check("T+1 用会话创建成功", false, c2.message);
  } else {
    const id2 = c2.session.id;
    const s0 = await snapOf(id2);

    // 4a) CONFIRM 模式：落 pending，未成交
    const sub = await submitSimTradeAction(id2, { action: "BUY", percent: 30, mode: "CONFIRM" } as never);
    check("买入（CONFIRM）提交成功", sub.success, sub.message);
    const sPending = await snapOf(id2);
    check("CONFIRM 模式：pendingAction = BUY", sPending.pendingAction === "BUY", `实际=${sPending.pendingAction}`);
    check("CONFIRM 模式：尚未成交（无持仓）", (sPending.position?.quantity ?? 0) === 0, `实际=${sPending.position?.quantity}`);

    const conf = await confirmSimTradeAction(id2);
    check("确认成交成功", conf.success, conf.message);
    const s1 = await snapOf(id2);
    check("买入后 持仓 > 0", (s1.position?.quantity ?? 0) > 0, `实际=${s1.position?.quantity}`);
    check("买入当日 可卖 = 0【T+1】", s1.position?.availableQty === 0, `实际=${s1.position?.availableQty}`);
    check("买入当日 今日买入份额 > 0", (s1.position?.todayQty ?? 0) > 0, `实际=${s1.position?.todayQty}`);
    check("买入消耗 1 次操作", s1.operationCount === 1, `实际=${s1.operationCount}`);
    check("买入次数 +1", s1.remainingBuy === 1, `实际剩余=${s1.remainingBuy}`);

    // 换日
    const dayA = s1.session.currentDate;
    for (let i = 0; i < 12; i += 1) {
      const cur = await snapOf(id2);
      if (cur.session.currentDate !== dayA) break;
      await advanceSimTradeStage(id2);
    }
    const s2 = await snapOf(id2);
    check("换日后 日期已变", s2.session.currentDate !== dayA, `实际=${s2.session.currentDate}`);
    check("换日后 可卖 == 持仓量【T+1 解冻】", s2.position?.availableQty === s2.position?.quantity, `available=${s2.position?.availableQty} qty=${s2.position?.quantity}`);
    check("换日后 今日买入份额 = 0", s2.position?.todayQty === 0, `实际=${s2.position?.todayQty}`);
    check("换日后 操作次数归零", s2.operationCount === 0, `实际=${s2.operationCount}`);

    /* 4b) 观望已取消（2026-09-24）—— 提交入口必须关闭，且不再计入操作数
     *
     * 原用例是「连续 HOLD 用满 8 次 → 第 9 次被拒」。
     * 观望取消后，能消耗操作的只剩「买 ≤2 + 卖 ≤2」= **最多 4 次**，
     * 总上限 8 在公开接口下**已无法构造**，因此该用例改为验证新规则本身：
     *   · HOLD 提交被拒，并给出「推进时间」的引导文案
     *   · HOLD 被拒后不消耗操作数（不是「操作失败也计数」）
     * 「额度用尽」这条兜底分支改由 `testSimTradeV3Deadlock` 直接注入
     * `remainingOps: 0` 来覆盖（构造方式更直接、也不依赖随机行情）。 */
    console.log("  --- 观望已取消（HOLD 提交入口关闭）---");
    const beforeHold = (await snapOf(id2)).operationCount;
    const holdTry = await submitSimTradeAction(id2, { action: "HOLD", mode: "INSTANT" } as never);
    check("HOLD 提交被拒【观望已取消】", !holdTry.success, `实际 success=${holdTry.success}`);
    check(
      "拒绝文案引导玩家「推进 30 分钟 K 线」",
      holdTry.message.includes("推进") && holdTry.message.includes("观望已取消"),
      holdTry.message,
    );
    const afterHold = (await snapOf(id2)).operationCount;
    check("HOLD 被拒后 操作数不变（不消耗）", afterHold === beforeHold, `${beforeHold} → ${afterHold}`);

    // HOLD 不再是合法操作类型之一：错误文案里也不应再宣传它
    check("拒绝文案不再把 HOLD 列为可选项", !holdTry.message.includes("BUY / SELL / HOLD"), holdTry.message);

    await deleteSimTradeSession(id2);
  }

  /* ================= 汇总 ================= */
  console.log("\n" + "=".repeat(64));
  console.log(`通过 ${passed} / 失败 ${failed}`);
  if (failures.length > 0) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log("=".repeat(64));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("ERR", e);
    await prisma.$disconnect();
    process.exit(1);
  });
