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

## 三、❌ 仍未回写源码（重新构建会全部作废）

| # | 改动 | 目前只存在于 | 回写目标 | 依据 |
|---|---|---|---|---|
| 1 | UI 主题覆盖 v1：DESIGN.md 全套设计令牌 + nav-active v1 | `.next/static/css/*.css`、`layout-*.js` | `app/globals.css`、`app/layout.tsx` | DESIGN.md |
| 2 | nav-active v2：当前页标记 + `/app` 链接归一化 | 同上 | 导航组件 / layout | PATCH-CHAIN v2a |
| 3 | 顶栏 `header a` nowrap 防断行 | css `a4c7f2e9…` | `globals.css` | PATCH-CHAIN v2b |
| 4 | <1024px 隐藏顶栏右侧数据标签 | css `c8e2f4a6…`（当前生效） | `globals.css` | PATCH-CHAIN v3 |
| 5 | workbench 反代新增路由：`/_next/*`、`/api/*`、`/stocks`、`/account`、`/sim`、`/backtest`、`/simtrade` | 服务器 `~/workbench/workbench_server.py` | 文档化 + 版本化 | PATCH-CHAIN §访问链路 |

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

---

## 六、建议的收尾顺序

1. 换掉服务器 `ubuntu` 密码（并把 `deploy/remote.py` 的凭据改走环境变量）
2. 按 `deploy/ui-design/DESIGN.md` 把 UI 主题（含 v2b/v3 两条窄屏规则）实现回源码
3. 把项目推到**远端私有仓库**（本地 `.git` + 服务器源码副本已是两层保险，但都在同一账号/同一云下，
   远端才是真正的异地冗余）
4. 重新构建 → 上传 standalone → 换 `.next` 指纹 → 验证 `/app` 七页
5. 清理残渣 234MB、装 sqlite3、更新 `MARKET-DATA-OPS.md`（补上 workbench 反代一节）
