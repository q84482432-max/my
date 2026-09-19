#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读核查线上 klines 表的数据覆盖区间（不写入、不加锁）"""
import sqlite3
import datetime as dt

DB = "file:/home/ubuntu/app/prisma/dev.db?mode=ro"
con = sqlite3.connect(DB, uri=True)
cur = con.cursor()

cur.execute("SELECT typeof(tradeDate) FROM klines WHERE period='1d' LIMIT 1")
kind = (cur.fetchone() or ["<空表>"])[0]
print(f"tradeDate 存储类型: {kind}")


def fmt(v):
    """兼容 Prisma 在 SQLite 里的 DateTime 存法（毫秒时间戳 / ISO 文本）"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return dt.datetime.utcfromtimestamp(v / 1000).strftime("%Y-%m-%d")
    return str(v)[:10]


def q(sql, args=()):
    cur.execute(sql, args)
    return cur.fetchone()


print("\n=== 日K (period='1d') 总览 ===")
lo, hi, n, nstk = q("SELECT MIN(tradeDate), MAX(tradeDate), COUNT(*), "
                    "COUNT(DISTINCT stockId) FROM klines WHERE period='1d'")
print(f"起始交易日 : {fmt(lo)}")
print(f"结束交易日 : {fmt(hi)}")
print(f"日K 总根数 : {n:,}")
print(f"覆盖股票数 : {nstk:,}")

print("\n=== 全表（含周K/月K） ===")
lo2, hi2, n2 = q("SELECT MIN(tradeDate), MAX(tradeDate), COUNT(*) FROM klines")
print(f"起始 {fmt(lo2)}  结束 {fmt(hi2)}  总计 {n2:,} 行")

print("\n=== 按周期拆分 ===")
for p, cnt, a, b in cur.execute(
        "SELECT period, COUNT(*), MIN(tradeDate), MAX(tradeDate) "
        "FROM klines GROUP BY period ORDER BY period").fetchall():
    print(f"  {p:<4} {cnt:>10,} 行   {fmt(a)} → {fmt(b)}")

print("\n=== 按年统计日K根数（看数据是否从某年才开始） ===")
for y, cnt, nstk2 in cur.execute(
        "SELECT strftime('%Y', tradeDate/1000, 'unixepoch') AS y, COUNT(*), "
        "COUNT(DISTINCT stockId) FROM klines WHERE period='1d' "
        "GROUP BY y ORDER BY y").fetchall():
    print(f"  {y} 年: {cnt:>10,} 根   涉及 {nstk2:,} 只")

print("\n=== 最早的 10 个交易日 ===")
for (d,) in cur.execute(
        "SELECT DISTINCT tradeDate FROM klines WHERE period='1d' "
        "ORDER BY tradeDate LIMIT 10").fetchall():
    print(f"  {fmt(d)}")

print("\n=== 最晚的 10 个交易日 ===")
for (d,) in cur.execute(
        "SELECT DISTINCT tradeDate FROM klines WHERE period='1d' "
        "ORDER BY tradeDate DESC LIMIT 10").fetchall():
    print(f"  {fmt(d)}")

print("\n=== 抽查：平安银行(000001) 的数据区间 ===")
row = q("SELECT s.code, MIN(k.tradeDate), MAX(k.tradeDate), COUNT(*) "
        "FROM klines k JOIN stocks s ON s.id = k.stockId "
        "WHERE s.code='000001' AND k.period='1d'")
if row and row[0]:
    print(f"  {row[0]}: {fmt(row[1])} → {fmt(row[2])}  共 {row[3]:,} 根")
else:
    print("  未找到 000001")

print("\n=== 复权口径分布 ===")
for a, cnt in cur.execute("SELECT adjust, COUNT(*) FROM klines "
                          "GROUP BY adjust").fetchall():
    print(f"  adjust={a:<6} {cnt:>10,} 行")

con.close()
