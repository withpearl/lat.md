/**
 * mdast-util extension to serialize wiki-link nodes back to markdown.
 */

import type { Parents } from 'mdast';
import type { Options, State, Info } from 'mdast-util-to-markdown';
import type { WikiLink } from './types.js';

function handler(
  node: WikiLink,
  _parent: Parents | undefined,
  state: State,
  _info: Info,
): string {
  const exit = state.enter('wikiLink');
  // The tokenizer reads link text raw, with no backslash escapes, so escaping
  // here would add characters the next parse keeps, e.g. `\[companySlug]`.
  const value = node.data.alias
    ? `[[${node.value}|${node.data.alias}]]`
    : `[[${node.value}]]`;

  exit();
  return value;
}

export function wikiLinkToMarkdown(): Options {
  return {
    unsafe: [
      { character: '[', inConstruct: ['phrasing', 'label', 'reference'] },
      { character: ']', inConstruct: ['label', 'reference'] },
    ],
    handlers: {
      wikiLink: handler,
    },
  };
}
