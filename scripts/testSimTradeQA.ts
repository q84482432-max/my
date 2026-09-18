/**
 * testSimTradeQA —— QA 独立补充边界测试（严过关）
 *
 * 与 testSimTrade.ts 不重叠的覆盖点：
 *  1. 账户恒等式：现金 + 持仓市值 == 初始资金 + 累计已实现盈亏（误差 < 0.05）
 *  2. 一周内多次部分卖出后 availableQty/todayQty 恒自洽
 *  3. 最后一天（第 N 日）正常结算结束、结束后再 action/next 被拒
 *  4. 已 FINISHED 会话再 action/next/reveal 行为
 *  5. 会话删除后关联账户级联清理（无孤儿账户 / 持仓 / 成交 / 快照）
 *  6. 揭晓前后快照均不含代码/名称（揭晓前）；揭晓后仅在 reveal 返回体
 *  7. 随机 5 局：选中股票确在 K 线表、区间落在数���窗口内
 *  8. 非法 percent 边界：-10 / 0 / 101 / "abc" / null / 1e9（负 percent 静默满仓回归）
 *  9. 100% 档不满仓回归：现金残留应足够小、现金不为负、不超买
 *
 * 运行：node -e "(async()=>{await (await import('./runner.mjs')).run('scripts/testSimTradeQA.ts');})()"
 */
import prisma from "@/lib/prisma";
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

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

async function snapOf(id: string): Promise<SimTradeSnapshot> {
  const s = await getSimTradeSnapshot(id);
  if (!s) throw new Error(`快照为空: ${id}`);
  return s;
}

/** 账户恒等式：cash + marketValue − initialCash ≈ totalProfit，且 totalAsset 一致 */
function assertAccountingIdentity(label: string, snap: SimTradeSnapshot): void {
  const s = snap.summary;
  const lhs = num(s.cash) + num(s.marketValue);
  check(`${label}: cash+市值 = totalAsset`, Math.abs(lhs - num(s.totalAsset)) < 0.05,
    `cash=${s.cash} mv=${s.marketValue} total=${s.totalAsset}`);
  check(`${label}: totalAsset−initialCash = totalProfit`,
    Math.abs(num(s.totalAsset) - num(s.initialCash) - num(s.totalProfit)) < 0.05,
    `total=${s.totalAsset} init=${s.initialCash} pnl=${s.totalProfit}`);
}

/** T+1 自洽：availableQty + todayQty == quantity，且均非负 */
function assertPositionSelfConsistent(label: string, snap: SimTradeSnapshot): void {
  const p = snap.position;
  if (!p) return;
  check(`${label}: availableQty+todayQty = quantity`,
    p.availableQty + p.todayQty === p.quantity,
    `avail=${p.availableQty} today=${p.todayQty} qty=${p.quantity}`);
  check(`${label}: availableQty/todayQty 均非负`, p.availableQty >= 0 && p.todayQty >= 0,
    `avail=${p.availableQty} today=${p.todayQty}`);
  check(`${label}: availableQty <= quantity`, p.availableQty <= p.quantity);
}

async function main(): Promise<void> {
  console.log("\n===== QA 独立补充边界测试（严过关）=====\n");

  /* ---------- 回归 1：非法 percent 边界（含负值/null） ---------- */
  console.log("[A] 非法 percent 边界（负值/null 静默满仓回归）");
  {
    // 每个非法输入用独立会话，避免「一次成功即确认当日、后续全部被同日重复拦截」
    const badCases: Array<[string, unknown]> = [
      ["-10", -10],
      ["0", 0],
      ["101", 101],
      ["abc", "abc"],
      ["1e9", 1e9],
      ["0.5（不足1）", 0.5],
      ["null（契约：1~100 之外一律拒绝）", null],
    ];
    for (const [label, percent] of badCases) {
      const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 22 });
      if (!c.success || !c.session) { check(`percent=${label} 会话创建`, false, c.message); continue; }
      const id = c.session.id;
      try {
        const r = await submitSimTradeAction(id, { action: "BUY", percent: percent as number });
        check(`percent=${label} 被拒绝（非静默成 100% 满仓）`, r.success === false,
          r.success ? `竟然成功了！msg=${r.message}` : "");
        const s = await snapOf(id);
        check(`percent=${label} 拒绝后无持仓产生`, s.position === null,
          `qty=${s.position?.quantity}`);
      } finally {
        await deleteSimTradeSession(id);
      }
    }
    // 合法边界 1 / 100 应通过（各用独立会话）
    for (const ok of [1, 100]) {
      const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 22 });
      const id = c.session!.id;
      try {
        const r = await submitSimTradeAction(id, { action: "BUY", percent: ok });
        check(`percent=${ok} 合法通过`, r.success, r.message);
      } finally {
        await deleteSimTradeSession(id);
      }
    }
  }

  /* ---------- 回归 2：100% 档不满仓 ---------- */
  console.log("\n[B] 100% 买入满仓回归（现金残留应足够小）");
  {
    // 多跑几局覆盖不同股价区间的标的
    for (let round = 0; round < 3; round += 1) {
      const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 22 });
      if (!c.success || !c.session) {
        check(`第 ${round + 1} 局创建`, false);
        continue;
      }
      const id = c.session.id;
      try {
        const before = await snapOf(id);
        const r = await submitSimTradeAction(id, { action: "BUY", percent: 100 });
        check(`第 ${round + 1} 局 100% 买入成功`, r.success, r.message);
        if (!r.success) continue;
        const s = await snapOf(id);
        const cashLeft = num(s.summary.cash);
        const qty = s.position?.quantity ?? 0;
        check(`第 ${round + 1} 局 现金 >= 0（不超买）`, cashLeft >= 0, `cash=${cashLeft}`);
        check(`第 ${round + 1} 局 有持仓`, qty > 0, `qty=${qty}`);
        // 100% 档：残留现金 = 整手取整余数 + 预留的一手，理论上限约 2 手成本。
        // 契约「尽量贴近满仓」→ 残留应 < 2 手成本（超出即为预留算法浪费，见报告）。
        const avgCost = s.position?.avgCost ?? 0;
        const oneLot = avgCost * 100;
        check(`第 ${round + 1} 局 100% 后残留现金 < 2 手成本`,
          cashLeft < oneLot * 2, `cash=${cashLeft} 一手≈${oneLot.toFixed(0)} 首日open=${before.openPrice}`);
        check(`第 ${round + 1} 局 100% 仓位比 > 90%`,
          s.positionRatio > 90, `仓位比=${s.positionRatio}%`);
        assertAccountingIdentity(`第 ${round + 1} 局 100% 后`, s);
      } finally {
        await deleteSimTradeSession(id);
      }
    }
  }

  /* ---------- 连续买卖 + 恒等式 + 部分卖出自洽 ---------- */
  console.log("\n[C] 连续买卖：账户恒等式 + availableQty/todayQty 自洽");
  {
    const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 22 });
    if (!c.success || !c.session) throw new Error("创建失败");
    const id = c.session.id;
    try {
      let snap = await snapOf(id);
      assertAccountingIdentity("初始", snap);

      // D1 买入 50%
      let r = await submitSimTradeAction(id, { action: "BUY", percent: 50 });
      check("D1 买入 50%", r.success, r.message);
      snap = await snapOf(id);
      assertPositionSelfConsistent("D1 收盘后", snap);
      assertAccountingIdentity("D1 收盘后", snap);
      check("D1 当日新买不可卖", snap.position!.availableQty === 0 && snap.position!.todayQty > 0,
        `avail=${snap.position!.availableQty} today=${snap.position!.todayQty}`);

      // D2：解冻 → 加仓 30%
      await advanceSimTradeDay(id);
      snap = await snapOf(id);
      check("D2 昨日买入已解冻", snap.position!.availableQty > 0, `avail=${snap.position!.availableQty}`);
      assertPositionSelfConsistent("D2 推进后", snap);
      r = await submitSimTradeAction(id, { action: "BUY", percent: 30 });
      check("D2 加仓 30%", r.success, r.message);
      snap = await snapOf(id);
      assertPositionSelfConsistent("D2 收盘后", snap);
      assertAccountingIdentity("D2 收盘后", snap);

      // D3~D5：多次部分卖出，验证恒等与自洽始终成立
      for (let d = 3; d <= 5; d += 1) {
        await advanceSimTradeDay(id);
        snap = await snapOf(id);
        assertPositionSelfConsistent(`D${d} 推进后`, snap);
        if (snap.position && snap.position.availableQty > 0) {
          const sell = await submitSimTradeAction(id, { action: "SELL", percent: 30 });
          check(`D${d} 部分卖出 30%`, sell.success, sell.message);
        } else {
          // 无可卖则观望
          await submitSimTradeAction(id, { action: "HOLD" });
        }
        snap = await snapOf(id);
        assertPositionSelfConsistent(`D${d} 收盘后`, snap);
        assertAccountingIdentity(`D${d} 收盘后`, snap);
        check(`D${d} 现金不为负`, num(snap.summary.cash) >= 0, `cash=${snap.summary.cash}`);
      }

      // 清仓：100% 卖出应卖光可卖（含零股）
      await advanceSimTradeDay(id);
      const clr = await submitSimTradeAction(id, { action: "SELL", percent: 100 });
      check("清仓 100% 成功", clr.success, clr.message);
      snap = await snapOf(id);
      check("清仓后持仓归零", snap.position === null || snap.position.quantity === 0,
        `qty=${snap.position?.quantity}`);
      assertAccountingIdentity("清仓后", snap);
    } finally {
      await deleteSimTradeSession(id);
    }
  }

  /* ---------- 最后一天结算 + FINISHED 后拒绝操作 ---------- */
  console.log("\n[D] 最后一天结算结束 & FINISHED 后拒绝操作");
  {
    const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 20 });
    if (!c.success || !c.session) throw new Error("创建失败");
    const id = c.session.id;
    try {
      let snap = await snapOf(id);
      const totalDays = snap.session.totalDays;
      let guard = 0;
      // 推进到最后一天且结束
      while (snap.session.status === "ACTIVE" && guard < 60) {
        guard += 1;
        if (!snap.session.confirmedToday) {
          await submitSimTradeAction(id, { action: "HOLD" });
          snap = await snapOf(id);
        }
        const a = await advanceSimTradeDay(id);
        snap = await snapOf(id);
        if (a.finished) break;
      }
      check("最终走到 FINISHED", snap.session.status === "FINISHED", `status=${snap.session.status}`);
      check("结束日 = 日历最后一天", snap.session.dayIndex === snap.session.totalDays,
        `day=${snap.session.dayIndex}/${snap.session.totalDays}`);
      check("结束日 = totalDays 记录", snap.session.totalDays === totalDays);
      check("结算数据存在", snap.settlement !== null);

      // FINISHED 后再操作应被拒
      const afterAction = await submitSimTradeAction(id, { action: "BUY", percent: 10 });
      check("FINISHED 后再 action 被拒", afterAction.success === false, afterAction.message);
      const afterNext = await advanceSimTradeDay(id);
      check("FINISHED 后再 next 幂等返回 finished", afterNext.finished === true, afterNext.message);
      // 再 action 后账户恒等式仍成立、持仓未被改变
      const snap2 = await snapOf(id);
      assertAccountingIdentity("FINISHED 后", snap2);
      check("FINISHED 后未被误改 status", snap2.session.status === "FINISHED");
    } finally {
      await deleteSimTradeSession(id);
    }
  }

  /* ---------- 级联删除：无孤儿账户/持仓/成交/快照 ---------- */
  console.log("\n[E] 删除会话 → 关联账户级联清理");
  {
    const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 20 });
    if (!c.success || !c.session) throw new Error("创建失败");
    const id = c.session.id;
    // 先做一笔买入产生持仓/成交/资产快照
    await submitSimTradeAction(id, { action: "BUY", percent: 50 });
    const accountId = c.session.accountId;
    check("会话绑定了账户", !!accountId, `accountId=${accountId}`);

    const accBefore = await prisma.account.findUnique({ where: { id: accountId } });
    check("删除前账户存在", accBefore !== null);
    const posBefore = await prisma.position.count({ where: { accountId } });
    const tradeBefore = await prisma.trade.count({ where: { accountId } });
    const assetBefore = await prisma.dailyAsset.count({ where: { accountId } });
    check("删除前有持仓/成交/资产快照", posBefore > 0 && tradeBefore > 0 && assetBefore > 0,
      `pos=${posBefore} trade=${tradeBefore} asset=${assetBefore}`);

    const del = await deleteSimTradeSession(id);
    check("删除会话成功", del.success, del.message);

    const accAfter = await prisma.account.findUnique({ where: { id: accountId } });
    check("删除后账户已级联清理（无孤儿账户）", accAfter === null,
      accAfter ? `仍存在 accountId=${accountId}` : "");
    const posAfter = await prisma.position.count({ where: { accountId } });
    const tradeAfter = await prisma.trade.count({ where: { accountId } });
    const assetAfter = await prisma.dailyAsset.count({ where: { accountId } });
    check("删除后持仓已清理", posAfter === 0, `pos=${posAfter}`);
    check("删除后成交已清理", tradeAfter === 0, `trade=${tradeAfter}`);
    check("删除后资产快照已清理", assetAfter === 0, `asset=${assetAfter}`);
    // 会话本身也消失
    const sessAfter = await prisma.simTradeSession.findUnique({ where: { id } });
    check("删除后会话不存在", sessAfter === null);
  }

  /* ---------- 揭晓前后防泄漏 ---------- */
  console.log("\n[F] 揭晓前快照不含身份 / 揭晓仅在 reveal 返回体");
  {
    const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 20 });
    if (!c.success || !c.session) throw new Error("创建失败");
    const id = c.session.id;
    try {
      // 进行中：快照全程无 6 位代码 / 名称字段
      const snapMid = await snapOf(id);
      const blobMid = JSON.stringify(snapMid);
      check("进行中快照无 hiddenStockCode", !blobMid.includes("hiddenStockCode"));
      check("进行中快照无 6 位股票代码", !/"[0368]\d{5}"/.test(blobMid),
        (blobMid.match(/"[0368]\d{5}"/g) || []).slice(0, 3).join(","));
      // 进行中揭晓应被拒
      const earlyReveal = await revealSimTradeStock(id);
      check("进行中揭晓被拒", earlyReveal.success === false, earlyReveal.message);
      check("进行中揭晓不返回身份", !earlyReveal.reveal);

      // 跑到结束
      let snap = await snapOf(id);
      let guard = 0;
      while (snap.session.status === "ACTIVE" && guard < 60) {
        guard += 1;
        if (!snap.session.confirmedToday) {
          await submitSimTradeAction(id, { action: "HOLD" });
          snap = await snapOf(id);
        }
        const a = await advanceSimTradeDay(id);
        snap = await snapOf(id);
        if (a.finished) break;
      }
      check("结束前快照仍无代码", !/"hiddenStockCode"|"[0368]\d{5}"/.test(JSON.stringify(snap)));
      const rv = await revealSimTradeStock(id);
      check("FINISHED 后揭晓成功", rv.success, rv.message);
      check("揭晓返回真实代码/名称", !!rv.reveal?.code && !!rv.reveal?.name,
        `${rv.reveal?.name}(${rv.reveal?.code})`);
    } finally {
      await deleteSimTradeSession(id);
    }
  }

  /* ---------- 随机 5 局：标的真实 + 区间在窗口内 ---------- */
  console.log("\n[G] 随机 5 局：选中标的确在 K 线表、区间落在真实数据窗口内");
  {
    const DATA_MIN = "2024-11-04";
    const DATA_MAX = "2026-09-10";
    for (let i = 0; i < 5; i += 1) {
      const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 22 });
      if (!c.success || !c.session) { check(`第 ${i + 1} 局创建`, false, c.message); continue; }
      const id = c.session.id;
      try {
        const row = await prisma.simTradeSession.findUnique({
          where: { id },
          select: { hiddenStockCode: true, startDate: true, endDate: true, currentDate: true },
        });
        const code = row!.hiddenStockCode;
        const stock = await prisma.stock.findUnique({ where: { code }, select: { id: true, isActive: true } });
        check(`第 ${i + 1} 局 标的存在于 stocks 表`, !!stock, `code=${code}`);
        const kcnt = stock ? await prisma.kline.count({ where: { stockId: stock.id, period: "1d" } }) : 0;
        check(`第 ${i + 1} 局 标的有日 K 数据`, kcnt > 0, `code=${code} klines=${kcnt}`);
        const start = c.session.startDate;
        const end = c.session.endDate;
        check(`第 ${i + 1} 局 区间起点在数据窗口内`,
          start >= DATA_MIN && start <= DATA_MAX, `start=${start}`);
        check(`第 ${i + 1} 局 区间终点在数据窗口内`,
          end >= DATA_MIN && end <= DATA_MAX, `end=${end}`);
        check(`第 ${i + 1} 局 交易日 20~23`, c.session.totalDays >= 20 && c.session.totalDays <= 23,
          `days=${c.session.totalDays}`);
        // 该标在模拟区间内逐日都有 K 线（不停牌）
        const simDates = c.session.nextDate ? null : null; // 仅用总量近似
        check(`第 ${i + 1} 局 K 线根数充足（含 >=60 历史）`, kcnt >= 82, `klines=${kcnt}`);
      } finally {
        await deleteSimTradeSession(id);
      }
    }
  }

  /* ---------- 并发：同一会话并发两次 action ---------- */
  console.log("\n[H] 并发：同一会话并发两次 action 只应成交一次");
  {
    let bothSuccess = 0;
    let doubleFills = 0;
    const N = 6;
    for (let i = 0; i < N; i += 1) {
      const c = await createSimTradeSession({ initialCash: 100000, tradingDays: 22 });
      if (!c.success || !c.session) continue;
      const id = c.session.id;
      const accId = c.session.accountId;
      try {
        const results = await Promise.all([
          submitSimTradeAction(id, { action: "BUY", percent: 50 }),
          submitSimTradeAction(id, { action: "BUY", percent: 50 }),
        ]);
        if (results.filter((r) => r.success).length === 2) bothSuccess += 1;
        const trades = await prisma.trade.count({ where: { accountId: accId } });
        if (trades > 1) doubleFills += 1;
      } finally {
        await deleteSimTradeSession(id);
      }
    }
    check(`并发双提交未产生双倍成交（${N} 局）`, doubleFills === 0,
      `双倍成交局数=${doubleFills} 两次均返回成功局数=${bothSuccess}`);
  }

  console.log(`\n===== QA 补充边界结果：${passed} 通过 / ${failed} 失败 =====\n`);
  if (failed > 0) {
    console.log("失败项：");
    failures.forEach((f) => console.log("  - " + f));
  }
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
