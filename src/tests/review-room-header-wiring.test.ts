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
const serverIndexSource = readFileSync(path.join(root, 'server/index.ts'), 'utf8');
const reviewRoomRoutesSource = readFileSync(path.join(root, 'server/review-room-routes.ts'), 'utf8');
const reviewRoomMcpSource = readFileSync(path.join(root, 'server/review-room-mcp-routes.ts'), 'utf8');
const reviewRoomClientSource = readFileSync(path.join(root, 'src/review-room/client.ts'), 'utf8');
const reviewPanelSource = readFileSync(path.join(root, 'src/review-room/review-panel.ts'), 'utf8');
const reviewItemsSource = readFileSync(path.join(root, 'src/review-room/review-items.ts'), 'utf8');
const reviewTokensSource = readFileSync(path.join(root, 'src/review-room/tokens.ts'), 'utf8');
const shareClientSource = readFileSync(path.join(root, 'src/bridge/share-client.ts'), 'utf8');
const collabClientSource = readFileSync(path.join(root, 'src/bridge/collab-client.ts'), 'utf8');
const suggestionsSource = readFileSync(path.join(root, 'src/editor/plugins/suggestions.ts'), 'utf8');
const markPopoverSource = readFileSync(path.join(root, 'src/editor/plugins/mark-popover.ts'), 'utf8');
const selectionBarSource = readFileSync(path.join(root, 'src/editor/plugins/mark-selection-bar.ts'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
  redirects?: Array<{ source?: string; destination?: string; permanent?: boolean }>;
};

assert(indexHtml.includes('id="review-room-title-slot"'), 'Expected Review Room header to expose a title slot');
assert(indexHtml.includes('id="review-room-capability-slot"'), 'Expected Review Room header to expose a capability summary slot');
assert(indexHtml.includes('id="review-room-status-slot"'), 'Expected Review Room header to expose a sync status slot');
assert(indexHtml.includes('id="review-room-review-slot"'), 'Expected Review Room header to expose a review sidebar slot');
assert(indexHtml.includes('id="review-room-agent-slot"'), 'Expected Review Room header to expose an agent control slot');
assert(indexHtml.includes('id="review-room-format-slot"'), 'Expected Review Room header to expose a formatting toolbar slot');
assert(indexHtml.includes('id="review-room-save-slot"'), 'Expected Review Room header to expose a save slot');
assert(indexHtml.includes('id="review-room-share-slot"'), 'Expected Review Room header to expose a share control slot');
assert(indexHtml.includes('id="review-room-profile-slot"'), 'Expected Review Room header to expose a profile control slot');
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
  editorSource.includes('private createReviewRoomCapabilityStrip()')
    && editorSource.includes('private updateReviewRoomCapabilityStrip()')
    && editorSource.includes("chip.className = 'review-room-capability-chip';")
    && editorSource.includes("this.createReviewRoomCapabilityChip('access'")
    && editorSource.includes("this.createReviewRoomCapabilityChip('agent'")
    && editorSource.includes("this.createReviewRoomCapabilityChip('state'")
    && editorSource.includes("this.reviewRoomShareState && this.reviewRoomShareState !== 'ACTIVE'")
    && editorSource.includes('Review Room exposes request-scoped work for an external BYO agent; it does not run a model.')
    && editorSource.includes('this.renderReviewRoomUnavailableChrome(copy.title);'),
  'Expected Review Room document chrome to summarize access, meaningful BYO-agent state, and unavailable states without noisy duplicate chips',
);
assert(
  editorSource.includes("titleSlot.replaceChildren(title);")
    && editorSource.includes('capabilitySlot.replaceChildren(this.reviewRoomCapabilityStripEl);')
    && editorSource.includes("statusSlot.replaceChildren(syncStatusInline);")
    && editorSource.includes("reviewWrap.append(this.createReviewRoomAuditBannerButton(), this.createReviewRoomReviewButton());")
    && editorSource.includes("reviewSlot.replaceChildren(reviewWrap);")
    && editorSource.includes("agentSlotContainer.replaceChildren(agentSlot);")
    && editorSource.includes("formatSlot.replaceChildren(this.createReviewRoomFormattingToolbar());")
    && editorSource.includes("saveSlot.replaceChildren(this.createReviewRoomSaveControls());")
    && editorSource.includes("profileSlot.replaceChildren(this.createReviewRoomProfileButton());")
    && editorSource.includes("shareSlot.replaceChildren(shareBtn);"),
  'Expected existing share controls to be mounted into Review Room header slots',
);
assert(
  editorSource.includes('private createReviewRoomProfileButton()')
    && editorSource.includes('private openReviewRoomProfileModal()')
    && editorSource.includes("state.textContent = sessionActive ? 'Linked on this browser' : 'Document-link identity on this browser';")
    && editorSource.includes("method: 'PATCH'")
    && editorSource.includes("fetch('/review-room/api/session/logout'")
    && editorSource.includes('shared document links can still grant document access')
    && editorSource.includes("fetch('/review-room/api/session/enrollments'")
    && editorSource.includes('Create device enrollment link')
    && editorSource.includes('payload.recovery?.guidance?.summary')
    && editorSource.includes('role-scoped document link')
    && editorSource.includes("fetch(`/review-room/api/sessions/${encodeURIComponent(deviceSession.id || '')}`"),
  'Expected Review Room document chrome to expose identity continuity, rename, device enrollment, and session revocation controls',
);
assert(
  reviewRoomRoutesSource.includes('id="profile-button"')
    && reviewRoomRoutesSource.includes("profileSession.textContent = sessionActive ? 'Linked on this browser' : 'Local browser identity';")
    && reviewRoomRoutesSource.includes("profileForm.addEventListener('submit'")
    && reviewRoomRoutesSource.includes("profileSignout.addEventListener('click'")
    && reviewRoomRoutesSource.includes('shared document links can still grant document access')
    && reviewRoomRoutesSource.includes("profileEnrollment.addEventListener('click'")
    && reviewRoomRoutesSource.includes('/review-room/api/session/enrollments')
    && reviewRoomRoutesSource.includes('/review-room/api/sessions/')
    && reviewRoomRoutesSource.includes('profile-recovery-copy')
    && reviewRoomRoutesSource.includes('NO_AUTHENTICATED_DEVICE')
    && reviewRoomRoutesSource.includes('Invitation email delivery is disabled'),
  'Expected the Review Room dashboard to expose the same identity continuity, enrollment, and device revocation controls',
);
assert(
  reviewRoomRoutesSource.includes('@media (max-width: 560px)')
    && reviewRoomRoutesSource.includes('.nav { display: none; }')
    && indexHtml.includes('#review-room-profile-slot [data-review-room-profile-label]'),
  'Expected identity controls to stay compact in narrow Review Room headers',
);
assert(
  reviewPanelSource.includes("REVIEW_PANEL_ID = 'review-room-review-sidebar'")
    && editorSource.includes("button.setAttribute('aria-controls', 'review-room-review-sidebar');")
    && editorSource.includes("button.setAttribute('aria-expanded', 'false');")
    && editorSource.includes('void this.openReviewRoomReviewPanel({ useSelection: true });')
    && reviewPanelSource.includes('Review selected text')
    && editorSource.includes('this.addReviewRoomSelectionComment(selection, text)')
    && reviewPanelSource.includes('host.addSelectionComment(activeSelection, textarea.value)')
    && reviewPanelSource.includes('const persisted = await host.persistReviewMarks();')
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
    && editorSource.includes('reviewRoomClient.fetchHistory({ limit })')
    && reviewPanelSource.includes('host.fetchHistory(100)')
    && reviewPanelSource.includes('renderAuditInbox(historyEvents)')
    && reviewPanelSource.includes('Mark reviewed')
    && reviewPanelSource.includes('renderHistoryEvents(historyEvents)')
    && reviewItemsSource.includes('Accepted replacement')
    && reviewPanelSource.includes('renderHistoryEventRow(event)')
    && reviewPanelSource.includes('Show details')
    && reviewPanelSource.includes('changeKindLabel(rowView.changeKind)')
    && markPopoverSource.includes('proof?.isReviewRoomRuntime?.()')
    && markPopoverSource.includes('void proof.openReviewRoomReviewSidebar({')
    && markPopoverSource.includes('focusMarkId: markId'),
  'Expected Review Room comment threads and accepted suggestion history to open inside the Review sidebar',
);
assert(
  editorSource.includes("import {\n  reviewRoomClient,")
    && reviewRoomClientSource.includes('export class ReviewRoomClient')
    && reviewRoomClientSource.includes('fetchHistory(options?')
    && reviewRoomClientSource.includes('return shareClient.fetchReviewRoomHistory(options);')
    && reviewRoomClientSource.includes('fetchMembers(options?')
    && reviewRoomClientSource.includes('return shareClient.fetchReviewRoomMembers(options);')
    && reviewRoomClientSource.includes('fetchAgentReviewRuns(options?')
    && reviewRoomClientSource.includes('return shareClient.fetchReviewRoomAgentReviewRuns(options);')
    && reviewPanelSource.includes("from './client'")
    && reviewItemsSource.includes("from './client'"),
  'Expected Review Room product APIs and types to route through the Review Room client boundary while shareClient keeps compatibility wrappers',
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
    && editorSource.includes('reviewRoomClient.fetchTasks({ status: \'all\' })')
    && editorSource.includes('reviewRoomClient.updateTaskStatus(taskId, status)')
    && editorSource.includes('filterOpenReviewAuditEvents(history.events)')
    && editorSource.includes('1 direct change to review')
    && markPopoverSource.includes("mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace'")
    && markPopoverSource.includes("initialTab: mark.kind === 'comment' ? 'comments' : 'suggestions'")
    && reviewPanelSource.includes('renderTasks(tasks)')
    && reviewPanelSource.includes("host.updateTaskStatus(task.id, 'completed')")
    && reviewPanelSource.includes("host.updateTaskStatus(task.id, 'dismissed')")
    && shareClientSource.includes('async fetchReviewRoomBaselines(')
    && shareClientSource.includes('/review-room/api/documents/${encodeURIComponent(this.slug)}/baselines?limit=${limit}')
    && shareClientSource.includes('async createReviewRoomBaseline(')
    && editorSource.includes('reviewRoomClient.fetchBaselines({ limit: 10 })')
    && editorSource.includes('reviewRoomClient.createBaseline({ note })')
    && reviewPanelSource.includes('renderPublish(baselines, historyEvents)')
    && reviewPanelSource.includes('Changes since baseline')
    && reviewItemsSource.includes('Created baseline'),
  'Expected share client and sidebar host to expose typed Review Room history, task, and baseline loading/actions',
);
assert(
  markPopoverSource.includes('void proof.openReviewRoomReviewSidebar({ useSelection: true, initialTab: \'comments\' });')
    && markPopoverSource.includes('TextSelection.create(view.state.doc, from, to)')
    && selectionBarSource.includes('openReviewRoomMarkInSidebar(mark.id, \'suggestions\')'),
  'Expected Review Room selection comments and selection-created suggestions to route through the Review sidebar instead of the SDK popover',
);
assert(
  shareClientSource.includes('ReviewRoomDocumentMember')
    && shareClientSource.includes('async fetchReviewRoomMembers(')
    && shareClientSource.includes('/review-room/api/documents/${encodeURIComponent(this.slug)}/members')
    && shareClientSource.includes('async upsertReviewRoomMember(')
    && shareClientSource.includes('async revokeReviewRoomMember(')
    && editorSource.includes('private openReviewRoomMembersModal()')
    && editorSource.includes('Manage human access')
    && editorSource.includes('View collaborators')
    && editorSource.includes('Your document access:')
    && editorSource.includes('Agent access is separate, request-scoped')
    && editorSource.includes('Rotate access')
    && editorSource.includes("reviewRoomClient.revokeMember(member.identityId)")
    && editorSource.includes('reviewRoomClient.fetchMembers()')
    && editorSource.includes('reviewRoomClient.upsertMember({')
    && editorSource.includes('this.reviewRoomCanManageMembers = this.documentCapabilities.canManageMembers;')
    && editorSource.includes('this.reviewRoomAgentReviewCanStart = this.documentCapabilities.canRequestAgentReview;')
    && editorSource.includes('canCreateBaseline: () => this.documentCapabilities.canCreateBaseline')
    && editorSource.includes('canUpdateTasks: () => this.documentCapabilities.canUpdateTasks')
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
  editorSource.includes('Copy general agent prompt')
    && editorSource.includes('Download Claude/Cowork plugin')
    && editorSource.includes('MCP URL:')
    && editorSource.includes('review_room_get_state')
    && editorSource.includes('review_room_add_suggestion')
    && editorSource.includes('review_room_claim_review_request')
    && editorSource.includes('review_room_complete_review_request')
    && editorSource.includes('/review-room/claude-plugin.zip')
    && editorSource.includes('/documents/${encodedSlug}/events/pending?after=0'),
  'Expected Add agent to expose a Review Room MCP-first prompt modal',
);
assert(
  shareClientSource.includes('async fetchReviewRoomAgentReviewRuns(')
    && shareClientSource.includes('async startReviewRoomAgentReview(')
    && shareClientSource.includes('async retryReviewRoomAgentReview(')
    && shareClientSource.includes('async cancelReviewRoomAgentReview(')
    && shareClientSource.includes('async createReviewRoomAgentCredential(')
    && editorSource.includes('private async refreshReviewRoomAgentReviewStatus()')
    && editorSource.includes('private async startReviewRoomAgentReview()')
    && editorSource.includes('private async retryReviewRoomAgentReview()')
    && editorSource.includes("addMenuButton(currentRun ? 'Queue another external review' : 'Queue external review'")
    && editorSource.includes("'Open remaining review work' : 'Open review panel'")
    && editorSource.includes("addMenuButton('Copy scoped request prompt'")
    && editorSource.includes("addMenuButton('Open setup guide'")
    && editorSource.includes("!this.isReviewRoomRuntime()")
    && editorSource.includes("this.reviewRoomOpenReviewItemCount")
    && editorSource.includes("addMenuButton('Requeue external review'")
    && editorSource.includes('private reviewRoomAgentReviewTimelineDetail(run: ReviewRoomAgentReviewRun)')
    && editorSource.includes('agent access not copied yet')
    && shareClientSource.includes('ReviewRoomAgentReviewLifecycleEvent')
    && shareClientSource.includes('isReviewRoomAgentReviewLifecycleStatus')
    && reviewRoomRoutesSource.includes('lifecycle: buildAgentReviewRunLifecycle(run, credential)')
    && reviewRoomMcpSource.includes('lifecycle: buildAgentReviewRunLifecycle(run)')
    && editorSource.includes('the agent brings its own model and credentials')
    && editorSource.includes('This is a request-scoped agent credential')
    && editorSource.includes('reviewRoomClient.createAgentCredential(request.id)')
    && reviewRoomRoutesSource.includes("reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/review-runs'")
    && reviewRoomRoutesSource.includes("reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/review-runs/:runId/retry'")
    && reviewRoomRoutesSource.includes("reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/review-runs/:runId/cancel'")
    && reviewRoomRoutesSource.includes("reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/review-runs/:runId/agent-credential'")
    && reviewRoomMcpSource.includes("name: 'review_room_claim_review_request'")
    && reviewRoomMcpSource.includes("name: 'review_room_heartbeat_review_request'")
    && reviewRoomMcpSource.includes("name: 'review_room_complete_review_request'")
    && reviewItemsSource.includes("event.eventType === 'agent_review.lease_expired'")
    && reviewItemsSource.includes("event.eventType === 'agent_review.completed'"),
  'Expected Add agent to request, monitor, cancel, and requeue a provider-neutral BYO agent review',
);
assert(
  editorSource.includes('this.reviewRoomRestSaveMode || (baseAllowLocalEdits && hydrated)'),
  'Expected hosted Review Room mode to allow local edits for manual save',
);
assert(
  editorSource.includes('&& !this.pendingCollabRebindOnSync\n      && !awaitingTemplateSeed')
    && editorSource.includes('const baseAllowLocalEdits = collabReadinessReady && !this.isCollabRemoteSettling();'),
  'Expected live collab editing to stay gated until deferred rebind/reset and remote update settling have completed',
);
assert(
  editorSource.includes('const finishReadOnlyBindingReady = () => {')
    && editorSource.includes('if (!this.collabCanEdit) {\n            finishReadOnlyBindingReady();\n            return;')
    && editorSource.includes('finishBindingReady();')
    && editorSource.includes("this.reportCollabIncident('transport_probe_success', { result: 'acknowledged' });"),
  'Expected read-only collab sessions to avoid forbidden write probes while edit-capable sessions still require acknowledgement',
);
assert(
  editorSource.includes('const localMetadata = getMarkMetadataWithQuotes(view.state);')
    && editorSource.includes('mergePendingServerMarks(\n      localMetadata,\n      this.lastReceivedServerMarks,'),
  'Expected Review Room mark sync to push quote/range-enriched metadata instead of raw plugin metadata',
);
assert(
  editorSource.includes('const mergedMarks = mergePendingServerMarks(')
    && editorSource.includes('collabClient.setMarksMetadata(mergedMarks)')
    && editorSource.includes('this.lastReceivedServerMarks = { ...mergedMarks };'),
  'Expected pre-accept Review Room mark persistence to preserve server-known pending suggestions instead of replacing the collab marks map with a partially hydrated editor snapshot',
);
assert(
  editorSource.includes('if (this.isShareMode && !this.reviewRoomRestSaveMode) {\n      this.flushShareMarks();\n    }'),
  'Expected Review Room manual-save mode to avoid marks-only REST pushes before suggested text is saved',
);
assert(
  editorSource.includes('const reviewRoomIdentityId = typeof context?.reviewRoom?.identityId === \'string\'')
    && editorSource.includes('Review Room member identity is missing')
    && editorSource.includes('this.shareViewerName = context?.reviewRoom?.displayName || existingViewerName')
    && editorSource.includes('this.reviewRoomActorLabels = context?.reviewRoom?.actorLabels ?? {}')
    && editorSource.includes('setCurrentActorValue(reviewRoomIdentityId ? `human:${reviewRoomIdentityId}`')
    && editorSource.includes('!existingViewerName && !reviewRoomIdentityId'),
  'Expected Review Room member identity to drive the current actor instead of the global viewer-name prompt',
);
assert(
  editorSource.includes("copy.textContent = 'Copy link';")
    && editorSource.includes("member.openPath && member.openPath.includes('token=')")
    && editorSource.includes('this.absoluteReviewRoomOpenUrl(member.openPath)'),
  'Expected existing Review Room member rows to expose copyable tokenized collaborator links',
);
assert(
  shareClientSource.includes('identityInvitePath?: string | null;')
    && editorSource.includes('saved.identityInvitePath || saved.member.openPath')
    && editorSource.includes('can accept this one-time identity invitation')
    && editorSource.includes("copy.textContent = 'Copy identity invitation';"),
  'Expected newly saved collaborators to receive a one-time identity invitation while legacy document links remain compatible',
);
assert(
  editorSource.includes("} else {\n        addItem('Copy link', async () => this.copyLinkWithFallback(this.getCanonicalShareUrl()));\n      }"),
  'Expected Review Room to expose only member-specific collaborator links instead of copying the current member token',
);
assert(
  !editorSource.includes('const ok = await shareClient.pushUpdate(snapshot.markdown, snapshot.marks, getCurrentActor());'),
  'Expected live-collab review persistence to avoid full-document REST snapshots before suggestion decisions',
);
assert(
  editorSource.includes('private scheduleLatestCollabMarksToEditor(): void')
    && editorSource.includes('activelyTyping = view.hasFocus() && (Date.now() - this.lastLocalTypingAt) < 600;'),
  'Expected remote mark-anchor application to wait until active local typing settles',
);
assert(
  suggestionsSource.includes("newTr.setMeta('suggestions-wrapped', true)")
    && suggestionsSource.includes('if (authoredType) tr.removeMark(from, to, authoredType);')
    && readFileSync(path.join(root, 'src/editor/plugins/authored-tracker.ts'), 'utf8').includes("tr.getMeta('suggestions-wrapped')"),
  'Expected suggested typing to exclude direct-authorship marks',
);
assert(
  editorSource.includes('private getReviewRoomSuggestionFinalizeBlockReason(): string | null')
    && editorSource.includes("this.collabConnectionStatus !== 'connected'")
    && editorSource.includes('this.collabUnsyncedChanges > 0 || this.collabPendingLocalUpdates > 0')
    && editorSource.includes('getSuggestionFinalizeBlockReason: () => this.getReviewRoomSuggestionFinalizeBlockReason()')
    && reviewPanelSource.includes('private async waitForSuggestionFinalizeReady(): Promise<string | null>')
    && reviewPanelSource.includes("this.setTaskState(activeTask, 'needs-refresh', blockReason)")
    && reviewPanelSource.includes("this.setMarkState(markId, task.action, 'needs-refresh', mutationBlockReason)"),
  'Expected Review Room accept/reject to be blocked while live collaboration is unhealthy or unsynced',
);
assert(
  collabClientSource.includes('function isPermissionDeniedClose(event: unknown): boolean')
    && collabClientSource.includes('code === 4401')
    && collabClientSource.includes("this.terminalCloseReason = 'permission-denied';")
    && editorSource.includes('collabClient.lastAuthenticationFailureReason')
    && editorSource.includes('this.refreshCollabSessionAndReconnect(this.shouldPreservePendingLocalCollabState())'),
  'Expected expired collab session tokens to trigger a state-preserving session refresh/reconnect',
);
assert(
  editorSource.includes('private isSuggestionDecisionPendingShareEvent(event: SharePendingEvent): boolean')
    && editorSource.includes("event.type === 'suggestion.accepted'")
    && editorSource.includes("|| event.type === 'suggestion.rejected'")
    && editorSource.includes('if (this.isSuggestionDecisionPendingShareEvent(event) && this.collabEnabled) {')
    && editorSource.includes('void this.refreshCollabSessionAndReconnect(false);'),
  'Expected accepted/rejected suggestion events to cleanly refresh the live collab session after access-epoch rotation',
);
assert(
  !editorSource.includes('if (this.collabUnsyncedChanges > 0 || this.collabPendingLocalUpdates > 0) return;\n    if (this.hasRecentLocalEditorInput()) return;')
    && editorSource.includes('if (this.hasRecentLocalEditorInput()) return;\n    this.collabRemoteSettlingUntilMs = Date.now() + COLLAB_REMOTE_EDIT_SETTLE_MS;'),
  'Expected remote collab updates to gate local edits even while sync counters are active',
);
assert(
  serverIndexSource.includes("import { metricsApiRoutes } from './metrics.js';")
    && serverIndexSource.includes("app.use('/api/metrics', metricsApiRoutes);"),
  'Expected client metrics routes to be mounted under /api/metrics',
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
    && suggestionsSource.includes('markInsertedSuggestionRange(')
    && suggestionsSource.includes("{ id: insertSuggestionId, kind: 'insert', by: actor }")
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

const oldSuggestionMark = suggestionsSchema.marks.proofSuggestion.create({
  id: 'old-suggestion',
  kind: 'insert',
  by: 'human:CJ-1',
});
const inheritedSuggestionState = EditorState.create({
  schema: suggestionsSchema,
  doc: suggestionsSchema.node('doc', null, [
    suggestionsSchema.node('paragraph', null, [
      suggestionsSchema.text('Start '),
      suggestionsSchema.text('old suggestion', [oldSuggestionMark]),
      suggestionsSchema.text('.'),
    ]),
  ]),
});
const inheritedSuggestionTr = inheritedSuggestionState.tr.insertText('2nd editor ', 11);
const wrappedInheritedSuggestionTr = wrapTransactionForSuggestions(inheritedSuggestionTr, inheritedSuggestionState, true);
const insertedSuggestionMarks: Array<{ text: string; ids: string[] }> = [];
wrappedInheritedSuggestionTr.doc.descendants((node) => {
  if (!node.isText || !node.text?.includes('2nd editor')) return true;
  insertedSuggestionMarks.push({
    text: node.text,
    ids: node.marks
      .filter((mark) => mark.type.name === 'proofSuggestion')
      .map((mark) => String(mark.attrs.id)),
  });
  return true;
});

assertEqual(insertedSuggestionMarks.length, 1, 'Expected inserted editor text to remain one text segment');
assertEqual(insertedSuggestionMarks[0]?.ids.length, 1, 'Expected inserted editor text to have exactly one suggestion mark');
assert(
  insertedSuggestionMarks[0]?.ids[0] !== 'old-suggestion',
  'Expected newly typed suggestion text not to inherit the adjacent older suggestion id',
);

console.log('✓ Review Room unified header wiring');
