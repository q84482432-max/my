#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A股 30 分钟K线每日落盘（Sina 源）
======================================================================
用途：为 a-share-sim-trading 每日抓取全市场 30 分钟 K 线，按「日K(1d) 前复权基准」
对齐后，落盘到 /home/ubuntu/minutes30_data/ 供下游本地任务消费。

数据源
  新浪  money.finance.sina.com.cn ... CN_MarketData.getKLineData?symbol={exch}{code}&scale=30&ma=no&datalen=200
  —— 与日K脚本的备源同端点（仅 scale 不同：日K 用 240，本脚本用 30）。
  新浪返回「未加引号的 JSON key」，需先以正则修复再 json.loads。
  新浪以「结束时间」标注每根 bar；一个完整 A 股交易日恰好 8 根：
    10:00, 10:30, 11:00, 11:30, 13:30, 14:00, 14:30, 15:00

复权基准对齐（关键，必须与日K表一致）
  新浪 30 分钟价为 RAW/不复权；而 klines 表存的是 qfq（前复权）日收盘价。
  因此对每只股票、目标交易日 d：
    factor = klines.close(d, period='1d', adjust=<该票 stocks.adjust>) / raw_30m_最后一根(15:00)_close
  将该日 8 根 bar 的 open/high/low/close 同乘 factor、round 4 位小数，
  再断言 high=max(o,h,l,c)、low=min(o,h,l,c)。
  stocks.adjust='none' 的票，公式给出 factor≈1.0（日RAW收盘≈30m最后一根RAW收盘），自动一致。
  这样 30 分钟序列与日K序列「同一基准」，15:00 那根 close 与日K收盘完全相等，
  两段序列相接处无跳变。

输出（固定接口契约，下游依赖，勿改）
  /home/ubuntu/minutes30_data/                         目录（自动建）
  /home/ubuntu/minutes30_data/<YYYY-MM-DD>.json.gz     = gzip(UTF-8 JSON)
    {"tradeDate","generatedAt","barsPerStock":8,"count":N,"rows":[
        {"code","exch","time","open","high","low","close","volume"}, ... 每只票恰好 8 行，time 升序]}
  /home/ubuntu/minutes30_data/manifest.json            每次按磁盘实际重建，避免漂移
    {"generatedAt","dates":[...],"files":{"<d>":{"count","bytes"}},"dbMaxDaily":"<d>"}

CLI
  --force          跳过交易日闸门
  --date YYYY-MM-DD 回填指定日期（默认今天）
  --codes a,b      只处理指定代码（逗号分隔）
  --sample N       只处理前 N 只（调试）
  --workers N      并发数（默认 12）
  --dry-run        只拉取与判定，不落盘
  --db PATH        数据库路径（默认 /home/ubuntu/app/prisma/dev.db）

退出码恒为 0：单票失败仅记录日志（与现有脚本约定一致）。
======================================================================
"""

import argparse
import datetime
import gzip
import json
import os
import random
import re
import sqlite3
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

DB = "/home/ubuntu/app/prisma/dev.db"
OUTDIR = "/home/ubuntu/minutes30_data"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

SINA30_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
              "CN_MarketData.getKLineData?symbol={sym}&scale=30&ma=no&datalen={n}")

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
U64 = "0123456789abcdefghijklmnopqrstuvwxyz"

INDEX_SYM = "sh000001"

# 一个完整 A 股交易日恰好 8 根 30 分钟 bar，按结束时间升序
EXPECTED_TIMES = ["10:00:00", "10:30:00", "11:00:00", "11:30:00",
                  "13:30:00", "14:00:00", "14:30:00", "15:00:00"]
BARS_PER_STOCK = 8


# ----------------------------------------------------------------------
# 基础工具（与 market-daily-update.py 保持一致，不另起 HTTP 栈）
# ----------------------------------------------------------------------
def http(url, referer="https://finance.sina.com.cn/", timeout=20, retries=2):
    last = None
    for i in range(retries + 1):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
        try:
            with OPENER.open(req, timeout=timeout) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, str(e)[:120])
            if i < retries:
                time.sleep(0.6 * (i + 1))
    return -1, "ERR " + str(last)


def ms_of(datestr):
    dt = datetime.datetime.strptime(datestr[:10], "%Y-%m-%d")
    return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def date_of(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")


def prefix_of(exch):
    return {"SH": "sh", "SZ": "sz", "BJ": "bj"}.get(exch, "sh")


def norm_time(s):
    s = (s or "").strip()
    parts = s.split(":")
    if len(parts) == 2:
        return s + ":00"
    return s[:8]


# ----------------------------------------------------------------------
# 交易日闸门（与日K脚本共用判定逻辑）
# ----------------------------------------------------------------------
def fetch_sina_index_bars(sym, n):
    url = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
           "CN_MarketData.getKLineData?symbol={sym}&scale=240&ma=no&datalen={n}").format(sym=sym, n=n)
    st, body = http(url, referer="https://finance.sina.com.cn/")
    if st != 200 or not body or body.strip() in ("null", "[]"):
        return []
    try:
        arr = json.loads(body)
    except Exception:
        arr = json.loads(re.sub(r'([{,])\s*([A-Za-z_]\w*)\s*:', r'\1"\2":', body))
    out = []
    for r in arr or []:
        try:
            out.append({"date": str(r["day"])[:10]})
        except Exception:
            continue
    return out


def latest_trading_day():
    """取上证指数最近一根日K的日期。返回 (date_str|None, source, err)。"""
    try:
        bars = fetch_sina_index_bars(INDEX_SYM, 6)
        if bars:
            return max(b["date"] for b in bars), "sina", None
    except Exception as e:
        return None, None, "sina:%s" % str(e)[:60]
    return None, None, "sina_empty"


def trading_day_gate(now=None):
    """判断今天是否该执行。返回 (should_run, note)。"""
    now = now or datetime.datetime.now()
    today = now.strftime("%Y-%m-%d")
    if now.weekday() >= 5:
        return False, "今日 %s 为周末，A股休市" % today
    ltd, src, err = latest_trading_day()
    if ltd is None:
        return True, "交易日探针失败（%s）→ 不阻断，继续执行" % err
    if ltd == today:
        return True, "今日 %s 为交易日（源：%s，当日数据已就绪）" % (today, src)
    return False, ("今日 %s 非交易日（%s 最新交易日仍为 %s，A股休市）" % (today, src, ltd))


# ----------------------------------------------------------------------
# 抓取新浪 30 分钟 K
# ----------------------------------------------------------------------
def fetch_sina_30m(sym, n):
    url = SINA30_URL.format(sym=sym, n=n)
    st, body = http(url, referer="https://finance.sina.com.cn/")
    if st != 200:
        raise RuntimeError("sina_http_%s(%s)" % (st, body[:80]))
    if not body or body.strip() in ("null", "[]"):
        return []
    try:
        arr = json.loads(body)
    except Exception:
        arr = json.loads(re.sub(r'([{,])\s*(\w+)\s*:', r'\1"\2":', body))
    out = []
    for r in arr or []:
        try:
            day = str(r["day"])
            dpart, _, tpart = day.partition(" ")
            out.append({
                "date": dpart[:10],
                "time": norm_time(tpart),
                "open": float(r["open"]),
                "close": float(r["close"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "volume": float(r["volume"]),
            })
        except Exception:
            continue
    return out


# ----------------------------------------------------------------------
# 全市场股票（来自 stocks 表）
# ----------------------------------------------------------------------
def load_universe(con, codes=None):
    cur = con.cursor()
    sql = ("SELECT s.id, s.code, s.name, s.exchange, s.board, s.adjust "
           "FROM stocks s")
    args = []
    if codes:
        sql += " WHERE s.code IN (%s)" % ",".join("?" * len(codes))
        args += list(codes)
    sql += " ORDER BY s.code"
    cur.execute(sql, args)
    return cur.fetchall()


def load_daily_close_map(con, target_ms):
    """建 {(stockId, adjust): close} 映射，仅取目标交易日的 1d 行。"""
    cur = con.cursor()
    cur.execute("SELECT stockId, adjust, close FROM klines "
                "WHERE period='1d' AND tradeDate=?", (target_ms,))
    m = {}
    for sid, adj, close in cur.fetchall():
        m[(sid, adj)] = close
    return m


# ----------------------------------------------------------------------
# 逐票处理：拉 30m → 对齐复权基准 → 输出 8 行
# ----------------------------------------------------------------------
def process_one(row, args, daily_map):
    (sid, code, name, exch, board, adjust) = row
    exch_l = prefix_of(exch)
    sym = exch_l + code
    adj = adjust or "qfq"
    res = {"code": code, "sym": sym, "exch": exch_l, "err": None}

    # 1) 该票目标交易日的日K收盘（用作复权基准）
    daily_close = daily_map.get((sid, adj))
    if daily_close is None:
        res["err"] = "no_daily_bar"
        return res, None
    daily_close = float(daily_close)

    # 2) 抓 30 分钟 K，筛出目标交易日
    try:
        bars = fetch_sina_30m(sym, args.n)
    except Exception as e:
        res["err"] = "fetch:%s" % str(e)[:70]
        return res, None

    by_time = {}
    for b in bars:
        if b["date"] == args.date:
            by_time[b["time"]] = b
    if not by_time:
        res["err"] = "no_30m_bars"
        return res, None

    # 3) 必须为完整的 8 个预期时间点，否则记为违规并跳过（保证每只票恰好 8 行）
    missing = [t for t in EXPECTED_TIMES if t not in by_time]
    if missing:
        res["err"] = "incomplete_30m(%d/8,缺%s)" % (len(by_time), ",".join(missing))
        return res, None

    last_close = by_time["15:00:00"]["close"]
    if not last_close:
        res["err"] = "zero_last_close"
        return res, None
    factor = daily_close / last_close

    rows = []
    for t in EXPECTED_TIMES:
        b = by_time[t]
        o = round(b["open"] * factor, 4)
        h = round(b["high"] * factor, 4)
        lo = round(b["low"] * factor, 4)
        c = round(b["close"] * factor, 4)
        hi = max(o, h, lo, c)
        lo2 = min(o, h, lo, c)
        rows.append({
            "code": code,
            "exch": exch_l,
            "time": t,
            "open": o,
            "high": hi,
            "low": lo2,
            "close": c,
            "volume": int(round(b["volume"])),
        })
    res["factor"] = round(factor, 6)
    return res, rows


# ----------------------------------------------------------------------
# 落盘
# ----------------------------------------------------------------------
def write_day_file(date_str, rows, generated_at):
    os.makedirs(OUTDIR, exist_ok=True)
    payload = {
        "tradeDate": date_str,
        "generatedAt": generated_at,
        "barsPerStock": BARS_PER_STOCK,
        "count": len(rows) // BARS_PER_STOCK,
        "rows": rows,
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    json_bytes = len(data)
    path = os.path.join(OUTDIR, "%s.json.gz" % date_str)
    with gzip.open(path, "wb") as f:
        f.write(data)
    # 真实落盘大小：读磁盘文件，而非内存缓冲长度
    gz_bytes = os.path.getsize(path)
    return path, json_bytes, gz_bytes, payload["count"]


def rebuild_manifest(db_max_daily):
    files = {}
    dates = []
    if os.path.isdir(OUTDIR):
        for fn in sorted(os.listdir(OUTDIR)):
            if not (fn.endswith(".json.gz") and len(fn) > 8):
                continue
            d = fn[:-8]
            if d.count("-") != 2:
                continue
            fp = os.path.join(OUTDIR, fn)
            try:
                with gzip.open(fp, "rb") as f:
                    obj = json.loads(f.read().decode("utf-8"))
                files[d] = {"count": obj.get("count"),
                            "bytes": os.path.getsize(fp)}
                dates.append(d)
            except Exception:
                continue
    manifest = {
        "generatedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "dates": dates,
        "files": files,
        "dbMaxDaily": db_max_daily,
    }
    with open(os.path.join(OUTDIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="跳过交易日闸门")
    ap.add_argument("--date", default="", help="回填指定日期 YYYY-MM-DD（默认今天）")
    ap.add_argument("--codes", default="", help="逗号分隔的股票代码")
    ap.add_argument("--sample", type=int, default=0, help="只处理前 N 只（调试）")
    ap.add_argument("--workers", type=int, default=12, help="并发数")
    ap.add_argument("--n", type=int, default=200, help="每票请求的30m K线根数")
    ap.add_argument("--dry-run", action="store_true", help="只拉取与判定，不落盘")
    ap.add_argument("--db", default=DB)
    args = ap.parse_args()

    t0 = time.time()

    print("=" * 70)
    print("A股 30 分钟K线落盘  %s" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 70)

    args.date = args.date or datetime.datetime.now().strftime("%Y-%m-%d")
    args.target_ms = ms_of(args.date)

    if args.force:
        print("[交易日闸门] 已通过 --force 跳过")
    else:
        should_run, note = trading_day_gate()
        print("[交易日闸门] %s" % note)
        if not should_run and not args.date:
            print()
            print("本次不执行。如需强制运行（如手动补历史数据），加 --force")
            return

    print()

    con = sqlite3.connect(args.db, timeout=120)
    con.execute("PRAGMA busy_timeout=120000")
    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    universe = load_universe(con, codes or None)
    daily_map = load_daily_close_map(con, args.target_ms)
    if args.sample:
        universe = universe[:args.sample]

    print("目标交易日: %s   股票数: %d   并发: %d   datalen: %d"
          % (args.date, len(universe), args.workers, args.n))
    print("落盘: %s   (dry-run=%s)" % (OUTDIR, args.dry_run))
    print()

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, (res, rows) in enumerate(
                ex.map(lambda row: process_one(row, args, daily_map), universe), 1):
            results.append((res, rows))
            if args.dry_run and (i <= 20 or i % 1000 == 0):
                if res["err"]:
                    print("    %-8s %-6s ERR %s" % (res["code"], res["exch"], res["err"]))
                else:
                    print("    %-8s %-6s factor=%.6f" % (res["code"], res["exch"], res["factor"]))
            elif i % 1000 == 0:
                print("    ... 已处理 %d/%d  (%.0fs)" % (i, len(universe), time.time() - t0))

    included, skipped, violations = [], [], []
    all_rows = []
    for res, rows in results:
        if res["err"] == "no_daily_bar":
            skipped.append(res)
        elif res["err"]:
            violations.append(res)
        elif rows:
            included.append(res)
            all_rows.extend(rows)

    print()
    print("---- 结果 ----")
    print("  全市场股票: %d" % len(universe))
    print("  成功(含8根): %d" % len(included))
    print("  跳过(无当日日K/停牌未上市): %d" % len(skipped))
    print("  违规(抓取失败或不足8根): %d" % len(violations))
    if violations:
        print("  违规样例:")
        for r in violations[:10]:
            print("    %-8s %s" % (r["code"], r["err"]))

    if args.dry_run:
        print()
        print("dry-run 结束，未落盘。耗时 %.1fs" % (time.time() - t0))
        con.close()
        return

    # 落盘
    generated_at = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    path, json_bytes, gz_bytes, count = write_day_file(args.date, all_rows, generated_at)
    print()
    print("---- 落盘 ----")
    print("  文件: %s" % path)
    print("  JSON 未压缩: %d 字节" % json_bytes)
    print("  gzip 落盘  : %d 字节" % gz_bytes)
    print("  count(股票数): %d    总 rows: %d    rows/8: %d"
          % (count, len(all_rows), len(all_rows) // BARS_PER_STOCK))

    cur = con.cursor()
    cur.execute("SELECT MAX(tradeDate) FROM klines WHERE period='1d'")
    mx = cur.fetchone()[0]
    db_max_daily = date_of(mx) if mx else None
    manifest = rebuild_manifest(db_max_daily)
    print("  manifest: %d 个日期, dbMaxDaily=%s" % (len(manifest["dates"]), db_max_daily))

    con.close()
    print()
    print("完成，总耗时 %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("[FATAL] %s: %s" % (type(e).__name__, e))
    sys.exit(0)
