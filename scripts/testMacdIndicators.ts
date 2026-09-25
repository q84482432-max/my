/**
 * testMacdIndicators —— MACD / EMA / 成交量均线 / 均线图例值的验收
 *
 * 为什么单独测：
 *   MACD 是本项目**第一个递推型**指标（此前的 MA 是无状态滑动窗口）。
 *   递推指标有两个容易出错的地方：① 种子口径（决定与行情软件能否对齐）；
 *   ② **因果性**（一旦不小心用了未来数据，图上会"提前知道"走势，而这在
 *   静态截图里完全看不出来）。本文件用「前缀不变性」把因果性变成可执行断言。
 *
 * 运行：DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testMacdIndicators.ts')"
 */
import type { KlineBar } from "@/types";
import {
  MACD_CONFIG,
  calcEMA,
  calcMA,
  calcMAFromValues,
  calcMACD,
  latestMAValues,
} from "@/lib/indicators";

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

const near = (a: number | null | undefined, b: number, tol = 1e-6) =>
  a !== null && a !== undefined && Math.abs(a - b) <= tol;

/** 造一根只关心 close 的 bar（其余字段给固定值，避免干扰） */
function bar(close: number, i = 0): KlineBar {
  return {
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000 + i,
    amount: close * 1000,
  };
}
const barsOf = (closes: number[]): KlineBar[] => closes.map((c, i) => bar(c, i));

function main(): void {
  console.log("\n=== A. calcEMA：种子口径与递推 ===");
  {
    // k = 2/(n+1) = 2/3
    const e = calcEMA([10, 11, 12], 2);
    check("长度与入参一致", e.length === 3, `${e.length}`);
    check("EMA[0] = close[0]（国内软件口径，用首值播种）", near(e[0], 10), `${e[0]}`);
    check("EMA[1] = 10 + 2/3×(11−10) = 10.6667", near(e[1], 10 + (2 / 3) * 1), `${e[1]}`);
    const exp2 = e[1] + (2 / 3) * (12 - e[1]);
    check("EMA[2] 按同一递推式", near(e[2], exp2), `${e[2]} 期望 ${exp2}`);

    check("空输入返回空数组", calcEMA([], 12).length === 0, "");
    check("单元素输入返回其自身", near(calcEMA([7], 12)[0], 7), "");

    // 常数序列：EMA 必恒等于该常数（递推不动点）
    const flat = calcEMA([5, 5, 5, 5, 5], 9);
    check("常数序列 EMA 恒等于该常数", flat.every((v) => near(v, 5)), JSON.stringify(flat));
  }

  console.log("\n=== B. calcMACD：结构、口径与恒等式 ===");
  {
    const closes = Array.from({ length: 60 }, (_, i) => 10 + i * 0.2);
    const { dif, dea, macd } = calcMACD(barsOf(closes));
    check("三条序列均与入参等长", dif.length === 60 && dea.length === 60 && macd.length === 60, `${dif.length}/${dea.length}/${macd.length}`);
    check("默认参数为 12/26/9", MACD_CONFIG.fast === 12 && MACD_CONFIG.slow === 26 && MACD_CONFIG.signal === 9, JSON.stringify(MACD_CONFIG));

    // 恒等式：柱 = 2 × (DIF − DEA)
    let identityOk = true;
    for (let i = 0; i < 60; i += 1) {
      if (Math.abs(macd[i] - 2 * (dif[i] - dea[i])) > 1e-9) identityOk = false;
    }
    check("恒等式 柱 = 2×(DIF−DEA) 逐点成立", identityOk, "");
    check("恒等式与参数无关（换参数仍成立）", (() => {
      const r = calcMACD(barsOf(closes), { fast: 5, slow: 13, signal: 4 });
      return r.macd.every((v, i) => Math.abs(v - 2 * (r.dif[i] - r.dea[i])) < 1e-9);
    })(), "");

    // 单边上涨：DIF 最终应为正（快线在慢线之上）
    check("单边上涨时末期 DIF > 0", dif[59] > 0, `DIF=${dif[59]}`);
    // 常数序列：DIF/DEA/柱 恒为 0
    const flat = calcMACD(barsOf(new Array(40).fill(8)));
    check("常数序列 DIF 恒为 0", flat.dif.every((v) => near(v, 0)), "");
    check("常数序列 柱 恒为 0", flat.macd.every((v) => near(v, 0)), "");
    check("空输入返回空序列", calcMACD([]).dif.length === 0, "");
  }

  console.log("\n=== C. 因果性（无未来函数）—— {前缀不变性} ===");
  {
    /* 这是本文件最重要的一组断言。
       MACD 是递推指标，若实现里混入了任何「全序列」操作（例如先算全局均值再回填、
       或对 DIF 做了 z-score 归一化），那么**前面的值会随后面数据的加入而改变** ——
       图表上表现为「历史 MACD 会自己动」，且回测时会偷看未来。
       断言方式：对长度 k 的前缀算一次、对全长算一次，两者的前 k 个值必须完全相同。 */
    const closes = Array.from({ length: 80 }, (_, i) => 20 + Math.sin(i / 5) * 3 + i * 0.1);
    const full = calcMACD(barsOf(closes));

    let prefixStable = true;
    for (const k of [5, 12, 26, 27, 40, 60]) {
      const pre = calcMACD(barsOf(closes.slice(0, k)));
      for (let i = 0; i < k; i += 1) {
        if (Math.abs(pre.dif[i] - full.dif[i]) > 1e-12) prefixStable = false;
        if (Math.abs(pre.dea[i] - full.dea[i]) > 1e-12) prefixStable = false;
        if (Math.abs(pre.macd[i] - full.macd[i]) > 1e-12) prefixStable = false;
      }
    }
    check("★ 前缀不变性：截断后段数据不改变前段所有 MACD 值（无未来函数）", prefixStable, "");

    // 反向验证：改**最后一根**价格，不得改变倒数第二根之前的任何值
    const mutated = closes.slice();
    mutated[mutated.length - 1] = mutated[mutated.length - 1] * 3;
    const m = calcMACD(barsOf(mutated));
    let pastUntouched = true;
    for (let i = 0; i < closes.length - 1; i += 1) {
      if (Math.abs(m.dif[i] - full.dif[i]) > 1e-12) pastUntouched = false;
    }
    check("★ 改末根价格不影响之前任何一根的 MACD（严格因果）", pastUntouched, "");
    check("改末根价格**确实**改变了末根 DIF（否则说明它没被使用）", Math.abs(m.dif[79] - full.dif[79]) > 1e-9, "");
  }

  console.log("\n=== D. latestMAValues：均线图例取值 ===");
  {
    const closes = Array.from({ length: 30 }, (_, i) => 10 + i * 0.1);
    const v = latestMAValues(barsOf(closes));
    check("返回 MA_CONFIG 全部周期", v.length === 4, `${v.length}`);
    check("MA5 取到末位窗口均值", near(v[0].value, (closes.slice(25).reduce((a, b) => a + b, 0)) / 5), `${v[0].value}`);
    // MA60 在 30 根数据下无值 → 必须是 null，不能伪装成 0 或末位 close
    check("样本不足的 MA60 取值为 null（不得伪装）", v[3].value === null, `${v[3].value}`);
    check("每条带周期与颜色", v.every((x) => typeof x.n === "number" && typeof x.color === "string"), "");

    // 数据充足时 MA60 应有值，且等于最后 60 根均值
    const longCloses = Array.from({ length: 80 }, (_, i) => 20 + i * 0.05);
    const v2 = latestMAValues(barsOf(longCloses));
    check("数据充足时 MA60 有值", v2[3].value !== null, `${v2[3].value}`);
    check("MA60 == 最后 60 根均值", near(v2[3].value, longCloses.slice(20).reduce((a, b) => a + b, 0) / 60, 1e-6), "");
  }

  console.log("\n=== E. calcMAFromValues：成交量均线 ===");
  {
    const vals = [10, 20, 30, 40, 50];
    const m3 = calcMAFromValues(vals, 3);
    check("前 n−1 根为 null（样本不足）", m3[0] === null && m3[1] === null, JSON.stringify(m3));
    check("idx2 == (10+20+30)/3 = 20", near(m3[2], 20), `${m3[2]}`);
    check("idx3 == (20+30+40)/3 = 30", near(m3[3], 30), `${m3[3]}`);
    check("idx4 == (30+40+50)/3 = 40", near(m3[4], 40), `${m3[4]}`);

    // 与 calcMA 在 close 字段上必须给出**完全相同**的结果（防两套口径漂移）
    const closes = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i) * 2);
    const viaField = calcMA(barsOf(closes), 5);
    const viaValues = calcMAFromValues(closes, 5);
    let same = viaField.length === viaValues.length;
    for (let i = 0; i < viaField.length && same; i += 1) {
      if (viaField[i] === null || viaValues[i] === null) {
        if (viaField[i] !== viaValues[i]) same = false;
      } else if (Math.abs(viaField[i]! - viaValues[i]!) > 1e-12) same = false;
    }
    check("★ 与 calcMA 结果逐点一致（单一口径，不漂移）", same, "");

    // 窗口含 null → 该点必须为 null（不得跳过 null 硬算，否则会把停牌日的 0 当成交量）
    // i=3 的窗口是 values[1..3] = [null, 30, 40]，**含 null**，故仍为 null
    const withNull = calcMAFromValues([10, null, 30, 40], 3);
    check("窗口含 null 时该点为 null", withNull[2] === null, JSON.stringify(withNull));
    check("窗口后移仍含 null 则为 null", withNull[3] === null, JSON.stringify(withNull));

    // 继续后移，窗口已完全越过 null → 恢复正常
    const recovered = calcMAFromValues([10, null, 30, 40, 50], 3);
    check("窗口越过 null 后恢复正常（(30+40+50)/3 = 40）", near(recovered[4], 40), `${recovered[4]}`);

    check("长度与入参一致", calcMAFromValues([1, 2, 3], 2).length === 3, "");
    check("n<=0 时全为 null（防御性）", calcMAFromValues([1, 2, 3], 0).every((x) => x === null), "");
  }

  console.log("\n" + "=".repeat(64));
  console.log(`通过 ${passed} / 失败 ${failed}`);
  if (failures.length > 0) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log("=".repeat(64));
}

main();
