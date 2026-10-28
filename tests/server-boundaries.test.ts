import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../apps/server/src/', import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(resolve(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
        ? [resolve(dir, e.name)]
        : [],
  );
const graph = new Map(
  sources(root).map((file) => [
    file,
    ts
      .preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles.map((i) => i.fileName)
      .filter((i) => i.startsWith('.'))
      .map((spec) => {
        const base = resolve(dirname(file), spec);
        return (
          [base, base + '.ts', base + '/index.ts'].find(
            (p) => existsSync(p) && statSync(p).isFile(),
          ) ?? base
        );
      })
      .filter((file) => file.startsWith(root) && file.endsWith('.ts')),
  ]),
);
const isRoute = (name: string) =>
  /(^|\/)routes\//.test(name) || /(^|\/)(?:[^/]+\.)?routes\.ts$/.test(name);

const sourceFile = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);

const importedFile = (file: string, spec: string) => {
  const base = resolve(dirname(file), spec);
  return [base, base + '.ts', base + '/index.ts'].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
};

it('centralizes database client and pool construction in core/database/client.ts', () => {
  for (const file of graph.keys()) {
    const name = relative(root, file);
    if (name === 'core/database/client.ts') continue;
    for (const statement of sourceFile(file).statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const spec = statement.moduleSpecifier.text;
      if (spec === '@prisma/client')
        expect(statement.importClause?.isTypeOnly, name).toBe(true);
      expect(['@prisma/adapter-pg', 'pg'].includes(spec), name).toBe(false);
    }
  }
});
it('keeps joint persistence independent of management, runtime and HTTP implementations', () => {
  for (const [file, deps] of graph) {
    const name = relative(root, file);
    for (const dep of deps) {
      const target = relative(root, dep);
      if (name.startsWith('persistence/')) {
        expect(
          target.startsWith('persistence/') ||
            target.startsWith('core/errors/') ||
            target.startsWith('core/database/'),
          `${name} -> ${target}`,
        ).toBe(true);
      }
      if (
        name.startsWith('modules/management/') ||
        name.startsWith('modules/tasks/')
      )
        expect(target.startsWith('persistence/'), `${name} -> ${target}`).toBe(
          false,
        );
    }
  }
});

/** Follow only the symbols imported from a module facade, not every re-export. */
function usedDependencies(
  file: string,
  readSource = sourceFile,
  resolveImport = importedFile,
): string[] {
  const dependencies: string[] = [];
  for (const statement of readSource(file).statements) {
    // Re-export-only barrels are also dependencies, including export type and export *.
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveImport(file, statement.moduleSpecifier.text);
      if (target?.startsWith(root)) dependencies.push(target);
      continue;
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const target = resolveImport(file, statement.moduleSpecifier.text);
    if (!target || !target.startsWith(root)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (
      !target.endsWith('/index.ts') ||
      !bindings ||
      !ts.isNamedImports(bindings)
    ) {
      dependencies.push(target);
      continue;
    }
    const facade = readSource(target);
    for (const imported of bindings.elements) {
      const name = imported.propertyName?.text ?? imported.name.text;
      const matched = facade.statements.find(
        (exported) =>
          ts.isExportDeclaration(exported) &&
          exported.moduleSpecifier &&
          ts.isStringLiteral(exported.moduleSpecifier) &&
          exported.exportClause &&
          ts.isNamedExports(exported.exportClause) &&
          exported.exportClause.elements.some(
            (item) => item.name.text === name,
          ),
      );
      if (
        matched &&
        ts.isExportDeclaration(matched) &&
        matched.moduleSpecifier &&
        ts.isStringLiteral(matched.moduleSpecifier)
      ) {
        const source = resolveImport(target, matched.moduleSpecifier.text);
        if (source) dependencies.push(source);
      } else dependencies.push(target);
    }
  }
  return dependencies;
}

it('keeps infrastructure independent of business modules and modules independent of composition/transport implementations', () => {
  for (const [file, deps] of graph) {
    const name = relative(root, file);
    for (const dep of deps) {
      const target = relative(root, dep);
      if (target.startsWith('modules/')) {
        const domain = target.split('/')[1];
        const owner = name.startsWith('modules/')
          ? name.split('/')[1]
          : undefined;
        if (owner !== domain)
          expect(target, `${name} -> ${target}`).toBe(
            `modules/${domain}/index.ts`,
          );
      }
      if (name.startsWith('core/'))
        expect(target.startsWith('core/'), `${name} -> ${target}`).toBe(true);
      if (
        name.startsWith('modules/management/routes/') &&
        target.startsWith('modules/')
      )
        expect(
          target.startsWith('modules/management/'),
          `${name} -> ${target}: domain routes must be injected by composition`,
        ).toBe(true);
      if (name.startsWith('modules/')) {
        const socketContract =
          target === 'core/transport/socket-routes.ts' &&
          /(^|[/.])socket\.ts$/.test(name);
        expect(
          ['app.ts', 'server.ts', 'index.ts'].includes(target) ||
            (target.startsWith('core/transport/') && !socketContract) ||
            target.startsWith('routes/') ||
            target.startsWith('http/') ||
            (target.startsWith('core/http/') && isRoute(target)) ||
            target.startsWith('core/openapi/'),
          `${name} -> ${target}`,
        ).toBe(false);
        if (socketContract) {
          const source = ts.createSourceFile(
            file,
            readFileSync(file, 'utf8'),
            ts.ScriptTarget.Latest,
          );
          const imports = source.statements.filter(
            (statement): statement is ts.ImportDeclaration =>
              ts.isImportDeclaration(statement) &&
              ts.isStringLiteral(statement.moduleSpecifier) &&
              resolve(dirname(file), statement.moduleSpecifier.text) + '.ts' ===
                dep,
          );
          expect(imports.length, `${name} -> ${target}`).toBeGreaterThan(0);
          for (const statement of imports)
            expect(
              statement.importClause?.isTypeOnly,
              `${name} -> ${target}`,
            ).toBe(true);
        }
      }
      if (
        name.startsWith('modules/audio/') ||
        name.startsWith('modules/providers/') ||
        name.startsWith('modules/tasks/')
      )
        expect(
          target.startsWith('modules/ai-characters/'),
          `${name} -> ${target}`,
        ).toBe(false);
      if (name.startsWith('modules/audio/'))
        expect(target.startsWith('modules/chat/'), `${name} -> ${target}`).toBe(
          false,
        );
      if (
        name.startsWith('modules/tasks/') &&
        !isRoute(name) &&
        !name.endsWith('/index.ts')
      )
        expect(
          target.startsWith('modules/management/'),
          `${name} -> ${target}`,
        ).toBe(false);
    }
    if (!name.startsWith('core/config/'))
      expect(readFileSync(file, 'utf8'), name).not.toMatch(/process\.env/);
  }
});
function assertNoRouteDependencies(
  file: string,
  dependencies: (file: string) => string[] = usedDependencies,
) {
  const visited = new Set<string>();
  function visit(current: string, chain: string[]) {
    if (visited.has(current)) return;
    visited.add(current);
    for (const dep of dependencies(current)) {
      const path = [...chain, relative(root, dep)];
      expect(isRoute(relative(root, dep)), path.join(' -> ')).toBe(false);
      visit(dep, path);
    }
  }
  visit(file, [relative(root, file)]);
}

it('keeps domain implementations independent of HTTP routes, including through barrels', () => {
  for (const file of graph.keys()) {
    const name = relative(root, file);
    if (
      (!name.startsWith('modules/') && !name.startsWith('persistence/')) ||
      isRoute(name) ||
      name.endsWith('/index.ts')
    )
      continue;
    assertNoRouteDependencies(file);
  }
});

function fixtureDependencies(files: Record<string, string>) {
  const contents = new Map(
    Object.entries(files).map(([file, text]) => [resolve(root, file), text]),
  );
  return (file: string) =>
    usedDependencies(
      file,
      (path) =>
        ts.createSourceFile(path, contents.get(path)!, ts.ScriptTarget.Latest),
      (from, spec) => {
        const base = resolve(dirname(from), spec);
        return [base, base + '.ts', base + '/index.ts'].find((path) =>
          contents.has(path),
        );
      },
    );
}

it.each([
  "export { handler } from './routes/example.routes';",
  "export * from './routes/example.routes';",
  "export type { Handler } from './routes/example.routes';",
])('rejects an indirect HTTP dependency through %s', (reexport) => {
  const dependencies = fixtureDependencies({
    'modules/example/services/worker.ts':
      "import * as helpers from '../helpers';",
    'modules/example/helpers.ts': "export * from './barrel';",
    'modules/example/barrel.ts': reexport,
    'modules/example/routes/example.routes.ts':
      'export const handler = () => {}; export type Handler = typeof handler;',
  });
  expect(() =>
    assertNoRouteDependencies(
      resolve(root, 'modules/example/services/worker.ts'),
      dependencies,
    ),
  ).toThrow('routes/example.routes.ts');
});

it('does not follow unrelated route exports when a service imports a named facade contract', () => {
  const dependencies = fixtureDependencies({
    'modules/consumer/services/worker.ts':
      "import { Service as Alias } from '../../example';",
    'modules/example/index.ts':
      "export { Service } from './service'; export { handler } from './routes/example.routes';",
    'modules/example/service.ts': 'export class Service {}',
    'modules/example/routes/example.routes.ts':
      'export const handler = () => {};',
  });
  expect(() =>
    assertNoRouteDependencies(
      resolve(root, 'modules/consumer/services/worker.ts'),
      dependencies,
    ),
  ).not.toThrow();
});
it('exports server module contracts from their owning module rather than compatibility facades', () => {
  for (const file of graph.keys()) {
    const name = relative(root, file);
    if (!name.startsWith('modules/')) continue;
    const module = name.split('/')[1];
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
    );
    for (const statement of source.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith('.')) continue;
      const target = relative(root, resolve(dirname(file), spec));
      expect(
        target.startsWith(`modules/${module}/`),
        `${name} re-exports ${target}`,
      ).toBe(true);
    }
  }
});
it('has no server module cycles, including type imports and re-exports', () => {
  const done = new Set<string>();
  function visit(file: string, chain: string[]) {
    if (chain.includes(file))
      throw Error([...chain, file].map((p) => relative(root, p)).join(' -> '));
    if (done.has(file)) return;
    for (const dep of graph.get(file) ?? []) visit(dep, [...chain, file]);
    done.add(file);
  }
  for (const file of graph.keys()) visit(file, []);
});
it('keeps all world integration/sandbox assembly on the production test factory', () => {
  const testRoot = resolve(root, '../test');
  for (const dir of ['integration', 'sandbox'])
    for (const name of readdirSync(resolve(testRoot, dir)).filter((n) =>
      n.endsWith('.ts'),
    )) {
      const source = readFileSync(resolve(testRoot, dir, name), 'utf8');
      expect(source, `${dir}/${name}`).toContain('createTestServer');
      expect(source, `${dir}/${name}`).not.toMatch(
        /new Server\(|\.define\('world'/,
      );
    }
});
