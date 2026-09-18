# -*- coding: utf-8 -*-
"""把线上真实接口数据注入 design-ui/preview_template.html -> design-ui/ui-preview.html"""
import json, os, io

ROOT = 'C:/Users/Administrator/WorkBuddy/2026-09-17-20-59-49'
DATA = os.path.join(ROOT, 'ui_assets', 'data')
TPL = os.path.join(ROOT, 'design-ui', 'preview_template.html')
OUT = os.path.join(ROOT, 'design-ui', 'ui-preview.html')

J = lambda n: json.load(io.open(os.path.join(DATA, n), encoding='utf-8'))

market = J('market.json')
kline = J('kline_000001.json')['data']
bt = J('backtest_detail.json')['data']

st = market['stats']

# ---- 榜单：[code, name, board, price, changePercent, amount, lastDate] ----
def rank_rows(lst):
    out = []
    for r in lst:
        out.append([
            r['code'], r['name'], r['board'],
            round(float(r['lastPrice']), 2),
            round(float(r.get('changePercent') or 0), 2),
            float(r.get('amount') or 0),
            r.get('lastDate') or ''
        ])
    return out

ranks = {
    'active':  rank_rows(market['active']),
    'gainers': rank_rows(market['gainers']),
    'losers':  rank_rows(market['losers']),
}

# ---- K 线：[date, open, high, low, close, volume] ----
k = [[b['date'], b['open'], b['high'], b['low'], b['close'], b['volume']] for b in kline]

# ---- 权益曲线：[date, totalAsset, close]（bench 用 close 归一化买入持有） ----
eq = [[p['date'], round(float(p['totalAsset']), 2), float(p['close'])]
      for p in bt['equityCurve']]

# ---- 回撤曲线：[date, drawdownPercent] ----
dd = [[p['date'], float(p['drawdownPercent'])] for p in bt['drawdownCurve']]

# ---- 交易回合：[seq, 买入日, 买入价, 卖出日, 卖出价, 数量, 持有, 盈亏, 收益率] ----
rounds = []
for r in bt['roundTrips']:
    rounds.append([
        r['seq'], r['entryDate'], round(float(r['entryPrice']), 2),
        r['exitDate'], round(float(r['exitPrice']), 2),
        int(r['quantity']), int(r['holdDays']),
        round(float(r['pnl']), 2), round(float(r['pnlPercent']), 2),
    ])

# ---- 派生指标（用于校验 & 覆盖模板硬编码） ----
m = bt['metrics']
wins = [r for r in bt['roundTrips'] if r['win']]
loss = [r for r in bt['roundTrips'] if not r['win']]
avg_win = sum(r['pnl'] for r in wins) / len(wins) if wins else 0
avg_los = sum(r['pnl'] for r in loss) / len(loss) if loss else 0
pl_ratio = abs(avg_win / avg_los) if avg_los else 0
avg_hold = sum(r['holdDays'] for r in bt['roundTrips']) / len(bt['roundTrips'])
total_fee = sum(r['totalFee'] for r in bt['roundTrips'])

D = {
    'stats': {
        'stockCount': st['stockCount'],
        'klineCount': st['klineCount'],
        'startDate': st['startDate'],
        'endDate': st['endDate'],
    },
    'ranks': ranks,
    'kline': k,
    'equity': eq,
    'dd': dd,
    'rounds': rounds,
    'derived': {
        'plRatio': round(pl_ratio, 2),
        'avgHold': round(avg_hold, 1),
        'totalFee': round(total_fee, 2),
        'feePct': round(total_fee / m['initialAsset'] * 100, 2),
        'winCount': len(wins),
        'lossCount': len(loss),
        'tradeCount': len(bt['roundTrips']),
    },
}

js = json.dumps(D, ensure_ascii=False, separators=(',', ':'))

html = io.open(TPL, encoding='utf-8').read()
assert '/*@@DATA@@*/' in html
html = html.replace('/*@@DATA@@*/', js)

# ---- 用真实派生值覆盖模板中的示例数字 ----
repl = [
    ('>4.41<', '>%s<' % D['derived']['plRatio']),
    ('>平均持有 15.5 天<', '>平均持有 %s 天<' % D['derived']['avgHold']),
    ('>累计费用 ¥664.38 · 占初始资金 0.66%<',
     '>累计费用 ¥%s · 占初始资金 %s%%<' % (D['derived']['totalFee'], D['derived']['feePct'])),
    ('>1 胜 / 3 负 · 4 次交易<',
     '>%d 胜 / %d 负 · %d 次交易<' % (D['derived']['winCount'], D['derived']['lossCount'], D['derived']['tradeCount'])),
    ('共 <b class="num">237.4</b> 万根',
     '共 <b class="num">%s</b> 万根' % round(st['klineCount'] / 1e4, 1)),
]
hit = []
for a, b in repl:
    if a in html:
        html = html.replace(a, b)
        hit.append(a[:26])

io.open(OUT, 'w', encoding='utf-8').write(html)

print('[OK] ->', OUT, os.path.getsize(OUT), 'bytes')
print('[replaced]', hit)
print('[derived]', json.dumps(D['derived'], ensure_ascii=False))
print('[metrics] totalReturn=%s maxDD=%s ddStart=%s ddEnd=%s shapre=%s winRate=%s' % (
    m['totalReturn'], m['maxDrawdown'], m['maxDrawdownStart'], m['maxDrawdownEnd'],
    m['sharpeRatio'], round(m['winCount'] / m['tradeCount'] * 100)))
print('[dd range] min=%s @ %s' % (min(p[1] for p in dd), [p[0] for p in dd if p[1] == min(q[1] for q in dd)][0]))
print('[kline] %d bars %s -> %s   close %s -> %s' % (len(k), k[0][0], k[-1][0], k[0][4], k[-1][4]))
print('[equity] %d pts  %s -> %s' % (len(eq), eq[0][1], eq[-1][1]))
print('[ranks] active=%d gainers=%d losers=%d' % (len(ranks['active']), len(ranks['gainers']), len(ranks['losers'])))
print('[rounds]', rounds)
