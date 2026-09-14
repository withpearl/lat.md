import type { SourceSpan } from './types.js';
import { createHash } from 'node:crypto';
import type { Embedder } from './embedder.js';
import type {
  MarkdownBlock,
  MarkdownFileAnalysis,
} from '../markdown-analysis.js';
import type { Section } from '../lattice-model.js';

export const CHUNK_POLICY = 'owned-blocks-v1';
export type Passage = {
  id: string;
  sectionId: string;
  ordinal: number;
  type: string;
  spans: SourceSpan[];
  text: string;
  /** Embedding input; empty for a passage reused from an index, which is already embedded. */
  input: string;
  inputHash: string;
  heading: string;
  path: string;
};
export const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
export function embeddingFingerprint(embedder: Embedder): string {
  return `${CHUNK_POLICY}:${embedder.name}:${embedder.dimensions}:${embedder.maxInputTokens}:${embedder.tokenizerFingerprint}`;
}

/** Find a fitting Unicode-safe prefix without assuming token-count monotonicity. */
export function fittingPrefix(
  text: string,
  fits: (text: string) => boolean,
): number {
  if (fits(text)) return text.length;
  let size = text.length;
  while (size > 0) {
    size = Math.floor(size / 2);
    if (size && /[\uD800-\uDBFF]/.test(text[size - 1])) size--;
    if (size && fits(text.slice(0, size))) return size;
  }
  return 0;
}

/**
 * Version of the section chunk key. Bump it whenever the passages chunkFile
 * produces for the same section input can change, so stored passages keyed by
 * an older version are chunked again instead of reused.
 */
const CHUNK_KEY_VERSION = 1;

/** Identifies everything chunking reads for one section, and where it starts. */
export type SectionChunkKey = { key: string; regionStart: number };

/** A section's stored passages, in ordinal order, with the key they came from. */
export type StoredSectionPassages = SectionChunkKey & {
  passages: {
    type: string;
    spans: SourceSpan[];
    text: string;
    inputHash: string;
  }[];
};

/** Lets chunkFile reuse passages an index already stores for unchanged sections. */
export type ChunkReuse = {
  /** Filled with every section's current key, whether reused or chunked. */
  keys: Map<string, SectionChunkKey>;
  /**
   * Stored passages for a section. Only return passages whose embeddings exist:
   * reused passages carry no embedding input.
   */
  stored: (sectionId: string) => StoredSectionPassages | undefined;
};

/** Offsets relative to a section's region, so moving the section keeps its key. */
function relativeBlocks(
  blocks: readonly MarkdownBlock[],
  origin: number,
): unknown[] {
  return blocks.map((b) => [
    b.type,
    b.language ?? null,
    b.start - origin,
    b.end - origin,
    relativeBlocks(b.children, origin),
  ]);
}

/** Every body block is owned once; headings provide context instead of copied subtrees. */
export function chunkFile(
  file: MarkdownFileAnalysis,
  sections: readonly Section[],
  embedder: Embedder,
  reuse?: ChunkReuse,
): Passage[] {
  // Fitting probes count the same context and passage strings repeatedly —
  // about three times each on a large vault — and every index update re-chunks
  // the whole project, so counts are memoized for this file.
  const counts = new Map<string, number>();
  const countTokens = (text: string) => {
    let count = counts.get(text);
    if (count === undefined) {
      count = embedder.countTokens(text);
      counts.set(text, count);
    }
    return count;
  };
  const local = embedder.name.startsWith('local:');
  const target = local ? 192 : 512;
  const contextBudget = local ? 48 : 96;
  const source = file.content;
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++)
    if (source[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0,
      hi = lineStarts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return lo + 1;
  };
  const own = new Map<string, MarkdownBlock[]>();
  const ordered = [...sections].sort(
    (a, b) => a.startLine - b.startLine || a.depth - b.depth,
  );
  let sectionIndex = 0;
  let ancestors: Section[] = [];
  for (const block of file.blocks) {
    if (block.type === 'heading' || block.type === 'yaml') continue;
    while (
      sectionIndex < ordered.length &&
      ordered[sectionIndex].startLine <= block.startLine
    ) {
      const next = ordered[sectionIndex++];
      ancestors = ancestors.filter((s) => s.endLine >= next.startLine);
      ancestors.push(next);
    }
    ancestors = ancestors.filter((s) => s.endLine >= block.endLine);
    const owner = ancestors.at(-1);
    // Text before a file's first heading (a directory README's introduction)
    // belongs to no section, and results are sections, so it forms no passage.
    // An unowned block anywhere after a heading means the ranges are wrong.
    if (!owner && sectionIndex === 0) continue;
    if (!owner)
      throw new Error(`No section owns ${file.path}:${block.startLine}`);
    const blocks = own.get(owner.id) ?? [];
    blocks.push(block);
    own.set(owner.id, blocks);
  }
  const result: Passage[] = [];
  const emitted = new Set<string>();
  for (const section of sections) {
    // Two headings with the same path in one file share an id. Their blocks are
    // pooled under that id above, so the id's passages are emitted once.
    if (emitted.has(section.id)) continue;
    emitted.add(section.id);
    const headings = section.id.split('#').slice(1);
    const path = headings.slice(0, -1).join(' > ');
    const page = file.headingTitles[0] ?? file.path;
    if (reuse) {
      // The key covers every input below: the context strings, the owned text
      // from the first owned block to the last (so the gaps that decide merges),
      // the block structure, and the heading line used when nothing else fits.
      const owned = own.get(section.id) ?? [];
      const headingStart = lineStarts[section.startLine - 1] ?? 0;
      const headingEnd = source.indexOf('\n', headingStart);
      const regionStart = owned[0]?.start ?? headingStart;
      const regionEnd = owned.at(-1)?.end ?? headingStart;
      const key = digest(
        JSON.stringify([
          CHUNK_KEY_VERSION,
          section.id,
          section.heading,
          page,
          headingStart - regionStart,
          source.slice(
            headingStart,
            headingEnd < 0 ? source.length : headingEnd,
          ),
          relativeBlocks(owned, regionStart),
          source.slice(regionStart, regionEnd),
        ]),
      );
      reuse.keys.set(section.id, { key, regionStart });
      const prior = reuse.stored(section.id);
      if (prior?.key === key) {
        const delta = regionStart - prior.regionStart;
        const moved = prior.passages.map((p, ordinal) => ({
          id: `${section.id}:${ordinal}`,
          sectionId: section.id,
          ordinal,
          type: p.type,
          spans: p.spans.map((s) => ({
            start: s.start + delta,
            end: s.end + delta,
            startLine: lineAt(s.start + delta),
            endLine: lineAt(Math.max(s.start + delta, s.end + delta - 1)),
          })),
          text: p.text,
          input: '',
          inputHash: p.inputHash,
          heading: section.heading,
          path,
        }));
        // Stored rows are trusted only while they still match the source text.
        if (
          moved.every(
            (p) => source.slice(p.spans[0].start, p.spans[0].end) === p.text,
          )
        ) {
          result.push(...moved);
          continue;
        }
      }
    }
    const rawContext = `Section: ${section.heading}\nPage: ${page}\nPath: ${path}`;
    const contextLength = fittingPrefix(
      rawContext,
      (t) => countTokens(t) <= contextBudget,
    );
    const context = rawContext.slice(0, contextLength);
    let ordinal = 0;
    type Piece = { start: number; end: number; type: string; extra: string };
    const inputFor = (text: string, extra: string) => {
      const extraSize = fittingPrefix(
        extra,
        (t) => countTokens(t) <= contextBudget / 2,
      );
      const fullContext = [extra.slice(0, extraSize), context]
        .filter(Boolean)
        .join('\n');
      const n = fittingPrefix(
        fullContext,
        (c) =>
          countTokens(c) <= contextBudget &&
          countTokens(`${c}\n\n${text}`) <= embedder.maxInputTokens,
      );
      return n ? `${fullContext.slice(0, n)}\n\n${text}` : text;
    };
    const fits = (text: string, extra = '') =>
      countTokens(text) <= target &&
      countTokens(inputFor(text, extra)) <= embedder.maxInputTokens;
    const split = (block: MarkdownBlock, extra = ''): Piece[] => {
      const text = source.slice(block.start, block.end);
      if (fits(text, extra))
        return [
          { start: block.start, end: block.end, type: block.type, extra },
        ];
      if (block.children.length) {
        const pieces: Piece[] = [];
        let start = block.start;
        for (let i = 0; i < block.children.length; i++) {
          const child = block.children[i];
          const end =
            i + 1 < block.children.length
              ? block.children[i + 1].start
              : block.end;
          let label = extra;
          if (block.type === 'table')
            label = `Row: ${i}\nTable headers: ${source.slice(block.children[0].start, block.children[0].end)}\n${extra}`;
          if (block.type === 'tableRow') label = `Column: ${i + 1}\n${extra}`;
          if (block.type === 'listItem')
            label += `\nList item: ${text.split('\n')[0]}`;
          pieces.push(...split({ ...child, start, end }, label));
          start = end;
        }
        return pieces;
      }
      const pieces: Piece[] = [];
      let start = block.start;
      const label =
        block.type === 'code'
          ? `${extra}\nCode: ${block.language ?? ''}`
          : extra;
      while (start < block.end) {
        const rest = source.slice(start, block.end);
        let n = fittingPrefix(rest, (t) => fits(t, label));
        if (!n)
          throw new Error(
            `Cannot fit source text at ${file.path}:${lineAt(start)}`,
          );
        if (n < rest.length) {
          const prefix = rest.slice(0, n);
          const boundary =
            block.type === 'code'
              ? prefix.lastIndexOf('\n') + 1
              : [...prefix.matchAll(/[.!?](?:\s+|$)/g)].at(-1)?.index;
          const preferred =
            typeof boundary === 'number' && boundary > n / 2
              ? boundary
              : prefix.search(/\s+\S*$/);
          if (preferred > n / 2 && fits(rest.slice(0, preferred), label))
            n = preferred;
        }
        pieces.push({ start, end: start + n, type: block.type, extra: label });
        start += n;
      }
      return pieces;
    };
    const pieces = (own.get(section.id) ?? []).flatMap((block) => split(block));
    if (!pieces.length) {
      const start = lineStarts[section.startLine - 1] ?? 0;
      const end = source.indexOf('\n', start);
      pieces.push(
        ...split({
          type: 'heading',
          start,
          end: end < 0 ? source.length : end,
          startLine: section.startLine,
          endLine: section.startLine,
          children: [],
        }),
      );
    }
    let pending: Piece | undefined;
    const emit = (piece: Piece) => {
      const text = source.slice(piece.start, piece.end);
      if (!text.trim()) return;
      const input = inputFor(text, piece.extra);
      if (countTokens(input) > embedder.maxInputTokens)
        throw new Error('Chunk exceeds embedding limit');
      const inputHash = digest(`${embeddingFingerprint(embedder)}\0${input}`);
      result.push({
        id: `${section.id}:${ordinal}`,
        sectionId: section.id,
        ordinal: ordinal++,
        type: piece.type,
        spans: [
          {
            start: piece.start,
            end: piece.end,
            startLine: lineAt(piece.start),
            endLine: lineAt(Math.max(piece.start, piece.end - 1)),
          },
        ],
        text,
        input,
        inputHash,
        heading: section.heading,
        path,
      });
    };
    for (const piece of pieces) {
      if (
        pending &&
        !pending.extra &&
        !piece.extra &&
        !source.slice(pending.end, piece.start).trim() &&
        fits(source.slice(pending.start, piece.end))
      )
        pending = {
          ...pending,
          end: piece.end,
          type: pending.type === piece.type ? piece.type : 'mixed',
        };
      else {
        if (pending) emit(pending);
        pending = piece;
      }
    }
    if (pending) emit(pending);
  }
  return result;
}
