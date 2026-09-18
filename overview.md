# 任务概览：GIT 服务器打通 + 线上新版 UI 部署

> 完成时间：2026-09-19 01:30 ~ 02:20

## 一、可用地址

| 用途 | 地址 | 状态 |
|---|---|---|
| **手机 / 电脑 / 网吧直接打开** | `http://111.229.225.7/app/simtrade` | ✅ 200，新版 UI |
| 站点首页 | `http://111.229.225.7/app` | ✅ 200 |
| 回测页 | `http://111.229.225.7/app/backtest` | ✅ 200 |
| 浏览器进服务器终端 | `http://111.229.225.7/`（腾讯云工作台，手机也能开） | ✅ |
| **git 仓库（clone/pull）** | `ssh://ubuntu@111.229.225.7/home/ubuntu/repos/a-share-sim-trading.git` | ✅ main @ `8b61613` |
| 源码取件包（没装 git 时） | `scp ubuntu@111.229.225.7:/home/ubuntu/ashare-src-20260919.tar.gz .` | ✅ 174 文件 |

> `:8080` 仍被腾讯云安全组挡死（只能走 80 反代），这是既定事实，不是故障。

## 二、做了什么

1. **服务器 git 裸仓库打通到最新**：从 `7b30338` 增量同步到 `8b61613`，与本地 `main` 完全一致。同步走 `git bundle` 增量，绕开 `git push` 的交互式密码。
2. **线上部署新版 UI**：本地构建 standalone → 打包（25MB / 2534 文件）→ 上传 → 服务器**原地只替换** `.next` 与 `server.js`。
3. **修复部署中引入的故障**（详见第五节）。
4. **新增两个部署脚本**（已入库）：`deploy/pack-standalone.sh`、`deploy/deploy-inplace.sh`。
5. **更新异地访问指南** `WAN-ACCESS.md`：手机地址、版本判定方法、部署流程、回滚步骤。

## 三、线上新版 UI 的验证证据

不用截图，用可复现的硬证据：

- **chunk 文案**：线上 `/_next/static/chunks/app/simtrade/page-38344da23a5e7397.js` 内含新版独有文案 —— `今日开盘` 1 处、`加仓` 1 处、`观望` 2 处、`确认今日操作` 2 处。**旧版没有这些词**。
- **chunk 文件名变化**：部署前是 `43-a9a5d512f4de53fa.js` / `45-b10de940f5944805.js`，部署后为 `45-2ef359a235d9e053.js` / `781-67b2691af05929d1.js` / `909-a5da60d248a1c133.js`，与本地构建产物一致。
- **页面与接口**：`/app`、`/app/simtrade`、`/app/backtest`、`/app/stocks` 全 200；`/api/simtrade` 200；`/api/market` 200（5558 只股票 / 2,379,962 根 K 线）。
- **移动端适配**：viewport meta = `width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover`。`viewport-fit=cover` 正是新版 UI 底部操作区 `env(safe-area-inset-bottom)` 生效的前提。

### ⚠️ 版本判定方法的重要修正

**不要用「HTML 里有没有『今日开盘』」判断线上新旧。** `SimTradeClient` 是客户端组件，SSR 阶段没有会话数据，这些文案本来就不在 HTML 里。用 HTML 检索会得出「还是旧版」的**错误结论**（本次一开始就这样误判过）。正确做法是查 chunk 内容。

## 四、生产数据安全（零损失）

`prisma/dev.db`（770MB / 806,891,520 字节）部署前后三项指纹**完全一致**：

| 项 | 部署前 | 部署后 |
|---|---|---|
| size | 806891520 | 806891520 |
| mtime | 2026-09-18 15:46:37.169635983 +0800 | 同 |
| md5 | `7aaae57e021fa6819f2a7a551f26c7e8` | `7aaae57e021fa6819f2a7a551f26c7e8` |

6 个模拟会话数据完好（`simTradeSession` 查询正常）。部署包**不含** `dev.db` 与 `.env`，脚本内有两道「发现即拒绝执行」的断言。

## 五、部署中踩到并已修复的两个故障

### 故障 1：Prisma 跨平台引擎不匹配 → 所有数据库接口 500

- **现象**：部署后 `/api/simtrade` 返回 500；`app.log` 报
  `Prisma Client could not locate the Query Engine for runtime "debian-openssl-3.0.x"` / `generated for "windows"`。
- **根因**：`rsync` 把本机（Windows）构建的 `node_modules` 同步到了 Linux 服务器；Prisma 的 Query Engine 是平台绑定的。
- **修复**：在服务器上重新 `prisma generate`（Linux 引擎已在 `~/.cache/prisma` 缓存，秒级完成，无需联网下载）。
- **长期规避**：部署脚本已内置「部署后必须 prisma generate」。

### 故障 2：`rsync --delete` 删掉了线上独有的 prisma CLI

- **现象**：修故障 1 时发现 `node_modules/prisma` 不存在，无法执行 generate。
- **根因**：standalone 的 `node_modules` 是精简集（19 个包），线上原有 144 个包；`--delete` 把线上独有的 `prisma` CLI 删了。
- **修复**：用 `npm pack @prisma/client@6.19.3` 精准替换精简包为完整包（避免 `npm install` 触发依赖树重装）；CLI 独立装在 `/home/ubuntu/prisma-tool`。
- **长期规避**：脚本改为**默认不同步 node_modules**，且同步时**永不用 `--delete`**。

## 六、回滚方式（万一线上异常）

```bash
cd /home/ubuntu/app
mv .next .next.broken && mv .next.pre-deploy-20260919-014929 .next
mv server.js server.js.broken && mv server.js.pre-deploy-20260919-014929 server.js
sudo systemctl restart ashare.service
```

备份保留在服务器上（各 11MB，两份）：`.next.pre-deploy-20260919-014546`、`.next.pre-deploy-20260919-014929`。

## 七、遗留事项

- 服务器 `sshd` 仍为 `PermitRootLogin yes`，`ubuntu` 用的是 09-16 在网吧用过的旧密码 —— 建议换新密码（改完同步更新本机 `deploy/remote.py`）。
- 服务器残渣约 234MB 未清（`app/dev.db.gz` 187MB、`deploy-bundle.tar.gz` 25MB、`diag*.js`、`.next.bak/`）。
- `workbench` 反代改造未版本化（只改了服务器上的 py 文件），workbench 升级即失效。
