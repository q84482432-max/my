# SIMTRADE V2 实施记录（阶段状态机 / 双成交价 / 每日额度）

> 本文记录 V2 的**实际改动、验证证据与已知边界**。规则口径见 `SIMTRADE-RULES.md`。
> 完成时间：2026-09-20。

---

## 一、V2 做了什么

| # | 需求 | 落地方式 |
|---|---|---|
| 1 | 每日拆成**开盘阶段 + 收盘阶段** | 新增 6 态阶段状态机 `OPEN → OPEN_CONFIRMED → CLOSE_ANIMATION → CLOSE → CLOSE_CONFIRMED → DAY_SETTLED`，由服务端 `session.stage` 唯一决定 |
| 2 | 每阶段**只能操作 1 次** | `stageActionCompleted` 标记 + 下单前**原子占位（CAS）**；已操作后再提交被拒 |
| 3 | 双阶段**不同成交价** | `OPEN` 用当日 `bar.open`、`CLOSE` 用当日 `bar.close`；以 **LIMIT 单 + 阶段成交价**下沉 `tradingEngine.placeOrder`，引擎仍负责资金/持仓/T+1/费用 |
| 4 | **每日额度** 买 ≤2 / 卖 ≤2 | `buyCountToday` / `sellCountToday` 落库；两阶段共享；观望不消耗；失败不消耗；跨日重置 |
| 5 | **收盘动画** | 前端 `CloseAnimation`（开盘价滚动到收盘价，1600ms，播完自动推进到 `CLOSE`） |
| 6 | 前端**改滑块** | `RatioSlider`：`<input type="range">` + 数字框双向同步，1~100；**删除旧的 10/30/50/100 档位按钮** |
| 7 | **删指数卡** | 移除大盘三卡；`snapshot.benchmarks` 保留仅为 API 兼容 |
| 8 | **防泄漏口径保持** | `OPEN` / `OPEN_CONFIRMED` 阶段：当日 K 线**只有 open**、`todayClose = null`；`CLOSE_ANIMATION` 起才揭示收盘价 |
| 9 | **不建第二套交易规则** | 费用/数量/T+1/成本一律复用 `tradingEngine`；`buildSettlement` 的手写费用公式改为调用 `calcFees` |
| 10 | 股票池扩展 | `STOCK` 可用并**排除 ST**；`INDEX` / `INDUSTRY` **明确拒绝**（原因见 §四） |

## 二、改动文件

### 数据层
- `prisma/schema.prisma` — `SimTradeSession` 新增 6 字段：
  `stage`、`stageActionCompleted`、`stageActionAt`、`buyCountToday`、`sellCountToday`、`pool`。
  已用 `prisma db push` 落地（SQLite `ALTER TABLE ADD COLUMN`，不丢数据）。

### 类型层
- `types/index.ts` — 新增 `SimTradeStage`、`SimTradePool`；`SimTradeInfo` / `SimTradeSnapshot`
  补 `stage`、`stageActionCompleted`、`remainingBuy`、`remainingSell`、`todayClose`、`stageFillPrice`、`pool`；
  `SubmitSimTradeActionInput.percent` 文档明确「BUY/SELL 必须显式给出 1~100」。

### 服务层
- `services/simtradeService.ts`（主战场）
  - 常量：`MAX_BUY_PER_DAY`、`MAX_SELL_PER_DAY`、`TRADABLE_STAGES`、`CLOSE_REVEALED_STAGES`、
    `MAX_CANDIDATE_BATCHES`。
  - 新增 `isTradableStage` / `isCloseRevealed` / `stageHint`。
  - `buildVisibleHistory(bars, currentDate, revealClose)` — 由「是否确认今日」改为「是否已揭示收盘」。
  - `getSimTradeSnapshot` — 新增 `todayClose`（未揭示恒为 `null`）、`stageFillPrice`、`tradable`、`remainingBuy/Sell`。
  - `submitSimTradeAction` — 阶段校验 + 额度校验 + 显式比例校验 + **原子占位** + 按阶段取成交价。
  - `advanceSimTradeStage`（替换 V1 的 `advanceSimTradeDay`）— 4 段流转，全部用条件更新防并发跳阶段。
  - `resolveQuantity` — 买入改为「预算约束下求最大整手数量」，费用取自 `calcFees` / `calcBuyOutlay`。
  - `pickRandomTarget` — 拆为 `pickRandomTargetOnce`（单批）+ `pickRandomTarget`（多批重试）。
  - `createSimTradeSession` — `pool` 校验（非 STOCK 明确拒绝）、抽股排除 ST、初始化阶段与额度。
- `services/marketDataService.ts` — `listRandomCodesHavingKlines(take, { excludeSt })` 增加 `name NOT LIKE '%ST%'`。
- `services/tradingEngine.ts` — 追加再导出 `calcBuyOutlay`（费用规则的单一出口）。

### API 层
- `app/api/simtrade/route.ts` — POST 接受并转发 `pool`。
- `app/api/simtrade/[id]/next/route.ts` — 调 `advanceSimTradeStage`（阶段推进语义）。

### 前端
- `components/SimTradeClient.tsx` — 全量重写：
  `STAGE_LABEL`、`StageBanner`、`PriceBlock`、`CloseAnimation`、`RatioSlider`、
  按 stage 四态渲染的 `TradeActionBar`；删除大盘三卡；`CLOSE_CONFIRMED` 与 `DAY_SETTLED`
  按钮文案区分（「结算今日」/「进入下一交易日」）。

### 测试
- `scripts/testSimTrade.ts` — V2 全量重写（阶段流转 / 双成交价 / 额度 / 失败不结束阶段 / 防泄漏 / 池拒绝）。
- `scripts/testSimTradeUI.ts` — V2 全量重写（阶段四态 / 额度门控 / 防泄漏 / 回归守卫）。
- `scripts/testSimTradeQA.ts` — 改 `advanceSimTradeStage` 调用；修正一处**本身不稳定**的断言（见 §五）。

### 文档
- `SIMTRADE-RULES.md` — 同步 V2 规则。
- 本文件。

## 三、验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | **0 错误** |
| 后端状态机 | `tsx scripts/testSimTrade.ts` | **85 通过 / 0 失败** |
| 前端契约 | `node -e "require('./runner.mjs').run('scripts/testSimTradeUI.ts')"` | **124 通过 / 0 失败** |
| QA 边界（含并发） | `tsx scripts/testSimTradeQA.ts` | **146 通过 / 0 失败** |
| 交易引擎 | `tsx scripts/testTradingEngine.ts` | 70 / 0 |
| 账户视图 | `tsx scripts/testAccountViews.ts` | 76 / 0 |
| 模拟交易（旧玩法） | `tsx scripts/testSimulation.ts` | 120 / 0 |
| 回测 | `tsx scripts/testBacktest.ts` | 134 / 0 |
| 并发（账户层） | `tsx scripts/testConcurrency.ts` | 9 / 0 |
| 行情 / K线 / 指标 / 图表 / 指数隔离 | `testMarketData` `testKlineAggregation` `testIndicators` `testKlineChartOption` `testIndexIsolation` | 71 / 96 / 31 / 70 / 46，全 0 失败 |
| 生产构建 | `node node_modules/next/dist/bin/next build` | **成功**（`Compiled successfully in 15.3s`，`/api/simtrade` 及其 `[id]/*` 子路由全部生成） |
| HTTP 集成测试 | `tsx scripts/testApiRoutes.ts`（`next start -p 3111`） | **38 通过 / 0 失败** |
| **V2 HTTP 端到端** | 临时探针走真实 HTTP 全流程（见下） | **32 通过 / 0 失败** |

### V2 HTTP 端到端覆盖（真实请求 `/api/simtrade*`，非直接调 service）

```
pool=INDEX / INDUSTRY 被拒 → pool=STOCK 建局
→ 初始 OPEN（todayClose=null、可交易、成交价=开盘价、额度 2/2）
→ 开盘观望 → OPEN_CONFIRMED（仍不可交易、todayClose 仍 null、观望不消耗额度）
→ 同阶段重复操作被拒
→ 推进 → CLOSE_ANIMATION（todayClose 已揭示、不可交易）
→ 推进 → CLOSE（可交易）
→ percent=null 被拒（不静默满仓）
→ 收盘买入 → CLOSE_CONFIRMED（剩余买额 1）
→ 推进 → DAY_SETTLED
→ 推进 → 下一交易日 OPEN（dayIndex=2、额度重置 2、todayClose 重置 null）
→ 删除会话
```

> 该探针为一次性验证脚本，跑完已删除；如需复跑可按上表步骤重建。
> 服务进程已停止（3111 端口已释放）。

数据库兼容：新增 6 列后旧会话（`stage` 取默认值 `OPEN`）仍可正常读取；
`toSimTradeInfo` 对「旧会话已确认今日」做了兼容映射（`OPEN` + `confirmedToday` → `CLOSE_CONFIRMED`）。

## 四、已知边界与偏离（**明确不做的部分**）

1. **INDEX / INDUSTRY 股票池不可用**（需求曾要求三池）。
   探查结论：`stocks.industry` 全为 `null`（无行业数据）；指数在 `market_index` / `index_klines`
   物理分表，与 `stocks` 无外键关联，而 `tradingEngine` 的 `Position`/`Order`/`Trade` 均以
   `stockId` 外键落库。
   处理：服务端**明确拒绝并给出原因**，不静默降级、不造假数据。
2. **每日额度与阶段数等价**：每天只有 2 个阶段、每阶段 1 次操作，因此「每日买 ≤2」
   在正常流程下与「开盘 1 次 + 收盘 1 次」等价。额度计数保留为显式护栏与 UI 展示。
3. **`snapshot.benchmarks` 仍在返回**（含查询开销），前端已不渲染。保留是为避免破坏 API 契约。

## 五、顺带修掉的 3 个既有缺陷（**V1 就存在，非 V2 引入**）

改动前先用 `git show HEAD:services/simtradeService.ts` 逐行比对确认了这三点在 V1 中同样存在。

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| 1 | **`percent` 缺省静默变成满仓**：`const rawPercent = input.percent ?? 100`，与紧邻注释「绝不静默退化为 100% 满仓」直接矛盾；`percent=null` 会变成 100% 全仓买入 | `testSimTradeQA` 报 `percent=null 竟然成功了！msg=开盘阶段已按 ¥38.77 完成买入` | 改为**必须显式给出**，缺省/`null`/`NaN`/越界一律拒绝 |
| 2 | **并发双提交可双倍成交**：V1 的幂等只是「先读 `confirmedToday` 再写」，两次并发请求可同时通过校验 | `testSimTradeQA` 报 `双倍成交局数=6 两次均返回成功局数=6` | 下单前加**原子占位（CAS）**；阶段推进也改为条件更新 |
| 3 | **大额预算下 100% 买入被误判「资金不足」**：费用按「一手费用」预留，费用实际随成交额线性增长（5000 万预算真实费用约 1.55 万，一手费用仅约 5 元） | 放大初始资金到 5000 万后 `percent=100 合法通过` 报「可用资金不足」 | 改为在「成交额 + `calcFees` 实际费用 ≤ 预算」约束下逐手回退求最大可买量 |

另修正 `testSimTradeQA.ts` 中一处**测试自身不稳定**的断言：
`percent=1 合法通过` 原用 10 万初始资金，1% = 1000 元往往不足一手成本（高价股一手可达数千元），
会被资金校验拒绝而误判成「1 不是合法比例」。已改为给足资金（5000 万），使该断言确定成立。

## 六、复现验证

```powershell
Set-Location D:\a-share-sim-trading
$node = "C:\Users\Administrator.USER-20260201WA\.workbuddy\binaries\node\versions\24.14.0\node.exe"

# 类型检查
& $node node_modules\typescript\bin\tsc --noEmit

# 后端状态机 / 前端契约 / QA 边界
& $node node_modules\tsx\dist\cli.mjs scripts/testSimTrade.ts
& $node -e "require('./runner.mjs').run('scripts/testSimTradeUI.ts')"
& $node node_modules\tsx\dist\cli.mjs scripts/testSimTradeQA.ts

# HTTP 集成（需先构建并起服务；注意先按端口反查强杀旧进程，否则会测到旧构建）
& $node node_modules\next\dist\bin\next build
& $node node_modules\next\dist\bin\next start -p 3111   # 另开一个终端
& $node node_modules\tsx\dist\cli.mjs scripts/testApiRoutes.ts
```

> 判定「新构建真的生效」：请求 `http://127.0.0.1:3111/api/simtrade` 应返回
> `Content-Type: application/json` 的 `{"success":true,...}`，而不是 404 HTML。

> Windows 提示：Node 的中文输出经 PowerShell 管道会乱码，
> 先执行 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 再调用 node；
> 且 PowerShell 的 stdout 不回传，需 `| Out-File $env:TEMP\xx.txt -Encoding utf8` 后用 Read 读取。
