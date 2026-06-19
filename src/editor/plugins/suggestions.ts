/**
 * Suggestions Plugin for Milkdown
 *
 * Converts edits into proofSuggestion marks + PROOF metadata
 * when suggestions mode is enabled.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { MarkType, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

import { marksPluginKey, getMarkMetadata, buildSuggestionMetadata, getMarks } from './marks';
import { generateMarkId, type InsertData, type Mark, type MarkRange } from '../../formats/marks';
import { getCurrentActor } from '../actor';

// Suggestion state
export interface SuggestionState {
  enabled: boolean;
}

// Plugin key for accessing state
export const suggestionsPluginKey = new PluginKey<SuggestionState>('suggestions');

// Context to store suggestion state
export const suggestionsCtx = $ctx<SuggestionState, 'suggestions'>({ enabled: false }, 'suggestions');

type SuggestionKind = 'insert' | 'delete' | 'replace';

type SliceNode = {
  type?: string;
  text?: string;
  content?: SliceNode[];
};

type InsertCoalesceState = { id: string; from: number; to: number; by: string; updatedAt: number };
type InsertCoalesceCandidate = { id: string; range: MarkRange; direction: 'append' | 'prepend' };

const lastInsertByActor = new Map<string, InsertCoalesceState>();

function markInsertedSuggestionRange(
  tr: Transaction,
  from: number,
  to: number,
  suggestionType: MarkType,
  attrs: { id: string; kind: SuggestionKind; by: string },
): void {
  // Text typed at the edge of an existing suggestion can inherit that adjacent
  // proofSuggestion mark. Scrub inherited suggestion marks first so the new
  // text belongs to exactly the intended suggestion.
  tr.removeMark(from, to, suggestionType);
  const authoredType = tr.doc.type.schema.marks.proofAuthored;
  if (authoredType) tr.removeMark(from, to, authoredType);
  tr.addMark(from, to, suggestionType.create(attrs));
}

function normalizeSuggestionKind(kind: unknown): SuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function isWhitespaceOnly(text: string): boolean {
  return /^[\s\u00A0]+$/.test(text);
}

export function getCoalescableInsertCandidateFromMarks(
  marks: Mark[],
  cached: Pick<InsertCoalesceState, 'id'> | null | undefined,
  pos: number,
  by: string,
): InsertCoalesceCandidate | null {
  if (!cached) return null;
  const isPendingInsertByActor = (mark: Mark) => {
    if (mark.kind !== 'insert' || mark.by !== by || !mark.range) return false;
    const data = mark.data as InsertData | undefined;
    return !data?.status || data.status === 'pending';
  };
  const adjacentCandidate = (mark: Mark): InsertCoalesceCandidate | null => {
    if (!isPendingInsertByActor(mark) || !mark.range) return null;
    if (mark.range.to === pos) return { id: mark.id, range: mark.range, direction: 'append' as const };
    if (mark.range.from === pos) return { id: mark.id, range: mark.range, direction: 'prepend' as const };
    return null;
  };

  const match = marks.find(mark => mark.id === cached.id && isPendingInsertByActor(mark));
  if (!match || !match.range) {
    // Under live collab latency, remote mark reapplication can briefly rebuild
    // the mark set around the cursor while the user's typing window is still
    // active. Fall back to the adjacent same-actor pending insert instead of
    // splitting every keystroke into its own suggestion.
    const fallback = marks
      .map(adjacentCandidate)
      .find((candidate): candidate is { id: string; range: MarkRange; direction: 'append' | 'prepend' } => Boolean(candidate));
    if (fallback) return fallback;
    return null;
  }

  return adjacentCandidate(match);
}

function getCoalescableInsertCandidate(
  state: EditorState,
  pos: number,
  by: string,
): InsertCoalesceCandidate | null {
  const cached = lastInsertByActor.get(by);
  if (!cached) return null;

  return getCoalescableInsertCandidateFromMarks(getMarks(state), cached, pos, by);
}

function collectSliceText(nodes?: SliceNode[]): { text: string; hasNonText: boolean } {
  let text = '';
  let hasNonText = false;

  if (!nodes) return { text, hasNonText };

  for (const node of nodes) {
    if (node.text) {
      text += node.text;
    }
    if (node.type && node.type !== 'text') {
      hasNonText = true;
    }
    if (node.content) {
      const child = collectSliceText(node.content);
      text += child.text;
      if (child.hasNonText) hasNonText = true;
    }
  }

  return { text, hasNonText };
}

function detectSuggestionKinds(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  suggestionType: MarkType
): { hasInsert: boolean; hasDelete: boolean; hasReplace: boolean } {
  const found = { hasInsert: false, hasDelete: false, hasReplace: false };

  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type !== suggestionType) continue;
      const kind = normalizeSuggestionKind(mark.attrs.kind);
      if (kind === 'insert') found.hasInsert = true;
      if (kind === 'delete') found.hasDelete = true;
      if (kind === 'replace') found.hasReplace = true;
    }
    return !(found.hasInsert && found.hasDelete && found.hasReplace);
  });

  return found;
}

/**
 * Wrap a transaction to convert edits to suggestions when enabled.
 * This intercepts the transaction and converts direct edits into tracked changes:
 * - Insertions get marked with proofSuggestion kind=insert
 * - Deletions get marked with proofSuggestion kind=delete instead of being removed
 * - Replacements become proofSuggestion kind=replace with content stored in metadata
 */
export function wrapTransactionForSuggestions(
  tr: Transaction,
  state: EditorState,
  enabled: boolean
): Transaction {
  if (!enabled || !tr.docChanged) {
    return tr;
  }
  if (tr.getMeta('y-sync$')) {
    return tr;
  }

  const suggestionType = state.schema.marks.proofSuggestion;

  if (!suggestionType) {
    console.warn('[suggestions] Missing proofSuggestion mark type');
    return tr;
  }

  // Check for structural changes (paragraph splits, etc). Pass through unchanged.
  for (const step of tr.steps) {
    const stepJson = step.toJSON() as { stepType?: string; slice?: { content?: SliceNode[] } };
    if (stepJson.stepType === 'replace' && stepJson.slice?.content) {
      const { hasNonText } = collectSliceText(stepJson.slice.content);
      if (hasNonText) {
        return tr;
      }
    }
  }

  const actor = getCurrentActor();
  let metadata = getMarkMetadata(state);
  let metadataChanged = false;

  // Build a new transaction that converts edits to tracked changes.
  const newTr = state.tr;
  let writeOffset = 0;

  for (const step of tr.steps) {
    const stepJson = step.toJSON() as {
      stepType?: string;
      from?: number;
      to?: number;
      slice?: { content?: SliceNode[] };
    };

    if (stepJson.stepType === 'replace') {
      const origFrom = stepJson.from ?? 0;
      const origTo = stepJson.to ?? 0;
      const from = origFrom + writeOffset;
      const to = origTo + writeOffset;
      const slice = stepJson.slice;

      const { text: insertedText } = collectSliceText(slice?.content);
      const deletedText = state.doc.textBetween(origFrom, origTo, '');

      const docSize = newTr.doc.content.size;
      const safeFrom = Math.max(0, Math.min(from, docSize));
      const safeTo = Math.max(safeFrom, Math.min(to, docSize));

      // CASE 1: Pure deletion (no insertion)
      if (deletedText && !insertedText) {
        lastInsertByActor.delete(actor);
        const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

        if (existing.hasDelete || existing.hasInsert) {
          // Already tracked: accept deletion or reject insertion
          newTr.delete(safeFrom, safeTo);
          writeOffset -= deletedText.length;
        } else if (existing.hasReplace) {
          // Remove replace suggestion and keep content
          newTr.removeMark(safeFrom, safeTo, suggestionType);
        } else {
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.addMark(safeFrom, safeTo, suggestionType.create({
            id: suggestionId,
            kind: 'delete',
            by: actor,
          }));

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('delete', actor, null, createdAt),
          };
          metadataChanged = true;

          // Move cursor to start of deletion (don't leave it inside deleted text)
          newTr.setSelection(TextSelection.create(newTr.doc, safeFrom));
        }
      }
      // CASE 2: Pure insertion (no deletion)
      else if (insertedText && !deletedText) {
        const now = Date.now();
        const whitespaceOnly = isWhitespaceOnly(insertedText);
        const candidate = getCoalescableInsertCandidate(state, safeFrom, actor);

        if (candidate && whitespaceOnly) {
          // Whitespace with active candidate: extend the mark to include it.
          // This keeps "Proof is" as one suggestion instead of splitting at the space.
          const existingMeta = metadata[candidate.id];
          const existingContent = typeof existingMeta?.content === 'string' ? existingMeta.content : '';
          const updatedContent = candidate.direction === 'append'
            ? `${existingContent}${insertedText}`
            : `${insertedText}${existingContent}`;

          newTr.insertText(insertedText, safeFrom);
          markInsertedSuggestionRange(
            newTr,
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType,
            { id: candidate.id, kind: 'insert', by: actor },
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [candidate.id]: {
              ...existingMeta,
              content: updatedContent,
            },
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: candidate.id,
            from: candidate.direction === 'prepend' ? candidate.range.from - insertedText.length : candidate.range.from,
            to: candidate.direction === 'prepend' ? candidate.range.to : candidate.range.to + insertedText.length,
            by: actor,
            updatedAt: now,
          });
        } else if (candidate) {
          // Non-whitespace with active candidate: coalesce into existing mark
          const existingMeta = metadata[candidate.id];
          const existingContent = typeof existingMeta?.content === 'string' ? existingMeta.content : '';
          const updatedContent = candidate.direction === 'append'
            ? `${existingContent}${insertedText}`
            : `${insertedText}${existingContent}`;

          newTr.insertText(insertedText, safeFrom);
          markInsertedSuggestionRange(
            newTr,
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType,
            { id: candidate.id, kind: 'insert', by: actor },
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [candidate.id]: {
              ...existingMeta,
              kind: 'insert',
              by: actor,
              content: updatedContent,
              status: existingMeta?.status ?? 'pending',
              createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
            },
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: candidate.id,
            from: candidate.direction === 'prepend' ? candidate.range.from - insertedText.length : candidate.range.from,
            to: candidate.direction === 'prepend' ? candidate.range.to : candidate.range.to + insertedText.length,
            by: actor,
            updatedAt: now,
          });
        } else if (whitespaceOnly) {
          // Standalone whitespace, no active candidate: create a tracked suggestion mark.
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.insertText(insertedText, safeFrom);
          markInsertedSuggestionRange(
            newTr,
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType,
            { id: suggestionId, kind: 'insert', by: actor },
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: suggestionId,
            from: safeFrom,
            to: safeFrom + insertedText.length,
            by: actor,
            updatedAt: now,
          });
        } else {
          // New non-whitespace text, no candidate: create fresh suggestion mark
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.insertText(insertedText, safeFrom);
          markInsertedSuggestionRange(
            newTr,
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType,
            { id: suggestionId, kind: 'insert', by: actor },
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: suggestionId,
            from: safeFrom,
            to: safeFrom + insertedText.length,
            by: actor,
            updatedAt: now,
          });
        }
      }
      // CASE 3: Replacement (deletion + insertion)
      else if (deletedText && insertedText) {
        lastInsertByActor.delete(actor);
        const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

        if (existing.hasDelete) {
          // Accept deletion and re-insert as an insertion suggestion.
          newTr.delete(safeFrom, safeTo);
          writeOffset -= deletedText.length;

          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();
          newTr.insertText(insertedText, safeFrom);
          markInsertedSuggestionRange(
            newTr,
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType,
            { id: suggestionId, kind: 'insert', by: actor },
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;
        } else if (existing.hasInsert) {
          // Replace inside a pending insertion - keep it as an insertion suggestion.
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.replaceWith(safeFrom, safeTo, state.schema.text(insertedText));
          markInsertedSuggestionRange(
            newTr,
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType,
            { id: suggestionId, kind: 'insert', by: actor },
          );
          writeOffset += insertedText.length - deletedText.length;

          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;
        } else {
          // Human typed replacement: keep the original text as a delete suggestion
          // and insert the replacement as normal visible green suggested text.
          const deleteSuggestionId = generateMarkId();
          const insertSuggestionId = generateMarkId();
          const createdAt = new Date().toISOString();

          newTr.removeMark(safeFrom, safeTo, suggestionType);
          newTr.addMark(safeFrom, safeTo, suggestionType.create({
            id: deleteSuggestionId,
            kind: 'delete',
            by: actor,
          }));
          newTr.insertText(insertedText, safeTo);
          markInsertedSuggestionRange(
            newTr,
            safeTo,
            safeTo + insertedText.length,
            suggestionType,
            { id: insertSuggestionId, kind: 'insert', by: actor },
          );
          writeOffset += insertedText.length;

          metadata = {
            ...metadata,
            [deleteSuggestionId]: buildSuggestionMetadata('delete', actor, null, createdAt),
            [insertSuggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: insertSuggestionId,
            from: safeTo,
            to: safeTo + insertedText.length,
            by: actor,
            updatedAt: Date.now(),
          });

          newTr.setSelection(TextSelection.create(newTr.doc, safeTo + insertedText.length));
        }
      }
      // CASE 4: Structural-only change (e.g., paragraph join/split with no text content).
      // Both deletedText and insertedText are empty — this isn't a text edit.
      // Pass through directly and adjust writeOffset for any doc size change.
      else {
        try {
          const sizeBefore = newTr.doc.content.size;
          newTr.step(step);
          writeOffset += newTr.doc.content.size - sizeBefore;
        } catch (e) {
          console.warn('[suggestions] Could not apply structural step:', e);
        }
      }
    } else if (stepJson.stepType === 'replaceAround' || stepJson.stepType === 'addMark' || stepJson.stepType === 'removeMark') {
      // Pass through structural and mark changes directly
      try {
        newTr.step(step);
      } catch (e) {
        console.warn('[suggestions] Could not apply step:', stepJson.stepType, e);
      }
    } else {
      // For other step types, try to apply them directly
      try {
        const result = step.apply(newTr.doc);
        if (result.doc && result.doc !== newTr.doc) {
          const sizeDiff = result.doc.content.size - newTr.doc.content.size;
          newTr.step(step);
          writeOffset += sizeDiff;
        }
      } catch (e) {
        console.warn('[suggestions] Could not apply step:', stepJson.stepType, e);
      }
    }
  }

  if (metadataChanged) {
    newTr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata });
  }

  // Mark this transaction so authorship tracking skips it
  newTr.setMeta('suggestions-wrapped', true);

  return newTr;
}

/**
 * Check if suggestions are enabled
 */
export function isSuggestionsEnabled(state: EditorState): boolean {
  const pluginState = suggestionsPluginKey.getState(state);
  return pluginState?.enabled ?? false;
}

/**
 * Enable suggestions
 */
export function enableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: true });
  view.dispatch(tr);
}

/**
 * Disable suggestions
 */
export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  const tr = view.state.tr.setMeta(suggestionsPluginKey, { enabled: false });
  view.dispatch(tr);
}

/**
 * Toggle suggestions
 */
export function toggleSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean {
  const enabled = isSuggestionsEnabled(view.state);
  if (enabled) {
    disableSuggestions(view);
  } else {
    enableSuggestions(view);
  }
  return !enabled;
}

/**
 * Create the suggestions plugin
 */
export const suggestionsPlugin = $prose(() => {
  return new Plugin<SuggestionState>({
    key: suggestionsPluginKey,

    state: {
      init(): SuggestionState {
        return { enabled: false };
      },

      apply(tr, value): SuggestionState {
        const meta = tr.getMeta(suggestionsPluginKey);
        if (meta !== undefined) {
          return { ...value, ...meta };
        }
        return value;
      },
    },

    appendTransaction(_trs, oldState, newState) {
      const wasEnabled = suggestionsPluginKey.getState(oldState)?.enabled ?? false;
      const isEnabled = suggestionsPluginKey.getState(newState)?.enabled ?? false;
      if (wasEnabled !== isEnabled) {
        // Emit bridge message on next microtask to avoid dispatch-in-dispatch
        queueMicrotask(() => {
          (window as any).proof?.bridge?.sendMessage('suggestionsChanged', { enabled: isEnabled });
        });
      }
      return null;
    },
  });
});

/**
 * Export all for use in editor
 */
export const suggestionsPlugins = [suggestionsCtx, suggestionsPlugin];
