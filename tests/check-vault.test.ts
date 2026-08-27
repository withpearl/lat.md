import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { plainStyler, type CmdContext } from '../src/context.js';
import { checkAllCommand } from '../src/cli/check.js';

// Passthrough spies: how many times the check phases list and parse the vault.
const spies = vi.hoisted(() => ({
  listLatticeFiles: vi.fn(),
  loadAllSections: vi.fn(),
}));
vi.mock('../src/lattice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lattice.js')>();
  spies.listLatticeFiles.mockImplementation(actual.listLatticeFiles);
  spies.loadAllSections.mockImplementation(actual.loadAllSections);
  return {
    ...actual,
    listLatticeFiles: spies.listLatticeFiles,
    loadAllSections: spies.loadAllSections,
  };
});

describe('lat check shares one vault load across phases', () => {
  // @lat: [[tests/check-all#Vault is read and parsed once]]
  it('lists and parses the vault once for a whole-vault run', async () => {
    const projectRoot = join(import.meta.dirname, 'cases', 'basic-project');
    const ctx: CmdContext = {
      latDir: join(projectRoot, 'lat.md'),
      projectRoot,
      styler: plainStyler,
      mode: 'cli',
    };
    spies.listLatticeFiles.mockClear();
    spies.loadAllSections.mockClear();

    const result = await checkAllCommand(ctx);
    expect(result.output).toMatch(/\.md/); // the file stats line ran

    // Previously: md, links, code-refs and sections each listed the vault
    // (four calls) and md and code-refs each parsed it via loadAllSections.
    expect(spies.listLatticeFiles).toHaveBeenCalledTimes(1);
    expect(spies.loadAllSections).toHaveBeenCalledTimes(0);
  });
});
