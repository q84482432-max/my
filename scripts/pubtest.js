// 通过公网走 /app 前缀，完整跑一局模拟炒股
// 契约来源：app/api/simtrade/**/route.ts + services/simtradeService.ts
//   POST /api/simtrade            -> 201 { success, message, session }
//   GET  /api/simtrade/:id        -> 200 { success, data: snapshot }
//   POST /api/simtrade/:id/action -> body { action: BUY|SELL|HOLD, percent? }
//   POST /api/simtrade/:id/next   -> 需 confirmedToday=true
//   POST /api/simtrade/:id/reveal -> { success, message, reveal:{code,name,...} } 仅 FINISHED 后
//   DELETE /api/simtrade/:id      -> { success, message }
const BASE = process.env.PUB_BASE || 'http://111.229.225.7/app';
const H = { 'content-type': 'application/json' };

async function j(p, o) {
  const r = await fetch(BASE + p, o);
  const t = await r.text();
  try { return JSON.parse(t); }
  catch (e) { return { _raw: t.slice(0, 300), _status: r.status, _ctype: r.headers.get('content-type') }; }
}
const num = (v) => (typeof v === 'number' ? v : Number(v));

(async () => {
  const R = [];
  const ok = (n, c, extra = '') => { R.push([!!c, n, extra]); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  | ' + extra : ''}`); };

  // 1. 创建
  let r = await j('/api/simtrade', { method: 'POST', headers: H, body: JSON.stringify({}) });
  const s0 = r?.session || r?.data?.session;
  const id = s0?.id;
  ok('创建会话', !!id, `id=${id} | ${r?.message || ''}`);
  if (!id) { console.log('RAW:', JSON.stringify(r).slice(0, 400)); return; }

  // 2. 快照 + 防泄漏
  r = await j('/api/simtrade/' + id);
  const d = r.data;
  const s = d.session;
  ok('快照可读', !!d && !!s, `status=${s.status} day=${s.dayIndex}/${s.totalDays} ${s.startDate}~${s.endDate}`);
  ok('账户字段完整', ['cash', 'totalAsset', 'totalProfit', 'totalProfitRate'].every((k) => num(d.summary[k]) === num(d.summary[k])),
    `cash=${d.summary.cash} total=${d.summary.totalAsset} pnl=${d.summary.totalProfit} rate=${d.summary.totalProfitRate}`);
  ok('初始资金 100000', num(s.initialCash) === 100000, `initialCash=${s.initialCash}`);
  ok('进度 20~23 日', s.totalDays >= 20 && s.totalDays <= 23, `totalDays=${s.totalDays}`);

  // 防泄漏：快照不得含股票身份
  const blob = JSON.stringify(d);
  ok('快照不含 hiddenStockCode 字段', !blob.includes('hiddenStockCode'));
  ok('快照不含 stockCode/stockName', !/"stock(Code|Name)"/.test(blob) && !blob.includes('hiddenStock'));
  ok('快照无 6 位股票代码', !blob.match(/"[0368]\d{5}"/), (blob.match(/"[0368]\d{5}"/g) || []).slice(0, 5).join(','));

  // 3. 当日 K 线只揭示 open
  const hist = d.history || [];
  ok('历史 K 线非空', hist.length > 0, `len=${hist.length}`);
  const todayBar = hist.find((b) => b.date === s.currentDate);
  if (todayBar) {
    ok('当日 K 线 high/low/close 已抹除',
      num(todayBar.high) === num(todayBar.open) && num(todayBar.low) === num(todayBar.open) && num(todayBar.close) === num(todayBar.open),
      `open=${todayBar.open} high=${todayBar.high} low=${todayBar.low} close=${todayBar.close}`);
  }
  ok('历史 K 线无未来日期', hist.every((b) => b.date <= s.currentDate), hist.filter((b) => b.date > s.currentDate).slice(0, 3).map((b) => b.date).join(','));
  ok('当日开盘价可读', num(d.openPrice) > 0, `openPrice=${d.openPrice}`);
  ok('曲线无未来日期', (d.curve || []).every((c) => c.date <= s.currentDate), `curveLen=${(d.curve || []).length}`);

  // 4. 观望推进一天，验证 HOLD 路径
  let rr = await j('/api/simtrade/' + id + '/action', { method: 'POST', headers: H, body: JSON.stringify({ action: 'HOLD' }) });
  ok('HOLD 操作被接受', rr.success === true, rr.message || '');
  r = await j('/api/simtrade/' + id);
  ok('HOLD 后 confirmedToday=true', r.data.session.confirmedToday === true);
  rr = await j('/api/simtrade/' + id + '/next', { method: 'POST', headers: H, body: JSON.stringify({}) });
  ok('HOLD 后可推进', rr.success === true, rr.message || '');
  const dayAfterHold = (await j('/api/simtrade/' + id)).data.session.dayIndex;

  // 5. 买入 30%
  let dd = (await j('/api/simtrade/' + id)).data;
  const cashBefore = num(dd.summary.cash);
  rr = await j('/api/simtrade/' + id + '/action', { method: 'POST', headers: H, body: JSON.stringify({ action: 'BUY', percent: 30 }) });
  ok('买入 30% 成功', rr.success === true, rr.message || JSON.stringify(rr).slice(0, 160));
  dd = (await j('/api/simtrade/' + id)).data;
  ok('需确认后推进（confirmedToday=true 表示已确认成交）', dd.session.confirmedToday === true);
  ok('持仓已建立', num(dd.position?.quantity) > 0, `qty=${dd.position?.quantity} avgCost=${dd.position?.avgCost}`);
  ok('T+1：availableQty=0 且 todayQty=quantity',
    num(dd.position?.availableQty) === 0 && num(dd.position?.todayQty) === num(dd.position?.quantity),
    `available=${dd.position?.availableQty} today=${dd.position?.todayQty} qty=${dd.position?.quantity}`);
  ok('现金已扣减且非负', num(dd.summary.cash) >= 0 && num(dd.summary.cash) < cashBefore, `cash ${cashBefore} → ${dd.summary.cash}`);

  // 6. 同日重复操作应被拒
  rr = await j('/api/simtrade/' + id + '/action', { method: 'POST', headers: H, body: JSON.stringify({ action: 'SELL', percent: 50 }) });
  ok('同日重复操作被拒', rr.success === false, (rr.message || '').slice(0, 120));

  // 7. 非法 percent 应被拒
  rr = await j('/api/simtrade/' + id + '/action', { method: 'POST', headers: H, body: JSON.stringify({ action: 'SELL', percent: 200 }) });
  ok('超范围 percent 被拒', rr.success === false, (rr.message || '').slice(0, 120));

  // 8. 推进，验证 T+1 解冻
  rr = await j('/api/simtrade/' + id + '/next', { method: 'POST', headers: H, body: JSON.stringify({}) });
  ok('确认并推进到下一交易日', rr.success === true, rr.message || '');
  dd = (await j('/api/simtrade/' + id)).data;
  ok('推进后 dayIndex+1', dd.session.dayIndex === dayAfterHold + 1, `day=${dd.session.dayIndex}`);
  ok('T+1 解冻：次日 availableQty = quantity',
    num(dd.position?.availableQty) === num(dd.position?.quantity) && num(dd.position?.availableQty) > 0,
    `available=${dd.position?.availableQty} qty=${dd.position?.quantity}`);
  ok('收盘结果已回填', dd.lastAction !== null && dd.lastAction !== undefined, `lastAction=${JSON.stringify(dd.lastAction).slice(0, 140)}`);

  // 9. 卖出 50% 验证卖出路径
  const cashBeforeSell = num(dd.summary.cash);
  const qtyBeforeSell = num(dd.position?.quantity);
  rr = await j('/api/simtrade/' + id + '/action', { method: 'POST', headers: H, body: JSON.stringify({ action: 'SELL', percent: 50 }) });
  ok('卖出 50% 成功', rr.success === true, rr.message || '');
  dd = (await j('/api/simtrade/' + id)).data;
  ok('卖出后现金增加', num(dd.summary.cash) > cashBeforeSell, `cash ${cashBeforeSell} → ${dd.summary.cash}`);
  ok('卖出后持仓减少', num(dd.position?.quantity) < qtyBeforeSell, `qty ${qtyBeforeSell} → ${dd.position?.quantity}`);
  ok('卖出后现金不为负', num(dd.summary.cash) >= 0);

  // 10. 一路跑到结束
  let guard = 0;
  for (let i = 0; i < 45; i++) {
    r = await j('/api/simtrade/' + id);
    if (r.data?.session?.status === 'FINISHED') break;
    if (r.data?.session?.confirmedToday === false) {
      await j('/api/simtrade/' + id + '/action', { method: 'POST', headers: H, body: JSON.stringify({ action: 'HOLD' }) });
    }
    await j('/api/simtrade/' + id + '/next', { method: 'POST', headers: H, body: JSON.stringify({}) });
    guard++;
  }
  dd = (await j('/api/simtrade/' + id)).data;
  ok('会话结束状态 FINISHED', dd.session.status === 'FINISHED', `day=${dd.session.dayIndex}/${dd.session.totalDays} loops=${guard}`);
  const st = dd.settlement;
  ok('最终结算存在', !!st);
  if (st) {
    ok('结算字段完整', ['initialCash', 'finalAsset', 'totalProfit', 'totalReturn', 'tradeCount', 'maxPositionRatio', 'maxDrawdown', 'buyHoldReturn'].every((k) => st[k] !== undefined),
      `final=${st.finalAsset} ret=${st.totalReturn}% trades=${st.tradeCount} maxPos=${st.maxPositionRatio}% mdd=${st.maxDrawdown}% buyHold=${st.buyHoldReturn}% beat=${st.beatBuyHold}`);
    ok('有交易次数记录', num(st.tradeCount) > 0, `tradeCount=${st.tradeCount}`);
  }
  ok('结束后快照仍未泄露身份', !JSON.stringify(dd).match(/"[0368]\d{5}"/), (JSON.stringify(dd).match(/"[0368]\d{5}"/g) || []).slice(0, 3).join(','));

  // 11. 揭晓
  r = await j('/api/simtrade/' + id + '/reveal', { method: 'POST', headers: H, body: JSON.stringify({}) });
  const rv = r.reveal || {};
  ok('揭晓返回股票代码/名称', !!rv.code && !!rv.name, `code=${rv.code} name=${rv.name} board=${rv.board}`);

  // 12. 揭晓后快照应含真实标的（revealed=true）
  dd = (await j('/api/simtrade/' + id)).data;
  ok('揭晓后会话 revealed=true', dd.session.revealed === true, `revealed=${dd.session.revealed}`);

  // 13. 清理
  r = await j('/api/simtrade/' + id, { method: 'DELETE' });
  ok('删除会话', r.success === true, r.message || '');

  const pass = R.filter((x) => x[0]).length;
  console.log(`\n===== 公网端到端：${pass}/${R.length} 通过 =====`);
  if (pass < R.length) { console.log('失败项：'); R.filter((x) => !x[0]).forEach((x) => console.log('  - ' + x[1] + ' | ' + x[2])); }
})().catch((e) => console.error('ERR', e.message, e.stack?.split('\n')[1] || ''));
