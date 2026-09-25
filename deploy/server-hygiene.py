#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""服务器卫生清理（task #43）。

设计原则：
  * 默认 dry-run，只打印计划；`--apply` 才真正动手。
  * **优先压缩而非删除**：体积大且回滚价值高的未压缩全量副本，改成 .gz 保留，
    不为了腾空间牺牲回滚能力。
  * 删除只针对「同日冗余备份」与「一次性脚本/旧构建」，且逐项列名。
  * gzip 用 -k 保留原文件 → `gzip -t` 校验通过 → 才删原文件（三步，任一步失败即中止）。
  * 绝不触碰：当前 .next、当前 server.js、今天的两份回滚备份、prisma/dev.db。

用法：
  python deploy/server-hygiene.py            # dry-run
  python deploy/server-hygiene.py --apply
  python deploy/server-hygiene.py --apply --install-pkgs
"""
import os
import sys

import paramiko

HOST = "111.229.225.7"
USER = "ubuntu"
PORT = 22
KEY = os.environ.get("ASHARE_SSH_KEY", os.path.expanduser("~/.ssh/ashare_ed25519"))

B = "/home/ubuntu/backup"
A = "/home/ubuntu/app"

# 1) 同日冗余日备份（只留当天最晚一份 223854）
DELETE_BACKUPS = [
    f"{B}/dev.db.daily-20260916-221620.gz",
    f"{B}/dev.db.daily-20260916-222312.gz",
]

# 2) 未压缩全量副本 → 压缩保留（不删）
GZIP_BACKUPS = [
    f"{B}/dev.db.pre-unitfix-20260916-214905",
    f"{B}/dev.db.pre-index-20260919-211152",
    f"{B}/dev.db.pre-v2schema-20260922-210837",
]

# 3) 旧构建目录（保留 .next 与今天的 .next.pre-deploy-20260922-210439）
DELETE_NEXT = [
    f"{A}/.next.bak",
    f"{A}/.next.pre-ui-20260918-204416",
    f"{A}/.next.pre-deploy-20260919-014546",
    f"{A}/.next.pre-deploy-20260919-014929",
    f"{A}/.next.pre-deploy-20260920-211205",
    f"{A}/.next.pre-deploy-20260920-224509",
]

# 4) 一次性脚本与旧产物（保留今天的 server.js.pre-deploy-20260922-210439
#    与 schema.prisma.bak-20260922-210837）
DELETE_MISC = [
    f"{A}/diag.js", f"{A}/diag2.js", f"{A}/diag3.js", f"{A}/diag4.js", f"{A}/diag5.js",
    f"{A}/fix-linux.sh", f"{A}/fix-linux.log",
    "/home/ubuntu/cc.cjs", "/home/ubuntu/cc2.cjs", "/home/ubuntu/cc3.cjs",
    "/home/ubuntu/cleanup.sh", "/home/ubuntu/cleanup-check.mjs",
    "/home/ubuntu/deep.mjs", "/home/ubuntu/check_all_backtests.py",
    "/home/ubuntu/ashare.bundle",
    "/home/ubuntu/ashare-inc.bundle", "/home/ubuntu/ashare-incr.bundle",
    "/home/ubuntu/ashare-incr2.bundle", "/home/ubuntu/ashare-incr3.bundle",
    "/home/ubuntu/ashare-incr4.bundle", "/home/ubuntu/ashare-incr5.bundle",
    "/home/ubuntu/ashare-incr6.bundle",
    "/home/ubuntu/ashare-src-20260918.tar.gz", "/home/ubuntu/ashare-src-20260919.tar.gz",
    "/home/ubuntu/deploy-bundle.tar.gz",
    f"{A}/server.js.pre-deploy-20260919-014546",
    f"{A}/server.js.pre-deploy-20260919-014929",
    f"{A}/server.js.pre-deploy-20260920-211205",
    f"{A}/server.js.pre-deploy-20260920-224509",
    f"{A}/prisma/schema.prisma.bak-20260920-211805",
    f"{A}/prisma/schema.prisma.bak-20260920-211814",
]

FAIL2BAN_CONF = """[DEFAULT]
# 封禁 1 小时起步，反复触发则指数级加长（最长 5 周）
bantime  = 1h
findtime = 10m
maxretry = 5
bantime.increment = true
bantime.factor    = 2
bantime.maxtime   = 5w
backend = systemd

[sshd]
enabled = true
mode    = aggressive
port    = 22
"""


def sh(client, cmd, timeout=900):
    chan = client.get_transport().open_session()
    chan.settimeout(timeout)
    chan.exec_command(cmd)
    out, err = [], []
    while True:
        if chan.recv_ready():
            out.append(chan.recv(65536))
        if chan.recv_stderr_ready():
            err.append(chan.recv_stderr(65536))
        if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
            break
    code = chan.recv_exit_status()
    chan.close()
    return (code,
            b"".join(out).decode("utf-8", "replace"),
            b"".join(err).decode("utf-8", "replace"))


def exists(client, paths):
    """返回存在的路径子集。"""
    quoted = " ".join("'%s'" % p for p in paths)
    _, so, _ = sh(client, "for p in %s; do [ -e \"$p\" ] && echo \"$p\"; done" % quoted)
    return [ln for ln in so.splitlines() if ln.strip()]


def main():
    apply = "--apply" in sys.argv
    install_pkgs = "--install-pkgs" in sys.argv

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=HOST, port=PORT, username=USER, key_filename=KEY,
              timeout=25, banner_timeout=25, auth_timeout=25,
              look_for_keys=False, allow_agent=False)
    try:
        _, before, _ = sh(c, "df -h / | tail -1; echo; du -sh %s" % B)
        print("=== 清理前 ===")
        print(before.strip())

        # ---- 1. 删除同日冗余日备份
        present = exists(c, DELETE_BACKUPS)
        print("\n=== [1] 删除同日冗余日备份（%d 项）===" % len(present))
        for p in present:
            print("  DEL  " + p)
        if apply and present:
            q = " ".join("'%s'" % p for p in present)
            code, so, se = sh(c, "rm -f %s && echo DONE" % q)
            print("  -> %s %s" % (so.strip() or se.strip(), "" if code == 0 else "exit=%d" % code))

        # ---- 2. 压缩未压缩全量副本（保留，不删）
        present = exists(c, GZIP_BACKUPS)
        print("\n=== [2] 压缩未压缩全量副本（%d 项，保留回滚能力）===" % len(present))
        for p in present:
            print("  GZ   " + p)
        if apply:
            for p in present:
                # 三步：压缩保留原文件 → 校验 → 删原文件
                code, so, se = sh(c, "gzip -k -9 '%s' && echo GZ_OK" % p, timeout=1800)
                if "GZ_OK" not in so:
                    print("  !! 压缩失败，跳过删除原文件：%s / %s" % (so.strip(), se.strip()))
                    continue
                code, so, se = sh(c, "gzip -t '%s.gz' && echo T_OK" % p)
                if "T_OK" not in so:
                    print("  !! 校验失败，保留原文件：%s" % p)
                    continue
                code, so, se = sh(c, "rm -f '%s' && echo RM_OK" % p)
                if "RM_OK" in so:
                    print("  OK   压缩+校验+删原文件：%s" % p)
                else:
                    print("  !! 删原文件失败：%s" % p)

        # ---- 3. 旧构建目录
        present = exists(c, DELETE_NEXT)
        print("\n=== [3] 删除旧构建目录（%d 项）===" % len(present))
        for p in present:
            print("  DEL  " + p)
        if apply and present:
            q = " ".join("'%s'" % p for p in present)
            code, so, se = sh(c, "rm -rf %s && echo DONE" % q, timeout=600)
            print("  -> %s" % (so.strip() or se.strip()))

        # ---- 4. 一次性脚本与旧产物
        present = exists(c, DELETE_MISC)
        print("\n=== [4] 删除一次性脚本与旧产物（%d 项）===" % len(present))
        for p in present:
            print("  DEL  " + p)
        if apply and present:
            q = " ".join("'%s'" % p for p in present)
            code, so, se = sh(c, "rm -f %s && echo DONE" % q)
            print("  -> %s" % (so.strip() or se.strip()))

        # ---- 5. 装包（sqlite3 + fail2ban）
        if install_pkgs:
            print("\n=== [5] 安装 sqlite3 与 fail2ban ===")
            code, so, se = sh(
                c,
                "export DEBIAN_FRONTEND=noninteractive; "
                "sudo apt-get update -qq && sudo apt-get install -y -qq sqlite3 fail2ban && echo APT_OK",
                timeout=1200,
            )
            print(so[-2000:] if so else "")
            if se.strip():
                print("[stderr] " + se[-800:])

            # fail2ban 配置
            sftp = c.open_sftp()
            with sftp.open("/tmp/jail.local", "w") as fh:
                fh.write(FAIL2BAN_CONF)
            sftp.close()
            code, so, se = sh(
                c,
                "sudo install -m 644 -o root -g root /tmp/jail.local /etc/fail2ban/jail.local && "
                "sudo systemctl enable --now fail2ban && sleep 3 && "
                "sudo systemctl is-active fail2ban && "
                "sudo fail2ban-client status sshd 2>&1 | head -12",
                timeout=300,
            )
            print(so)
            if se.strip():
                print("[stderr] " + se[-500:])

            # sqlite3 可用性
            code, so, se = sh(c, "which sqlite3 && sqlite3 --version")
            print("sqlite3: " + so.strip())

        # ---- 结果
        _, after, _ = sh(c, "df -h / | tail -1; echo; du -sh %s; echo; ls -la %s | head -20" % (B, B))
        print("\n=== 清理后 ===")
        print(after.strip())
    finally:
        c.close()


if __name__ == "__main__":
    main()
