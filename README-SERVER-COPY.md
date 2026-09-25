# 服务器源码副本（仅备份，不参与运行）

本目录是**家里构建机**（`D:\a-share-sim-trading`，2026-09-20 由 C 盘迁移至此）源码的异地副本，用于消除「源码唯一副本在家里」的单点风险。

| 项 | 值 |
|---|---|
| 上传时间 | 2026-09-18 23:55 (CST) |
| 来源提交 | `4edf9f6`（`main` 分支首次入库） |
| 原始包 | `/home/ubuntu/ashare-src-20260918.tar.gz` |
| 包 MD5 | `c6417a752458d8ab9c93f523f25de4ea` |
| 文件数 | 124 |

未包含：`node_modules`、`.next`、`prisma/dev.db`(763MB)、`.env`、`deploy/remote.py`(含凭据)。

## 与运行目录的关系

| 路径 | 角色 |
|---|---|
| `/home/ubuntu/app` | **运行目录**：Next.js standalone 构建产物 + `node_modules` + `prisma/dev.db`，由 `ashare.service` 托管（:8080） |
| `/home/ubuntu/src/a-share-sim-trading` | **本目录**：纯源码备份，**不参与运行**；不需要在这里 `npm install` / `next build` |

## 注意

1. **不要在这台机器上 `npm run build`** —— 2 GB 内存会被 OOM killer 打断（详见 `/home/ubuntu/SERVER-TUNING-NOTES.md`）。
   构建在家里那台机器做，只上传 standalone 产物。
2. 本目录**没有 git 历史**（`git archive` 导出的是工作树快照）。要查历史回家里机器。
3. 线上产物与这份源码**存在已知分叉**（UI 主题补丁、workbench 反代补丁等尚未回写源码）——
   详见本目录 `SOURCE-SYNC-TODO.md`，那里有逐条清单和收尾顺序。
4. 更新方式（在家里机器执行）：
   ```bash
   git archive --format=tar.gz -o .tmp-run/ashare-src.tar.gz HEAD
   python deploy/remote.py put .tmp-run/ashare-src.tar.gz /home/ubuntu/ashare-src.tar.gz
   python deploy/remote.py exec "tar xzf /home/ubuntu/ashare-src.tar.gz -C /home/ubuntu/src/a-share-sim-trading"
   ```
