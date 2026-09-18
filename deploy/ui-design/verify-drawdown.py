#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
交叉验证：回测详情接口给出的「最大回撤起止日」是否与独立计算一致。

独立算法（与引擎内的正确实现同语义）：
    遍历资产曲线，维护运行峰值及其日期；
    当日资产低于运行峰值时算出回撤幅度，遇到更深的回撤就记录
    「当前运行峰值日」为起始日、「当日」为结束日。
"""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8080"


def get(path):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def correct(curve):
    peak = curve[0]["totalAsset"]
    peak_date = curve[0]["date"]
    worst = 0.0
    start = None
    end = None
    for x in curve:
        if x["totalAsset"] > peak:
            peak = x["totalAsset"]
            peak_date = x["date"]
        cur = (x["totalAsset"] - peak) / peak * 100 if peak > 0 else 0.0
        if cur < worst:
            worst = cur
            start = peak_date
            end = x["date"]
    return start, end, round(worst, 2)


def main():
    items = get("/api/backtest")["data"]
    print("回测记录数 =", len(items))
    print()
    bad = 0
    checked = 0
    for it in items:
        bid = it["id"]
        d = get("/api/backtest/" + bid)["data"]
        m = d.get("metrics") or {}
        curve = d.get("drawdownCurve") or []
        name = (it.get("name") or "")[:32]
        if len(curve) < 2:
            print("  [--] %-32s 曲线为空，跳过" % name)
            continue
        cs, ce, cdd = correct(curve)
        api_s, api_e = m.get("maxDrawdownStart"), m.get("maxDrawdownEnd")
        ok = (cs == api_s and ce == api_e)
        checked += 1
        if not ok:
            bad += 1
        print("  %s %-32s API %s -> %s | 正确 %s -> %s | 回撤 %s%%"
              % ("[OK]" if ok else "[!!]", name, api_s, api_e, cs, ce, m.get("maxDrawdown")))
        if api_s and api_e and api_s > api_e:
            print("       ^^ 注意：起始日晚于结束日")
    print()
    print("检查 %d 条，结论：%s" % (checked, "全部一致" if bad == 0 else "%d 条不一致" % bad))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
