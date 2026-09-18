// 离线对照测试：回撤起始日的「旧逻辑 vs 新逻辑」
// 用途：在改动线上编译产物之前，先证明新逻辑正确、旧逻辑确实错、边界情况不炸。
'use strict';

// ---- 复刻 C2（buildDrawdownCurve），与线上模块 72406 的 e 函数同语义 ----
function buildCurve(points) {
  let peak = -Infinity;
  const out = [];
  for (const p of points) {
    if (p.totalAsset > peak) peak = p.totalAsset;
    const dd = peak > 0 ? (p.totalAsset - peak) / peak * 100 : 0;
    out.push({
      date: p.date,
      totalAsset: p.totalAsset,
      peak: Math.round(100 * peak) / 100,
      drawdownPercent: Math.round(100 * dd) / 100,
    });
  }
  return out;
}

// ---- 线上旧逻辑（有 Bug）：起始日 = 全区间最高点日期 ----
function runOld(k, s) {
  const j = { maxDrawdownStart: null, maxDrawdownEnd: null };
  if (s < 0) {
    let a = -1 / 0, b = null, c = null;
    for (const d of k) {
      d.totalAsset > a && ((a = d.totalAsset), (b = d.date));
      d.drawdownPercent === s && null === c && (c = d.date);
    }
    j.maxDrawdownStart = b;
    j.maxDrawdownEnd = c;
  }
  return j;
}

// ---- 线上新逻辑（补丁后）：起始日 = 回撤前的运行峰值日 ----
function runNew(k, s) {
  const j = { maxDrawdownStart: null, maxDrawdownEnd: null };
  if (s < 0 && k.length > 0) {
    let __ddPeak = k[0].totalAsset, __ddPeakDate = k[0].date, __ddStart = null, __ddEnd = null, __ddWorst = 0;
    for (const __ddItem of k) {
      __ddItem.totalAsset > __ddPeak && ((__ddPeak = __ddItem.totalAsset), (__ddPeakDate = __ddItem.date));
      const __ddCur = __ddPeak > 0 ? (__ddItem.totalAsset - __ddPeak) / __ddPeak * 100 : 0;
      __ddCur < __ddWorst && ((__ddWorst = __ddCur), (__ddStart = __ddPeakDate), (__ddEnd = __ddItem.date));
    }
    j.maxDrawdownStart = __ddStart;
    j.maxDrawdownEnd = __ddEnd;
  }
  return j;
}

function minDD(k) {
  let s = 0;
  for (const x of k) if (x.drawdownPercent < s) s = x.drawdownPercent;
  return s;
}

let pass = 0, fail = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  [OK] ' + label + '  ' + g); }
  else { fail++; console.log('  [!!] ' + label + '  得到 ' + g + '  期望 ' + w); }
}

// ===== 用例 1：复现线上真实场景（平安银行 2026-03-02~2026-09-17）=====
// 特征：06-12 见局部峰值 103094.22 → 06-25 跌至 95962.41（最深 -6.92%）
//       → 之后反弹并于 07-31 创出全区间新高 105942.70 → 09-17 收于 102216.62
const real = buildCurve([
  { date: '2026-03-02', totalAsset: 100000 },
  { date: '2026-04-10', totalAsset: 101820.5 },
  { date: '2026-05-15', totalAsset: 102560.1 },
  { date: '2026-06-12', totalAsset: 103094.22 },
  { date: '2026-06-15', totalAsset: 101456.22 },
  { date: '2026-06-16', totalAsset: 100364.22 },
  { date: '2026-06-23', totalAsset: 98271.22 },
  { date: '2026-06-24', totalAsset: 96451.22 },
  { date: '2026-06-25', totalAsset: 95962.41 },
  { date: '2026-07-10', totalAsset: 101500.0 },
  { date: '2026-07-31', totalAsset: 105942.7 },
  { date: '2026-08-20', totalAsset: 104100.0 },
  { date: '2026-09-17', totalAsset: 102216.62 },
]);
const sReal = minDD(real);
console.log('用例 1 · 真实场景（最深回撤 ' + sReal + '%）');
check('旧逻辑（应复现 Bug：起始日晚于结束日）', runOld(real, sReal),
      { maxDrawdownStart: '2026-07-31', maxDrawdownEnd: '2026-06-25' });
check('新逻辑（应为 06-12 -> 06-25）', runNew(real, sReal),
      { maxDrawdownStart: '2026-06-12', maxDrawdownEnd: '2026-06-25' });
console.log('');

// ===== 用例 2：最深回撤发生在中途、之后创新高（最典型的中招场景）=====
const mid = buildCurve([
  { date: 'D1', totalAsset: 100 },
  { date: 'D2', totalAsset: 90 },
  { date: 'D3', totalAsset: 95 },
  { date: 'D4', totalAsset: 130 },
  { date: 'D5', totalAsset: 125 },
]);
const sMid = minDD(mid);
console.log('用例 2 · 回撤后创新高（最深回撤 ' + sMid + '%）');
check('旧逻辑', runOld(mid, sMid), { maxDrawdownStart: 'D4', maxDrawdownEnd: 'D2' });
check('新逻辑', runNew(mid, sMid), { maxDrawdownStart: 'D1', maxDrawdownEnd: 'D2' });
console.log('');

// ===== 用例 3：最深回撤就是全局最高点之后那次（旧逻辑恰好蒙对）=====
const tail = buildCurve([
  { date: 'D1', totalAsset: 100 },
  { date: 'D2', totalAsset: 120 },
  { date: 'D3', totalAsset: 110 },
  { date: 'D4', totalAsset: 105 },
]);
const sTail = minDD(tail);
console.log('用例 3 · 最高点在回撤之前（最深回撤 ' + sTail + '%）');
check('旧逻辑', runOld(tail, sTail), { maxDrawdownStart: 'D2', maxDrawdownEnd: 'D4' });
check('新逻辑', runNew(tail, sTail), { maxDrawdownStart: 'D2', maxDrawdownEnd: 'D4' });
console.log('');

// ===== 用例 4：全程单边上涨（无回撤，s=0，两套逻辑都不应写入）=====
const up = buildCurve([
  { date: 'D1', totalAsset: 100 },
  { date: 'D2', totalAsset: 110 },
  { date: 'D3', totalAsset: 120 },
]);
const sUp = minDD(up);
console.log('用例 4 · 无回撤（s=' + sUp + '）');
check('旧逻辑', runOld(up, sUp), { maxDrawdownStart: null, maxDrawdownEnd: null });
check('新逻辑', runNew(up, sUp), { maxDrawdownStart: null, maxDrawdownEnd: null });
console.log('');

// ===== 用例 5：空曲线 / 单点（新逻辑不得抛异常）=====
console.log('用例 5 · 边界：空曲线与单点');
try {
  check('空曲线 · 新逻辑（s=-1 极端值）', runNew([], -1), { maxDrawdownStart: null, maxDrawdownEnd: null });
  check('空曲线 · 旧逻辑（s=-1 极端值）', runOld([], -1), { maxDrawdownStart: null, maxDrawdownEnd: null });
  check('单点 · 新逻辑', runNew(buildCurve([{ date: 'D1', totalAsset: 100 }]), 0),
        { maxDrawdownStart: null, maxDrawdownEnd: null });
} catch (e) {
  fail++;
  console.log('  [!!] 抛出异常：' + e.message);
}
console.log('');

// ===== 用例 6：多段回撤，取最深那段（旧逻辑会取到别的段的峰值日）=====
const multi = buildCurve([
  { date: 'D1', totalAsset: 100 },
  { date: 'D2', totalAsset: 95 },   // 浅回撤 -5%
  { date: 'D3', totalAsset: 100 },
  { date: 'D4', totalAsset: 110 },
  { date: 'D5', totalAsset: 99 },   // 深回撤 -10%（自 D4 起）
  { date: 'D6', totalAsset: 105 },
  { date: 'D7', totalAsset: 115 },  // 创新高
]);
const sMulti = minDD(multi);
console.log('用例 6 · 多段回撤（最深回撤 ' + sMulti + '%）');
check('旧逻辑（会错取 D7）', runOld(multi, sMulti), { maxDrawdownStart: 'D7', maxDrawdownEnd: 'D5' });
check('新逻辑（应取 D4 -> D5）', runNew(multi, sMulti), { maxDrawdownStart: 'D4', maxDrawdownEnd: 'D5' });
console.log('');

console.log('==== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
process.exit(fail === 0 ? 0 : 1);
