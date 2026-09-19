#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把指数数据导入生产库的**独立表** market_indices / index_klines

设计要点（与个股物理隔离）：
  · 新表，不动 stocks / klines 一行
  · 表结构与 Prisma 生成的 DDL 严格一致（含引号 camelCase、索引命名、外键）
  · tradeDate 按毫秒时间戳存储，与 klines.tradeDate 口径一致
  · id 用确定性字符串（idx_<code> / ik_<code>_<date>），保证可重复执行幂等
  · 先 DROP 该指数的旧 K 线再插入，等价 upsert，避免脏数据累积

用法：
  python3 import_indices.py            # 建表 + 导入
  python3 import_indices.py --check     # 只读校验，不写库
"""
import json
import os
import sqlite3
import sys
import time
import datetime as dt

DB = "/home/ubuntu/app/prisma/dev.db"
SRC_DIR = "/home/ubuntu/index_data"

# 分类归属（覆盖人工确认，避免把「创业板指」误当规模指数）
CATEGORY = {
    "sh000001": "综合指数",   # 上证指数
    "sz399001": "综合指数",   # 深证成指
    "sz399006": "板块指数",   # 创业板指
    "sh000300": "规模指数",   # 沪深300
    "sh000905": "规模指数",   # 中证500
    "sh000852": "规模指数",   # 中证1000
    "sh000016": "规模指数",   # 上证50
    "sh000688": "板块指数",   # 科创50
    "bj899050": "板块指数",   # 北证50
}

# 与 Prisma 生成的 SQLite DDL 保持一致：引号 camelCase 列名 / 索引命名 / 外键
DDL = [
    """CREATE TABLE IF NOT EXISTS "market_indices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '综合指数',
    "source" TEXT NOT NULL DEFAULT 'sina',
    "barCount" INTEGER NOT NULL DEFAULT 0,
    "windowStart" DATETIME,
    "windowEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS "index_klines" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "indexId" TEXT NOT NULL,
    "tradeDate" DATETIME NOT NULL,
    "open" DECIMAL NOT NULL,
    "high" DECIMAL NOT NULL,
    "low" DECIMAL NOT NULL,
    "close" DECIMAL NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "index_klines_indexId_fkey" FOREIGN KEY ("indexId") REFERENCES "market_indices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)""",
    'CREATE UNIQUE INDEX IF NOT EXISTS "market_indices_code_key" ON "market_indices"("code")',
    'CREATE INDEX IF NOT EXISTS "market_indices_name_idx" ON "market_indices"("name")',
    'CREATE INDEX IF NOT EXISTS "market_indices_exchange_idx" ON "market_indices"("exchange")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "index_klines_indexId_tradeDate_key" ON "index_klines"("indexId", "tradeDate")',
    'CREATE INDEX IF NOT EXISTS "index_klines_tradeDate_idx" ON "index_klines"("tradeDate")',
]


def ms(d):
    """YYYYMMDD → 毫秒时间戳（UTC 零点），与 klines.tradeDate 存储口径一致"""
    return int(dt.datetime(int(d[:4]), int(d[4:6]), int(d[6:8]),
                           tzinfo=dt.timezone.utc).timestamp() * 1000)


def load_files():
    out = []
    for fn in sorted(os.listdir(SRC_DIR)):
        if fn.startswith("index_") and fn.endswith(".json"):
            with open(os.path.join(SRC_DIR, fn), encoding="utf-8") as f:
                out.append(json.load(f))
    return out


def check():
    con = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    c = con.cursor()
    tabs = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    print("表是否存在: market_indices=%s  index_klines=%s"
          % ("market_indices" in tabs, "index_klines" in tabs))
    print("\n=== 个股侧（必须与导入前完全一致）===")
    print("  stocks =", c.execute("SELECT COUNT(*) FROM stocks").fetchone()[0])
    print("  klines =", c.execute("SELECT COUNT(*) FROM klines").fetchone()[0])
    lo, hi = c.execute("SELECT MIN(tradeDate), MAX(tradeDate) FROM klines").fetchone()
    fmt = lambda v: dt.datetime.utcfromtimestamp(v / 1000).strftime("%Y-%m-%d") if v else None
    print("  窗口 =", fmt(lo), "→", fmt(hi))
    print("\n=== 指数侧 ===")
    if "market_indices" in tabs:
        rows = c.execute('SELECT code,name,category,barCount,windowStart,windowEnd '
                         'FROM market_indices ORDER BY code').fetchall()
        tot = 0
        for code, name, cat, bc, ws, we in rows:
            tot += bc
            print("  %-10s %-8s %-6s %5d 根  %s → %s"
                  % (code, name, cat, bc, fmt(ws), fmt(we)))
        print("  指数条数 =", len(rows), " K线合计 =", tot)
        real = c.execute("SELECT COUNT(*) FROM index_klines").fetchone()[0]
        print("  index_klines 实际行数 =", real, "（应与合计一致）")
        orphan = c.execute("SELECT COUNT(*) FROM index_klines WHERE indexId NOT IN "
                           "(SELECT id FROM market_indices)").fetchone()[0]
        print("  孤儿行 =", orphan)
    else:
        print("  （表尚未创建）")
    con.close()


def main():
    if "--check" in sys.argv:
        check()
        return

    data = load_files()
    if not data:
        print("✗ %s 下没有 index_*.json" % SRC_DIR)
        sys.exit(1)

    con = sqlite3.connect(DB)
    con.execute("PRAGMA foreign_keys = ON")
    c = con.cursor()
    now = dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    print("=== 建表 ===")
    for stmt in DDL:
        c.execute(stmt)
        print("  " + stmt.split('"')[1] + " / " + stmt.split()[-1])
    con.commit()

    print("\n=== 导入 ===")
    total = 0
    for j in data:
        code, name = j["symbol"], j["name"]
        rows = j["rows"]
        idx_id = "idx_%s" % code
        first, last = rows[0]["d"], rows[-1]["d"]

        c.execute(
            'INSERT INTO "market_indices" '
            '("id","code","name","exchange","category","source","barCount",'
            ' "windowStart","windowEnd","createdAt","updatedAt") '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?) '
            'ON CONFLICT("code") DO UPDATE SET '
            ' "name"=excluded."name", "exchange"=excluded."exchange", '
            ' "category"=excluded."category", "source"=excluded."source", '
            ' "barCount"=excluded."barCount", "windowStart"=excluded."windowStart", '
            ' "windowEnd"=excluded."windowEnd", "updatedAt"=excluded."updatedAt"',
            (idx_id, code, name, code[:2].upper(), CATEGORY.get(code, "综合指数"),
             j.get("source", "sina"), len(rows), ms(first), ms(last), now, now))
        c.execute('SELECT id FROM market_indices WHERE code=?', (code,))
        real_id = c.fetchone()[0]

        # 幂等：先清掉该指数的旧 K 线，再整段插入
        c.execute('DELETE FROM index_klines WHERE "indexId"=?', (real_id,))
        c.executemany(
            'INSERT INTO "index_klines" '
            '("id","indexId","tradeDate","open","high","low","close","volume","createdAt") '
            'VALUES (?,?,?,?,?,?,?,?,?)',
            [("ik_%s_%s" % (code, r["d"]), real_id, ms(r["d"]),
              r["o"], r["h"], r["l"], r["c"], int(r["v"]), now) for r in rows])
        total += len(rows)
        print("  %-10s %-8s %5d 根  %s → %s"
              % (code, name, len(rows), first, last))

    con.commit()
    print("\n导入完成：%d 个指数 / %d 根日K" % (len(data), total))
    con.close()


if __name__ == "__main__":
    main()
