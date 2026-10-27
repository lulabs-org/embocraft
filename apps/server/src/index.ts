import { readFile } from 'node:fs/promises';
import { env } from './core/config';
import { createServer } from './server';

try {
  const config = env.load();
  const server = await createServer({ config });
  const url = (await server.listen()).replace(/^ws:/, 'http:');
  console.log(
    config.gateway.token
      ? 'Agent Gateway 使用 AGENT_GATEWAY_TOKEN。'
      : `Agent Gateway 令牌文件 ${config.gateway.tokenFile}`,
  );
  // 仅在本地开发模式打印令牌值，方便直接粘贴到网页控制台解锁；生产环境维持只打印来源。
  if (!config.isProduction) {
    try {
      const token =
        config.gateway.token?.trim() ||
        (await readFile(config.gateway.tokenFile, 'utf8')).trim();
      if (token) {
        console.log(
          '[开发模式] 控制台管理员令牌（粘贴到网页「控制台」解锁框）：\n' +
            `${token}\n` +
            '获取方式亦可用：pnpm agent:ctl auth show',
        );
      }
    } catch {
      /* 令牌文件读取失败不影响服务启动，跳过打印。 */
    }
  }
  console.log(`Voxel server ${url}`);
  console.log(`Swagger UI   ${url}/api-docs`);
  console.log(`OpenAPI JSON ${url}/api-docs.json`);
  const stop = () => {
    void server
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
