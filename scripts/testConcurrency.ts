/**
 * 并发下单一致性测试 —— 验证 placeOrder 在并发场景下的资金/持仓边界。
 *
 * 复现并锁定修复前存在的「读在事务外」竞态：
 *  - 并发买入：账户余额仅够 1 手，同时发 2 笔下单；修复前应同时放行导致透支，
 *    修复后仅 1 笔成功且 availableCash 永不为负。
 *  - 并发卖出：持有 100 股且全部可卖，同时发 2 笔各卖 100 股；修复前应超卖
 *    （持仓变负/份额丢失），修复后仅 1 笔成功，持仓归零。
 *
 * 运行： npx tsx scripts/testConcurrency.ts
 */

import { prisma } from "@/lib/prisma";
import { createAccount, placeOrder, getAccountSummary } from "@/services/tradingEngine";
import { getLatestBar, getStockInfoByCode } from "@/services/marketDataService";
import { calcBuyOutlay, calcFees } from "@/lib/tradingRules";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
  }
}

const TEST_USER = "e2e_concurrency";
const STOCK = "000001"; // 平安银行，库内 qfq 数据

async function freshAccount(initialCash: number): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { username: TEST_USER },
    select: { id: true, accounts: { select: { id: true } } },
  });
  if (user) {
    for (const a of user.accounts) {
      await prisma.trade.deleteMany({ where: { accountId: a.id } });
      await prisma.order.deleteMany({ where: { accountId: a.id } });
      await prisma.position.deleteMany({ where: { accountId: a.id } });
      await prisma.dailyAsset.deleteMany({ where: { accountId: a.id } });
    }
  }
  return createAccount({
    username: TEST_USER,
    accountName: "并发测试账户",
    initialCash,
  });
}

async function main() {
  const info = await getStockInfoByCode(STOCK);
  const bar = await getLatestBar(STOCK);
  if (!info || !bar || bar.close <= 0) {
    console.error("前置数据缺失：需 stock 000001 的行情");
    process.exit(1);
  }
  const price = bar.close;
  const lot = 100;
  const oneLotAmount = Math.round(price * lot * 100) / 100;
  const oneLotFees = calcFees(oneLotAmount, "BUY");
  const oneLotOutlay = calcBuyOutlay(oneLotAmount, oneLotFees);
  const stockId = info.id;

  /* ---------- 用例 1：并发买入（余额仅够 1 手） ---------- */
  console.log("\n\x1b[1m\x1b[36m── 并发买入：余额仅够 1 手，同时发 2 笔 ──\x1b[0m");
  const buyAcct = await freshAccount(oneLotOutlay); // 恰好够 1 手
  const buyResults = await Promise.all([
    placeOrder({ accountId: buyAcct, stockCode: STOCK, side: "BUY", quantity: lot, tradeDate: bar.date }),
    placeOrder({ accountId: buyAcct, stockCode: STOCK, side: "BUY", quantity: lot, tradeDate: bar.date }),
  ]);
  const buySuccess = buyResults.filter((r) => r.success).length;
  const acctAfter = await prisma.account.findUnique({
    where: { id: buyAcct },
    select: { availableCash: true },
  });
  const posAfter = await prisma.position.findMany({ where: { accountId: buyAcct } });
  const totalBought = posAfter.reduce((s, p) => s + p.quantity, 0);
  const availCash = Number(acctAfter!.availableCash);

  check("仅 1 笔买入成功", buySuccess === 1, `成功数=${buySuccess}`);
  check("availableCash 不为负", availCash >= -1e-9, `availableCash=${availCash.toFixed(2)}`);
  check("实际买入不超过 1 手", totalBought === lot, `持有=${totalBought}`);

  /* ---------- 用例 2：并发卖出（持有 100 且全可卖，同时卖 2 笔各 100） ---------- */
  console.log("\n\x1b[1m\x1b[36m── 并发卖出：持有 100 全可卖，同时发 2 笔各卖 100 ──\x1b[0m");
  const sellAcct = await freshAccount(100000);
  // 直接造一个干净持仓（绕过 T+1，availableQty=100）
  await prisma.position.create({
    data: {
      accountId: sellAcct,
      stockId,
      quantity: lot,
      availableQty: lot,
      avgCost: price,
      lastPrice: price,
      unrealizedPnl: 0,
    },
  });
  const sellResults = await Promise.all([
    placeOrder({ accountId: sellAcct, stockCode: STOCK, side: "SELL", quantity: lot, tradeDate: bar.date }),
    placeOrder({ accountId: sellAcct, stockCode: STOCK, side: "SELL", quantity: lot, tradeDate: bar.date }),
  ]);
  const sellSuccess = sellResults.filter((r) => r.success).length;
  const posAfterSell = await prisma.position.findMany({ where: { accountId: sellAcct } });
  const totalLeft = posAfterSell.reduce((s, p) => s + p.quantity, 0);

  check("仅 1 笔卖出成功", sellSuccess === 1, `成功数=${sellSuccess}`);
  check("持仓未超卖（剩余≥0 且=0）", totalLeft === 0, `剩余=${totalLeft}`);

  /* ---------- 用例 3：并发混合（5 笔买入抢 1 手额度） ---------- */
  console.log("\n\x1b[1m\x1b[36m── 混合压力：5 笔并发买入抢 1 手额度 ──\x1b[0m");
  const stressAcct = await freshAccount(oneLotOutlay);
  const stressResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      placeOrder({ accountId: stressAcct, stockCode: STOCK, side: "BUY", quantity: lot, tradeDate: bar.date }),
    ),
  );
  const stressSuccess = stressResults.filter((r) => r.success).length;
  const posStress = await prisma.position.findMany({ where: { accountId: stressAcct } });
  const totalStress = posStress.reduce((s, p) => s + p.quantity, 0);
  const cashStress = Number(
    (await prisma.account.findUnique({ where: { id: stressAcct }, select: { availableCash: true } }))!.availableCash,
  );
  check("5 笔中仅 1 笔成功", stressSuccess === 1, `成功数=${stressSuccess}`);
  check("持有恰为 1 手", totalStress === lot, `持有=${totalStress}`);
  check("现金不为负", cashStress >= -1e-9, `cash=${cashStress.toFixed(2)}`);

  const summary = await getAccountSummary(stressAcct);
  if (summary) {
    check("账户汇总总现金=可用现金（frozenCash=0）", Math.abs(summary.cash - summary.availableCash) < 0.02);
  }

  console.log(`\n\x1b[1m结果：\x1b[32m${passed} 通过\x1b[0m, \x1b[31m${failed} 失败\x1b[0m`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
