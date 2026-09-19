# deploy/server —— 服务器侧脚本与 systemd 单元（版本化副本）

> 建立时间：2026-09-19
> 背景：这些脚本此前**只存在于服务器上，没有任何版本控制** ——
> `SOURCE-SYNC-TODO.md` 把这类东西列为风险项（"不写在任何版本库里，升级/重装即失效"）。
> 本目录是它们的入库副本，md5 与服务器上的**逐字节一致**。

## 一、脚本清单

| 文件 | 服务器路径 | 作用 | 触发方式 |
|---|---|---|---|
| `market-daily-update.py` | `/home/ubuntu/market-daily-update.py` | 个股日K增量更新（腾讯主源/新浪备源 + 复权基准重建） | `market-update.timer` 第一条 ExecStart |
| `index-daily-update.py` | `/home/ubuntu/index-daily-update.py` | 指数日K增量更新（新浪主源/腾讯备源） | `market-update.timer` 第二条 ExecStart |
| `db-backup.py` | `/home/ubuntu/db-backup.py` | SQLite 在线备份 + 指纹跳过 | `db-backup.timer` |
| `fetch-indices.py` | `/home/ubuntu/fetch_indices.py` | 抓取 9 个指数全量历史 → `index_data/` | 手动 / 首次导入 |
| `import-indices.py` | `/home/ubuntu/import_indices.py` | 建表 + 把 `index_data/` 导入独立表（幂等） | 手动 / 数据重建 |
| `verify-isolation.py` | `/home/ubuntu/verify_isolation.py` | SQL 级隔离审计（23 项） | 手动 / 变更后回归 |
| `db-range-check.py` | — | 核查个股与指数数据覆盖区间 | 手动诊断 |

`market-daily-update.py` / `db-backup.py` 是既有脚本，本次一并入库；
其余为 2026-09-19 新增。

## 二、systemd 单元

| 文件 | 安装位置 |
|---|---|
| `market-update.service` | `/etc/systemd/system/market-update.service` |
| `ashare.service` | `/etc/systemd/system/ashare.service`（Next.js 应用） |
| `workbench.service` | 同 `ashare.service` 所在（短线工作台，:80） |

`market-update.timer` / `db-backup.timer` 的单元文件**尚未入库**，仍在服务器 `/etc/systemd/system/`。
需要时可 `systemctl cat <unit> > deploy/server/<unit>` 补上。

## 三、部署方式

脚本是纯 Python（仅标准库，除 `db-backup.py` 外无第三方依赖），直接推到 `/home/ubuntu/` 即可：

```bash
# 用项目自带的远程客户端（凭据走环境变量）
export ASHARE_SSH_HOST=111.229.225.7
export ASHARE_SSH_USER=ubuntu
export ASHARE_SSH_PASSWORD='<密码>'

python deploy/remote.py put deploy/server/index-daily-update.py /home/ubuntu/index-daily-update.py
python deploy/remote.py put deploy/server/market-update.service /tmp/market-update.service
python deploy/remote.py exec "sudo cp /tmp/market-update.service /etc/systemd/system/ && sudo systemctl daemon-reload"
```

改 systemd 单元后**必须** `daemon-reload`，否则改动不生效。

## 四、验证改动是否生效

```bash
# 1) 单元语法
sudo systemd-analyze verify /etc/systemd/system/market-update.service

# 2) 确认两条 ExecStart 都在
systemctl cat market-update.service | grep ExecStart

# 3) 空跑（非交易日会两个闸门都拦下，安全）
sudo systemctl start market-update.service
tail -20 /home/ubuntu/logs/market-update.log

# 4) 指数侧单独验证
python3 /home/ubuntu/index-daily-update.py --dry-run
python3 /home/ubuntu/verify_isolation.py
```

## 五、注意事项

1. **`Type=oneshot` 下两条 ExecStart 是顺序执行、且前者失败后者不跑**。
   指数排在个股之后是刻意的：个股失败通常意味着网络或数据源有更大问题，17:30 会整个重试。
   反过来指数失败**不影响**个股。
2. **两个脚本都恒返回 0**，单点失败只记日志。这是刻意的 ——
   避免因单只标的的网络抖动把整个日更判为失败，日志才是事实来源。
3. **抓指数必须设 `NO_PROXY='*'`**（`market-update.service` 的 `Environment=no_proxy=*` 已覆盖；
   手工执行时要自己加），否则会走系统代理被拦。
4. `index-daily-update.py` 与 `market-daily-update.py` **刻意不共享代码**：
   后者的文件名带连字符无法 import，抽公共模块要动生产脚本，风险高于收益；
   而故障隔离（指数写坏不影响个股日更）本身也是想要的。
5. 改完脚本请**同步更新本目录**，否则又会退化成"只在服务器上有一份"。
