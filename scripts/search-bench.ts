/**
 * Search-index regression bench: do two builds of the vector index return the
 * same `lat search` results, and how close is each to exact nearest neighbours?
 *
 * Every index is queried through the `searchSections` / `openDb` modules of the
 * lat install that built it (so its own libSQL binary answers `vector_top_k`),
 * with query vectors embedded once up front. Ground truth is an exact full scan
 * — `vector_distance_cos` over every stored vector, no ANN index involved.
 *
 * Nothing is written to the indexes: open copies (`cp -c` on APFS) if in doubt,
 * and never point this at a live `.cache` — the sync check writes to a temp clone.
 *
 * Usage:
 *   pnpm exec tsx scripts/search-bench.ts \
 *     --queries queries.json \
 *     --index L=/scratch/L,/path/to/lat-install \
 *     --index A=/scratch/A,/path/to/lat-install \
 *     --index B=/scratch/B,/path/to/candidate-install \
 *     --truth A --baseline L --out /scratch/bench-out
 *
 *   --index NAME=ROOT[,LAT]  project root containing lat.md/.cache/vectors.db, and
 *                            the lat package root (with dist/src) that built it.
 *                            LAT defaults to this repository.
 *   --truth NAME             index whose stored vectors define exact ground truth.
 *   --baseline NAME          index every other index is compared against.
 *   --queries FILE           JSON array of strings or { id, query, area?, source? }.
 *
 * Writes results.json (every ranked list with scores), summary.json, report.md.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Query = { id: string; query: string; area?: string; source?: string };
type Hit = { id: string; score: number };
type LatModules = {
  db: any;
  search: any;
  embedder: any;
  index: any;
  lattice: any;
};
type IndexSpec = { name: string; root: string; lat: string };

const KS = [5, 10] as const;

// ── args ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const indexes: IndexSpec[] = [];
  let queries = '';
  let out = '';
  let truth = '';
  let baseline = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--index') {
      const [name, rest] = next().split(/=(.*)/s);
      const [root, lat] = rest.split(',');
      indexes.push({
        name,
        root: resolve(root),
        lat: resolve(lat ?? join(import.meta.dirname, '..')),
      });
    } else if (a === '--queries') queries = next();
    else if (a === '--out') out = next();
    else if (a === '--truth') truth = next();
    else if (a === '--baseline') baseline = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!indexes.length || !queries || !out) {
    throw new Error('Required: --index (1+), --queries, --out');
  }
  truth ||= indexes[0].name;
  baseline ||= indexes[0].name;
  return { indexes, queries, out, truth, baseline };
}

async function loadLat(latRoot: string): Promise<LatModules> {
  const mod = (p: string) =>
    import(pathToFileURL(join(latRoot, 'dist', 'src', p)).href);
  return {
    db: await mod('search/db.js'),
    search: await mod('search/search.js'),
    embedder: await mod('search/embedder.js'),
    index: await mod('search/index.js'),
    lattice: await mod('lattice.js'),
  };
}

function loadQueries(file: string): Query[] {
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as (string | Query)[];
  return raw.map((q, i) =>
    typeof q === 'string'
      ? { id: `q${String(i + 1).padStart(3, '0')}`, query: q }
      : q,
  );
}

// ── measurement ─────────────────────────────────────────────────────

/** An embedder that serves precomputed query vectors to `searchSections`. */
function replayEmbedder(
  base: { name: string; dimensions: number },
  vectors: Map<string, number[]>,
) {
  return {
    name: base.name,
    dimensions: base.dimensions,
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = vectors.get(t);
        if (!v) throw new Error(`query was not pre-embedded: ${t}`);
        return v;
      });
    },
  };
}

async function exactTopK(db: any, vec: number[], k: number): Promise<Hit[]> {
  const json = JSON.stringify(vec);
  const rows = await db.execute({
    sql: `SELECT id, 1.0 - vector_distance_cos(embedding, vector(?)) AS score
          FROM sections ORDER BY score DESC, id LIMIT ?`,
    args: [json, k],
  });
  return rows.rows.map((r: any) => ({
    id: String(r.id),
    score: Number(r.score),
  }));
}

/** Neighbour count per DiskANN node (block layout: rowid u64 LE, count u16 LE, …). */
async function degreeStats(db: any) {
  const rows = await db.execute('SELECT data FROM sections_vec_idx_shadow');
  const degrees = rows.rows.map((r: any) => {
    const buf = Buffer.from(r.data as ArrayBuffer);
    return buf.readUInt16LE(8);
  });
  degrees.sort((a: number, b: number) => a - b);
  const sum = degrees.reduce((s: number, d: number) => s + d, 0);
  return {
    nodes: degrees.length,
    blockBytes: rows.rows.length
      ? Buffer.from(rows.rows[0].data as ArrayBuffer).length
      : 0,
    min: degrees[0],
    median: degrees[Math.floor(degrees.length / 2)],
    max: degrees[degrees.length - 1],
    mean: +(sum / Math.max(1, degrees.length)).toFixed(2),
  };
}

async function spaceByObject(db: any) {
  try {
    const rows = await db.execute(
      'SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC',
    );
    return rows.rows.map((r: any) => ({
      name: String(r.name),
      bytes: Number(r.bytes),
    }));
  } catch (err) {
    return `dbstat unavailable: ${(err as Error).message}`;
  }
}

/**
 * What `lat search` would do to this index before querying: run the install's
 * own `indexSections` on a throwaway clone, with an embedder that only counts.
 */
async function syncCheck(spec: IndexSpec, lat: LatModules, dimensions: number) {
  const tmp = mkdtempSync(join(tmpdir(), 'search-bench-sync-'));
  const latDir = join(tmp, 'lat.md');
  mkdirSync(join(latDir, '.cache'), { recursive: true });
  // `cp -c` clones on APFS (instant, no extra disk); elsewhere it is a plain copy.
  const clone = (from: string, to: string) =>
    execFileSync('cp', ['-c', from, to]);
  clone(
    join(spec.root, 'lat.md', '.cache', 'vectors.db'),
    join(latDir, '.cache', 'vectors.db'),
  );
  for (const f of readdirSync(join(spec.root, 'lat.md'))) {
    if (f.endsWith('.md')) clone(join(spec.root, 'lat.md', f), join(latDir, f));
  }
  const db = lat.db.openDb(latDir);
  try {
    let wouldEmbed = 0;
    const counting = {
      name: 'count-only',
      dimensions,
      async embed(texts: string[]) {
        wouldEmbed += texts.length;
        return texts.map(() => new Array(dimensions).fill(0));
      },
    };
    const stats = await lat.index.indexSections(latDir, db, counting);
    return { ...stats, wouldEmbed };
  } finally {
    await lat.db.closeDb(db);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * recall@k against exact results, counting a hit as correct when its exact score
 * reaches the k-th true score — so equal-score sections straddling rank k (e.g.
 * duplicated text) are not reported as misses.
 */
function tieAwareRecall(ann: Hit[], truth: Hit[], k: number) {
  const kth = truth[Math.min(k, truth.length) - 1]?.score ?? -Infinity;
  const correct = ann.slice(0, k).filter((h) => h.score >= kth - 1e-6).length;
  return { correct, missed: Math.min(k, truth.length) - correct };
}

// ── comparison ──────────────────────────────────────────────────────

function compare(a: Hit[], b: Hit[], k: number) {
  const ak = a.slice(0, k).map((h) => h.id);
  const bk = b.slice(0, k).map((h) => h.id);
  const bRank = new Map(bk.map((id, i) => [id, i]));
  const common = ak.filter((id) => bRank.has(id));
  const displacement = ak.flatMap((id, i) =>
    bRank.has(id) ? [Math.abs(i - bRank.get(id)!)] : [],
  );
  return {
    overlap: common.length,
    top1: ak[0] === bk[0],
    identical: ak.length === bk.length && ak.every((id, i) => id === bk[i]),
    displacement,
  };
}

function histogram(values: number[], max: number) {
  const h = new Array(max + 1).fill(0);
  for (const v of values) h[v]++;
  return h;
}

function summarize(rows: ReturnType<typeof compare>[], k: number) {
  const n = rows.length;
  const disp = rows.flatMap((r) => r.displacement);
  const pct = (x: number) => +((100 * x) / Math.max(1, n)).toFixed(1);
  return {
    queries: n,
    top1Stable: pct(rows.filter((r) => r.top1).length),
    identicalLists: pct(rows.filter((r) => r.identical).length),
    meanOverlap: +(
      rows.reduce((s, r) => s + r.overlap, 0) /
      Math.max(1, n) /
      k
    ).toFixed(4),
    overlapHistogram: histogram(
      rows.map((r) => r.overlap),
      k,
    ),
    displacement: {
      pairs: disp.length,
      moved: disp.filter((d) => d > 0).length,
      mean: +(
        disp.reduce((s, d) => s + d, 0) / Math.max(1, disp.length)
      ).toFixed(3),
      max: disp.length ? Math.max(...disp) : 0,
      histogram: histogram(disp, k - 1),
    },
  };
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queries = loadQueries(args.queries);
  mkdirSync(args.out, { recursive: true });

  const lats = new Map<string, LatModules>();
  for (const spec of args.indexes)
    if (!lats.has(spec.lat)) lats.set(spec.lat, await loadLat(spec.lat));

  // Embed every query once, with the backend the truth index was built with.
  const truthSpec = args.indexes.find((s) => s.name === args.truth)!;
  const truthLat = lats.get(truthSpec.lat)!;
  const truthLatDir = join(truthSpec.root, 'lat.md');
  const probeDb = truthLat.db.openDb(truthLatDir);
  const storedModel = await truthLat.db.getStoredModel(probeDb);
  await truthLat.db.closeDb(probeDb);
  const embedder = await truthLat.embedder.embedderForIndex(
    storedModel,
    truthLatDir,
  );
  const texts = [...new Set(queries.map((q) => q.query))];
  const t0 = performance.now();
  const vecs: number[][] = await embedder.embed(texts);
  const vectors = new Map(texts.map((t, i) => [t, vecs[i]]));
  console.error(
    `embedded ${texts.length} queries with ${storedModel} in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );

  // Current corpus: the ids `lat search` can resolve a hit to.
  const sections = truthLat.lattice.flattenSections(
    await truthLat.lattice.loadAllSections(truthLatDir),
  );
  const corpusIds = new Set<string>(sections.map((s: any) => s.id));

  const results: Record<string, Record<string, Hit[]>> = {}; // list name -> query id -> hits
  const indexInfo: Record<string, unknown> = {};
  const storedVectors = new Map<string, Map<string, string>>(); // index -> id -> hex(embedding)

  for (const spec of args.indexes) {
    const lat = lats.get(spec.lat)!;
    const latDir = join(spec.root, 'lat.md');
    const dbFile = join(latDir, '.cache', 'vectors.db');
    const db = lat.db.openDb(latDir);
    try {
      const rows = await db.execute(
        'SELECT id, content_hash, embedding FROM sections',
      );
      const vmap = new Map<string, string>();
      for (const r of rows.rows)
        vmap.set(
          String(r.id),
          Buffer.from(r.embedding as ArrayBuffer).toString('hex'),
        );
      storedVectors.set(spec.name, vmap);
      const indexSql = await db.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'sections_vec_idx'",
      );
      const replay = replayEmbedder(embedder, vectors);
      const ann: Record<number, Record<string, Hit[]>> = { 5: {}, 10: {} };
      const exact: Record<string, Hit[]> = {};
      const annMs: number[] = [];
      for (const q of queries) {
        for (const k of KS) {
          const t = performance.now();
          const hits = await lat.search.searchSections(db, q.query, replay, k);
          annMs.push(performance.now() - t);
          ann[k][q.id] = hits.map((h: any) => ({ id: h.id, score: h.score }));
        }
        exact[q.id] = await exactTopK(db, vectors.get(q.query)!, 10);
      }
      results[spec.name] = ann[10];
      results[`${spec.name}@5`] = ann[5];
      results[`exact:${spec.name}`] = exact;
      annMs.sort((a, b) => a - b);
      const staleIds = [...vmap.keys()].filter((id) => !corpusIds.has(id));
      indexInfo[spec.name] = {
        root: spec.root,
        lat: spec.lat,
        fileBytes: statSync(dbFile).size,
        rows: rows.rows.length,
        corpusSections: corpusIds.size,
        rowsNotInCorpus: staleIds.length,
        corpusSectionsNotIndexed: [...corpusIds].filter((id) => !vmap.has(id))
          .length,
        indexDdl: indexSql.rows[0]?.sql ?? null,
        degree: await degreeStats(db),
        space: await spaceByObject(db),
        annQueryMs: {
          median: +annMs[Math.floor(annMs.length / 2)].toFixed(2),
          p95: +annMs[Math.floor(annMs.length * 0.95)].toFixed(2),
        },
      };
    } finally {
      await lat.db.closeDb(db);
    }
    indexInfo[spec.name] = {
      ...(indexInfo[spec.name] as object),
      sync: await syncCheck(spec, lat, embedder.dimensions),
    };
    console.error(`queried ${spec.name}`);
  }

  // Are the stored vectors themselves the same across indexes?
  const vectorAgreement: Record<string, unknown> = {};
  const truthVecs = storedVectors.get(args.truth)!;
  for (const spec of args.indexes) {
    if (spec.name === args.truth) continue;
    const vm = storedVectors.get(spec.name)!;
    let shared = 0;
    let identical = 0;
    for (const [id, hex] of vm) {
      const t = truthVecs.get(id);
      if (t === undefined) continue;
      shared++;
      if (t === hex) identical++;
    }
    vectorAgreement[`${spec.name} vs ${args.truth}`] = {
      shared,
      identical,
      differing: shared - identical,
    };
  }

  // Comparisons: each ANN index vs the baseline, and vs exact ground truth.
  const lists: Record<string, (q: Query, k: number) => Hit[]> = {};
  for (const spec of args.indexes) {
    lists[spec.name] = (q, k) =>
      results[`${spec.name}${k === 5 ? '@5' : ''}`][q.id];
    lists[`exact:${spec.name}`] = (q) => results[`exact:${spec.name}`][q.id];
  }
  const G = `exact:${args.truth}`;
  const pairs: [string, string][] = [];
  for (const spec of args.indexes)
    if (spec.name !== args.baseline) pairs.push([spec.name, args.baseline]);
  for (const spec of args.indexes) pairs.push([spec.name, G]);
  for (const spec of args.indexes)
    if (spec.name !== args.truth) pairs.push([spec.name, `exact:${spec.name}`]);
  for (const spec of args.indexes)
    if (spec.name !== args.truth) pairs.push([`exact:${spec.name}`, G]);

  const summary: Record<string, Record<string, unknown>> = {};
  for (const [x, y] of pairs) {
    const key = `${x} vs ${y}`;
    summary[key] = {};
    for (const k of KS) {
      summary[key][`@${k}`] = summarize(
        queries.map((q) => compare(lists[x](q, k), lists[y](q, k), k)),
        k,
      );
    }
  }

  const recall: Record<string, Record<string, unknown>> = {};
  for (const spec of args.indexes) {
    recall[spec.name] = {};
    for (const k of KS) {
      const rows = queries.map((q) =>
        tieAwareRecall(lists[spec.name](q, k), lists[G](q, k), k),
      );
      recall[spec.name][`@${k}`] = {
        recall: +(
          (100 * rows.reduce((s, r) => s + r.correct, 0)) /
          (queries.length * k)
        ).toFixed(2),
        queriesWithAMiss: rows.filter((r) => r.missed > 0).length,
      };
    }
  }

  // top-5 as the CLI asks for it vs the first five of a top-10 request.
  const prefixConsistency: Record<string, number> = {};
  for (const spec of args.indexes) {
    prefixConsistency[spec.name] = queries.filter(
      (q) =>
        compare(lists[spec.name](q, 5), lists[spec.name](q, 10), 5).identical,
    ).length;
  }

  writeFileSync(
    join(args.out, 'results.json'),
    JSON.stringify({ queries, results }, null, 1),
  );
  const summaryDoc = {
    generatedAt: new Date().toISOString(),
    storedModel,
    truth: args.truth,
    baseline: args.baseline,
    recall,
    indexInfo,
    vectorAgreement,
    prefixConsistency,
    summary,
  };
  writeFileSync(
    join(args.out, 'summary.json'),
    JSON.stringify(summaryDoc, null, 2),
  );
  writeFileSync(
    join(args.out, 'report.md'),
    renderReport(args, queries, lists, summaryDoc, G, corpusIds),
  );
  console.error(`wrote ${args.out}/{results.json,summary.json,report.md}`);
  process.exit(0);
}

// ── report ──────────────────────────────────────────────────────────

function renderReport(
  args: ReturnType<typeof parseArgs>,
  queries: Query[],
  lists: Record<string, (q: Query, k: number) => Hit[]>,
  doc: any,
  G: string,
  corpusIds: Set<string>,
): string {
  const out: string[] = [`# Search bench — ${queries.length} queries`, ''];
  out.push(
    `Ground truth: exact full scan over ${args.truth}'s stored vectors. Baseline: ${args.baseline}.`,
    '',
  );
  out.push(
    '| index | file bytes | recall@5 | queries missing a true top-5 hit | recall@10 | queries missing a true top-10 hit |',
    '|---|---|---|---|---|---|',
  );
  for (const [name, r] of Object.entries(doc.recall) as [string, any][]) {
    out.push(
      `| ${name} | ${doc.indexInfo[name].fileBytes.toLocaleString('en-US')} | ${r['@5'].recall}% | ${r['@5'].queriesWithAMiss} | ${r['@10'].recall}% | ${r['@10'].queriesWithAMiss} |`,
    );
  }
  out.push(
    '',
    'Recall is tie-aware: a hit scoring at least the k-th exact score counts as correct.',
    '',
  );
  out.push(
    '| comparison | k | #1 stable | identical | mean overlap | overlap histogram (0..k) | moved / pairs | max move |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const [key, byK] of Object.entries(doc.summary) as [string, any][]) {
    for (const k of KS) {
      const s = byK[`@${k}`];
      out.push(
        `| ${key} | ${k} | ${s.top1Stable}% | ${s.identicalLists}% | ${(s.meanOverlap * 100).toFixed(2)}% | ${s.overlapHistogram.join(' ')} | ${s.displacement.moved} / ${s.displacement.pairs} | ${s.displacement.max} |`,
      );
    }
  }
  out.push('', 'Against ground truth, mean overlap is recall@k.', '');

  // Every query whose top-10 differs from the baseline, per index, judged against truth.
  for (const spec of args.indexes) {
    if (spec.name === args.baseline) continue;
    const changed = queries.filter(
      (q) =>
        !compare(lists[spec.name](q, 10), lists[args.baseline](q, 10), 10)
          .identical,
    );
    out.push(
      `## ${spec.name} vs ${args.baseline}: ${changed.length} of ${queries.length} queries changed in top-10`,
      '',
    );
    for (const q of changed) {
      const a = lists[args.baseline](q, 10);
      const b = lists[spec.name](q, 10);
      const truth = lists[G](q, 10);
      const truthRank = new Map(truth.map((h, i) => [h.id, i + 1]));
      const recall = (hits: Hit[], k: number) =>
        hits
          .slice(0, k)
          .filter((h) => truth.slice(0, k).some((t) => t.id === h.id)).length;
      const c5 = compare(b, a, 5);
      const verdict =
        recall(b, 10) > recall(a, 10)
          ? 'better'
          : recall(b, 10) < recall(a, 10)
            ? 'worse'
            : 'equivalent';
      out.push(`### ${q.id} — ${q.query}`, '');
      out.push(
        `${q.area ? `area: ${q.area} · ` : ''}top-5 ${c5.identical ? 'unchanged' : c5.overlap === 5 ? 'reordered' : `overlap ${c5.overlap}/5`} · #1 ${c5.top1 ? 'same' : 'CHANGED'} · recall@10 vs truth: ${args.baseline} ${recall(a, 10)}/10, ${spec.name} ${recall(b, 10)}/10 → **${verdict}**`,
        '',
      );
      out.push(
        `| # | ${args.baseline} | score | truth rank | ${spec.name} | score | truth rank |`,
        '|---|---|---|---|---|---|---|',
      );
      for (let i = 0; i < 10; i++) {
        const cell = (h: Hit | undefined) =>
          h
            ? `${h.id}${corpusIds.has(h.id) ? '' : ' ⚠ not in corpus'} | ${h.score.toFixed(4)} | ${truthRank.get(h.id) ?? '>10'}`
            : '— | | ';
        out.push(`| ${i + 1} | ${cell(a[i])} | ${cell(b[i])} |`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
