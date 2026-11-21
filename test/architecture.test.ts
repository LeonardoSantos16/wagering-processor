import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../src');

const IMPORT_PATTERN = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => (match[1] ?? match[2]) as string);
}

function filesIn(layer: string): string[] {
  const dir = join(SRC, layer);
  if (!existsSync(dir)) {
    return [];
  }
  const glob = new Glob('**/*.ts');
  return [...glob.scanSync({ cwd: dir, absolute: true })];
}

function layerOf(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const target = relative(SRC, resolve(file, '..', specifier)).replaceAll('\\', '/');
  return target.split('/')[0];
}

function violations(layer: string, forbiddenPackages: RegExp, forbiddenLayers: string[]) {
  return filesIn(layer).flatMap((file) =>
    importsOf(file)
      .filter((specifier) => {
        const targetLayer = layerOf(file, specifier);
        return (
          forbiddenPackages.test(specifier) ||
          (targetLayer !== undefined && forbiddenLayers.includes(targetLayer))
        );
      })
      .map((specifier) => `${relative(SRC, file)} -> ${specifier}`),
  );
}

describe('architecture boundaries', () => {
  test('domain does not depend on frameworks, ORM or outer layers', () => {
    expect(
      violations('domain', /^@nestjs\/|^@mikro-orm\/|^@aws-sdk\//, ['application', 'infrastructure']),
    ).toEqual([]);
  });

  test('application does not depend on frameworks, ORM or infrastructure', () => {
    expect(
      violations('application', /^@mikro-orm\/|^@aws-sdk\//, ['infrastructure']),
    ).toEqual([]);
  });
});
