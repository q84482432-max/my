#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
30 分钟 K 线「源端污染 bar」同 bar 有界收敛修复。

背景
----
新浪源端在 2026-06-30 对 24 只北交所（920xxx）股票写入了物理不可能的边界值
（如 920001 在 14:00 的 high=26681.471），且该污染贯穿新浪 5m/15m/30m/60m 全粒度，
无可用替代源（腾讯不提供北交所分钟线、东财不可达、网易 DNS 失败）。

修复原则（关键：零外部数据注入）
--------------------------------
只用**同一根 bar 自身的干净字段**把污染值收敛回物理可能区间：

    1) close 污染  →  close ← open
    2) open  污染  →  open  ← close
    3) high  污染  →  high  ← max(open, close, low)
    4) low   污染  →  low   ← min(open, close, high)
    5) 重保 OHLC 不变量；amount ← close × volume

顺序不可调换：必须先修锚点字段（close/open），再修由它们派生的 high/low。
（首版曾因先修 high 而引用了未修复的 close=4508.87，导致仍越界。）

触发条件：仅当越界倍数 > RATIO（默认 1.5×）才动 —— 不误伤 300176 那种
2.4~2.7% 的正常跨源口径差异。

用法
----
  # 干跑（只报告，不写盘）
  python scripts/repair_30m_defects.py --manifest D:/AStockData/logs/p5_defect_manifest.json

  # 实际执行（自动先备份被触及的 parquet）
  python scripts/repair_30m_defects.py --manifest ... --apply
"""
import argparse
import datetime as dt
import json
import os
import shutil
import sqlite3
import sys

import duckdb
import pandas as pd

ROOT = r"D:\AStockData"
DIR_MIN = os.path.join(ROOT, "minutes_30")
DIR_META = os.path.join(ROOT, "metadata")
DIR_BACKUP = os.path.join(ROOT, "backup")
DB = r"D:\a-share-sim-trading\prisma\dev.db"

RULE_VERSION = "same-bar-bound/v1"
RATIO = 1.5
STD_TIMES = ["10:00:00", "10:30:00", "11:00:00", "11:30:00",
             "13:30:00", "14:00:00", "14:30:00", "15:00:00"]


def log(*a):
    print(*a, flush=True)


def dayk_map():
    """{code: {YYYY-MM-DD: (high, low)}}，来自 dev.db 日K"""
    sc = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    rows = sc.execute("""
        select s.code, k.tradeDate, k.high, k.low
        from klines k join stocks s on s.id=k.stockId
        where k.period='1d'
    """).fetchall()
    sc.close()
    m = {}
    for code, td, h, l in rows:
        if isinstance(td, (int, float)):
            d = dt.datetime.fromtimestamp(td / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        else:
            d = str(td)[:10]
        m.setdefault(code, {})[d] = (float(h), float(l))
    return m


def classify(bar, dh, dl):
    """返回被污染的字段列表（越界倍数 > RATIO 才算）"""
    o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]
    bad = []
    for name, v in (("open", o), ("high", h), ("low", l), ("close", c)):
        if v > dh * RATIO or v < dl / RATIO:
            bad.append(name)
    return bad


def converge(bar, bad):
    """同 bar 有界收敛（顺序：close → open → high → low → 保不变量）"""
    o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]
    if "close" in bad:
        c = o
    if "open" in bad:
        o = c
    if "high" in bad:
        h = max(o, c, l)
    if "low" in bad:
        l = min(o, c, h)
    h = max(o, h, l, c)
    l = min(o, h, l, c)
    return {"open": round(o, 4), "high": round(h, 4),
            "low": round(l, 4), "close": round(c, 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True,
                    help="缺陷清单 JSON（含 code/tradeDate/time）")
    ap.add_argument("--apply", action="store_true", help="实际写盘（默认干跑）")
    ap.add_argument("--backup-tag", default=None)
    ap.add_argument("--ratio", type=float, default=None,
                    help="越界倍数阈值。默认 1.5（硬缺陷）；按「事故成员」界定范围时设 1.0"
                         "（任何越界都收敛，适用于已确认整段源端损坏的日期+板块）")
    args = ap.parse_args()

    global RATIO
    if args.ratio is not None:
        RATIO = args.ratio

    man = json.load(open(args.manifest, encoding="utf-8"))
    items = man["defects"] if isinstance(man, dict) else man
    log("== 30m 污染 bar 修复（规则 %s，阈值 %.1f×，模式 %s）=="
        % (RULE_VERSION, RATIO, "APPLY" if args.apply else "DRY-RUN"))
    log("清单：%s（%d 条）" % (args.manifest, len(items)))

    dayk = dayk_map()
    log("dev.db 日K：%d 只标的" % len(dayk))

    # 按 code 归组
    by_code = {}
    for it in items:
        by_code.setdefault(it["code"], []).append(it)

    tag = args.backup_tag or dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    bdir = os.path.join(DIR_BACKUP, "minutes_30_pre_repair_%s" % tag)
    os.makedirs(DIR_META, exist_ok=True)
    audit_fp = os.path.join(DIR_META, "kline_30m_repairs.jsonl")

    audit = []
    n_changed_rows = 0
    n_files = 0

    for code, its in sorted(by_code.items()):
        pq = os.path.join(DIR_MIN, "%s.parquet" % code)
        if not os.path.exists(pq):
            log("  ! 缺文件 %s" % pq); continue
        df = pd.read_parquet(pq)
        before = df.copy()
        idx = {(str(r.tradeDate), str(r.time)): i for i, r in df.iterrows()}

        touched = 0
        for it in its:
            d, t = str(it["tradeDate"]), str(it["time"])
            key = (d, t)
            if key not in idx:
                log("  ! %s %s %s 不在文件中" % (code, d, t)); continue
            i = idx[key]
            dh, dl = dayk[code][d]
            cur = {k: float(df.at[i, k]) for k in ("open", "high", "low", "close")}
            bad = classify(cur, dh, dl)
            if not bad:
                log("  ? %s %s %s 未检出污染（清单与实测不符），跳过" % (code, d, t)); continue
            new = converge(cur, bad)
            # 断言：收敛后必须在日K边界内
            assert dl <= new["low"] and new["high"] <= dh, \
                "%s %s %s 收敛后仍越界: %s vs [%s, %s]" % (code, d, t, new, dl, dh)
            for k in ("open", "high", "low", "close"):
                df.at[i, k] = new[k]
            df.at[i, "amount"] = round(new["close"] * float(df.at[i, "volume"]), 2)
            touched += 1
            audit.append({
                "code": code, "tradeDate": d, "time": t,
                "bad_fields": bad, "original": cur, "repaired": new,
                "db_day": {"high": dh, "low": dl},
                "rule": RULE_VERSION,
                "at": dt.datetime.now().isoformat(timespec="seconds"),
                "source": "sina_30m_raw (source-side corruption, all granularities)",
                "cross_source_injection": False,
            })

        if not touched:
            continue
        n_files += 1
        n_changed_rows += touched

        # 校验：行数不变、非目标行完全一致、每日仍 8 根
        assert len(df) == len(before), "行数变化"
        mask = df[["open", "high", "low", "close"]].ne(
            before[["open", "high", "low", "close"]]).any(axis=1)
        assert int(mask.sum()) == touched, "改动行数 %d != 预期 %d" % (int(mask.sum()), touched)
        cnt = df.groupby("tradeDate").size()
        assert int(cnt.min()) == 8 and int(cnt.max()) == 8, "每日根数异常"
        assert set(df["time"].unique()) <= set(STD_TIMES), "出现非标准时点"
        assert (df["high"] >= df["low"]).all(), "high<low"
        assert (df["high"] >= df[["open", "close"]].max(axis=1)).all(), "high 非最大"
        assert (df["low"] <= df[["open", "close"]].min(axis=1)).all(), "low 非最小"

        log("  %s: 收敛 %d 根（%d 行）" % (code, touched, len(df)))

        if args.apply:
            os.makedirs(bdir, exist_ok=True)
            shutil.copy2(pq, os.path.join(bdir, "%s.parquet" % code))
            tmp = pq + ".tmp.parquet"
            df.to_parquet(tmp, index=False, compression="zstd")
            os.replace(tmp, pq)

    log()
    log("触及标的：%d，收敛 bar：%d" % (n_files, n_changed_rows))
    if args.apply:
        with open(audit_fp, "a", encoding="utf-8") as f:
            for a in audit:
                f.write(json.dumps(a, ensure_ascii=False) + "\n")
        log("审计日志已追加：%s（+%d 行）" % (audit_fp, len(audit)))
        log("原始文件备份：%s" % bdir)
    else:
        log("（干跑，未写盘）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
