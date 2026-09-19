#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A股指数日K增量更新

与 market-daily-update.py（个股）**完全独立**的自包含脚本：
  · 自带交易日闸门（同样用上证指数当日 K 线探测，零维护）
  · 只读上游、只写 market_indices / index_klines 两张表，不碰 stocks / klines
  · 幂等：K 线 id 为 ik_<code>_<date>，INSERT OR IGNORE，重复执行不产生脏数据
  · **windowStart 不会被推进**：每次由 MIN(tradeDate) 重算，语义始终是「自发布日」

为什么不做成 market-daily-update.py 的一个参数：
  1. 那个文件名带连字符，无法被 import；抽公共模块要动生产脚本，风险高于收益；
  2. 故障隔离 —— 指数脚本写坏了不影响个股日更，反之亦然；
  3. 单独跑 / 单独 debug 更方便（--dry-run / --codes / --force）。

用法：
  python3 index-daily-update.py                 # 常规日更
  python3 index-daily-update.py --dry-run        # 只抓不写
  python3 index-daily-update.py --force          # 跳过交易日闸门
  python3 index-daily-update.py --codes sh000001 # 只更新指定指数
"""
import argparse
import datetime
import json
import random
import re
import sqlite3
import sys
import time
import urllib.request

DB = "/home/ubuntu/app/prisma/dev.db"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

SINA_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
            "CN_MarketData.getKLineData?symbol={sym}&scale=240&ma=no&datalen={n}")
TENCENT_URL = ("http://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get"
               "?param={sym},day,,,{n},qfq")

# 交易日探针用的标的（与个股脚本一致）
INDEX_SYM = "sh000001"


# ----------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------
def http(url, referer, timeout=25, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.getcode(), r.read().decode("utf-8", "replace")
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1) + random.random())
    raise RuntimeError(str(last)[:120])


def ms_of(date_str):
    """YYYY-MM-DD → 毫秒时间戳（UTC 零点），与 klines / index_klines 存储口径一致"""
    d = date_str[:10]
    return int(datetime.datetime(int(d[:4]), int(d[5:7]), int(d[8:10]),
                                 tzinfo=datetime.timezone.utc).timestamp() * 1000)


def date_of(ms):
    return datetime.datetime.utcfromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def dash(compact):
    """YYYYMMDD → YYYY-MM-DD"""
    return "%s-%s-%s" % (compact[:4], compact[4:6], compact[6:8])


# ----------------------------------------------------------------------
# 数据源
# ----------------------------------------------------------------------
def fetch_sina(sym, n):
    st, body = http(SINA_URL.format(sym=sym, n=n), "https://finance.sina.com.cn/")
    if st != 200:
        raise RuntimeError("sina_http_%s" % st)
    if not body or body.strip() in ("null", "[]"):
        return []
    try:
        arr = json.loads(body)
    except Exception:
        # 新浪返回的 JSON key 不带引号，补上再解析
        arr = json.loads(re.sub(r'([{,])\s*([A-Za-z_]\w*)\s*:', r'\1"\2":', body))
    out = []
    for r in arr or []:
        try:
            out.append({
                "date": str(r["day"])[:10],
                "open": float(r["open"]), "close": float(r["close"]),
                "high": float(r["high"]), "low": float(r["low"]),
                "volume": float(r["volume"]),
            })
        except Exception:
            continue
    return out


def fetch_tencent(sym, n):
    st, body = http(TENCENT_URL.format(sym=sym, n=n), "https://gu.qq.com/")
    if st != 200:
        raise RuntimeError("tencent_http_%s" % st)
    j = json.loads(body)
    # 注意：n 过大时腾讯返回 {"code":0,"msg":"param error","data":[]}，data 是**数组**
    if not isinstance(j, dict):
        raise RuntimeError("tencent_bad_json")
    node = (j.get("data") or {})
    node = node.get(sym) if isinstance(node, dict) else None
    arr = (node or {}).get("day") or (node or {}).get("qfqday") or []
    out = []
    for r in arr:
        try:
            out.append({
                "date": str(r[0])[:10],
                "open": float(r[1]), "close": float(r[2]),
                "high": float(r[3]), "low": float(r[4]),
                "volume": float(r[5]),
            })
        except Exception:
            continue
    return out


# ----------------------------------------------------------------------
# 交易日闸门（与 market-daily-update.py 同款策略）
#   节假日（春节/国庆/清明…落在工作日里）不跑，靠上证指数当日K线判定：
#   开市日收盘后必然有当日K线；休市日最新K线仍是上一个交易日。
#   零维护 —— 不需要交易日历，也不用每年更新放假安排。
# ----------------------------------------------------------------------
def latest_trading_day():
    t_err = s_err = None
    try:
        bars = fetch_tencent(INDEX_SYM, 6)
        if bars:
            return max(b["date"] for b in bars), "tencent", None
        t_err = "tencent_empty"
    except Exception as e:
        t_err = "tencent:%s" % str(e)[:60]
    try:
        bars = fetch_sina(INDEX_SYM, 6)
        if bars:
            return max(b["date"] for b in bars), "sina", None
        s_err = "sina_empty"
    except Exception as e:
        s_err = "sina:%s" % str(e)[:60]
    return None, None, "%s | %s" % (t_err, s_err)


def trading_day_gate(now=None):
    now = now or datetime.datetime.now()
    today = now.strftime("%Y-%m-%d")
    if now.weekday() >= 5:
        return False, "今日 %s 为周末，A股休市" % today
    ltd, src, err = latest_trading_day()
    if ltd is None:
        return True, "交易日探针失败（%s）→ 不阻断，继续执行" % err
    if ltd == today:
        return True, "今日 %s 为交易日（源：%s，当日数据已就绪）" % (today, src)
    return False, "今日 %s 非交易日（%s 最新交易日仍为 %s，A股休市）" % (today, src, ltd)


# ----------------------------------------------------------------------
# 入库
# ----------------------------------------------------------------------
def load_indices(con, codes=None):
    sql = ('SELECT id, code, name, barCount, windowEnd FROM market_indices')
    args = []
    if codes:
        sql += " WHERE code IN (%s)" % ",".join("?" * len(codes))
        args = codes
    sql += " ORDER BY code"
    return con.execute(sql, args).fetchall()


def update_one(con, idx_id, code, n, dry_run):
    """返回 dict：新增根数 / 最新日 / 是否出错"""
    row = con.execute('SELECT windowEnd FROM market_indices WHERE id=?', (idx_id,)).fetchone()
    last_ms = row[0] if row and row[0] else 0

    err = None
    bars = []
    for fn, label in ((lambda: fetch_sina(code, n), "sina"),
                      (lambda: fetch_tencent(code, min(n, 500)), "tencent")):
        try:
            bars = fn()
            if bars:
                break
        except Exception as e:
            err = "%s:%s" % (label, str(e)[:70])
    if not bars:
        return {"code": code, "new": 0, "err": err or "empty", "last": date_of(last_ms) if last_ms else None}

    # 只取比库内最新还要新的；id 确定性生成，INSERT OR IGNORE 保证幂等
    fresh = [b for b in bars if ms_of(b["date"]) > last_ms]
    if fresh and not dry_run:
        now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        with con:  # 单个指数的全部写入放一个事务
            con.executemany(
                'INSERT OR IGNORE INTO index_klines '
                '("id","indexId","tradeDate","open","high","low","close","volume","createdAt") '
                'VALUES (?,?,?,?,?,?,?,?,?)',
                [("ik_%s_%s" % (code, b["date"].replace("-", "")), idx_id, ms_of(b["date"]),
                  b["open"], b["high"], b["low"], b["close"], int(b["volume"]), now)
                 for b in fresh])
            # 冗余字段全部由表内数据重算 —— 不会漂移，且 windowStart 语义恒为「自发布日」
            con.execute(
                'UPDATE market_indices SET '
                '  "barCount" = (SELECT COUNT(*) FROM index_klines WHERE "indexId"=?), '
                '  "windowStart" = (SELECT MIN("tradeDate") FROM index_klines WHERE "indexId"=?), '
                '  "windowEnd" = (SELECT MAX("tradeDate") FROM index_klines WHERE "indexId"=?), '
                '  "updatedAt" = ? WHERE "id" = ?',
                (idx_id, idx_id, idx_id, now, idx_id))

    return {"code": code, "new": len(fresh), "err": None,
            "last": dash(max(b["date"] for b in bars).replace("-", ""))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只抓取与判定，不写库")
    ap.add_argument("--force", action="store_true", help="跳过交易日闸门（手动补数据用）")
    ap.add_argument("--n", type=int, default=60, help="每个指数请求的K线根数（默认 60，足够覆盖长假）")
    ap.add_argument("--codes", default="", help="逗号分隔的指数代码，如 sh000001,sz399001")
    ap.add_argument("--db", default=DB)
    args = ap.parse_args()

    t0 = time.time()
    print("=" * 70)
    print("A股指数日K增量更新  %s" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 70)

    if args.force:
        print("[交易日闸门] 已通过 --force 跳过")
    else:
        should_run, note = trading_day_gate()
        print("[交易日闸门] %s" % note)
        if not should_run:
            print()
            print("本次不执行。如需强制运行，加 --force")
            return
    print()

    con = sqlite3.connect(args.db, timeout=120)
    con.execute("PRAGMA busy_timeout=120000")
    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    indices = load_indices(con, codes or None)
    if not indices:
        print("market_indices 为空，无需更新")
        con.close()
        return

    print("指数数: %d   每指数请求: %d 根   写库: %s"
          % (len(indices), args.n, "否（dry-run）" if args.dry_run else "是"))
    print()

    results = []
    for idx_id, code, name, bar_count, window_end in indices:
        r = update_one(con, idx_id, code, args.n, args.dry_run)
        r["name"] = name
        r["before"] = bar_count
        r["before_end"] = date_of(window_end) if window_end else None
        results.append(r)

    ok = [r for r in results if not r["err"]]
    failed = [r for r in results if r["err"]]
    changed = [r for r in ok if r["new"]]

    print("---- 结果 ----")
    for r in sorted(results, key=lambda x: x["code"]):
        if r["err"]:
            print("  %-10s %-8s  ✗ %s" % (r["code"], r["name"], r["err"]))
        else:
            flag = "新增 %d 根" % r["new"] if r["new"] else "已是最新"
            print("  %-10s %-8s  %s → %s   %s"
                  % (r["code"], r["name"], r["before_end"] or "-", r["last"], flag))

    print()
    print("成功 %d / %d   失败 %d   有新增 %d" % (len(ok), len(results), len(failed), len(changed)))
    print("耗时 %.1fs" % (time.time() - t0))
    if args.dry_run:
        print("（dry-run，未写库）")
    con.close()


if __name__ == "__main__":
    main()
