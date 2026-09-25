# workbench 反代路由（`/app` → Next.js）—— 文档化与版本化

> 来源：`deploy/ui-design/workbench_server.py.bak-20260917`（服务器 `~/workbench/workbench_server.py` 的实测副本）
> 生成时间：2026-09-22
> 对应 `SOURCE-SYNC-TODO.md` 第三节第 5 项

---

## 1. 为什么需要它

| 事实 | 说明 |
|---|---|
| 应用监听 | Next.js standalone 在服务器 `127.0.0.1:8080` |
| 公网 8080 | ❌ 腾讯云安全组**未放行** |
| 公网 80 | ✅ workbench 服务在 `:80`（默认 `:8901`，服务器上跑 80） |

⇒ 想从公网访问应用，**只能**经 workbench 反代。这就是「`/app` 前缀不能省」的物理原因。

---

## 2. 路由表（`workbench_server.py` 实测）

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/` | workbench 自己的面板页 |
| GET | `/img/*`、`/static/*` | workbench 静态资源（`application/javascript` / `application/octet-stream`） |
| GET | `/api/pool`、`/api/daily`、`/api/index`、`/api/mindmaps`、`/api/ver`、`/api/kline_stocks`、`/api/kline`、`/api/kline_meta`、`/api/yaowang` | workbench 自己的 JSON 接口 |
| **GET** | **`/app`、`/app/*`** | **→ 反代到 `127.0.0.1:8080`** |
| **POST / PUT / PATCH / DELETE / HEAD** | **`/app`、`/app/*`** | **→ 同上（全部动词转发）** |
| 其它 | 任意 | `404` |

`do_POST` / `do_PUT` / `do_PATCH` / `do_DELETE` / `do_HEAD` **只**对 `/app/*` 前缀转发，其余一律 404
—— 即 workbench 自身不接受写操作，写操作只可能落到应用上。

---

## 3. 反代实现（关键：**前缀剥离**）

```python
rest = u.path[4:] or "/"           # 去掉 "/app" 四个字符
if not rest.startswith("/"): rest = "/" + rest
backend_path = rest + (("?" + u.query) if u.query else "")
conn = http.client.HTTPConnection("127.0.0.1", 8080, timeout=60)
conn.request(self.command, backend_path, body=body, headers=headers)
```

映射示例：

| 公网请求 | 转发到 Next.js |
|---|---|
| `/app` | `/` |
| `/app/stocks` | `/stocks` |
| `/app/stocks/000001` | `/stocks/000001` |
| `/app/_next/static/chunks/xx.js` | `/_next/static/chunks/xx.js` |
| `/app/api/simtrade` | `/api/simtrade` |

### 由此推出的两条重要结论

1. **Next.js 不需要配 `basePath`。** 后端看到的是**已剥离**的路径，
   应用内所有 `Link href="/stocks"` 都是正确的相对根路径。
   ⇒ 源码里**不要**为了「反代前缀」去改路由；`SiteNav.tsx` 注释里
   「不需要 nav-active.js 那套 `/app` 前缀归一化」正是这个原因。
2. **但浏览器地址栏里必须带 `/app`。** 前端产出的绝对 URL（如 `fetch("/api/...")`）
   会打到 `http://host/api/...` 而**不是** `/app/api/...`，workbench 会 404。
   ⇒ 应用内一律用**相对路径**（`/api/xxx` 或 `fetch("api/xxx")`），
     由浏览器基于当前 `/app/...` 目录自然解析；**不要**在代码里硬编码 `/app/`。

### 跳过的请求/响应头（hop-by-hop）

- 请求侧：`host`、`connection`、`accept-encoding`、`content-length`
- 响应侧：`connection`、`transfer-encoding`、`content-encoding`、`content-length`
  （`content-length` 由反代按实际读到的 body 重算）

⚠️ 因为剥掉了 `accept-encoding`，上游**不会**压缩；反代也不做 gzip。
因此线上首屏传输量比直连大 —— 这是已知代价，不是 bug。

---

## 4. 运维含义

| 事项 | 结论 |
|---|---|
| workbench 升级/重装 | ⚠️ **本补丁会失效**（`workbench_server.py` 不在任何包管理里）。升级后必须重新打回 `/app/*` 分支 |
| 回滚/重打 | 用本目录 `workbench_server.py.bak-20260917` 作对照，或直接整文件替换 |
| 验证 | `curl -s -o /dev/null -w "%{http_code}" http://111.229.225.7/app` 应返回 200；`/app/_next/*` 与 `/app/api/*` 亦应 200 |
| 端口 | 服务器实际监听 80（脚本默认 8901，启动时用 `sys.argv[1]` 覆盖） |

---

## 5. 与源码的关系

**反代不是应用代码的一部分**，它是部署层设施。因此：

- 源码里**不应**出现任何 `/app` 前缀（已核对：`app/`、`components/`、`lib/`、`services/` 无 `/app` 硬编码）
- 重新构建部署**不会**影响反代（`workbench_server.py` 独立于 `.next`）
- 但反代**会**影响「构建产物能否被访问」—— 换 `.next` 指纹后仍需经 `/app` 访问，
  所以每次部署后都要按 §4 验证 `/app/_next/*` 能取到新指纹的文件

---

## 6. 变更记录

| 日期 | 事件 |
|---|---|
| 2026-09-17 | `/app/*` 反代分支加入，备份 `workbench_server.py.bak-20260917` |
| 2026-09-22 | 本文档建立（`SOURCE-SYNC-TODO` 第三节第 5 项收口）：路由表、前缀剥离语义、hop-by-hop 头、运维含义 |
