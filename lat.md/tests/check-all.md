---
lat:
  require-code-mention: true
---

# Check All

Tests for whole-vault check runs (`lat check` with no subcommand, and the Stop hook), as opposed to the single-phase subcommands.

## Vault is read and parsed once

`checkAllCommand` on a fixture calls `listLatticeFiles` once and `loadAllSections` never: the md, links, code-refs and sections phases all consume one shared `Vault` instead of each listing, reading and parsing the vault themselves.
