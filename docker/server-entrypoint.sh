#!/bin/sh
set -e

echo "[Server Entrypoint] 检查数据库连接并应用已提交的迁移..."

if [ -z "$DATABASE_URL" ]; then
  echo "[Server Entrypoint] 必须配置 DATABASE_URL。" >&2
  exit 1
fi
echo "[Server Entrypoint] 正在运行 Prisma migrate deploy..."
pnpm db:deploy || {
  echo "[Server Entrypoint] 迁移应用失败，正在重试一次（等待数据库完全启动）..."
  sleep 3
  pnpm db:deploy
}
echo "[Server Entrypoint] 数据库迁移应用成功完成！"

echo "[Server Entrypoint] 启动 Voxel Server..."
exec "$@"
