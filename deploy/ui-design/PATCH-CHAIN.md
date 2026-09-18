# UI 补丁链说明（a-share-sim-trading）

> 源码已丢失（唯一副本在家里机器，待 git 化），线上只能零构建覆盖。
> 本文记录 2026-09-18 上线的全部补丁的**链条、当前状态与回滚方式**。

## 访问链路（为什么需要这些补丁）

8080 被腾讯云安全组挡死，公网唯一入口是工作台 `http://111.229.225.7/app`（80 端口反代）。
应用内部全用根路径（`/_next/*`、`/api/*`、`/stocks`…），所以：

1. **workbench_server.py 反代**（已改，备份 `~/workbench/workbench_server.py.bak.*`）：
   - `/_next/*` → 8080（原路径）
   - 未被工作台认领的 `/api/*` → 8080（原路径，全动词）
   - `/stocks /account /sim /backtest /simtrade /favicon.ico` → 8080（兜底）
   - `/app/*` → 8080（剥前缀，原有）
2. **静态资源覆盖补丁**（下表）+ **注入脚本**（nav-active.js v2：当前页标记 + /app 链接适配）。

## 指纹链（当前生效：c8e2f4a61d903b75 / layout-b16f4e28d0a7c593）

| 批次 | 脚本（本地与服务器 ui-design/ 各一份） | 内容 | 指纹变化 |
|---|---|---|---|
| v1 | apply-ui-patch.sh | 主题覆盖（DESIGN.md 全套令牌）+ nav-active v1 | css 1f03992f…→7d3a91c0…；js 8ab5865b…→b16f4e28… |
| v2a | apply-nav-v2.sh | nav-active 升 v2（/app 归一化 + `/` 链接改写） | js 文件名不变 |
| v2b | apply-css-v2.sh | 顶栏 `header a` nowrap 防断行 | css 7d3a91c0…→a4c7f2e9… |
| v3 | apply-css-v3.sh | <1024px 隐藏顶栏右侧数据标签 | css a4c7f2e9…→**c8e2f4a6…（当前）** |

全量备份：`~/app/.next.pre-ui-<时间戳>`（v1 时创建，含当时整个 .next）。

## 回滚

- **只回 CSS**：`cp ~/workbuddy-export/ui-design/css-backup-<旧指纹>.css ~/app/.next/static/css/<想要的指纹>.css`
  （各批次前的完整副本都在 ui-design/ 下），再 `sed` 引用或整链回退。
- **只回 JS**：`layout-backup-8ab5865bd888c90e.js` 是原始未注入版本；
  `layout-backup-v1-<时间戳>.js` 是 v1 注入版。
- **整体回滚**：`systemctl stop ashare && rm -rf ~/app/.next && mv ~/app/.next.pre-ui-<时间戳> ~/app/.next && systemctl start ashare`
  （这会同时丢掉反代之外的所有覆盖，需按上表重放）。

## 逻辑补丁（2026-09-18）：最大回撤起始日

**文件**：`~/app/.next/server/chunks/75.js`（standalone 副本已同步修改）
**备份**：`~/backup/drawdown-fix-20260918-212145/`
**脚本**（服务器 `ui-design/` 与本地各一份）：
`patch-drawdown.py`（默认干跑，`--apply` 生效）、`verify-drawdown.py`（交叉验证）、
`test-drawdown-logic.js`（离线单测，node 直接跑，13 项断言）

**病根**：`/api/backtest/[id]` 的序列化逻辑把 `maxDrawdownStart` 赋成**全区间最高点日期**，
而不是**回撤前的运行峰值日期**，会出现「起始日晚于结束日」：

| 回测记录 | 修复前（错） | 修复后（对） |
|---|---|---|
| 验证：平安银行 2026-03-02~09-17 | 2026-07-31 → 2026-06-25 | **2026-06-12 → 2026-06-25** |
| 平安银行 2025-01-02~06-30 | 2025-06-26 → 2025-03-21 | **2025-02-18 → 2025-03-21** |
| 贵州茅台（资金不足） | 无回撤，不受影响 | 无回撤 |
| 平安银行全区间 | 2025-07-10 → 2026-06-25（本来就对） | 不变 |

**修法**：与同文件模块 72406 的 `OL` 函数（引擎在建回测时用的那份，本来就正确）保持同一语义：
遍历资产曲线维护运行峰值及其日期，遇到更深的回撤时取「当前运行峰值日」为起始日。
新逻辑带 `k.length>0` 守卫，空曲线/单点曲线不抛异常。

**范围说明**：chunk 75 是服务端文件、**无内容指纹**，改动重启即生效，无需换指纹。
错的重算只发生在详情接口；引擎在建回测时用的是本来就正确的 `OL` 实现，
所以库里的 `maxDrawdown` 数值一直是对的，错的只有详情页展示的起止日期。
列表接口不返回这两个字段。

**回滚**：

```bash
cp ~/backup/drawdown-fix-20260918-212145/home_ubuntu_app_.next_server_chunks_75.js \
   ~/app/.next/server/chunks/75.js
sudo systemctl restart ashare
```

**验证结论**（2026-09-18）：`verify-drawdown.py` 4/4 与独立计算一致；
浏览器实测详情面板显示「最大回撤 -6.92% · 2026-06-12 → 2026-06-25」，
资金曲线、回撤曲线、K 线买卖点、交易明细全部正常。

## 注意

- CSS/JS 带 `immutable` 一年缓存：**每次改内容必须换指纹**，否则老访客永远看不到更新。
- 未来源码找回归位后重新构建，这批覆盖全部作废，需按 DESIGN.md 重新实现（v2/v3 的两条窄屏规则记得带上）。
