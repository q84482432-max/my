# AUTO-UPDATE-EVIDENCE.md

> 自动收盘更新（post-close auto update）功能的实测证据留痕。
> 本文记录「阶段 A：本地数据追平」的真实命令与硬数字，供后续阶段 B/C 与回归测试参考。

---

## 阶段 A：本地数据追平（2026-09-21）

**目标交易日**：2026-09-21（周一）。本地库与本地 30 分钟 parquet 此前滞后一个交易日（止于 2026-09-18），需追平到服务端当前交易日 2026-09-21。

**环境**：Windows / Git Bash。所有 `python` 均指向 paramiko+duckdb+requests 虚拟环境
`C:\Users\Administrator.USER-20260201WA\.workbuddy\binaries\python\envs\default\Scripts\python.exe`

---

### Step 1 — 服务器导出增量

**命令**（本机执行，经 `deploy/remote.py` 的 paramiko 密码登录 SSH 到 `111.229.225.7`）：
```bash
python deploy/remote.py exec "python3 /home/ubuntu/export-to-local.py --out /home/ubuntu/market-export-0921.json --since 2026-09-19"
```

**服务器导出结果（stdout）**：
```
导出完成 -> /home/ubuntu/market-export-0921.json
  indices      9 行
  indexKlines  34567 行
  klines       5547 行
```

**导出文件内部分解**（本地读 JSON 复核）：
- `meta.since` = `2026-09-19`
- `klines`（个股增量）：共 **5,547** 行，按 adjust 拆分 `qfq=5419`、`none=128`；按日期拆分全部为 `2026-09-21`（5419+128=5547）
- `indexKlines`：共 **34,567** 行，日期范围 `2006-03-01` → `2026-09-21`
- `indices`：**9** 行

> 注：2026-09-19/09-20 为周末无交易，故增量恰好是 2026-09-21 一个交易日。

---

### Step 2 — 下载导出文件（paramiko SFTP）

`deploy/remote.py` 只暴露 `exec/put/putdir`，**无下载动作**，故自写 SFTP 片段下载到 `.tmp-run/`：

**命令**（脚本 `_sftp_get.py`，连接 `111.229.225.7:22` 用户 `ubuntu`）：
```bash
python _sftp_get.py   # sftp.get(/home/ubuntu/market-export-0921.json, .tmp-run/market-export-0921.json)
```

**字节数一致性**：
| 位置 | 大小（字节） |
|------|-------------|
| 远端 `/home/ubuntu/market-export-0921.json` | 9,015,949 |
| 本地 `.tmp-run/market-export-0921.json`     | 9,015,949 |

远端 == 本地，传输无损坏。

---

### Step 3 — 导入本地库

**命令**：
```bash
npx tsx scripts/importServerExport.ts .tmp-run/market-export-0921.json
```

**导入逻辑**（来自 `scripts/importServerExport.ts`）：
- `market_indices` / `index_klines`：**先整表清空再全量导入**（这两张表是服务端只读副本）
- `klines` 个股增量：按 `tradeDate >= since(2026-09-19)` **先删后插**，只动增量区间，不影响更早历史

**导入端 stdout 关键行**：
```
[1/3] market_indices (9 行) -> 完成，当前 9 行
[2/3] index_klines (34567 行) -> 完成，当前 34567 行
[3/3] klines 增量 (5547 行)
      先删除同区间旧行：0 行           # 本地原无 >=2026-09-19 的行，符合预期
      -> 完成，当前 klines 共 2385505 行
本机库现状：
  股票数      : 5558
  个股 K 线    : 2385505
  个股窗口     : 2024-11-04 → 2026-09-21
  指数数      : 9
  指数 K 线    : 34567
```

#### 3.1 基线（导入前，本地 `prisma/dev.db`）
| 表 / 维度 | max(tradeDate) | 行数 |
|---|---|---|
| klines `1d` `qfq` | 2026-09-18 | 2,350,405 |
| klines `1d` `none` | 2026-09-18 | 29,553 |
| index_klines | 2026-09-18 | 34,558 |
| market_indices | — | 9 |
| stocks | — | 5,558 |

#### 3.2 结果（导入后）
| 表 / 维度 | max(tradeDate) | 行数 | Δ |
|---|---|---|---|
| klines `1d` `qfq` | **2026-09-21** | **2,355,824** | +5,419 |
| klines `1d` `none` | **2026-09-21** | **29,681** | +128 |
| index_klines | **2026-09-21** | **34,567** | +9 |
| market_indices | — | 9 | 0 |
| stocks | — | 5,558 | 0 |

#### 3.3 增量区间严格校验（按整数毫秒 tradeDate 复核）
窗口 `[2026-09-19, 2026-09-22)`（`tradeDate` 列在库内以整数毫秒存储，非文本）：
- klines 增量：qfq **5,419** + none **128** = **5,547**，与导出文件 `klines` 行数 **完全一致** ✓
- 增量内 `MIN(tradeDate)==MAX(tradeDate)==2026-09-21`，**无散落的其他日期** ✓
- `tradeDate >= 2026-09-22` 的行数 = **0**（无多写）✓
- index_klines 增量 = **9**（服务端整表重导，净增 34,567−34,558）✓
- `stocks` 仍为 **5,558**（导入未触碰股票主表）✓

**结论**：Step 3 导入精确——增量恰好是 2026-09-21 一天，qfq/none/index_klines 的增量行数与导出文件逐一吻合，无多写、无少写、无越界日期。本地数据库侧已追平到 2026-09-21。

---

### Step 4 / Step 5 — 30 分钟 K 线追平（待补）

> ⚠️ **进程被杀事件留痕（重要，避免日后误判）**：
> 本 agent 最初用「回合内后台」方式启动
> `python scripts/fetch_30m_kline.py --mode update`（重定向到 `D:\AStockData\logs\fetch_30m_update.txt`，
> 后台任务 `p8tSDp`）。
> **该子进程并非脚本崩溃，而是随 agent 回合结束被外部回收**（此环境的已知行为：长任务必须由宿主托管后台通道运行，不能靠回合内的 `&`）。
> 证据：日志最后一行停在 `progress 350/5558 elapsed=91s`，文件 mtime **22:41**，距当时约 25 分钟无进展；
> 且日志**缺失脚本正常退出必打的 `# exit code=N` 行**，`faulthandler.txt` 亦为 0 字节。
> 抽样 800 个 parquet 仅 351 个含 2026-09-21，与日志 350 吻合——状态即冻结在 350。
> **这不构成数据损坏**：
> ① 数据库导入（Step 3）在该进程被杀前已完整提交，库侧不受影响；
> ② 被杀时仅部分 parquet 写入了 2026-09-21，而 30 分钟更新采用 `--mode update`（`merge=True`，按 `(tradeDate,time)` 去重合并），
>    重跑会重新抓取并覆盖/补全，不会产生重复或脏数据。

**后续动作（由 team-lead 在其会话中重新拉起，本 agent 未再启动任何 fetch 进程以免双写踩踏）**：
- 命令：`python scripts/fetch_30m_kline.py --mode update`
- 日志：`D:\AStockData\logs\fetch_30m_update2.txt`
- 状态：运行中（预计 20–25 分钟）；完成后由本 agent 执行 Step 5 验证并回填本节的「待补」部分。

**待补内容（Step 5 验证项）**：
1. 本地 `klines` 1d qfq / none 的 max+行数、`index_klines` max+行数（已在 3.2 给出，可复用于此处汇总）。
2. 抽样股票（600519 / 000001 / 920016）读 parquet，打印：max tradeDate、每个新增交易日的 bar 数、确认每个新交易日恰好 8 根（10:00/10:30/11:00/11:30/13:30/14:00/14:30/15:00）。
3. **qfq 锚定**：上述股票 parquet 中 2026-09-21 的 15:00 收盘 `close`，须等于本地库该股票 2026-09-21 的 qfq 日 K 收盘；并列打印两侧数值。
4. `python scripts/verify_30m_kline.py --n 20` 的数字（每日 8 根、时点集合、OHLC 不变量、与日 K 锚定相对误差、覆盖度）。

> 注：在 30 分钟更新跑完前，本 agent **未读取/修改任何 parquet**，上述 Step 5 留待更新完成后执行。
