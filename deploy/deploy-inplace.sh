#!/usr/bin/env bash
# 服务器端：原地更新 Next.js standalone 产物。
#
# 用法（在服务器上）：bash /home/ubuntu/deploy-inplace.sh [包路径] [--with-modules]
#   默认包路径 /home/ubuntu/ashare-standalone.tar.gz
#   --with-modules：同时同步 node_modules（仅当依赖变更时需要，默认不同步）
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
#
# 回滚：把 .next.pre-deploy-<时间戳> 换回 .next，server.js 同理，然后重启服务。
set -euo pipefail

APP=/home/ubuntu/app
PKG="${1:-/home/ubuntu/ashare-standalone.tar.gz}"
WITH_MODULES="${2:-}"
PRISMA_BIN=/home/ubuntu/prisma-tool/node_modules/.bin/prisma
TS="$(date +%Y%m%d-%H%M%S)"

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
