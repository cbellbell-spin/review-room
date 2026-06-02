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
assert(indexHtml.includes('id="review-room-agent-slot"'), 'Expected Review Room header to expose an agent control slot');
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
    && editorSource.includes("agentSlotContainer.replaceChildren(agentSlot);")
    && editorSource.includes("shareSlot.replaceChildren(shareBtn);"),
  'Expected existing share controls to be mounted into Review Room header slots',
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
  editorSource.includes('if (this.isReviewRoomRuntime()) {\n          this.clearErrorBanner();')
    && editorSource.includes("this.showErrorBanner('Live collaboration is currently unavailable for this shared document.');"),
  'Expected Review Room hosted no-collab mode to avoid the generic live collaboration error banner',
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
