/**
 * 数据库初始化脚本（seed）
 *
 * 职责：建立**最小可用的初始数据**，让页面首次打开即可使用。
 * 注意：本脚本**不生成任何行情数据**。K线数据一律通过
 * `scripts/importKline.ts` 导入真实历史数据。
 *
 * 执行：npm run db:seed
 *
 * 幂等性：可重复执行。已存在的用户/账户不会被重复创建。
 */

import { config } from "dotenv";

config();

async function main(): Promise<void> {
  // 动态导入，确保 .env 已先加载
  const { default: prisma } = await import("../lib/prisma");
  const { ensureDefaultAccount, createAccount } = await import(
    "../services/tradingEngine"
  );

  console.log("[seed] 开始初始化基础数据...");

  // 1) 默认模拟账户（初始资金 10 万，见 lib/constants.ts 的 DEFAULT_INITIAL_CASH）
  const existing = await prisma.account.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, initialCash: true },
  });

  if (existing) {
    console.log(
      `[seed] 已存在账户：${existing.name}（初始资金 ${existing.initialCash}），跳过创建`,
    );
  } else {
    const accountId = await ensureDefaultAccount();
    console.log(`[seed] 已创建默认模拟账户 id=${accountId}（初始资金 100,000）`);
  }

  // 2) 额外创建一个「空账户」，便于对照演示多账户切换
  const extraUsername = "demo2";
  const hasExtraUser = await prisma.user.findUnique({
    where: { username: extraUsername },
    select: { id: true },
  });
  if (hasExtraUser) {
    console.log(`[seed] 用户 ${extraUsername} 已存在，跳过`);
  } else {
    const id = await createAccount({
      username: extraUsername,
      nickname: "对照账户",
      accountName: "对照模拟账户",
      initialCash: 100_000,
    });
    console.log(`[seed] 已创建对照账户 id=${id}（初始资金 100,000）`);
  }

  // 3) 行情数据现状提示（不做任何写入）
  const [stockCount, klineCount] = await Promise.all([
    prisma.stock.count(),
    prisma.kline.count(),
  ]);
  console.log(
    `[seed] 当前行情数据：股票 ${stockCount} 只，日K ${klineCount} 根` +
      (stockCount === 0
        ? "\n[seed] 提示：尚未导入行情，请执行：\n" +
          "       npx tsx scripts/importKline.ts --dir=./data/kline --skip-missing-market=true"
        : ""),
  );

  console.log("[seed] 完成。");
}

main()
  .catch((err) => {
    console.error("[seed] 失败：", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { default: prisma } = await import("../lib/prisma");
    await prisma.$disconnect();
  });
