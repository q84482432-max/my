# 异地（手机 / 网吧）访问指南

> 服务器：`111.229.225.7`
> 裸仓库：`/home/ubuntu/repos/a-share-sim-trading.git` — `main` @ `500ceb2`
> 最后核实：2026-09-19 01:40（全部结论为实测，非推断）

---

## 一、手机 / 平板：直接开站点（零安装，推荐）

**`http://111.229.225.7/app/simtrade`**

手机浏览器直接输入即可，不需要装任何 App。要常驻可「添加到主屏幕」。

### 实测证据（2026-09-19 01:35，公网直连，非局域网）

| 探测目标 | 结果 |
|---|---|
| `/app/simtrade` | **200** |
| `/_next/static/chunks/*.js`（GET） | **200**，返回真实 JS 内容 |
| `/_next/static/css/*.css` | **200**，32371 字节 |
| `/api/simtrade` | **200**，返回会话列表 JSON |
| `/api/market` | **200**，5558 只股票 / 2,379,962 根 K 线 |
| `:8080` 直连 | **000**（腾讯云安全组挡死，只能走 80 反代） |

> ⚠️ 两个反代特性，别误判为故障：
> 1. **HEAD 请求一律 404，GET 正常 200。** 用 `curl -I` 探测会误导你，必须用 GET。
>    （反代是 Python `BaseHTTP/0.6`，不实现 HEAD。）
> 2. 站点挂在 `/app` 前缀下，所以页面是 `/app/simtrade`，但静态资源仍是根路径 `/_next/...` —— 反代已为这两类路径都配了转发。

### 其他入口

| 用途 | 地址 |
|---|---|
| 站点首页 | `http://111.229.225.7/app` |
| 回测页 | `http://111.229.225.7/app/backtest` |
| 浏览器进服务器终端 | `http://111.229.225.7/`（腾讯云 OrcaTerm 工作台，手机也能开） |

### ⚠️ 站点当前是新是旧？

**线上 `/app` 跑的是 2026-09-18 的构建产物，界面不是最新版。**
判定依据：线上 HTML 标题仍是旧版 `模拟炒股 · 猜股票`，且不含新版的 `今日开盘` / `仓位` / `加仓` 等元素（实测出现次数均为 0）。

新版 UI 源码**已入库并已同步到服务器 git 仓库**（`components/SimTradeClient.tsx` 含「今日开盘」3 处、「加仓」5 处），但**尚未构建部署**。要线上看到新版，需要走「本地构建 standalone → 上传 → 重启服务」，且上传时必须**排除 `prisma/dev.db`**，否则线上 237.9 万根 K 线与会话数据会被本地库覆盖。

---

## 二、网吧 PC：三种取代码方式

### 方式 1：网吧有 git → 直接克隆

```bash
git clone ssh://ubuntu@111.229.225.7/home/ubuntu/repos/a-share-sim-trading.git
# 提示 password 时输入服务器密码
```

只要最新快照、不要历史（快很多）：

```bash
git clone --depth 1 ssh://ubuntu@111.229.225.7/home/ubuntu/repos/a-share-sim-trading.git
```

已实测：服务器本地 `git clone` 该裸仓库成功，HEAD = `500ceb2`，含最新 UI 代码与测试脚本。

### 方式 2：网吧没装 git → 用 Windows 自带 scp

Win10/11 自带 OpenSSH 客户端，零安装。PowerShell 里：

```powershell
# 最新源码包（357 KB，纯源码快照，不含 .git）
scp ubuntu@111.229.225.7:/home/ubuntu/ashare-src-20260919.tar.gz .

# 解包
tar xzf ashare-src-20260919.tar.gz
```

> 包由 `git archive` 生成，天然只含已入库文件：172 个文件，**不含** `.env` / `deploy/remote.py` / `prisma/dev.db` / `.git`（已核查）。
> 旧包 `ashare-src-20260918.tar.gz` 仍在服务器上，可留作对比。

### 方式 3：什么都不装 → 浏览器进腾讯云控制台

`http://111.229.225.7/` 就是腾讯云 OrcaTerm 工作台。登录**腾讯云控制台 → 云服务器 → 登录**，即可在浏览器里拿到完整 shell：看文件、`cat` 代码、跑 git、打包下载都行。**本机零安装，手机也能用。**

---

## 三、从家里推送更新到服务器仓库

### 当前已验证的路径：bundle 增量（无需交互式密码）

```bash
# 1) 生成增量包（把 <旧HEAD> 换成服务器裸仓库当前 HEAD）
git bundle create .tmp-run/ashare-incr.bundle <旧HEAD>..main

# 2) 上传
python deploy/remote.py put .tmp-run/ashare-incr.bundle /home/ubuntu/ashare-incr.bundle

# 3) 服务器裸仓库就地更新
python deploy/remote.py exec "cd /home/ubuntu/repos/a-share-sim-trading.git && \
  git fetch /home/ubuntu/ashare-incr.bundle 'main:main'"
```

本次实跑：`7b30338..500ceb2  main -> main`，更新后裸仓库 HEAD 与本地一致。

### 可选：配置 git remote 直推（需 SSH 免密）

```bash
git remote add origin ssh://ubuntu@111.229.225.7/home/ubuntu/repos/a-share-sim-trading.git
git push -u origin main
```

免密（私钥只留家里）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ashare_deploy -N ""
# 把 ~/.ssh/ashare_deploy.pub 内容追加到服务器 /home/ubuntu/.ssh/authorized_keys
git config core.sshCommand "ssh -i ~/.ssh/ashare_deploy"
```

---

## 四、安全红线（网吧环境）

1. **绝不要把 SSH 私钥拷到网吧机器。** 网吧机可能有还原卡，但更可能被监控或装键盘记录——私钥一旦泄露等于服务器交出去。网吧只用**密码**登录，且**只做只读拉取**。
2. 用完清理：删掉拉下来的代码目录；清命令行历史（PowerShell：`Clear-History`；并删 `$env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`）。
3. **家里那台才是"主"**，网吧只是临时取件口。推送只在家里做。
4. 待办安全项：服务器 `sshd` 目前 `PermitRootLogin yes`，且 `ubuntu` 用的是 09-16 在网吧用过的旧密码 —— 建议换新密码（改完同步更新家里机器的 `deploy/remote.py`）。

---

## 五、服务器现状快照（2026-09-19 01:40）

```
/home/ubuntu/repos/a-share-sim-trading.git   # 裸仓库，main @ 500ceb2
/home/ubuntu/src/a-share-sim-trading         # 纯源码副本（09-18）
/home/ubuntu/app                             # 线上运行目录（standalone 产物 + dev.db）
/home/ubuntu/ashare-src-20260919.tar.gz      # 最新源码包 357KB MD5 f2d287605c6ec76b25245fccc83fa79f
/home/ubuntu/ashare-src-20260918.tar.gz      # 上一版源码包 339KB
磁盘：40G 总 / 13G 已用 / 26G 可用（33%）
```
