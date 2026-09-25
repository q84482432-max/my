#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生产库 schema 迁移：为 sim_trade_sessions 补齐 V3 字段（幂等、纯增量）。

背景
    V3 引入了三组新能力，对应 6 个新列：
      * 每日总操作计数（BUY/SELL/HOLD 统一计数，上限 8）      -> operationCountToday
      * 30m 时间轴游标（当日已揭示的 30m K 根数，1~8）        -> intradayBarCount
      * 确认模式 pending（pending → confirm → execute）        -> pendingAction /
        pendingPercent / pendingStage / pendingDate

    `deploy/deploy-inplace.sh` 出于「防覆盖生产库」的设计**从不同步 prisma/**，
    因此 schema 变更必须单独上服务器。顺序（V2 事故复盘已写死在 deploy-inplace.sh）：
        ① 先给物理表 ADD COLUMN  ② 同步 schema  ③ 再 prisma generate
    三步缺一不可、顺序不能颠倒；本脚本负责第 ① 步。

用法（在服务器上执行）
    python3 migrate-simtrade-v3.py [--db /home/ubuntu/app/prisma/dev.db] [--dry-run]

设计原则
    * **纯增量**：只 ADD COLUMN，不改动/删除任何现有列，不触碰 orders / trades / accounts。
    * **幂等**：列已存在则跳过；可重复执行。
    * **可干跑**：--dry-run 只打印将要做的变更。
    * **不臆造历史**：`operationCountToday` 一律从 0 起。
      V2 的 HOLD 不计数，用 buyCountToday + sellCountToday 反推会**低估**当日已用操作，
      反而让老会话白拿额度；从 0 起是「对玩家宽松、且不会锁死老会话」的唯一安全选择。
      （老会话数量极少，且本列在进入新交易日时本就会重置。）
    * `intradayBarCount` 用默认 1；服务层对「已进入收盘揭示之后」的阶段会强制读作 8，
      因此老会话在 DAY_SETTLED / CLOSE_ANIMATION 下不会只返回 1 根。
"""
import argparse
import sqlite3
import sys

DEFAULT_DB = "/home/ubuntu/app/prisma/dev.db"

NEW_COLS = [
    # (列名, DDL)
    ("operationCountToday", "INTEGER NOT NULL DEFAULT 0"),
    ("intradayBarCount", "INTEGER NOT NULL DEFAULT 1"),
    ("pendingAction", "TEXT"),
    ("pendingPercent", "INTEGER"),
    ("pendingStage", "TEXT"),
    ("pendingDate", "DATETIME"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite 生产库路径")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要做的变更")
    args = ap.parse_args()

    c = sqlite3.connect(args.db)
    print("库: %s" % args.db)

    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "sim_trade_sessions" not in tables:
        print("FATAL: 表 sim_trade_sessions 不存在，库路径可能不对")
        return 1

    before_rows = c.execute("SELECT COUNT(*) FROM sim_trade_sessions").fetchone()[0]
    before_tables = len(tables)
    others_before = {
        t: c.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
        for t in ("accounts", "orders", "trades")
        if t in tables
    }

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

    print("=== [2] 验证（列结构 / 行数 / 其它表未受影响）===")
    cols = [r[1] for r in c.execute("PRAGMA table_info(sim_trade_sessions)")]
    missing = [n for n, _ in NEW_COLS if n not in cols]
    print("  缺失列: %s %s" % (missing if missing else "无", "" if not missing else "!!! 仍缺列 !!!"))

    after_rows = c.execute("SELECT COUNT(*) FROM sim_trade_sessions").fetchone()[0]
    print("  sim_trade_sessions 行数: %d -> %d %s"
          % (before_rows, after_rows, "OK" if before_rows == after_rows else "!!! 行数变化 !!!"))

    after_tables = len({r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")})
    print("  表数量: %d -> %d %s"
          % (before_tables, after_tables, "OK" if before_tables == after_tables else "!!! 表数量变化 !!!"))

    ok_others = True
    for t, n in others_before.items():
        now = c.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
        if now != n:
            ok_others = False
            print("  %s 行数: %d -> %d !!! 变化 !!!" % (t, n, now))
    if ok_others:
        print("  accounts / orders / trades 行数均未变: OK")

    print("=== [3] 新列默认值分布（确认可读、无 NULL 破坏）===")
    if missing:
        # dry-run（或列仍缺失）时新列并不存在，此处**必须跳过** ——
        # 否则 SELECT 会以 "no such column" 崩掉，让一次本该成功的干跑变成报错。
        print("  跳过：新列尚不存在（dry-run 或仍未创建），不做分布统计")
    else:
        for r in c.execute(
            "SELECT status, stage, operationCountToday, intradayBarCount, "
            "CASE WHEN pendingAction IS NULL THEN 'none' ELSE pendingAction END, COUNT(*) n "
            "FROM sim_trade_sessions GROUP BY 1,2,3,4,5"
        ):
            print("  status=%s stage=%s ops=%s intraday=%s pending=%s n=%s" % tuple(r))

    print("=== [4] 最终列结构 ===")
    print("  " + ",".join(cols))

    bad = bool(missing) or before_rows != after_rows or before_tables != after_tables or not ok_others
    return 1 if (bad and not args.dry_run) else 0


if __name__ == "__main__":
    sys.exit(main())
