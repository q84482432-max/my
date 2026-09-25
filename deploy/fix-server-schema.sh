#!/usr/bin/env bash
# 服务器端：同步 prisma/schema.prisma 并重新生成 Prisma Client。
#
# 背景：deploy-inplace.sh 只同步 .next 与 server.js，**不同步 prisma/schema.prisma**。
# 线上 schema 停在 09-12 版本（缺 MarketIndex / IndexKline），导致重新 generate 出来的
# client 没有 prisma.marketIndex，指数页与 /api/indices 报
#   TypeError: Cannot read properties of undefined (reading 'findMany')
#
# 本脚本只做两件事：备份旧 schema → 用新 schema 重新 generate → 重启服务验证。
# **不碰生产库数据**（不执行 db push / migrate），前后打印 dev.db 的 md5 作证。
set -uo pipefail

APP=/home/ubuntu/app
PRISMA=/home/ubuntu/prisma-tool/node_modules/.bin/prisma
cd "$APP" || { echo "FATAL: $APP 不存在"; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"

echo "=== [1/5] 备份旧 schema ==="
cp -a prisma/schema.prisma "prisma/schema.prisma.bak-$TS"
echo "  -> prisma/schema.prisma.bak-$TS"

echo "=== [2/5] 校验新 schema 含索引模型 ==="
echo "  model MarketIndex: $(grep -c 'model MarketIndex' prisma/schema.prisma)"
echo "  model IndexKline : $(grep -c 'model IndexKline' prisma/schema.prisma)"
echo "  schema md5: $(md5sum prisma/schema.prisma | cut -d' ' -f1)"

echo "=== [3/5] 重新生成 Prisma Client ==="
"$PRISMA" generate --schema=prisma/schema.prisma 2>&1 | tail -6
echo "--- 生成结果自检（应 > 0）---"
echo "  client 内 marketIndex 出现次数: $(grep -c 'marketIndex' node_modules/.prisma/client/index.d.ts 2>/dev/null)"
echo "  linux 引擎: $(ls node_modules/.prisma/client/ | grep -c debian-openssl)"

echo "=== [4/5] 重启服务 ==="
sudo systemctl restart ashare.service
sleep 8
echo "  服务状态: $(systemctl is-active ashare.service)"

echo "=== [5/5] 健康检查 ==="
for p in / /indices "/indices?code=sz399001" /api/indices /api/simtrade /api/market /stocks /simtrade /backtest; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:8080$p" || echo 000)"
  printf '  %s  %s\n' "$code" "$p"
done

echo "--- /api/indices 返回内容 ---"
curl -s --noproxy '*' "http://127.0.0.1:8080/api/indices" | head -c 400
echo
echo "--- 生产库指纹（应与部署前一致，本脚本不写库）---"
md5sum prisma/dev.db
