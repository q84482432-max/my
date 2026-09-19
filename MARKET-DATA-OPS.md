# 行情数据自动化 —— 运维手册

> 服务器 `111.229.225.7`（Ubuntu 22.04 / 2G 内存 / 40G 磁盘）
> 项目：`/home/ubuntu/app`（A股模拟交易 Next.js，端口 8080，反代 `/app`）
> 数据库：`/home/ubuntu/app/prisma/dev.db`（SQLite 单文件）

---

## 一、自动化任务一览

| 任务 | 触发时间 | 脚本 | 日志 |
|---|---|---|---|
| 行情增量更新（个股） | **交易日** 15:45（17:30 补跑） | `/home/ubuntu/market-daily-update.py` | `/home/ubuntu/logs/market-update.log` |
| 行情增量更新（指数） | 紧跟个股之后，同一 service | `/home/ubuntu/index-daily-update.py` | 同上（写入同一个日志） |
| 数据库备份 | **工作日** 16:30（源库未变自动跳过） | `/home/ubuntu/db-backup.py` | `/home/ubuntu/logs/db-backup.log` |

> 个股与指数由 `market-update.service` 的**两条 ExecStart** 顺序执行，
> 共用同一个交易日闸门与日志文件。详见本手册第七节。

管理命令：

```bash
systemctl list-timers market-update.timer db-backup.timer   # 看下次触发时间
systemctl status market-update.timer                        # 看定时器状态
sudo systemctl start market-update.service                  # 手动跑一次（立即执行）
journalctl -u market-update.service -n 50                   # 看服务运行日志
tail -50 /home/ubuntu/logs/market-update.log                # 看脚本输出
sudo systemctl disable --now market-update.timer            # 关掉定时器
sudo systemctl enable  --now market-update.timer            # 打开定时器
```

### 交易日闸门（节假日自动免跑）

非交易日不会真正执行，**两道防线**：

1. **定时器层**：`OnCalendar=Mon-Fri …` —— 周六周日根本不触发。
2. **脚本层**：开跑前先做一次交易日探针，节假日直接退出。

探针的判据很朴素：**看上证指数 `sh000001` 有没有「当日」日K**。
开市日收盘后必然有；休市日最新K线仍是上一个交易日。

```bash
[交易日闸门] 今日 2026-09-16 为交易日（源：tencent，当日数据已就绪）   # → 正常执行
[交易日闸门] 今日 2026-10-01 非交易日（tencent 最新交易日仍为 2026-09-30，A股休市）
本次不执行。如需强制运行（例如手动补历史数据），加 --force
```

**为什么这样做**：零维护。不需要内置交易日历，也不用每年更新国务院放假安排 ——
春节、国庆、清明这类「落在工作日里的休市日」由数据源本身如实反映。

三条兜底设计：

| 场景 | 行为 |
|---|---|
| 探针网络失败 | **不阻断**，继续执行 —— 宁可多跑一次，也不因网络抖动漏数据 |
| 15:45 主跑时数据源尚未更新 | 判为未就绪跳过，**17:30 会再试一次** |
| 两次都落空 | 不丢数据 —— 次日运行按 `--n` 根回溯**自动补齐** |

手动补历史数据（例如补上周）时绕开闸门：

```bash
python3 /home/ubuntu/market-daily-update.py --force
```

---

## 二、数据源与口径

### 数据源

| 角色 | 接口 | 说明 |
|---|---|---|
| **主源** | `proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get` | 腾讯前复权日K |
| 备源 | `money.finance.sina.com.cn/.../CN_MarketData.getKLineData` | 新浪日K |
| ❌ 已废弃 | `web.ifzq.gtimg.cn/...` | **被腾讯 WAF 拦截**（http→302 stgw / https→501 waf），原抓取脚本用的这个域名，已不可用 |
| ❌ 不可用 | `push2his.eastmoney.com` K线接口 | 连接被重置 |

脚本按「主源 → 备源」顺序自动降级，单只失败不影响整体。

### 成交量单位（⚠️ 本项目历史事故根因，务必理解）

**同一库里不同板块的源单位不一样**，`volume` 列声明是「股」，但上游给的不一定：

| 板块 | 主源给出单位 | 换算 | 实测库/源比值 |
|---|---|---|---|
| 沪深主板 MAIN | 手 | **×100** | 100.0000 |
| 创业板 GEM | 手 | **×100** | 100.0000 |
| 科创板 STAR | **股** | **×1** | 1.0000 |
| 北交所 BSE | 手 | **×100** | 100.0000 |

**脚本不做硬编码，而是逐票自校准**：拿「库内该票最后一根K线」的 `volume`
与数据源同日 `volume` 相除，比值落在 1.0 或 100.0 附近即判定单位，再套用到
本次新增的所有日期。这样上游换口径也不会写错。

### 复权口径

- `stocks.adjust = 'qfq'`（5430 只）→ 请求前复权序列
- `stocks.adjust = 'none'`（128 只）→ 请求不复权序列
- 写入时使用该票在 `klines` 里已有的 `adjust` 值，保证
  `(stockId, period, tradeDate, adjust)` 唯一键不分裂。

### 成交额

库里 `amount = close × volume`（导入层推导，遵循 schema 注释里的既有约定）。
上游虽有真实成交额字段，但库里从来没用过，脚本保持一致，不引入新口径。

---

## 三、前复权基准重建（重要机制）

**为什么需要**：前复权序列以「最新交易日」为基准。个股一旦发生除权除息，
全部历史价格都要重算。如果只是往后追加新K线，历史仍是旧基准，新旧拼接处
会出现**人为跳空**（本项目实测：09-10 后有 55 只发生除权，跳空幅度
0.3% ~ 45%，其中 300908 达 -32.9%，一眼假）。

**脚本怎么做**：把「库内基准日那根K线」的 `close` 与数据源同日的值比对，
不一致即判定发生复权事件（阈值：绝对差 > 0.011 元 **且** 相对差 > 0.3%），
随即拉取完整前复权序列（`--rebase-full-n`，默认 1023 根）覆盖该票的
`open/high/low/close`，`amount` 按新 close 重算，**volume 保持不变**
（实测上游前复权不调整成交量）。

**实测两类形态**（用于人工复核时的心智模型）：

| 类型 | 特征 | 实例 |
|---|---|---|
| 现金分红 | 全历史**恒定差值** | 600016 差 0.120；000708 差 0.200；603929 差 1.650 |
| 送转股 | 全历史**恒定比例** | 300908 比值 1.4499（约 10 送 4.5） |

**基准日**：默认取库内现有最新交易日（日常增量场景，能捕捉当天发生的除权）；
也可用 `--rebase-anchor YYYY-MM-DD` 指定历史日期做一次性体检：

```bash
# 体检（不写库）
python3 /home/ubuntu/market-daily-update.py --dry-run --rebase-anchor 2026-09-10
# 修复
python3 /home/ubuntu/market-daily-update.py --rebase-anchor 2026-09-10
```

关闭该机制：`--no-rebase`。

---

## 四、日常操作

```bash
# 空跑看今天会拉什么（不写库）
python3 /home/ubuntu/market-daily-update.py --dry-run

# 正式增量更新
python3 /home/ubuntu/market-daily-update.py

# 跳过交易日闸门（节假日/周末手动补数据时用）
python3 /home/ubuntu/market-daily-update.py --force

# 只更新指定股票
python3 /home/ubuntu/market-daily-update.py --codes 600519,000001

# 只更新某板块（MAIN / GEM / STAR / BSE）
python3 /home/ubuntu/market-daily-update.py --boards MAIN

# 手动备份
python3 /home/ubuntu/db-backup.py
python3 /home/ubuntu/db-backup.py --force      # 源库未变也强制备份
python3 /home/ubuntu/db-backup.py --check      # 只看现有备份列表与指纹状态
```

---

## 五、备份与恢复

- 备份目录：`/home/ubuntu/backup/`
- 命名：`dev.db.daily-YYYYmmdd-HHMMSS.gz`，滚动保留最近 **14** 份（约 2.7 GB）
- 方式：SQLite **Online Backup API**，可与运行中的应用并发，不锁库、不中断服务
- 每次备份后自动做 `PRAGMA integrity_check` + `klines` 行数核对，通过才压缩并删除未压缩副本

### 源库未变更自动跳过

备份前先比对源库指纹（`mtime` + `size`），与上次备份时记录的一致就秒退：

```bash
[22:38:54] 源库自上次备份后未变更（指纹 1789568721 804638720），跳过本次备份
```

**为什么要这个**：节假日和停更日数据本来就没变，硬备份只会产生一模一样的副本，
把滚动保留位（14 份）白白占掉，真正需要回滚的时候反而找不到有差异的历史版本。

指纹状态存在 `/home/ubuntu/backup/.last-src-state`。注意它记录的是
**备份开始前**读到的值 —— 万一备份窗口内源库又被写入，下次运行会检出差异并重新备份，
安全方向是对的。

想强制备份（例如改了配置想留个点）：`python3 db-backup.py --force`。

**从备份恢复**：

```bash
sudo systemctl stop ashare
cd /home/ubuntu/backup
ls -lt *.gz | head                       # 挑一份
gunzip -c dev.db.daily-XXXXXXXX-XXXXXX.gz > /tmp/restore.db
sqlite3 /tmp/restore.db "PRAGMA integrity_check"   # 有 sqlite3 才可用；否则用 python3
cp /home/ubuntu/app/prisma/dev.db /home/ubuntu/app/prisma/dev.db.before-restore
cp /tmp/restore.db /home/ubuntu/app/prisma/dev.db
sudo systemctl start ashare
```

> ⚠️ 服务器**没有装 `sqlite3` 命令行工具**。需要执行 SQL 时用 `python3 -c` 调
> `sqlite3` 模块，或安装 `sqlite3`（`sudo apt install -y sqlite3`）。

---

## 六、注意事项

1. **不要在这台机器上跑 `npm run build`。** Next.js 生产构建峰值 1.5–2.5 GB，
   本机只有 2 GB 内存，会被 OOM killer 打断并可能连带杀掉服务。
   构建在家里那台 Windows 上做，只上传 standalone 产物。
2. **`web.ifzq.gtimg.cn` 已不可用**，不要照抄网上老代码里的这个域名，
   用 `proxy.finance.qq.com/ifzqgtimg/...`。
3. **不要用 `--replace` 全量重导**。服务器上的 `full_market_qfq/*.json`
   是缩水版（每票约 255 根），而库里每票 457 根，全量重导会砍掉一半历史。
4. 脚本写库用的是单个事务 + `busy_timeout=120s`，无需停服。
   只在手工执行大批量变更时才考虑 `systemctl stop ashare`。
5. **源码已有版本控制，不止一份副本**（2026-09-19 订正，原文写于 09-16，已过时）：
   - 服务器裸仓库 `/home/ubuntu/repos/a-share-sim-trading.git`（`main`，可 clone/pull）
   - 服务器纯源码副本 `/home/ubuntu/src/a-share-sim-trading`（注意：这份**停在
     `4edf9f6` 时代**，缺 `e27e52a`/`500ceb2` 两次 UI 重构，**不要拿它当源码基准**）
   - 家里构建机 `C:\Users\Administrator.USER-20260201WA\WorkBuddy\a-share-sim-trading`
   推送方式见 `WAN-ACCESS.md` 第三节（走 git bundle 增量，绕开交互式密码）。

---

## 七、指数数据（独立表）

### 为什么单独存

个股表 `stocks` / `klines` 里**没有、也不应该有**指数。原因见 `INDEX-DATA.md`，摘要：

1. **裸代码撞车**：`000001` 同时是「上证指数(SH)」和「平安银行(SZ)」；
   `000905`/`000016`/`000688` 同理。`stocks.code` 不带交易所后缀，无法区分。
2. **靠 where 条件排除是约定式隔离，一定会漏**。个股枚举分散 8 处以上，
   其中 `getMarketStats()` 的 `klineCount` 与 `rangeAgg` 是**裸的全表 `prisma.kline` 查询**，
   指数一旦入库，「K 线总数」和「数据窗口」当场就错。
3. **复权语义不同**：指数无除权除息，`klines.adjust` 对它没有意义。

因此指数存在**独立表** `market_indices` / `index_klines`，与个股物理隔离。

### 覆盖范围

9 个主要指数 / 34,558 根日K，各自自**发布日**起的全量历史（截至 2026-09-18）：
上证指数、深证成指、沪深300、中证500、中证1000、上证50、创业板指、科创50、北证50。
每个指数在个股窗口 `2024-11-04 → 2026-09-18` 内都恰好 **459 根**，可直接按日期关联。

### 数据源（与个股主源不同，注意）

| 角色 | 接口 | 上限 | 可回溯到 |
|---|---|---|---|
| **主源** | 新浪 `money.finance.sina.com.cn/.../getKLineData` | 5,000 根 | **2006-03-01** |
| 备源 | 腾讯 `proxy.finance.qq.com/ifzqgtimg/...` | **2,000 根** | 2018-06-27 |

> ⚠️ **个股用腾讯做主源，指数用新浪做主源**，这是刻意的不对称：
> 腾讯接口 `n≥2500` 直接返回 `{"code":0,"msg":"param error","data":[]}`，硬上限 2000 根，
> 拿来抓指数只能回溯到 2018 年。新浪能给 5000 根。两源已逐日比对，
> 收盘点位最大相对偏差 **0.0008%**（纯四舍五入）。

指数 **没有 amount 字段** —— 指数不披露成交额，凭空用 `close × volume` 推导就是造假数据。
`volume` 统一按「股」存（新浪原生单位；腾讯源为「手」，若降级到腾讯源需换算）。

### 增量更新

```bash
python3 /home/ubuntu/index-daily-update.py                # 常规（含交易日闸门）
python3 /home/ubuntu/index-daily-update.py --dry-run      # 只抓不写
python3 /home/ubuntu/index-daily-update.py --force        # 跳过闸门
python3 /home/ubuntu/index-daily-update.py --codes sh000001   # 只更一个
```

幂等性保证：K 线主键为确定性的 `ik_<code>_<date>`，写入用 `INSERT OR IGNORE`；
每次写完后 `barCount` / `windowStart` / `windowEnd` 三个冗余字段**全部由表内数据重算**，
所以既不会漂移，也保证 `windowStart` 的语义恒为「自发布日」而不会被子刷新推进。

### 与个股任务的编排关系

`market-update.service` 里是两条 `ExecStart`，指数那条**紧跟个股之后**：

```ini
ExecStart=/usr/bin/python3 /home/ubuntu/market-daily-update.py --workers 12 --n 45
ExecStart=/usr/bin/python3 /home/ubuntu/index-daily-update.py --n 60
```

> ⚠️ `Type=oneshot` 下若个股那条失败，指数那条**不会执行**。
> 这是可接受的：个股失败通常意味着网络或数据源有更大问题，17:30 的补跑会整个重试。
> 反过来指数失败**不影响**个股 —— 两条命令各自独立，且指数只写自己的两张表。

两个脚本的退出码策略一致：**恒返回 0**，单点失败只记日志不判失败，
避免因单只标的的网络抖动把整个日更判为失败。

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 日志显示 `非交易日（A股休市）` | 正常。闸门探针读上证指数当日K线，节假日不跑 |
| 所有指数都显示「已是最新」 | 正常。数据已经是最新的，没有新增 |
| 某个指数显示 `✗` | 单点失败，不影响其他；下次运行会按 `--n` 根回溯自动补齐 |
| 指数数据缺了几天 | `--force` 手动补；或加大 `--n`（默认 60，足够覆盖长假） |

### 验证

```bash
python3 /home/ubuntu/verify_isolation.py     # SQL 级隔离审计，23 项
# 应用侧：npm run test:index（46 项，双向断言指数与个股互不可见）
```

---

## 八、变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-16 | 初次建立：行情增量更新 + `dev.db` 在线备份两个 systemd 定时器上线 |
| 2026-09-16 | **改为只在交易日执行**：新增交易日闸门（上证指数当日K线探针），节假日不再运行；备份改为 `Mon-Fri` + 源库指纹未变则跳过 |
| 2026-09-19 | **新增指数数据**：9 个主要指数（34,558 根）导入独立表 `market_indices`/`index_klines`；新增 `index-daily-update.py` 并接入 `market-update.service` 第二条 ExecStart；新增隔离审计与回归测试 |

---

*更新于 2026-09-19*
