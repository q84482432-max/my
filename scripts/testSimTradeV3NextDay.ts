/**
 * testSimTradeV3NextDay —— 「结算并进入下一交易日」原子操作验收
 *
 * 重点验证（防越界是核心）：
 *   1. `OPEN` / `OPEN_CONFIRMED` 起始 → **拒绝**（当日尚未收盘）
 *   2. `CLOSE` 起始 → 一次调用即到「下一交易日 OPEN」
 *   3. `DAY_SETTLED` 起始 → 一次调用即到「下一交易日 OPEN」
 *   4. **绝不越界**：结果阶段必须是 `OPEN`，绝不能是 `CLOSE_ANIMATION`
 *      （越界 = 提前揭示新交易日的收盘价 = 未来数据泄露）
 *   5. **幂等/不跳日**：连续调用两次只前进一天，不会跳过一整天
 *
 * 运行：DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testSimTradeV3NextDay.ts')"
 */
import prisma from "@/lib/prisma";
import {
  advanceSimTradeStage,
  createSimTradeSession,
  deleteSimTradeSession,
  getSimTradeSnapshot,
  settleAndAdvanceToNextDay,
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

async function snapOf(id: string): Promise<SimTradeSnapshot> {
  const s = await getSimTradeSnapshot(id);
  if (!s) throw new Error("快照为空: " + id);
  return s;
}

async function main(): Promise<void> {
  const created = await createSimTradeSession({ name: "V3-NEXTDAY", tradingDays: 20 });
  if (!created.success || !created.session) throw new Error("创建失败: " + created.message);
  const id = created.session.id;

  /* ---------- 1) OPEN 起始必须被拒 ---------- */
  console.log("\n=== 1) OPEN 起始被拒（当日尚未收盘）===");
  {
    const s = await snapOf(id);
    check("起始 stage = OPEN", s.stage === "OPEN", `实际=${s.stage}`);
    const r = await settleAndAdvanceToNextDay(id);
    check("OPEN 起点调用被拒", !r.success, `实际 success=${r.success}`);
    check("拒绝文案提示先看收盘", /看收盘|尚未收盘/.test(r.message), `实际=${r.message}`);
    const after = await snapOf(id);
    check("被拒后状态未被改动", after.stage === "OPEN" && after.session.currentDate === s.session.currentDate, `stage=${after.stage} date=${after.session.currentDate}`);
  }

  /* ---------- 2) CLOSE 起始 → 一步到下一交易日 ---------- */
  console.log("\n=== 2) CLOSE 起始 → 一次到下一交易日 ===");
  const day1 = (await snapOf(id)).session.currentDate;
  // OPEN -> CLOSE_ANIMATION -> CLOSE
  await advanceSimTradeStage(id);
  await advanceSimTradeStage(id);
  {
    const s = await snapOf(id);
    check("已到 stage = CLOSE", s.stage === "CLOSE", `实际=${s.stage}`);
    check("收盘价已揭示（对比基线用）", s.todayClose !== null, `实际=${s.todayClose}`);

    const r = await settleAndAdvanceToNextDay(id);
    check("CLOSE 起点调用成功", r.success, r.message);
    const after = await snapOf(id);
    check("日期已变化", after.session.currentDate !== day1, `仍是 ${after.session.currentDate}`);
    check("进入下一交易日 OPEN", after.stage === "OPEN", `实际=${after.stage}`);
    check("**未越界到 CLOSE_ANIMATION**（否则会泄露新日收盘）", after.stage !== "CLOSE_ANIMATION", `实际=${after.stage}`);
    check("新日 30m 游标 = 1", after.session.intradayBarCount === 1, `实际=${after.session.intradayBarCount}`);
    check("新日 操作计数 = 0", after.operationCount === 0, `实际=${after.operationCount}`);
    check("新日 todayClose = null", after.todayClose === null, `实际=${after.todayClose}`);
    check("新日 todayBar 未定格", after.todayBar === null || after.todayBar.finalized === false, `实际=${after.todayBar?.finalized}`);
    console.log(`    → ${day1} --next-day--> ${after.session.currentDate} stage=${after.stage}`);
  }

  /* ---------- 3) DAY_SETTLED 起始 ---------- */
  console.log("\n=== 3) DAY_SETTLED 起始 → 一次到下一交易日 ===");
  {
    const dayA = (await snapOf(id)).session.currentDate;
    await advanceSimTradeStage(id); // CLOSE? no: currently OPEN -> CLOSE_ANIMATION
    await advanceSimTradeStage(id); // CLOSE_ANIMATION -> CLOSE
    await advanceSimTradeStage(id); // CLOSE -> DAY_SETTLED
    const s = await snapOf(id);
    check("已到 stage = DAY_SETTLED", s.stage === "DAY_SETTLED", `实际=${s.stage}`);

    const r = await settleAndAdvanceToNextDay(id);
    check("DAY_SETTLED 起点调用成功", r.success, r.message);
    const after = await snapOf(id);
    check("日期已变化", after.session.currentDate !== dayA, `仍是 ${after.session.currentDate}`);
    check("进入下一交易日 OPEN", after.stage === "OPEN", `实际=${after.stage}`);
    check("未越界", after.stage !== "CLOSE_ANIMATION", `实际=${after.stage}`);
  }

  /* ---------- 4) 幂等：连点两次只前进一天 ---------- */
  console.log("\n=== 4) 连点两次只前进一天（不跳日）===");
  {
    // 先把当天推到 CLOSE
    await advanceSimTradeStage(id); // OPEN -> CLOSE_ANIMATION
    await advanceSimTradeStage(id); // -> CLOSE
    const before = await snapOf(id);
    check("前置：stage = CLOSE", before.stage === "CLOSE", `实际=${before.stage}`);

    const r1 = await settleAndAdvanceToNextDay(id);
    const after1 = await snapOf(id);
    check("第 1 次成功", r1.success, r1.message);
    check("第 1 次后日期 +1 天", after1.session.currentDate !== before.session.currentDate, `实际=${after1.session.currentDate}`);

    // 紧接着再点一次：此时处于新日 OPEN，应被拒绝（而不是继续前进）
    const r2 = await settleAndAdvanceToNextDay(id);
    const after2 = await snapOf(id);
    check("第 2 次（新日 OPEN）被拒", !r2.success, `实际 success=${r2.success}`);
    check("第 2 次后日期未再变化【不跳日】", after2.session.currentDate === after1.session.currentDate, `第1次=${after1.session.currentDate} 第2次=${after2.session.currentDate}`);
    check("第 2 次后 stage 仍为 OPEN", after2.stage === "OPEN", `实际=${after2.stage}`);
  }

  await deleteSimTradeSession(id);

  console.log("\n" + "=".repeat(64));
  console.log(`通过 ${passed} / 失败 ${failed}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log("=".repeat(64));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("ERR", e);
    await prisma.$disconnect();
    process.exit(1);
  });
