import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { plainStyler, type CmdContext } from '../src/context.js';
import { getSection, buildSectionIndex } from '../src/cli/section.js';

// Passthrough spies on the two expensive whole-corpus operations behind
// `getSection`, so the tests can count them without changing behaviour.
const spies = vi.hoisted(() => ({
  loadAllSections: vi.fn(),
  scanCodeRefs: vi.fn(),
}));
vi.mock('../src/lattice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lattice.js')>();
  spies.loadAllSections.mockImplementation(actual.loadAllSections);
  return { ...actual, loadAllSections: spies.loadAllSections };
});
vi.mock('../src/code-refs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/code-refs.js')>();
  spies.scanCodeRefs.mockImplementation(actual.scanCodeRefs);
  return { ...actual, scanCodeRefs: spies.scanCodeRefs };
});

function ctx(name: string): CmdContext {
  const projectRoot = join(import.meta.dirname, 'cases', name);
  return {
    latDir: join(projectRoot, 'lat.md'),
    projectRoot,
    styler: plainStyler,
    mode: 'cli',
  };
}

describe('getSection with a shared index', () => {
  // @lat: [[tests/section#Shared index returns identical results]]
  it('returns exactly what a standalone lookup returns', async () => {
    const lookups: [string, string][] = [
      ['basic-project', 'lat.md/dev-process#Dev Process#Testing'],
      ['short-ref', 'setup#Install'],
    ];
    for (const [fixture, id] of lookups) {
      const c = ctx(fixture);
      const index = await buildSectionIndex(c);
      const shared = await getSection(c, id, index);
      expect(shared.kind).toBe('found');
      expect(shared).toEqual(await getSection(c, id));
    }
  });

  // @lat: [[tests/section#Shared index parses and scans once]]
  it('parses the vault and scans code once for any number of lookups', async () => {
    const c = ctx('basic-project');
    spies.loadAllSections.mockClear();
    spies.scanCodeRefs.mockClear();

    const index = await buildSectionIndex(c);
    const ids = index.flat.slice(0, 3).map((s) => s.id);
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect((await getSection(c, id, index)).kind).toBe('found');
    }
    expect(spies.loadAllSections).toHaveBeenCalledTimes(1);
    expect(spies.scanCodeRefs).toHaveBeenCalledTimes(1);

    // Without a shared index every lookup pays for its own parse and scan.
    spies.loadAllSections.mockClear();
    spies.scanCodeRefs.mockClear();
    for (const id of ids) await getSection(c, id);
    expect(spies.loadAllSections).toHaveBeenCalledTimes(ids.length);
    expect(spies.scanCodeRefs).toHaveBeenCalledTimes(ids.length);
  });
});
