import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  findLatticeDir,
  listLatticeFiles,
  parseSections,
  buildFileIndex,
  resolveRef,
} from '../src/lattice.js';
import { toPosix } from '../src/path.js';

const basicDir = join(import.meta.dirname, 'cases', 'basic-project');
const basicLat = join(basicDir, 'lat.md');

describe('findLatticeDir', () => {
  it('finds .lat in the given directory', () => {
    expect(findLatticeDir(basicDir)).toBe(basicLat);
  });

  it('returns null when no .lat exists', () => {
    expect(findLatticeDir('/')).toBeNull();
  });
});

describe('listLatticeFiles', () => {
  it('lists .md files sorted alphabetically', async () => {
    const files = await listLatticeFiles(basicLat);
    expect(files).toEqual([
      join(basicLat, 'dev-process.md'),
      join(basicLat, 'notes.md'),
    ]);
  });
});

describe('parseSections', () => {
  it('handles multiple top-level headings', () => {
    const sections = parseSections('multi.md', '# First\n\n# Second\n');
    expect(sections).toHaveLength(2);
    expect(sections[0].id).toBe('multi#First');
    expect(sections[1].id).toBe('multi#Second');
  });

  it('uses file stem without .md extension', () => {
    const sections = parseSections('/path/to/notes.md', '# Hello');
    expect(sections[0].file).toBe('notes');
  });
});

describe('toPosix', () => {
  it('converts native backslash separators to forward slashes', () => {
    expect(toPosix('codigo\\codigo.md')).toBe('codigo/codigo.md');
    expect(toPosix('lat.md\\codigo\\a')).toBe('lat.md/codigo/a');
  });

  it('leaves POSIX paths unchanged', () => {
    expect(toPosix('lat.md/codigo/a')).toBe('lat.md/codigo/a');
    expect(toPosix('notes')).toBe('notes');
    expect(toPosix('')).toBe('');
  });
});

// Regression guard for issue #69: on Windows, section file paths kept the
// native `\` separator, so bare-name (`[[a]]`) links in a directory-index file
// never resolved. Section paths are now normalized to POSIX at construction, so
// this scenario resolves identically on every OS. The windows-latest CI job
// runs this same test on the platform where the bug originally manifested.
describe('bare-name link resolution in a subdirectory (issue #69)', () => {
  const root = join('/tmp', 'proj');
  const parse = (rel: string, body: string) =>
    parseSections(join(root, 'lat.md', rel), body, root);

  it('resolves short-form links to sibling files in the same subdir', () => {
    const sections = [
      ...parse('codigo/a.md', '# A\n\nAlpha.\n'),
      ...parse('codigo/b.md', '# B\n\nBravo.\n'),
      ...parse('codigo/codigo.md', '# Codigo\n\nDirectory index.\n'),
    ];

    // The invariant the fix enforces: stored paths are POSIX on every platform.
    expect(sections.map((s) => s.file)).toContain('lat.md/codigo/a');
    expect(sections.every((s) => !s.file.includes('\\'))).toBe(true);

    const fileIndex = buildFileIndex(sections);
    const sectionIds = new Set(sections.map((s) => s.id.toLowerCase()));

    for (const name of ['a', 'b']) {
      const { resolved, ambiguous } = resolveRef(name, sectionIds, fileIndex);
      expect(ambiguous).toBeNull();
      expect(sectionIds.has(resolved.toLowerCase())).toBe(true);
    }
  });
});

// `resolveRef` resolves short-form refs (`file#Leaf`, no root heading) by
// inserting the file's root headings. Those used to be found by scanning every
// section id on every call — quadratic in corpus size, and the dominant cost of
// `lat section` / `lat check` / the prompt hook on a 13k-section corpus.
describe('short-form ref resolution against a large section set', () => {
  const makeIds = (n: number) =>
    new Set(
      Array.from({ length: n }, (_, i) => `lat.md/tests#tests#case ${i}`),
    ).add('lat.md/tests#tests');
  const fileIndex = new Map([['tests', ['lat.md/tests']]]);

  // @lat: [[ref-resolution#Short ref resolution scales past ten thousand refs]]
  it('resolves ten thousand short refs without rescanning the id set', () => {
    const n = 10_000;
    const sectionIds = makeIds(n);
    const started = performance.now();
    for (let i = 0; i < n; i++) {
      const { resolved } = resolveRef(`tests#case ${i}`, sectionIds, fileIndex);
      expect(resolved.toLowerCase()).toBe(`lat.md/tests#tests#case ${i}`);
    }
    // Indexed: a few ms. Rescanning per ref was ~0.5 ms × n on the corpus
    // that motivated this, so a generous bound still fails the old code.
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 30_000);

  // @lat: [[ref-resolution#Folder index ref resolution scales across shard files]]
  it('resolves fourteen thousand folder refs across sixty-four shard files', () => {
    const shards = 64;
    const n = 14_000;
    const sectionIds = new Set<string>(['lat.md/tests/tests#tests']);
    const files = ['lat.md/tests/tests'];
    for (let s = 0; s < shards; s++) {
      files.push(`lat.md/tests/${s}`);
      sectionIds.add(`lat.md/tests/${s}#tests`);
    }
    for (let i = 0; i < n; i++) {
      const shard = i % shards;
      sectionIds.add(`lat.md/tests/${shard}#tests#area ${i}`);
      sectionIds.add(`lat.md/tests/${shard}#tests#area ${i}#spec`);
    }
    const fileIndex = buildFileIndex(
      files.map((file) => ({
        id: `${file}#Tests`,
        file,
        filePath: `${file}.md`,
        heading: 'Tests',
        depth: 1,
        startLine: 1,
        endLine: 1,
        children: [],
        firstParagraph: '',
      })),
    );
    const started = performance.now();
    for (let i = 0; i < n; i++) {
      const { resolved, ambiguous } = resolveRef(
        `tests#area ${i}#spec`,
        sectionIds,
        fileIndex,
      );
      expect(ambiguous).toBeNull();
      expect(resolved.toLowerCase()).toBe(
        `lat.md/tests/${i % shards}#tests#area ${i}#spec`,
      );
    }
    // The folder's heading index is built once for the id set: a few hundred
    // ms. Rebuilding it per ref took over two minutes here.
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 30_000);

  // @lat: [[ref-resolution#Vault root index does not search the vault]]
  it('does not resolve a missing heading of the vault root index in other files', () => {
    const sectionIds = new Set([
      'lat.md/lat#lat',
      'lat.md/guide#guide',
      'lat.md/guide#guide#install',
    ]);
    const index = new Map([
      ['lat', ['lat.md/lat']],
      ['guide', ['lat.md/guide']],
    ]);
    expect(resolveRef('lat#install', sectionIds, index).resolved).toBe(
      'lat#install',
    );
  });

  // @lat: [[ref-resolution#Root heading index tracks a growing section set]]
  it('picks up a root heading added after the first lookup', () => {
    const sectionIds = new Set(['lat.md/a#a', 'lat.md/a#a#child']);
    const index = new Map([['a', ['lat.md/a']]]);
    expect(resolveRef('a#child', sectionIds, index).resolved).toBe(
      'lat.md/a#a#child',
    );
    sectionIds.add('lat.md/a#b').add('lat.md/a#b#other');
    expect(resolveRef('a#other', sectionIds, index).resolved).toBe(
      'lat.md/a#b#other',
    );
  });
});
