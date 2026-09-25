#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""部署后端到端验收 —— 在**服务器本机**对 http://127.0.0.1:8080 实跑一遍核心流程。

为什么需要：
  部署脚本只验「页面 200 / 接口 200」，那只能证明进程活着，**证明不了新功能真的在跑**。
  本脚本用一个**临时会话**走完「建局 → 逐节点揭示 → 看收盘 → 一步换日 → 删除」，
  逐项断言关键契约，测完自删，**不触碰任何真实会话**。

用法（在服务器上）：python3 /home/ubuntu/deploy/e2e-deployed-check.py
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8080"
PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  \u2713 %s" % name)
    else:
        FAIL += 1
        FAILURES.append("%s %s" % (name, extra))
        print("  \u2717 %s %s" % (name, extra))


def req(method, path, body=None):
    url = BASE + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {}
    except Exception as e:  # noqa: BLE001
        return 0, {"message": str(e)}


def main():
    print("=== [1] 健康检查 ===")
    st, js = req("GET", "/api/simtrade")
    check("GET /api/simtrade 返回 200", st == 200, "status=%s" % st)
    before_count = js.get("count", 0)
    print("    现有会话数 = %s（测试期间应保持不变）" % before_count)

    print("\n=== [2] 创建临时会话 ===")
    st, js = req("POST", "/api/simtrade", {"tradingDays": 20, "name": "E2E-DEPLOY-CHECK"})
    check("创建成功（201）", st == 201, "status=%s msg=%s" % (st, js.get("message")))
    sess = js.get("session") or {}
    sid = sess.get("id")
    if not sid:
        print("FATAL: 未拿到会话 id，终止")
        return 1
    print("    临时会话 id = %s  区间 %s ~ %s" % (sid, sess.get("startDate"), sess.get("endDate")))

    try:
        print("\n=== [3] 快照新契约：prevClose / todayBar ===")
        st, js = req("GET", "/api/simtrade/%s" % sid)
        snap = js.get("data") or {}
        check("GET 快照 200", st == 200, "status=%s" % st)
        check("快照含 prevClose", snap.get("prevClose") is not None, "prevClose=%s" % snap.get("prevClose"))
        tb = snap.get("todayBar")
        check("快照含 todayBar", tb is not None, "todayBar=%s" % tb)
        if tb:
            check(
                "todayBar.source 合法",
                tb.get("source") in ("INTRADAY_30M", "DAILY_K"),
                "source=%s" % tb.get("source"),
            )
            check(
                "未揭示收盘时 finalized=false",
                tb.get("finalized") is False,
                "finalized=%s" % tb.get("finalized"),
            )
            check(
                "未揭示收盘时 todayClose=null",
                snap.get("todayClose") is None,
                "todayClose=%s" % snap.get("todayClose"),
            )
            hist = snap.get("history") or []
            last = hist[-1] if hist else {}
            if last.get("date") == snap.get("session", {}).get("currentDate"):
                check(
                    "history 末根与 todayBar 逐字段一致",
                    abs(last.get("open", 0) - tb.get("open", 0)) < 1e-6
                    and abs(last.get("high", 0) - tb.get("high", 0)) < 1e-6
                    and abs(last.get("low", 0) - tb.get("low", 0)) < 1e-6
                    and abs(last.get("close", 0) - tb.get("close", 0)) < 1e-6
                    and last.get("volume") == tb.get("volume"),
                    "hist=%s tb=%s" % (last, tb),
                )

        print("\n=== [4] 分时契约：ticks / 09:30 锚点 / 不泄露未来 ===")
        st, js = req("GET", "/api/intraday?sessionId=%s" % sid)
        d = js.get("data") or {}
        check("GET /api/intraday 200", st == 200, "status=%s" % st)
        check("含 prevClose", d.get("prevClose") is not None, "prevClose=%s" % d.get("prevClose"))
        check("times 长度 == 9", len(d.get("times") or []) == 9, "times=%s" % d.get("times"))
        check("times[0] == 09:30", (d.get("times") or [None])[0] == "09:30", "times=%s" % d.get("times"))
        ticks = d.get("ticks") or []
        bar_count = d.get("barCount", 0)
        check(
            "ticks 长度 == barCount + 1",
            len(ticks) == bar_count + 1 or bar_count == 0,
            "ticks=%s barCount=%s" % (len(ticks), bar_count),
        )
        if ticks:
            check("ticks[0].time == 09:30", ticks[0].get("time") == "09:30", "ticks[0]=%s" % ticks[0])
        check("未揭示时 revealClose=false", d.get("revealClose") is False, "revealClose=%s" % d.get("revealClose"))

        print("\n=== [5] 逐节点推进到 7/8（防泄漏边界）===")
        ok_ticks = 0
        for i in range(6):
            st, js = req("POST", "/api/simtrade/%s/tick" % sid)
            if js.get("success"):
                ok_ticks += 1
        check("推进 6 次成功（游标 → 7）", ok_ticks == 6, "成功 %s 次" % ok_ticks)
        st, js = req("POST", "/api/simtrade/%s/tick" % sid)
        check("第 8 根在 OPEN 阶段被拒【防泄露】", not js.get("success"), "msg=%s" % js.get("message"))

        st, js = req("GET", "/api/intraday?sessionId=%s" % sid)
        d = js.get("data") or {}
        ticks = d.get("ticks") or []
        check("游标 7 → ticks 长度 8", len(ticks) == 8, "ticks=%s" % len(ticks))
        times = d.get("times") or []
        idx_last = times.index(ticks[-1]["time"]) if ticks and ticks[-1]["time"] in times else -1
        check("最后一个 tick 时点 == 14:30", ticks and ticks[-1]["time"] == "14:30", "last=%s" % (ticks[-1] if ticks else None))
        check(
            "不含任何晚于 14:30 的时点【防泄露】",
            all(t["time"] in ("09:30",) or (idx_last >= 0 and times.index(t["time"]) <= idx_last) for t in ticks),
            "ticks=%s" % [t["time"] for t in ticks],
        )
        check("cumVolume > 0（累计成交量已换算）", (d.get("cumVolume") or 0) > 0, "cumVolume=%s" % d.get("cumVolume"))

        print("\n=== [6] 看收盘 → CLOSE_ANIMATION ===")
        st, js = req("POST", "/api/simtrade/%s/next" % sid)
        check("next 成功", js.get("success"), "msg=%s" % js.get("message"))
        st, js = req("GET", "/api/simtrade/%s" % sid)
        snap = js.get("data") or {}
        check("stage == CLOSE_ANIMATION", snap.get("stage") == "CLOSE_ANIMATION", "stage=%s" % snap.get("stage"))
        check("todayClose 已揭示", snap.get("todayClose") is not None, "todayClose=%s" % snap.get("todayClose"))
        tb = snap.get("todayBar") or {}
        check("todayBar.finalized == true", tb.get("finalized") is True, "finalized=%s" % tb.get("finalized"))
        check("定格后 source == DAILY_K", tb.get("source") == "DAILY_K", "source=%s" % tb.get("source"))
        close_revealed = snap.get("todayClose")
        day_before = (snap.get("session") or {}).get("currentDate")

        st, js = req("GET", "/api/intraday?sessionId=%s" % sid)
        d = js.get("data") or {}
        check("揭示后 revealClose == true", d.get("revealClose") is True, "revealClose=%s" % d.get("revealClose"))
        check("揭示后 ticks 长度 == 9", len(d.get("ticks") or []) == 9, "ticks=%s" % len(d.get("ticks") or []))

        print("\n=== [7] 一步换日（原子 /next-day）===")
        st, js = req("POST", "/api/simtrade/%s/next" % sid)
        check("进入 CLOSE", js.get("success"), "msg=%s" % js.get("message"))
        st, js = req("POST", "/api/simtrade/%s/next-day" % sid)
        check("next-day 成功", js.get("success"), "msg=%s" % js.get("message"))
        check("返回体不含 finished=true", js.get("finished") is not True, "finished=%s" % js.get("finished"))

        st, js = req("GET", "/api/simtrade/%s" % sid)
        snap = js.get("data") or {}
        sess2 = snap.get("session") or {}
        check("日期已变化", sess2.get("currentDate") != day_before, "仍为 %s" % sess2.get("currentDate"))
        check("新日 stage == OPEN", snap.get("stage") == "OPEN", "stage=%s" % snap.get("stage"))
        check("**未越界到 CLOSE_ANIMATION**", snap.get("stage") != "CLOSE_ANIMATION", "stage=%s" % snap.get("stage"))
        check("新日 30m 游标 == 1", snap.get("intradayBarCount") == 1, "游标=%s" % snap.get("intradayBarCount"))
        check("新日 操作计数 == 0", snap.get("operationCount") == 0, "ops=%s" % snap.get("operationCount"))
        check("新日 买入额度 == 2", snap.get("remainingBuy") == 2, "remainingBuy=%s" % snap.get("remainingBuy"))
        check("新日 卖出额度 == 2", snap.get("remainingSell") == 2, "remainingSell=%s" % snap.get("remainingSell"))
        check("新日 todayClose == null", snap.get("todayClose") is None, "todayClose=%s" % snap.get("todayClose"))
        check("新日 tradable", snap.get("tradable") is True, "tradable=%s" % snap.get("tradable"))
        check(
            "新日 prevClose == 上一日收盘",
            close_revealed is not None and abs((snap.get("prevClose") or 0) - close_revealed) < 0.05,
            "prevClose=%s 上日收盘=%s" % (snap.get("prevClose"), close_revealed),
        )

        print("\n=== [8] 幂等：再点 next-day 应被拒（不跳日）===")
        day_now = sess2.get("currentDate")
        st, js = req("POST", "/api/simtrade/%s/next-day" % sid)
        check("新日 OPEN 下 next-day 被拒", not js.get("success"), "msg=%s" % js.get("message"))
        st, js = req("GET", "/api/simtrade/%s" % sid)
        check(
            "日期未再变化【不跳日】",
            (js.get("data") or {}).get("session", {}).get("currentDate") == day_now,
            "now=%s" % (js.get("data") or {}).get("session", {}).get("currentDate"),
        )
    finally:
        print("\n=== [9] 清理临时会话 ===")
        st, js = req("DELETE", "/api/simtrade/%s" % sid)
        check("删除临时会话成功", js.get("success"), "status=%s msg=%s" % (st, js.get("message")))
        st, js = req("GET", "/api/simtrade")
        check(
            "会话数回到测试前（%s）" % before_count,
            js.get("count") == before_count,
            "现在 %s" % js.get("count"),
        )

    print("\n" + "=" * 60)
    print("通过 %s / 失败 %s" % (PASS, FAIL))
    for f in FAILURES:
        print("  \u2717 %s" % f)
    print("=" * 60)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
