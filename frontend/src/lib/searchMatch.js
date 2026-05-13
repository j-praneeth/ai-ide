/**
 * Shared search match rules (Search panel + editor jump-to-match).
 */

export function buildMatchRegex(query, { caseSensitive, wholeWord, useRegex }) {
  const q = (query || '').trim();
  if (!q) return null;
  try {
    if (useRegex) {
      return new RegExp(q, caseSensitive ? 'g' : 'gi');
    }
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = wholeWord ? `\\b(?:${escaped})\\b` : escaped;
    return new RegExp(body, caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/** First match in a single line; columns are 1-based for Monaco. */
export function firstMatchColumnsInLine(lineText, regex) {
  if (!regex) return null;
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const r = new RegExp(regex.source, flags);
  const m = r.exec(lineText == null ? '' : String(lineText));
  if (!m || m[0].length === 0) return null;
  return { startColumn: m.index + 1, endColumn: m.index + m[0].length + 1 };
}
