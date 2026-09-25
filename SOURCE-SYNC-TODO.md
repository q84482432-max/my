# 源码 ↔ 线上 分叉清单（SOURCE-SYNC-TODO）

> 核对时间：2026-09-18 23:58（远程 SSH 实测 + 本机核查，非推断）
> 服务器：`111.229.225.7` · 线上入口 `http://111.229.225.7/app`
> **核心结论：线上跑的是「补丁版」。多个改动从未回写源码，重新构建部署会静默丢失。**

---

## 一、线上实况（本次实测）

| 项 | 状态 |
|---|---|
| 应用 | `ashare.service` active，Next.js 15.5.25 standalone 监听 :8080 |
| 公网入口 | 80 端口 workbench 反代 → `/app` 返回 200（`/app/_next/*`、`/app/api/*` 均通） |
| 8080 直连 | ❌ 腾讯云安全组未放行（因此才需 80 反代） |
| 行情日更 | `market-update.timer` active；09-18 15:45 + 17:31 两次均成功（5558/5558，0 失败） |
| 数据库备份 | `db-backup.timer` active；09-18 16:31 备份 190.4MB，integrity=ok |
| 库内数据 | 最新交易日 **2026-09-18**，`klines` 2,379,962 行，5558 只 |
| 服务器源码 | ✅ 已有纯源码副本 `/home/ubuntu/src/a-share-sim-trading`（125 文件，**不参与运行**） |
| 版本控制 | 服务器运行目录无 `.git`；服务器源码副本为 `git archive` 快照（无历史）；**本机项目已于 2026-09-18 git 化**（`main`，提交 `4edf9f6`） |

---

## 二、✅ 本次已修复（唯一一项已回写源码）

**最大回撤起止日**

- 现象：回测详情页出现「起始日晚于结束日」（如 `2026-07-31 → 2026-06-25`）
- 病根：`services/backtestService.ts` 从库还原时，把 `maxDrawdownStart` 取成**全区间最高点日期**；
  曲线在谷底之后再创新高时，起点就落到终点之后。引擎层的 `lib/performanceMetrics.ts::calcMaxDrawdown`
  本来就是对的 —— 错的是这份**重复实现**。
- 线上处置（09-18 21:21）：直接把补丁打进 `~/.next/server/chunks/75.js`（+ standalone 副本），原文件备份在
  `~/backup/drawdown-fix-20260918-212145/`
- **本次源码回写**：改为直接复用 `calcMaxDrawdown`，消除重复实现
- 验证：`test:backtest` **134 通过 / 0 失败**；服务器源码副本已核对（`calcMaxDrawdown` 在位、旧算法 0 残留）
- ⚠️ 需重新构建部署后源码版才生效；在此之前线上仍是 chunk 热修版（两者行为一致）

---

## 三、✅ 已全部回写源码（2026-09-22 逐项实测核对）

| # | 改动 | 回写位置（实测确认） | 状态 |
|---|---|---|---|
| 1 | UI 主题覆盖 v1：DESIGN.md 全套设计令牌 + nav-active v1 | `app/globals.css`（令牌齐全）、`app/layout.tsx`（深色顶栏） | ✅ 已回写 |
| 2 | nav-active v2：当前页标记 + `/app` 链接归一化 | `components/SiteNav.tsx`（`aria-current`）、`app/layout.tsx` | ✅ 已回写 |
| 3 | 顶栏 `header a` nowrap 防断行 | `app/layout.tsx` 顶栏 `<Link>` 上的 `whitespace-nowrap` | ✅ 已回写 |
| 4 | <1024px 隐藏顶栏右侧数据标签 | `app/layout.tsx`：「数据：真实历史日K」外层 `hidden … lg:block` | ✅ 已回写 |
| 5 | workbench 反代路由 | 已文档化并版本化 → `deploy/WORKBENCH-PROXY.md` | ✅ 已文档化 |

**附带统一项**：内容区宽度全站由 `max-w-7xl` / `max-w-[1400px]` 统一为 **`max-w-[1320px]`**，共 8 处：

```
app/account/page.tsx:17   app/backtest/page.tsx:18   app/sim/page.tsx:17
app/stocks/[code]/page.tsx:43   app/layout.tsx:32/59/63
components/SimTradeClient.tsx:1241
```

> 复核方式：`grep -rn "max-w-7xl\|max-w-\[1400px\]" app components --include=*.tsx` → **已清空**；
> `grep -rn "max-w-\[1320px\]"` → 上述 8 处。
>
> ⚠️ 仍需**重新构建部署**后源码版才在线上生效；在此之前线上仍是 CSS/JS chunk 热修版（两者行为一致）。

> ⚠️ CSS/JS 带 `immutable` 一年缓存 —— 每次改内容必须换指纹，否则老访客看不到更新。
> ⚠️ workbench 那条补丁**不写在任何版本库里**，workbench 升级/重装即失效（备份：`workbench_server.py.bak-20260917`，已随 `deploy/ui-design/` 入库）。

补丁脚本与全部备份副本：`deploy/ui-design/`（已入库）

---

## 四、安全 / 卫生待办

1. **🔴 服务器 `ubuntu` 密码未更换** —— 09-16 在网吧机器上用过明文密码；本次实测**原密码仍能登录**。
   `deploy/remote.py` 已加入 `.gitignore`（凭据不入库），并提供了脱敏模板 `deploy/remote.example.py`（读环境变量）。
2. 部署残渣约 **234 MB** 未清理：`app/dev.db.gz` 187M、`~/deploy-bundle.tar.gz` 25M、
   `app/.next.bak/` 11M、`app/.next.pre-ui-20260918-204416/` 11M、`diag*.js` ×5。
3. 服务器**未装 `sqlite3`** —— 恢复流程文档里要用到（`sudo apt install -y sqlite3`）。
4. 备份目录含 5 份同指纹备份（约 756 MB），可回收中间三份。

---

## 五、已完成的归档动作

- 把 09-16 网吧机留档 `workbuddy-export`（**101 个文件**）从服务器取回本机 `WorkBuddy/workbuddy-export/`
  （该机装还原卡，本地文件会消失；README 里的 scp 一直没执行）
- 其中 `ui-design/`（DESIGN.md + PATCH-CHAIN.md + 5 个补丁脚本 + 全部回滚备份）已复制进项目 `deploy/ui-design/`
- **项目完成 git 化**：`main` 分支，首次提交 `4edf9f6`，124 个文件；`node_modules`/`.next`/`prisma/*.db`（763MB）/
  `.env`/`deploy/remote.py` 均已排除
- **源码已上传服务器副本** `/home/ubuntu/src/a-share-sim-trading`：
  由 `git archive` 导出（124 文件，339KB），包 MD5 `c6417a752458d8ab9c93f523f25de4ea` 双向校验一致；
  未含 `node_modules`/`.next`/`dev.db`/`.env`/`deploy/remote.py`；附 `README-SERVER-COPY.md` 说明与运行目录的关系
- 临时排查脚本已清理
- **服务器裸仓库已建**：`/home/ubuntu/repos/a-share-sim-trading.git`（524 KB，含完整提交历史）——
  异地/网吧取代码的三条路径见 `WAN-ACCESS.md`（**不需要自建 Gitea/GitLab**）

---

## 六、收尾进度（2026-09-22 更新）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 换掉服务器 `ubuntu` 密码（凭据改走环境变量） | ⬜ 待办（需用户决定新密码） |
| 2 | 按 `DESIGN.md` 把 UI 主题实现回源码 | ✅ **已完成**（见第三节，含 v2b/v3 两条窄屏规则 + 全站 1320px 统一） |
| 3 | 把项目推到**远端私有仓库** | ⬜ 待办（本地 `.git` + 服务器源码副本均在腾讯云同账号下，远端才是真正的异地冗余） |
| 4 | 重新构建 → 上传 standalone → 换 `.next` 指纹 → 验证 `/app` 七页 | ✅ **已完成 2026-09-22**（见第七节） |
| 5 | 清理残渣 234MB、装 sqlite3、更新 `MARKET-DATA-OPS.md` | ⬜ 待办（workbench 反代一节已单独成文 `deploy/WORKBENCH-PROXY.md`） |

---

## 七、✅ 2026-09-22 重新构建部署实录（UI 源码版正式上线）

### 7.1 部署结果

| 项 | 值 |
|---|---|
| 类型检查 | `tsc --noEmit` **0 错误** |
| 构建 | 本地 `next build`（Next 16.3.5 / standalone），7 分 03 秒，34 条路由，0 错误 |
| 产物 | `ashare-standalone.tar.gz` **65 MB / 2280 文件**，MD5 `2fac61dc782616881bf149452e646976`（双向校验一致） |
| build ID | `HWalog4iOBUjZDAt8F_1X` → **`rpkCfEKbIJcMySj1rzBSv`**（指纹已换，immutable 缓存自动失效） |
| 线上 next | **16.3.5，与本地同版本** —— 原先担心的 15→16 大版本风险实际不存在 |
| 服务 | `ashare.service` active，:8080 |
| 七页验证 | `/app` `/app/indices` `/app/stocks` `/app/simtrade` `/app/backtest` `/app/account` `/app/sim` **全部 200** |
| 数据库接口 | `/app/api/simtrade` **200**、`/app/api/indices` **200** |
| 新 UI 特征 | CSS `2cti9tiagr3lz.css` + JS `21i-y90viej3y.js` 中含 `1320px` → 全站宽度统一已生效 |
| 回滚备份 | 服务器 `.next.pre-deploy-20260922-210439` / `server.js.pre-deploy-20260922-210439` |

Turbopack 哈希别名（`@prisma/client-2c3a283f134fdcb6`）在本地构建后确认为**空目录**
（Windows 构建必踩），已由部署脚本 `[4b/7]` 在服务器侧重建为软链并实测可解析。

### 7.2 ⚠️ 部署中暴露并已修复的事故：schema 未同步

**现象**：部署后 `/`、`/simtrade`、`/backtest` 均 200，但 `/api/simtrade` **500**：

```
Unknown field `stage` for select statement on model `SimTradeSession`.
```

**根因**：`deploy-inplace.sh` 出于「防覆盖生产库」的设计**从不同步 `prisma/`**，
导致 V2 阶段状态机的 schema 变更（6 列）从未上服务器：

| 字段 | 线上（修复前） | 本地 |
|---|---|---|
| `stage` / `stageActionCompleted` / `stageActionAt` | ❌ | ✅ |
| `buyCountToday` / `sellCountToday` / `pool` | ❌ | ✅ |

全表扫描确认：**13 张表中仅 `sim_trade_sessions` 有列差异**，其余列结构完全一致。

**关键坑**：重新 `prisma generate` **无效** —— Prisma Client 是照**服务器上的旧 schema**
生成的。必须按 ① 物理表 ADD COLUMN → ② 同步 schema → ③ generate 的顺序，缺一不可。

**处置（三步，全部完成）**：

1. **备份**：`/home/ubuntu/backup/dev.db.pre-v2schema-20260922-210837`
   （815,783,936 字节，MD5 与生产库一致 `c6ad21e3e176c490214cc8f4f1e216c8`）
2. **迁移**：`ALTER TABLE ADD COLUMN` ×6（纯增量，不删不改现有列）+ 语义回填
   - `confirmedDate == currentDate` → `stage=DAY_SETTLED`（4 个 FINISHED 会话）
   - 否则 → `stage=OPEN`（7 个 ACTIVE 会话，均停在起点未推进）
   - **数据零损失**：sessions 11 / accounts 18 / orders 21 / trades 21 前后完全一致
3. **同步 + generate**：上传本地 schema（MD5 `1e6e8d54b65fc2164d15a6dce06c7faf`）
   → 服务器 `prisma generate`（client 含 `stage` 122 处）→ 重启 → `/api/simtrade` **200**，
   详情接口实测下发 `stage` 字段 → **V2 阶段状态机功能真正上线可用**

**生产库指纹变化说明**：MD5 由 `c6ad21e3…` 变为 `95f05eb4…`（因加列所致，预期内），
但**文件大小完全相同**（815,783,936 字节），证明无任何数据被删。

### 7.3 流程加固（防复发）

| 改动 | 内容 |
|---|---|
| `deploy/pack-standalone.sh` | 新增 `[2b/4]`：把本次构建所用 schema 的 MD5 与副本写入包内（`SCHEMA-MD5.txt` / `SCHEMA.prisma`） |
| `deploy/deploy-inplace.sh` | 新增 `[4c/7]` schema 一致性检查：不一致则**显式告警**并打印处置步骤；新增 `--with-schema` 开关（默认**不**覆盖生产 schema）；参数解析改为顺序无关 |
| `deploy/migrate-simtrade-v2.py` | **新增**：幂等的 V2 字段补齐 + 语义回填工具，支持 `--dry-run` |

上述两个脚本已上传服务器并与本地 MD5 对齐（`deploy-inplace.sh` = `f828fca40c3f10ec45d589242e209284`），
服务器侧 `bash -n` 语法检查通过。

### 7.4 待观察

- `/api/market` 响应耗时 **19.96 秒**（带参数 11.1 秒），逼近 20 秒超时边界。
  本次部署**未改动**该接口，属既有性能特征；但建议后续优化，否则弱网/并发下易超时。
