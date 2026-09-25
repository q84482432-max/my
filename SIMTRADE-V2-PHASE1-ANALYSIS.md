# SIMTRADE V2「猜股票」Phase 1 架构分析报告

> **性质**：只读分析交付物。本阶段**未修改任何业务源码**。
> **项目路径**：`D:/a-share-sim-trading`
> **依据**：V2 需求第三十四条（Phase 1 八项输出）、第三十三条（复用现有规则、不得建立第二套交易规则）
> **产出日期**：2026-09-21

---

## 0. 一句话结论

现有 V1 已经具备「隐藏标的 + 复用 tradingEngine 撮合 + T+1 + 防未来数据」的完整骨架，但**每日只有一个"确认"动作（统一按当日收盘价结算）**，没有"开盘阶段 / 收盘阶段"两个独立交易阶段，也没有阶段状态机、每日买卖次数额度、股票池类型选择、停牌跳过、ST 过滤。

V2 的改造面收敛在：**1 张表 + 3 个核心服务函数 + 3 个 API 路由 + 1 个前端组件**。费用规则（佣金 0.03% 双向最低 ¥5、印花税 0.1% 仅卖出、过户费 0.001% 双向）**完全不需要改**，直接复用。

---

## 1. 当前架构

分层职责：

| 层 | 文件 | 职责 |
|---|---|---|
| 数据层 | `prisma/schema.prisma` | Stock / Kline / MarketIndex / IndexKline / Account / Order / Trade / Position / DailyAsset / SimTradeSession |
| 引擎层 | `services/tradingEngine.ts` | **唯一撮合路径**（`placeOrder` 581-682、`executeBuy` 700-819、`executeSell` 838-944），费用唯一实现在 `lib/tradingRules.ts:calcFees`（98-108） |
| 玩法层 | `services/simtradeService.ts`（1117 行） | 随机选股、会话推进、快照构建、身份隐藏 |
| 接口层 | `app/api/simtrade/**` | route / [id] / [id]/action / [id]/next / [id]/reveal |
| 视图层 | `app/simtrade/page.tsx` + `components/SimTradeClient.tsx`（1057 行） | 移动端优先的操作界面 |

**两个关键隔离设计（V2 必须继承）**：

1. **账户物理隔离**：`Account` 同时持有 `simulationId String? @unique` 与 `simTradeSessionId String? @unique`（schema.prisma:43-71）；`tradingEngine.createAccount`（120-148）支持双归属，`ensureDefaultAccount`（159-172）用 `simulationId:null, simTradeSessionId:null` 双过滤，确保普通账户不会串到玩法账户。
2. **指数与个股物理分表**：`MarketIndex` / `IndexKline`（schema.prisma:487 / 515）与 `Stock` / `Kline` 分离，因为 000001 等代码撞码、复权口径语义不同（schema.prisma:457-484）。

**费用常量**位于 `lib/constants.ts:6-19`，V2 第二十一条要求保持不变。

---

## 2. 当前交易流程（V1）

```
创建   POST /api/simtrade
       └─ createSimTradeSession (305)
          ├─ 随机起始交易日（保留 >=60 根历史）
          ├─ pickRandomTarget (208) 随机抽股（隐藏身份）
          └─ tradingEngine.createAccount（独占账户）

读盘   GET /api/simtrade/:id
       └─ getSimTradeSnapshot (490)
          ├─ 可见 K 线右端锁 currentDate，当日仅暴露 open（buildVisibleHistory 469）
          └─ 大盘参照（上证/深证/创业板）当日未结算时取 open

操作   POST /api/simtrade/:id/action  { action: BUY|SELL|HOLD, percent }
       └─ submitSimTradeAction (818)
          ├─ 按**当日收盘价**成交（placeOrder tradeDate = currentDate）
          ├─ refreshDailyAsset
          └─ 写 confirmedDate = currentDate（**不推进日期**）

推进   POST /api/simtrade/:id/next
       └─ advanceSimTradeDay (985)
          ├─ 前置：必须 confirmedToday
          ├─ settleT1(accountId, nextDate)  ← T+1 解冻
          ├─ currentDate = nextDate，清 confirmedDate
          └─ 日历末尾 → FINISHED

揭晓   POST /api/simtrade/:id/reveal
       └─ revealSimTradeStock (1075)  ← 唯一返回 code/name 的接口，仅 FINISHED 允许
```

**V1 与 V2 的核心差距**：

| | V1 | V2 |
|---|---|---|
| 每日操作机会 | 1 次（选动作 → 确认） | 2 次（开盘阶段 1 次 + 收盘阶段 1 次） |
| 成交价 | 统一当日收盘价 | 开盘阶段 = 开盘价；收盘阶段 = 收盘价 |
| 阶段状态 | 无（仅 confirmedToday 布尔） | OPEN → OPEN_CONFIRMED → CLOSE_ANIMATION → CLOSE → CLOSE_CONFIRMED → DAY_SETTLED |
| 每日额度 | 无 | 成功买入 ≤2 次/天、成功卖出 ≤2 次/天（两阶段共享） |
| 交易失败 | 保持未确认、可重选 | 同（保持 `stageActionCompleted=false`，阶段不结束） |
| 股票池 | 仅个股 | 个股 / 指数 / 行业板块 三选一 |
| 停牌处理 | **排除会停牌的股票** | **停牌日跳过且不消耗有效游戏日** |
| ST 过滤 | 无 | 排除 ST / *ST / 退市整理期 |

---

## 3. 需修改的文件（11 个）

| # | 文件 | 性质 | 说明 |
|---|---|---|---|
| 1 | `prisma/schema.prisma` | **改（DB）** | `SimTradeSession`（128-169）新增阶段状态机与额度字段 |
| 2 | `services/simtradeService.ts` | **改（核心）** | 阶段状态机、双阶段成交价、次数额度、股票池、停牌跳过、ST 过滤、结算复用 calcFees |
| 3 | `services/marketDataService.ts` | 改 / 增 | 候选池按 pool 查不同表（1030、1056），ST 过滤 |
| 4 | `app/api/simtrade/[id]/action/route.ts` | 改 | 接受阶段语义、返回阶段与剩余额度 |
| 5 | `app/api/simtrade/[id]/next/route.ts` | 改 | 由"确认后推进"改为"阶段推进" |
| 6 | `app/api/simtrade/route.ts` | 改 | 创建时接受 `pool` 参数 |
| 7 | `types/index.ts` | 改 | SimTrade DTO（429-664）增阶段与额度字段 |
| 8 | `components/SimTradeClient.tsx` | **改（核心）** | 阶段状态、滑块、T+1 灰按钮、删指数卡、收盘动画 |
| 9 | `app/simtrade/page.tsx` | 微调 | 入口/文案 |
| 10 | `scripts/testSimTrade.ts` / `testSimTradeUI.ts` | 改 / 增 | 阶段、额度、停牌、双阶段成交价断言 |
| 11 | `lib/constants.ts` / `lib/tradingRules.ts` | **只读复用** | 费用规则不变，V2 明确要求复用 |

**不需要改**：`app/indices/**`、`components/IndexBoard.tsx`、`components/IndexOverview.tsx`（指数页面本身保留，只是交易界面不展示指数卡片）、`services/tradingEngine.ts`（撮合与费用逻辑完全复用）。

---

## 4. 需修改 / 新增的函数

| 函数 | 位置 | 动作 |
|---|---|---|
| `pickRandomTarget` | simtradeService.ts:208 | **改**：新增 `pool` 参数、ST/退市排除、停牌容忍策略 |
| `createSimTradeSession` | :305 | **改**：接受 `pool`，初始化阶段字段与额度计数 |
| `buildVisibleHistory` | :469 | **改**：按阶段决定是否揭示当日 high/low/close |
| `getSimTradeSnapshot` | :490 | **改**：DTO 增 `stage` / `stageActionCompleted` / 剩余额度 |
| `buildSettlement` | :726（**754-760 手写费用**） | **改**：改为复用 `calcFees`（现存缺陷，见 §9） |
| `submitSimTradeAction` | :818 | **改（核心）**：按 `stage` 选成交价、校验额度、失败不结束阶段 |
| `resolveQuantity` | :929 | 基本复用；按剩余额度裁剪 |
| `advanceSimTradeDay` | :985 | **改**：拆为阶段推进（OPEN→CLOSE→DAY_SETTLED→下一日） |
| `revealSimTradeStock` | :1075 | 复用，前置条件随 FINISHED 语义微调 |
| `listRandomCodesHavingKlines` | marketDataService.ts:1030 | **改**：按 `pool` 查 stocks / indices / 行业板块 |
| `listCandidatesCoveringRange` | marketDataService.ts:1056 | **改**：停牌容忍（允许缺口） |
| 新增 `getStageOpenPrice` / `confirmStageAction` / `advanceStage` | simtradeService.ts | **新增**：阶段状态机实现 |

---

## 5. 数据库是否修改 —— **是**

`SimTradeSession`（schema.prisma:128-169）当前**没有任何阶段状态机字段**，仅有 `confirmedDate DateTime?`（149）表达"当日已确认"。

需新增（均为带默认值字段，向后兼容）：

```
stage                String   @default("OPEN")   // OPEN | OPEN_CONFIRMED | CLOSE | CLOSE_CONFIRMED | DAY_SETTLED
stageActionCompleted Boolean  @default(false)    // 本阶段是否已完成一次有效操作
stageActionAt        DateTime?                   // 本阶段操作时间
buyCountToday        Int      @default(0)        // 当日成功买入次数（上限 2）
sellCountToday       Int      @default(0)        // 当日成功卖出次数（上限 2）
pool                 String   @default("STOCK")  // STOCK | INDEX | INDUSTRY
```

**迁移要点**：
- 新增字段全部带默认值，`prisma migrate` 对已有 ACTIVE 会话安全（旧会话自动落入 `stage=OPEN`、计数 0）。
- `confirmedDate` 建议保留作为"当日结算完成"的兼容标记，或迁移为 `closeConfirmedDate`，**需保证旧会话可继续游玩**。
- 若要做"停牌跳过不消耗游戏日"，`calendar`（152）语义需从"固定 N 个交易日"变为"有效游戏日序列"，需评估是否新增 `effectiveCalendar` 字段。

---

## 6. API 是否修改 —— **是**

| 端点 | 改动 |
|---|---|
| `POST /api/simtrade` | 新增 `pool`（STOCK/INDEX/INDUSTRY） |
| `GET /api/simtrade/:id` | 响应增 `stage`、`stageActionCompleted`、`remainingBuy`、`remainingSell` |
| `POST /api/simtrade/:id/action` | 阶段由服务端按 `session.stage` 推导（客户端不传，防作弊）；响应增阶段与新额度；失败保持阶段不结束 |
| `POST /api/simtrade/:id/next` | 由"确认后推进整日"改为"阶段推进" |
| `POST /api/simtrade/:id/reveal` | 无需结构改动 |

**无需改动**：所有路由已使用 Next 16 的 `params: Promise<{id}>` 写法（action/route.ts:18、next/route.ts:18、[id]/route.ts:22、reveal/route.ts:17），符合当前框架规范。

**防泄漏口径必须保持**：`/action` 与 `/[id]` 均不接受任何日期参数（route.ts:9-19 注释），可见上界由服务端 `currentDate` 强制；`/reveal` 是唯一返回 code/name 的端点且仅 FINISHED 允许。

---

## 7. 前端需修改的页面

**`components/SimTradeClient.tsx`（核心，1057 行）**：

| 位置 | 当前 | V2 目标 |
|---|---|---|
| `RATIOS = [10,30,50,100]`（:51） | 四档固定比例 | 滑块 + 数字双向同步，1%~100% |
| `SimTradeBoard`（:431） | 进度徽章 + 账户汇总 | 增**阶段状态**显著展示 |
| 大盘参照三卡（:475-505） | 上证/深证/创业板 | **删除** |
| `OpenPriceBlock`（:612） | 今日开盘最大字号 | 保留，按阶段调整文案 |
| `TradeActionBar`（:880-1031） | 三段式（选动作+比例+确认 / 待确认 / 进入下一日） | 改为阶段式：开盘阶段操作 → 收盘动画 → 收盘阶段操作 |
| T+1 不可卖 | 已有状态 | 灰色禁用按钮（视觉强化） |
| 收盘动画 | 无 | **新增**组件（先公布收盘价再开放收盘阶段交易） |

**`app/simtrade/page.tsx`**：仅 metadata 与容器（当前 1-11 行），微调文案即可。

**不修改**：`app/indices/page.tsx`、`components/IndexBoard.tsx`、`components/IndexOverview.tsx`。

---

## 8. 兼容性问题

1. **旧会话迁移**：现存 ACTIVE 会话无阶段字段，依赖默认值续玩；`confirmedDate` 语义迁移需谨慎，避免进行中的会话卡死。
2. **防泄漏口径**：`buildVisibleHistory`（469）当前逻辑是"当日未确认 → high/low/close 用 open 占位"。V2 拆阶段后，**开盘阶段必须仍不返回当日 close/high/low**，收盘阶段动画完成后才揭示——这是最容易写错的点。
3. **成交价口径变更影响绩效**：V1 全部按收盘价，V2 开盘阶段按开盘价，历史绩效与"买入持有基准"对比口径随之变化，UI 需明确说明。
4. **交易失败语义**：V2 第六条要求失败不消耗额度、阶段不结束；现有 `OrderRejectError` 拒单机制可直接复用，但 `submitSimTradeAction` 需确保失败时不写 `stageActionCompleted`。
5. **`buildSettlement` 手写费用**（**现存缺陷**）：simtradeService.ts:754-760 手写了佣金/印花税/过户费公式，注释称"与 constants 一致"，但**未调用 `calcFees`**，存在规则漂移与舍入口径不一致风险 → 直接违反 V2 第三十三条。
6. **`Stock.adjust` 与 `Kline.adjust` 默认值不一致**：schema.prisma:191 默认 `qfq`，:234 默认 `none`，新导入数据若遗漏可能取错复权口径。
7. **测试脚本覆盖**：`package.json:19-35` 中 `test:all` 包含 `test:simTrade` 但**不含 `test:simTradeUI`**，UI 回归需单独跑。
8. **`POST /action` 非法 JSON 直接 500**：其他路由有 400 兜底，此处缺 JSON 解析容错。

---

## 9. Phase 1 附带发现的关键风险（建议 Phase 2 一并修）

| 风险 | 位置 | 影响 |
|---|---|---|
| 结算费用未复用 `calcFees` | simtradeService.ts:754-760 | **违反"不建立第二套规则"**，必修 |
| 停牌策略语义相反 | pickRandomTarget:257-270 | 当前"排除会停牌的股票" vs V2"停牌日跳过、不消耗游戏日" |
| 无 ST/退市过滤 | listRandomCodesHavingKlines:1030-1040 | 仅 `isActive=1`，`Stock` 无 `isSt` 字段 |
| 股票池仅个股 | 同上 | 无法选指数池 / 行业板块池 |
| adjust 默认值不一致 | schema.prisma:191 / 234 | 数据一致性 |

---

## 10. 建议的 Phase 2 起步顺序

1. **先改 DB**：`SimTradeSession` 加阶段与额度字段 → `prisma migrate` → 验证旧会话可续玩。
2. **再改服务层状态机**：`advanceStage` / `submitSimTradeAction` 按阶段分支，**先保证防泄漏口径不回退**（开盘阶段当日仅 open）。
3. **然后补测试**：阶段流转、额度上限、失败不结束阶段、双阶段成交价、停牌跳过、ST 排除 —— 用 `scripts/testSimTrade.ts` 扩展（TDD，先红后绿）。
4. **同步修 `buildSettlement` 复用 `calcFees`**，消除规则漂移。
5. **最后改前端**：滑块、阶段状态、删指数卡、T+1 灰按钮、收盘动画。
6. **收尾**：更新 `SIMTRADE-RULES.md`，跑通 `test:all` + `test:simTradeUI`。

---

## 附：本次分析的文件读取清单

`services/simtradeService.ts`、`services/marketDataService.ts`、`services/tradingEngine.ts`、`lib/tradingRules.ts`、`lib/constants.ts`、`prisma/schema.prisma`、`components/SimTradeClient.tsx`、`app/simtrade/page.tsx`、`app/api/simtrade/route.ts`、`app/api/simtrade/[id]/route.ts`、`app/api/simtrade/[id]/action/route.ts`、`app/api/simtrade/[id]/next/route.ts`、`app/api/simtrade/[id]/reveal/route.ts`、`types/index.ts`、`scripts/testSimTrade.ts`、`scripts/testSimTradeUI.ts`、`package.json`

**未修改任何文件。**
