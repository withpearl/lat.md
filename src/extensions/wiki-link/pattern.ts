/**
 * Regular-expression form of a wiki link for plain-text scans that do not parse
 * Markdown. Like the tokenizer in syntax.ts, it lets the link text contain
 * balanced brackets — a `[companySlug]` or `[[...slug]]` route segment in a
 * source path — nested up to two levels.
 */
const INNER = String.raw`(?:[^[\]]|\[(?:[^[\]]|\[[^[\]]*\])*\])+`;

/** Creates a fresh wiki-link regex; group 1 is the text between the markers. */
export function wikiLinkPattern(flags = ''): RegExp {
  return new RegExp(String.raw`\[\[(${INNER})\]\]`, flags);
}
