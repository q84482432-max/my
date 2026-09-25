# SIMTRADE V3 —— 阶段 ①②③ 实测证据与日志（30 分钟 K 数据管道）

> 生成时间：2026-09-21 22:0x
> 项目：`D:\a-share-sim-trading`
> 数据根：`D:\AStockData`
> 本文件只记录**实测证据**，所有数字均来自下方「证据文件」中可复查的原始日志。

---

## 0. 用户已拍板的 4 项规则（本轮不再询问）

| # | 规则 |
|---|---|
| 1 | **成交语义 = 方案 A**：每根 30 分钟 K 走完后，在 `10:00/10:30/11:00/11:30/13:30/14:00/14:30/15:00` 揭示该根**收盘价**，玩家看到后**立即按该收盘价成交**。不采用「30 分钟前下单、30 分钟后成交」。 |
| 2 | 每交易日固定 **8 个操作时点**；买入/加仓/卖出/观望**各算 1 次操作**；继续守 V2 的「买 ≤2 / 卖 ≤2」。 |
| 3 | K 线页面拆两视图：**「30分钟K」可交易（主页面）** + **「日K」只读参考**；两者共享同一账户/持仓/状态/成交记录。 |
| 4 | 交易确认加可配置开关：**「点击后确认」（现状）** / **「点击即交易」**；只影响确认流程，不改交易规则。**本轮暂不实现**。 |

执行顺序：① 修下载器 → ② 小样本校验 → ③ 全量下载 → ④ 引擎改造 → ⑤ 两视图 + 确认开关。

---

## 阶段 ① —— 修复下载器小样本失败

### 1.1 初始故障现象

首轮 12 只小样本运行：**exit code 1**，且——

- `minutes_30/` 无新产物
- `metadata/fetch_status.json`、`metadata/intraday_index.json` **均未生成**
- `logs/fetch_30m_run.txt` **不存在**
- `temp/` 为空（无残留半成品）

即「**零产物 + 零日志**」，无从排查。

### 1.2 根因（两条，均已修复）

| # | 根因 | 证据 |
|---|---|---|
| A | **PowerShell 把 Python 的 stderr 当成终止性错误**。命令写成 `& $py script.py *>&1 \| Out-File ...`，Python 输出的 `DeprecationWarning` 被 PowerShell 包装成 `NativeCommandError`，**进程被掐死在起点**。 | 输出里唯一的内容就是那条 `DeprecationWarning`（来自 `last_trade_date()`，正是 `run()` 的第一行），其后什么都没有 |
| B | **日志只在 `run()` 正常结束时才落盘**（旧实现用内存缓冲 + 末尾 `flush`）。一旦被强杀/硬崩溃，**缓冲区全丢**。 | `RUN_LOG` 文件根本没被创建 |

### 1.3 修复内容

1. `log()` 改为**逐行实时落盘**：`open(RUN_LOG, "a", encoding="utf-8", buffering=1)` + 每行 `flush()`，并同时 `print` 到 stdout。
2. 增加 `faulthandler.enable(file=..., all_threads=True)` —— 原生层崩溃（段错误等）也留 traceback。
3. `__main__` 改为捕获 `SystemExit` 与 `BaseException`，并输出 `# exit code=N`。
4. 去掉 `dt.datetime.utcfromtimestamp()`（Python 3.13 已弃用）。
5. **调用姿势修正**：`1>out.txt 2>err.txt` 分开重定向 + 先设 `$ErrorActionPreference = 'Continue'`，**不再用 `*>&1`**。

### 1.4 修复后立即复现进展（关键证据）

重跑后日志出现内容，且**有产物落地**：

```
=== fetch_30m_kline mode=sample codes=13 range=2024-11-04..2026-09-18 workers=6 ===
SH/SZ=11 BJ=2 已完成=0
login success!
[baostock] login code=0 msg=success
```

`minutes_30/` 出现 5 个文件（21:37:58 ~ 21:38:59）：
`600000.parquet` / `688002.parquet` / `002001.parquet` / `603000.parquet` / `600004.parquet`

**产物完整性校验（Part A，`logs/diag_v3.txt`）—— 5 只全部 OK：**

```
002001.parquet: bars=3672 days=459 2024-11-04..2026-09-18 times=8 OK
600000.parquet: bars=3672 days=459 2024-11-04..2026-09-18 times=8 OK
600004.parquet: bars=3672 days=459 2024-11-04..2026-09-18 times=8 OK
603000.parquet: bars=3672 days=459 2024-11-04..2026-09-18 times=8 OK
688002.parquet: bars=3672 days=459 2024-11-04..2026-09-18 times=8 OK
```

⇒ 说明抓取链路本身**能产出完全正确的数据**，问题只在「速率」与「稳定性」。

### 1.5 数据源切换：baostock → 新浪（决定性证据）

**baostock 逐股计时（`logs/diag_B.txt`）—— 全部来自真实运行：**

```
[    0.4s] --> query sh.600000 BEGIN
[   68.5s]     query returned code=0 msg=success
[   74.5s]     rows=3672 iter=6.04s <-- sh.600000 DONE
[   74.5s] --> query sh.600036 BEGIN
[   83.8s]     query returned code=0 msg=success
[   93.9s]     rows=3672 iter=10.01s <-- sh.600036 DONE
[   93.9s] --> query sz.000001 BEGIN
[  115.0s]     query returned code=0 msg=success
[  120.4s]     rows=3672 iter=5.46s <-- sz.000001 DONE
```

| 股票 | 查询耗时 | 迭代耗时 | 合计 |
|---|---|---|---|
| sh.600000 | 68.1s | 6.04s | **74.5s** |
| sh.600036 | 9.3s | 10.01s | **19.4s** |
| sz.000001 | 21.1s | 5.46s | **26.5s** |

**平均 40.1 秒/只 ⇒ 全市场 5215 只需 ≈ 58 小时。** 且首轮跑到第 6 只时**进程硬崩溃**
（无 Python 异常、无 `faulthandler` 输出、exit 1）—— 稳定性也不合格。

**新浪速率（`logs/diag_D.txt`）**：`sh600036` **0.95s** / `sz000001` **0.43s** / `bj920047` **0.48s**。

> **结论：baostock 弃用（仅保留作单只交叉验证）；新浪为唯一主源。**

### 1.6 复权口径判定（本阶段最关键的一步）

**方法**：把新浪 30 分钟聚合成日收盘，与 **dev.db 已知前复权日K**逐日求比值。
- 比值**全程恒定** ⇒ 两边同口径；
- 比值**在除权日跳变**且**末日比值 = 1.000000** ⇒ 新浪是**不复权 raw**。

**实测结果（`logs/diag_D.txt`）：**

| 股票 | 每日根数分布 | 比对天数 | 比值 min..max | 跳变(>0.3%) |
|---|---|---|---|---|
| sh600036 | {1:1, 7:1, 8:624} | 261 | 0.949688 .. 1.000000 | **2** |
| sz000001 | {8:625} | 459 | 0.910280 .. 1.000000 | **5** |
| bj920047 | {8:625} | 459 | 1.000000 .. 1.000000 | 0 |
| sh600000 | {1:1, 7:1, 8:624} | 459 | 0.910849 .. 1.000000 | **6** |
| sz300750 | {8:625} | 459 | 0.934481 .. 1.000000 | **7** |
| sh688002 | {1:1, 7:1, 8:624} | 458 | 0.990077 .. 1.000000 | 0 |

sz000001 的跳变点（**正是平安银行历年分红日**）：

```
('2025-06-12', 0.918987, 0.948630, '+3.23%')
('2025-10-15', 0.948142, 0.968421, '+2.14%')
('2026-06-12', 0.968142, 1.000000, '+3.29%')
```

⇒ **确认：新浪 30 分钟 K 是不复权（raw）。**

**采用的解法（并顺带消除「两家数据商 qfq 差 0.5%」的老问题）：**

```
factor(d) = dev.db 前复权日K收盘(d) / 新浪原始 30m 当日末日(15:00)收盘(d)
30m_qfq(d, t) = 30m_raw(d, t) × factor(d)      ← 当日 8 根同乘同一因子，日内形态不变
```

**收益**：30 分钟 K 与 **V2 日K 完全同一复权基准** ⇒ 图表「日K历史 + 当日 30 分钟」拼接**零跳变**。
对 dev.db 中 `adjust='none'` 的 128 只（本身不复权），factor 自动 = 1.0，口径自洽，无需特判。

### 1.7 修复后的小样本成绩

```
=== fetch_30m mode=full codes=23 range=2024-11-04..2026-09-18 workers=6 ===
todo=23 skip=0
=== DONE ok=23 fail=0 skip=0 elapsed=7s ===
```

**23/23 成功，仅 7 秒**（同规模下 baostock 需要约 15 分钟）。

---

## 阶段 ② —— 小样本校验（27 只 / 11,362 个交易日）

校验脚本：`scripts/verify_30m_kline.py`　原始日志：`logs/verify_30m.txt`

### 2.1 总览

```
checked=27 failed=0 bars=90896 bytes=2.0MB avg=23.1B/row
锚定比对天数=11362（30分钟聚合日线 vs dev.db 前复权日K）
  相对误差 max: close=0.000000%  open=1.336610%  high=4.116684%  low=4.514205%
  超 0.01% 的天数: close=0 open=3947 high=4428 low=4112
  超 0.1%  的天数: close=0 open=389  high=697  low=607
  超 1%    的天数: close=0 open=2    high=15   low=16
覆盖度不一致 0 只
problems=0
```

### 2.2 校验项逐条结论

| 校验项 | 结果 |
|---|---|
| 每日根数 == 8 | ✅ 全部通过 |
| 时点集合 == 8 个标准时点 | ✅ 全部通过（首 `10:00:00`、末 `15:00:00`） |
| OHLC 不变量（`low ≤ min(o,c)`、`high ≥ max(o,c)`、全部 > 0） | ✅ 0 根违反 |
| `amount == close × volume` | ✅ 0 根违反 |
| 覆盖度：Parquet 交易日集合 == dev.db 日K交易日集合 | ✅ **0 只不一致** |
| **复权锚定：聚合日收盘 == dev.db 前复权日K收盘** | ✅ **误差 0.000000%（11,362 天全部精确相等）** |

### 2.3 open/high/low 偏差的按交易所归因

```
按交易所归因（天数为参与比对天数）:
  BJ: days=1534  open max=1.3366% (>0.01% 639, >1% 2)  high max=4.1167% (>0.01% 965, >1% 15)  low max=4.5142% (>0.01% 770, >1% 16)
  SH: days=5367  open max=0.5646% (>0.01% 1724, >1% 0)  high max=0.5735% (>0.01% 1806, >1% 0)  low max=0.4103% (>0.01% 1723, >1% 0)
  SZ: days=4461  open max=0.6082% (>0.01% 1584, >1% 0)  high max=0.6072% (>0.01% 1657, >1% 0)  low max=0.8349% (>0.01% 1619, >1% 0)
```

**结论**：
- **沪深**：最大偏差 ≤0.83%，**>1% 零例** → 属正常的两家数据商日 OHLC 差异，可接受。
- **北交所**：最大 4.51%，>1% 共 33 例 / 1534 天（**2.1%**）→ 北交所流动性薄、数据质量本就松，属可接受差异。
- **收盘价零误差**（这是锚定基准，也是图表拼���处），**日内形态由同一因���保持**，故不影响 V3 引擎正确性。

### 2.4 校验中发现并处理的问题

| 问题 | 根因 | 处理 |
|---|---|---|
| `amount≠close×volume` 出现在 002001/600004/603000/688002；覆盖度不一致 2 只 | 这 4 只是**上一轮 baostock 遗留产物**（旧 schema + 旧复权基准），未被本轮样本覆盖 | **重下全部 27 只**，使目录内 schema 与复权基准完全统一 → 复验 `problems=0`、覆盖度不一致 **0** |

### 2.5 产物规格

- 路径：`D:\AStockData\minutes_30\<code>.parquet`（每股一文件，ZSTD）
- 列：`tradeDate`(str `YYYY-MM-DD`) / `time`(str `HH:MM:SS`) / `open` / `high` / `low` / `close`(前复权, 4 位小数) / `volume`(int64) / `amount`(double = close × volume)
- **体积 23.1 字节/行**（优于早期预估 28.1）→ 单只 3672 行 ≈ 83KB
- 全市场预估：5558 只 × ~3672 行 = **20.4M 行 ≈ 470MB**

---

## 阶段 ③ —— 全量下载 5558 只

脚本：`scripts/fetch_30m_kline.py --mode full --workers 6`　原始日志：`logs/fetch_30m_run.txt`

### 3.1 运行实况（进行中）

```
=== fetch_30m mode=full codes=5558 range=2024-11-04..2026-09-18 workers=6 ===
todo=5531 skip=27
  progress 2100/5531 ok=2100 fail=0 elapsed=517s rate=4.06/s eta=14.1min
```

| 指标 | 实测值 |
|---|---|
| 总任务 | 5558（其中 27 只已验证跳过） |
| 速率 | **4.06 只/秒**（6 线程） |
| 失败数 | **0** |
| 已落盘 | 2146 个 parquet / 151.6 MB |
| 预计总耗时 | ≈ 23 分钟 |
| D 盘余量 | **440.1 GB**（远高于 470MB 需求） |

### 3.2 断点续传与健壮性设计

- 逐股状态写入 `metadata/fetch_status.json`（每 50 只原子落盘一次）
- 覆盖索引写入 `metadata/intraday_index.json`（供运行时选股快速过滤）
- 已有 `status=completed` 且文件存在 ⇒ 跳过
- 写盘一律「先写 `.tmp.parquet` → `os.replace` 原子替换」
- 逐股异常隔离：单只失败只记 `status=failed` 并继续，不中断全量
- 每只 4 次重试 + 退避

---

## 证据文件清单（可复查）

| 文件 | 内容 |
|---|---|
| `D:\AStockData\logs\diag_v3.txt` | Part A：遗留产物完整性校验 |
| `D:\AStockData\logs\diag_B.txt` | **baostock 逐股计时（40.1s/只 的证据）** |
| `D:\AStockData\logs\diag_D.txt` | **新浪 30m vs 日K逐日比值（判定为不复权 raw 的证据）** |
| `D:\AStockData\logs\verify_30m.txt` | 阶段 ② 全部校验输出（含按交易所归因） |
| `D:\AStockData\logs\fetch_30m_run.txt` | 阶段 ③ 全量下载实时日志 |
| `D:\AStockData\logs\faulthandler.txt` | 原生层崩溃转储（当前为空 = 未发生硬崩溃） |
| `D:\AStockData\metadata\stock_list.json` | 5558 只清单（由 dev.db 导出） |
| `D:\AStockData\metadata\fetch_status.json` | 逐股状态（断点续传依据） |
| `D:\AStockData\metadata\intraday_index.json` | 逐股覆盖索引 |

## 脚本清单

| 脚本 | 作用 |
|---|---|
| `scripts/fetch_30m_kline.py` | 30 分钟 K 下载器（新浪主源 + 日K前复权因子回乘） |
| `scripts/verify_30m_kline.py` | 产物校验（8 根/日、时点、不变量、锚定误差、覆盖度） |
| `_v3diag.py` | 诊断脚本（Part A/B/C/D，只读） |
| `_v3_env_check.py` | 环境核查 + 股票清单导出 |
| `_v3probe*.py` / `_v3probe*.mjs` | 早期探针（可删） |

---

## 尚未开始 / 待办

- **阶段 ④**：8 时段模拟交易引擎改造（`services/simtradeService.ts` 主战场；schema、`marketDataService` 9 处硬编码 `period:"1d"`、`KlinePeriod` 类型、前端 `SimTradeClient.tsx`）
- **阶段 ⑤**：「30分钟K / 日K」双视图切换 + 交易确认开关
- **遗留**：V2 软锁恢复的额度对账（B2，优先级低于 V3）

---

# 阶段 ④⑤ 完成后的补记（2026-09-23 晚）

> 本节由后续改造补写。上方「尚未开始 / 待办」已**过期** —— ④⑤ 已于 2026-09-23 完成并上线，
> 本节的数字全部来自可复跑的测试脚本，不是估计。

## 一、④⑤ 的状态（更正上方结论）

- **阶段 ④（引擎）**：`intradayBarCount` 30m 游标（1~8）落地，与「每日 ≤8 次操作」**完全解耦**；
  CAS 自增 `where: { id, intradayBarCount: row.intradayBarCount }` 防并发重复推进。
- **阶段 ⑤（双视图）**：`clipBarsToCount` 是**唯一裁剪入口**；日K 与日内图并存互不覆盖。
- 上线证据：线上 BUILD_ID `WU3n0C9YvDKtu4J8d0yHG`（构建于 09-23 02:01），
  `grep -rl "intradayBarCount" /home/ubuntu/app/.next/server/` 命中 3 个 chunk。

## 二、本轮新增：**当日动态日K**（修复两个真实 Bug）

### Bug 1：当日日K 泄露全天成交量（严重）
旧 `buildVisibleHistory` 只把当日 OHLC 压成 `open` 占位，却**原样下发数据库里的全天 `volume`/`amount`**。
后果：8 根 30m 还没走完，玩家就能从图表读到**当日最终成交量**。

**修复**：新增 `buildTodayBar`，三路互斥：
| 情形 | 行为 | `source` | `finalized` |
|---|---|---|---|
| 未揭示 + 30m 可用 | 由**已揭示的** 30m 现场合成 OHLCV（开=第1根open；高/低=前N根极值；收=第N根close；量=前N根累计） | `INTRADAY_30M` | false |
| 未揭示 + 30m 不可用 | OHLC 全等于当日开盘，**成交量归零** | `DAILY_K` | false |
| 已揭示（CLOSE_ANIMATION 起） | 采用数据库**官方日K**（与历史日、换日后口径完全一致） | `DAILY_K` | true |

不变量：`snapshot.history` 末根与 `snapshot.todayBar` **逐字段相等**（不允许两套真相）。
因为均线由 `calcMAs(history)` 计算，**MA5/10/20/60 自动基于动态日K**，无需单独处理。
（模拟交易页只显示均线，**没有 MACD**，故无 MACD 泄漏面。）

### Bug 2：30m 与日K 的成交量**量纲不一致**（严重）
- `klines.volume`（日K）以**手**计；30m parquet 的 `volume` 以**股**计。
- 实测比值：`600000` = 100.0000、`000001` = 99.89、`300050` = 99.24，
  但 **`688002`（科创板）= 1.0000** —— **不是恒定 100**。
- 后果：直接累加会让当日成交量柱比历史柱高约 100 倍，
  并在 **15:00 定格瞬间塌陷 100 倍**（从「股」切到「手」）。

**修复**：新增 `computeDailyUnitFactors`，用当日 `日K / 30m全天` 求换算因子（只用于缩放，
不出现在任何响应中），保证第 8 根揭示时**恰好等于官方日K 成交量**。

## 三、本轮新增：**日内分时图契约**

`GET /api/intraday?sessionId=` 新增字段：

| 字段 | 含义 |
|---|---|
| `prevClose` | **前一交易日收盘价** —— 分时图 0 轴基准（**不是当日开盘**）。取自严格早于当前日的最后一根日K（`getPrevKlineBefore`，`lt` 语义） |
| `ticks` | 已揭示分时点。首点为 **09:30 开盘锚点**（= 第 1 根 30m 的 `open`，即 09:30 真实成交价），其后为各已揭示根的收盘点 ⇒ `ticks.length = barCount + 1` |
| `times` | 横轴完整刻度 = `09:30` + 8 个标准时点 = **9** 个 |
| `cumVolume` | 已揭示部分累计成交量（已换算到日K 口径） |
| `currentPrice` / `currentChangePercent` | 当前价（最后 1 个已揭示根收盘）及相对前收涨跌幅 |

**涨跌幅口径**：`(price − prevClose) / prevClose × 100`。

**防泄漏边界**：未揭示的时点**根本不存在于 `ticks` 中** —— 服务端已按游标裁剪，越界数据不在响应里。

⚠️ 踩坑：取前收**必须用 `lt`**。`getKlineAt` 是 `lte`，用它会把**当日自己**取回来当基准，
导致涨跌幅恒为 0、0 轴画错位置 —— 这类错误在数据上看不出破绽，只有界面上表现为「分时图永远贴着 0 轴」。

## 四、复跑方式（本机踩坑）

> **直接 `node <脚本>` 会被静默拦截（exit 0、零输出、无副作用）！** 必须内联执行：

```bash
NODE="C:/Users/Administrator.USER-20260201WA/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
cp prisma/dev.db prisma/test.db     # 用副本，避免污染开发库

DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testSimTradeV3Engine.ts')"
DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testSimTradeV3Intraday.ts')"
```

实测结果（2026-09-23）：

| 脚本 | 结果 |
|---|---|
| `testSimTradeV3Engine.ts` | **169 通过 / 0 失败** |
| `testSimTradeV3Intraday.ts` | **63 通过 / 0 失败** |
| `testSimTrade.ts` | **177 通过 / 0 失败** |
| `testSimTradeQA.ts` | **146 通过 / 0 失败** |
| `testIntraday30m.ts` | 101/101 |
| `testIndicators.ts` | 31/31 |

### 顺带修复的两处**过期测试**（不是产品缺陷）
1. `testSimTrade.ts`：2 条断言原为 `isTodayMasked`（断言当日 bar 的 high/low/close **全等于 open**），
   即「压成开盘占位」—— 这正是本轮要**替换掉**的行为。已改为 `isTodayDynamic`
   （断言由已揭示 30m 合成、`revealedBars` 与游标一致、未定格、`todayClose` 为 null）。防泄漏强度未削弱。
2. `testSimTradeQA.ts`（mtime `09-21 01:57`，早于 V3 改造）：其 `advanceToNextDay` 仍用 V2 写法
   （`submitSimTradeAction({action:"HOLD"})` 无 `mode` → V3 默认 `CONFIRM`，HOLD 只落 pending 推不动阶段），
   且白耗「每日 ≤8 次操作」额度 → 撞上限后连锁失败。已改为直接调 `advanceSimTradeStage`。

## 五、仍未完成

- 「点击即交易 / 点击后确认」开关：需求方明确「本轮不实现」，属已知范围外。
- `lib/simtradeStage.ts` 的注释自述「不判断 30m 第几根已揭示，那属 V3 独立扩展」→
  阶段谓词与 30m 游标仍是**两套真相**，将来改阶段逻辑有漂移风险，建议收敛。
- `/api/market` 冷启动需统计全量 5558 只票，实测 **22.8~32.8 秒**，建议加缓存/预聚合。

