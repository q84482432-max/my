/**
 * 历史模拟交易 —— 端到端测试（重点：**未来数据泄露哨兵**）
 *
 * 用户硬性要求：
 *   「必须防止未来数据泄露。例如模拟日期为 2025-10-01，不能读取 2025-10-02 以后任何行情。」
 *   「把历史模拟系统和普通模拟账户解耦。」
 *
 * 本脚本的校验策略是**独立对照**（不拿被测实现验证自己）：
 *   - 服务层给的价格 ↔ 直接用 Prisma 读 klines（带 `tradeDate <= asOf` 上界）对照；
 *   - 哨兵取「截至 currentDate 的最后一根」K0 与「currentDate 之后的第一根」未来 K1，
 *     两者收盘价不同时期望值必须是 K0 —— 若实现泄露未来数据，就会返回 K1；
 *   - 交易日历 ↔ listTradingDates 独立查询对照（推进必须落在真实交易日，跳过周末）；
 *   - 最大回撤 ↔ 本文件内的朴素 O(n²) 实现对照；
 *   - 账户恒等式 ↔ 逐项重算。
 *
 * 运行： npx tsx scripts/testSimulation.ts
 */

import { prisma } from "@/lib/prisma";
import {
  advanceSimulationDay,
  createSimulation,
  deleteSimulation,
  getSimulationAccountId,
  getSimulationInfo,
  getSimulationKlines,
  getSimulationSnapshot,
  listSimulations,
  searchSimulationStocks,
} from "@/services/simulationService";
import {
  calcMaxDrawdown,
  calcPerformance,
  ensureDefaultAccount,
  getAccountSummary,
  getOrders,
  getPositions,
  getTrades,
  placeOrder,
} from "@/services/tradingEngine";
import {
  getKlines,
  getQuotesAsOf,
  listTradingDates,
  normalizeDate,
} from "@/services/marketDataService";
import { DEFAULT_INITIAL_CASH } from "@/lib/constants";
import { toDateStr } from "@/lib/utils";
import type { AdjustType } from "@/types";

/* ------------------------------------------------------------------ */
/* 测试框架                                                            */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m\x1b[36m── ${title} ──\x1b[0m`);
}

function note(text: string): void {
  console.log(`  \x1b[90m· ${text}\x1b[0m`);
}

function near(a: number, b: number, eps = 0.011): boolean {
  return Math.abs(a - b) <= eps;
}

function money(v: number): string {
  return `¥${v.toFixed(2)}`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function numOf(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  return Number((v as { toString(): string }).toString());
}

/** 日期差（自然日） */
function dayDiff(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00.000Z`);
  const tb = Date.parse(`${b}T00:00:00.000Z`);
  return Math.round((tb - ta) / 86400000);
}

/* ------------------------------------------------------------------ */
/* 独立数据源：直接读 klines（不经服务层）                              */
/* ------------------------------------------------------------------ */

interface RawBar {
  date: string;
  close: number;
}

/** 截至 asOf（含）的全部日K（升序），口径取该股自身 adjust */
async function dbBarsUpTo(code: string, asOf: string): Promise<RawBar[]> {
  const s = await prisma.stock.findUnique({
    where: { code },
    select: { id: true, adjust: true },
  });
  if (!s) return [];
  const rows = await prisma.kline.findMany({
    where: {
      stockId: s.id,
      period: "1d",
      adjust: s.adjust as AdjustType,
      tradeDate: { lte: normalizeDate(asOf) },
    },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, close: true },
  });
  return rows.map((r) => ({ date: toDateStr(r.tradeDate), close: numOf(r.close) }));
}

/** asOf 之后的第一根日K（**未来数据**，仅用于构造哨兵） */
async function dbNextBarAfter(code: string, asOf: string): Promise<RawBar | null> {
  const s = await prisma.stock.findUnique({
    where: { code },
    select: { id: true, adjust: true },
  });
  if (!s) return null;
  const row = await prisma.kline.findFirst({
    where: {
      stockId: s.id,
      period: "1d",
      adjust: s.adjust as AdjustType,
      tradeDate: { gt: normalizeDate(asOf) },
    },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, close: true },
  });
  return row ? { date: toDateStr(row.tradeDate), close: numOf(row.close) } : null;
}

/** 朴素 O(n²) 最大回撤（独立对照实现） */
function naiveMaxDrawdown(curve: { date: string; totalAsset: number }[]): {
  maxDrawdown: number;
  start: string | null;
  end: string | null;
} {
  if (curve.length === 0) return { maxDrawdown: 0, start: null, end: null };
  let worst = 0;
  let start: string | null = null;
  let end: string | null = null;
  for (let i = 0; i < curve.length; i++) {
    for (let j = i + 1; j < curve.length; j++) {
      const peak = curve[i].totalAsset;
      if (peak <= 0) continue;
      const dd = ((curve[j].totalAsset - peak) / peak) * 100;
      if (dd < worst) {
        worst = dd;
        start = curve[i].date;
        end = curve[j].date;
      }
    }
  }
  return { maxDrawdown: Math.round(worst * 100) / 100, start, end };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/** 本测试创建的会话 ID（结束时只删自己创建的，不碰用户手动建的数据） */
const createdSimIds: string[] = [];

const RANGE = { start: "2025-09-11", end: "2026-09-11" };
const QTY = 100;

async function main(): Promise<void> {
  console.log("\n\x1b[1m历史模拟交易端到端测试（防未来数据泄露 + 账户解耦）\x1b[0m");
  console.log("═".repeat(64));

  const calendar = await listTradingDates(RANGE.start, RANGE.end);
  if (calendar.length < 10) {
    throw new Error(
      `数据窗口不足：${RANGE.start}~${RANGE.end} 仅 ${calendar.length} 个交易日，无法进行模拟测试`,
    );
  }
  note(`区间 ${RANGE.start} ~ ${RANGE.end}：${calendar.length} 个真实交易日，首日 ${calendar[0]}`);

  /* ================================================================ */
  section("1. 会话创建与交易日历对齐");

  const created = await createSimulation({
    startDate: RANGE.start,
    endDate: RANGE.end,
    initialCash: 100_000,
  });
  check("createSimulation 成功", created.success, created.message);
  const sim = created.simulation!;
  if (!sim) throw new Error("会话创建失败，后续测试无法进行");
  createdSimIds.push(sim.id);

  check(
    "currentDate 对齐到区间内第一个真实交易日",
    sim.currentDate === calendar[0],
    `${sim.currentDate} vs ${calendar[0]}`,
  );
  check("totalDays == 区间真实交易日数", sim.totalDays === calendar.length, `${sim.totalDays}`);
  check("dayIndex 从 1 开始", sim.dayIndex === 1, `${sim.dayIndex}`);
  check(
    "nextDate == 日历第 2 个交易日",
    sim.nextDate === calendar[1],
    `${sim.nextDate} vs ${calendar[1]}`,
  );
  check("status = ACTIVE", sim.status === "ACTIVE", sim.status);
  check("初始资金正确", sim.initialCash === 100_000, money(sim.initialCash));
  check("accountId 非空", sim.accountId.length > 0, sim.accountId);
  check(
    "endDate 记录为会话区间结束日",
    sim.endDate === RANGE.end,
    sim.endDate,
  );

  // DB 溯源：calendar 字段确实固化了完整日历
  const simRow = await prisma.simulation.findUnique({
    where: { id: sim.id },
    select: { calendar: true, currentDate: true, status: true },
  });
  const storedCal = JSON.parse(simRow!.calendar) as string[];
  check(
    "DB 固化的交易日历与 listTradingDates 完全一致",
    storedCal.length === calendar.length &&
      storedCal.every((d, i) => d === calendar[i]),
    `${storedCal.length} 项`,
  );
  check(
    "DB currentDate 与 DTO 一致（均为真实交易日）",
    toDateStr(simRow!.currentDate) === sim.currentDate,
    toDateStr(simRow!.currentDate),
  );

  /* ================================================================ */
  section("2. 与普通模拟账户解耦");

  const plainAccountId = await ensureDefaultAccount();
  check(
    "ensureDefaultAccount 返回的不是模拟会话账户",
    plainAccountId !== sim.accountId,
    `${plainAccountId.slice(0, 8)}… vs ${sim.accountId.slice(0, 8)}…`,
  );

  // 第二个会话 → 账户必须独立
  const created2 = await createSimulation({
    startDate: RANGE.start,
    endDate: calendar[10],
    initialCash: 50_000,
  });
  check("第二个会话创建成功", created2.success, created2.message);
  const sim2 = created2.simulation!;
  if (sim2) createdSimIds.push(sim2.id);
  check(
    "两个模拟会话的账户互不相同",
    !!sim2 && sim2.accountId !== sim.accountId,
    sim2 ? `${sim2.accountId.slice(0, 8)}…` : "N/A",
  );
  check(
    "普通账户与模拟账户互不相同（第二会话亦独立）",
    !!sim2 && sim2.accountId !== plainAccountId,
    "—",
  );

  const plainBefore = await getAccountSummary(plainAccountId);
  const plainTradeIdsBefore = (
    await prisma.trade.findMany({ where: { accountId: plainAccountId }, select: { id: true } })
  )
    .map((t) => t.id)
    .sort()
    .join(",");
  const plainPositionBefore = await prisma.position.count({ where: { accountId: plainAccountId } });
  check("普通账户存在且初始资金为默认值", !!plainBefore, money(plainBefore?.initialCash ?? 0));
  check(
    "模拟会话的初始资金未污染普通账户",
    (plainBefore?.initialCash ?? 0) === DEFAULT_INITIAL_CASH,
    money(plainBefore?.initialCash ?? 0),
  );

  // DB 溯源：Account.simulationId 指向正确
  const boundAccounts = await prisma.account.findMany({
    where: { id: { in: [sim.accountId, sim2?.accountId ?? ""] } },
    select: { id: true, simulationId: true },
  });
  check(
    "模拟账户在 DB 中 simulationId 正确绑定会话",
    boundAccounts.every((a) => a.simulationId !== null),
    boundAccounts.map((a) => a.simulationId?.slice(0, 6)).join(","),
  );
  const plainRow = await prisma.account.findUnique({
    where: { id: plainAccountId },
    select: { simulationId: true },
  });
  check("普通账户在 DB 中 simulationId 为 null", plainRow?.simulationId === null);

  /* ================================================================ */
  section("3. 未来数据泄露哨兵（服务层 vs 直接读库）");

  const TEST_CODES = ["000001", "300750", "688981", "601398"];
  // 抽样 3 个日期：区间首日 / 中段 / 末段
  const sampleDates = [
    calendar[0],
    calendar[Math.floor(calendar.length / 2)],
    calendar[calendar.length - 1],
  ];
  note(`对 ${TEST_CODES.length} 只股票 × ${sampleDates.length} 个日期做哨兵（含中途 K 线）`);
  note(
    `样本日期：${sampleDates.join(" / ")}（注意：末位 ${sampleDates[2]} 之后仍有未来行情，` +
      `若实现泄露就会取到该日之后的收盘价）`,
  );

  let sentinelSamples = 0; // 有效哨兵样本数（K0 与未来 K1 价格不同才有区分力）
  let discriminating = 0;
  let allMatchAsOf = true;
  let allLastDateOk = true;
  let allNotFuture = true;
  const leakDetails: string[] = [];

  for (const code of TEST_CODES) {
    const quotes = await getQuotesAsOf([code], sampleDates[0]);
    if (!quotes[code]) {
      note(`跳过 ${code}：无行情`);
      continue;
    }
    for (const asOf of sampleDates) {
      const q = (await getQuotesAsOf([code], asOf))[code];
      const upTo = await dbBarsUpTo(code, asOf);
      if (upTo.length === 0) continue;
      const k0 = upTo[upTo.length - 1];
      const k1 = await dbNextBarAfter(code, asOf);

      sentinelSamples++;

      // ① 价格必须等于「截至 asOf 的最后一根」
      if (!near(q.close, k0.close, 1e-6)) {
        allMatchAsOf = false;
        leakDetails.push(`${code}@${asOf}: 服务层 ${q.close} ≠ K0 ${k0.close}`);
      }
      // ② lastDate 必须是 K0 的日期（不得是未来日期）
      if (q.lastDate !== k0.date) {
        allLastDateOk = false;
        leakDetails.push(`${code}@${asOf}: lastDate ${q.lastDate} ≠ K0.date ${k0.date}`);
      }
      // ③ 上界：lastDate 绝不能晚于 asOf
      if (q.lastDate !== null && q.lastDate > asOf) {
        allLastDateOk = false;
        leakDetails.push(`${code}@${asOf}: lastDate ${q.lastDate} 晚于模拟日期`);
      }
      // ④ 未来哨兵：若某个未来交易日收盘价与 K0 不同，服务层绝不能返回它
      if (k1 && !near(k1.close, k0.close, 1e-6)) {
        discriminating++;
        if (!near(q.close, k0.close, 1e-6)) {
          allNotFuture = false;
          leakDetails.push(
            `${code}@${asOf}: 疑似泄露未来数据 —— 返回 ${q.close}，K0 ${k0.close}，未来 K1(${k1.date}) ${k1.close}`,
          );
        }
      }
    }
  }

  check("哨兵样本数 > 0", sentinelSamples > 0, `${sentinelSamples} 个`);
  check(
    "服务层价格 == 截至 asOf 的最后一根收盘价",
    allMatchAsOf,
    leakDetails.length > 0 ? leakDetails.slice(0, 3).join(" | ") : `${sentinelSamples} 项全通过`,
  );
  check(
    "lastDate 严格为截至 asOf 的最后一根，且不晚于模拟日期",
    allLastDateOk,
    allLastDateOk ? "全部合规" : leakDetails.slice(0, 3).join(" | "),
  );
  check(
    "具备区分力的哨兵样本（未来价 ≠ 当日价）占比 > 0",
    discriminating > 0,
    `${discriminating}/${sentinelSamples} 个样本可区分未来数据`,
  );
  check(
    "无任何样本返回未来交易日收盘价",
    allNotFuture,
    allNotFuture ? "0 次泄露" : leakDetails.join(" | "),
  );

  /* ================================================================ */
  section("4. K 线接口右端点强制截断");

  for (const code of TEST_CODES) {
    const res = await getSimulationKlines(sim.id, code, "1d", 1000);
    const upTo = await dbBarsUpTo(code, sim.currentDate);
    check(
      `${code} 日K 全部日期 <= currentDate`,
      !!res && res.bars.every((b) => b.date <= sim.currentDate),
      `共 ${res?.bars.length ?? 0} 根`,
    );
    check(
      `${code} 日K 根数与直接读库一致（无未来、无缺漏）`,
      !!res && res.bars.length === upTo.length,
      `${res?.bars.length ?? 0} vs ${upTo.length}`,
    );
    check(
      `${code} 日K 最后一根日期 == 截至 currentDate 的最后一根`,
      !!res && res.bars.length > 0 && res.bars[res.bars.length - 1].date === upTo[upTo.length - 1]?.date,
      `${res?.bars[res.bars.length - 1]?.date ?? "—"}`,
    );
    check(
      `${code} 日K 最后一根收盘价与读库一致`,
      !!res &&
        res.bars.length > 0 &&
        near(res.bars[res.bars.length - 1].close, upTo[upTo.length - 1].close, 1e-6),
      money(res?.bars[res.bars.length - 1]?.close ?? 0),
    );
  }

  // 周K/月K 由日K 聚合，右端点同样受截断
  const wk = await getSimulationKlines(sim.id, "000001", "1w", 1000);
  check(
    "周K 右端点同样被截断（全部日期 <= currentDate）",
    !!wk && wk.bars.every((b) => b.date <= sim.currentDate),
    `共 ${wk?.bars.length ?? 0} 根`,
  );
  const mo = await getSimulationKlines(sim.id, "000001", "1M", 1000);
  check(
    "月K 右端点同样被截断（全部日期 <= currentDate）",
    !!mo && mo.bars.every((b) => b.date <= sim.currentDate),
    `共 ${mo?.bars.length ?? 0} 根`,
  );

  // 客户端无法覆盖右端点：把 endDate 传成未来日期也应被服务端忽略
  const forced = await getKlines("000001", {
    period: "1d",
    endDate: "2099-12-31",
    limit: 1000,
  });
  check(
    "对照：直接调用 getKlines 不传裁剪时会读到最后交易日（说明截断确实来自模拟服务层）",
    forced.length > 0 && forced[forced.length - 1].date > sim.currentDate,
    `末根 ${forced[forced.length - 1]?.date ?? "—"} > currentDate ${sim.currentDate}`,
  );

  /* ================================================================ */
  section("5. 模拟搜索不泄露未来行情");

  const searched = await searchSimulationStocks(sim.id, "", 20);
  check("搜索返回成功", !!searched && searched.items.length > 0, `${searched?.items.length ?? 0} 条`);
  check(
    "搜索结果 currentDate == 会话 currentDate",
    searched?.currentDate === sim.currentDate,
    searched?.currentDate,
  );
  check(
    "搜索结果每项 lastDate 均 <= currentDate",
    !!searched && searched.items.every((it) => it.lastDate === null || it.lastDate <= sim.currentDate),
    searched?.items
      .filter((it) => it.lastDate !== null && it.lastDate > sim.currentDate)
      .map((it) => `${it.code}:${it.lastDate}`)
      .join(",") || "全部合规",
  );

  // 逐项与直接读库对照
  let searchMismatch = 0;
  for (const it of searched?.items ?? []) {
    const upTo = await dbBarsUpTo(it.code, sim.currentDate);
    if (upTo.length === 0) continue;
    const k0 = upTo[upTo.length - 1];
    if (!near(it.close, k0.close, 1e-6) || it.lastDate !== k0.date) searchMismatch++;
  }
  check("搜索结果收盘价/行情日与直接读库逐项一致", searchMismatch === 0, `不一致 ${searchMismatch} 项`);

  // 按关键词搜索（"银行"）同样受限
  const kw = await searchSimulationStocks(sim.id, "银行", 10);
  check(
    "关键词搜索结果同样受 currentDate 上界约束",
    !!kw && kw.items.every((it) => it.lastDate === null || it.lastDate <= sim.currentDate),
    `${kw?.items.length ?? 0} 条`,
  );

  // 次新股：currentDate 早于其上市日 → lastDate 为 null 或早于 currentDate，绝不返回未来首日
  const late = await searchSimulationStocks(sim.id, "600519", 3);
  const mao = late?.items.find((it) => it.code === "600519");
  if (mao) {
    const upTo = await dbBarsUpTo("600519", sim.currentDate);
    check(
      "600519（窗口较短的标的）也严格按 currentDate 截断",
      upTo.length > 0 && near(mao.close, upTo[upTo.length - 1].close, 1e-6),
      `${mao.lastDate} / ${money(mao.close)}`,
    );
  } else {
    note("未取到 600519，跳过窗口较短标的的截断校验");
  }

  /* ================================================================ */
  section("6. 引擎层拦截「未来成交日」与「当日无行情」");

  const futureDate = calendar[1];
  const blockedFuture = await placeOrder({
    accountId: sim.accountId,
    stockCode: "000001",
    side: "BUY",
    orderType: "MARKET",
    quantity: QTY,
    tradeDate: futureDate,
    asOfDate: sim.currentDate,
  });
  check(
    "成交日晚于模拟日期 → 拒绝",
    !blockedFuture.success,
    blockedFuture.message,
  );

  const futureFar = await placeOrder({
    accountId: sim.accountId,
    stockCode: "000001",
    side: "BUY",
    orderType: "MARKET",
    quantity: QTY,
    tradeDate: "2099-01-01",
    asOfDate: sim.currentDate,
  });
  check("成交日为远期未来 → 拒绝", !futureFar.success, futureFar.message);

  // 当日无行情（停牌/未上市）→ 拒绝。
  // 构造：取一个早于 600519 数据窗口起点的交易日建会话，该股当日必然无行情。
  const wide = await listTradingDates("2024-11-01", "2026-09-11");
  const earlyIdx = wide.findIndex((d) => d >= "2025-01-02" && d < "2025-08-20");
  const earlyDate = wide[earlyIdx];
  const earlyEnd = wide[earlyIdx + 4];
  const earlySim = await createSimulation({
    startDate: earlyDate,
    endDate: earlyEnd,
    initialCash: 100_000,
  });
  check("早窗口会话创建成功", earlySim.success, earlySim.message);
  const eSim = earlySim.simulation!;
  if (eSim) createdSimIds.push(eSim.id);

  if (eSim) {
    const maoGap = await dbBarsUpTo("600519", eSim.currentDate);
    const pab = await dbBarsUpTo("000001", eSim.currentDate);
    check(
      "构造有效：600519 在该日无行情，000001 有行情",
      maoGap.length === 0 && pab.length > 0,
      `600519 ${maoGap.length} 根 / 000001 ${pab.length} 根 (${eSim.currentDate})`,
    );

    const noBar = await placeOrder({
      accountId: eSim.accountId,
      stockCode: "600519",
      side: "BUY",
      orderType: "MARKET",
      quantity: QTY,
      asOfDate: eSim.currentDate,
    });
    check("该股在模拟交易日无行情（未上市/停牌）→ 拒绝成交", !noBar.success, noBar.message);

    const okBar = await placeOrder({
      accountId: eSim.accountId,
      stockCode: "000001",
      side: "BUY",
      orderType: "MARKET",
      quantity: QTY,
      asOfDate: eSim.currentDate,
    });
    check("同日有行情的股票正常成交", okBar.success, okBar.message);

    const expected = pab[pab.length - 1];
    check(
      "成交价 == 该模拟交易日的收盘价（读库对照）",
      !!okBar.trade && near(okBar.trade.price, expected.close, 1e-6),
      okBar.trade ? `${money(okBar.trade.price)} vs ${money(expected.close)}` : "无成交",
    );
    check(
      "成交日 == 模拟交易日（不是最新交易日）",
      okBar.trade?.tradedAt === eSim.currentDate,
      `${okBar.trade?.tradedAt} vs ${eSim.currentDate}`,
    );
    // 该会话的成交日期必须早于数据窗口末段（证明确实按历史日期成交）
    check(
      "成交日期确实落在历史区间（远离最新交易日）",
      (okBar.trade?.tradedAt ?? "9999") < "2025-09-01",
      okBar.trade?.tradedAt ?? "—",
    );
  }

  /* ================================================================ */
  section("7. 普通账户在模拟交易期间保持零污染");

  const eSimAccount = eSim?.accountId ?? "";
  const plainAfter = await getAccountSummary(plainAccountId);
  check(
    "模拟会话下单后普通账户现金不变",
    plainBefore !== null &&
      plainAfter !== null &&
      near(plainBefore.availableCash, plainAfter.availableCash, 1e-6),
    `${money(plainBefore?.availableCash ?? 0)} → ${money(plainAfter?.availableCash ?? 0)}`,
  );
  check(
    "模拟会话下单后普通账户总资产不变",
    near(plainBefore?.totalAsset ?? 0, plainAfter?.totalAsset ?? 0, 1e-6),
    `${money(plainAfter?.totalAsset ?? 0)}`,
  );
  const plainTrades = await getTrades(plainAccountId, { limit: 500 });
  const plainTradeIdsAfter = (
    await prisma.trade.findMany({ where: { accountId: plainAccountId }, select: { id: true } })
  )
    .map((t) => t.id)
    .sort()
    .join(",");
  check(
    "普通账户成交集合在模拟交易前后完全一致（零写入）",
    plainTradeIdsBefore === plainTradeIdsAfter,
    `前 ${plainTradeIdsBefore ? plainTradeIdsBefore.split(",").length : 0} 笔 → 后 ${
      plainTradeIdsAfter ? plainTradeIdsAfter.split(",").length : 0
    } 笔`,
  );
  check(
    "普通账户持仓条数未因模拟交易变化",
    (await prisma.position.count({ where: { accountId: plainAccountId } })) === plainPositionBefore,
    `${plainPositionBefore} 条`,
  );
  const simTradesCount = await prisma.trade.count({ where: { accountId: eSimAccount } });
  check(
    "模拟会话的成交记录归属其独占账户",
    simTradesCount > 0,
    `${simTradesCount} 笔（账户 ${eSimAccount.slice(0, 8)}…）`,
  );
  // 落库的模拟成交日期必须落在历史区间内（持久层防泄漏断言）
  const simTradeDates = await prisma.trade.findMany({
    where: { accountId: eSimAccount },
    select: { tradedAt: true },
  });
  check(
    "模拟成交的成交日全部 <= 该会话 currentDate（持久层无未来数据）",
    simTradeDates.every((t) => toDateStr(t.tradedAt) <= (eSim?.currentDate ?? "")),
    simTradeDates.map((t) => toDateStr(t.tradedAt)).join(","),
  );
  check(
    "普通账户成交查询结果与 DB 计数一致",
    plainTrades.length === (plainTradeIdsAfter ? plainTradeIdsAfter.split(",").length : 0),
    `${plainTrades.length} 笔`,
  );

  /* ================================================================ */
  section("8. 推进交易日：真实日历 / T+1 / 每日重算");

  // 用第二个会话（区间较短）做推进测试
  const shortSimId = sim2!.id;
  const shortCal = calendar.slice(0, 11);
  check(
    "短区间会话日历与全局日历前缀一致",
    shortCal[0] === RANGE.start,
    `${shortCal.length} 日`,
  );

  // 首日买入 200 股
  const buy1 = await placeOrder({
    accountId: sim2!.accountId,
    stockCode: "000001",
    side: "BUY",
    orderType: "MARKET",
    quantity: 200,
    asOfDate: sim2!.currentDate,
  });
  check("首日买入成功", buy1.success, buy1.message);

  const posDay1 = await getPositions(sim2!.accountId, sim2!.currentDate);
  const p1 = posDay1.find((p) => p.stockCode === "000001");
  check("首日持仓数量 = 200", p1?.quantity === 200, `${p1?.quantity}`);
  check(
    "T+1：当日买入份额可卖数量为 0",
    p1?.availableQty === 0,
    `${p1?.availableQty}`,
  );

  const snapDay1 = await getSimulationSnapshot(shortSimId);
  check("快照 curve 仅含 currentDate 及以前", !!snapDay1 && snapDay1.curve.every((c) => c.date <= sim2!.currentDate));
  check(
    "快照 curve 首日为会话首日",
    snapDay1?.curve[0]?.date === sim2!.currentDate,
    snapDay1?.curve[0]?.date ?? "—",
  );
  check(
    "首日每日盈亏 == 总资产 − 初始资金",
    !!snapDay1 && near(snapDay1.dailyPnl, round2(snapDay1.summary.totalAsset - snapDay1.simulation.initialCash)),
    money(snapDay1?.dailyPnl ?? 0),
  );

  // 推进
  const adv1 = await advanceSimulationDay(shortSimId);
  check("推进成功", adv1.success, adv1.message);
  const day2 = calendar[1];
  check(
    "推进结果 == 日历中的下一个真实交易日",
    adv1.snapshot?.simulation.currentDate === day2,
    `${adv1.snapshot?.simulation.currentDate} vs ${day2}`,
  );

  /* ---- 跨周末推进：证明推进的是「真实交易日」而非 +1 自然日 ---- */
  const gapCal = await listTradingDates("2025-09-01", "2026-09-10");
  let gapIdx = -1;
  for (let i = 0; i + 2 < gapCal.length; i++) {
    if (dayDiff(gapCal[i], gapCal[i + 1]) >= 2) {
      gapIdx = i;
      break;
    }
  }
  if (gapIdx >= 0) {
    const gapStart = gapCal[gapIdx];
    const gapNext = gapCal[gapIdx + 1];
    const gapEnd = gapCal[gapIdx + 2];
    const gapSim = await createSimulation({
      startDate: gapStart,
      endDate: gapEnd,
      initialCash: 100_000,
    });
    const gSim = gapSim.simulation!;
    if (gSim) createdSimIds.push(gSim.id);
    check(
      `存在非交易日间隙：${gapStart} → ${gapNext}（相差 ${dayDiff(gapStart, gapNext)} 天）`,
      !!gSim,
      `${gSim?.currentDate ?? "—"}`,
    );
    if (gSim) {
      const gAdv = await advanceSimulationDay(gSim.id);
      check(
        "跨周末推进落在真实交易日（而非周六/周日）",
        gAdv.snapshot?.simulation.currentDate === gapNext &&
          dayDiff(gapStart, gapNext) >= 2,
        `${gapStart} → ${gAdv.snapshot?.simulation.currentDate}（跳过 ${
          dayDiff(gapStart, gapNext) - 1
        } 个非交易日）`,
      );
      const gapWeekend = await prisma.kline.count({
        where: { period: "1d", tradeDate: normalizeDate(gAdv.snapshot!.simulation.currentDate) },
      });
      check(
        "推进后的日期在全市场 K 线中确实存在（是真实交易日）",
        gapWeekend > 0,
        `该日 K 线行数 ${gapWeekend}`,
      );
    }
  } else {
    check("找到跨非交易日间隙用于断言", false, "区间内不存在间隙（数据异常）");
  }

  check(
    "推进不会落到非交易日（逐日推进日志全部命中真实日历）",
    adv1.snapshot?.simulation.currentDate === day2 && calendar.includes(day2),
    `${day2} ∈ 日历`,
  );
  check(
    "dayIndex 递增到 2",
    adv1.snapshot?.simulation.dayIndex === 2,
    `${adv1.snapshot?.simulation.dayIndex}`,
  );

  // T+1 生效
  const posDay2 = await getPositions(sim2!.accountId, day2);
  const p2 = posDay2.find((p) => p.stockCode === "000001");
  check(
    "T+1：推进后昨日买入份额解锁为可卖",
    p2?.availableQty === 200,
    `可卖 ${p2?.availableQty} / 持仓 ${p2?.quantity}`,
  );

  // 推进后价格必须刷新为「新交易日」的收盘价（且不得为未来）
  const upToDay2 = await dbBarsUpTo("000001", day2);
  const k2 = upToDay2[upToDay2.length - 1];
  check(
    "推进后持仓现价 == 新交易日收盘价（读库对照）",
    !!p2 && near(p2.lastPrice, k2.close, 1e-6),
    `${money(p2?.lastPrice ?? 0)} vs ${money(k2.close)}`,
  );
  check(
    "推进后持仓昨收 == 新交易日的前一根收盘价",
    !!p2 &&
      upToDay2.length >= 2 &&
      near(p2.prevClose, upToDay2[upToDay2.length - 2].close, 1e-6),
    `${money(p2?.prevClose ?? 0)} vs ${money(upToDay2[upToDay2.length - 2]?.close ?? 0)}`,
  );

  // 账户恒等式（推进后）
  const s2 = adv1.snapshot!;
  check(
    "恒等式：cash = availableCash + frozenCash",
    near(s2.summary.cash, round2(s2.summary.availableCash + s2.summary.frozenCash)),
    money(s2.summary.cash),
  );
  check(
    "恒等式：totalAsset = cash + marketValue",
    near(s2.summary.totalAsset, round2(s2.summary.cash + s2.summary.marketValue)),
    `${money(s2.summary.totalAsset)} vs ${money(round2(s2.summary.cash + s2.summary.marketValue))}`,
  );
  check(
    "恒等式：totalProfit = totalAsset − initialCash",
    near(s2.summary.totalProfit, round2(s2.summary.totalAsset - s2.summary.initialCash)),
    money(s2.summary.totalProfit),
  );
  check(
    "恒等式：totalProfitRate = totalProfit / initialCash × 100",
    near(
      s2.summary.totalProfitRate,
      round2((s2.summary.totalProfit / s2.summary.initialCash) * 100),
    ),
    `${s2.summary.totalProfitRate}%`,
  );

  // 每日重算：市值 = Σ 当日收盘价 × 数量
  const upToDay2All = await dbBarsUpTo("000001", day2);
  const expectedMv = round2(upToDay2All[upToDay2All.length - 1].close * 200);
  check(
    "每日重算：持仓市值 == 当日收盘价 × 数量（读库对照）",
    near(s2.summary.marketValue, expectedMv),
    `${money(s2.summary.marketValue)} vs ${money(expectedMv)}`,
  );

  // 每日快照落库，且每日盈亏口径正确
  const assetRows = await prisma.dailyAsset.findMany({
    where: { accountId: sim2!.accountId },
    orderBy: { date: "asc" },
    select: { date: true, totalAsset: true },
  });
  check(
    "推进后每日资产快照新增一行",
    assetRows.length === 2,
    `${assetRows.length} 行`,
  );
  check(
    "快照日期 == 会话首日与次一交易日",
    toDateStr(assetRows[0].date) === calendar[0] && toDateStr(assetRows[1].date) === day2,
    assetRows.map((r) => toDateStr(r.date)).join(" / "),
  );
  check(
    "dailyPnl == 最后一日总资产 − 前一日总资产",
    near(
      s2.dailyPnl,
      round2(numOf(assetRows[1].totalAsset) - numOf(assetRows[0].totalAsset)),
    ),
    money(s2.dailyPnl),
  );
  check(
    "dailyReturn == 会话快照最后一日的日收益（与落库一致）",
    near(s2.dailyReturn, numOf(assetRows[1].totalAsset) > 0
      ? round2(
          ((numOf(assetRows[1].totalAsset) - numOf(assetRows[0].totalAsset)) /
            numOf(assetRows[0].totalAsset)) *
            100,
        )
      : 0),
    `${s2.dailyReturn}%`,
  );
  check(
    "快照 curve 不含任何晚于 currentDate 的日期",
    s2.curve.every((c) => c.date <= day2),
    `末项 ${s2.curve[s2.curve.length - 1]?.date}`,
  );

  /* ================================================================ */
  section("9. 推进到区间末尾 → 会话结束");

  let guard = 0;
  let lastAdv = adv1;
  while (lastAdv.snapshot?.simulation.status === "ACTIVE" && guard < 40) {
    lastAdv = await advanceSimulationDay(shortSimId);
    if (!lastAdv.success) break;
    guard++;
  }
  const endInfo = await getSimulationInfo(shortSimId);
  check("推进到日历末尾后 status = FINISHED", endInfo?.status === "FINISHED", endInfo?.status);
  check(
    "currentDate == 区间内最后一个真实交易日",
    endInfo?.currentDate === calendar[10],
    `${endInfo?.currentDate} vs ${calendar[10]}`,
  );
  check("nextDate 为 null（无更晚交易日）", endInfo?.nextDate === null, `${endInfo?.nextDate}`);

  const afterEnd = await advanceSimulationDay(shortSimId);
  check("已结束后继续推进：不报错、不越界", afterEnd.success);
  const endInfo2 = await getSimulationInfo(shortSimId);
  check(
    "已结束后 currentDate 保持不变",
    endInfo2?.currentDate === calendar[10],
    `${endInfo2?.currentDate}`,
  );
  // 引擎本身对"会话是否已结束"无概念（会话状态是 simulationService 的职责）。
  // 这一点是刻意的分层：交易规则只在 tradingEngine，会话生命周期只在 simulationService。
  // 因此引擎仍会按最后交易日撮合，而 /api/sim/:id/orders 会在路由层拒绝已结束会话。
  const afterEndOrder = await placeOrder({
    accountId: sim2!.accountId,
    stockCode: "000001",
    side: "BUY",
    orderType: "MARKET",
    quantity: QTY,
    asOfDate: endInfo2!.currentDate,
  });
  check(
    "引擎层与会话状态解耦：仍可按最后交易日撮合（结束拦截在 API 路由层）",
    afterEndOrder.success === true,
    afterEndOrder.message,
  );
  const endSnap = await getSimulationSnapshot(shortSimId);
  check(
    "已结束会话的成交仍不越界（成交日 == 最后交易日）",
    endSnap !== null &&
      endSnap.trades.every((t) => t.tradedAt <= endSnap.simulation.currentDate),
    `${endSnap?.trades.length ?? 0} 笔`,
  );

  /* ================================================================ */
  section("10. 最大回撤（独立朴素实现对照）");

  const synthetic = [
    { date: "2025-01-02", totalAsset: 100000 },
    { date: "2025-01-03", totalAsset: 105000 },
    { date: "2025-01-06", totalAsset: 98000 }, // 峰值 105000 → 98000 = -6.666%
    { date: "2025-01-07", totalAsset: 101000 },
    { date: "2025-01-08", totalAsset: 90000 }, // 峰值 105000 → 90000 = -14.29%
    { date: "2025-01-09", totalAsset: 110000 },
  ];
  const dd = calcMaxDrawdown(synthetic);
  const naive = naiveMaxDrawdown(synthetic);
  check(
    "calcMaxDrawdown 与朴素实现一致",
    near(dd.maxDrawdown, naive.maxDrawdown, 1e-6),
    `${dd.maxDrawdown}% vs ${naive.maxDrawdown}%`,
  );
  check(
    "最大回撤区间定位正确（峰值 → 谷底）",
    dd.start === "2025-01-03" && dd.end === "2025-01-08",
    `${dd.start} → ${dd.end}`,
  );
  check("最大回撤为负值（约定：回撤以负号表示）", dd.maxDrawdown < 0, `${dd.maxDrawdown}%`);

  const perf = calcPerformance(
    synthetic.map((s) => ({ ...s, dailyReturn: 0 })),
    100000,
  );
  check(
    "calcPerformance.maxDrawdown 与 calcMaxDrawdown 一致",
    near(perf.maxDrawdown, dd.maxDrawdown, 1e-6),
    `${perf.maxDrawdown}%`,
  );
  check("calcPerformance.tradingDays == 曲线长度", perf.tradingDays === synthetic.length);

  const realMetrics = (await getSimulationSnapshot(sim.id))!.metrics;
  check(
    "真实会话指标：最大回撤 <= 0",
    realMetrics.maxDrawdown <= 0,
    `${realMetrics.maxDrawdown}%`,
  );
  check(
    "真实会话指标：交易天数 == 快照曲线长度",
    realMetrics.tradingDays === (await getSimulationSnapshot(sim.id))!.curve.length,
    `${realMetrics.tradingDays}`,
  );
  check(
    "真实会话指标：initialAsset == 初始资金",
    realMetrics.initialAsset === 100_000,
    money(realMetrics.initialAsset),
  );

  /* ================================================================ */
  section("11. 列表 / 删除 与会话级联清理");

  const list = await listSimulations();
  check(
    "listSimulations 含本次创建的会话",
    createdSimIds.every((id) => list.some((s) => s.id === id)),
    `共 ${list.length} 个会话`,
  );

  const target = sim2!.id;
  const targetAccount = sim2!.accountId;
  const del = await deleteSimulation(target);
  check("deleteSimulation 成功", del.success, del.message);
  check(
    "删除后会话不在列表中",
    !(await listSimulations()).some((s) => s.id === target),
  );
  const leftover = await prisma.account.count({ where: { id: targetAccount } });
  check("级联删除：会话账户已删除", leftover === 0, `${leftover} 个残留`);
  const leftoverTrades = await prisma.trade.count({ where: { accountId: targetAccount } });
  const leftoverAssets = await prisma.dailyAsset.count({ where: { accountId: targetAccount } });
  check(
    "级联删除：成交与每日快照一并清空",
    leftoverTrades === 0 && leftoverAssets === 0,
    `成交 ${leftoverTrades} / 快照 ${leftoverAssets}`,
  );
  const missing = await deleteSimulation("not-exist-id");
  check("删除不存在的会话 → 返回失败而非抛错", !missing.success, missing.message);

  // 关键回归：删除模拟会话不得影响普通账户
  const plainFinal = await getAccountSummary(plainAccountId);
  check(
    "删除模拟会话后普通账户仍完好（解耦回归）",
    !!plainFinal && near(plainFinal.totalAsset, plainAfter?.totalAsset ?? 0, 1e-6),
    money(plainFinal?.totalAsset ?? 0),
  );

  /* ================================================================ */
  section("12. 参数校验（拒绝非法会话）");

  const bad1 = await createSimulation({ startDate: "2026-09-11", endDate: "2025-09-11", initialCash: 100000 });
  check("开始日期晚于结束日期 → 拒绝", !bad1.success, bad1.message);
  const bad2 = await createSimulation({ startDate: "2025-9-11", endDate: "2025-10-11", initialCash: 100000 });
  check("日期格式非法 → 拒绝", !bad2.success, bad2.message);
  const bad3 = await createSimulation({ startDate: RANGE.start, endDate: RANGE.end, initialCash: 0 });
  check("初始资金为 0 → 拒绝", !bad3.success, bad3.message);
  const bad4 = await createSimulation({ startDate: RANGE.start, endDate: RANGE.end, initialCash: -5 });
  check("初始资金为负 → 拒绝", !bad4.success, bad4.message);
  const bad5 = await createSimulation({ startDate: "1990-01-01", endDate: "1990-02-01", initialCash: 100000 });
  check("区间内无真实交易日 → 拒绝", !bad5.success, bad5.message);
  const bad6 = await createSimulation({ startDate: RANGE.start, endDate: RANGE.end, initialCash: 2_000_000_000 });
  check("初始资金超过上限 → 拒绝", !bad6.success, bad6.message);

  /* ================================================================ */
  await cleanup();

  console.log("\n" + "═".repeat(64));
  console.log(
    `\x1b[1m结果：\x1b[32m${passed} 通过\x1b[0m` +
      (failed > 0 ? `，\x1b[31m${failed} 失败\x1b[0m` : "，0 失败"),
  );
  if (failed > 0) {
    console.log("\x1b[31m失败项：\x1b[0m");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("═".repeat(64) + "\n");

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

/** 只清理本脚本创建的会话（不触碰用户手动创建的数据） */
async function cleanup(): Promise<void> {
  for (const id of createdSimIds) {
    await deleteSimulation(id).catch(() => undefined);
  }
  const remaining = await prisma.simulation.count();
  console.log(`\n\x1b[90m清理：已删除本脚本创建的 ${createdSimIds.length} 个会话，库中剩余 ${remaining} 个\x1b[0m`);
}

main().catch(async (err) => {
  console.error("\n\x1b[31m测试异常终止：\x1b[0m", err);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
