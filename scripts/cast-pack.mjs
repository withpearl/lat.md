#!/usr/bin/env node
/**
 * Pack the Cast build of lat as one self-contained tarball.
 *
 * `pnpm pack` rewrites `workspace:*` dependencies to exact versions, which only
 * install when those versions are on npm. `@lat.md/server` is not published (and
 * the `@lat.md` scope is not ours to publish to), so the plain tarball fails with
 * E404. This bundles the built server package inside the tarball as a
 * `bundleDependencies` entry, so npm uses the copy it ships with.
 *
 * npm treats a bundled package's own dependencies as part of the bundle too, and
 * leaves them uninstalled. The bundled copy therefore declares none: each of its
 * dependencies must also be a dependency of lat itself, which Node resolves one
 * directory up. The script refuses to pack if that stops being true.
 *
 * Usage (after `pnpm buildall`): node scripts/cast-pack.mjs <output-dir>
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(process.argv[2] ?? join(root, 'cast-dist'));
const BUNDLED = '@lat.md/server';

// COPYFILE_DISABLE stops macOS tar from adding `._*` AppleDouble metadata files.
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf-8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
const newest = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(dir, f));

const work = mkdtempSync(join(tmpdir(), 'cast-pack-'));
try {
  const rootPack = join(work, 'root');
  const serverPack = join(work, 'server');
  mkdirSync(rootPack);
  mkdirSync(serverPack);
  run('pnpm', ['pack', '--pack-destination', rootPack]);
  run('pnpm', ['--filter', BUNDLED, 'pack', '--pack-destination', serverPack]);
  const [rootTgz] = newest(rootPack);
  const [serverTgz] = newest(serverPack);

  const stage = join(work, 'stage');
  mkdirSync(stage);
  run('tar', ['-xzf', rootTgz, '-C', stage]);
  const serverStage = join(work, 'server-stage');
  mkdirSync(serverStage);
  run('tar', ['-xzf', serverTgz, '-C', serverStage]);

  const pkgDir = join(stage, 'package');
  const bundledDir = join(pkgDir, 'node_modules', ...BUNDLED.split('/'));
  mkdirSync(bundledDir, { recursive: true });
  cpSync(join(serverStage, 'package'), bundledDir, { recursive: true });

  const pkgPath = join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const bundledPkgPath = join(bundledDir, 'package.json');
  const bundledPkg = JSON.parse(readFileSync(bundledPkgPath, 'utf-8'));
  if (pkg.dependencies?.[BUNDLED] !== bundledPkg.version) {
    throw new Error(
      `expected dependency ${BUNDLED}@${bundledPkg.version}, found ${pkg.dependencies?.[BUNDLED]}`,
    );
  }
  for (const [name, range] of Object.entries(bundledPkg.dependencies ?? {})) {
    if (pkg.dependencies?.[name] !== range) {
      throw new Error(
        `${BUNDLED} needs ${name}@${range}, which lat does not also depend on (lat has ${pkg.dependencies?.[name]})`,
      );
    }
  }
  delete bundledPkg.dependencies;
  writeFileSync(bundledPkgPath, `${JSON.stringify(bundledPkg, null, 2)}\n`);
  pkg.bundleDependencies = [BUNDLED];
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `lat.md-${pkg.version}.tgz`);
  rmSync(outFile, { force: true });
  run('tar', ['-czf', outFile, '-C', stage, 'package']);
  console.log(outFile);
} finally {
  rmSync(work, { recursive: true, force: true });
}
