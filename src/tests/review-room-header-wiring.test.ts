import { readFileSync } from 'fs';
import path from 'path';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';

import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const root = process.cwd();
const indexHtml = readFileSync(path.join(root, 'src/index.html'), 'utf8');
const editorSource = readFileSync(path.join(root, 'src/editor/index.ts'), 'utf8');
const reviewPanelSource = readFileSync(path.join(root, 'src/review-room/review-panel.ts'), 'utf8');
const reviewItemsSource = readFileSync(path.join(root, 'src/review-room/review-items.ts'), 'utf8');
const reviewTokensSource = readFileSync(path.join(root, 'src/review-room/tokens.ts'), 'utf8');
const shareClientSource = readFileSync(path.join(root, 'src/bridge/share-client.ts'), 'utf8');
const suggestionsSource = readFileSync(path.join(root, 'src/editor/plugins/suggestions.ts'), 'utf8');
const markPopoverSource = readFileSync(path.join(root, 'src/editor/plugins/mark-popover.ts'), 'utf8');
const selectionBarSource = readFileSync(path.join(root, 'src/editor/plugins/mark-selection-bar.ts'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
  redirects?: Array<{ source?: string; destination?: string; permanent?: boolean }>;
};

assert(indexHtml.includes('id="review-room-title-slot"'), 'Expected Review Room header to expose a title slot');
assert(indexHtml.includes('id="review-room-status-slot"'), 'Expected Review Room header to expose a sync status slot');
assert(indexHtml.includes('id="review-room-review-slot"'), 'Expected Review Room header to expose a review sidebar slot');
assert(indexHtml.includes('id="review-room-agent-slot"'), 'Expected Review Room header to expose an agent control slot');
assert(indexHtml.includes('id="review-room-format-slot"'), 'Expected Review Room header to expose a formatting toolbar slot');
assert(indexHtml.includes('id="review-room-save-slot"'), 'Expected Review Room header to expose a save slot');
assert(indexHtml.includes('id="review-room-share-slot"'), 'Expected Review Room header to expose a share control slot');
assert(indexHtml.includes('class="review-room-controls"'), 'Expected Review Room header to group controls below the title row');
assert(
  indexHtml.indexOf('id="review-room-title-slot"') < indexHtml.indexOf('class="review-room-controls"'),
  'Expected Review Room document title slot to render before the control row',
);

assert(
  editorSource.includes("const reviewRoomBar = document.getElementById('review-room-bar');"),
  'Expected Review Room mode to target the Review Room header bar',
);
assert(
  editorSource.includes("titleSlot.replaceChildren(title);")
    && editorSource.includes("statusSlot.replaceChildren(syncStatusInline);")
    && editorSource.includes("reviewSlot.replaceChildren(this.createReviewRoomReviewButton());")
    && editorSource.includes("agentSlotContainer.replaceChildren(agentSlot);")
    && editorSource.includes("formatSlot.replaceChildren(this.createReviewRoomFormattingToolbar());")
    && editorSource.includes("saveSlot.replaceChildren(this.createReviewRoomSaveControls());")
    && editorSource.includes("shareSlot.replaceChildren(shareBtn);"),
  'Expected existing share controls to be mounted into Review Room header slots',
);
assert(
  reviewPanelSource.includes("REVIEW_PANEL_ID = 'review-room-review-sidebar'")
    && editorSource.includes("button.setAttribute('aria-controls', 'review-room-review-sidebar');")
    && editorSource.includes("button.setAttribute('aria-expanded', 'false');")
    && editorSource.includes('void this.openReviewRoomReviewPanel({ useSelection: true });')
    && reviewPanelSource.includes('Review selected text')
    && editorSource.includes('this.addReviewRoomSelectionComment(selection, text)')
    && reviewPanelSource.includes('host.addSelectionComment(activeSelection, textarea.value)')
    && reviewPanelSource.includes("top:calc(var(--review-room-bar-height, 64px) + 8px);right:8px;bottom:8px;")
    && reviewPanelSource.includes('width:min(440px, calc(100dvw - 16px));max-width:calc(100vw - 16px);')
    && reviewPanelSource.includes('flex:1 1 auto;min-width:0;')
    && !reviewPanelSource.includes('background:rgba(31,41,51,0.46);'),
  'Expected Review Room review items to open as a docked sidebar that can use selected text',
);
assert(
  editorSource.includes('openReviewRoomReviewSidebar(options: ReviewRoomReviewPanelOptions = {})')
    && editorSource.includes('this.markReply(commentId, getCurrentActor(), text)')
    && editorSource.includes('this.markResolve(commentId)')
    && editorSource.includes('this.markDeleteThread(commentId)')
    && reviewPanelSource.includes("let commentFilter: ReviewCommentFilter = 'open';")
    && reviewPanelSource.includes('renderCommentFilterControls')
    && reviewPanelSource.includes('attachReviewItemFocus(item, comment.id)')
    && reviewPanelSource.includes("if (target instanceof HTMLElement && target.closest('button, textarea, input, a')) return;")
    && reviewPanelSource.includes('activateReviewItem(markId)')
    && reviewPanelSource.includes('Comments (${visibleComments.length})')
    && reviewPanelSource.includes('No resolved comment threads.')
    && reviewPanelSource.includes('Review items could not load')
    && editorSource.includes('shareClient.fetchReviewRoomHistory({ limit })')
    && reviewPanelSource.includes('host.fetchHistory(100)')
    && reviewPanelSource.includes('renderAuditInbox(historyEvents)')
    && reviewPanelSource.includes('Mark reviewed')
    && reviewPanelSource.includes('renderHistoryEvents(historyEvents)')
    && reviewItemsSource.includes('Accepted replacement')
    && reviewPanelSource.includes('renderHistoryEventRow(event)')
    && reviewPanelSource.includes('Show details')
    && reviewPanelSource.includes('changeKindLabel(rowView.changeKind)')
    && markPopoverSource.includes('proof?.isReviewRoomRuntime?.()')
    && markPopoverSource.includes('proof.openReviewRoomReviewSidebar({ focusMarkId: markId })'),
  'Expected Review Room comment threads and accepted suggestion history to open inside the Review sidebar',
);
assert(
  reviewTokensSource.includes('--rr-accent: #266854;')
    && reviewPanelSource.includes('ensureReviewRoomTokens();')
    && reviewPanelSource.includes('var(--rr-accent)')
    && reviewPanelSource.includes("tabBar.setAttribute('role', 'tablist');")
    && reviewPanelSource.includes("{ value: 'audit', label: `Audit ${counts.audit}` }")
    && reviewPanelSource.includes("{ value: 'tasks', label: `Tasks ${counts.tasks}` }")
    && reviewPanelSource.includes("{ value: 'publish', label: 'Publish' }")
    && reviewPanelSource.includes('Realtime sync unavailable on this host'),
  'Expected the extracted Review Room cockpit to use CJB tokens, tabs, and a realtime availability note',
);
assert(
  shareClientSource.includes('async fetchReviewRoomHistory(')
    && shareClientSource.includes('/review-room/api/documents/${encodeURIComponent(this.slug)}/history?${params.toString()}')
    && shareClientSource.includes('ReviewRoomHistoryEvent')
    && shareClientSource.includes('before: event.before')
    && shareClientSource.includes('after: event.after')
    && shareClientSource.includes('async fetchReviewRoomTasks(')
    && shareClientSource.includes('/review-room/api/documents/${encodeURIComponent(this.slug)}/tasks?status=${encodeURIComponent(status)}')
    && shareClientSource.includes('async updateReviewRoomTaskStatus(')
    && shareClientSource.includes('async markReviewRoomAuditEventReviewed(')
    && shareClientSource.includes('/review-room/api/documents/${encodeURIComponent(this.slug)}/audit/${encodeURIComponent(eventId)}/reviewed')
    && editorSource.includes('shareClient.fetchReviewRoomTasks({ status: \'all\' })')
    && editorSource.includes('shareClient.updateReviewRoomTaskStatus(taskId, status)')
    && editorSource.includes('filterOpenReviewAuditEvents(history.events)')
    && editorSource.includes('1 direct change to review')
    && reviewPanelSource.includes('renderTasks(tasks)')
    && reviewPanelSource.includes("host.updateTaskStatus(task.id, 'completed')")
    && reviewPanelSource.includes("host.updateTaskStatus(task.id, 'dismissed')")
    && shareClientSource.includes('async fetchReviewRoomBaselines(')
    && shareClientSource.includes('/review-room/api/documents/${encodeURIComponent(this.slug)}/baselines?limit=${limit}')
    && shareClientSource.includes('async createReviewRoomBaseline(')
    && editorSource.includes('shareClient.fetchReviewRoomBaselines({ limit: 10 })')
    && editorSource.includes('shareClient.createReviewRoomBaseline({ note })')
    && reviewPanelSource.includes('renderPublish(baselines, historyEvents)')
    && reviewPanelSource.includes('Changes since baseline')
    && reviewItemsSource.includes('Created baseline'),
  'Expected share client and sidebar host to expose typed Review Room history, task, and baseline loading/actions',
);
assert(
  shareClientSource.includes('ReviewRoomDocumentMember')
    && shareClientSource.includes('async fetchReviewRoomMembers(')
    && shareClientSource.includes('/review-room/api/documents/${encodeURIComponent(this.slug)}/members')
    && shareClientSource.includes('async upsertReviewRoomMember(')
    && editorSource.includes('private openReviewRoomMembersModal()')
    && editorSource.includes('Manage collaborators')
    && editorSource.includes('View collaborators')
    && editorSource.includes('shareClient.fetchReviewRoomMembers()')
    && editorSource.includes('shareClient.upsertReviewRoomMember({')
    && editorSource.includes('this.reviewRoomCanManageMembers = reviewRoomRole === \'owner\';')
    && editorSource.includes('this.collabCanEdit || this.isReviewRoomRuntime()')
    && reviewPanelSource.includes('canCreateBaseline(): boolean;')
    && reviewPanelSource.includes('canUpdateTasks(): boolean;')
    && reviewPanelSource.includes('Only editors and owners can create baselines.')
    && reviewPanelSource.includes('Comment access is required to update tasks.'),
  'Expected Review Room member management UI and role-gated cockpit actions',
);
assert(
  editorSource.includes('private createReviewRoomSaveButton()')
    && editorSource.includes('private createReviewRoomCancelButton()')
    && editorSource.includes("window.location.href = '/review-room';"),
  'Expected Review Room save/cancel controls to return to the document list',
);
assert(
  editorSource.includes('private readonly reviewRoomAutosaveDelayMs: number = 5_000;')
    && editorSource.includes('this.scheduleReviewRoomAutosave();')
    && editorSource.includes('this.shouldWarnAboutUnsavedReviewRoomChanges()'),
  'Expected Review Room manual-save mode to autosave and warn only for unsaved changes',
);
assert(
  editorSource.includes('private createReviewRoomFormattingToolbar()')
    && editorSource.includes('private createReviewRoomSuggestingToggle()')
    && editorSource.includes("button.setAttribute('role', 'switch');")
    && editorSource.includes("button.setAttribute('aria-label', 'Suggesting mode');")
    && editorSource.includes('this.toggleSuggestions();')
    && editorSource.includes('this.updateReviewRoomSuggestingToggle();')
    && editorSource.includes("action: 'bold'")
    && editorSource.includes("action: 'italic'")
    && editorSource.includes("action: 'heading1'")
    && editorSource.includes("action: 'bulletList'"),
  'Expected Review Room editor to expose a compact Markdown formatting toolbar with a Suggesting toggle',
);
assert(
  editorSource.includes("addItem('Download Markdown', async () => this.downloadCurrentDocument('markdown')")
    && editorSource.includes("addItem('Download Text', async () => this.downloadCurrentDocument('text')")
    && editorSource.includes('private getCurrentExportMarkdown()')
    && editorSource.includes('stripProofSpanTags(serialized)')
    && editorSource.includes('private downloadCurrentDocument(format:'),
  'Expected Review Room Share menu to export Markdown and Text without internal Proof spans',
);
assert(
  editorSource.includes('Copy agent prompt')
    && editorSource.includes('Download Claude/Cowork plugin')
    && editorSource.includes('MCP URL:')
    && editorSource.includes('review_room_get_state')
    && editorSource.includes('review_room_add_suggestion')
    && editorSource.includes('review_room_resolve_comment')
    && editorSource.includes('/review-room/claude-plugin.zip')
    && editorSource.includes('/documents/${encodedSlug}/events/pending?after=0'),
  'Expected Add agent to expose a Review Room MCP-first prompt modal',
);
assert(
  editorSource.includes('this.reviewRoomRestSaveMode || (baseAllowLocalEdits && hydrated)'),
  'Expected hosted Review Room mode to allow local edits for manual save',
);
assert(
  editorSource.includes('const localMetadata = getMarkMetadataWithQuotes(view.state);')
    && editorSource.includes('mergePendingServerMarks(\n      localMetadata,\n      this.lastReceivedServerMarks,'),
  'Expected Review Room mark sync to push quote/range-enriched metadata instead of raw plugin metadata',
);
assert(
  editorSource.includes('if (this.isShareMode && !this.reviewRoomRestSaveMode) {\n      this.flushShareMarks();\n    }'),
  'Expected Review Room manual-save mode to avoid marks-only REST pushes before suggested text is saved',
);
assert(
  editorSource.includes('private pendingCollabMarksMetadata: Record<string, StoredMark> | null = null;')
    && editorSource.includes('private flushPendingCollabMarksMetadata(): void')
    && editorSource.includes('this.collabUnsyncedChanges > 0 || this.collabPendingLocalUpdates > 0')
    && editorSource.includes('this.pendingCollabMarksMetadata = metadata;')
    && editorSource.includes('collabClient.setMarksMetadata(this.pendingCollabMarksMetadata);'),
  'Expected live collab mark sync to wait until local content updates are synced',
);
assert(
  suggestionsSource.includes('Human typed replacement: keep the original text as a delete suggestion')
    && suggestionsSource.includes('const deleteSuggestionId = generateMarkId();')
    && suggestionsSource.includes('const insertSuggestionId = generateMarkId();')
    && suggestionsSource.includes("kind: 'delete',")
    && suggestionsSource.includes('newTr.insertText(insertedText, safeTo);')
    && suggestionsSource.includes("suggestionType.create({ id: insertSuggestionId, kind: 'insert', by: actor })")
    && suggestionsSource.includes("buildSuggestionMetadata('insert', actor, insertedText, createdAt)"),
  'Expected typed replacement suggestions to render as visible red delete plus green insert text',
);
assert(
  editorSource.includes("if (this.isReviewRoomRuntime()) {\n      const reviewRoomBar = document.getElementById('review-room-bar');"),
  'Expected Review Room mode to avoid creating the floating share banner',
);
assert(
  editorSource.includes("banner.id = 'share-banner';"),
  'Expected generic shared document mode to keep the floating share banner',
);
assert(
  editorSource.includes("return document.getElementById('share-banner');"),
  'Expected non-Review Room share chrome lookups to keep using the floating share banner',
);
assert(
  editorSource.includes("document.title = `${nextTitle} - Review Room`;"),
  'Expected documents to use Review Room in the browser title',
);
assert(
  editorSource.includes('if (reviewRoomRestSaveMode) {\n          this.clearErrorBanner();')
    && editorSource.includes("this.showErrorBanner('Live collaboration is currently unavailable for this shared document.');"),
  'Expected editable Review Room hosted no-collab mode to avoid the generic live collaboration error banner',
);
assert(
  markPopoverSource.includes("'review-room-bar', 'share-banner'")
    && selectionBarSource.includes("'review-room-bar', 'share-banner'"),
  'Expected fixed comment overlays to account for the Review Room header before the share banner',
);
assert(
  vercelConfig.redirects?.some((redirect) => (
    redirect.source === '/'
    && redirect.destination === '/review-room'
    && redirect.permanent === false
  )) === true,
  'Expected Vercel root launches to redirect to the Review Room dashboard',
);
assert(
  JSON.stringify(vercelConfig.functions ?? {}).includes('docs/**')
    && JSON.stringify(vercelConfig.functions ?? {}).includes('AGENT_CONTRACT.md'),
  'Expected Vercel function bundle to include Agent API docs',
);

const suggestionsSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: {
        id: { default: null },
        kind: { default: 'replace' },
        by: { default: 'unknown' },
      },
      inclusive: false,
      spanning: true,
    },
  },
});

const replacementState = EditorState.create({
  schema: suggestionsSchema,
  doc: suggestionsSchema.node('doc', null, [
    suggestionsSchema.node('paragraph', null, [suggestionsSchema.text('Hello World.')]),
  ]),
});
const replacementTr = replacementState.tr.replaceWith(7, 12, suggestionsSchema.text('Hello'));
const wrappedReplacementTr = wrapTransactionForSuggestions(replacementTr, replacementState, true);

assertEqual(
  wrappedReplacementTr.doc.textContent,
  'Hello WorldHello.',
  'Expected typed replacement to keep original text and insert visible replacement text',
);

const replacementSegments: Array<{ text: string; kind: string }> = [];
wrappedReplacementTr.doc.descendants((node) => {
  if (!node.isText) return true;
  const suggestion = node.marks.find((mark) => mark.type.name === 'proofSuggestion');
  if (suggestion) {
    replacementSegments.push({ text: node.text ?? '', kind: String(suggestion.attrs.kind) });
  }
  return true;
});

assert(
  replacementSegments.some((segment) => segment.text === 'World' && segment.kind === 'delete'),
  'Expected original selected text to become a visible delete suggestion',
);
assert(
  replacementSegments.some((segment) => segment.text === 'Hello' && segment.kind === 'insert'),
  'Expected typed replacement text to become a visible insert suggestion',
);

console.log('✓ Review Room unified header wiring');
