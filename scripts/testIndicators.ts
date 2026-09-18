/**
 * 均线指标单元测试
 *
 * 验证 lib/indicators.ts 的 calcMA / MA_CONFIG：
 *   - 周期集合必须为 MA5 / MA10 / MA20 / MA60（第三阶段要求，且不含 MACD/RSI）
 *   - 前 n-1 根样本不足返回 null（不是 0）
 *   - 均线数值用手工可验算的确定性序列核对
 *   - 纯函数：不修改入参；边界与非法入参行为明确
 *   - 真实数据复核：MA5 首值 = 前 5 根收盘价算术平均
 *
 * 运行： npx tsx scripts/testIndicators.ts
 */

import { calcMA, calcMAs, MA_CONFIG } from "@/lib/indicators";
import { getKlines, getStockInfoByCode } from "@/services/marketDataService";
import type { KlineBar } from "@/types";

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

function section(t: string): void {
  console.log(`\n\x1b[1m\x1b[36m── ${t} ──\x1b[0m`);
}

function approx(a: number, b: number, tol = 1e-12): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

/** 用收盘价序列构造 K 线（其余字段填 0，calcMA 只用 close） */
function barsFromCloses(closes: number[]): KlineBar[] {
  return closes.map((c, i) => ({
    date: `2025-01-${String(i + 1).padStart(2, "0")}`,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 0,
    amount: 0,
  }));
}

async function main(): Promise<void> {
  console.log("\n\x1b[1m均线指标单元测试（MA5 / MA10 / MA20 / MA60）\x1b[0m");
  console.log("═".repeat(64));

  /* ============================================================ */
  section("1. 周期集合");

  const ns = MA_CONFIG.map((c) => c.n).sort((a, b) => a - b);
  check(
    "MA_CONFIG 恰好为 [5, 10, 20, 60]",
    ns.length === 4 && ns[0] === 5 && ns[1] === 10 && ns[2] === 20 && ns[3] === 60,
    `实得 [${ns.join(", ")}]`
  );
  check(
    "每条均线均有独立颜色",
    new Set(MA_CONFIG.map((c) => c.color)).size === MA_CONFIG.length
  );
  check(
    "不包含 MACD / RSI 等复杂指标（无其它周期）",
    !ns.some((n) => n === 9 || n === 12 || n === 26),
    `[${ns.join(", ")}]`
  );

  /* ============================================================ */
  section("2. 确定性序列手工验算");

  // close = [10, 20, 30, 40, 50]，MA3 应 = [null, null, 20, 30, 40]
  const seq = barsFromCloses([10, 20, 30, 40, 50]);
  const ma3 = calcMA(seq, 3);
  check("MA3 长度 = 5", ma3.length === 5, String(ma3.length));
  check("MA3[0] = null（样本不足）", ma3[0] === null);
  check("MA3[1] = null（样本不足）", ma3[1] === null);
  check("MA3[2] = (10+20+30)/3 = 20", ma3[2] === 20, String(ma3[2]));
  check("MA3[3] = (20+30+40)/3 = 30", ma3[3] === 30, String(ma3[3]));
  check("MA3[4] = (30+40+50)/3 = 40", ma3[4] === 40, String(ma3[4]));

  // MA1 应等于自身
  const ma1 = calcMA(seq, 1);
  check(
    "MA1 每根 = 自身收盘价",
    ma1.every((v, i) => v === seq[i].close),
    `[${ma1.join(", ")}]`
  );

  // 常数序列：任何周期均线都等于该常数
  const flat = barsFromCloses([7, 7, 7, 7, 7, 7, 7, 7]);
  for (const n of [1, 3, 5, 8]) {
    const m = calcMA(flat, n);
    const ok = m.every((v, i) => (i >= n - 1 ? v === 7 : v === null));
    check(`常数序列下 MA${n} 恒等于 7`, ok, `[${m.join(", ")}]`);
  }

  // 单调递增序列：MA3 应为中间值
  const inc = barsFromCloses([1, 2, 3, 4, 5, 6]);
  const maInc = calcMA(inc, 3);
  check(
    "递增序列 MA3 = [null,null,2,3,4,5]",
    JSON.stringify(maInc) === JSON.stringify([null, null, 2, 3, 4, 5]),
    JSON.stringify(maInc)
  );

  /* ============================================================ */
  section("3. 边界与非法入参");

  check("空数组返回空数组", calcMA([], 5).length === 0);
  check(
    "数据不足 n 根时全部为 null（不是 0）",
    calcMA(barsFromCloses([1, 2, 3]), 5).every((v) => v === null)
  );
  check(
    "恰好 n 根时只有最后一根有值",
    (() => {
      const m = calcMA(barsFromCloses([2, 4, 6, 8, 10]), 5);
      return m.slice(0, 4).every((v) => v === null) && m[4] === 6;
    })()
  );

  const throws = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check("n = 0 抛错", throws(() => calcMA(seq, 0)));
  check("n 为负数抛错", throws(() => calcMA(seq, -5)));
  check("n 为非整数抛错", throws(() => calcMA(seq, 2.5)));

  /* ============================================================ */
  section("4. 纯函数性质");

  const before = JSON.stringify(seq);
  calcMA(seq, 3);
  check("calcMA 不修改入参", JSON.stringify(seq) === before);

  const beforeCfg = JSON.stringify(MA_CONFIG);
  calcMAs(seq);
  check("calcMAs 不修改 MA_CONFIG", JSON.stringify(MA_CONFIG) === beforeCfg);

  const all = calcMAs(seq, [
    { n: 1, color: "#000" },
    { n: 3, color: "#111" },
  ]);
  check("calcMAs 按入参顺序返回", all.length === 2 && all[0].n === 1 && all[1].n === 3);
  check(
    "calcMAs 结果与逐个 calcMA 一致",
    JSON.stringify(all[1].data) === JSON.stringify(calcMA(seq, 3))
  );

  /* ============================================================ */
  section("5. 真实数据复核（600519）");

  const info = await getStockInfoByCode("600519");
  if (!info) {
    check("600519 可查询", false, "未命中");
  } else {
    const bars = await getKlines("600519", {
      period: "1d",
      adjust: info.adjust,
      limit: 5000,
    });
    check("日K 根数 ≥ 60（足以计算 MA60）", bars.length >= 60, `${bars.length} 根`);

    const ma5 = calcMA(bars, 5);
    const ma60 = calcMA(bars, 60);

    check(
      "MA5 前 4 根为 null，第 5 根起有值",
      ma5.slice(0, 4).every((v) => v === null) && ma5[4] !== null
    );
    check(
      "MA60 前 59 根为 null，第 60 根起有值",
      ma60.slice(0, 59).every((v) => v === null) && ma60[59] !== null
    );

    // 手工复核首根 MA5 = 前 5 根 close 的算术平均
    const manual5 = bars.slice(0, 5).reduce((a, b) => a + b.close, 0) / 5;
    check(
      "MA5[4] = 前 5 根收盘价算术平均（手工复核）",
      approx(ma5[4] as number, manual5),
      `${(ma5[4] as number).toFixed(6)} vs ${manual5.toFixed(6)}`
    );

    // 手工复核末根 MA20
    const last20 = bars.slice(-20).reduce((a, b) => a + b.close, 0) / 20;
    const ma20 = calcMA(bars, 20);
    check(
      "MA20 末根 = 最后 20 根收盘价算术平均（手工复核）",
      approx(ma20[ma20.length - 1] as number, last20),
      `${(ma20[ma20.length - 1] as number).toFixed(6)} vs ${last20.toFixed(6)}`
    );

    // 前复权价有三位小数，均线不应被截断为两位
    const hasSubCent = ma5.some(
      (v) => v !== null && Math.abs(v * 100 - Math.round(v * 100)) > 1e-9
    );
    check(
      "MA 保留三位以上精度（未被 toFixed(2) 截断）",
      hasSubCent,
      `样例 MA5[4]=${(ma5[4] as number).toFixed(6)}`
    );

    console.log(
      `  \x1b[90m样本 600519 日K ${bars.length} 根；末根 close=${bars[bars.length - 1].close}\x1b[0m`
    );
  }

  /* ============================================================ */
  console.log("\n" + "═".repeat(64));
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[1m\x1b[32m✔ 全部通过：${passed}/${total}\x1b[0m`);
  } else {
    console.log(`\x1b[1m\x1b[31m✗ 失败 ${failed}/${total}\x1b[0m`);
    failures.forEach((f) => console.log(`    - ${f}`));
  }
  console.log("═".repeat(64) + "\n");
}

main()
  .then(async () => {
    const { default: prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("\n\x1b[31m测试执行异常:\x1b[0m", e);
    process.exit(1);
  });
