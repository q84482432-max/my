# A股模拟交易项目 —— 全量代码审查报告

审查日期：2026-09-23
审查范围：`D:\a-share-sim-trading` 全仓库（约 2.15 万行核心代码，28 个 API 路由，7 个 service）
审查方式：逐文件精读 + 独立重算验证（不复用被审代码自证）+ 状态机可达性推演

---

## 一、结论摘要

项目整体工程质量**高于同类水平**。核心交易链路（费用、资金守恒、T+1、防未来数据）经独立重算验证**完全正确**，资金守恒偏差恒为 0。

发现 1 项 P1、4 项 P2、4 项 P3 问题。**无 P0（数据正确性/资金安全）问题。**

| 级别 | 数量 | 含义 |
|------|------|------|
| P0 | 0 | 资金/数据正确性缺陷 |
| P1 | 1 | 功能缺陷，用户可感知 |
| P2 | 4 | 健壮性/一致性问题 |
| P3 | 4 | 工程卫生问题 |

---

## 二、已验证正确的部分（含实证）

### 1. 交易费用与资金守恒 —— 独立重算，完全一致

独立实现 `calcFees` / `calcBuyOutlay` / `calcSellNetIncome` / `maxAffordableLots` 后对拍：

| 场景 | 买入价 | 数量 | 成本均价 | 实现盈亏 | 期末现金 vs 期望 |
|------|--------|------|----------|----------|------------------|
| 100,000 @ 14.88 | — | 6700 | 14.884613 | -161.52 | 99838.48 / 99838.48 **差 0** |
| 50,000 @ 7.77 | — | 6400 | 7.772409 | -80.57 | 49919.43 / 49919.43 **差 0** |
| 100,000 @ 100 | — | 900 | 100.031 | -145.80 | 99854.20 / 99854.20 **差 0** |

**100 轮同价往复压力测试**：实际损耗 149547.47 = 理论累计费用 149547.47，**偏差恒为 0**。
→ 结论：金额舍入**不累积**，不会凭空增减资金。这是本项目最关键的底层保证，成立。

### 2. `maxAffordableLots` 满仓判定正确

全部测试场景残金均严格小于「一手价格」，无「买得起却没买满」或「算过但下单被拒」的空间。逐手回退循环次数极少（费用随成交额单调递增），不退化。

### 3. T+1 结算的跨股票串味缺陷已修复且修复正确

`settleT1` 已按 `(accountId, stockId, tradedAt)` **逐股票**统计当日买入量，不再跨股票汇总。代码注释保留了缺陷记录，修法正确。

### 4. 防未来数据（核心红线）在会话类玩法上完整

- `/api/sim/*`、`/api/simtrade/*` 均在服务端强制 `asOfDate = currentDate`，客户端无法覆盖。
- `getKlineAt` / `getPrevKlineBefore` 的 `lte` / `lt` 语义区分正确，分时图 0 轴取前收不会退化为当日自己。
- 30m 游标裁剪走**唯一入口** `clipBarsToCount`，且按标准时点表取上界（不用 `slice`），异常数据不会把 13:30 当成「第一根」。
- 开盘阶段上限 7 根（第 8 根 15:00 = 当日收盘）—— 红线设置正确，`CLOSE_ANIMATION` 才置 8。

### 5. 回测引擎无未来函数

严格遵守「信号 T 日收盘产生 → T+1 日**开盘**成交」：
- 买入数量在**成交时点**按实际成交价计算，不用信号日价格定量；
- 刻意不做「同根 K 线收盘价成交」（那才是隐性未来函数）；
- `executionModel: "NEXT_OPEN"` 明示；
- 均线只用过去数据，`equityCurve` 逐根按序生成。
→ 时序模型正确。

### 6. 并发防护到位

- 资金校验、持仓校验**均在事务内**读取（避免写丢失竞态）；
- 操作用「以旧计数为条件」的 CAS 自增；
- pending 用 CAS 取走，双击不会成交两次；
- `settleAndAdvanceToNextDay` 以「日期是否变化」为硬终止条件，避免盲连两次 `/next` 提前揭示新日收盘。

### 7. 架构分层清晰

`lib/tradingRules.ts` / `lib/performanceMetrics.ts` / `lib/simtradeStage.ts` 三处纯函数下沉是**正确决策**：两个引擎共享口径却互不 import。阶段谓词收敛为唯一实现（有审计记录可查），避免了「两份会漂移的真相」。

---

## 三、发现的问题

### P1-1：`/api/account/orders` 绕过全部防泄漏校验，且成交日无格式校验

**位置**：`app/api/account/orders/route.ts:65`

**事实**：该路由调用 `placeOrder` 时**未传 `asOfDate`**：

```ts
const result = await placeOrder({
  accountId, stockCode: body.stockCode, side: body.side,
  orderType: body.orderType ?? "MARKET", price: body.price,
  quantity: body.quantity,
  tradeDate: body.tradeDate,   // ← 客户端完全可控
  // asOfDate 缺失 → undefined
});
```

于是 `tradingEngine.ts` 内两条防泄漏校验**全部短路**：
- `:601` `if (asOfDate && tradeDate && ...)` → 永不触发
- `:647` `if (asOfDate && barDate !== asOfDate)` → 永不触发

**影响**：
1. **`tradeDate` 无格式校验**。`placeOrder` 只用 `normalizeDate()`，非法字符串会退化为 `NaN` 日期并落库。
2. **可无限回溯成交**。前端 `StockDetail.tsx:134` 明确暴露该输入框（页面注释说明这是「模拟 T+1 往返」的设计）。这本身**不是未来函数**（`getKlineAt` 是 `lte` 语义，只取历史价），但接口层无任何边界。
3. **传未来日期会被静默改写**。`getKlineAt` 取「最后一根」= 最新交易日，`fillDate` 被写成 `barDate`（最新交易日）而非用户传的未来日期 —— 用户看到「成交日 ≠ 我填的日期」却无提示。

**影响范围**：仅 `/api/account/*`（普通模拟账户，无「隐藏标的 / 防未来」语义）。`/api/sim/*` 与 `/api/simtrade/*` **不受影响**（服务端强制 `asOfDate`）。

**建议**：加 `^YYYY-MM-DD$` 格式校验 + `tradeDate <= 最新交易日` 上界校验；若产品确实需要回溯成交，应显式传 `asOfDate`（可用当前日期）以恢复第二条校验的语义。

---

### P2-1：新交易日 30m 游标起点与首日不一致（设计不对称）

**位置**：`services/simtradeService.ts:699`（创建，初值 `0`）vs `:2158`（换日，重置为 `1`）

**事实**：首日游标从 **0** 起（只知 09:30 开盘价），换日后却从 **1** 起（已揭示第 1 根 10:00）。

**注意**：这不是 bug —— 测试 `testSimTrade.ts:425`、`testSimTradeV3Engine.ts:216`、`testSimTradeV3NextDay.ts:79` 均**明确断言**「新日游标 = 1」，属有意设计。

**但存在真实的不对称**：玩家在首日开局看到的是「09:30 一个点」，第二日起开局看到「09:30 + 10:00 两个点」。同一玩法内两种起点口径，会让玩家困惑「为什么第二天一开盘就多了一个点」，也让 `/api/intraday` 的 `barCount` 语义在两种日期下不同。

**建议**：要么统一为 0（推荐，与「刚开盘」语义一致），要么在界面文案上说明差异。若改，需同步更新上述 3 处测试断言。

---

### P2-2：`computeDailyUnitFactors` 在日K 缺失时静默退化为 1，成交量柱高估约 100 倍

**位置**：`lib/intraday30m.ts:461-474`

**事实**（已实证）：

```
dailyVolume=0 时 volumeFactor=1
fullDay30mVolume=0 时 volumeFactor=1
第8根揭示 volume=123456 vs 官方日K=123456 → 一致 ✓（正常路径正确）
```

正常路径**完全正确**，15:00 定格无跳变。但当日K 数据缺失（`dailyBar` 为 null，如停牌日或数据缺口）时因子退化为 `1`，而 30m 的 volume 单位是**股**、日K 是**手** —— 此时当日成交量柱会比历史柱**高约 100 倍**。

代码注释已说明「因子从不出现在响应中，玩家无法据此反推」，泄漏性无问题；但**量纲错乱**是可见的图表缺陷。

**建议**：日K 缺失时不应退化为 `1`，应退化为「不画成交量柱」或按 100 的固定量纲比兜底。

---

### P2-3：`package.json` 的 `test:all` 未覆盖 7 个测试文件

**位置**：`package.json:36`

**事实**：`test:all` 串联 14 个测试，但 `scripts/` 下有 **19 个 `test*.ts`**，未纳入的包括：

```
testSimTradeV3Intraday.ts        ← 上一轮修的就是这个文件对应的 API 层
testSimTradeV3IntradayChart.ts   ← 含「Math.max(...,1) 兜底」防回归断言
testSimTradeV3Engine.ts
testSimTradeV3NextDay.ts
testSimTradeV3Deadlock.ts
testSimTradeQA.ts
testStockQuoteOhlc.ts
```

**这是上一轮教训的直接延续**：上次「只跑 7 个测试会漏掉 API 层 bug」—— 现在 `test:all` 仍漏掉 7 个，其中 `testSimTradeV3IntradayChart.ts` 正是**专门为守住 `Math.max(...,1)` 兜底回归而写的**断言。它不在 `test:all` 里，等于这道防回归闸门日常不生效。

**建议**：把全部 `test*.ts` 纳入 `test:all`（或改用 glob 自动收集）。这是**最高性价比的修复**。

---

### P2-4：项目未纳入版本控制，`git ls-files` 返回 0

**位置**：仓库根目录

**事实**：`git ls-files | wc -l` → **0**。项目**完全没有纳入 Git**，`.gitignore` 写得相当完善（甚至包含凭据保护 `/deploy/remote.py`），但没有任何文件被跟踪。

**风险**：
- 无任何变更历史，无法回滚；
- `.gitignore` 里刻意保护的 `deploy/remote.py`（含服务器明文密码）若将来误 `git add .`，保护失效时无从追溯；
- 上一轮「误编辑 config 靠备份恢复」的教训说明本机已有过不可逆损失。

**建议**：立即 `git init` + 首次提交。**注意**：提交前先确认 `deploy/remote.py`、`.env`、`prisma/*.db` 均被正确忽略。

---

### P3-1：仓库根目录 78 个临时脚本 + 24 个日志文件 + 15 个过程文档

**位置**：仓库根目录

**事实**：

```
根目录文件总数 117，其中：
  _ 开头临时脚本    78 个（_p5_*.py / _phase*.py / _db_hard*.py / _probe*.py ...）
  .err/.out/.log/.txt 24 个（_step1.err / _step2.out / build_out.txt ...）
  *.md 过程文档      15 个（PHASE1-REPORT.md / SIMTRADE-V2-*.md / SOURCE-SYNC-TODO.md ...）
```

这些是历史调试遗留（30m 数据修复、OOM 排查、并发复现、数据库加固等），**不应留在仓库根目录**。其中 `_probe_server.py`、`_sftp_get.py` 等属一次性探针，`PHASE*-REPORT.md` 属已完成阶段的过程产物。

**建议**：归档到 `docs/archive/` 或直接删除（都是可再生的调试脚本）。**注意**：`SOURCE-SYNC-TODO.md`、`MARKET-DATA-OPS.md` 可能仍是有效运维文档，需人工确认后再决定。

---

### P3-2：`Kline.volume` 字段单位注释与 `IndexKline` 不一致，且与实现相反

**位置**：`prisma/schema.prisma:277` vs `:574`

**事实**：

```prisma
model Kline  { volume BigInt  /// 成交量（股）...  }   ← 注释说「股」
model IndexKline { volume BigInt /// 本表统一按「股」存储 ... }  ← 注释说「股」
```

而 `lib/intraday30m.ts:444` 的实测记录明确写：

> `klines.volume`（日K）以**手**计（1 手 = 100 股，A股惯例）；而 30m parquet 的 volume 以**股**计。

→ **schema 注释与实测结论相反**。这正是 `computeDailyUnitFactors` 存在的原因（需要 ×0.01 换算）。将来若有人信注释去写取数逻辑，会引入 100 倍误差。

**建议**：把 `Kline.volume` 注释改为「手（1 手 = 100 股）」，`IndexKline.volume` 若确为「股」则加一行说明「与 klines 单位不同，勿直接比较」。

---

### P3-3：`refreshDailyAsset` 的 `dailyReturn` 在跨非交易日递减时可能失真

**位置**：`services/tradingEngine.ts:1094-1101`

**事实**：`prev` 取「严格早于当日的最近一条快照」，`prevAsset` 缺省为 `initialCash`。若账户中间有跳空（如会话直接从首日跳到第 5 日），`dailyReturn` 会算成「跨越 5 日的总变化」却标记为「日收益」。

会话推进走固化日历、逐日推进，正常流程不会出现跳空；但普通账户若隔多日才下单一次，`refreshDailyAsset` 会在此处产生一个被误标的「日收益」，进而影响 `calcPerformance` 的波动率/夏普（把多日波动当日波动，低估年化波动率 → 高估夏普）。

**建议**：`prev` 缺失或间隔 > 1 个交易日时，把 `dailyReturn` 置 0 而非算跨期收益。

---

### P3-4：`buildSettlement` 的买入持有基准与策略基准口径不同

**位置**：`services/simtradeService.ts:1434`

**事实**：

```ts
const lots = Math.floor(info.initialCash / startClose / 100);  // 未预留手续费
const qty = lots * 100;
```

买入持有基准按「初始资金 ÷ 首日开盘价」取整手，**未扣除买入费用预留**，可能出现「理论买得起，实际买不起」的边界（临界场景下高估 1 手）。`buyHoldProfit` 计算里确实扣了 `buyFees`，但数量已按无费用口径确定。

对比 `backtestEngine.ts:753` 用的是 `maxAffordableLots(initialCash, first.close)` —— **两个「买入持有基准」实现不一致**。

**建议**：`simtradeService` 改用 `maxAffordableLots`，与回测引擎统一口径。

---

## 四、修复优先级建议

| 顺序 | 问题 | 理由 |
|------|------|------|
| 1 | **P2-3** `test:all` 补齐 7 个测试 | 最高性价比。上一轮已因漏跑测试漏掉 API 层 bug，且 `testSimTradeV3IntradayChart.ts` 是专门的防回归闸门 |
| 2 | **P2-4** 纳入 Git | 无版本控制是最大系统性风险 |
| 3 | **P1-1** 补 `tradeDate` 格式与上界校验 | 唯一的 P1，且修复成本极低（2 行） |
| 4 | **P2-2** 量纲因子退化兜底 | 图表可见缺陷 |
| 5 | **P3-2** 修正 schema 注释 | 防后人被误导引入 100 倍误差 |
| 6 | **P2-1** 游标起点统一 | 需同步改 3 处测试断言 |
| 7 | P3-1 / P3-3 / P3-4 | 卫生与一致性 |

---

## 五、审查方法说明

为避免「用被审代码自证」的循环论证，本次审查采用：

1. **独立重算**：不复用 `lib/tradingRules.ts`，用独立实现的等价函数对拍费用与资金流，覆盖 6 组价格场景 + 100 轮同价往复压力测试。
2. **边界穷举**：对 `maxAffordableLots`、`clipBarsToCount`、`computeDailyUnitFactors` 逐一遍历退化输入（0、负数、缺失）。
3. **状态机可达性推演**：枚举 6 个阶段的全部分支，确认无死锁、无环、无不可达。
4. **契约交叉核对**：schema 注释 × 代码实现 × 测试断言 × 前端消费四处交叉，找出互相矛盾处（P3-2、P2-1 均由此发现）。
5. **静态路径追踪**：对 `asOfDate` 参数从 API 路由追到引擎分支，确认短路条件（P1-1）。

---

## 六、未覆盖范围（如实声明）

- **未做运行时端到端测试**：本次为静态审查 + 纯函数层独立验证，未启动服务跑真实 HTTP 请求。
- **未审查的模块**：`components/` 23 个 tsx 仅审查了与交易契约相关的部分（`SimTradeClient` 游标消费、`StockDetail` 下单入参），图表组件的渲染细节未逐一核对。
- **数据层未做完整性校验**：未验证 `dev.db` 中 5558 只股票的 K 线缺口、30m parquet 覆盖完整性（属数据运维范畴，非代码问题）。
- **未验证线上部署状态**：本次审查对象为本地代码，未与线上 `111.229.225.7` 运行版本做差异比对。
