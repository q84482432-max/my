#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dev.db 在线备份（SQLite Online Backup API）
======================================================================
特点：
  - 用 sqlite3 的 backup() 接口，可与正在运行的 Next.js 应用并发，不锁库、不中断服务
  - 备份后立刻做 PRAGMA integrity_check + klines 行数核对
  - 压缩为 .gz（799MB → 约 187MB），压缩成功才删除未压缩副本
  - 滚动保留最近 KEEP 份
  - 源库自上次备份后未变更则跳过 —— 节假日/停更日不产生重复副本，不挤占保留位
用法：
  python3 db-backup.py            # 正常备份（源库未变则自动跳过）
  python3 db-backup.py --force    # 忽略"未变更"检查，强制备份
  python3 db-backup.py --check    # 只列出现有备份，不新建
======================================================================
"""

import datetime
import glob
import gzip
import os
import shutil
import sqlite3
import sys
import time

SRC = "/home/ubuntu/app/prisma/dev.db"
DESTDIR = "/home/ubuntu/backup"
PREFIX = "dev.db.daily-"
KEEP = 14
STATE = os.path.join(DESTDIR, ".last-src-state")


def log(msg):
    print("[%s] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


def list_backups():
    return sorted(glob.glob(os.path.join(DESTDIR, PREFIX + "*.gz")))


def src_state():
    """源库指纹：mtime + size。任一变化都说明数据被写过。"""
    st = os.stat(SRC)
    return "%d %d" % (int(st.st_mtime), st.st_size)


def read_prev_state():
    try:
        with open(STATE, "r") as f:
            return f.read().strip()
    except Exception:
        return ""


def write_state(v):
    try:
        with open(STATE, "w") as f:
            f.write(v)
    except Exception as e:
        log("  警告：状态文件写入失败 %s" % e)


def main():
    os.makedirs(DESTDIR, exist_ok=True)

    if "--check" in sys.argv:
        files = list_backups()
        log("现有备份 %d 份：" % len(files))
        for f in files:
            log("   %s  %.1f MB" % (os.path.basename(f), os.path.getsize(f) / 1048576.0))
        log("源库指纹: %s   上次备份时: %s"
            % (src_state(), read_prev_state() or "(无记录)"))
        return

    t0 = time.time()

    # 0) 源库未变更则跳过（节假日常见）
    cur_state = src_state()
    prev_state = read_prev_state()
    if cur_state == prev_state and "--force" not in sys.argv:
        log("源库自上次备份后未变更（指纹 %s），跳过本次备份" % cur_state)
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    raw = os.path.join(DESTDIR, PREFIX + stamp)
    gz = raw + ".gz"

    # 1) 在线备份
    log("开始在线备份 %s -> %s" % (SRC, raw))
    src = sqlite3.connect("file:%s?mode=ro" % SRC, uri=True, timeout=60)
    dst = sqlite3.connect(raw)
    try:
        with dst:
            src.backup(dst)
    finally:
        dst.close()
        src.close()
    size = os.path.getsize(raw)
    log("  备份完成 %.1f MB  耗时 %.1fs" % (size / 1048576.0, time.time() - t0))

    # 2) 完整性校验
    con = sqlite3.connect("file:%s?mode=ro" % raw, uri=True)
    cur = con.cursor()
    cur.execute("PRAGMA integrity_check")
    integ = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM klines WHERE period='1d'")
    n_k = cur.fetchone()[0]
    cur.execute("SELECT MAX(tradeDate) FROM klines WHERE period='1d'")
    mx = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM stocks")
    n_s = cur.fetchone()[0]
    con.close()
    last = datetime.datetime.fromtimestamp(mx / 1000, datetime.timezone.utc).strftime("%Y-%m-%d") if mx else "-"
    log("  校验: integrity=%s  klines(1d)=%d  stocks=%d  最新交易日=%s" % (integ, n_k, n_s, last))
    if integ != "ok" or n_k < 1000000:
        log("  !! 校验未通过，保留未压缩副本以供排查：%s" % raw)
        return 2

    # 3) 压缩（流式，不吃内存）
    log("  压缩中 ...")
    with open(raw, "rb") as fi, gzip.open(gz, "wb", compresslevel=6) as fo:
        shutil.copyfileobj(fi, fo, 1024 * 1024)
    gsize = os.path.getsize(gz)
    log("  压缩完成 %.1f MB (%.0f%%)" % (gsize / 1048576.0, gsize * 100.0 / size))
    os.remove(raw)

    # 3.5) 记录本次备份时的源库指纹
    #      故意写"备份开始前"读到的值：若备份窗口内源库又被写入，
    #      下次运行会检出差异并重新备份，安全方向是对的。
    write_state(cur_state)

    # 4) 滚动保留
    files = list_backups()
    for old in files[:-KEEP]:
        os.remove(old)
        log("  清理旧备份 %s" % os.path.basename(old))
    log("  当前保留 %d 份，共 %.1f MB"
        % (len(files[-KEEP:]), sum(os.path.getsize(f) for f in files[-KEEP:]) / 1048576.0))
    log("备份完成，总耗时 %.1fs" % (time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
