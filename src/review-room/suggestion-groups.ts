import type { MarkRange, StoredMark } from '../formats/marks';

export type ReviewRoomSuggestionKind = 'insert' | 'delete' | 'replace';

export type ReviewRoomSuggestionGroup = {
  id: string;
  ids: string[];
  contentById: Record<string, string>;
  kind: ReviewRoomSuggestionKind;
  by: string;
  quote: string;
  content: string;
  count: number;
};

type SpanLocation = {
  order: number;
  start: number;
  end: number;
  text: string;
};

type PendingSuggestion = ReviewRoomSuggestionGroup & {
  range: MarkRange | null;
  charStart: number | null;
  charEnd: number | null;
  createdAtMs: number | null;
  span: SpanLocation | null;
  sourceIndex: number;
};

const INSERT_GROUP_CREATED_AT_WINDOW_MS = 2_000;

type SuggestionDocument = {
  markdown?: string | null;
  marks?: Record<string, unknown> | null;
};

function normalizeSuggestionKind(raw: Record<string, unknown>): ReviewRoomSuggestionKind | null {
  const rawKind = typeof raw.kind === 'string' ? raw.kind : '';
  const kind = rawKind === 'suggestion' && typeof raw.suggestionKind === 'string'
    ? raw.suggestionKind
    : rawKind;
  return kind === 'insert' || kind === 'delete' || kind === 'replace' ? kind : null;
}

function parseCharRel(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^char:(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseRange(value: unknown): MarkRange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const range = value as Record<string, unknown>;
  if (
    typeof range.from !== 'number'
    || typeof range.to !== 'number'
    || !Number.isFinite(range.from)
    || !Number.isFinite(range.to)
  ) {
    return null;
  }
  return { from: range.from, to: range.to };
}

function parseCreatedAtMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readAttr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = attrs.match(pattern);
  return match?.[2] ?? null;
}

function decodeHtmlText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function spanText(html: string): string {
  return decodeHtmlText(html.replace(/<[^>]*>/g, ''));
}

function visibleMarkdownText(markdown: string): string {
  return decodeHtmlText(markdown)
    .replace(/<span\b[^>]*data-proof=["']suggestion["'][^>]*>([\s\S]*?)<\/span>/gi, (_match, inner: string) => spanText(inner))
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n');
}

function charSlice(text: string, start: number | null, end: number | null): string | null {
  if (start === null || end === null || end < start) return null;
  if (start < 0 || end > text.length) return null;
  return text.slice(start, end);
}

function parseSuggestionSpanLocations(markdown: string): Map<string, SpanLocation> {
  const locations = new Map<string, SpanLocation>();
  const spanPattern = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let match: RegExpExecArray | null;
  let order = 0;

  while ((match = spanPattern.exec(markdown)) !== null) {
    const attrs = match[1] ?? '';
    if (readAttr(attrs, 'data-proof') !== 'suggestion') continue;
    const id = readAttr(attrs, 'data-id');
    if (!id || locations.has(id)) continue;
    locations.set(id, {
      order,
      start: match.index,
      end: match.index + match[0].length,
      text: spanText(match[2] ?? ''),
    });
    order += 1;
  }

  return locations;
}

function sortValue(item: PendingSuggestion): number {
  if (item.range) return item.range.from;
  if (item.charStart !== null) return item.charStart;
  if (item.span) return item.span.start;
  return Number.MAX_SAFE_INTEGER;
}

function comparePendingSuggestions(a: PendingSuggestion, b: PendingSuggestion): number {
  const byPosition = sortValue(a) - sortValue(b);
  if (byPosition !== 0) return byPosition;
  const bySpan = (a.span?.order ?? Number.MAX_SAFE_INTEGER) - (b.span?.order ?? Number.MAX_SAFE_INTEGER);
  if (bySpan !== 0) return bySpan;
  return a.sourceIndex - b.sourceIndex;
}

function spanGap(markdown: string, left: PendingSuggestion, right: PendingSuggestion): string | null {
  if (!left.span || !right.span) return null;
  if (right.span.start < left.span.end) return null;
  return markdown.slice(left.span.end, right.span.start);
}

function hasHardReturn(text: string): boolean {
  return /[\r\n]/.test(text);
}

function isWordBoundaryMerge(left: PendingSuggestion, right: PendingSuggestion, gap: string): boolean {
  if (gap.length > 0) return false;
  if (!/[A-Za-z0-9]$/.test(left.content) || !/^[A-Za-z0-9]/.test(right.content)) return false;
  return /\s/.test(left.content.trim()) || /\s/.test(right.content.trim());
}

function rangeFallbackGap(left: PendingSuggestion, right: PendingSuggestion): string | null {
  if (!left.range || !right.range) return null;
  if (right.range.from < left.range.to) return null;
  if (right.range.from - left.range.to > 1) return null;
  return '';
}

function charFallbackGap(visibleText: string, left: PendingSuggestion, right: PendingSuggestion): string | null {
  if (left.charEnd === null || right.charStart === null) return null;
  if (right.charStart < left.charEnd) return null;
  const gap = visibleText.slice(left.charEnd, right.charStart);
  if (gap.trim().length > 0 || hasHardReturn(gap)) return null;
  return gap;
}

function inlineMergeGap(markdown: string, visibleText: string, left: PendingSuggestion, right: PendingSuggestion): string | null {
  const spanText = spanGap(markdown, left, right);
  if (spanText !== null) {
    if (spanText.trim().length > 0 || hasHardReturn(spanText)) return null;
    if (isWordBoundaryMerge(left, right, spanText)) return null;
    return spanText;
  }

  const charGap = charFallbackGap(visibleText, left, right);
  if (charGap !== null) {
    if (isWordBoundaryMerge(left, right, charGap)) return null;
    return charGap;
  }
  const rangeGap = rangeFallbackGap(left, right);
  if (rangeGap !== null && isWordBoundaryMerge(left, right, rangeGap)) return null;
  return rangeGap;
}

function areAdjacentInsertSuggestions(markdown: string, visibleText: string, left: PendingSuggestion, right: PendingSuggestion): boolean {
  if (left.kind !== 'insert' || right.kind !== 'insert') return false;
  if (left.by !== right.by) return false;
  if (
    left.createdAtMs !== null
    && right.createdAtMs !== null
    && Math.abs(right.createdAtMs - left.createdAtMs) > INSERT_GROUP_CREATED_AT_WINDOW_MS
  ) {
    return false;
  }

  return inlineMergeGap(markdown, visibleText, left, right) !== null;
}

function mergeInsertGroup(markdown: string, visibleText: string, left: PendingSuggestion, right: PendingSuggestion): PendingSuggestion {
  const gap = inlineMergeGap(markdown, visibleText, left, right);
  const separator = gap ?? '';
  const sameQuote = left.quote.trim() && left.quote.trim() === right.quote.trim();
  const rightContent = right.content;
  const nextCharEnd = right.charEnd ?? left.charEnd;
  const mergedCharText = charSlice(visibleText, left.charStart, nextCharEnd);
  return {
    ...left,
    ids: [...left.ids, ...right.ids],
    contentById: { ...left.contentById, ...right.contentById },
    content: mergedCharText ?? `${left.content}${separator}${rightContent}`,
    quote: sameQuote ? left.quote : left.quote || right.quote,
    count: left.count + right.count,
    range: left.range && right.range ? { from: left.range.from, to: right.range.to } : left.range,
    charEnd: nextCharEnd,
    createdAtMs: right.createdAtMs ?? left.createdAtMs,
    span: left.span && right.span ? { ...left.span, end: right.span.end } : left.span,
  };
}

export function getReviewRoomSuggestionGroups(doc: SuggestionDocument): ReviewRoomSuggestionGroup[] {
  const marks = doc.marks ?? {};
  const markdown = typeof doc.markdown === 'string' ? doc.markdown : '';
  const visibleText = visibleMarkdownText(markdown);
  const spanLocations = parseSuggestionSpanLocations(markdown);
  const pending: PendingSuggestion[] = [];

  Object.entries(marks).forEach(([id, raw], sourceIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const mark = raw as StoredMark & { suggestionKind?: unknown };
    const record = mark as Record<string, unknown>;
    const kind = normalizeSuggestionKind(record);
    const status = typeof record.status === 'string' ? record.status : 'pending';
    if (!kind || status === 'accepted' || status === 'rejected') return;

    const range = parseRange(record.range);
    const charStart = parseCharRel(record.startRel);
    const charEnd = parseCharRel(record.endRel);
    const createdAtMs = parseCreatedAtMs(record.createdAt);
    const contentFromChars = charSlice(visibleText, charStart, charEnd);
    const storedContent = typeof record.content === 'string' ? record.content : '';
    const content = contentFromChars ?? spanLocations.get(id)?.text ?? storedContent;
    pending.push({
      id,
      ids: [id],
      contentById: { [id]: content || storedContent },
      kind,
      by: typeof record.by === 'string' ? record.by : 'ai:agent',
      quote: typeof record.quote === 'string' ? record.quote : '',
      content,
      count: 1,
      range,
      charStart,
      charEnd,
      createdAtMs,
      span: spanLocations.get(id) ?? null,
      sourceIndex,
    });
  });

  const groups: PendingSuggestion[] = [];
  for (const suggestion of pending.sort(comparePendingSuggestions)) {
    const previous = groups[groups.length - 1];
    if (previous && areAdjacentInsertSuggestions(markdown, visibleText, previous, suggestion)) {
      groups[groups.length - 1] = mergeInsertGroup(markdown, visibleText, previous, suggestion);
    } else {
      groups.push(suggestion);
    }
  }

  return groups.map(({
    range: _range,
    charStart: _charStart,
    charEnd: _charEnd,
    createdAtMs: _createdAtMs,
    span: _span,
    sourceIndex: _sourceIndex,
    ...group
  }) => group);
}
