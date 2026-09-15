import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  SearchDb,
  readManifest,
  INDEX_VERSION,
  MANIFEST_FILE,
  ensureMeta,
  getStoredModel,
} from './db.js';

/** Cross-process writer lock; a crashed owner's lock can be reclaimed. */
async function lock(cacheDir: string): Promise<() => Promise<void>> {
  const path = join(cacheDir, 'search-write.lock');
  const deadline = Date.now() + 120000;
  while (true) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const { pid } = JSON.parse(await readFile(path, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
              await rm(path, { force: true });
              continue;
            }
          }
        }
      } catch {
        /* Owner may still be writing the lock. */
      }
      if (Date.now() > deadline)
        throw new Error('Search index writer is busy; retry shortly.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function archiveLegacy(cacheDir: string): Promise<string | null> {
  const migration = join(cacheDir, 'search-migration.json');
  if (existsSync(migration)) {
    const { model, archive } = JSON.parse(await readFile(migration, 'utf8'));
    const old = join(cacheDir, 'vectors.db');
    if (existsSync(old) && !existsSync(archive)) await rename(old, archive);
    for (const suffix of ['-wal', '-shm', '-journal'])
      if (existsSync(old + suffix) && !existsSync(archive + suffix))
        await rename(old + suffix, archive + suffix);
    return model;
  }
  const old = join(cacheDir, 'vectors.db');
  if (!existsSync(old)) return null;
  // Process exit releases libSQL's native handles before Windows renames the file.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      import { createRequire } from 'node:module';
      const { createClient } = createRequire(process.argv[2])('@libsql/client');
      const db = createClient({ url: process.argv[1] });
      let model = null;
      try {
        const tables = await db.execute("SELECT name FROM sqlite_master WHERE name='meta'");
        if (tables.rows.length) {
          model = (await db.execute("SELECT value FROM meta WHERE key='embedding_model'")).rows[0]?.value ?? null;
        }
        await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { db.close(); }
      process.stdout.write(JSON.stringify(model));
    `,
      `file:${old}`,
      import.meta.url,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const model = JSON.parse(stdout) as string | null;
  let archive = old + '.old-12',
    suffix = 0;
  while (existsSync(archive)) archive = old + `.old-12.${++suffix}`;
  await writeFile(migration, JSON.stringify({ model, archive }));
  await rename(old, archive);
  for (const sidecar of ['-wal', '-shm', '-journal'])
    if (existsSync(old + sidecar))
      await rename(old + sidecar, archive + sidecar);
  return model;
}

const GENERATION_FILE = /^(search-[\w-]+\.db)(?:-wal|-shm|-tshm|-journal)?$/;

/**
 * Delete generation files other than `keep`. Every published update copies the
 * whole database, so without this each doc edit followed by a search leaves
 * another full-size copy behind. The generation just replaced is kept: a reader
 * that read the previous manifest may not have opened its file yet. Files a
 * process still holds open on Windows are left for a later publish.
 */
async function removeOldGenerations(
  dir: string,
  keep: readonly (string | undefined)[],
): Promise<void> {
  for (const entry of await readdir(dir)) {
    const generation = GENERATION_FILE.exec(entry)?.[1];
    if (!generation || keep.includes(generation)) continue;
    try {
      await rm(join(dir, entry), { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!['EBUSY', 'EPERM'].includes(code)) throw error;
    }
  }
}

/**
 * Write a compacted copy of a finished staging database beside it and return
 * the copy's generation name, or null if compaction failed. The engine does not
 * reuse pages freed by updates, and every FTS rebuild frees the whole old index,
 * so without this each incremental publish carries all earlier dead space
 * forward. The driver accepts only a literal path and cannot write under a
 * directory whose name contains an apostrophe; on any failure the caller
 * publishes the uncompacted staging file, since compaction only saves space.
 */
async function compactGeneration(
  db: SearchDb,
  dir: string,
): Promise<string | null> {
  const name = `search-${randomUUID()}.db`,
    path = join(dir, name);
  try {
    await db.execute(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return name;
  } catch {
    for (const suffix of ['', '-wal', '-shm'])
      await rm(path + suffix, { force: true });
    return null;
  }
}

/** Stage a complete generation; failed work cannot replace a usable index. */
export async function writeIndex<T>(
  latDir: string,
  cacheDir: string | undefined,
  rebuild: boolean,
  work: (db: SearchDb, storedModel: string | null) => Promise<T>,
): Promise<T> {
  const dir = cacheDir ?? join(latDir, '.cache');
  await mkdir(dir, { recursive: true });
  const release = await lock(dir);
  const name = `search-${randomUUID()}.db`,
    path = join(dir, name);
  let db: SearchDb | undefined;
  let compacted: string | null = null;
  try {
    let manifest;
    try {
      manifest = readManifest(dir);
    } catch (error) {
      if (!rebuild) throw error;
      manifest = null;
    }
    let model: string | null = null;
    if (manifest) {
      const active = new SearchDb(
        join(dir, manifest.file),
        true,
        process.platform === 'win32',
      );
      try {
        model = await getStoredModel(active);
      } finally {
        await active.close();
      }
      if (!rebuild) await copyFile(join(dir, manifest.file), path);
    } else model = await archiveLegacy(dir);
    // Staging has one writer and no readers. Multiprocess WAL can stall large
    // FTS builds; enable it only when opening published generations.
    db = new SearchDb(path, false);
    await ensureMeta(db);
    const changesBefore = (await db.execute('SELECT total_changes() AS n'))
      .rows[0].n;
    const result = await work(db, model);
    const unchanged =
      manifest &&
      !rebuild &&
      (await db.execute('SELECT total_changes() AS n')).rows[0].n ===
        changesBefore;
    await db.checkpoint();
    if (!unchanged) compacted = await compactGeneration(db, dir);
    await db.close();
    db = undefined;
    if (unchanged || compacted)
      for (const suffix of ['', '-wal', '-shm'])
        await rm(path + suffix, { force: true });
    if (unchanged) return result;
    const published = compacted ?? name;
    const temp = join(dir, `${MANIFEST_FILE}.${randomUUID()}.tmp`);
    await writeFile(
      temp,
      JSON.stringify({ version: INDEX_VERSION, file: published }),
    );
    await rename(temp, join(dir, MANIFEST_FILE));
    await removeOldGenerations(dir, [published, manifest?.file]);
    return result;
  } catch (error) {
    await db?.close();
    for (const staged of [path, compacted && join(dir, compacted)])
      if (staged)
        for (const suffix of ['', '-wal', '-shm'])
          await rm(staged + suffix, { force: true });
    throw error;
  } finally {
    await release();
  }
}
