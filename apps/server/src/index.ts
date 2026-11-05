import { env } from './core/config';
import { createServer } from './server';

try {
  const config = env.load();
  const server = await createServer();
  const { httpUrl: url } = await server.listen();

  if (config.gateway.token) {
    console.log('Agent Gateway 使用 AGENT_GATEWAY_TOKEN');
    if (!config.isProduction) {
      console.log(`[开发模式] 控制台管理员令牌：\n${config.gateway.token}`);
    }
  } else {
    console.log(
      '[开发模式] 未配置 AGENT_GATEWAY_TOKEN，Agent Gateway 已开启免密访问。',
    );
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
