import { readFileSync } from 'fs';
import path from 'path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const indexHtml = readFileSync(path.join(root, 'src/index.html'), 'utf8');
const editorSource = readFileSync(path.join(root, 'src/editor/index.ts'), 'utf8');
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
  editorSource.includes("panel.id = 'review-room-review-sidebar';")
    && editorSource.includes("button.setAttribute('aria-controls', 'review-room-review-sidebar');")
    && editorSource.includes("button.setAttribute('aria-expanded', 'false');")
    && editorSource.includes("top:var(--review-room-bar-height, 64px);right:0;bottom:0;")
    && !editorSource.includes('background:rgba(31,41,51,0.46);'),
  'Expected Review Room review items to open as a docked sidebar, not a dimmed overlay',
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
    && editorSource.includes("action: 'bold'")
    && editorSource.includes("action: 'italic'")
    && editorSource.includes("action: 'heading1'")
    && editorSource.includes("action: 'bulletList'"),
  'Expected Review Room editor to expose a compact Markdown formatting toolbar',
);
assert(
  editorSource.includes('this.reviewRoomRestSaveMode || (baseAllowLocalEdits && hydrated)'),
  'Expected hosted Review Room mode to allow local edits for manual save',
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

console.log('✓ Review Room unified header wiring');
