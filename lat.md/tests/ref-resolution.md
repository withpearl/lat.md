---
lat:
  require-code-mention: true
---

# Ref Resolution

Tests for wiki link and code ref resolution across vault subdirectories — ambiguous short refs, unique short refs, and fully qualified refs.

## Ambiguous short ref in md

When two directories contain a file with the same stem (e.g. `alpha/notes.md` and `beta/notes.md`), a wiki link using just the short name `[[notes#Topic A]]` is flagged as ambiguous by `check md`.

The error lists both candidate full paths so the user can pick the right one.

## Ambiguous short ref unique section

When a section exists in only one of the duplicate-stem files (e.g. `Topic C` only in `alpha/notes.md`), a short ref `[[notes#Topic C]]` is still flagged as ambiguous because two files named `notes.md` exist.

The error message suggests the specific fix (`did you mean "[[alpha/notes#Topic C]]"?`) along with listing all matching file paths.

## Ambiguous short ref in code

When two directories contain a file with the same stem, a `@lat:` code comment using the short name (e.g. `// @lat: [[notes#Topic A]]`) is flagged as ambiguous by `check code-refs`, with an error listing both candidate full paths.

## Short ref passes check md

When a file stem is unique in the vault (e.g. only one `setup.md` exists, under `guides/`), wiki links using `[[setup#Install]]` or `[[setup.md#Install]]` pass `check md` without errors.

## Wiki links accept literal and GitHub headings

`lat check md` accepts both `[[file#Some Section!]]` and `[[file#some-section]]`, resolving both to the same canonical literal-heading section id.

## Short ref passes check code-refs

When a file stem is unique in the vault, `@lat:` code comments using `[[setup#Configure]]` or `[[setup.md#Configure]]` pass `check code-refs` without errors.

## Short ref findSections resolves

`findSections` resolves short refs like `setup#Install` and `setup.md#Install` to the full vault-relative section `guides/setup#Install` and returns the matching section.

## Short ref refs finds md references

`lat refs` for a short ref target finds wiki link references from markdown files that use the short form.

## Short ref refs finds code references

`lat refs` for a short ref target finds `@lat:` code references that use the short form.

## Full ref passes check md

A wiki link using the full vault-relative path `[[guides/setup#Install]]` passes `check md` without errors.

## Full ref passes check code-refs

A `@lat:` code comment using the full vault-relative path `[[guides/setup#Configure]]` passes `check code-refs` without errors.

## Windows-style backslash refs pass

A `@lat:` code comment whose file portion uses Windows-style backslashes resolves to the canonical POSIX section id, preserving references generated before v0.12.1.

## Full ref findSections resolves

`findSections` resolves a full vault-relative ref like `guides/setup#Install` and returns the matching section.

## Full ref refs finds md references

`lat refs` for a full ref target finds wiki link references from markdown files that use the full path form.

## Full ref refs finds code references

`lat refs` for a full ref target finds `@lat:` code references that use the full path form.

## Bare heading in md is error

A wiki link `[[Installation]]` where `Installation` is a heading (not a file) is flagged as a broken link by `check md`. Bare names resolve as file references in Obsidian convention — since no file `Installation.md` exists, it's an error.

## Local section syntax in md is error

A wiki link `[[#Configuration]]` using Obsidian local-section syntax is flagged as a broken link by `check md`. The `#`-prefixed form is not supported — use the full `[[file#Heading]]` form instead.

## Nonexistent file ref in md is error

A wiki link `[[other-file#Missing]]` where `other-file.md` does not exist is flagged as a broken link by `check md`.

## Bare heading in code is error

A `@lat:` code comment `// @lat: [[Installation]]` where `Installation` is a heading (not a file) is flagged as a dangling ref by `check code-refs`. Code refs must use `[[file#Heading]]` form.

## Valid code ref with file prefix passes

A `@lat:` code comment `// @lat: [[docs#Configuration]]` using the correct `file#Heading` form passes `check code-refs` without errors.

## Nested in-file refs pass

Wiki links using the full heading chain within the same file (e.g. `[[guide#Setup#Prerequisites]]`, `[[guide#Usage#Basic]]`) pass `check md` without errors.

## Skipped intermediate in ref is error

A wiki link `[[guide#Prerequisites]]` that skips the intermediate `Setup` section is flagged as a broken link by `check md`. The full path `[[guide#Setup#Prerequisites]]` is required.

## Wrong nesting order in ref is error

A wiki link `[[guide#Install#Setup]]` with headings in the wrong order is flagged as a broken link by `check md`.

## Nonexistent leaf in nested ref is error

A wiki link `[[guide#Setup#Missing]]` where the leaf heading does not exist is flagged as a broken link by `check md`.

## Short ref resolution scales past ten thousand refs

Ten thousand short-form refs (`tests#case N`, root heading omitted) resolve against a ten-thousand-section set in well under two seconds, proving root headings come from a per-file index rather than a scan of every id per ref.

## Folder index ref resolves in the folder's files

A ref whose file part names a directory's index file (`[[specs#Bills#Replace Bill]]` with `specs/specs.md`) and whose heading is not in the index resolves in the other files of that directory, so `check md` accepts it. Headings in the index itself still resolve there first.

## Folder index ref ambiguous across files

When more than one file in the directory holds the heading, the ref is ambiguous, and `check md` lists every matching section rather than picking one.

## Folder index ref counts as a code mention

`@lat:` comments that resolve through a directory's index count toward `require-code-mention` for leaf sections in that directory's files.

## Folder path ref resolves through its index

A ref that names the directory by its full path (`[[lat.md/specs#Invoices#Void Invoice]]`), as a ref written before a file became a folder does, resolves through the directory's index file and then its other files, in code and markdown alike.

## Folder index ref findSections resolves

`findSections` resolves a folder ref to the section in the directory's file, while a heading of the index file itself still wins.

## Folder index ref section shows the section

`lat section` on a folder ref shows the section from the file that holds it, and lists both files as suggestions when the heading is in two of them.

## Folder index ref refs finds code references

`lat refs` for a section reached through a folder ref finds the `@lat:` code comments and wiki links that use the folder form.

## Folder index ref resolution scales across shard files

Fourteen thousand folder refs spread over sixty-four files in one directory resolve in well under two seconds, because each directory's heading paths are indexed once per section set rather than per ref.

## Vault root index does not search the vault

The vault root's index file (`lat.md/lat.md`) does not count as a directory index for this fallback, so a missing heading under its stem is not looked up in every top-level file.

## Root heading index tracks a growing section set

After a first lookup, adding a new root heading and its child to the same section set makes the child resolvable through that new root — the memoized per-file root-heading index is rebuilt when the set grows.
