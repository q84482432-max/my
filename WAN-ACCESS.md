# 异地（网吧）访问源码指南

> 服务器：`111.229.225.7` · 裸仓库：`/home/ubuntu/repos/a-share-sim-trading.git`
> 建立时间：2026-09-18 · 含完整提交历史（`main`，当前 `bfb70d3`）
> **不需要自建 Gitea/GitLab** —— 那类 Web 服务既吃内存（这台只有 2G）又需要额外开端口，而这台机的 8080 被腾讯云安全组挡着、80 被工作台占着。

---

## 零、前提事实（均已实测）

| 项 | 状态 |
|---|---|
| 公网 22 端口（SSH） | ✅ 开放 |
| 公网 80 端口 | 被工作台（腾讯云 OrcaTerm）占用 —— 但**可以走它进网页终端** |
| 公网 8080 | ❌ 被腾讯云安全组挡死 |
| 服务器 git | 2.34.1 |
| 裸仓库 | 524 KB，`main` 分支，2 个提交 |
| SSH 认证 | 密码认证开启（用户名 `ubuntu`） |
| 服务端 clone 握手 | ✅ `git upload-pack --advertise-refs` 正常广播 refs |

---

## 一、网吧有 git → 直接克隆

```bash
git clone ssh://ubuntu@111.229.225.7/home/ubuntu/repos/a-share-sim-trading.git
# 提示 password 时输入服务器密码
```

只取最新、不要历史（更快）：

```bash
git clone --depth 1 ssh://ubuntu@111.229.225.7/home/ubuntu/repos/a-share-sim-trading.git
```

---

## 二、网吧没 git → 用 Windows 自带的 scp

Win10/11 自带的 OpenSSH 客户端，**不需要装任何东西**。PowerShell 里：

```powershell
# 取源码包（339 KB，纯源码快照，不含 .git）
scp ubuntu@111.229.225.7:/home/ubuntu/ashare-src-20260918.tar.gz .

# 或直接取整个源码目录
scp -r ubuntu@111.229.225.7:/home/ubuntu/src/a-share-sim-trading .
```

解包：`tar xzf ashare-src-20260918.tar.gz`

---

## 三、什么都不想装 → 浏览器进腾讯云控制台

`http://111.229.225.7/` 就是腾讯云 OrcaTerm 工作台（这也是它占着 80 端口的原因）。

登录**腾讯云控制台 → 云服务器 → 登录**，就能在浏览器里得到这台机器的完整终端：
查文件、`cat` 代码、打包下载、跑 git 命令都行。**本机零安装。**

---

## 四、安全红线（网吧环境）

1. **绝不要把 SSH 私钥拷到网吧机器。** 网吧机常有还原卡（看似重启就清），但机器可能被监控、键盘记录，私钥一旦泄露等于服务器交出去。
   → 网吧只用**密码**登录，且**只做只读拉取**。
2. 用完清掉：删除拉下来的代码目录、清理命令行历史（PowerShell：`Clear-History`；删 `$env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`）。
3. **家里那台才是"主"**，网吧只是临时取件口。
4. 顺手记一下：服务器 `sshd` 目前 `PermitRootLogin yes`，且 `ubuntu` 用的是 09-16 在网吧用过的旧密码 —— 建议尽快换成新密码（改完记得同步更新家里机器上的 `deploy/remote.py`）。

---

## 五、从家里推送更新到服务器仓库

```bash
git remote add origin ssh://ubuntu@111.229.225.7/home/ubuntu/repos/a-share-sim-trading.git
git push -u origin main
```

想免密（推荐，私钥只留家里）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ashare_deploy -N ""
# 把 ~/.ssh/ashare_deploy.pub 内容追加到服务器 /home/ubuntu/.ssh/authorized_keys
# 然后让 git 走这把钥匙：
git config core.sshCommand "ssh -i ~/.ssh/ashare_deploy"
```

---

## 六、可选：还想有"网页上看代码"

那就得开一个公网端口（腾讯云控制台 → 安全组放行，例如 3000），再装 Gitea（约 150 MB 内存）。
这台 2G 机器跑得动，但**当前没必要** —— 网吧取代码用上面三条路已经够。
真要开端口时，更划算的是先放行 8080，把现有应用直连暴露出来。
