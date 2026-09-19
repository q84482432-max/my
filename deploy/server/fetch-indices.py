#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 A 股主要指数日K（新浪为主源，腾讯为交叉校验）

为什么以新浪为主：腾讯接口 n>2000 直接返回 "param error"（上限 2000 根 ≈ 2018-06）；
新浪 datalen 可到 5000，能回溯到 2006 年，长历史对回测更有价值。

输出：/home/ubuntu/index_data/index_<symbol>.json + indices_all.json + _summary.json
只写 /home/ubuntu/index_data/，不碰生产库 dev.db。
"""
import json
import os
import re
import time
import random
import urllib.request

OUT_DIR = "/home/ubuntu/index_data"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

SINA_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
            "CN_MarketData.getKLineData?symbol={sym}&scale=240&ma=no&datalen={n}")
TENCENT_URL = ("http://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get"
               "?param={sym},day,,,{n},qfq")

SINA_MAX = 5000      # 新浪可取上限
TENCENT_MAX = 2000   # 腾讯硬上限，超过返回 param error

DB_START, DB_END = "2024-11-04", "2026-09-18"

INDICES = [
    ("sh000001", "上证指数"), ("sz399001", "深证成指"), ("sz399006", "创业板指"),
    ("sh000300", "沪深300"), ("sh000905", "中证500"), ("sh000852", "中证1000"),
    ("sh000016", "上证50"), ("sh000688", "科创50"), ("bj899050", "北证50"),
]


def http(url, referer, timeout=30, retries=3):
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


def fetch_sina(sym, n=SINA_MAX):
    st, body = http(SINA_URL.format(sym=sym, n=n), "https://finance.sina.com.cn/")
    if st != 200:
        raise RuntimeError("http_%s" % st)
    if not body or body.strip() in ("null", "[]"):
        return []
    try:
        arr = json.loads(body)
    except Exception:
        arr = json.loads(re.sub(r'([{,])\s*([A-Za-z_]\w*)\s*:', r'\1"\2":', body))
    out = []
    for r in arr or []:
        try:
            out.append({"d": str(r["day"])[:10].replace("-", ""), "o": float(r["open"]),
                        "c": float(r["close"]), "h": float(r["high"]),
                        "l": float(r["low"]), "v": float(r["volume"])})
        except Exception:
            continue
    return out


def fetch_tencent(sym, n=TENCENT_MAX):
    st, body = http(TENCENT_URL.format(sym=sym, n=n), "https://gu.qq.com/")
    if st != 200:
        raise RuntimeError("http_%s" % st)
    j = json.loads(body)
    if not isinstance(j, dict):
        raise RuntimeError("bad_json")
    node = (j.get("data") or {}).get(sym) or {}
    arr = node.get("day") or node.get("qfqday") or []
    out = []
    for r in arr:
        try:
            out.append({"d": str(r[0])[:10].replace("-", ""), "o": float(r[1]), "c": float(r[2]),
                        "h": float(r[3]), "l": float(r[4]), "v": float(r[5])})
        except Exception:
            continue
    return out


def dash(d):
    return "%s-%s-%s" % (d[:4], d[4:6], d[6:8])


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    summary, combined = [], {}

    for sym, name in INDICES:
        try:
            sina = fetch_sina(sym)
        except Exception as e:
            print("  %-9s %-8s ✗ 新浪失败 %s" % (sym, name, str(e)[:70]))
            summary.append({"symbol": sym, "name": name, "ok": False, "error": str(e)[:120]})
            continue
        if not sina:
            print("  %-9s %-8s ✗ 新浪无数据" % (sym, name))
            summary.append({"symbol": sym, "name": name, "ok": False, "error": "sina_empty"})
            continue

        # 交叉校验：与腾讯在共同日期上比收盘价
        xcheck = {"available": False}
        try:
            ten = fetch_tencent(sym)
            td = {r["d"]: r["c"] for r in ten}
            common = [r for r in sina if r["d"] in td]
            if common:
                diffs = [abs(r["c"] - td[r["d"]]) / td[r["d"]] for r in common if td[r["d"]]]
                xcheck = {"available": True, "common_days": len(common),
                          "max_rel_diff_pct": round(max(diffs) * 100, 4) if diffs else None,
                          "tencent_days": len(ten)}
        except Exception as e:
            xcheck = {"available": False, "error": str(e)[:80]}

        uniq = {r["d"]: r for r in sina}
        keys = sorted(uniq)
        clean = [uniq[k] for k in keys]
        in_win = sum(1 for k in keys if DB_START <= dash(k) <= DB_END)

        payload = {"symbol": sym, "name": name, "source": "sina",
                   "v_unit": "share", "count": len(clean),
                   "first": dash(keys[0]), "last": dash(keys[-1]),
                   "in_db_window": in_win, "cross_check": xcheck, "rows": clean}
        with open(os.path.join(OUT_DIR, "index_%s.json" % sym), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        combined[sym] = {k: v for k, v in payload.items() if k != "rows"}

        summary.append({"symbol": sym, "name": name, "ok": True, "source": "sina",
                        "count": len(clean), "first": dash(keys[0]), "last": dash(keys[-1]),
                        "in_db_window": in_win, "cross_check": xcheck})
        xc = ("腾讯比对 %d 日 最大偏差 %.4f%%" % (xcheck["common_days"], xcheck["max_rel_diff_pct"])
              if xcheck.get("available") else "腾讯比对不可用")
        print("  %-9s %-8s %5d 根  %s → %s  窗口内 %3d 根  | %s"
              % (sym, name, len(clean), dash(keys[0]), dash(keys[-1]), in_win, xc))

    out = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "primary_source": "sina",
           "tencent_max_bars": TENCENT_MAX, "sina_max_bars": SINA_MAX,
           "db_window": [DB_START, DB_END], "indices": combined}
    with open(os.path.join(OUT_DIR, "indices_all.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT_DIR, "_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    ok = sum(1 for s in summary if s.get("ok"))
    print("\n成功 %d / %d   输出 %s" % (ok, len(INDICES), OUT_DIR))


if __name__ == "__main__":
    main()
