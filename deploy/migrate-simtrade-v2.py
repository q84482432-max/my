#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生产库 schema 迁移：为 sim_trade_sessions 补齐 V2 阶段状态机字段（幂等）。

背景（2026-09-22 事故复盘）
    线上 V2 代码引用了 `stage` 等 6 个字段，但 `deploy/deploy-inplace.sh` 出于
    「防覆盖生产库」的设计**从不同步 prisma/**，导致 V2 的 schema 变更一直没上服务器。
    部署新构建后所有走库的接口报：
        Unknown field `stage` for select statement on model `SimTradeSession`
    而 Prisma Client 是照服务器旧 schema 生成的，所以光重新 generate 也修不好 ——
    **必须先给物理表加列，再同步 schema，最后 generate**（三步缺一不可，顺序不能颠倒）。

用法（在服务器上执行）
    python3 migrate-simtrade-v2.py [--db /home/ubuntu/app/prisma/dev.db] [--dry-run]

设计原则
    * 纯增量：只 ADD COLUMN，不改动/删除任何现有列，不触碰 orders/trades/accounts。
    * 幂等：列已存在则跳过；回填按主键覆盖，可重复执行。
    * 可干跑：--dry-run 只打印将要做的变更。
    * 语义回填依据（实测 11 行存量数据）：
        - confirmedDate 与 currentDate 同日 → 当日已收盘确认 → DAY_SETTLED
        - 否则（含 confirmedDate 为 NULL）  → 停在当日开盘阶段 → OPEN
    * 注意：Prisma 的 DateTime 在 SQLite 中存**毫秒级** Unix 时间戳，
      不能用 SQLite 的 date() 直接判定同日（会把毫秒数当秒/儒略日），故在 Python 侧换算。
"""
import argparse
import datetime
import sqlite3
import sys

DEFAULT_DB = "/home/ubuntu/app/prisma/dev.db"

NEW_COLS = [
    ("stage", "TEXT NOT NULL DEFAULT 'OPEN'"),
    ("stageActionCompleted", "BOOLEAN NOT NULL DEFAULT 0"),
    ("stageActionAt", "DATETIME"),
    ("buyCountToday", "INTEGER NOT NULL DEFAULT 0"),
    ("sellCountToday", "INTEGER NOT NULL DEFAULT 0"),
    ("pool", "TEXT NOT NULL DEFAULT 'STOCK'"),
]


def dstr(v):
    """毫秒级 Unix 时间戳 → 'YYYY-MM-DD'（UTC）。"""
    if v is None:
        return None
    try:
        return datetime.datetime.utcfromtimestamp(int(v) / 1000).strftime("%Y-%m-%d")
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite 生产库路径")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要做的变更")
    args = ap.parse_args()

    c = sqlite3.connect(args.db)
    print("库: %s" % args.db)

    # ---- 前置断言：确认表存在 ----
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "sim_trade_sessions" not in tables:
        print("FATAL: 表 sim_trade_sessions 不存在，库路径可能不对")
        return 1

    before_rows = c.execute("SELECT COUNT(*) FROM sim_trade_sessions").fetchone()[0]

    # ---- [1] ADD COLUMN ----
    print("=== [1] ADD COLUMN ===")
    existing = {r[1] for r in c.execute("PRAGMA table_info(sim_trade_sessions)")}
    todo = [(n, d) for n, d in NEW_COLS if n not in existing]
    for name, _ in NEW_COLS:
        print("  %s %s" % ("SKIP (已存在):" if name in existing else "TO ADD:", name))
    if args.dry_run:
        print("  [dry-run] 跳过实际写入")
    else:
        for name, ddl in todo:
            c.execute("ALTER TABLE sim_trade_sessions ADD COLUMN %s %s" % (name, ddl))
        c.commit()
        print("  新增列数: %d" % len(todo))

    # ---- [2] 回填 stage 语义 ----
    print("=== [2] 回填 stage 语义 ===")
    plan_settled = plan_open = 0
    for sid, cur, conf in list(
        c.execute("SELECT id, currentDate, confirmedDate FROM sim_trade_sessions")
    ):
        same_day = conf is not None and cur is not None and dstr(conf) == dstr(cur)
        if same_day:
            plan_settled += 1
            if not args.dry_run:
                c.execute(
                    "UPDATE sim_trade_sessions SET stage='DAY_SETTLED', stageActionCompleted=1, "
                    "buyCountToday=0, sellCountToday=0, pool='STOCK' WHERE id=?",
                    (sid,),
                )
        else:
            plan_open += 1
            if not args.dry_run:
                c.execute(
                    "UPDATE sim_trade_sessions SET stage='OPEN', stageActionCompleted=0, "
                    "buyCountToday=0, sellCountToday=0, pool='STOCK' WHERE id=?",
                    (sid,),
                )
    if not args.dry_run:
        c.commit()
    print("  DAY_SETTLED: %d | OPEN: %d" % (plan_settled, plan_open))

    # ---- [3] 验证 ----
    print("=== [3] 验证 ===")
    after_rows = c.execute("SELECT COUNT(*) FROM sim_trade_sessions").fetchone()[0]
    print("  sim_trade_sessions 行数: %d -> %d %s" % (before_rows, after_rows, "OK" if before_rows == after_rows else "!!! 行数变化 !!!"))
    for r in c.execute(
        "SELECT status, stage, stageActionCompleted, pool, COUNT(*) n "
        "FROM sim_trade_sessions GROUP BY status, stage, stageActionCompleted, pool"
    ):
        print("  status=%s stage=%s done=%s pool=%s n=%s" % tuple(r))
    print("  accounts=%d orders=%d trades=%d" % (
        c.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
        c.execute("SELECT COUNT(*) FROM orders").fetchone()[0],
        c.execute("SELECT COUNT(*) FROM trades").fetchone()[0],
    ))
    print("=== [4] 最终列结构 ===")
    print("  " + ",".join(r[1] for r in c.execute("PRAGMA table_info(sim_trade_sessions)")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
