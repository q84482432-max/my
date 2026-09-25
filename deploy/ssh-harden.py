#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""服务器 SSH 加固工具（task #43）。

子命令：
  check        只读盘点：sshd 生效配置 / authorized_keys / 家目录权限 / 端口监听
  install-key  把本机公钥写入服务器 ~/.ssh/authorized_keys（幂等）
  harden       关闭密码登录 + 关闭 root 登录（写 drop-in，sshd -t 校验后 reload）
  set-password 更换 ubuntu 用户密码（随机强口令，打印一次）
  verify       只读复验：确认密码登录已被拒绝、公钥登录可用

安全设计：
  * harden 之前必须由调用方先证明公钥登录可用（--key-verified），否则拒绝执行。
  * 改配置前把 /etc/ssh/sshd_config 备份成 sshd_config.bak-<时间戳>。
  * 先 sshd -t 语法校验，通过才 reload；失败则回滚 drop-in 并报错。
  * 绝不删除 authorized_keys 中已有条目，只追加。
"""
import os
import secrets
import string
import sys
import time

import paramiko

HOST = "111.229.225.7"
USER = "ubuntu"
PORT = 22
# 引导口令**不再硬编码**。仅在首次装公钥（服务器还没关密码登录）时，
# 由调用方通过环境变量临时提供；加固完成后本机不需要它。
BOOTSTRAP_PASSWORD = os.environ.get("ASHARE_SSH_PASSWORD", "")

KEY_PATH = os.path.expanduser("~/.ssh/ashare_ed25519")
PUB_PATH = KEY_PATH + ".pub"
DROPIN = "/etc/ssh/sshd_config.d/99-ashare-hardening.conf"


def connect(password=None):
    """password=None → 走公钥；password='xxx' → 强制走口令（仅用于引导与「口令已被拒」复验）。"""
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kw = dict(hostname=HOST, port=PORT, username=USER, timeout=25,
              banner_timeout=25, auth_timeout=25,
              look_for_keys=False, allow_agent=False)
    if password:
        kw["password"] = password
    else:
        if not os.path.exists(KEY_PATH):
            sys.exit("缺少私钥 %s；请先运行 install-key 或在环境中提供口令。" % KEY_PATH)
        kw["key_filename"] = KEY_PATH
    c.connect(**kw)
    return c


def run(client, cmd, timeout=180):
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
    so = b"".join(out).decode("utf-8", "replace")
    se = b"".join(err).decode("utf-8", "replace")
    return code, so, se


CHECK = r"""
echo "=== [1] sshd 生效配置（sshd -T）==="
sudo sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|pubkeyauthentication|permitrootlogin|kbdinteractiveauthentication|challengeresponseauthentication|usepam|port|listenaddress)'
echo "=== [2] Include 顺序（先出现者生效）==="
grep -n -i '^\s*Include' /etc/ssh/sshd_config
echo "=== [3] 主配置中的相关行 ==="
grep -n -Ei '^\s*(PasswordAuthentication|PermitRootLogin|PubkeyAuthentication)' /etc/ssh/sshd_config
echo "=== [4] drop-in 目录 ==="
ls -la /etc/ssh/sshd_config.d/ 2>/dev/null
echo "=== [5] authorized_keys ==="
if [ -f ~/.ssh/authorized_keys ]; then
  echo "LINES=$(wc -l < ~/.ssh/authorized_keys)"
  awk '{print "  KEY["NR"] type="$1" comment="$3}' ~/.ssh/authorized_keys
else
  echo "NO_AUTHORIZED_KEYS"
fi
echo "=== [6] 权限 ==="
stat -c '%a %U:%G %n' ~/.ssh ~/.ssh/authorized_keys 2>/dev/null || echo "NO_SSH_DIR"
stat -c '%a %U:%G %n' ~ 2>/dev/null
echo "=== [7] sudo ==="
sudo -n true 2>&1 && echo "SUDO_NOPASS=YES" || echo "SUDO_NOPASS=NO"
echo "=== [8] 失败登录统计（暴力破解迹象）==="
sudo journalctl -u ssh --since '-7 days' 2>/dev/null | grep -ci 'Failed password' || echo 0
echo "=== [9] 磁盘 ==="
df -h / | tail -1
echo "=== [10] 监听 ==="
ss -tlnp 2>/dev/null | grep -E ':(22|80|8080)\b' || true
"""


def cmd_check():
    c = connect()
    try:
        _, so, _ = run(c, CHECK, timeout=180)
        print(so)
    finally:
        c.close()


def cmd_install_key():
    if not os.path.exists(PUB_PATH):
        sys.exit("找不到公钥：%s" % PUB_PATH)
    pub = open(PUB_PATH, "r", encoding="utf-8").read().strip()
    # 公钥已装则用公钥连，否则用口令引导
    try:
        c = connect()
    except Exception:
        if not BOOTSTRAP_PASSWORD:
            sys.exit("公钥登录失败，且未提供 ASHARE_SSH_PASSWORD 引导口令。")
        c = connect(BOOTSTRAP_PASSWORD)
    try:
        sftp = c.open_sftp()
        # 读现有 authorized_keys
        try:
            with sftp.open("/home/ubuntu/.ssh/authorized_keys", "r") as fh:
                existing = fh.read().decode("utf-8", "replace")
        except IOError:
            existing = ""
        if pub.split()[1] in existing:
            print("公钥已存在，跳过追加")
        else:
            new = (existing.rstrip("\n") + "\n" + pub + "\n") if existing.strip() else (pub + "\n")
            run(c, "mkdir -p /home/ubuntu/.ssh && chmod 700 /home/ubuntu/.ssh")
            with sftp.open("/home/ubuntu/.ssh/authorized_keys", "w") as fh:
                fh.write(new)
            print("已追加公钥")
        sftp.close()
        run(c, "chmod 600 /home/ubuntu/.ssh/authorized_keys && chown -R ubuntu:ubuntu /home/ubuntu/.ssh")
        _, so, _ = run(c, "wc -l < /home/ubuntu/.ssh/authorized_keys; awk '{print $3}' /home/ubuntu/.ssh/authorized_keys")
        print("authorized_keys 现状：\n" + so)
    finally:
        c.close()


def cmd_harden(key_verified):
    if not key_verified:
        sys.exit("拒绝执行：请先证明公钥登录可用，再加 --key-verified")
    ts = time.strftime("%Y%m%d-%H%M%S")
    conf = (
        "# A股模拟交易 服务器 SSH 加固（task #43，%s 生成）\n"
        "# 该 drop-in 位于 /etc/ssh/sshd_config 顶部 Include 内，先出现者生效。\n"
        "PasswordAuthentication no\n"
        "KbdInteractiveAuthentication no\n"
        "ChallengeResponseAuthentication no\n"
        "PubkeyAuthentication yes\n"
        "PermitRootLogin no\n"
    ) % ts

    c = connect()
    try:
        # 备份
        code, so, se = run(c, "sudo cp -a /etc/ssh/sshd_config /etc/ssh/sshd_config.bak-%s && echo BACKUP_OK" % ts)
        print("备份：", so.strip() or se.strip())

        # 写入 drop-in
        sftp = c.open_sftp()
        tmp = "/tmp/99-ashare-hardening.conf"
        with sftp.open(tmp, "w") as fh:
            fh.write(conf)
        sftp.close()
        code, so, se = run(c, "sudo install -m 644 -o root -g root %s %s && echo WRITE_OK" % (tmp, DROPIN))
        print("写入 drop-in：", so.strip() or se.strip())

        # 语法校验
        code, so, se = run(c, "sudo sshd -t && echo SYNTAX_OK")
        if "SYNTAX_OK" not in so:
            run(c, "sudo rm -f %s" % DROPIN)
            sys.exit("sshd -t 校验失败，已回滚 drop-in：\n" + so + se)
        print("语法校验：OK")

        # reload（不改动已建立的连接）
        code, so, se = run(c, "sudo systemctl reload ssh && echo RELOAD_OK")
        print("reload：", so.strip() or se.strip())

        # 复验生效值
        _, so, _ = run(c, "sudo sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|pubkeyauthentication)'")
        print("生效值：\n" + so)
    finally:
        c.close()


def cmd_set_password():
    alphabet = string.ascii_letters + string.digits + "!@#%^*-_=+"
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(24))
        if (any(ch.islower() for ch in pw) and any(ch.isupper() for ch in pw)
                and any(ch.isdigit() for ch in pw) and any(not ch.isalnum() for ch in pw)):
            break
    c = connect()
    try:
        # 用 stdin 传，避免出现在进程列表里
        chan = c.get_transport().open_session()
        chan.exec_command("sudo chpasswd")
        chan.sendall(("ubuntu:%s\n" % pw).encode())
        chan.shutdown_write()
        code = chan.recv_exit_status()
        chan.close()
        if code != 0:
            sys.exit("chpasswd 失败，exit=%d" % code)
        print("NEW_PASSWORD=%s" % pw)
    finally:
        c.close()


def cmd_verify():
    """只读复验：分别用口令与公钥尝试认证，报告结果。"""
    if BOOTSTRAP_PASSWORD:
        print("[A] 口令登录：", end=" ")
        try:
            c = connect(BOOTSTRAP_PASSWORD)
            c.close()
            print("仍然可用 ❌（加固未生效）")
        except paramiko.AuthenticationException:
            print("已被拒绝 ✅")
        except Exception as e:
            print("异常：%r" % e)
    else:
        print("[A] 口令登录：跳过（未提供 ASHARE_SSH_PASSWORD，无法构造口令探测）")

    print("[B] 公钥登录：", end=" ")
    try:
        c = connect(None)
        _, so, _ = run(c, "id -un; hostname")
        c.close()
        print("可用 ✅ -> " + so.replace("\n", " ").strip())
    except Exception as e:
        print("失败 ❌ %r" % e)

    print("[C] root 登录：", end=" ")
    if not BOOTSTRAP_PASSWORD:
        print("跳过（无口令可用；sshd -T 已显示 permitrootlogin no）")
    else:
        try:
            r = paramiko.SSHClient()
            r.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            r.connect(hostname=HOST, port=PORT, username="root", password=BOOTSTRAP_PASSWORD,
                      timeout=15, banner_timeout=15, auth_timeout=15,
                      look_for_keys=False, allow_agent=False)
            r.close()
            print("仍然可用 ❌")
        except paramiko.AuthenticationException:
            print("已被拒绝 ✅")
        except Exception as e:
            print("异常（多半也是拒绝）：%r" % e)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    action = sys.argv[1]
    if action == "check":
        cmd_check()
    elif action == "install-key":
        cmd_install_key()
    elif action == "harden":
        cmd_harden("--key-verified" in sys.argv)
    elif action == "set-password":
        cmd_set_password()
    elif action == "verify":
        cmd_verify()
    else:
        sys.exit("unknown action: " + action)


if __name__ == "__main__":
    main()
