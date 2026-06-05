import type { MarkRange, StoredMark } from '../formats/marks';

export type ReviewRoomSuggestionKind = 'insert' | 'delete' | 'replace';

export type ReviewRoomSuggestionGroup = {
  id: string;
  ids: string[];
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
};

type PendingSuggestion = ReviewRoomSuggestionGroup & {
  range: MarkRange | null;
  charStart: number | null;
  charEnd: number | null;
  span: SpanLocation | null;
  sourceIndex: number;
};

type SuggestionDocument = {
  markdown?: string | null;
  marks?: Record<string, unknown> | null;
};

const MAX_INLINE_INSERT_GAP = 96;

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

function readAttr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = attrs.match(pattern);
  return match?.[2] ?? null;
}

function parseSuggestionSpanLocations(markdown: string): Map<string, SpanLocation> {
  const locations = new Map<string, SpanLocation>();
  const spanPattern = /<span\b([^>]*)>[\s\S]*?<\/span>/gi;
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

function hasParagraphBreak(text: string): boolean {
  return /\n\s*\n/.test(text);
}

function rangeGap(markdown: string, left: PendingSuggestion, right: PendingSuggestion): string | null {
  if (!left.range || !right.range) return null;
  if (right.range.from < left.range.to) return null;
  if (right.range.from - left.range.to > MAX_INLINE_INSERT_GAP) return null;
  if (!markdown) return '';
  return markdown.slice(left.range.to, right.range.from);
}

function charGap(markdown: string, left: PendingSuggestion, right: PendingSuggestion): string | null {
  if (left.charEnd === null || right.charStart === null) return null;
  if (right.charStart < left.charEnd) return null;
  if (right.charStart - left.charEnd > MAX_INLINE_INSERT_GAP) return null;
  if (!markdown) return '';
  return markdown.slice(left.charEnd, right.charStart);
}

function inlineMergeGap(markdown: string, left: PendingSuggestion, right: PendingSuggestion): string | null {
  const rangeText = rangeGap(markdown, left, right);
  if (rangeText !== null) return hasParagraphBreak(rangeText) ? null : rangeText;

  const charText = charGap(markdown, left, right);
  if (charText !== null) return hasParagraphBreak(charText) ? null : charText;

  const spanText = spanGap(markdown, left, right);
  if (spanText !== null) {
    if (spanText.trim().length > 0 || hasParagraphBreak(spanText)) return null;
    return spanText;
  }

  return null;
}

function areAdjacentInsertSuggestions(markdown: string, left: PendingSuggestion, right: PendingSuggestion): boolean {
  if (left.kind !== 'insert' || right.kind !== 'insert') return false;
  if (left.by !== right.by) return false;

  return inlineMergeGap(markdown, left, right) !== null;
}

function mergeInsertGroup(markdown: string, left: PendingSuggestion, right: PendingSuggestion): PendingSuggestion {
  const gap = inlineMergeGap(markdown, left, right);
  const separator = gap ?? '';
  const sameQuote = left.quote.trim() && left.quote.trim() === right.quote.trim();
  return {
    ...left,
    ids: [...left.ids, ...right.ids],
    content: `${left.content}${separator}${right.content}`,
    quote: sameQuote ? left.quote : left.quote || right.quote,
    count: left.count + right.count,
    range: left.range && right.range ? { from: left.range.from, to: right.range.to } : left.range,
    charEnd: right.charEnd ?? left.charEnd,
    span: left.span && right.span ? { ...left.span, end: right.span.end } : left.span,
  };
}

export function getReviewRoomSuggestionGroups(doc: SuggestionDocument): ReviewRoomSuggestionGroup[] {
  const marks = doc.marks ?? {};
  const markdown = typeof doc.markdown === 'string' ? doc.markdown : '';
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
    pending.push({
      id,
      ids: [id],
      kind,
      by: typeof record.by === 'string' ? record.by : 'ai:agent',
      quote: typeof record.quote === 'string' ? record.quote : '',
      content: typeof record.content === 'string' ? record.content : '',
      count: 1,
      range,
      charStart: parseCharRel(record.startRel),
      charEnd: parseCharRel(record.endRel),
      span: spanLocations.get(id) ?? null,
      sourceIndex,
    });
  });

  const groups: PendingSuggestion[] = [];
  for (const suggestion of pending.sort(comparePendingSuggestions)) {
    const previous = groups[groups.length - 1];
    if (previous && areAdjacentInsertSuggestions(markdown, previous, suggestion)) {
      groups[groups.length - 1] = mergeInsertGroup(markdown, previous, suggestion);
    } else {
      groups.push(suggestion);
    }
  }

  return groups.map(({ range: _range, charStart: _charStart, charEnd: _charEnd, span: _span, sourceIndex: _sourceIndex, ...group }) => group);
}
