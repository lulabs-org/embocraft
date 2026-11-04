import { readFile } from 'node:fs/promises';
import { env } from './core/config';
import { createServer } from './server';

try {
  const config = env.load();
  const server = await createServer({ config });
  const { httpUrl: url } = await server.listen();
  if (config.gateway.token) {
    console.log('Agent Gateway 使用 AGENT_GATEWAY_TOKEN');
  } else if (config.gateway.tokenFile) {
    console.log(`Agent Gateway 令牌文件 ${config.gateway.tokenFile}`);
  } else {
    console.log(
      '[开发模式] 未配置 AGENT_GATEWAY_TOKEN，Agent Gateway 已开启免密访问。',
    );
  }
  // 仅在本地开发模式且启用了 Token 时打印令牌值，方便直接粘贴到网页控制台解锁
  if (
    !config.isProduction &&
    (config.gateway.token || config.gateway.tokenFile)
  ) {
    try {
      const token =
        config.gateway.token?.trim() ||
        (config.gateway.tokenFile
          ? (await readFile(config.gateway.tokenFile, 'utf8')).trim()
          : '');
      if (token) {
        console.log(
          '[开发模式] 控制台管理员令牌：\n' +
            `${token}\n` +
            '获取方式亦可用：pnpm agent:ctl auth show',
        );
      }
    } catch {
      /* 令牌文件读取失败不影响服务启动，跳过打印。 */
    }
  }
  console.log(`Server        ${url}`);
  console.log(`Swagger UI    ${url}/api-docs`);
  console.log(`OpenAPI JSON  ${url}/api-docs.json`);
  console.log(`AsyncAPI UI   ${url}/asyncapi-docs`);
  console.log(`AsyncAPI JSON ${url}/asyncapi.json`);
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
