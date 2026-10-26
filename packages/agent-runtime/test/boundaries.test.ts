import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const runtime = fileURLToPath(new URL('../src/', import.meta.url));
const root = resolve(runtime, '../../..');
const packageJson = JSON.parse(
  readFileSync(resolve(runtime, '../package.json'), 'utf8'),
) as { dependencies: Record<string, string> };

/** Production sources only; colocated tests are free to import fakes. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** Include type imports, re-exports and dynamic imports in the boundary check. */
function imports(path: string) {
  return ts
    .preProcessFile(readFileSync(path, 'utf8'), true, true)
    .importedFiles.map(({ fileName }) => fileName);
}

function resolveLocal(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`])
    if (fileSet.has(candidate)) return candidate;
  throw Error(`Unresolved import ${specifier} from ${relative(runtime, from)}`);
}

const files = sources(runtime);
const fileSet = new Set(files);

const graph = new Map(
  files.map((path) => [
    path,
    imports(path)
      .filter((name) => name.startsWith('.'))
      .map((name) => resolveLocal(path, name)),
  ]),
);

function layer(path: string) {
  const segments = relative(runtime, path).split('/');
  return segments.length === 1 ? segments[0].replace('.ts', '') : segments[0];
}

/** Public surface modules may aggregate symbols; implementation layers import them directly. */
function isSurface(path: string): boolean {
  const module = relative(runtime, path).split('\\').join('/');
  return (
    ['api', 'index', 'testing'].includes(layer(path)) ||
    module === 'contracts/index.ts'
  );
}

/** Arrows point from importer to allowed dependencies only. */
const allowed: Record<string, string[]> = {
  contracts: ['contracts'],
  kernel: ['kernel'],
  world: ['world', 'contracts', 'kernel'],
  agent: ['agent', 'world', 'contracts', 'kernel'],
  persistence: ['contracts'],
  api: ['api', 'agent', 'world', 'persistence', 'contracts', 'kernel'],
  testing: ['testing', 'world', 'contracts'],
  index: ['api'],
};

describe('agent runtime dependency boundaries', () => {
  it('has no circular module dependencies, including types and re-exports', () => {
    const visited = new Set<string>();
    function visit(path: string, chain: string[]) {
      if (chain.includes(path))
        throw Error(
          `Dependency cycle: ${[...chain, path]
            .map((p) => relative(runtime, p))
            .join(' -> ')}`,
        );
      if (visited.has(path)) return;
      const dependencies = graph.get(path);
      expect(dependencies, `Unknown runtime module: ${path}`).toBeDefined();
      for (const dependency of dependencies!)
        visit(dependency, [...chain, path]);
      visited.add(path);
    }
    for (const path of graph.keys()) visit(path, []);
  });

  it('only imports along declared layer edges', () => {
    for (const [path, dependencies] of graph) {
      const own = layer(path);
      const permitted = allowed[own];
      expect(permitted, relative(runtime, path)).toBeDefined();
      for (const dependency of dependencies)
        expect(
          permitted,
          `${relative(runtime, path)} -> ${relative(runtime, dependency)}`,
        ).toContain(layer(dependency));
    }
  });

  it('keeps contracts a pure type leaf', () => {
    for (const path of files.filter((f) =>
      f.startsWith(resolve(runtime, 'contracts')),
    ))
      for (const name of imports(path)) {
        if (name.startsWith('.')) continue;
        expect(name, relative(runtime, path)).toBe('@voxel/shared');
      }
  });

  it('keeps world execution and task policy apart', () => {
    const executors = new Set([
      resolve(runtime, 'world/actions/execute.ts'),
      resolve(runtime, 'world/actions/batch.ts'),
      resolve(runtime, 'world/actions/build.ts'),
    ]);
    for (const [path, dependencies] of graph) {
      const module = relative(runtime, path);
      if (!module.startsWith('agent/task/')) continue;
      for (const dependency of dependencies)
        expect(executors.has(dependency), module).toBe(false);
      const external = imports(path).filter((name) => !name.startsWith('.'));
      expect(
        external.some((name) => name.startsWith('@earendil-works/')),
        module,
      ).toBe(false);
      expect(external, module).not.toContain('openai');
    }
  });

  it('keeps tool handlers behind the ToolHost port', () => {
    for (const path of files.filter((file) =>
      relative(runtime, file).startsWith('agent/tools/'),
    )) {
      for (const dependency of graph.get(path) ?? [])
        expect(
          relative(runtime, dependency),
          relative(runtime, path),
        ).not.toMatch(/^agent\/turn\//);
    }
  });

  it('routes every decision through one turn loop and keeps task commands in the service', () => {
    const slot = readFileSync(resolve(runtime, 'api/runtime.ts'), 'utf8');
    const runner = readFileSync(resolve(runtime, 'agent/turn/wake.ts'), 'utf8');
    expect(slot).toContain("export { AgentRunner } from '../agent/turn/wake'");
    expect(runner).toContain('export class AgentRunner');
    for (const path of graph.keys())
      expect(path).not.toMatch(
        /(?:conversation-runner|task-runner|conversation-tools)\.ts$/,
      );
    const taskTools = readFileSync(
      resolve(runtime, 'agent/tools/task.ts'),
      'utf8',
    );
    expect(taskTools).not.toContain('.command(');
    expect(taskTools).not.toContain('.commit(');
    for (const path of graph.keys())
      expect(readFileSync(path, 'utf8')).not.toContain('update_task');
  });

  it('uses declared package dependencies and never imports application code', () => {
    for (const path of graph.keys())
      for (const name of imports(path)) {
        if (name.startsWith('.') || name.startsWith('node:')) continue;
        const declared = name.startsWith('@')
          ? name.split('/').slice(0, 2).join('/')
          : name.split('/')[0];
        expect(
          Object.keys(packageJson.dependencies),
          relative(runtime, path),
        ).toContain(declared);
      }
    for (const directory of [
      resolve(root, 'apps/server'),
      resolve(root, 'scripts/agent'),
    ])
      for (const path of sources(directory))
        for (const name of imports(path)) {
          expect(name).not.toMatch(/^@voxel\/agent-runtime\//);
          if (!name.startsWith('.')) continue;
          const target = resolve(dirname(path), name);
          expect(relative(root, target)).not.toMatch(
            /^packages\/agent-runtime\/src\//,
          );
        }
  });

  it('keeps re-exports and inline import() types on the public surface', () => {
    for (const path of files) {
      if (isSurface(path)) continue;
      const module = relative(runtime, path);
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const reExports = source.statements
        .filter(ts.isExportDeclaration)
        .flatMap((statement) =>
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
            ? [statement.getText(source)]
            : [],
        );
      expect(
        reExports,
        `${module} must import from the defining module instead of re-exporting it`,
      ).toEqual([]);
      const inline: number[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isImportTypeNode(node))
          inline.push(
            source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          );
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(inline, `${module} uses inline import() types at`).toEqual([]);
    }
  });
});
