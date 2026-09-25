#!/usr/bin/env bash
# 服务器端：原地更新 Next.js standalone 产物。
#
# 用法（在服务器上）：bash /home/ubuntu/deploy-inplace.sh [包路径] [--with-modules] [--with-schema]
#   默认包路径 /home/ubuntu/ashare-standalone.tar.gz
#   --with-modules：同时同步 node_modules（仅当依赖变更时需要，默认不同步）
#   --with-schema ：若线上 prisma/schema.prisma 与本次构建所用 schema 不一致，则自动同步
#                   （默认只检查并告警 —— 生产 schema 不自动覆盖）
#
# 设计原则 —— 只换代码，绝不碰数据：
#   * prisma/dev.db（线上 770MB 生产库）原地不动
#   * .env（DATABASE_URL 等）原地不动
#   * 只替换 .next/ 与 server.js，替换前自动备份
#   * 若发现包里含 prisma/dev.db 或 .env，直接拒绝执行（防误覆盖）
#
# ⚠️ 两条踩过的坑，本脚本已内置规避（2026-09-19 实测故障）：
#   1. **必须在服务器上重新 prisma generate。** 本机（Windows）构建的 Prisma Client
#      只含 windows 引擎，直接同步到 Linux 会报
#      "Prisma Client could not locate the Query Engine for runtime debian-openssl-3.0.x"，
#      所有走数据库的接口返回 500。
#   2. **node_modules 默认不同步、且永不用 rsync --delete。** standalone 的 node_modules
#      是精简集（仅 19 个包），带 --delete 会把线上独有的 prisma CLI 一并删掉；
#      同时会再次引入平台相关的 prisma client。
#   3. **Next 16 + Windows 构建会出现 Turbopack 哈希别名丢链**（本脚本 [4b/7] 已内置修复）：
#      Turbopack 把 serverExternalPackages 建成 `.next/node_modules/@prisma/client-<hash>` 软链，
#      Windows 上 standalone 只留下空目录 → 线上 require 该别名报 MODULE_NOT_FOUND → 走库的
#      页面/接口全 500（`/` 500 而 `/simtrade` 200 就是它的典型特征）。
#
# 回滚：把 .next.pre-deploy-<时间戳> 换回 .next，server.js 同理，然后重启服务。
set -euo pipefail

APP=/home/ubuntu/app
PKG=/home/ubuntu/ashare-standalone.tar.gz
WITH_MODULES=""
WITH_SCHEMA=""
PRISMA_BIN=/home/ubuntu/prisma-tool/node_modules/.bin/prisma
TS="$(date +%Y%m%d-%H%M%S)"

# 参数解析（顺序无关）：[包路径] [--with-modules] [--with-schema]
for _a in "$@"; do
  case "$_a" in
    --with-modules) WITH_MODULES="--with-modules" ;;
    --with-schema)  WITH_SCHEMA="--with-schema" ;;
    *.tar.gz)       PKG="$_a" ;;
    *) echo "FATAL: 未知参数 $_a"; exit 2 ;;
  esac
done

export PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin

echo "=== [1/7] 校验输入包 ==="
test -f "$PKG" || { echo "FATAL: 包不存在: $PKG"; exit 1; }
if tar tzf "$PKG" | grep -qE '(^\./)?(prisma/dev\.db|\.env$|prisma/dev\.db-)'; then
  echo "FATAL: 包内含 prisma/dev.db 或 .env —— 会覆盖生产数据/配置，拒绝执行"
  tar tzf "$PKG" | grep -E '(^\./)?(prisma/dev\.db|\.env$|prisma/dev\.db-)'
  exit 1
fi
echo "OK: 包内无生产库/配置（文件数 $(tar tzf "$PKG" | wc -l)）"

echo "=== [2/7] 记录部署前生产库指纹 ==="
cd "$APP"
DB_SIZE_BEFORE="$(stat -c%s prisma/dev.db)"
DB_MTIME_BEFORE="$(stat -c%y prisma/dev.db)"
DB_MD5_BEFORE="$(md5sum prisma/dev.db | cut -d' ' -f1)"
echo "dev.db size=$DB_SIZE_BEFORE  mtime=$DB_MTIME_BEFORE  md5=$DB_MD5_BEFORE"

echo "=== [3/7] 备份现有产物 ==="
cp -a .next ".next.pre-deploy-$TS"
cp -a server.js "server.js.pre-deploy-$TS"
echo "OK: .next.pre-deploy-$TS / server.js.pre-deploy-$TS"

echo "=== [4/7] 解包并同步产物 ==="
TMP="$(mktemp -d)"
tar xzf "$PKG" -C "$TMP"
test -f "$TMP/server.js" || { echo "FATAL: 包内缺 server.js"; rm -rf "$TMP"; exit 1; }

rsync -a --delete "$TMP/.next/" .next/
cp -f "$TMP/server.js" server.js
echo "OK: .next 与 server.js 已更新"

if [ "$WITH_MODULES" = "--with-modules" ]; then
  echo "--- 同步 node_modules（不带 --delete，保留线上独有包）---"
  if [ -d "$TMP/node_modules" ]; then
    rsync -a "$TMP/node_modules/" node_modules/
    echo "OK: node_modules 已合并"
  fi
else
  echo "SKIP: node_modules 未同步（依赖无变更时的正确行为）"
fi

echo "=== [4b/7] 修复 Turbopack 哈希别名（Next 16 / Windows 构建特有）==="
# Next 16 起 Turbopack 会把 serverExternalPackages 建成哈希别名：
#   .next/node_modules/@prisma/client-<hash>  ->  软链到  node_modules/@prisma/client
# 而**在 Windows 上构建时，这个别名会以两种坏形态之一进入 tar 包**：
#   (甲) 空目录 —— Windows 没能建成软链，只留下一个空目录；
#   (乙) **悬空软链，且指向 Windows 路径**，例如
#        client-2c3a283f134fdcb6 -> /d/a-share-sim-trading/node_modules/@prisma/client
#        解到 Linux 上就是一个解析不了的链接。
# 两种形态都会让 require('@prisma/client-<hash>') 抛 MODULE_NOT_FOUND，
# 表现为**走库的页面/接口全 500**（`/` 500 而 `/simtrade` 200 是它的典型特征）。
#
# 🔴 事故复盘（2026-09-23 实测）：
#   旧实现在 `find` 上用了 `-type d`，**根本匹配不到符号链接** —— 于是形态 (乙) 被完全跳过，
#   脚本报告「修复 0 个」却放行部署，线上 `/` 与 `/api/simtrade` 全 500。
#   同一次构建若 Turbopack 恰好只留下空目录（形态甲），旧实现又能修好 ——
#   **这就是「同一个脚本，一次成功一次全站 500」的原因**。
#   现改为：目录与符号链接一并枚举；用「能否解析（-e）」判断好坏；
#   坏的重建后**再验一次**；末尾再跑一次全局悬空链接硬闸门。
ALIAS_FIXED=0
ALIAS_VERIFIED=0
if [ -d .next/node_modules ]; then
  while IFS= read -r d; do
    [ -z "$d" ] && continue

    name="$(basename "$d")"
    parent="$(basename "$(dirname "$d")")"
    if [ "$parent" = "node_modules" ]; then
      # 非作用域包：.next/node_modules/<name>
      target="$APP/node_modules/$name"
    else
      # 作用域包：.next/node_modules/<scope>/<name>-<hash> → 去掉 -<hash>
      target="$APP/node_modules/$parent/${name%-*}"
    fi

    # ---- 判断这个别名是不是坏的 ----
    if [ -L "$d" ]; then
      # 符号链接：**关键** —— 能解析就跳过；解析不了才算坏（悬空链接）
      if [ -e "$d" ]; then
        ALIAS_VERIFIED=$((ALIAS_VERIFIED + 1))
        continue
      fi
      reason="悬空符号链接"
    elif [ -d "$d" ]; then
      if [ -n "$(ls -A "$d" 2>/dev/null)" ]; then
        ALIAS_VERIFIED=$((ALIAS_VERIFIED + 1))
        continue
      fi
      reason="空目录"
    else
      continue
    fi

    if [ -d "$target" ]; then
      rm -rf "$d"
      ln -s "$target" "$d"
      if [ -e "$d" ]; then
        echo "  FIXED($reason): $d -> $target"
        ALIAS_FIXED=$((ALIAS_FIXED + 1))
      else
        echo "  FATAL: 重建后仍无法解析：$d -> $target"
        exit 1
      fi
    else
      echo "  SKIP : $d （真实包不存在：$target）"
    fi
  done < <(find .next/node_modules -mindepth 1 -maxdepth 2 \( -type d -o -type l \) 2>/dev/null)
fi
echo "OK: 修复 $ALIAS_FIXED 个哈希别名（另有 $ALIAS_VERIFIED 个已可解析）"

# 硬闸门：.next/node_modules 下不得残留任何「解析不了的」条目。
# 这一条是本次事故的直接教训 —— 修复逻辑漏判时必须**中止部署**，而不是放行到线上。
ALIAS_BROKEN="$(find .next/node_modules \( -type l -o -type d \) 2>/dev/null | while IFS= read -r p; do
  if [ ! -e "$p" ]; then echo "$p"; fi
done)"
if [ -n "$ALIAS_BROKEN" ]; then
  echo "FATAL: .next/node_modules 下仍有无法解析的条目，拒绝继续部署："
  echo "$ALIAS_BROKEN" | sed 's|^|  |'
  echo "处置：确认 \$APP/node_modules 下存在对应真实包，或删除该悬空条目后重跑。"
  exit 1
fi
echo "OK: 别名链接全部可解析（无悬空条目）"

echo "=== [4c/7] schema 一致性检查（防「代码新、schema 旧」→ 走库接口 500）==="
# 事故复盘（2026-09-22）：本脚本出于防覆盖生产库的考虑从不同步 prisma/，
# 导致 V2 的 schema 变更（stage / stageActionCompleted / stageActionAt /
# buyCountToday / sellCountToday / pool 共 6 列）长期未上服务器。部署新构建后
# 所有走库接口报 `Unknown field stage for select statement`（500），
# 且**重新 generate 也无效** —— 因为 Prisma Client 是照旧 schema 生成的。
# 正确处置顺序：① 先给物理表 ADD COLUMN ② 同步 schema ③ 再 generate。
# 包内 SCHEMA-MD5.txt / SCHEMA.prisma 由 pack-standalone.sh 写入。
EXPECT_SCHEMA_MD5="$(cat "$TMP/SCHEMA-MD5.txt" 2>/dev/null | tr -d '[:space:]' || true)"
CUR_SCHEMA_MD5="$(md5sum prisma/schema.prisma | cut -d' ' -f1)"
SCHEMA_MISMATCH=0
if [ -n "$EXPECT_SCHEMA_MD5" ] && [ "$EXPECT_SCHEMA_MD5" != "$CUR_SCHEMA_MD5" ]; then
  SCHEMA_MISMATCH=1
  echo "  ⚠️  线上 schema 与本次构建所用 schema 不一致！"
  echo "     线上: $CUR_SCHEMA_MD5"
  echo "     期望: $EXPECT_SCHEMA_MD5"
  if [ "$WITH_SCHEMA" = "--with-schema" ] && [ -f "$TMP/SCHEMA.prisma" ]; then
    cp -a prisma/schema.prisma "prisma/schema.prisma.bak-$TS"
    cp -f "$TMP/SCHEMA.prisma" prisma/schema.prisma
    echo "     已同步（旧 schema 已备份为 prisma/schema.prisma.bak-$TS）"
    SCHEMA_MISMATCH=0
  else
    echo "     未同步（默认不覆盖生产 schema）。若新代码引用了线上缺失的字段，"
    echo "     走库接口会 500。处置："
    echo "       a) 先给物理表补列：python3 /home/ubuntu/deploy/migrate-simtrade-v2.py"
    echo "       b) 再重跑本脚本并追加 --with-schema"
  fi
else
  echo "  OK: schema 一致（$CUR_SCHEMA_MD5）"
fi

echo "=== [5/7] 重新生成 Prisma Client（规避跨平台引擎不匹配）==="
if [ -x "$PRISMA_BIN" ]; then
  "$PRISMA_BIN" generate --schema=prisma/schema.prisma 2>&1 | tail -5
  ls -la node_modules/.prisma/client/ | grep -E 'debian|windows' || true
else
  echo "警告: 未找到 prisma CLI ($PRISMA_BIN)"
  echo "      首次部署请先执行："
  echo "      mkdir -p /home/ubuntu/prisma-tool && cd /home/ubuntu/prisma-tool && \\"
  echo "        npm init -y && npm i prisma@6.19.3"
  echo "      否则数据库接口会因引擎缺失返回 500"
fi

# 关键断言：线上生产库与配置必须在原位
test -f prisma/dev.db || { echo "FATAL: prisma/dev.db 丢失！"; exit 1; }
test -f .env         || { echo "FATAL: .env 丢失！"; exit 1; }
echo "OK: prisma/dev.db 与 .env 均在原位"

echo "=== [6/7] 重启服务 ==="
sudo systemctl restart ashare.service
sleep 8
systemctl is-active ashare.service

echo "=== [7/7] 健康检查 ==="
for i in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://127.0.0.1:8080/ || echo 000)
  echo "  尝试 $i: HTTP $code"
  [ "$code" = "200" ] && break
  sleep 3
done

echo "--- 各页面 ---"
for p in / /simtrade /backtest; do
  echo "  $(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:8080$p")  $p"
done

echo "--- 数据库接口（跨平台引擎回归的判定点，必须 200）---"
API_CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://127.0.0.1:8080/api/simtrade)"
echo "  /api/simtrade: $API_CODE"
if [ "$API_CODE" != "200" ]; then
  echo "  ✗ 数据库接口异常 —— 检查 prisma generate 是否成功（见 app.log）"
  tail -20 /home/ubuntu/app/app.log 2>/dev/null || true
fi

echo "--- 新版 UI 特征（比对 chunk 文案）---"
PAGE_JS="$(curl -s --noproxy '*' http://127.0.0.1:8080/simtrade | grep -o '/_next/static/chunks/app/simtrade/page-[^"]*\.js' | head -1)"
if [ -n "$PAGE_JS" ]; then
  BODY="$(curl -s --noproxy '*' "http://127.0.0.1:8080$PAGE_JS")"
  for k in 今日开盘 加仓 确认今日操作; do
    echo "  $k: $(printf '%s' "$BODY" | grep -o "$k" | wc -l)"
  done
  echo "  （0 表示仍在跑旧版构建产物）"
fi

echo "--- 部署后生产库指纹（须与部署前完全一致）---"
DB_SIZE_AFTER="$(stat -c%s prisma/dev.db)"
DB_MTIME_AFTER="$(stat -c%y prisma/dev.db)"
DB_MD5_AFTER="$(md5sum prisma/dev.db | cut -d' ' -f1)"
echo "dev.db size=$DB_SIZE_AFTER  mtime=$DB_MTIME_AFTER  md5=$DB_MD5_AFTER"
if [ "$DB_SIZE_BEFORE" = "$DB_SIZE_AFTER" ] && [ "$DB_MTIME_BEFORE" = "$DB_MTIME_AFTER" ] && [ "$DB_MD5_BEFORE" = "$DB_MD5_AFTER" ]; then
  echo "✓ 生产库未被触碰（size / mtime / md5 三项一致）"
else
  echo "✗ 警告：生产库指纹变化！请立即检查"
fi

rm -rf "$TMP"
echo "=== 部署完成（备份保留在 .next.pre-deploy-$TS）==="
if [ "${SCHEMA_MISMATCH:-0}" = "1" ]; then
  echo "⚠️  提醒：schema 未同步（见 [4c/7]）。若接口报 Unknown field ... 请按该处提示处置。"
fi
