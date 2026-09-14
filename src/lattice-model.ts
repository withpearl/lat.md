import type { SearchEvidence, SearchDiagnostics } from './search/types.js';
import GithubSlugger from 'github-slugger';
import { toPosix } from './path.js';

export type Section = {
  id: string;
  heading: string;
  depth: number;
  file: string;
  filePath: string;
  children: Section[];
  startLine: number;
  endLine: number;
  firstParagraph: string;
  /** GitHub-compatible anchor generated from the rendered heading text. */
  githubSlug?: string;
};

export type Ref = {
  target: string;
  fromSection: string;
  file: string;
  line: number;
};

/** An ordinary markdown destination or an undefined reference-style link. */
export type MdLink =
  | {
      /** Destination exactly as authored, percent-escapes and all. */
      url: string;
      kind: 'link' | 'image' | 'definition';
      line: number;
    }
  | {
      /** Authored label that should have a matching definition. */
      identifier: string;
      /** Full reference syntax exactly as authored. */
      source: string;
      kind: 'linkReference' | 'imageReference';
      style: 'full' | 'collapsed' | 'shortcut' | 'definition';
      line: number;
    };

export type LatFrontmatter = {
  requireCodeMention?: boolean;
};

export function flattenSections(sections: Section[]): Section[] {
  const result: Section[] = [];
  for (const s of sections) {
    result.push(s);
    result.push(...flattenSections(s.children));
  }
  return result;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Returns the trailing segment(s) of a section id.
 * e.g. "markdown#Frontmatter#require-code-mention" → ["Frontmatter#require-code-mention", "require-code-mention"]
 * The full id itself is not included (handled by exact match).
 */
function tailSegments(id: string): string[] {
  const parts = id.split('#');
  const tails: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    tails.push(parts.slice(i).join('#'));
  }
  return tails;
}

/**
 * Build an index mapping path suffixes to their full vault-relative paths.
 * Used by resolveRef to allow short references when a suffix is unambiguous.
 *
 * For a file like `lat.md/guides/setup`, indexes both `guides/setup` and `setup`.
 * This ensures backward-compatible short refs after the vault root moved to the
 * project root (so section IDs now include the `lat.md/` prefix).
 */
export function buildFileIndex(sections: Section[]): Map<string, string[]> {
  const flat = flattenSections(sections);
  const index = new Map<string, Set<string>>();
  for (const s of flat) {
    const parts = s.file.split('/');
    // Index all trailing path suffixes (excluding the full path itself,
    // which is handled by exact match). Keys are lowercase for
    // case-insensitive lookup.
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/').toLowerCase();
      if (!index.has(suffix)) index.set(suffix, new Set());
      index.get(suffix)!.add(s.file);
    }
  }
  const result = new Map<string, string[]>();
  for (const [stem, paths] of index) {
    result.set(stem, [...paths]);
  }
  return result;
}

export type SectionSlugIndex = ReadonlyMap<string, string>;

/**
 * Map GitHub-slugged heading paths back to canonical, literal-heading ids.
 * Every path segment accepts either representation so an implicit literal h1
 * can still prefix slugged child headings during short-ref resolution.
 */
export function buildSectionSlugIndex(
  sections: Section[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const stacks = new Map<
    string,
    { depth: number; literal: string; slug: string }[]
  >();
  const sluggers = new Map<string, GithubSlugger>();

  for (const section of flattenSections(sections)) {
    let slugger = sluggers.get(section.file);
    if (!slugger) {
      slugger = new GithubSlugger();
      sluggers.set(section.file, slugger);
    }

    // Always advance the fallback slugger so manually constructed Section
    // objects without githubSlug still get correct duplicate suffixes.
    const fallbackSlug = slugger.slug(section.heading);
    const headingSlug = section.githubSlug ?? fallbackSlug;
    const stack = stacks.get(section.file) ?? [];
    while (stack.length > 0 && stack[stack.length - 1].depth >= section.depth) {
      stack.pop();
    }

    const levels = [
      ...stack,
      {
        depth: section.depth,
        literal: section.heading.toLowerCase(),
        slug: headingSlug.toLowerCase(),
      },
    ];
    let paths = [''];
    for (const level of levels) {
      const options = [...new Set([level.literal, level.slug])];
      paths = paths.flatMap((path) =>
        options.map((part) => (path ? `${path}#${part}` : part)),
      );
    }

    for (const path of paths) {
      const alias = `${section.file.toLowerCase()}#${path}`;
      if (!aliases.has(alias)) aliases.set(alias, section.id);
    }

    stack.push(levels[levels.length - 1]);
    stacks.set(section.file, stack);
  }

  return aliases;
}

export type ResolveResult = {
  resolved: string;
  ambiguous: string[] | null;
  /** When ambiguous but exactly one candidate has the section, suggest it. */
  suggested: string | null;
};

/**
 * Normalize separators only in the file portion of a section reference.
 * Headings are authored text and may legitimately contain backslashes.
 */
function normalizeRefFilePath(target: string): string {
  const hashIdx = target.indexOf('#');
  const file = toPosix(hashIdx === -1 ? target : target.slice(0, hashIdx));
  const normalizedFile = file.replace(/\.md$/i, '');
  return normalizedFile + (hashIdx === -1 ? '' : target.slice(hashIdx));
}

/**
 * Resolve a potentially short reference to its canonical full-path form.
 * If the file segment of the ref is a bare stem that uniquely maps to one
 * full path, expands it. Otherwise returns the ref unchanged.
 *
 * When ambiguous (multiple files share the stem), returns all candidates.
 * If exactly one candidate actually contains the referenced section,
 * `suggested` is set to that candidate so the caller can propose a fix.
 */
export function resolveRef(
  target: string,
  sectionIds: Set<string>,
  fileIndex: Map<string, string[]>,
  slugIndex?: SectionSlugIndex,
): ResolveResult {
  target = normalizeRefFilePath(target);

  const resolveKnown = (candidate: string): string | null => {
    // Preserve existing wiki-link meaning when a literal heading happens to
    // collide with a different heading's GitHub slug.
    if (sectionIds.has(candidate.toLowerCase())) return candidate;
    return slugIndex?.get(candidate.toLowerCase()) ?? null;
  };

  const resolveInFile = (file: string, rest: string): string | null => {
    const direct = resolveKnown(file + rest);
    if (direct) return direct;

    // Try inserting root headings between file and rest. This also works for
    // slugged child segments because the slug index contains mixed paths.
    const rootHeadings = findRootHeadings(file, sectionIds);
    for (const h1 of rootHeadings) {
      const withRoot = rest ? `${file}#${h1}${rest}` : `${file}#${h1}`;
      const resolved = resolveKnown(withRoot);
      if (resolved) return resolved;
    }
    return null;
  };

  // Already matches a known section — no resolution needed
  const direct = resolveKnown(target);
  if (direct) {
    return { resolved: direct, ambiguous: null, suggested: null };
  }

  // Extract the file segment (before first #) and try resolving it
  const hashIdx = target.indexOf('#');
  const filePart = hashIdx === -1 ? target : target.slice(0, hashIdx);
  const rest = hashIdx === -1 ? '' : target.slice(hashIdx);

  // Try resolving the file part: either it's a full path or a bare stem
  // File index keys are lowercase for case-insensitive lookup.
  const lcFilePart = filePart.toLowerCase();
  const filePaths = fileIndex.has(lcFilePart)
    ? fileIndex.get(lcFilePart)!
    : [filePart];

  if (filePaths.length === 1) {
    const fp = filePaths[0];
    const resolved = resolveInFile(fp, rest);
    if (resolved) {
      return { resolved, ambiguous: null, suggested: null };
    }
    // A ref to a directory's index file whose heading is not in the index
    // resolves in the directory's other files, so a file split into a folder
    // keeps every existing `[[name#Heading]]` working. Exactly one file must
    // hold the heading; several are ambiguous, as a shared file stem is.
    const dir = rest ? indexedDirectory(fp) : null;
    if (dir) {
      const literal = folderFilesWithPath(dir, rest, sectionIds, fileIndex);
      // GitHub-slug forms are not in the literal index; try every file only
      // when a slug index can resolve them and nothing matched literally.
      const candidates =
        literal.length || !slugIndex ? literal : filesInFolder(dir, fileIndex);
      const matches = candidates
        .map((file) => resolveInFile(file, rest))
        .filter((match): match is string => match !== null);
      if (matches.length === 1)
        return { resolved: matches[0], ambiguous: null, suggested: null };
      if (matches.length > 1)
        return { resolved: target, ambiguous: matches, suggested: null };
    }
  } else if (filePaths.length > 1) {
    // Multiple files share this stem — ambiguous at the filename level
    const all = filePaths.map((c) => c + rest);
    const valid = filePaths.filter((c) => resolveInFile(c, rest) !== null);
    return {
      resolved: target,
      ambiguous: all,
      suggested: valid.length === 1 ? valid[0] + rest : null,
    };
  }

  return { resolved: target, ambiguous: null, suggested: null };
}

/**
 * Root (h1) headings per file, derived from the section ids that have exactly
 * the pattern `file#heading` (no further # segments). Built once per id set
 * and memoized on the set itself: `resolveRef` needs this for every short-form
 * ref, and rescanning all ids per ref made resolving 11k `@lat:` refs against
 * 13k sections cost ~6 s (0.5 ms each). The size check guards a set that grew
 * after the first lookup.
 */
const rootHeadingsCache = new WeakMap<
  Set<string>,
  { size: number; byFile: Map<string, string[]> }
>();

function rootHeadingsByFile(sectionIds: Set<string>): Map<string, string[]> {
  const cached = rootHeadingsCache.get(sectionIds);
  if (cached && cached.size === sectionIds.size) return cached.byFile;
  const byFile = new Map<string, string[]>();
  for (const id of sectionIds) {
    const hashIdx = id.indexOf('#');
    if (hashIdx === -1 || id.includes('#', hashIdx + 1)) continue;
    const file = id.slice(0, hashIdx);
    const heading = id.slice(hashIdx + 1);
    const headings = byFile.get(file);
    if (headings) headings.push(heading);
    else byFile.set(file, [heading]);
  }
  rootHeadingsCache.set(sectionIds, { size: sectionIds.size, byFile });
  return byFile;
}

function findRootHeadings(file: string, sectionIds: Set<string>): string[] {
  return rootHeadingsByFile(sectionIds).get(file.toLowerCase()) ?? [];
}

/**
 * The directory a directory-index file stands for, or null. An index file
 * shares its directory's name, so `lat.md/tests/tests` stands for
 * `lat.md/tests`. The vault root's index (`lat.md/lat`) does not match, so a
 * root-level stem never searches the whole vault.
 */
export function indexedDirectory(file: string): string | null {
  const slash = file.lastIndexOf('/');
  if (slash === -1) return null;
  const dir = file.slice(0, slash);
  return dir.slice(dir.lastIndexOf('/') + 1).toLowerCase() ===
    file.slice(slash + 1).toLowerCase()
    ? dir
    : null;
}

/** Files directly inside each directory, keyed by lowercase directory path. */
const folderFilesCache = new WeakMap<
  Map<string, string[]>,
  Map<string, string[]>
>();

function filesInFolder(
  dir: string,
  fileIndex: Map<string, string[]>,
): string[] {
  let byDir = folderFilesCache.get(fileIndex);
  if (!byDir) {
    byDir = new Map();
    const files = new Set([...fileIndex.values()].flat());
    for (const file of files) {
      const slash = file.lastIndexOf('/');
      if (slash === -1 || indexedDirectory(file)) continue;
      const key = file.slice(0, slash).toLowerCase();
      byDir.set(key, [...(byDir.get(key) ?? []), file]);
    }
    folderFilesCache.set(fileIndex, byDir);
  }
  return byDir.get(dir.toLowerCase()) ?? [];
}

/**
 * For one directory, which of its files hold a literal heading path, keyed by
 * that path with and without the file's root heading (`#tests#bills#x` and
 * `#bills#x`). Memoized on the id set like root headings, so resolving every
 * `@lat:` ref of a sharded spec folder costs one pass over the ids per folder.
 */
const folderHeadingsCache = new WeakMap<
  Set<string>,
  { size: number; byDir: Map<string, Map<string, Set<string>>> }
>();

function folderFilesWithPath(
  dir: string,
  rest: string,
  sectionIds: Set<string>,
  fileIndex: Map<string, string[]>,
): string[] {
  let cached = folderHeadingsCache.get(sectionIds);
  if (!cached || cached.size !== sectionIds.size) {
    cached = { size: sectionIds.size, byDir: new Map() };
    folderHeadingsCache.set(sectionIds, cached);
  }
  const dirKey = dir.toLowerCase();
  let byPath = cached.byDir.get(dirKey);
  if (!byPath) {
    byPath = new Map();
    const files = new Map(
      filesInFolder(dir, fileIndex).map((f) => [f.toLowerCase(), f]),
    );
    const add = (path: string, file: string) => {
      const set = byPath!.get(path) ?? new Set<string>();
      set.add(file);
      byPath!.set(path, set);
    };
    for (const id of sectionIds) {
      const hashIdx = id.indexOf('#');
      const file = hashIdx === -1 ? undefined : files.get(id.slice(0, hashIdx));
      if (!file) continue;
      const withRoot = id.slice(hashIdx);
      add(withRoot, file);
      const second = withRoot.indexOf('#', 1);
      if (second !== -1) add(withRoot.slice(second), file);
    }
    cached.byDir.set(dirKey, byPath);
  }
  return [...(byPath.get(rest.toLowerCase()) ?? [])];
}

const MAX_DISTANCE_RATIO = 0.4;

export type SectionMatch = {
  section: Section;
  reason: string;
  rankScore?: number;
  semanticSimilarity?: number;
  lexicalScore?: number;
  semanticRank?: number;
  lexicalRank?: number;
  evidence?: SearchEvidence[];
  diagnostics?: SearchDiagnostics;
};

export function findSections(
  sections: Section[],
  query: string,
): SectionMatch[] {
  const flat = flattenSections(sections);
  // Leading # means "search for a heading", strip it
  const normalized = normalizeRefFilePath(
    query.startsWith('#') ? query.slice(1) : query,
  );
  const q = normalized.toLowerCase();
  const isFullPath = normalized.includes('#');
  const byId = new Map(flat.map((s) => [s.id.toLowerCase(), s]));
  const slugIndex = buildSectionSlugIndex(sections);

  const sectionFor = (candidate: string): Section | undefined => {
    const key = candidate.toLowerCase();
    return byId.get(key) ?? byId.get(slugIndex.get(key)?.toLowerCase() ?? '');
  };

  // Tier 1: exact full-id match
  const literalExact = flat.filter((s) => s.id.toLowerCase() === q);
  const slugExact =
    literalExact.length === 0 && isFullPath
      ? sectionFor(normalized)
      : undefined;
  const exact = slugExact ? [slugExact] : literalExact;
  const exactMatches: SectionMatch[] = exact.map((s) => ({
    section: s,
    reason: 'exact match',
  }));
  if (exactMatches.length > 0 && isFullPath) return exactMatches;

  // Build file index early — used by both tier 1a and 1b
  const fileIndex = buildFileIndex(sections);

  // Tier 1a: bare name matches file — return root sections of that file
  // Also checks via file index (e.g. "dev-process" → "lat.md/dev-process")
  if (!isFullPath && exactMatches.length === 0) {
    const matchFiles = new Set<string>();
    // Direct match
    for (const s of flat) {
      if (
        s.file.toLowerCase() === q &&
        !s.id.includes('#', s.file.length + 1)
      ) {
        matchFiles.add(s.file);
      }
    }
    // File index expansion (keys are lowercase)
    const indexPaths = fileIndex.get(q) ?? [];
    for (const p of indexPaths) {
      matchFiles.add(p);
    }
    if (matchFiles.size > 0) {
      const fileRoots = flat.filter(
        (s) => matchFiles.has(s.file) && !s.id.includes('#', s.file.length + 1),
      );
      if (fileRoots.length > 0) {
        return fileRoots.map((s) => ({
          section: s,
          reason: 'exact match',
        }));
      }
    }
  }

  // Tier 1b: file stem expansion
  // For bare names: "locate" → matches root section of "tests/locate.md"
  // For paths with #: "setup#Install" → expands to "guides/setup#Install"
  const stemMatches: SectionMatch[] = [];
  if (isFullPath) {
    // Expand file stem in the file part of the query
    const hashIdx = normalized.indexOf('#');
    const filePart = normalized.slice(0, hashIdx);
    const rest = normalized.slice(hashIdx);
    const stemPaths = fileIndex.get(filePart.toLowerCase()) ?? [];
    // Also try filePart as a direct file path (for root-level files not in index)
    const allPaths =
      stemPaths.length > 0 ? stemPaths : filePart ? [filePart] : [];
    for (const p of allPaths) {
      const s = sectionFor(p + rest);
      if (s) {
        if (exact.includes(s)) continue;
        stemMatches.push({
          section: s,
          reason:
            stemPaths.length > 0
              ? `file stem expanded: ${filePart} → ${p}`
              : 'exact match',
        });
        continue;
      }
      // Try inserting root headings: file#rest → file#h1#rest
      const rootsOfFile = flat.filter(
        (s) =>
          s.file.toLowerCase() === p.toLowerCase() &&
          !s.id.includes('#', s.file.length + 1),
      );
      for (const root of rootsOfFile) {
        const match = sectionFor(root.id + rest);
        if (match) {
          if (exact.includes(match)) continue;
          stemMatches.push({
            section: match,
            reason:
              stemPaths.length > 0
                ? `file stem expanded: ${filePart} → ${p}`
                : 'exact match',
          });
        }
      }
    }
    // A directory index's stem also reaches headings in that directory's
    // files, matching resolveRef, so `lat section tests#Area#Spec` works on a
    // spec file split into a folder.
    if (
      stemMatches.length === 0 &&
      allPaths.length === 1 &&
      indexedDirectory(allPaths[0])
    ) {
      const { resolved, ambiguous } = resolveRef(
        normalized,
        new Set(byId.keys()),
        fileIndex,
        slugIndex,
      );
      for (const id of ambiguous ?? [resolved]) {
        const s = sectionFor(id);
        if (s && !exact.includes(s))
          stemMatches.push({
            section: s,
            reason: `found in folder: ${filePart} → ${s.file}`,
          });
      }
    }
    if (stemMatches.length > 0) return [...exactMatches, ...stemMatches];
  } else {
    // Bare name: match root sections of files via stem index (keys lowercase)
    const paths = fileIndex.get(q) ?? [];
    for (const p of paths) {
      for (const s of flat) {
        if (exact.includes(s)) continue;
        // Root sections have id = "file#heading" (exactly 2 segments)
        if (
          s.file.toLowerCase() === p.toLowerCase() &&
          !s.id.includes('#', s.file.length + 1)
        ) {
          stemMatches.push({ section: s, reason: 'file stem match' });
        }
      }
    }
  }

  // Tier 2: exact match on trailing segments (subsection name match)
  const seen = new Set([
    ...exact.map((s) => s.id),
    ...stemMatches.map((m) => m.section.id),
  ]);
  const slugTailMatches = new Set<string>();
  if (!isFullPath) {
    for (const [alias, canonical] of slugIndex) {
      if (alias.slice(alias.lastIndexOf('#') + 1) === q) {
        slugTailMatches.add(canonical.toLowerCase());
      }
    }
  }
  const literalTailMatches = new Set(
    isFullPath
      ? []
      : flat
          .filter((s) =>
            tailSegments(s.id).some((tail) => tail.toLowerCase() === q),
          )
          .map((s) => s.id.toLowerCase()),
  );
  const subsection: SectionMatch[] = isFullPath
    ? []
    : flat
        .filter((s) => {
          if (seen.has(s.id)) return false;
          const id = s.id.toLowerCase();
          return literalTailMatches.size > 0
            ? literalTailMatches.has(id)
            : slugTailMatches.has(id);
        })
        .map((s) => ({ section: s, reason: 'section name match' }));

  // Tier 2b: subsequence match — query segments are a subsequence of section id segments
  // e.g. "Markdown#Resolution Rules" matches "markdown#Wiki Links#Resolution Rules"
  // Also tries expanding the file part via the file index for short refs.
  const seenSub = new Set([...seen, ...subsection.map((m) => m.section.id)]);
  const qParts = q.split('#');
  // Build query variants: original + file-index-expanded forms
  const qVariants: string[][] = [qParts];
  if (qParts.length >= 2) {
    const expanded = fileIndex.get(qParts[0]);
    if (expanded) {
      for (const exp of expanded) {
        qVariants.push([exp.toLowerCase(), ...qParts.slice(1)]);
      }
    }
  }
  const subsequence: SectionMatch[] =
    qParts.length >= 2
      ? flat
          .filter((s) => {
            if (seenSub.has(s.id)) return false;
            const sParts = s.id.toLowerCase().split('#');
            return qVariants.some((variant) => {
              if (sParts.length <= variant.length) return false;
              let qi = 0;
              for (const sp of sParts) {
                if (sp === variant[qi]) qi++;
                if (qi === variant.length) return true;
              }
              return false;
            });
          })
          .map((s) => {
            const skipped = s.id.split('#').length - qParts.length;
            return {
              section: s,
              reason: `path match, ${skipped} intermediate ${skipped === 1 ? 'section' : 'sections'} skipped`,
            };
          })
      : [];

  // Tier 3: fuzzy match by edit distance on each segment tail and full id
  const seenAll = new Set([
    ...seenSub,
    ...subsequence.map((m) => m.section.id),
  ]);
  const fuzzy: { section: Section; distance: number; matched: string }[] = [];

  // For full-path queries, extract the file and heading parts so we can
  // fuzzy-match only the heading portion when the file part matches exactly.
  // This prevents the shared file prefix from inflating similarity scores
  // (e.g. "cli#locat" would otherwise fuzzy-match "cli#prompt").
  const qHashIdx = normalized.indexOf('#');
  const qFile =
    qHashIdx === -1 ? null : normalized.slice(0, qHashIdx).toLowerCase();
  const qHeading =
    qHashIdx === -1 ? null : normalized.slice(qHashIdx + 1).toLowerCase();

  for (const s of flat) {
    if (seenAll.has(s.id)) continue;
    const candidates = [s.id, ...tailSegments(s.id)];
    let best = Infinity;
    let bestCandidate = '';
    for (const c of candidates) {
      let d: number;
      let maxLen: number;
      const cl = c.toLowerCase();
      const cHashIdx = cl.indexOf('#');

      // When both query and candidate have # and their file parts match,
      // compare only the heading portions to avoid file-prefix inflation
      if (qFile && qHeading && cHashIdx !== -1) {
        const cFile = cl.slice(0, cHashIdx);
        const cHeading = cl.slice(cHashIdx + 1);
        if (cFile === qFile) {
          d = levenshtein(cHeading, qHeading);
          maxLen = Math.max(cHeading.length, qHeading.length);
        } else {
          d = levenshtein(cl, q);
          maxLen = Math.max(c.length, q.length);
        }
      } else {
        d = levenshtein(cl, q);
        maxLen = Math.max(c.length, q.length);
      }

      if (maxLen > 0 && d / maxLen <= MAX_DISTANCE_RATIO && d < best) {
        best = d;
        bestCandidate = c;
      }
    }
    if (best < Infinity) {
      fuzzy.push({ section: s, distance: best, matched: bestCandidate });
    }
  }
  fuzzy.sort((a, b) => a.distance - b.distance);

  const fuzzyMatches: SectionMatch[] = fuzzy.map((f) => ({
    section: f.section,
    reason:
      f.matched.toLowerCase() === f.section.id.toLowerCase()
        ? `fuzzy match, distance ${f.distance}`
        : `fuzzy match on "${f.matched}", distance ${f.distance}`,
  }));

  // Sort results: shallower depth first, then fewer path segments
  const sortKey = (s: Section) => {
    const pathDepth = (s.file.match(/\//g) || []).length;
    return s.depth * 100 + pathDepth;
  };

  const sortedStems = [...stemMatches].sort(
    (a, b) => sortKey(a.section) - sortKey(b.section),
  );

  return [
    ...exactMatches,
    ...sortedStems,
    ...subsection,
    ...subsequence,
    ...fuzzyMatches,
  ];
}
