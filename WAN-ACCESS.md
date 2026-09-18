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

### ✅ 线上版本：2026-09-19 01:52 已部署新版 UI

线上 `/app` 现已运行**新版界面**（五层信息层级 / 白底 / 移动端固定操作区）。

**判定版本的可靠方法**（别用 HTML 文案判断，会误判）：
页面 `app/simtrade/page-*.js` 这个 chunk 内含新版独有文案 `今日开盘` / `加仓` / `确认今日操作`，旧版没有这些词。
> 为什么不能用 HTML 判断：SimTradeClient 是客户端组件，SSR 阶段没有会话数据，这些文案在 HTML 里本来就不会出现 —— 用 HTML 检索会得出「还是旧版」的错误结论。必须查 chunk。

部署后的实测（2026-09-19 01:52）：`/`、`/simtrade`、`/backtest`、`/stocks` 全部 200；`/api/simtrade` 200；`/api/market` 200（5558 只 / 2,379,962 根 K 线）。

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
> 包 MD5 每次重新打包都会变（因为包内含本文件），**以服务器端 `md5sum` 输出为准**，本文件不写死该值。

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
/home/ubuntu/ashare-src-20260919.tar.gz      # 最新源码包 357KB（MD5 见服务器端 md5sum）
/home/ubuntu/ashare-src-20260918.tar.gz      # 上一版源码包 339KB
磁盘：40G 总 / 13G 已用 / 26G 可用（33%）
/home/ubuntu/prisma-tool                     # 独立的 prisma CLI（部署时 generate 用）
```

---

## 六、部署新版 UI 的完整流程

### 本地三件事

```bash
# 1) 构建（先停掉占着 .next 的 dev server，否则文件被锁）
npm run build

# 2) 组装并打包（自动复制 .next/static、剔除 dev.db 与 .env）
bash deploy/pack-standalone.sh

# 3) 上传包与服务器端脚本
python deploy/remote.py put .tmp-run/ashare-standalone.tar.gz /home/ubuntu/ashare-standalone.tar.gz
python deploy/remote.py put deploy/deploy-inplace.sh /home/ubuntu/deploy-inplace.sh
```

### 服务器一件事

```bash
python deploy/remote.py exec "bash /home/ubuntu/deploy-inplace.sh"
```

脚本会自动：备份 → 同步 `.next`/`server.js` → **重新 prisma generate** → 重启服务 → 健康检查 → 比对生产库指纹（size/mtime/md5 三项必须一致）。

### ⚠️ 两个必须知道的坑（2026-09-19 实际踩过并修复）

1. **不要在服务器上同步 `node_modules`。**
   standalone 的 `node_modules` 是精简集（仅 19 个包），且本机（Windows）构建的 Prisma Client 只含 **windows 引擎**。用 `rsync --delete` 同步会同时导致两个后果：
   - 删掉线上独有的 `prisma` CLI 目录；
   - 引入平台不匹配的 Prisma Client，所有走数据库的接口立刻 **500**，报错：
     `Prisma Client could not locate the Query Engine for runtime "debian-openssl-3.0.x"`
   正确做法：**默认不同步 node_modules**（依赖没变时复用线上那份），并在部署后**务必重新 `prisma generate`** 生成 Linux 引擎。
   `deploy-inplace.sh` 已内置这两条规避。

2. **`prisma generate` 必须在服务器上跑。** Linux 引擎缓存在 `~/.cache/prisma/master/<hash>/debian-openssl-3.0.x`，服务器上已有，generate 时秒级完成、无需联网下载。
   `prisma` CLI 装在 `/home/ubuntu/prisma-tool`（独立目录，不污染 app 的 node_modules）。

### 回滚

```bash
cd /home/ubuntu/app
mv .next .next.broken && mv .next.pre-deploy-<时间戳> .next
mv server.js server.js.broken && mv server.js.pre-deploy-<时间戳> server.js
sudo systemctl restart ashare.service
```
