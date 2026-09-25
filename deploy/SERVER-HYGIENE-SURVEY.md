# 服务器安全与卫生盘点（只读实测）

> 盘点时间：2026-09-22 01:25（SSH 实测，非推断）
> 主机：`VM-0-14-ubuntu` · `111.229.225.7` · uptime 13 天 · load 0.02
> **本次为纯只读盘点，未删除、未修改任何文件，未改任何配置。**

---

## 一、磁盘水位

| 项 | 值 |
|---|---|
| 根分区 | `/dev/vda2` 40G，已用 **14G**，可用 **24G**，使用率 **37%** |
| inode | 2,621,440 总量，已用 133,096（**6%**） |

> 水位健康。残渣与备份合计约 **3.0G**，清理后使用率可降到 ~30%。

---

## 二、🔴 安全项（按风险排序）

| # | 项 | 实测值 | 风险 |
|---|---|---|---|
| 1 | **SSH `PermitRootLogin`** | `yes`（`/etc/ssh/sshd_config:33`） | 🔴 **root 可直接 SSH 登录** |
| 2 | **SSH `PasswordAuthentication`** | `yes`（`/etc/ssh/sshd_config:123`） | 🔴 **允许密码登录 → 可被暴力破解** |
| 3 | **`ubuntu` 密码仍有效** | `deploy/remote.py` 用明文密码连接**成功** | 🔴 该密码 09-16 在网吧机用过，**必须更换** |
| 4 | **免密 sudo** | `SUDO_NOPASS=YES` | 🟠 一旦普通账号失陷即等价 root |
| 5 | **22 端口暴露** | `0.0.0.0:22` LISTEN | 🟠 配合 #1#2 构成典型爆破面 |
| 6 | **凭据落盘** | `deploy/remote.py` 内含明文密码（已 gitignore，但文件在本机） | 🟠 应改走环境变量 |

`/etc/ssh/sshd_config.d/` **为空**，无 include 覆盖 → 上述两行即最终生效值。

**建议处置顺序**（**均未执行，待确认**）：

1. 换 `ubuntu` 密码 → 把 `deploy/remote.py` 凭据改为读环境变量（模板 `deploy/remote.example.py` 已存在）
2. 关闭密码登录：`PasswordAuthentication no` + `PubkeyAuthentication yes`
3. 关闭 root 登录：`PermitRootLogin no`（或 `prohibit-password`）
4. 给 `ubuntu` 装 SSH 公钥后再执行 #2/#3 —— **顺序不能反，否则会把自己锁在门外**
5. 可选：`sudo` 改回需要密码

> ⚠️ 改 sshd 配置**必须先确认公钥登录可用**，且**保留当前会话不退出**直到新开一个终端验证成功。

---

## 三、残渣清单（实测体积，非引用旧数字）

| 路径 | 体积 | mtime | 判定 | 理由 |
|---|---|---|---|---|
| `~/app/dev.db.gz` | **187M** | 09-12 09:09 | 🟡 需确认 | 09-12 的旧库快照；线上库已迁到 `prisma/dev.db`（777M） |
| `~/deploy-bundle.tar.gz` | **25M** | 09-12 10:01 | 🟢 可删 | 09-12 一次性部署包 |
| `~/ashare-standalone.tar.gz` | **39M** | 09-20 22:44 | 🟡 需确认 | 当前线上构建的产物包，留着可回滚 |
| `~/app/.next.bak` | 11M | 09-12 11:09 | 🟢 可删 | 旧构建 |
| `~/app/.next.pre-deploy-20260919-014546` | 11M | 09-18 21:07 | 🟢 可删 | 旧构建 |
| `~/app/.next.pre-deploy-20260919-014929` | 11M | 09-18 21:07 | 🟢 可删 | 旧构建 |
| `~/app/.next.pre-deploy-20260920-211205` | 5.8M | 09-19 01:47 | 🟢 可删 | 旧构建 |
| `~/app/.next.pre-deploy-20260920-224509` | 7.1M | 09-20 21:08 | 🟢 可删 | 旧构建 |
| `~/app/.next.pre-ui-20260918-204416` | 11M | 09-12 11:14 | 🟢 可删 | 旧构建 |
| `~/app/diag{2,3,4,5}.js` + `diag.js` | 9.7K | 09-12 | 🟢 可删 | 09-12 排查脚本 |
| `~/app/fix-linux.{sh,log}` | 18K | 09-12 | 🟢 可删 | 同上 |
| `~/cc{,2,3}.cjs`、`cleanup*.sh`、`cleanup-check.mjs`、`deep.mjs`、`check_all_backtests.py` | ~17K | 09-12 | 🟢 可删 | 一次性脚本 |
| `~/ashare-src-2026091{8,9}.tar.gz`、`~/ashare*.bundle` ×7 | ~1.2M | 09-18/19 | 🟢 可删 | 已被 `/home/ubuntu/repos/*.git` 取代 |
| `~/app/prisma/schema.prisma.bak-2026*` ×2 | 39K | 09-20 | 🟢 可删 | schema 备份 |
| `~/app/server.js.pre-deploy-*` ×4 | 27K | 09-12~20 | 🟢 可删 | 旧 server.js |
| **小计（🟢 明确可删）** | **≈ 99M** | | | |
| **小计（含 🟡 两项）** | **≈ 325M** | | | |

**无需处理**：`~/app/.next`（7.1M，当前生效）、`~/app/node_modules`、`~/workbench/full_market_qfq`（146M，workbench 数据，非残渣）。

---

## 四、备份目录 `~/backup` —— 合计 **2.7G**（最大占用）

| 路径 | 体积 | mtime | MD5 | 判定 |
|---|---|---|---|---|
| `dev.db.pre-unitfix-20260916-214905` | **763M** | 09-16 21:49 | `a085f828…` | ⚠️ 原判「已被每日备份覆盖」**不成立**（见下方纠正），已压缩保留 |
| `dev.db.pre-index-20260919-211152` | **770M** | 09-19 21:11 | `ad661129…` | ⚠️ 同上，已压缩保留 |
| `dev.db.daily-20260916-221620.gz` | 188M | 09-16 22:17 | `76ea6fbd…` | 🟢 可删（同日最早一份） |
| `dev.db.daily-20260916-222312.gz` | 190M | 09-16 22:24 | `549d8847…` | 🟢 可删（同日中间一份） |
| `dev.db.daily-20260916-223854.gz` | 190M | 09-16 22:39 | `4e72dd59…` | ✅ 保留（09-16 最晚一份） |
| `dev.db.daily-20260917-163356.gz` | 190M | 09-17 16:35 | `d6348838…` | ✅ 保留 |
| `dev.db.daily-20260918-163143.gz` | 191M | 09-18 16:32 | `db77a941…` | ✅ 保留 |
| `dev.db.daily-20260921-163356.gz` | 193M | 09-21 16:35 | `89390412…` | ✅ 保留 |
| `drawdown-fix-20260918-212{135,145}/` | 48K | 09-18 | — | ✅ 保留（回滚素材） |
| `RESTORE-HOWTO.txt`、`.last-src-state` | 小 | — | — | ✅ 保留 |

### ⚠️ 对 `SOURCE-SYNC-TODO.md` 旧结论的纠正

原文写「备份目录含 **5 份同指纹备份（约 756 MB）**，可回收中间三份」。**实测不成立**：

- 6 份 `dev.db.daily-*.gz` 的 **MD5 两两不同** → 它们是**不同日期的独立快照**，不是同指纹副本。
- 真正的冗余是：**09-16 当天连做 3 份**（22:17 / 22:24 / 22:39），可只留最晚一份 → 回收 **378M**。
- 另有 2 份**未压缩全量副本**（763M + 770M = **1.53G**），已被每日 gz 链覆盖 → 可回收 **1.53G**。

**备份目录可安全回收 ≈ 1.91G**（保留 09-16 最晚一份 + 09-17/18/21 各一份 + 回滚素材）。

---

## 五、服务与定时器

| 单元 | active | enabled | 最近执行 | 下次执行 |
|---|---|---|---|---|
| `ashare.service` | ✅ active | ✅ enabled | — | — |
| `market-update.timer` | ✅ active | ✅ enabled | 09-21 17:30 | 09-22 15:45 |
| `db-backup.timer` | ✅ active | ✅ enabled | 09-21 16:33 | 09-22 16:34 |

**应用可达性**：
- `http://127.0.0.1/app` → **200** ✅（80 端口 workbench 反代正常）
- `http://127.0.0.1:8080/app` → **404**（**预期行为**：Next.js standalone 在根路径 `/` 提供服务，`/app` 前缀由 workbench 剥离）

**监听端口**：`8080`（next-server）、`80`、`22`、`127.0.0.53:53`

---

## 六、线上数据库

| 项 | 值 |
|---|---|
| 路径 | `/home/ubuntu/app/prisma/dev.db` |
| 体积 | 814,678,016 B（**777M**） |
| mtime | 09-21 15:47 |
| `pragma integrity_check` | **ok** ✅ |
| `stocks` | 5558 |
| `klines` 总行数 | 2,385,509 |
| `klines` 中 `period='1d'` | **2,385,509**（**即线上库目前只有日K，尚无 30 分钟数据**） |
| 最新交易日 | **2026-09-21** ✅ |
| 其他表 | `backtests` 4、`accounts` 17、`orders` 21 |

> 另：`~/app/prisma/` 下有 `schema.prisma.bak-2026*` ×2（39K，可删）、`fixed-volume-stocks.json`（31K）。

---

## 七、其他

| 项 | 状态 |
|---|---|
| `sqlite3` CLI | ❌ **未安装**（`which sqlite3` → NO_SQLITE3），恢复流程文档需要它 |
| 源码副本 | `/home/ubuntu/src/a-share-sim-trading`（1.8M）✅ |
| 裸仓库 | `/home/ubuntu/repos/a-share-sim-trading.git`（**756K**）✅ |
| workbench 目录 | `~/workbench/` 含 `full_market_qfq` 146M + 6 张思维导图 PNG（0.5~0.9M） |

---

## 八、建议的处置方案（**已于 2026-09-22 执行完毕，实录见第九节**）

### A. 可安全执行（低风险，回收 ≈ 2.0G）
1. 删 09-16 的两份冗余日备份（378M）
2. 删两份未压缩全量副本（1.53G）
3. 删 6 个旧 `.next*` 目录（56.8M）
4. 删 `diag*.js` / `fix-linux.*` / `cc*.cjs` / `cleanup*` / `deep.mjs` / `check_all_backtests.py` / `ashare-src-*.tar.gz` / `ashare*.bundle` / `server.js.pre-*` / `schema.prisma.bak-*`（≈ 42M）
5. `sudo apt install -y sqlite3`

### B. 需用户决策
6. `~/app/dev.db.gz`（187M）—— 09-12 旧库快照，是否保留？
7. `~/ashare-standalone.tar.gz`（39M）—— 当前构建产物包，留着可回滚，是否保留？
8. `~/deploy-bundle.tar.gz`（25M）—— 09-12 一次性包，可删
9. **换 `ubuntu` 密码 + 关 SSH 密码登录 + 关 root 登录**（须先装公钥，见第二节）

---

## 九、处置实录（2026-09-22 执行，全部已实测验证）

> 工具：`deploy/ssh-harden.py`（加固/复验）、`deploy/server-hygiene.py`（清理，默认 dry-run）
> 密钥：`~/.ssh/ashare_ed25519`（ED25519，`SHA256:MpzwgwYCUHghjEH69vEoNULaNQp2CUDyqoUaAJK5YuA`）

### 9.1 先导发现：爆破已在进行中

盘点从「只读」升级为「先查有没有已经被打进来」：

| 指标（近 30 天） | 实测 |
|---|---|
| `Failed password` 总次数 | **14,133** |
| 近 24h | **2,240**（其中单 IP `51.89.42.211` 占 2,233） |
| TOP 攻击源 | `51.222.47.156`(7,995)、`51.89.42.211`(4,397) —— 均为 OVH 段 |
| 被尝试账号 | `root` 13,284 次、`ubuntu` 743 次 |
| **成功登录** | 796 次，来自 **9 个 IP，全部是 `Accepted password`** |
| **成功登录 for root** | **0** |
| **成功登录 for lighthouse** | **0** |
| 非 ubuntu/root/lighthouse 的成功登录 | **0** |

**结论：未被攻破。** 9 个成功登录 IP 全部是中国 ISP 动态地址，各自集中在
1~3 天的连续窗口内、时段均为晚间工作时段 —— 即用户本人的家宽/移动网络在轮换：

| IP | 登录数 | 时间窗 |
|---|---|---|
| `120.230.18.17` | 82 | 09-08 ~ 09-09 |
| `120.231.132.153` | 240 | 09-09 ~ 09-12 |
| `61.141.181.142` | 143 | 09-16 ~ 09-17 |
| `113.100.245.131` | 86 | 09-18 |
| `223.160.229.182` | 59 | 09-18 ~ 09-19 |
| `113.100.244.4` | 91 | 09-19 |
| `223.160.225.51` | 12 | 09-19 |
| `223.160.229.119` | 5 | 09-20 |
| `223.160.226.62` | 78 | 09-20 ~ 09-22 |

### 9.2 SSH 加固（已完成并复验）

先装公钥 → **用新会话独立验证公钥可用** → 才改配置（顺序不可颠倒）：

| 项 | 加固前 | 加固后（`sshd -T` 实测） |
|---|---|---|
| `PasswordAuthentication` | `yes` | **`no`** ✅ |
| `PermitRootLogin` | `yes` | **`no`** ✅ |
| `PubkeyAuthentication` | `yes` | `yes` ✅ |
| `KbdInteractiveAuthentication` | `no` | `no` |

- 落点：`/etc/ssh/sshd_config.d/99-ashare-hardening.conf`（位于主配置第 12 行 `Include` 内，**先出现者生效**，故覆盖第 33/123 行的旧值）
- 备份：`/etc/ssh/sshd_config.bak-20260922-215334`
- 复验：口令登录 → `Permission denied (publickey)`；root 登录 → 被拒；公钥登录 → 正常
- **未锁死自己**：加固前后均以独立会话验证公钥可用

### 9.3 口令轮换与凭据清剿

`ubuntu` 口令已更换为 24 位随机强口令（`passwd -S` 显示 `P`，最后修改日期 `09/22/2026`），
旧口令实测**已失效**。旧口令的暴露面已全部清除：

| 位置 | 状态 |
|---|---|
| `deploy/remote.py` / `scripts/postclose_sync.py` / `_sftp_get.py`（本机） | ✅ 改为「公钥优先 + `ASHARE_SSH_PASSWORD` 兜底」 |
| `/home/ubuntu/workbuddy-cafe-20260919/tools/ssh_run.py`（服务器，**网吧会话遗留**） | ✅ 改为公钥认证 |
| **`~/ashare-standalone.tar.gz`（部署包内 `deploy/remote.py`）** | ✅ 重新打包并上传替换 |
| `.next/standalone/`（构建产物内 4 个副本，含 1 个 `.pyc`） | ✅ 已刷新清理 |
| 服务器 `/home/ubuntu/src/` 源码副本 | ✅ 本来就不含 `remote.py` |
| git 历史 | ✅ **从未提交**（`.gitignore:44` 忽略 `deploy/remote.py`，`git log -S` 无命中） |
| 本机 `.tmp-run/` 各归档 | ✅ 全部干净 |

**⚠️ 新增事故复盘 —— 部署包泄露口令（本轮最隐蔽的一条）**

Next.js standalone 的 file tracing 会把项目根目录的一批文件（`deploy/`、`scripts/`、
`_sftp_get.py`）一并拷进 `.next/standalone`，于是 `deploy/remote.py` 里的明文口令被
**原样打进部署包**。而 `.tar.gz` 是二进制，在服务器上 `grep -r '78Y,;'` 搜不到，
直到解包逐文件查才暴露 —— 也就是说**这个泄露此前任何一次「全盘 grep」都查不出来**。

加固措施（`deploy/pack-standalone.sh` 新增 `[3b/4]` 闸门，**命中即 exit 1 拒绝打包**）：
- 扫描范围仅项目自有文件（`--exclude-dir=node_modules --exclude-dir=.next`），
  否则第三方库里大量 `password = "..."` 会把正常构建全部误杀（实测首版即误杀 13 个文件）
- 检测器要求「赋值给长度 ≥ 8 的字面量」，故注释里举例的 `password = "..."` 与
  文档字符串里的 `password='xxx'` 不误报，而 `os.environ.get()` 本来就不命中 —— 后者才是正解
- 打包前先清 `__pycache__`（字节码会残留字符串常量）
- 闸门已实测：对污染产物报 `FATAL` 并拒绝出包；对清理后的产物放行

### 9.4 卫生清理（回收 ≈ 2.3G）

| 动作 | 对象 | 回收 |
|---|---|---|
| 删除 | 09-16 同日冗余日备份 ×2（只留当天最晚 `223854`） | 394M |
| **压缩保留** | 3 份未压缩全量副本 → `.gz`（`gzip -k` → `gzip -t` 校验 → 才删原文件） | ≈ 1.7G |
| 删除 | 6 个旧 `.next*` 构建目录（保留当前 `.next` 与今天的 `.next.pre-deploy-20260922-210439`） | 51M |
| 删除 | 31 项一次性脚本/旧产物（`diag*.js`、`cc*.cjs`、`ashare*.bundle`、旧 `server.js.pre-*`、旧 `schema.prisma.bak-*` 等） | ≈ 1M |
| 删除 | `next15-backup-20260920-211143`（Next **15.5.25** 的 npm 包，应用已升 16.3.5） | 30M |
| 删除 | `verify-index`（09-19 的指数隔离验证脚手架，无任何引用） | 208M |

**关键：优先压缩而非删除。** 两处纠正：

1. 原判「两份未压缩全量副本已被后续每日备份覆盖」**不成立** ——
   `dev.db.pre-index-20260919-211152`（09-19 21:11）落在 `daily-20260918-163143`
   与 `daily-20260921-163356` 的**空档**里，没有任何日备份复刻它。
   故改为压缩保留（各 ≈ 197M），而非删除。**保留的回滚素材严格多于原方案。**
2. 备份目录已从盘点时的 2.7G 增长到 **3.6G**（今天的部署新增了
   `dev.db.pre-v2schema-20260922-210837` 778M 与 `daily-20260922` 202M）。

**差点误删的关键项：`~/prisma-tool`（149M）必须保留。**
`deploy-inplace.sh:36` 写死 `PRISMA_BIN=/home/ubuntu/prisma-tool/node_modules/.bin/prisma`，
而 `app/node_modules/prisma` **不存在** —— 删掉它，以后每次部署都会失败。
实测 `prisma --version` → 6.19.3 正常。

**磁盘**：`15G/40G (40%)` → **`13G/40G (34%)`**，可用 `23G → 25G`。

### 9.5 fail2ban（已装 + 已修 + 已验证）

`sqlite3` 3.37.2 与 `fail2ban` 0.11.2 已装，`fail2ban` 已 enable + active。

**⚠️ 但装完发现它形同虚设，根因如下（Ubuntu 通病）：**

fail2ban 自带 `filter.d/sshd.conf:126` 写死
`journalmatch = _SYSTEMD_UNIT=sshd.service + _COMM=sshd`，
而本机 sshd 的真实 systemd 单元是 **`ssh.service`**（`sshd.service` 只是软链别名）：

| journal 过滤条件 | 命中条数（24h） |
|---|---|
| `_SYSTEMD_UNIT=sshd.service` | **1** |
| `_SYSTEMD_UNIT=ssh.service` | **9,361** |
| `_COMM=sshd` | **9,438** |

⇒ 该条件只命中 1 条，**jail 完全失效**（24h 内 2,240 次爆破，fail2ban 只记到 4 次）。

**修复**：在 `jail.local` 的 `[sshd]` 里覆盖 `journalmatch = _COMM=sshd`（与单元名解耦，改名也不受影响）。

**端到端验证**（不是「看它 active 就算过」）：
- 生效值：`fail2ban-client get sshd journalmatch` → `_COMM=sshd` ✅
- 过滤有效：把真实 journal 400 行喂给 filter → 默认模式 **35 匹配**、aggressive 模式 **108 匹配** ✅
- 封禁有效：手工封 `203.0.113.66`（RFC 5737 保留段，不可路由，误封无副作用）→
  `iptables` 出现 `f2b-sshd` 链 `-A f2b-sshd -s 203.0.113.66/32 -j REJECT` ✅ → 解封后规则撤销 ✅

配置：`bantime 1h` / `findtime 10m` / `maxretry 5` / `bantime.increment`（指数加长，上限 5 周）/ `mode aggressive`。

### 9.6 收尾终检（全部通过）

| 项 | 结果 |
|---|---|
| `passwordauthentication` / `permitrootlogin` | `no` / `no` ✅ |
| 旧口令全盘 grep | 无残留 ✅ |
| 部署包内硬编码口令 | 无 ✅ |
| `sqlite3` / `prisma` CLI | 3.37.2 / 6.19.3 ✅ |
| `ashare.service` / `workbench.service` / `fail2ban` | 全部 `active` ✅ |
| 页面 `/`、`/app`、`/app/simtrade`、`/app/indices`、`/app/stocks` | 全 **200** ✅ |
| 走库接口 `/app/api/simtrade` | **200** ✅ |
| 磁盘 / inode | 34% / 5% ✅ |

### 9.7 遗留项（未处置，附理由）

| 项 | 现状 | 为什么没动 |
|---|---|---|
| **workbench `:80` 无认证且以 root 运行** | `workbench.service` 以 `User=root` 跑 `python3 workbench_server.py 80`，`GET /` 直接 200，无任何认证 | 这是**用户手机访问的唯一公网入口**（腾讯云安全组未放行 8080）。改认证或降权会直接中断用户既有访问方式，且降权需处理 80 端口特权绑定（`CAP_NET_BIND_SERVICE`），须先与用户确认 |
| `PermitRootLogin no` 后 root 口令仍存在 | `passwd -S root` → `P` | 仅影响 VNC/控制台，SSH 已禁 root；腾讯云控制台应急登录可能仍需要它 |
| `sudo` 免密（`SUDO_NOPASS=YES`） | 未改 | 自动化部署脚本依赖它；改为需口令会打断既有部署链路 |
| `ufw` | `inactive`（未启用） | 腾讯云安全组已限制入站（8080 公网实测超时不可达），且 `workbench` 的出站依赖面未能完全枚举，贸然启用有中断风险 |
| 136 个可升级包 | `unattended-upgrades` 已 active | 非本次范围；自动安全更新已在跑 |

