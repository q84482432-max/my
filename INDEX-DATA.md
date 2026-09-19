# 指数数据（INDEX-DATA）

> 建立时间：2026-09-19
> 相关：`prisma/schema.prisma`（MarketIndex / IndexKline）· `services/indexDataService.ts` · `scripts/testIndexIsolation.ts`

## 一、为什么需要这份设计

主库原本**只有个股，没有任何指数** —— `stocks.board` 只有 `MAIN/GEM/STAR/BSE`，
`399001`/`399006`/`000300` 一律查不到；`000001` 是平安银行，不是上证指数。

项目里唯一跟指数有关的东西是 `market-daily-update.py` 的 `INDEX_SYM = "sh000001"`，
但它**只拉 6 根用来探测当天是不是交易日，拉完就丢**，从不落库。

短线盯盘和模拟交易都需要大盘参照（今天上证涨跌多少、情绪如何），所以补齐了 9 个主要指数。

## 二、核心决策：物理分表，而不是加板块枚举

最初的方案是「把指数塞进 `stocks` + `klines`，用 `board = 'INDEX'` 区分，再在所有个股查询里加排除条件」。
**这个方案被否掉了**，改成分表。原因如下。

### 问题 1：代码冲突无法解决

`stocks.code` 是 `@unique`，且**不带交易所后缀**。而 A 股指数与个股大面积撞码：

| 裸代码 | 个股身份 | 指数身份 |
|---|---|---|
| `000001` | 平安银行（SZ） | 上证指数（SH） |
| `000905` | 厦门港务 | 中证 500 |
| `000016` | *ST康佳A | 上证 50 |
| `000688` | 国城矿业 | 科创 50 |

入同一张表就必须改 `code` 口径或加后缀，会波及全部既有取数路径（`getKlines`、交易引擎、回测引擎全部按 code 取数）。

### 问题 2：靠 where 条件排除是「约定式隔离」，一定会漏

个股枚举分散在 `marketDataService.ts` 的 8 处以上，且**其中两处是全表扫描、没有板块过滤**：

| 位置 | 风险 |
|---|---|
| `listCodesHavingKlines()` | `/api/market` 用它取全市场代码，再生成**成交活跃 / 涨幅榜 / 跌幅榜** —— 指数会被排进个股榜单 |
| `getMarketStats().klineCount` = `prisma.kline.count()` | **无任何过滤**，指数 K 线直接计入「K 线总数」 |
| `getMarketStats()` 的 `rangeAgg` | 同样无过滤，会把「数据窗口」从 `2024-11-04` 变成 `2006-03-01` |
| `getStockList()` / `getStockList().count` | 不传 `board` 时不过滤 |
| `searchStocks()` | 按名称模糊匹配，搜「上证」会命中指数 |
| `listStockCodes()` | 全表 |
| `listRandomCodesHavingKlines()` | 裸 SQL，模拟炒股「随机选股」有概率抽到指数 |
| `listCandidatesCoveringRange()` | 回测/模拟的候选预筛 |

任一处漏改就是**静默的数据错误**：不是报错，而是数字悄悄变了。
「约定式隔离」需要 8 个地方永远保持正确；分表是「结构式隔离」，现有查询**物理上读不到**指数。

### 问题 3：复权口径语义不同

`klines.adjust` 是必填字段（`qfq`/`none`/`hfq`）。指数没有除权除息，不存在复权概念，
硬塞只能用 `'none'` 占位，还会污染 `getMarketStats().byAdjust` 的统计口径。

## 三、最终设计

两张新表，`IndexKline` 刻意**不带 `period` / `adjust` 字段** —— 指数只有日线、无复权，
给字段就是给误解留口子。

```prisma
model MarketIndex {
  id       String @id @default(cuid())
  code     String @unique   // 必须带交易所前缀：sh000001 / sz399001 / bj899050
  name     String
  exchange String
  category String @default("综合指数")   // 综合指数 / 规模指数 / 板块指数
  source   String @default("sina")
  barCount Int    @default(0)
  windowStart DateTime?
  windowEnd   DateTime?
  klines IndexKline[]
  @@map("market_indices")
}

model IndexKline {
  id        String   @id @default(cuid())
  indexId   String
  tradeDate DateTime
  open/high/low/close Decimal
  volume    BigInt   @default(0)   // 单位「股」，统一口径
  index     MarketIndex @relation(...)
  @@unique([indexId, tradeDate])
  @@map("index_klines")
}
```

### 边界由代码强制，而不是靠自觉

`services/indexDataService.ts` 是**指数读写的唯一入口**，并且刻意不做「用 code 猜是股还是指数」的自动路由：

- `isIndexCode()` 要求代码**必须带 `sh`/`sz`/`bj` 前缀**。裸码一律拒绝 ——
  `getIndexKlines("000001")` 返回 `[]`，而不是"聪明地"猜成上证指数。
- `marketDataService` 里任何函数**不会**返回指数；`indexDataService` 里任何函数**不会**返回个股。
- `getMarketStats()`（个股口径）与 `getIndexStats()`（指数口径）分成两个函数，
  不合并成一个语义含混的返回值。宁可让调用方多调一次。

### 独立读取路径

| 端点 | 说明 |
|---|---|
| `GET /api/indices` | 指数清单，支持 `?category=规模指数&stats=1` |
| `GET /api/indices/:code/klines` | 指数日K，支持 `?startDate=&endDate=&limit=` |

`/api/stocks`、`/api/market` 完全不涉及指数；`/api/indices` 完全不涉及个股。

## 四、数据内容

9 个指数 / 34,558 根日K，均为**自发布日起的全量历史**。

| 指数 | 代码 | 分类 | 根数 | 起始 |
|---|---|---|---|---|
| 上证指数 | `sh000001` | 综合指数 | 5,000 | 2006-03-01 |
| 深证成指 | `sz399001` | 综合指数 | 5,000 | 2006-03-01 |
| 沪深300 | `sh000300` | 规模指数 | 5,000 | 2006-03-01 |
| 中证500 | `sh000905` | 规模指数 | 5,000 | 2006-03-01 |
| 上证50 | `sh000016` | 规模指数 | 5,000 | 2006-03-01 |
| 创业板指 | `sz399006` | 板块指数 | 3,961 | 2010-06-01 |
| 中证1000 | `sh000852` | 规模指数 | 2,902 | 2014-10-17 |
| 科创50 | `sh000688` | 板块指数 | 1,629 | 2020-01-02 |
| 北证50 | `bj899050` | 板块指数 | 1,066 | 2022-05-05 |

全部截至 2026-09-18。**每个指数在个股窗口 `2024-11-04 → 2026-09-18` 内都恰好 459 根**，
与个股完全对齐，可直接按 `tradeDate` 关联做大盘基准。

### 数据质量：双源交叉校验

以**新浪**为主源，同时拉**腾讯**源逐日比对收盘点位：

| 指数 | 共同交易日 | 收盘最大相对偏差 |
|---|---|---|
| 上证指数 / 深证成指 / 沪深300 / 中证500 / 上证50 / 中证1000 | 2,000 | 0.0001% ~ 0.0002% |
| 创业板指 | 2,000 | 0.0004% |
| 科创50 | 1,629 | 0.0007% |
| 北证50 | 1,066 | 0.0008% |

最大偏差 0.0008% = 万分之零点零八，属小数点后两位的四舍五入误差。两源独立，互证无误。

### 为什么主源选新浪

| 源 | 可取上限 | 可回溯到 |
|---|---|---|
| 腾讯 `proxy.finance.qq.com` | **2,000 根**（`n≥2500` 直接返回 `{"code":0,"msg":"param error","data":[]}`） | 2018-06-27 |
| 新浪 `money.finance.sina.com.cn` | 5,000 根 | **2006-03-01** |

## 五、更新数据

```bash
# 1) 抓取（在服务器上，必须绕过代理）
cd /home/ubuntu && NO_PROXY='*' no_proxy='*' python3 fetch_indices.py
#    → 输出 /home/ubuntu/index_data/

# 2) 导入（幂等：先删该指数的旧K线再整段插入，可重复执行）
python3 /home/ubuntu/import_indices.py

# 3) 审计
python3 /home/ubuntu/verify_isolation.py     # SQL 级隔离审计，23 项
python3 /home/ubuntu/import_indices.py --check
```

`market_indices` 用 `ON CONFLICT(code) DO UPDATE` upsert；`index_klines` 按 `indexId` 先删后插，
所以重复执行不会产生脏数据。

> 尚未接入 `market-update.timer`。指数只需要日线且可回溯，接入前建议先确认增量抓取
> 不会破坏 `windowStart`（当前是「自发布日」，增量更新后应保持）。

## 六、验证

### SQL 级审计（`verify_isolation.py`，23 项全绿）

覆盖：表结构、个股侧未被改动、板块/复权口径未污染、指数侧完整性、窗口对齐、抽样点位、`integrity_check`。

关键断言：

```
✓ stocks = 5558                        ✓ klines = 2379962
✓ 窗口 = 2024-11-04 → 2026-09-18        ✓ stocks 中无带前缀代码
✓ 板块计数之和 = 5558                   ✓ 复权口径 qfq 5430 / none 128
✓ 指数条数 = 9                          ✓ 指数 K 线 = 34558
✓ (indexId, tradeDate) 无重复           ✓ 每个指数窗口内均恰好 459 根
```

### 应用级回归测试（`npm run test:index`）

`scripts/testIndexIsolation.ts` 从**两个方向**断言不可见性：

1. 个股侧：`getMarketStats` 的 stockCount/klineCount/窗口/板块/复权口径全部不变；
   `listCodesHavingKlines`、`listStockCodes`、`listRandomCodesHavingKlines(60)`、
   `getStockList`、`searchStocks('上证指数')` 均不得返回指数（用 `^\d{6}$` 正则卡死）。
2. 指数侧：9 个指数可查、`sh000001` 有 5000 根、首根 2006-03-01、升序、
   `getIndexKlines('000001')` 必须返回空（裸码不被当指数）。
3. 000001 双身份：`getStockInfoByCode('000001')` → 平安银行；
   `getStockInfoByCode('sh000001')` → null（指数不在个股表）。

已加入 `npm run test:all` 末尾。**注意这会改变 test:all 的断言总数**，
`HANDOFF.md` 里「694 项断言」的描述需要相应更新。

## 七、踩过的坑

1. **`tradeDate` 在 SQLite 里是整数毫秒时间戳**，不是文本。手工写 SQL 时
   `MIN(tradeDate)` 会返回 13 位数字，需 `datetime(v/1000,'unixepoch')` 换算。
2. **手写 DDL 必须与 Prisma 的生成结果严格一致**，否则将来 `db push` 会产生意外 diff。
   校验方法：
   ```bash
   prisma migrate diff --from-url "file:/path/dev.db" \
     --to-schema-datamodel schema.prisma --script
   # 输出 "-- This is an empty migration." 即完全一致
   ```
   本项目的表是用手写 `CREATE TABLE IF NOT EXISTS` 建的，已用上述命令验证为零差异。
3. 这一版 `prisma db push` **没有 `--dry-run`**（会直接打印 usage），别指望用它预演。
4. **腾讯接口 `n≥2500` 返回的 `data` 是数组不是对象**，按 `data[sym]` 解析会 `TypeError`。
5. **新浪返回的 JSON key 不带引号**，需正则补引号后再 `json.loads`。
6. 抓指数必须设 `NO_PROXY='*'`，否则会走系统代理被拦。
