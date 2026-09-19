#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""指数隔离的 SQL 级审计（只读）

断言的核心契约：指数与个股**双向不可见**。
"""
import sqlite3
import datetime as dt

DB = "file:/home/ubuntu/app/prisma/dev.db?mode=ro"
con = sqlite3.connect(DB, uri=True)
c = con.cursor()

ok = bad = 0
fails = []


def check(name, cond, detail=""):
    global ok, bad
    if cond:
        ok += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        bad += 1
        fails.append(name)
        print(f"  \033[31m✗\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))


def one(sql, args=()):
    c.execute(sql, args)
    return c.fetchone()


def fmt(v):
    return dt.datetime.utcfromtimestamp(v / 1000).strftime("%Y-%m-%d") if v else None


def section(t):
    print(f"\n\033[1m\033[36m── {t} ──\033[0m")


print("\033[1m指数隔离 SQL 审计\033[0m")

section("一、表结构")
tabs = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
check("market_indices 存在", "market_indices" in tabs)
check("index_klines 存在", "index_klines" in tabs)
check("stocks / klines 仍存在", "stocks" in tabs and "klines" in tabs)

section("二、个股侧未被改动")
n_stock = one("SELECT COUNT(*) FROM stocks")[0]
n_kline = one("SELECT COUNT(*) FROM klines")[0]
lo, hi = one("SELECT MIN(tradeDate), MAX(tradeDate) FROM klines")
check("stocks = 5558", n_stock == 5558, f"实际 {n_stock}")
check("klines = 2379962", n_kline == 2379962, f"实际 {n_kline}")
check("窗口 = 2024-11-04 → 2026-09-18",
      fmt(lo) == "2024-11-04" and fmt(hi) == "2026-09-18",
      f"实际 {fmt(lo)} → {fmt(hi)}")

leak = one("SELECT COUNT(*) FROM stocks WHERE code LIKE 'sh%' OR code LIKE 'sz%' "
           "OR code LIKE 'bj%'")[0]
check("stocks 中无带前缀代码（指数未混入）", leak == 0, f"命中 {leak}")

section("三、板块与复权口径未被污染")
rows = c.execute("SELECT board, COUNT(*) FROM stocks GROUP BY board ORDER BY board").fetchall()
board_sum = sum(r[1] for r in rows)
check("板块取值只在 MAIN/GEM/STAR/BSE",
      all(r[0] in ("MAIN", "GEM", "STAR", "BSE") for r in rows),
      str([r[0] for r in rows]))
check("板块计数之和 = 5558", board_sum == 5558, f"实际 {board_sum}")
adj = dict(c.execute("SELECT adjust, COUNT(*) FROM stocks GROUP BY adjust").fetchall())
check("复权口径 qfq 5430 / none 128",
      adj.get("qfq") == 5430 and adj.get("none") == 128, str(adj))

section("四、指数侧完整性")
n_idx = one("SELECT COUNT(*) FROM market_indices")[0]
n_ik = one("SELECT COUNT(*) FROM index_klines")[0]
check("指数条数 = 9", n_idx == 9, f"实际 {n_idx}")
check("指数 K 线 = 34558", n_ik == 34558, f"实际 {n_ik}")
check("barCount 之和 = index_klines 行数",
      one("SELECT SUM(barCount) FROM market_indices")[0] == n_ik)

orphan = one("SELECT COUNT(*) FROM index_klines WHERE indexId NOT IN "
             "(SELECT id FROM market_indices)")[0]
check("无孤儿行", orphan == 0, f"实际 {orphan}")

dup = one("SELECT COUNT(*) FROM (SELECT indexId, tradeDate FROM index_klines "
          "GROUP BY indexId, tradeDate HAVING COUNT(*)>1)")[0]
check("(indexId, tradeDate) 无重复", dup == 0, f"实际 {dup}")

bad_prefix = one("SELECT COUNT(*) FROM market_indices WHERE code NOT LIKE 'sh%' "
                 "AND code NOT LIKE 'sz%' AND code NOT LIKE 'bj%'")[0]
check("指数代码全部带交易所前缀", bad_prefix == 0, f"异常 {bad_prefix}")

# 每个指数的实际 K 线根数要和声称的一致
mis = c.execute("""
    SELECT m.code, m.barCount, COUNT(k.id) FROM market_indices m
    LEFT JOIN index_klines k ON k.indexId = m.id
    GROUP BY m.id HAVING m.barCount <> COUNT(k.id)""").fetchall()
check("每个指数 barCount 与实际 K 线数一致", len(mis) == 0, str(mis))

section("五、与主库窗口对齐")
c.execute("""SELECT m.code, COUNT(*) FROM market_indices m
             JOIN index_klines k ON k.indexId = m.id
             WHERE k.tradeDate BETWEEN ? AND ? GROUP BY m.id""",
          (int(dt.datetime(2024, 11, 4, tzinfo=dt.timezone.utc).timestamp() * 1000),
           int(dt.datetime(2026, 9, 18, 23, 59, 59, tzinfo=dt.timezone.utc).timestamp() * 1000)))
win = c.execute("""SELECT m.code, m.name, COUNT(*) FROM market_indices m
                   JOIN index_klines k ON k.indexId = m.id
                   WHERE k.tradeDate BETWEEN ? AND ? GROUP BY m.id ORDER BY m.code""",
                (int(dt.datetime(2024, 11, 4, tzinfo=dt.timezone.utc).timestamp() * 1000),
                 int(dt.datetime(2026, 9, 18, 23, 59, 59, tzinfo=dt.timezone.utc).timestamp() * 1000))).fetchall()
check("9 个指数都在主库窗口内", len(win) == 9, f"实际 {len(win)}")
check("每个指数窗口内均恰好 459 根", all(r[2] == 459 for r in win),
      " ".join(f"{r[0]}:{r[2]}" for r in win))

section("六、抽样校验真实点位")
# 上证指数 2026-09-18 收盘价，应与新浪/腾讯公开行情一致
row = one("""SELECT k.close, k.open, k.high, k.low FROM market_indices m
             JOIN index_klines k ON k.indexId = m.id
             WHERE m.code='sh000001' AND k.tradeDate=?""",
          (int(dt.datetime(2026, 9, 18, tzinfo=dt.timezone.utc).timestamp() * 1000),))
check("上证指数 2026-09-18 有数据", row is not None,
      f"收盘 {row[0]} 开 {row[1]} 高 {row[2]} 低 {row[3]}" if row else "")
if row:
    check("high >= low", float(row[2]) >= float(row[3]))
    check("close 在 [low, high] 内", float(row[3]) <= float(row[0]) <= float(row[2]))

section("七、完整性")
check("integrity_check = ok", c.execute("PRAGMA integrity_check").fetchone()[0] == "ok")

con.close()
print(f"\n\033[1m结果：\033[32m{ok} 通过\033[0m / \033[31m{bad} 失败\033[0m")
if fails:
    print("失败项：" + ", ".join(fails))
