# -*- coding: utf-8 -*-
"""
SIMTRADE V3 —— 30 分钟 K 产物校验（Phase ② 证据脚本）

校验项：
  1. 每日根数 == 8
  2. 时点集合 == {10:00,10:30,11:00,11:30,13:30,14:00,14:30,15:00}
  3. OHLC 不变量：low <= min(o,c) 且 high >= max(o,c)，全部 > 0
  4. **复权锚定**：30 分钟聚合出的当日 OHLC 应 == dev.db 前复权日K 的 OHLC
     （这是设计目标：factor(d) = 日K收盘/原始30m末日收盘 ⇒ 聚合日收盘必然精确相等）
  5. 覆盖度：Parquet 的交易日集合 与 dev.db 日K交易日集合 应完全一致
  6. 成交量/成交额：单调性、非负、amount ≈ close*volume

用法：
  python scripts/verify_30m_kline.py --n 0        # 校验全部
  python scripts/verify_30m_kline.py --n 20       # 只校验 20 只（随机）
  python scripts/verify_30m_kline.py --codes 600036,000001
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import sqlite3
import sys
import time
import traceback

import duckdb

ROOT = r"D:\AStockData"
DIR_MIN = os.path.join(ROOT, "minutes_30")
DIR_LOGS = os.path.join(ROOT, "logs")
DB = r"D:\a-share-sim-trading\prisma\dev.db"
LOG = os.path.join(DIR_LOGS, "verify_30m.txt")
_fh = open(LOG, "a", encoding="utf-8", buffering=1)


def log(*a) -> None:
    s = " ".join(str(x) for x in a)
    _fh.write(s + "\n")
    _fh.flush()
    try:
        print(s, flush=True)
    except Exception:
        pass


def nd(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (int, float)):
        return dt.datetime.fromtimestamp(v / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
    s = str(v)
    if s.isdigit():
        return dt.datetime.fromtimestamp(int(s) / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
    return s[:10]


STD = {"10:00:00", "10:30:00", "11:00:00", "11:30:00",
       "13:30:00", "14:00:00", "14:30:00", "15:00:00"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=0, help="0 = 全部")
    ap.add_argument("--codes", default="")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    files = sorted(f[:-8] for f in os.listdir(DIR_MIN) if f.endswith(".parquet"))
    if a.codes:
        want = {c.strip() for c in a.codes.split(",")}
        files = [f for f in files if f in want]
    elif a.n and a.n < len(files):
        files = random.Random(a.seed).sample(files, a.n)

    log(f"\n#### verify_30m {dt.datetime.now().isoformat()} files={len(files)} ####")
    con = duckdb.connect()
    dbc = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cur = dbc.cursor()

    ok = 0
    fail = 0
    tot_bars = tot_bytes = 0
    max_close_rel = 0.0
    max_open_rel = 0.0
    max_high_rel = 0.0
    max_low_rel = 0.0
    worst_close = worst_open = None
    coverage_short = []
    problems = []
    # 锚定误差分布：cmp_days=参与比对的天数；各档累计
    cmp_days = 0
    close_gt = {"1e-4": 0, "1e-3": 0, "1e-2": 0}
    open_gt = {"1e-4": 0, "1e-3": 0, "1e-2": 0}
    hi_gt = {"1e-4": 0, "1e-3": 0, "1e-2": 0}
    lo_gt = {"1e-4": 0, "1e-3": 0, "1e-2": 0}
    worst_samples = []
    # 按交易所分组统计（用于归因 open/high/low 偏差是否集中于北交所）
    by_ex: dict[str, dict] = {}

    def _bx(ex: str) -> dict:
        return by_ex.setdefault(ex, {"days": 0, "o1e4": 0, "h1e4": 0, "l1e4": 0,
                                     "o1e2": 0, "h1e2": 0, "l1e2": 0, "o_max": 0.0,
                                     "h_max": 0.0, "l_max": 0.0})

    t0 = time.time()
    for i, code in enumerate(files, 1):
        p = os.path.join(DIR_MIN, f"{code}.parquet").replace("\\", "/")
        try:
            # 聚合日线（用 30m 自身）
            agg = con.execute(f"""
                SELECT tradeDate,
                       first(open ORDER BY time)  AS o,
                       max(high)                  AS h,
                       min(low)                   AS l,
                       last(close ORDER BY time)  AS c,
                       sum(volume)                AS v,
                       sum(amount)                AS amt,
                       count(*)                   AS n,
                       count(DISTINCT time)       AS tn,
                       min(time)                  AS t0,
                       max(time)                  AS t1
                FROM read_parquet('{p}')
                GROUP BY tradeDate ORDER BY tradeDate
            """).fetchdf()
            nb = int(con.execute(
                f"SELECT COUNT(*) FROM read_parquet('{p}')").fetchone()[0])
            tot_bars += nb
            tot_bytes += os.path.getsize(os.path.join(DIR_MIN, f"{code}.parquet"))

            # 1) 每日 8 根 + 2) 时点
            if int(agg["n"].min()) != 8 or int(agg["n"].max()) != 8:
                problems.append(f"{code}: 每日根数 {int(agg['n'].min())}..{int(agg['n'].max())}")
            if int(agg["tn"].min()) != 8:
                problems.append(f"{code}: 每日不同时点数 min={int(agg['tn'].min())}")
            if agg["t0"].min() != "10:00:00" or agg["t1"].max() != "15:00:00":
                problems.append(f"{code}: 首末时点 {agg['t0'].min()}..{agg['t1'].max()}")

            # 3) OHLC 不变量
            bad = con.execute(f"""
                SELECT COUNT(*) FROM read_parquet('{p}')
                WHERE open<=0 OR high<=0 OR low<=0 OR close<=0
                   OR high < low OR high < open OR high < close OR low > open OR low > close
            """).fetchone()[0]
            if bad:
                problems.append(f"{code}: OHLC 不变量违反 {bad} 根")

            # 6) amount ≈ close*volume
            amt_bad = con.execute(f"""
                SELECT COUNT(*) FROM read_parquet('{p}')
                WHERE abs(amount - close*volume) > 0.02 * greatest(amount, 1)
            """).fetchone()[0]
            if amt_bad:
                problems.append(f"{code}: amount≠close*volume {amt_bad} 根")

            # 4) 与 dev.db 日K 逐日比对
            cur.execute(
                "SELECT k.tradeDate, k.open, k.high, k.low, k.close FROM klines k "
                "JOIN stocks s ON s.id=k.stockId WHERE s.code=? AND k.period='1d' "
                "AND k.adjust=s.adjust ORDER BY k.tradeDate", (code,))
            dbr = {nd(r[0]): (float(r[1]), float(r[2]), float(r[3]), float(r[4]))
                   for r in cur.fetchall()}
            if not dbr:
                cur.execute(
                    "SELECT k.tradeDate, k.open, k.high, k.low, k.close FROM klines k "
                    "JOIN stocks s ON s.id=k.stockId WHERE s.code=? AND k.period='1d' "
                    "ORDER BY k.tradeDate", (code,))
                dbr = {nd(r[0]): (float(r[1]), float(r[2]), float(r[3]), float(r[4]))
                       for r in cur.fetchall()}

            days_pq = set(agg["tradeDate"].astype(str))
            days_db = set(dbr.keys())
            # 5) 覆盖度：Parquet 应等于 dev.db（dev.db 是 V2 日期宇宙）
            if days_pq != days_db:
                miss = days_db - days_pq
                extra = days_pq - days_db
                if miss or extra:
                    coverage_short.append((code, len(days_pq), len(days_db),
                                           len(miss), len(extra)))

            for r in agg.itertuples():
                d = str(r.tradeDate)
                if d not in dbr:
                    continue
                do, dh, dl, dc = dbr[d]
                cmp_days += 1
                cur.execute("SELECT exchange FROM stocks WHERE code=?", (code,))
                _r = cur.fetchone()
                bx = _bx(_r[0] if _r else "?")
                bx["days"] += 1
                pair = (("close", r.c, dc, close_gt), ("open", r.o, do, open_gt),
                        ("high", r.h, dh, hi_gt), ("low", r.l, dl, lo_gt))
                for name, got, exp, bucket in pair:
                    rel = abs(got - exp) / max(abs(exp), 1e-9)
                    for k in bucket:
                        if rel > float(k):
                            bucket[k] += 1
                    if name == "open":
                        bx["o_max"] = max(bx["o_max"], rel)
                        bx["o1e4"] += 1 if rel > 1e-4 else 0
                        bx["o1e2"] += 1 if rel > 1e-2 else 0
                    elif name == "high":
                        bx["h_max"] = max(bx["h_max"], rel)
                        bx["h1e4"] += 1 if rel > 1e-4 else 0
                        bx["h1e2"] += 1 if rel > 1e-2 else 0
                    elif name == "low":
                        bx["l_max"] = max(bx["l_max"], rel)
                        bx["l1e4"] += 1 if rel > 1e-4 else 0
                        bx["l1e2"] += 1 if rel > 1e-2 else 0
                    if name == "close" and rel > max_close_rel:
                        max_close_rel, worst_close = rel, (code, d, got, exp)
                    if name == "open" and rel > max_open_rel:
                        max_open_rel, worst_open = rel, (code, d, got, exp)
                    if name == "high":
                        max_high_rel = max(max_high_rel, rel)
                    if name == "low":
                        max_low_rel = max(max_low_rel, rel)
                    if rel > 0.01 and len(worst_samples) < 12:
                        worst_samples.append((code, d, name, round(got, 4), round(exp, 4),
                                              f"{rel*100:.2f}%"))
            ok += 1
        except Exception as e:
            fail += 1
            problems.append(f"{code}: EXC {type(e).__name__}: {str(e)[:100]}")
        if i % 200 == 0:
            log(f"  ...{i}/{len(files)} elapsed={time.time()-t0:.0f}s")

    con.close()
    dbc.close()

    log(f"checked={ok} failed={fail} bars={tot_bars} "
        f"bytes={tot_bytes/1048576:.1f}MB avg={tot_bytes/max(tot_bars,1):.1f}B/row")
    log(f"锚定比对天数={cmp_days}（30分钟聚合日线 vs dev.db 前复权日K）")
    log(f"  相对误差 max: close={max_close_rel*100:.6f}%  open={max_open_rel*100:.6f}%  "
        f"high={max_high_rel*100:.6f}%  low={max_low_rel*100:.6f}%")
    log(f"  超 0.01% 的天数: close={close_gt['1e-4']} open={open_gt['1e-4']} "
        f"high={hi_gt['1e-4']} low={lo_gt['1e-4']}")
    log(f"  超 0.1%  的天数: close={close_gt['1e-3']} open={open_gt['1e-3']} "
        f"high={hi_gt['1e-3']} low={lo_gt['1e-3']}")
    log(f"  超 1%    的天数: close={close_gt['1e-2']} open={open_gt['1e-2']} "
        f"high={hi_gt['1e-2']} low={lo_gt['1e-2']}")
    log(f"worst close: {worst_close}")
    log(f"worst open : {worst_open}")
    log(f"误差>1% 的样本(前12): {worst_samples}")
    log("按交易所归因（天数为参与比对天数）:")
    for ex, v in sorted(by_ex.items()):
        log(f"  {ex}: days={v['days']}  open max={v['o_max']*100:.4f}% "
            f"(>0.01% {v['o1e4']}, >1% {v['o1e2']})  high max={v['h_max']*100:.4f}% "
            f"(>0.01% {v['h1e4']}, >1% {v['h1e2']})  low max={v['l_max']*100:.4f}% "
            f"(>0.01% {v['l1e4']}, >1% {v['l1e2']})")
    log(f"覆盖度不一致 {len(coverage_short)} 只; 前10 (code,pqDays,dbDays,missing,extra):")
    for x in coverage_short[:10]:
        log("   ", x)
    log(f"problems={len(problems)}")
    for x in problems[:40]:
        log("  !", x)
    log("#### verify done ####")
    return 0


if __name__ == "__main__":
    try:
        _rc = main()
    except SystemExit as _e:
        _rc = int(_e.code or 0)
    except BaseException:
        log("FATAL")
        log(traceback.format_exc())
        _rc = 1
    sys.exit(_rc)
