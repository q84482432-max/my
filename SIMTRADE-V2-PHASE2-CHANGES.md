# SIMTRADE V2 — Phase 2 变更记录（数据模型 / 阶段状态机字段）

> **阶段**：Phase 2 — 数据库 schema 扩展
> **项目**：`D:/a-share-sim-trading`
> **日期**：2026-09-21
> **变更文件**：`prisma/schema.prisma`（仅此一个源码文件）

---

## 1. 变更内容

`SimTradeSession` 模型新增 **6 个字段**（位于 `confirmedDate` 与 `calendar` 之间）：

| 字段 | 类型 | 默认值 | 用途 |
|---|---|---|---|
| `stage` | `String` | `"OPEN"` | 当前交易阶段：`OPEN` / `OPEN_CONFIRMED` / `CLOSE_ANIMATION` / `CLOSE` / `CLOSE_CONFIRMED` / `DAY_SETTLED` |
| `stageActionCompleted` | `Boolean` | `false` | 本阶段是否已完成 1 次有效操作（成功买入/卖出/观望 → true；**交易失败保持 false、阶段不结束**） |
| `stageActionAt` | `DateTime?` | `null` | 本阶段操作完成时间 |
| `buyCountToday` | `Int` | `0` | 当日**成功买入**次数（开盘+收盘共享，上限 2） |
| `sellCountToday` | `Int` | `0` | 当日**成功卖出**次数（开盘+收盘共享，上限 2） |
| `pool` | `String` | `"STOCK"` | 股票池类型：`STOCK`（全部 A 股）/ `INDEX`（指数）/ `INDUSTRY`（行业板块） |

**保留未动**：`confirmedDate` 字段保留，语义收窄为「收盘阶段已完成」的标记；阶段推进一律以 `stage` 为准。

---

## 2. 执行的操作

1. **备份**（改前）：
   - `prisma/dev.db`（811,642,880 bytes）→ `D:\simtrade-backup\20260921-phase2\dev.db`
   - `prisma/schema.prisma` → `D:\simtrade-backup\20260921-phase2\schema.prisma`
2. **同步 schema**：`prisma db push --skip-generate` → `Your database is now in sync with your Prisma schema. Done in 549ms`
   - SQLite `ALTER TABLE ADD COLUMN`（全部带默认值），**不重建表、不丢数据**
3. **重生成客户端**：`prisma generate` → `Generated Prisma Client (v6.19.3) in 2.15s`

---

## 3. 验证证据

| 验证项 | 结果 |
|---|---|
| `PRAGMA table_info(sim_trade_sessions)` | 6 列全部存在，默认值正确（`stage TEXT default='OPEN'`、`buyCountToday INTEGER default=0`、`pool TEXT default='STOCK'` 等） |
| 旧会话兼容读取 | **11 条**现存会话全部可读，自动落入 `stage=OPEN` / `stageActionCompleted=false` / `buyCountToday=0` / `sellCountToday=0` / `pool=STOCK` |
| `tsc --noEmit` | **0 错误** |
| `scripts/testSimTrade.ts`（现有回归） | **43 通过 / 0 失败**（含防泄漏哨兵、T+1、两阶段确认、终局结算、揭晓） |

---

## 4. 本阶段未改动（留待 Phase 3+）

- `services/simtradeService.ts` —— 阶段状态机逻辑、双阶段成交价、额度校验
- `app/api/simtrade/**` —— 阶段语义路由
- `components/SimTradeClient.tsx` —— 阶段 UI、滑块、删指数卡
- `lib/tradingRules.ts` / `lib/constants.ts` —— **费用规则保持不变（复用）**
- `services/tradingEngine.ts` —— 撮合逻辑不变（复用）

---

## 5. 回滚方式

```powershell
Copy-Item D:\simtrade-backup\20260921-phase2\dev.db        D:\a-share-sim-trading\prisma\dev.db -Force
Copy-Item D:\simtrade-backup\20260921-phase2\schema.prisma D:\a-share-sim-trading\prisma\schema.prisma -Force
# 然后重新 prisma generate
```

---

## 6. 下一步（Phase 3 建议）

在 `services/simtradeService.ts` 实现阶段状态机：

1. 新建 `getStageOpenPrice` / `confirmStageAction` / `advanceStage`
2. `submitSimTradeAction` 按 `stage` 分支：`OPEN` → 开盘价成交；`CLOSE` → 收盘价成交
3. 额度校验：`buyCountToday < 2` / `sellCountToday < 2`
4. 失败路径确保 `stageActionCompleted` 不被写入
5. **防泄漏红线**：`OPEN` 阶段 `buildVisibleHistory` 仍不得暴露当日 `high/low/close`
