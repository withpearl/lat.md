import { synchronizeLexical } from './lexical.js';
import { dirname } from 'node:path';
import { CREATE_PASSAGE_FTS, type SearchDb } from './db.js';
import {
  analyzeMarkdownProject,
  type MarkdownProjectAnalysis,
} from '../project-analysis.js';
import type { Embedder } from './embedder.js';
import { indexedDirectory } from '../lattice-model.js';
import {
  chunkFile,
  digest,
  embeddingFingerprint,
  type Passage,
  type SectionChunkKey,
  type StoredSectionPassages,
} from './chunks.js';

export function projectFingerprint(project: MarkdownProjectAnalysis): string {
  return digest(
    [...project.files.values()]
      .map((f) => `${f.projectPath}\0${digest(f.content)}`)
      .sort()
      .join('\n'),
  );
}

export type IndexStats = {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
};
/** Exact identifier tokens complement FTS's punctuation and long-token handling. */
export function identifierTokens(text: string): string[] {
  return [
    ...new Set(
      (text.match(/[\p{L}\p{N}_][\p{L}\p{N}_./:#@-]*/gu) ?? [])
        .map((t) => t.toLowerCase())
        .filter((t) => /[_./:#@-]/.test(t) || t.length >= 40),
    ),
  ];
}
type IndexedSection = MarkdownProjectAnalysis['sections'][number];

/**
 * Root sections that only continue their folder: the top heading of a file
 * inside a directory whose index file has the same top heading, as every shard
 * of a file split into a folder repeats it (`# Tests`). They remain sections for
 * refs and checks but get no search passages, so a split adds no near-identical
 * results and leaves term statistics as they were.
 */
function folderContinuationRoots(
  sections: readonly IndexedSection[],
): Set<string> {
  const indexRoots = new Map<string, Set<string>>();
  for (const s of sections) {
    const dir = s.depth === 1 ? indexedDirectory(s.file) : null;
    if (!dir) continue;
    const headings = indexRoots.get(dir.toLowerCase()) ?? new Set<string>();
    headings.add(s.heading.toLowerCase());
    indexRoots.set(dir.toLowerCase(), headings);
  }
  const roots = new Set<string>();
  if (!indexRoots.size) return roots;
  for (const s of sections) {
    if (s.depth !== 1 || indexedDirectory(s.file)) continue;
    const slash = s.file.lastIndexOf('/');
    const dir = slash === -1 ? '' : s.file.slice(0, slash).toLowerCase();
    if (indexRoots.get(dir)?.has(s.heading.toLowerCase())) roots.add(s.id);
  }
  return roots;
}

/**
 * Stored passages for sections with a recorded chunk key, usable by chunkFile
 * only when every passage is still embedded and their ordinals are contiguous.
 */
async function storedPassages(
  db: SearchDb,
  keys: ReadonlyMap<string, SectionChunkKey>,
  embedded: ReadonlySet<string>,
): Promise<Map<string, StoredSectionPassages>> {
  const stored = new Map<string, StoredSectionPassages>();
  if (!keys.size) return stored;
  const unusable = new Set<string>();
  for (const c of (
    await db.execute(
      'SELECT section_id,ordinal,type,spans,body,input_hash FROM chunks ORDER BY section_id,ordinal',
    )
  ).rows) {
    const key = keys.get(c.section_id);
    if (!key || unusable.has(c.section_id)) continue;
    const entry = stored.get(c.section_id) ?? { ...key, passages: [] };
    if (
      !embedded.has(c.input_hash) ||
      Number(c.ordinal) !== entry.passages.length
    ) {
      unusable.add(c.section_id);
      stored.delete(c.section_id);
      continue;
    }
    entry.passages.push({
      type: c.type,
      spans: JSON.parse(c.spans),
      text: c.body,
      inputHash: c.input_hash,
    });
    stored.set(c.section_id, entry);
  }
  return stored;
}

/**
 * Of the given changed sections, those whose stored rows would be rewritten
 * identically apart from line numbers and passage spans — typically every
 * section below lines inserted earlier in the same file. Maps each to its chunk
 * ids in ordinal order, so an update can move them without touching their
 * lexical rows, identifiers or full-text index.
 */
async function movedSections(
  db: SearchDb,
  ids: readonly string[],
  sections: ReadonlyMap<string, IndexedSection>,
  parents: ReadonlyMap<string, string>,
  owned: ReadonlyMap<string, Passage[]>,
): Promise<Map<string, number[]>> {
  const moved = new Map<string, number[]>();
  if (!ids.length) return moved;
  const wanted = new Set(ids);
  const rows = new Map(
    (
      await db.execute('SELECT id,file,heading,content,parent_id FROM sections')
    ).rows
      .filter((r) => wanted.has(r.id))
      .map((r) => [r.id as string, r]),
  );
  const chunks = new Map<string, any[]>();
  for (const c of (
    await db.execute(
      'SELECT id,section_id,source_id,ordinal,type,body,heading,path,input_hash FROM chunks ORDER BY section_id,ordinal',
    )
  ).rows) {
    if (!wanted.has(c.section_id)) continue;
    const list = chunks.get(c.section_id) ?? [];
    list.push(c);
    chunks.set(c.section_id, list);
  }
  for (const id of ids) {
    const s = sections.get(id);
    const row = rows.get(id);
    if (
      !s ||
      !row ||
      row.file !== s.file ||
      row.heading !== s.heading ||
      row.content !== s.firstParagraph ||
      (row.parent_id ?? null) !== (parents.get(id) ?? null)
    )
      continue;
    const stored = chunks.get(id) ?? [];
    const next = owned.get(id) ?? [];
    const same =
      stored.length === next.length &&
      next.every((p, i) => {
        const c = stored[i];
        return (
          c.source_id === p.id &&
          Number(c.ordinal) === p.ordinal &&
          c.type === p.type &&
          c.body === p.text &&
          c.heading === p.heading &&
          c.path === p.path &&
          c.input_hash === p.inputHash
        );
      });
    if (same)
      moved.set(
        id,
        stored.map((c) => Number(c.id)),
      );
  }
  return moved;
}

export async function indexSections(
  latDir: string,
  db: SearchDb,
  embedder: Embedder,
  onProgress?: (done: number, total: number) => void,
  analyzedProject?: MarkdownProjectAnalysis,
): Promise<IndexStats> {
  const project =
    analyzedProject ??
    (await analyzeMarkdownProject(latDir, dirname(latDir), {
      executor: 'auto',
    }));
  const fingerprint = embeddingFingerprint(embedder);
  const oldFingerprint = (
    await db.execute("SELECT value FROM meta WHERE key='fingerprint'")
  ).rows[0]?.value;
  if (oldFingerprint && oldFingerprint !== fingerprint)
    throw new Error(
      'Search chunking or embedding model changed; run lat reindex.',
    );
  const byFile = new Map<string, typeof project.sections>();
  for (const s of project.sections) {
    const list = byFile.get(s.filePath) ?? [];
    list.push(s);
    byFile.set(s.filePath, list);
  }
  const files = new Map(
    [...project.files.values()].map((f) => [f.projectPath, f]),
  );
  const storedHashes = new Set<string>(
    (await db.execute('SELECT hash FROM embeddings')).rows.map((r) => r.hash),
  );
  const storedKeys = new Map<string, SectionChunkKey>(
    (
      await db.execute(
        'SELECT section_id,chunk_key,region_start FROM section_chunk_keys',
      )
    ).rows.map((r) => [
      r.section_id,
      { key: r.chunk_key, regionStart: Number(r.region_start) },
    ]),
  );
  const stored = await storedPassages(db, storedKeys, storedHashes);
  const keys = new Map<string, SectionChunkKey>();
  const continuations = folderContinuationRoots(project.sections);
  const passages = [...byFile]
    .flatMap(([path, sections]) => {
      const file = files.get(path);
      if (!file) throw new Error(`Missing analyzed file: ${path}`);
      return chunkFile(file, sections, embedder, {
        keys,
        stored: (id) => stored.get(id),
      });
    })
    .filter((p) => !continuations.has(p.sectionId));
  const existing = new Map<string, string>(
    (await db.execute('SELECT id,content_hash FROM sections')).rows.map((r) => [
      r.id,
      r.content_hash,
    ]),
  );
  const sectionHashes = new Map<string, string>();
  const owned = new Map<string, typeof passages>();
  for (const p of passages) {
    const list = owned.get(p.sectionId) ?? [];
    list.push(p);
    owned.set(p.sectionId, list);
  }
  for (const s of project.sections) {
    // A repeated heading path yields a repeated id; the first occurrence stands
    // for it here and in the sections table.
    if (sectionHashes.has(s.id)) continue;
    sectionHashes.set(
      s.id,
      digest(
        JSON.stringify([
          { ...s, children: undefined },
          (owned.get(s.id) ?? []).map((p) => [p.inputHash, p.spans]),
        ]),
      ),
    );
  }
  const changed = new Set(
    [...sectionHashes]
      .filter(([id, hash]) => existing.get(id) !== hash)
      .map(([id]) => id),
  );
  const removed = [...existing.keys()].filter((id) => !sectionHashes.has(id));
  const firstById = new Map<string, (typeof project.sections)[number]>();
  for (const s of project.sections)
    if (!firstById.has(s.id)) firstById.set(s.id, s);
  const parents = new Map<string, string>();
  for (const s of project.sections)
    for (const child of s.children) parents.set(child.id, s.id);
  const moved = await movedSections(
    db,
    [...changed].filter((id) => existing.has(id)),
    firstById,
    parents,
    owned,
  );
  const stats = {
    added: [...changed].filter((id) => !existing.has(id)).length,
    updated: [...changed].filter((id) => existing.has(id)).length,
    removed: removed.length,
    unchanged: project.sections.length - changed.size,
  };
  if (!changed.size && !removed.length && oldFingerprint === fingerprint) {
    // Lexical maintenance can repair old generations without embedding work.
    await db.execute('BEGIN');
    try {
      await synchronizeLexical(db);
      await db.execute('COMMIT');
    } catch (error) {
      await db.execute('ROLLBACK');
      throw error;
    }
    return stats;
  }
  const missing = new Map(
    passages
      .filter((p) => !storedHashes.has(p.inputHash))
      .map((p) => [p.inputHash, p.input]),
  );
  if ([...missing.values()].some((input) => !input))
    throw new Error('A reused search passage has no stored embedding');
  const entries = [...missing];
  const vectors = entries.length
    ? await embedder.embed(
        entries.map(([, input]) => input),
        onProgress,
      )
    : [];
  if (
    vectors.length !== entries.length ||
    vectors.some(
      (v) =>
        v.length !== embedder.dimensions || v.some((n) => !Number.isFinite(n)),
    )
  )
    throw new Error('Embedding backend returned invalid vectors');
  // Sections whose stored text and structure are unchanged keep their rows;
  // only their line numbers and passage spans move.
  const rewritten = new Set([...changed].filter((id) => !moved.has(id)));
  const rebuildFts =
    !existing.size ||
    // Tantivy retains deleted versions in BM25 statistics until rebuilt.
    [...rewritten].some((id) => existing.has(id)) ||
    removed.length > 0 ||
    passages.filter((p) => rewritten.has(p.sectionId)).length > 512;
  await db.execute('BEGIN');
  try {
    if (rebuildFts) await db.execute('DROP INDEX IF EXISTS chunks_fts');
    for (let i = 0; i < entries.length; i++)
      await db.execute({
        sql: 'INSERT INTO embeddings VALUES (?,vector32(?))',
        args: [entries[i][0], JSON.stringify(vectors[i])],
      });
    for (const [id, chunkIds] of moved) {
      const s = firstById.get(id)!;
      await db.execute({
        sql: 'UPDATE sections SET content_hash=?, start_line=?, end_line=? WHERE id=?',
        args: [sectionHashes.get(id), s.startLine, s.endLine, id],
      });
      const sectionPassages = owned.get(id) ?? [];
      for (let i = 0; i < chunkIds.length; i++)
        await db.execute({
          sql: 'UPDATE chunks SET spans=? WHERE id=?',
          args: [JSON.stringify(sectionPassages[i].spans), chunkIds[i]],
        });
    }
    for (const id of [...rewritten, ...removed]) {
      await db.execute({
        sql: 'DELETE FROM lexical_chunks WHERE id IN (SELECT id FROM chunks WHERE section_id=?)',
        args: [id],
      });
      await db.execute({
        sql: 'DELETE FROM identifiers WHERE chunk_id IN (SELECT id FROM chunks WHERE section_id=?)',
        args: [id],
      });
      await db.execute({
        sql: 'DELETE FROM chunks WHERE section_id=?',
        args: [id],
      });
      await db.execute({ sql: 'DELETE FROM sections WHERE id=?', args: [id] });
      await db.execute({
        sql: 'DELETE FROM section_chunk_keys WHERE section_id=?',
        args: [id],
      });
    }
    for (const [id, key] of keys) {
      const prior = storedKeys.get(id);
      if (
        rewritten.has(id) ||
        prior?.key !== key.key ||
        prior.regionStart !== key.regionStart
      )
        await db.execute({
          sql: 'INSERT OR REPLACE INTO section_chunk_keys VALUES (?,?,?)',
          args: [id, key.key, key.regionStart],
        });
    }
    const inserted = new Set<string>();
    for (const s of project.sections)
      if (rewritten.has(s.id) && !inserted.has(s.id)) {
        inserted.add(s.id);
        await db.execute({
          sql: 'INSERT INTO sections VALUES (?,?,?,?,?,?,?,?)',
          args: [
            s.id,
            s.file,
            s.heading,
            s.firstParagraph,
            sectionHashes.get(s.id),
            parents.get(s.id) ?? null,
            s.startLine,
            s.endLine,
          ],
        });
      }
    for (const p of passages)
      if (rewritten.has(p.sectionId)) {
        const row = (
          await db.execute({
            sql: 'INSERT INTO chunks(source_id,section_id,ordinal,type,spans,body,heading,path,input_hash) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id',
            args: [
              p.id,
              p.sectionId,
              p.ordinal,
              p.type,
              JSON.stringify(p.spans),
              p.text,
              p.heading,
              p.path,
              p.inputHash,
            ],
          })
        ).rows[0];
        for (const token of identifierTokens(
          `${p.sectionId}\n${project.sectionById.get(p.sectionId.toLowerCase())?.filePath ?? ''}\n${p.heading}\n${p.path}\n${p.text}`,
        ))
          await db.execute({
            sql: 'INSERT INTO identifiers VALUES (?,?)',
            args: [token, row.id],
          });
      }
    await db.execute(
      'DELETE FROM embeddings WHERE hash NOT IN (SELECT input_hash FROM chunks)',
    );
    await db.execute({
      sql: 'INSERT OR REPLACE INTO meta VALUES (?,?)',
      args: ['fingerprint', fingerprint],
    });
    await db.execute({
      sql: 'INSERT OR REPLACE INTO meta VALUES (?,?)',
      args: ['project_hash', projectFingerprint(project)],
    });
    await synchronizeLexical(db);
    if (rebuildFts) await db.execute(CREATE_PASSAGE_FTS);
    await db.execute('COMMIT');
  } catch (error) {
    await db.execute('ROLLBACK');
    throw error;
  }
  return stats;
}
