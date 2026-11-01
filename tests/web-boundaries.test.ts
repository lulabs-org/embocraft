import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../apps/web/src/', import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(resolve(dir, entry.name))
      : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
        ? [resolve(dir, entry.name)]
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
          [base, base + '.ts', base + '.tsx', base + '/index.ts'].find(
            (p) => existsSync(p) && statSync(p).isFile(),
          ) ?? base
        );
      })
      .filter((dep) => dep.startsWith(root) && /\.tsx?$/.test(dep)),
  ]),
);

it('keeps infrastructure and reusable UI independent of features and React-free audio/graphics/network', () => {
  for (const [file, dependencies] of graph) {
    const name = relative(root, file);
    if (/^(audio|graphics|network|hooks|components)\//.test(name))
      for (const dependency of dependencies)
        expect(
          relative(root, dependency).startsWith('features/'),
          `${name} -> ${relative(root, dependency)}`,
        ).toBe(false);
    if (/^(audio|graphics|network)\//.test(name))
      expect(readFileSync(file, 'utf8'), name).not.toMatch(
        /from ['"]react(?:-dom)?(?:\/[^'"]*)?['"]/,
      );
  }
});

it('uses public feature entrypoints across features and in App', () => {
  for (const [file, dependencies] of graph) {
    const own = relative(root, file).match(/^features\/([^/]+)\//)?.[1];
    for (const dependency of dependencies) {
      const target = relative(root, dependency).match(
        /^features\/([^/]+)\/(.+)$/,
      );
      if (target && own !== target[1])
        expect(
          target[2],
          `${relative(root, file)} -> ${relative(root, dependency)}`,
        ).toBe('index.ts');
    }
  }
});

it('keeps the admin console out of the initial chunk', () => {
  const source = readFileSync(resolve(root, 'App.tsx'), 'utf8');
  const loader = readFileSync(resolve(root, 'load-console.ts'), 'utf8');
  expect(source).toMatch(/lazy\(/);
  expect(loader).toMatch(/import\(['"]\.\/features\/console['"]\)/);
  expect(source + loader).not.toMatch(
    /import\s+(?:type\s+)?\{[^}]*\bControlConsole\b[^}]*\}\s*from\s*['"]\.\/features\/console['"]/,
  );
});

it('keeps locale dictionaries out of the initial chunk', () => {
  const source = readFileSync(resolve(root, 'i18n/config.ts'), 'utf8');
  expect(source).toMatch(/import\(['"]\.\/locales\/[a-z]+\.json['"]\)/);
  expect(source).not.toMatch(/from\s+['"]\.\/locales\//);
});

it('keeps requests out of feature components and hooks, and addresses in endpoints', () => {
  for (const file of graph.keys()) {
    const name = relative(root, file),
      source = readFileSync(file, 'utf8');
    if (
      name.startsWith('features/') &&
      !['api.ts', 'request.ts'].includes(name.split('/').at(-1)!)
    )
      expect(source, name).not.toMatch(/\bfetch\s*\(/);
    if (name !== 'network/endpoints.ts')
      expect(source, name).not.toContain('import.meta.env.VITE_SERVER_URL');
  }
});

it('has no Web dependency cycles, including type imports and public re-exports', () => {
  const visited = new Set<string>();
  function visit(file: string, chain: string[]) {
    if (chain.includes(file))
      throw Error([...chain, file].map((p) => relative(root, p)).join(' -> '));
    if (visited.has(file)) return;
    for (const dependency of graph.get(file) ?? [])
      visit(dependency, [...chain, file]);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file, []);
});

it('keeps the PCM worklet URL pointed at a shipped JavaScript asset', () => {
  for (const file of ['audio/recording/live-recorder.ts']) {
    const source = readFileSync(resolve(root, file), 'utf8');
    const reference = source.match(
      /new URL\('([^']+pcm-worklet\.js)', import\.meta\.url\)/,
    )?.[1];
    expect(reference, file).toBeDefined();
    expect(existsSync(resolve(root, dirname(file), reference!)), file).toBe(
      true,
    );
  }
});

it('loads HUD overrides after shared surfaces in the original cascade order', () => {
  const imports = ts
    .preProcessFile(readFileSync(resolve(root, 'main.tsx'), 'utf8'), true, true)
    .importedFiles.map((i) => i.fileName);
  expect(imports.filter((i) => i.endsWith('.css'))).toEqual([
    './styles/main.css',
    './features/hud/hud.css',
  ]);
});

it('keeps roles free of plan controls and the plan workspace independent of the console controller', () => {
  for (const [file, dependencies] of graph) {
    const name = relative(root, file);
    if (name.startsWith('features/console/ai-characters/'))
      for (const dependency of dependencies)
        expect(relative(root, dependency), name).not.toContain('/tasks/');
    if (name.startsWith('features/console/tasks/'))
      expect(readFileSync(file, 'utf8'), name).not.toMatch(
        /ConsoleController|useConsoleController/,
      );
  }
});
