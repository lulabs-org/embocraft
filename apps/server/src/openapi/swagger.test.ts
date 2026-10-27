import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { swaggerSpec } from './swagger';

type Schema = {
  $ref?: string;
  enum?: string[];
  properties: Record<string, Schema>;
  not: { anyOf: unknown[] };
};
type Operation = {
  tags?: string[];
  security?: Record<string, string[]>[];
  description?: string;
  parameters: { name: string; schema: Schema }[];
  responses?: Record<string, unknown>;
  requestBody: { content: Record<string, { schema: Schema }> };
};
const spec = swaggerSpec as {
  paths: Record<string, Record<string, Operation>>;
  servers?: unknown[];
  security?: unknown;
  components: {
    securitySchemes: Record<string, { scheme: string }>;
    schemas: Record<string, Schema>;
  };
};
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method),
    )
    .map(([method, operation]) => ({
      path,
      method,
      operation,
    })),
);

it('documents every statically registered HTTP route', () => {
  const serverSrc = join(dirname(fileURLToPath(import.meta.url)), '..');
  const routeFiles: string[] = [];
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name === 'routes.ts' || entry.name.endsWith('.routes.ts'))
        routeFiles.push(path);
    }
  }
  collect(join(serverSrc, 'http'));
  collect(join(serverSrc, 'modules'));

  let routeCount = 0;
  for (const file of routeFiles) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'app' &&
        ['get', 'post', 'put', 'patch', 'delete'].includes(
          node.expression.name.text,
        )
      ) {
        const method = node.expression.name.text;
        const first = node.arguments[0];
        const paths = ts.isArrayLiteralExpression(first)
          ? first.elements
          : [first];
        for (const pathNode of paths) {
          expect(ts.isStringLiteral(pathNode), file).toBe(true);
          if (!ts.isStringLiteral(pathNode)) continue;
          routeCount++;
          const path = pathNode.text.replace(/:([\w]+)/g, '{$1}');
          expect(
            spec.paths[path]?.[method],
            `${method} ${path} (${file})`,
          ).toBeDefined();
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(routeCount).toBeGreaterThan(0);
  expect(operations).toHaveLength(routeCount);
});

it('includes agent and task endpoints from domain routes.ts files', () => {
  for (const [path, methods] of [
    ['/ai-characters', ['get', 'post']],
    ['/ai-characters/{id}', ['put', 'delete']],
    ['/tasks', ['get', 'post']],
    ['/tasks/{planId}', ['get', 'put', 'delete']],
    ['/task-runs/{runId}/{operation}', ['post']],
  ] as const) {
    expect(spec.paths[path], path).toBeDefined();
    for (const method of methods)
      expect(spec.paths[path][method], `${method} ${path}`).toBeDefined();
  }
});

it('documents the spatial text, command receipt, and OpenAPI JSON endpoints', () => {
  const spatial = spec.paths['/chat/spatial/{id}/text']?.post;
  expect(spatial).toBeDefined();
  expect(
    spatial.requestBody.content['application/json'].schema.properties.text,
  ).toMatchObject({ type: 'string', maxLength: 240 });
  expect(spatial.responses?.['200']).toBeDefined();

  const receipt = spec.paths['/management/commands/{id}']?.get;
  expect(receipt).toBeDefined();
  expect(receipt.responses?.['200']).toBeDefined();

  const document = spec.paths['/api-docs.json']?.get;
  expect(document).toBeDefined();
  expect(document.tags).toEqual(['System']);
  expect(document.security).toBeUndefined();
});

it('documents resource ownership, management and chat credentials, with no global auth on public APIs', () => {
  expect(spec.servers).toEqual([{ url: '/', description: '当前服务器' }]);
  expect(spec.security).toBeUndefined();
  const management = [
    ['/management', 'Management'],
    ['/ai-characters', 'AI Characters'],
    ['/providers', 'Providers'],
    ['/tasks', 'Tasks'],
    ['/task-runs', 'Tasks'],
    ['/voice/tts/services', 'TTS'],
    ['/voice/tts/piper', 'TTS'],
    ['/voice/asr/services', 'ASR'],
  ];
  for (const { path, operation } of operations) {
    const domain = management.find(
      ([prefix]) => path === prefix || path.startsWith(prefix + '/'),
    );
    if (domain) {
      expect(operation.tags, path).toEqual([domain[1]]);
      expect(operation.security, path).toEqual([{ ManagementBearer: [] }]);
    } else if (path.startsWith('/chat/')) {
      expect(operation.security, path).toEqual([{ ChatBearer: [] }]);
    } else expect(operation.security, path).toBeUndefined();
    expect(path).not.toMatch(
      /^\/ai-characters\/(providers|tasks|task-runs|voice-services)(\/|$)/,
    );
  }
  expect(spec.components.securitySchemes.ManagementBearer.scheme).toBe(
    'bearer',
  );
  expect(spec.components.securitySchemes.ChatBearer.scheme).toBe('bearer');
});

it('provides path parameters, request bodies and successful responses, and resolves every local reference', () => {
  for (const { path, method, operation } of operations) {
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      expect(operation.parameters, `${method} ${path}`).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: match[1],
            in: 'path',
            required: true,
            schema: expect.any(Object),
          }),
        ]),
      );
    }
    expect(
      Object.keys(operation.responses ?? {}).some((status) =>
        /^2\d\d$/.test(status),
      ),
      `${method} ${path}`,
    ).toBe(true);
    if (
      ['post', 'put'].includes(method) &&
      (path.startsWith('/tasks') || path.startsWith('/task-runs'))
    )
      expect(
        operation.requestBody?.content['application/json'].schema,
      ).toBeDefined();
  }
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if ('$ref' in value && typeof value.$ref === 'string') {
      expect(value.$ref.startsWith('#/')).toBe(true);
      const target = value.$ref
        .slice(2)
        .split('/')
        .reduce<unknown>(
          (node, key) =>
            node && typeof node === 'object'
              ? (node as Record<string, unknown>)[key]
              : undefined,
          spec,
        );
      expect(target, value.$ref).toBeDefined();
    }
    for (const item of Object.values(value)) visit(item);
  }
  visit(spec);
  expect(
    spec.paths['/tasks/{planId}/{operation}'].post.parameters.find(
      (p) => p.name === 'operation',
    )!.schema.enum,
  ).toEqual(['run', 'pause', 'resume', 'archive', 'extend']);
  expect(
    spec.paths['/task-runs/{runId}/{operation}'].post.parameters.find(
      (p) => p.name === 'operation',
    )!.schema.enum,
  ).toEqual(['pause', 'resume', 'cancel']);
});

it('exposes task controls only through plans and explicit run IDs', () => {
  for (const operation of ['task', 'pause', 'resume', 'cancel'])
    expect(spec.paths[`/ai-characters/{id}/${operation}`]).toBeUndefined();
  expect(spec.paths['/tasks'].post.description).toContain('无需再次调用 run');
  expect(spec.paths['/tasks/{planId}/{operation}'].post.description).toContain(
    '不影响当前执行',
  );
  expect(
    spec.paths['/task-runs/{runId}/{operation}'].post.description,
  ).toContain('不自动上线');
});

it('documents profile-only Agent writes and default standby with optional offline creation', () => {
  expect(
    spec.paths['/ai-characters'].post.requestBody.content['application/json']
      .schema.$ref,
  ).toBe('#/components/schemas/AICharacterCreate');
  expect(
    spec.paths['/ai-characters/{id}'].put.requestBody.content[
      'application/json'
    ].schema.$ref,
  ).toBe('#/components/schemas/AICharacterProfileUpdate');
  expect(
    spec.components.schemas.AICharacterCreate.properties.joinWorld,
  ).toEqual({
    type: 'boolean',
    default: true,
  });
  for (const name of ['AICharacterCreate', 'AICharacterProfileUpdate']) {
    const schema = spec.components.schemas[name];
    expect(schema.properties.goal).toBeUndefined();
    expect(schema.properties.startTask).toBeUndefined();
    expect(schema.properties.taskTimeZone).toBeUndefined();
    expect(schema.not.anyOf).toEqual(
      expect.arrayContaining([
        { required: ['startTask'] },
        { required: ['taskTimeZone'] },
      ]),
    );
  }
});
