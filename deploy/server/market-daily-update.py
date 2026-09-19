#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A股日K行情增量更新 + 前复权基准重建
======================================================================
用途：为 a-share-sim-trading 每日增量拉取日K并写入 prisma/dev.db 的 klines 表。

数据源
  主源  腾讯  proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get
  备源  新浪  money.finance.sina.com.cn ... CN_MarketData.getKLineData
  （原用的 web.ifzq.gtimg.cn 已被腾讯 WAF 拦截：http 302 / https 501）

一、单位（本项目历史事故根因，必须逐票自校准）
  以库内该票最后一根日K的 volume 为基准，与数据源同日 volume 相除，
  比值 ≈1.0 或 ≈100.0 即判定单位，再套用到本次新增的所有日期。
  实测：沪深主板/创业板/北交所源为「手」(×100)，科创板源为「股」(×1)。

二、前复权基准重建（--rebase，默认开启）
  前复权序列以「最新交易日」为基准。一旦个股发生除权除息（现金分红或送转），
  全部历史价格都要重新计算，否则新旧数据拼在一起会出现人为跳空。
  做法：把库内「基准日那根K线」的 close 与数据源同日的值比对，
        若不一致（差值或比值超过阈值），即判定该票发生了复权事件，
        随即拉取完整前复权历史（默认 1023 根）覆盖该票的 open/high/low/close，
        并保持 amount = close * volume 的库内约定。
  锚点默认取库内现有最新交易日；也可用 --rebase-anchor 指定历史日期做一次性体检。

三、写入
  表 klines，唯一键 (stockId, period, tradeDate, adjust)，INSERT OR IGNORE 保证幂等。
  amount = close * volume（与库内既有约定一致）。
  tradeDate 存 UTC 零点毫秒时间戳。

四、交易日闸门（默认开启，--force 可跳过）
  节假日（春节/国庆/清明等落在工作日里的休市日）不执行，也不写库。
  判据：上证指数 sh000001 是否已有「当日」日K —— 开市日收盘后必有，
        休市日最新K线仍是上一个交易日。
  这样零维护：不需要交易日历，也不用每年更新放假安排。
  探针网络失败时不阻断（宁可多跑一次，也不因抖动漏数据）。
  万一漏跑，下次运行会按 --n 根回溯自动补齐。

用法
  python3 market-daily-update.py --dry-run                  # 空跑
  python3 market-daily-update.py                            # 正式增量更新（含自动复权重建）
  python3 market-daily-update.py --force                    # 跳过交易日闸门（手动补历史数据）
  python3 market-daily-update.py --rebase-anchor 2026-09-10 # 以历史日为期准做复权体检+修复
  python3 market-daily-update.py --no-rebase                # 关闭复权重建
======================================================================
"""

import argparse
import datetime
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
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

TENCENT_URL = ("http://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get"
               "?param={sym},day,,,{n},{fq}")
SINA_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
            "CN_MarketData.getKLineData?symbol={sym}&scale=240&ma=no&datalen={n}")

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
U64 = "0123456789abcdefghijklmnopqrstuvwxyz"

REBASE_ABS = 0.011          # 绝对差阈值（元）
REBASE_REL = 0.003          # 相对差阈值
DEFAULT_UNIT = {"lot": 100.0, "share": 1.0}


# ----------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------
def http(url, referer="https://gu.qq.com/", timeout=20, retries=2):
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


def today_ms():
    return ms_of(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"))


def make_id():
    n = int(time.time() * 1000)
    a = ""
    while n:
        a = U64[n % 36] + a
        n //= 36
    return "c" + a + "".join(random.choice(U64) for _ in range(16))


def prefix_of(exch):
    return {"SH": "sh", "SZ": "sz", "BJ": "bj"}.get(exch, "sh")


# ----------------------------------------------------------------------
# 数据源
# ----------------------------------------------------------------------
def fetch_tencent(sym, n, fq):
    url = TENCENT_URL.format(sym=sym, n=n, fq=fq)
    st, body = http(url, referer="https://gu.qq.com/")
    if st != 200:
        raise RuntimeError("tencent_http_%s(%s)" % (st, body[:80]))
    j = json.loads(body)
    node = (j.get("data") or {}).get(sym) or {}
    arr = node.get("qfqday") or node.get("day") or node.get("hfqday") or []
    bars = []
    for r in arr:
        try:
            bars.append({"date": str(r[0])[:10], "open": float(r[1]), "close": float(r[2]),
                         "high": float(r[3]), "low": float(r[4]), "volume": float(r[5])})
        except Exception:
            continue
    return bars, "lot"


def fetch_sina(sym, n):
    url = SINA_URL.format(sym=sym, n=n)
    st, body = http(url, referer="https://finance.sina.com.cn/")
    if st != 200:
        raise RuntimeError("sina_http_%s(%s)" % (st, body[:80]))
    if not body or body.strip() in ("null", "[]"):
        return [], "share"
    try:
        arr = json.loads(body)
    except Exception:
        arr = json.loads(re.sub(r'([{,])\s*([A-Za-z_]\w*)\s*:', r'\1"\2":', body))
    bars = []
    for r in arr or []:
        try:
            bars.append({"date": str(r["day"])[:10], "open": float(r["open"]),
                         "close": float(r["close"]), "high": float(r["high"]),
                         "low": float(r["low"]), "volume": float(r["volume"])})
        except Exception:
            continue
    return bars, "share"


def calc_unit(db_vol, src_vol):
    if not src_vol:
        return None, 0.0
    ratio = float(db_vol) / float(src_vol)
    for cand in (1.0, 100.0, 0.01, 10000.0):
        if abs(ratio / cand - 1.0) <= 0.02:
            return cand, ratio
    return None, ratio


# ----------------------------------------------------------------------
# 交易日闸门
#   节假日（春节/国庆/清明…落在工作日里）不跑，靠上证指数当日K线判定：
#   开市日收盘后必然有当日K线；休市日最新K线仍是上一个交易日。
#   好处是零维护 —— 不需要交易日历，也不需要每年更新放假安排。
#   即使某天误判漏跑，下次运行会按 --n 根回溯自动补齐。
# ----------------------------------------------------------------------
INDEX_SYM = "sh000001"


def latest_trading_day():
    """取上证指数最近一根日K的日期。返回 (date_str|None, source, err)。"""
    t_err = s_err = None
    try:
        bars, _ = fetch_tencent(INDEX_SYM, 6, "qfq")
        if bars:
            return max(b["date"] for b in bars), "tencent", None
        t_err = "tencent_empty"
    except Exception as e:
        t_err = "tencent:%s" % str(e)[:60]
    try:
        bars, _ = fetch_sina(INDEX_SYM, 6)
        if bars:
            return max(b["date"] for b in bars), "sina", None
        s_err = "sina_empty"
    except Exception as e:
        s_err = "sina:%s" % str(e)[:60]
    return None, None, "%s | %s" % (t_err, s_err)


def trading_day_gate(now=None):
    """判断今天是否该执行。返回 (should_run, note)。

    now 可注入，便于测试任意日期（默认取系统时间）。
    """
    now = now or datetime.datetime.now()
    today = now.strftime("%Y-%m-%d")

    if now.weekday() >= 5:
        return False, "今日 %s 为周末，A股休市" % today

    ltd, src, err = latest_trading_day()
    if ltd is None:
        # 探针失败不阻断 —— 宁可多跑一次，也不因为网络抖动漏掉数据
        return True, "交易日探针失败（%s）→ 不阻断，继续执行" % err

    if ltd == today:
        return True, "今日 %s 为交易日（源：%s，当日数据已就绪）" % (today, src)

    return False, ("今日 %s 非交易日（%s 最新交易日仍为 %s，A股休市）"
                   % (today, src, ltd))


# ----------------------------------------------------------------------
# 抓取 + 判定（并发）
# ----------------------------------------------------------------------
def load_universe(con, codes=None, boards=None, anchor_ms=None):
    cur = con.cursor()
    sql = ("SELECT s.id, s.code, s.name, s.exchange, s.board, s.adjust, "
           "  (SELECT k.tradeDate FROM klines k WHERE k.stockId=s.id AND k.period='1d' "
           "     ORDER BY k.tradeDate DESC LIMIT 1) AS lastDate, "
           "  (SELECT k.volume    FROM klines k WHERE k.stockId=s.id AND k.period='1d' "
           "     ORDER BY k.tradeDate DESC LIMIT 1) AS lastVol, "
           "  (SELECT k.close     FROM klines k WHERE k.stockId=s.id AND k.period='1d' "
           "     ORDER BY k.tradeDate DESC LIMIT 1) AS lastClose, "
           "  (SELECT k.adjust    FROM klines k WHERE k.stockId=s.id AND k.period='1d' "
           "     ORDER BY k.tradeDate DESC LIMIT 1) AS lastAdjust ")
    args = []
    if anchor_ms is not None:
        sql += (", (SELECT k.close FROM klines k WHERE k.stockId=s.id AND k.period='1d' "
                "     AND k.tradeDate=?) AS anchorClose ")
        args.append(anchor_ms)
    else:
        sql += ", NULL AS anchorClose "
    sql += "FROM stocks s"
    where = []
    if codes:
        where.append("s.code IN (%s)" % ",".join("?" * len(codes)))
        args += list(codes)
    if boards:
        where.append("s.board IN (%s)" % ",".join("?" * len(boards)))
        args += list(boards)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY s.code"
    cur.execute(sql, args)
    return cur.fetchall()


def process_one(row, args):
    (sid, code, name, exch, board, adjust, last_ms, last_vol, last_close,
     last_adjust, anchor_close) = row
    kadj = last_adjust or adjust or "qfq"
    sym = prefix_of(exch) + code
    res = {"code": code, "name": name, "board": board, "sym": sym, "adj": kadj,
           "source": None, "unit": None, "mult": None, "ratio": None,
           "new": [], "err": None, "rebase": None, "rebase_why": None,
           "last": date_of(last_ms) if last_ms else None}

    fq = "qfq" if kadj == "qfq" else ""
    bars, unit, errs = [], None, []
    for src in ([args.source] if args.source else ["tencent", "sina"]):
        try:
            bars, unit = (fetch_tencent(sym, args.n, fq) if src == "tencent"
                          else fetch_sina(sym, args.n))
            res["source"] = src
            break
        except Exception as e:
            errs.append("%s=%s" % (src, str(e)[:70]))
    if res["source"] is None:
        res["err"] = " | ".join(errs)
        return res
    if not bars:
        res["err"] = "源无数据"
        return res

    bydate = {b["date"]: b for b in bars}

    # ---- 单位校准 ----
    mult, ratio = None, None
    if last_ms and last_vol:
        ref = bydate.get(date_of(last_ms))
        if ref:
            mult, ratio = calc_unit(last_vol, ref["volume"])
    if mult is None:
        mult = DEFAULT_UNIT.get(unit, 1.0)
        res["unverified"] = True
    res["unit"], res["mult"], res["ratio"] = unit, mult, ratio

    # ---- 复权事件判定 ----
    if args.rebase and kadj == "qfq":
        if args.anchor_ms is not None:
            aref_ms, aref_close, adate = args.anchor_ms, anchor_close, args.anchor_date
        else:
            aref_ms, aref_close, adate = last_ms, last_close, res["last"]
        if aref_ms and aref_close is not None and adate in bydate:
            sp = bydate[adate]["close"]
            if sp:
                d_abs = abs(float(aref_close) - sp)
                d_rel = abs(float(aref_close) / sp - 1.0)
                if d_abs > REBASE_ABS and d_rel > REBASE_REL:
                    res["rebase"] = adate
                    res["rebase_why"] = "基准日 %s 库%s vs 源%s (差%.3f / %.2f%%)" % (
                        adate, aref_close, sp, float(aref_close) - sp, d_rel * 100)

    # ---- 待新增日期 ----
    newbars = []
    for b in bars:
        try:
            d = ms_of(b["date"])
        except Exception:
            continue
        if d > args.end_ms or d < args.beg_ms:
            continue
        if last_ms is not None and d <= last_ms:
            continue
        newbars.append(b)
    res["new"] = newbars
    return res


# ----------------------------------------------------------------------
# 写库
# ----------------------------------------------------------------------
def apply_rebase(con, results, args):
    """对发生除权除息的股票，用源的前复权序列重建历史价格。"""
    targets = [r for r in results if r.get("rebase")]
    if not targets:
        return 0, 0, []
    cur = con.cursor()
    cur.execute("SELECT code, id FROM stocks")
    idmap = dict(cur.fetchall())
    n_upd, done, failed = 0, 0, []
    for r in targets:
        sid = idmap.get(r["code"])
        if not sid:
            continue
        try:
            full, _ = fetch_tencent(r["sym"], args.rebase_full_n, "qfq")
        except Exception as e:
            failed.append("%s(%s)" % (r["code"], str(e)[:40]))
            continue
        src = {b["date"]: b for b in full}
        if not src:
            failed.append("%s(源无数据)" % r["code"])
            continue
        cur.execute("SELECT tradeDate, volume FROM klines WHERE stockId=? AND period='1d'", (sid,))
        rows = cur.fetchall()
        upd = []
        for td, vol in rows:
            b = src.get(date_of(td))
            if not b:
                continue
            o, h, lo, c = (round(b["open"], 2), round(b["high"], 2),
                           round(b["low"], 2), round(b["close"], 2))
            upd.append((o, h, lo, c, round(c * vol, 2), sid, td))
        if upd:
            cur.executemany("UPDATE klines SET open=?, high=?, low=?, close=?, amount=? "
                            "WHERE stockId=? AND period='1d' AND tradeDate=?", upd)
            n_upd += len(upd)
            done += 1
    return n_upd, done, failed


def write_rows(con, results, args):
    cur = con.cursor()
    cur.execute("SELECT code, id FROM stocks")
    idmap = dict(cur.fetchall())

    reb_rows, reb_done, reb_failed = (0, 0, [])
    if args.rebase:
        reb_rows, reb_done, reb_failed = apply_rebase(con, results, args)

    rows, touched = [], {}
    for r in results:
        if not r.get("new"):
            continue
        sid = idmap.get(r["code"])
        if not sid:
            continue
        for b in r["new"]:
            vol = int(round(b["volume"] * r["mult"]))
            if vol <= 0:
                continue
            c = round(b["close"], 2)
            rows.append((make_id(), sid, "1d", ms_of(b["date"]), round(b["open"], 2),
                         round(b["high"], 2), round(b["low"], 2), c, vol,
                         round(c * vol, 2), r["adj"]))
        touched[sid] = r["code"]

    if rows:
        cur.executemany(
            "INSERT OR IGNORE INTO klines "
            "(id, stockId, period, tradeDate, open, high, low, close, volume, amount, adjust) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)

    for sid in touched:
        cur.execute("SELECT COUNT(*), MAX(tradeDate), MIN(tradeDate) FROM klines "
                    "WHERE stockId=? AND period='1d'", (sid,))
        c, mx, mn = cur.fetchone()
        cur.execute("UPDATE stocks SET barCount=?, windowEnd=?, windowStart=? WHERE id=?",
                    (c, mx, mn, sid))
    con.commit()
    return len(rows), len(touched), reb_rows, reb_done, reb_failed


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只拉取与判定，不写库")
    ap.add_argument("--sample", type=int, default=0, help="只处理前 N 只（调试）")
    ap.add_argument("--codes", default="", help="逗号分隔的股票代码")
    ap.add_argument("--boards", default="", help="逗号分隔板块 MAIN,GEM,STAR,BSE")
    ap.add_argument("--n", type=int, default=45, help="每票请求的K线根数")
    ap.add_argument("--days", type=int, default=15, help="回溯天数上限")
    ap.add_argument("--workers", type=int, default=12, help="并发数")
    ap.add_argument("--source", default="", choices=["", "tencent", "sina"])
    ap.add_argument("--no-rebase", dest="rebase", action="store_false", help="关闭复权重建")
    ap.add_argument("--rebase-anchor", default="", help="指定复权判定的基准日 YYYY-MM-DD")
    ap.add_argument("--rebase-full-n", type=int, default=1023, help="重建时拉取的完整K线根数")
    ap.add_argument("--force", action="store_true",
                    help="跳过交易日闸门强制运行（手动补历史数据时用）")
    ap.add_argument("--db", default=DB)
    ap.set_defaults(rebase=True)
    args = ap.parse_args()

    args.end_ms = today_ms()
    args.beg_ms = args.end_ms - args.days * 86400000
    args.anchor_ms = ms_of(args.rebase_anchor) if args.rebase_anchor else None
    args.anchor_date = args.rebase_anchor or None

    t0 = time.time()

    print("=" * 70)
    print("A股行情增量更新  %s" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 70)

    if args.force:
        print("[交易日闸门] 已通过 --force 跳过")
    else:
        should_run, note = trading_day_gate()
        print("[交易日闸门] %s" % note)
        if not should_run:
            print()
            print("本次不执行。如需强制运行（例如手动补历史数据），加 --force")
            return
    print()

    con = sqlite3.connect(args.db, timeout=120)
    con.execute("PRAGMA busy_timeout=120000")
    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    boards = [b.strip() for b in args.boards.split(",") if b.strip()]
    universe = load_universe(con, codes or None, boards or None, args.anchor_ms)
    if args.sample:
        universe = universe[:args.sample]

    print("新增区间: <= %s（回溯 %d 天）   股票数: %d   并发: %d"
          % (date_of(args.end_ms), args.days, len(universe), args.workers))
    print("复权重建: %s   基准日: %s   写库: %s"
          % ("开启" if args.rebase else "关闭",
             args.anchor_date or "自动(库内最新交易日)",
             "否（dry-run）" if args.dry_run else "是"))
    print()

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, r in enumerate(ex.map(lambda row: process_one(row, args), universe), 1):
            results.append(r)
            if i % 1000 == 0:
                print("    ... 已处理 %d/%d  (%.0fs)" % (i, len(universe), time.time() - t0))

    ok = [r for r in results if not r["err"]]
    failed = [r for r in results if r["err"]]
    have_new = [r for r in ok if r["new"]]
    unverified = [r for r in ok if r.get("unverified")]
    rebases = [r for r in results if r.get("rebase")]

    print()
    print("---- 抓取结果 ----")
    print("  成功 %d / %d     失败 %d     有新增行情 %d 只"
          % (len(ok), len(results), len(failed), len(have_new)))

    dist = {}
    for r in have_new:
        for b in r["new"]:
            dist[b["date"]] = dist.get(b["date"], 0) + 1
    if dist:
        print("  待新增日期: " + "  ".join("%s=%d只" % (d, dist[d]) for d in sorted(dist)))

    if rebases:
        print()
        print("---- 检出除权除息（前复权基准已变）%d 只 ----" % len(rebases))
        byb = {}
        for r in rebases:
            byb[r["board"]] = byb.get(r["board"], 0) + 1
            print("   %-8s %-6s %s" % (r["code"], r["board"], r["rebase_why"]))
        print("   按板块:", byb)

    if unverified:
        print()
        print("  单位未校准（按源默认值处理）%d 只：%s"
              % (len(unverified), ",".join(r["code"] for r in unverified[:15])))
    if failed:
        print()
        print("---- 失败样例 ----")
        for r in failed[:10]:
            print("   %-8s %s" % (r["code"], r["err"]))

    if args.dry_run:
        print()
        print("dry-run 结束，未写库。耗时 %.1fs" % (time.time() - t0))
        con.close()
        return

    print()
    print("---- 写入数据库 ----")
    t1 = time.time()
    nrows, nstk, reb_rows, reb_done, reb_failed = write_rows(con, results, args)
    if reb_rows:
        print("  复权重建: 覆盖 %d 行 / %d 只股票" % (reb_rows, reb_done))
    if reb_failed:
        print("  复权重建失败: %s" % ", ".join(reb_failed[:10]))
    print("  新增行情: 插入 %d 行 / %d 只股票" % (nrows, nstk))
    print("  写库耗时 %.2fs" % (time.time() - t1))

    cur = con.cursor()
    cur.execute("SELECT MAX(tradeDate), COUNT(*) FROM klines WHERE period='1d'")
    mx, tot = cur.fetchone()
    print("  库内最新交易日 %s   总行数 %d" % (date_of(mx), tot))
    con.close()
    print()
    print("完成，总耗时 %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
