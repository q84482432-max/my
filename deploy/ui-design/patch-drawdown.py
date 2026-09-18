#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修复「最大回撤起始日」Bug —— Next.js 编译产物补丁

病根
    /api/backtest/[id] 的序列化逻辑把 maxDrawdownStart 赋成了「全区间最高点日期」，
    而不是「本次回撤开始前的运行峰值日期」。于是会出现起始日晚于结束日的荒谬值。
    实测（平安银行 MA5/MA20 · 2026-03-02~2026-09-17）：
        API 返回 2026-07-31 → 2026-06-25   ← 起始日晚于结束日
        正确��   2026-06-12 → 2026-06-25

修法
    与同文件内引擎已有的正确实现（模块 72406 的 OL 函数）保持完全同一语义：
    遍历时维护「运行峰值」及其日期，遇到更深的回撤时，
    把当前的运行峰值日记为起始日、把当日记为结束日。

安全性
    - 精确字符串匹配，要求恰好出现 1 次，否则中止不动
    - 改动前备份原文件到带时间戳的目录
    - 写入同目录临时 .js 文件后 node --check 语法校验，通过才原子替换
    - 任一环节失败，原文件保持不变
"""
import os
import shutil
import subprocess
import sys
import time

OLD = (
    "if(s<0){let a=-1/0,b=null,c=null;"
    "for(let d of k)d.totalAsset>a&&(a=d.totalAsset,b=d.date),"
    "d.drawdownPercent===s&&null===c&&(c=d.date);"
    "j.maxDrawdownStart=b,j.maxDrawdownEnd=c}"
)

NEW = (
    "if(s<0&&k.length>0){"
    "let __ddPeak=k[0].totalAsset,__ddPeakDate=k[0].date,"
    "__ddStart=null,__ddEnd=null,__ddWorst=0;"
    "for(let __ddItem of k){"
    "__ddItem.totalAsset>__ddPeak&&(__ddPeak=__ddItem.totalAsset,__ddPeakDate=__ddItem.date);"
    "let __ddCur=__ddPeak>0?(__ddItem.totalAsset-__ddPeak)/__ddPeak*100:0;"
    "__ddCur<__ddWorst&&(__ddWorst=__ddCur,__ddStart=__ddPeakDate,__ddEnd=__ddItem.date)}"
    "j.maxDrawdownStart=__ddStart,j.maxDrawdownEnd=__ddEnd}"
)

TARGETS = [
    "/home/ubuntu/app/.next/server/chunks/75.js",
    "/home/ubuntu/app/.next/standalone/.next/server/chunks/75.js",
]
BACKUP_DIR = "/home/ubuntu/backup/drawdown-fix-" + time.strftime("%Y%m%d-%H%M%S")


def find_node():
    for c in ("node", "/opt/node/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if os.sep in c:
            if os.path.exists(c):
                return c
        else:
            p = shutil.which(c)
            if p:
                return p
    return None


def main():
    apply = "--apply" in sys.argv
    node = find_node()
    print("node       =", node)
    print("backup dir =", BACKUP_DIR)
    print("mode       =", "APPLY" if apply else "DRY-RUN")
    print()

    os.makedirs(BACKUP_DIR, exist_ok=True)
    ok = True
    changed = 0

    for path in TARGETS:
        print("=" * 64)
        print("target:", path)
        if not os.path.exists(path):
            print("  SKIP  文件不存在")
            continue

        text = open(path, "rb").read().decode("utf-8")
        n_old = text.count(OLD)
        n_new = text.count(NEW)
        print("  size         =", len(text))
        print("  OLD 出现次数 =", n_old)
        print("  NEW 出现次数 =", n_new)

        if n_new == 1 and n_old == 0:
            print("  SKIP  补丁已应用过")
            continue
        if n_old != 1:
            print("  ABORT OLD 字符串不唯一，拒绝修改")
            ok = False
            continue

        patched = text.replace(OLD, NEW)

        if not apply:
            print("  DRY-RUN  将替换 1 处")
            continue

        shutil.copy2(path, os.path.join(BACKUP_DIR, path.strip("/").replace("/", "_")))
        print("  备份完成")

        tmp = path + ".tmp-patch-%d.js" % os.getpid()
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(patched)

            if node:
                r = subprocess.run([node, "--check", tmp],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    print("  ABORT node --check 失败，原文件未改动")
                    print(r.stdout, r.stderr)
                    ok = False
                    continue
                print("  node --check = OK")
            else:
                print("  WARN  未找到 node，跳过语法校验")

            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

        after = open(path, "rb").read().decode("utf-8")
        print("  替换后 OLD 剩余 =", after.count(OLD), " NEW 出现 =", after.count(NEW))
        print("  已写入:", path)
        changed += 1

    print("=" * 64)
    print("RESULT:", "OK" if ok else "FAILED", " 已修改文件数:", changed)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
