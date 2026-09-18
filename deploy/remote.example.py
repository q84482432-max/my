#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""远程部署客户端模板（脱敏版）。真正的 deploy/remote.py 已被 .gitignore 排除。

凭据不写死在文件里，改为读环境变量：
    export ASHARE_SSH_HOST=1.2.3.4
    export ASHARE_SSH_USER=ubuntu
    export ASHARE_SSH_PASSWORD='...'
    python deploy/remote.py probe

用法：
  python remote.py exec "<shell command>"
  python remote.py put <local_path> <remote_path>
  python remote.py putdir <local_dir> <remote_dir>
  python remote.py probe
"""
import os
import posixpath
import stat
import sys

import paramiko

HOST = os.environ.get("ASHARE_SSH_HOST", "")
USER = os.environ.get("ASHARE_SSH_USER", "ubuntu")
PASSWORD = os.environ.get("ASHARE_SSH_PASSWORD", "")
PORT = int(os.environ.get("ASHARE_SSH_PORT", "22"))


def connect(timeout=25):
    if not (HOST and PASSWORD):
        sys.exit("缺少凭据：请先设置 ASHARE_SSH_HOST / ASHARE_SSH_PASSWORD 环境变量")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        hostname=HOST,
        port=PORT,
        username=USER,
        password=PASSWORD,
        timeout=timeout,
        banner_timeout=timeout,
        auth_timeout=timeout,
        look_for_keys=False,
        allow_agent=False,
    )
    return c


def run(client, cmd, timeout=600, quiet=False):
    """执行命令并返回 (exit_code, stdout, stderr)。"""
    chan = client.get_transport().open_session()
    chan.settimeout(timeout)
    chan.get_pty()
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
    so = b"".join(out).decode("utf-8", "replace")
    se = b"".join(err).decode("utf-8", "replace")
    if not quiet:
        if so:
            sys.stdout.write(so)
        if se:
            sys.stdout.write("[stderr] " + se)
    return code, so, se


def sftp_makedirs(sftp, path):
    parts = path.strip("/").split("/")
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)


def put_file(sftp, local, remote):
    sftp_makedirs(sftp, posixpath.dirname(remote))
    sftp.put(local, remote)


def put_dir(sftp, local_dir, remote_dir, raw=False):
    """递归上传目录。默认跳过 node_modules / .next / .git / dev.db。"""
    SKIP_DIRS = set() if raw else {"node_modules", ".next", ".git", ".tmp-run", "__pycache__"}
    SKIP_FILES = set() if raw else {"dev.db", "dev.db-journal", "dev.db-wal", "dev.db-shm"}
    n = 0
    for root, dirs, files in os.walk(local_dir):
        if SKIP_DIRS:
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        rel = os.path.relpath(root, local_dir).replace("\\", "/")
        tgt = remote_dir if rel == "." else posixpath.join(remote_dir, rel)
        try:
            sftp.stat(tgt)
        except IOError:
            sftp_makedirs(sftp, tgt)
        for f in files:
            if f in SKIP_FILES:
                continue
            lp = os.path.join(root, f)
            rp = posixpath.join(tgt, f)
            try:
                put_file(sftp, lp, rp)
                n += 1
            except Exception as e:
                print("  ! skip %s : %s" % (rp, e))
    return n


PROBE = r"""
echo "=== OS ==="; cat /etc/os-release 2>/dev/null | head -3
echo "=== ARCH ==="; uname -m
echo "=== CPU/MEM ==="; nproc; free -m | head -2
echo "=== DISK ==="; df -h / | tail -1
echo "=== NODE ==="; which node; node -v 2>/dev/null; which npm; npm -v 2>/dev/null
echo "=== NGINX ==="; which nginx; nginx -v 2>&1
echo "=== OTHER ==="; which caddy; which pm2; which git; which curl; which screen; which systemctl
echo "=== SUDO ==="; sudo -n true 2>&1 && echo "SUDO_NOPASS=YES" || echo "SUDO_NOPASS=NO"
echo "=== LISTEN ==="; ss -tlnp 2>/dev/null | head -20
echo "=== PORT80 ==="; (curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1/ || echo NO_HTTP)
"""


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "probe"
    c = connect()
    try:
        if action == "probe":
            run(c, PROBE, timeout=120)
        elif action == "exec":
            code, so, se = run(c, sys.argv[2], timeout=int(os.environ.get("CMD_TIMEOUT", "900")))
            sys.exit(0 if code == 0 else 1)
        elif action == "put":
            sftp = c.open_sftp()
            put_file(sftp, sys.argv[2], sys.argv[3])
            sftp.close()
            print("OK put " + sys.argv[3])
        elif action == "putdir":
            sftp = c.open_sftp()
            raw = (len(sys.argv) > 4 and sys.argv[4] == "raw")
            n = put_dir(sftp, sys.argv[2], sys.argv[3], raw=raw)
            sftp.close()
            print("OK put %d files -> %s (raw=%s)" % (n, sys.argv[3], raw))
        else:
            print("unknown action: " + action)
            sys.exit(2)
    finally:
        c.close()


if __name__ == "__main__":
    main()
