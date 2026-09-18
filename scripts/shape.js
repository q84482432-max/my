const BASE = 'http://111.229.225.7/app';
const H = { 'content-type': 'application/json' };
(async () => {
  let r = await fetch(BASE + '/api/simtrade', { method: 'POST', headers: H, body: '{}' });
  let j = await r.json();
  const id = (j.session || j.data?.session)?.id;
  r = await fetch(BASE + '/api/simtrade/' + id);
  j = await r.json();
  console.log('TOP KEYS:', Object.keys(j).join(', '));
  const d = j.data || j;
  console.log('DATA KEYS:', Object.keys(d).join(', '));
  console.log('SESSION:', JSON.stringify(d.session, null, 1).slice(0, 700));
  console.log('ACCOUNT:', JSON.stringify(d.account, null, 1).slice(0, 600));
  const kl = d.klines || d.bars || d.kline || d.candles;
  console.log('KLINE KEY:', kl ? (d.klines ? 'klines' : d.bars ? 'bars' : d.kline ? 'kline' : 'candles') : 'NONE', 'len=', kl ? kl.length : 0);
  if (kl && kl.length) console.log('LAST BAR:', JSON.stringify(kl[kl.length - 1]));
  await fetch(BASE + '/api/simtrade/' + id, { method: 'DELETE' });
})().catch(e => console.error('ERR', e.message));
