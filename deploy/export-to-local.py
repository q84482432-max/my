#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从服务器生产库导出数据为 JSON，供本机开发库同步。

背景
----
本机开发库常年落后于线上（线上有 market-update.timer 在日更）。本次做指数前端时
就撞上了：本机 `market_indices` / `index_klines` 两张表是空的，页面打开没数据，
`npm run test:index` 也会因「数据缺失」而失败（不是代码问题）。

为什么不直接拷整个 dev.db
------------------------
线上库 770MB+，而本次只需要其中两张小表（9 行 + 34,558 行）和个股的一小段增量。
导出 JSON 只有几 MB，传输和导入都快得多，也不会覆盖本机库里已有的东西。

用法（**在服务器上执行**）
------------------------
    python3 export-to-local.py --out /home/ubuntu/market-export.json
    python3 export-to-local.py --out /home/ubuntu/market-export.json --since 2026-09-11

`--since` 会附带导出 klines 表中 tradeDate >= 该日的**个股**增量行
（本机个股数据也常落后，补上才能让 test:index 的窗口断言通过）。

输出结构
--------
    {
      "meta": { "exportedAt", "dbPath", "since", "counts": {...} },
      "indices":      [ market_indices 全量 ],
      "indexKlines":  [ index_klines 全量 ],
      "klines":       [ klines 增量，未指定 --since 时为空数组 ]
    }
"""
import argparse
import datetime as dt
import decimal
import json
import sqlite3
import sys

DEFAULT_DB = "/home/ubuntu/app/prisma/dev.db"


def to_jsonable(v):
    """SQLite 取出的值转成可 JSON 序列化的形式。

    注意 DateTime 字段（tradeDate 等）在 SQLite 里存的是**整数毫秒时间戳**，
    这里保持整数原样 —— 导入端负责 ms -> Date 的换算，避免经过字符串日期
    往返导致时区偏移。
    """
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", "replace")
    if isinstance(v, decimal.Decimal):
        return float(v)
    return v


def rows_to_dicts(cur):
    cols = [d[0] for d in cur.description]
    return [
        dict((c, to_jsonable(v)) for c, v in zip(cols, tuple(r)))
        for r in cur.fetchall()
    ]


def date_to_ms(s):
    """YYYY-MM-DD -> 当日 00:00 的毫秒时间戳（本地时区，与库内写法一致）"""
    d = dt.datetime.strptime(s, "%Y-%m-%d")
    return int(d.timestamp() * 1000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite 库路径")
    ap.add_argument("--out", required=True, help="输出的 JSON 路径")
    ap.add_argument("--since", default=None, help="个股增量起始日 YYYY-MM-DD（闭区间）")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    cur = conn.cursor()

    indices = rows_to_dicts(cur.execute("SELECT * FROM market_indices ORDER BY code"))
    index_klines = rows_to_dicts(
        cur.execute("SELECT * FROM index_klines ORDER BY indexId, tradeDate")
    )

    klines = []
    if args.since:
        ms = date_to_ms(args.since)
        klines = rows_to_dicts(
            cur.execute("SELECT * FROM klines WHERE tradeDate >= ? ORDER BY tradeDate", (ms,))
        )

    obj = {
        "meta": {
            "exportedAt": dt.datetime.now().isoformat(timespec="seconds"),
            "dbPath": args.db,
            "since": args.since,
            "counts": {
                "indices": len(indices),
                "indexKlines": len(index_klines),
                "klines": len(klines),
            },
        },
        "indices": indices,
        "indexKlines": index_klines,
        "klines": klines,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)

    print("导出完成 -> %s" % args.out)
    for k, v in obj["meta"]["counts"].items():
        print("  %-12s %d 行" % (k, v))

    # 抽样打印一行，便于肉眼核对字段名与类型
    if indices:
        print("\n样例 indices  : %s" % json.dumps(indices[0], ensure_ascii=False)[:240])
    if index_klines:
        print("样例 indexKline: %s" % json.dumps(index_klines[0], ensure_ascii=False)[:240])
    if klines:
        print("样例 klines    : %s" % json.dumps(klines[0], ensure_ascii=False)[:240])

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
