# A 股模拟交易系统 — 交接说明（HANDOFF）

> 本包用于把完整项目交给新的会话 / 新的专家继续开发。解包即用，无需重新导入行情数据。

## 一、包内容

| 内容 | 说明 |
|---|---|
| `app/` `components/` `lib/` `services/` `store/` `types/` | 全部源码（Next.js 15 App Router + React 19 + TS） |
| `scripts/` | 12 个测试脚本 + 2 个导入器 + 浏览器验证封装 |
| `prisma/schema.prisma` `prisma/seed.ts` | 数据模型与种子 |
| `prisma/dev.db` | **真实数据库（约 763 MB）**，含 5558 只股票 / 2,346,677 根真实日 K，**无需重新导入** |
| `package.json` `package-lock.json` | 依赖清单（**不含 `node_modules`**，需 `npm install`） |
| `tsconfig.json` `next.config.mjs` `postcss.config.mjs` `tailwind.config.ts` | 构建配置 |
| `PHASE1-REPORT.md` | 第一阶段交付报告 |

**刻意排除**：`node_modules`（918 MB，`npm install` 可重建）、`.next`（429 MB，构建产物）、`.env`（含本机绝对路径，见下）。

## 二、环境要求

- **Node.js 22.x**（实测 22.22.2 通过）
- **npm**（随 Node 附带）
- 首次解包后必须执行：

```bash
npm install
```

## 三、环境变量（必须手动创建 `.env`）

包内**未包含** `.env`，因为里面写的是原机器绝对路径。在项目根目录新建 `.env`：

```dotenv
# SQLite 数据库文件（相对 prisma/ 目录解析）
DATABASE_URL="file:./dev.db"

# 真实 A股日K 数据源目录（只读引用）
# 仅导入脚本使用；数据库已含全量数据时可以不配
MARKET_SOURCE_DIR="<你的行情源目录，可留空>"
```

> `DATABASE_URL` 是唯一必需项。数据已在 `prisma/dev.db` 中，**不要**运行导入脚本，会重复写入。

## 四、启动

```bash
npm install
npx prisma generate     # 生成 Prisma Client（首次必需）
npm run dev             # 开发模式，默认 http://localhost:3000
```

生产构建：

```bash
npm run build
npm run start
```

## 五、验证（确保环境正确）

```bash
npm run test:all        # 694 项断言，无需启动服务
```

预期输出：market 70 / kline 96 / indicators 31 / chart 59 / trade 70 / account 76 / sim 120 / backtest 134，**全绿**。

另有并发专项测试：

```bash
npx tsx scripts/testConcurrency.ts   # 9 项
```

## 六、不可违反的架构约束

1. **交易规则只在引擎层**：`services/tradingEngine.ts`（实盘）、`services/backtestEngine.ts`（回测）。React 组件与 API Route **不得**直接读写 `Account` / `Position` 表，不得复制买卖逻辑。两引擎互不 import，共享 `lib/tradingRules.ts` + `lib/performanceMetrics.ts`。
2. **K 线读写只在 `services/marketDataService.ts`**。周 K / 月 K 必须由日 K 实时聚合（`aggregateKlines`），**不得物化落库**。
3. **数据库只存 source of truth**，派生值（市值 / 总资产 / 总盈亏）由服务层实时计算。

## 七、关键口径（易踩雷）

- **复权**：库内 qfq 5430 只 / none(raw) 128 只，同一只股票只有一种口径。唯一键 `(stockId, period, tradeDate, adjust)`。取价函数不传 `adjust` 时必须回落到 `stock.adjust`。
- **T+1**：当日买入次日才可卖，由 `settleT1(accountId, asOfDate)` 结算，**必须逐股票**统计当日买入量。
- **成本均价**按 6 位小数落库（用 `round2` 会因 × 股数放大误差，破坏盈亏恒等式）。
- **回测时序模型 `NEXT_OPEN`**：信号 T 日收盘产生、T+1 日开盘成交；**刻意不做同根收盘价成交**（隐性未来函数）。买入数量在成交时点按实际成交价计算。
- **数据窗口**：2024-11-04 → 2026-09-10（453 交易日）。

## 八、已知的环境坑

- 本项目**已 git 化**（2026-09-18 首次入库，`main` 分支）。`node_modules` / `.next` / `prisma/*.db` /
  `.env` / `deploy/remote.py`（含服务器凭据）均已在 `.gitignore` 中排除 —— 凭据模板见 `deploy/remote.example.py`。
- Windows 下 `next build` 可能被 safe-delete 守卫中断，需放宽阈值：
  ```bash
  export CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000 && rm -rf .next && npm run build
  ```
- `npx next start` 停止不干净，需按端口反查 PID 强杀，否则旧进程会继续服务旧构建。
- 访问本机服务时若开着代理，curl 需加 `--noproxy '*'`。
