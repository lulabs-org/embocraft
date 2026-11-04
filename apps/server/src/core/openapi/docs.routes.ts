import path from 'node:path';
import { createRequire } from 'node:module';
import express, { type Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger';
import { asyncApiSpec } from './asyncapi';

const require = createRequire(import.meta.url);
const asyncApiDistDir = path.dirname(
  require.resolve('@asyncapi/react-component/package.json'),
);

function renderAsyncApiHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EmboCraft WebSocket API (AsyncAPI)</title>
  <link rel="stylesheet" href="/asyncapi-assets/css/default.min.css" />
  <style>
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="asyncapi"></div>
  <script src="/asyncapi-assets/js/index.js"></script>
  <script>
    fetch('/asyncapi.json')
      .then((res) => res.json())
      .then((schema) => {
        if (window.AsyncApiStandalone) {
          window.AsyncApiStandalone.render(
            { schema, config: { show: { sidebar: true } } },
            document.getElementById('asyncapi'),
          );
        }
      });
  </script>
</body>
</html>`;
}

export function installDocsRoutes(router: Router) {
  router.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  router.use(
    '/asyncapi-assets/css',
    express.static(path.join(asyncApiDistDir, 'styles')),
  );
  router.use(
    '/asyncapi-assets/js',
    express.static(path.join(asyncApiDistDir, 'browser', 'standalone')),
  );

  const docsRouter = express.Router();

  docsRouter.get('/api-docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpec);
  });

  docsRouter.get('/asyncapi-docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderAsyncApiHtml());
  });

  docsRouter.get('/asyncapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(asyncApiSpec);
  });

  router.use(docsRouter);
}
