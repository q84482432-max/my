#!/usr/bin/env bash
# 服务器侧部署脚本 —— 在 standalone 产物已上传到 /home/ubuntu/app 之后执行
# 用法（在服务器上以 ubuntu 用户）：bash /home/ubuntu/app/deploy.sh
set -euo pipefail

APP_DIR=/home/ubuntu/app
NODE_BIN=/opt/node/bin
cd "$APP_DIR"

export PATH="$NODE_BIN:$PATH"

echo "=== [1/6] 校验产物结构 ==="
test -f server.js || { echo "FATAL: server.js 不存在，standalone 产物未正确上传"; exit 1; }
test -d .next/static || { echo "FATAL: .next/static 不存在"; exit 1; }
test -f prisma/dev.db || { echo "FATAL: prisma/dev.db 不存在"; exit 1; }
ls -la | head -20

echo "=== [2/6] 生成 Prisma Client（standalone 内含 prisma CLI）==="
# standalone 产物里已包含 node_modules/prisma 与 @prisma/client
node node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma

echo "=== [3/6] 同步数据库结构（新增 SimTradeSession 表 / Account.simTradeSessionId）==="
node node_modules/prisma/build/index.js db push --skip-generate --schema=prisma/schema.prisma

echo "=== [4/6] 写入 .env ==="
cat > "$APP_DIR/.env" <<'ENVEOF'
DATABASE_URL="file:./dev.db"
NODE_ENV=production
PORT=8080
HOSTNAME=0.0.0.0
ENVEOF
cat "$APP_DIR/.env"

echo "=== [5/6] 安装 systemd 服务 ==="
sudo cp "$APP_DIR/ashare.service" /etc/systemd/system/ashare.service
sudo systemctl daemon-reload
sudo systemctl enable ashare.service
sudo systemctl restart ashare.service
sleep 6
sudo systemctl status ashare.service --no-pager | head -20

echo "=== [6/6] 健康检查 ==="
for i in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://127.0.0.1:8080/ || echo 000)
  echo "  尝试 $i: HTTP $code"
  if [ "$code" = "200" ]; then echo "  ✓ 服务已就绪"; break; fi
  sleep 3
done

echo "--- 首页标题 ---"
curl -s --noproxy '*' http://127.0.0.1:8080/ | grep -o '<title>[^<]*</title>' || true
echo "--- /simtrade 页面 ---"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' --noproxy '*' http://127.0.0.1:8080/simtrade
echo "--- /api/simtrade 接口 ---"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' --noproxy '*' http://127.0.0.1:8080/api/simtrade

echo "=== 部署完成 ==="
