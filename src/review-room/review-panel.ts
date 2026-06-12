import type { ReviewRoomAssignmentTask, ReviewRoomHistoryEvent } from '../bridge/share-client';
import {
  collectReviewCommentActors,
  collectReviewHistoryActors,
  collectReviewHistoryEventTypes,
  collectReviewSuggestionActors,
  collectReviewSuggestionKinds,
  collectReviewTaskActors,
  collectReviewTaskStatuses,
  countReviewComments,
  deriveReviewComments,
  filterReviewComments,
  filterReviewHistoryEvents,
  filterReviewSuggestions,
  filterReviewTasks,
  historyEventTitle,
  shapeHistoryRow,
  type ReviewActorFilter,
  type ReviewComment,
  type ReviewCommentFilter,
  type ReviewHistoryEventTypeFilter,
  type ReviewSuggestionKindFilter,
  type ReviewTaskStatusFilter,
} from './review-items';
import { getReviewRoomSuggestionGroups } from './suggestion-groups';
import { ensureReviewRoomTokens } from './tokens';

// Review Room cockpit sidebar, extracted from the editor monolith. The editor
// supplies document/mark operations through ReviewPanelHost; this module owns
// derivation wiring, tabs, and presentation.

export type ReviewPanelSelection = {
  range: { from: number; to: number };
  quote: string;
};

export type ReviewPanelOptions = {
  focusMarkId?: string | null;
  useSelection?: boolean;
};

export type ReviewPanelHost = {
  getSelectedText(): ReviewPanelSelection | null;
  addSelectionComment(selection: ReviewPanelSelection, text: string): { id: string } | null;
  persistReviewMarks(): Promise<boolean>;
  replyToComment(commentId: string, text: string): boolean;
  resolveComment(commentId: string): boolean;
  deleteCommentThread(commentId: string): boolean;
  acceptSuggestion(suggestionId: string): Promise<boolean>;
  rejectSuggestion(suggestionId: string): Promise<boolean>;
  refreshDocumentFromServer(): Promise<void>;
  focusMark(markId: string): void;
  fetchDocument(): Promise<{ markdown?: string | null; marks?: Record<string, unknown> } | null>;
  fetchHistory(limit: number): Promise<ReviewRoomHistoryEvent[]>;
  fetchTasks(): Promise<ReviewRoomAssignmentTask[]>;
  updateTaskStatus(taskId: string, status: 'completed' | 'dismissed'): Promise<boolean>;
  isRealtimeAvailable(): boolean;
  onToggle(expanded: boolean): void;
};

export const REVIEW_PANEL_ID = 'review-room-review-sidebar';

type ReviewPanelTab = 'suggestions' | 'comments' | 'history' | 'tasks' | 'publish';

export async function openReviewRoomReviewPanel(host: ReviewPanelHost, options: ReviewPanelOptions = {}): Promise<void> {
  const existing = document.getElementById(REVIEW_PANEL_ID);
  if (existing) {
    existing.remove();
    if (!options.focusMarkId && !options.useSelection) {
      host.onToggle(false);
      return;
    }
  }

  ensureReviewRoomTokens();

  let selectedReviewText = options.useSelection ? host.getSelectedText() : null;
  let focusedMarkId = options.focusMarkId ?? null;
  let commentFilter: ReviewCommentFilter = 'open';
  let commentActorFilter: ReviewActorFilter = 'all';
  let suggestionActorFilter: ReviewActorFilter = 'all';
  let suggestionKindFilter: ReviewSuggestionKindFilter = 'all';
  let historyActorFilter: ReviewActorFilter = 'all';
  let historyEventTypeFilter: ReviewHistoryEventTypeFilter = 'all';
  let taskActorFilter: ReviewActorFilter = 'all';
  let taskStatusFilter: ReviewTaskStatusFilter = 'open';
  let activeTab: ReviewPanelTab = selectedReviewText ? 'comments' : 'suggestions';

  const panel = document.createElement('aside');
  panel.id = REVIEW_PANEL_ID;
  panel.setAttribute('aria-label', 'Review items');
  panel.style.cssText = `
    position:fixed;top:var(--review-room-bar-height, 64px);right:0;bottom:0;z-index:1200;
    width:min(440px, 100vw);background:var(--rr-surface);color:var(--rr-ink);
    border-left:1px solid var(--rr-border);box-shadow:var(--rr-shadow-overlay);
    display:grid;grid-template-rows:auto auto 1fr;overflow:hidden;
  `;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--rr-border-soft);';
  const title = document.createElement('div');
  title.textContent = 'Review';
  title.style.cssText = 'font-size:17px;font-weight:750;letter-spacing:0;color:var(--rr-ink);';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.style.cssText = 'border:1px solid var(--rr-control-border);background:var(--rr-surface);color:var(--rr-ink);border-radius:18px;min-height:32px;padding:0 11px;font-size:13px;font-weight:650;cursor:pointer;';
  header.append(title, close);
  if (!host.isRealtimeAvailable()) {
    const realtimeNote = document.createElement('div');
    realtimeNote.textContent = 'Realtime sync unavailable on this host - manual save mode';
    realtimeNote.style.cssText = 'font-size:11px;color:var(--rr-faint);padding:2px 8px;border:1px solid var(--rr-border-soft);border-radius:var(--rr-radius-pill);background:var(--rr-surface-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    header.insertBefore(realtimeNote, close);
  }

  const tabBar = document.createElement('div');
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', 'Review sections');
  tabBar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--rr-border-soft);background:var(--rr-surface-soft);';

  const body = document.createElement('div');
  body.style.cssText = 'overflow:auto;padding:0;';
  panel.append(header, tabBar, body);
  document.body.appendChild(panel);
  host.onToggle(true);

  const cleanup = () => {
    if (!panel.isConnected) return;
    panel.remove();
    host.onToggle(false);
    document.removeEventListener('keydown', onKeyDown, true);
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') cleanup();
  };
  document.addEventListener('keydown', onKeyDown, true);
  close.onclick = cleanup;

  const sectionHeading = (label: string): HTMLElement => {
    const heading = document.createElement('div');
    heading.textContent = label;
    heading.style.cssText = 'padding:16px 18px 8px;font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:0.04em;color:var(--rr-muted);';
    return heading;
  };

  const row = (): HTMLElement => {
    const el = document.createElement('article');
    el.style.cssText = 'padding:14px 18px;border-top:1px solid var(--rr-border-soft);display:grid;gap:9px;';
    return el;
  };

  const emptyNote = (text: string): HTMLElement => {
    const empty = document.createElement('div');
    empty.textContent = text;
    empty.style.cssText = 'padding:8px 18px 16px;color:var(--rr-muted);font-size:13px;line-height:1.45;';
    return empty;
  };

  const renderLoading = () => {
    const loading = document.createElement('div');
    loading.textContent = 'Loading review items...';
    loading.style.cssText = 'padding:18px;color:var(--rr-muted);font-size:14px;line-height:1.45;';
    body.replaceChildren(loading);
  };

  const renderState = (titleText: string, message: string, tone: 'neutral' | 'error' = 'neutral', action?: HTMLButtonElement) => {
    const state = document.createElement('div');
    state.style.cssText = 'padding:22px 18px;display:grid;gap:8px;';
    const titleEl = document.createElement('div');
    titleEl.textContent = titleText;
    titleEl.style.cssText = `font-size:15px;font-weight:750;color:${tone === 'error' ? 'var(--rr-danger-deep)' : 'var(--rr-ink)'};`;
    const copy = document.createElement('div');
    copy.textContent = message;
    copy.style.cssText = `font-size:14px;line-height:1.45;color:${tone === 'error' ? 'var(--rr-danger)' : 'var(--rr-muted)'};`;
    state.append(titleEl, copy);
    if (action) {
      const actionRow = document.createElement('div');
      actionRow.style.cssText = 'padding-top:4px;';
      actionRow.appendChild(action);
      state.appendChild(actionRow);
    }
    body.replaceChildren(state);
  };

  const renderError = (message: string) => {
    const retry = smallButton('Retry');
    retry.onclick = () => { void loadPanel(); };
    renderState('Review items could not load', message, 'error', retry);
  };

  const smallButton = (label: string, variant: 'primary' | 'secondary' | 'danger' = 'secondary'): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    const palette = variant === 'primary'
      ? 'border:1px solid var(--rr-accent);background:var(--rr-accent);color:var(--rr-on-accent);'
      : variant === 'danger'
        ? 'border:1px solid var(--rr-danger-border);background:var(--rr-surface);color:var(--rr-danger);'
        : 'border:1px solid var(--rr-control-border);background:var(--rr-surface);color:var(--rr-ink);';
    button.style.cssText = `${palette}border-radius:var(--rr-radius);min-height:32px;padding:0 10px;font-size:13px;font-weight:650;cursor:pointer;font-family:inherit;`;
    return button;
  };

  const pillButton = (label: string, active: boolean): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = active
      ? 'border:1px solid var(--rr-accent);background:var(--rr-accent);color:var(--rr-on-accent);border-radius:var(--rr-radius-pill);min-height:30px;padding:0 10px;font-size:12px;font-weight:750;cursor:pointer;font-family:inherit;'
      : 'border:1px solid var(--rr-control-border);background:var(--rr-surface);color:var(--rr-ink);border-radius:var(--rr-radius-pill);min-height:30px;padding:0 10px;font-size:12px;font-weight:650;cursor:pointer;font-family:inherit;';
    return button;
  };

  const formatFilterValue = (value: string): string => {
    if (value === 'all') return 'All';
    return value
      .replace(/[_:.]/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  };

  const keepValidFilter = <T extends string>(value: T, options: readonly string[]): T | 'all' => (
    value === 'all' || options.includes(value) ? value : 'all'
  );

  const renderFilterControls = (
    label: string,
    options: Array<{ value: string; label: string; count?: number }>,
    activeValue: string,
    onSelect: (value: string) => void,
  ) => {
    if (options.length <= 1) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 18px 8px;';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    labelEl.style.cssText = 'font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:0.04em;color:var(--rr-faint);min-width:42px;';
    wrap.appendChild(labelEl);
    for (const option of options) {
      const text = typeof option.count === 'number' ? `${option.label} ${option.count}` : option.label;
      const button = pillButton(text, activeValue === option.value);
      button.setAttribute('aria-pressed', String(activeValue === option.value));
      button.onclick = () => {
        onSelect(option.value);
        focusedMarkId = null;
        void loadPanel();
      };
      wrap.appendChild(button);
    }
    body.appendChild(wrap);
  };

  const applyFocusedItemStyle = (item: HTMLElement, active: boolean) => {
    item.style.background = active ? 'var(--rr-surface-soft)' : 'var(--rr-surface)';
    item.style.boxShadow = active ? 'var(--rr-focus-inset)' : 'none';
    item.style.outline = active ? '1px solid rgba(38,104,84,0.22)' : '0';
    item.style.outlineOffset = active ? '-1px' : '0';
  };

  const activateReviewItem = (markId: string) => {
    focusedMarkId = markId;
    for (const candidate of body.querySelectorAll<HTMLElement>('[data-review-mark-id]')) {
      applyFocusedItemStyle(candidate, candidate.dataset.reviewMarkId === markId);
    }
    host.focusMark(markId);
  };

  const attachReviewItemFocus = (item: HTMLElement, markId: string) => {
    item.dataset.reviewMarkId = markId;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', 'Focus linked document text');
    applyFocusedItemStyle(item, markId === focusedMarkId);
    const maybeFocus = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('button, textarea, input, a')) return;
      activateReviewItem(markId);
    };
    item.addEventListener('click', maybeFocus);
    item.addEventListener('keydown', (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('button, textarea, input, a')) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activateReviewItem(markId);
    });
  };

  const renderTabBar = (counts: { suggestions: number; comments: number; history: number; tasks: number }) => {
    const tabs: Array<{ value: ReviewPanelTab; label: string }> = [
      { value: 'suggestions', label: `Suggestions ${counts.suggestions}` },
      { value: 'comments', label: `Comments ${counts.comments}` },
      { value: 'history', label: `History ${counts.history}` },
      { value: 'tasks', label: `Tasks ${counts.tasks}` },
      { value: 'publish', label: 'Publish' },
    ];
    const buttons = tabs.map((tab) => {
      const button = pillButton(tab.label, activeTab === tab.value);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(activeTab === tab.value));
      button.onclick = () => {
        activeTab = tab.value;
        void loadPanel();
      };
      return button;
    });
    tabBar.replaceChildren(...buttons);
  };

  const renderCommentFilterControls = (comments: ReviewComment[], counts: { open: number; resolved: number; all: number }) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;gap:4px;padding:8px 0 12px;border-top:1px solid var(--rr-border-soft);';
    const statusRow = document.createElement('div');
    statusRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 18px;';
    const statusLabel = document.createElement('span');
    statusLabel.textContent = 'Status';
    statusLabel.style.cssText = 'font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:0.04em;color:var(--rr-faint);min-width:42px;';
    statusRow.appendChild(statusLabel);
    const labels: Array<{ value: ReviewCommentFilter; label: string; count: number }> = [
      { value: 'open', label: 'Open', count: counts.open },
      { value: 'resolved', label: 'Resolved', count: counts.resolved },
      { value: 'all', label: 'All', count: counts.all },
    ];
    for (const option of labels) {
      const button = pillButton(`${option.label} ${option.count}`, commentFilter === option.value);
      button.setAttribute('aria-pressed', String(commentFilter === option.value));
      button.onclick = () => {
        commentFilter = option.value;
        focusedMarkId = null;
        void loadPanel();
      };
      statusRow.appendChild(button);
    }
    wrap.appendChild(statusRow);
    body.appendChild(wrap);

    const actors = collectReviewCommentActors(comments);
    commentActorFilter = keepValidFilter(commentActorFilter, actors);
    renderFilterControls('Actor', [
      { value: 'all', label: 'All actors', count: comments.length },
      ...actors.map((actor) => ({
        value: actor,
        label: actor,
        count: filterReviewComments(comments, 'all', actor).length,
      })),
    ], commentActorFilter, (value) => {
      commentActorFilter = value;
    });
  };

  const renderSuggestionFilterControls = (suggestions: ReturnType<typeof getReviewRoomSuggestionGroups>) => {
    const actors = collectReviewSuggestionActors(suggestions);
    const kinds = collectReviewSuggestionKinds(suggestions);
    suggestionActorFilter = keepValidFilter(suggestionActorFilter, actors);
    suggestionKindFilter = keepValidFilter(suggestionKindFilter, kinds) as ReviewSuggestionKindFilter;
    body.appendChild(document.createElement('div')).style.cssText = 'border-top:1px solid var(--rr-border-soft);padding-top:8px;';
    renderFilterControls('Actor', [
      { value: 'all', label: 'All actors', count: suggestions.length },
      ...actors.map((actor) => ({
        value: actor,
        label: actor,
        count: filterReviewSuggestions(suggestions, { actorFilter: actor }).length,
      })),
    ], suggestionActorFilter, (value) => {
      suggestionActorFilter = value;
    });
    renderFilterControls('Type', [
      { value: 'all', label: 'All types', count: suggestions.length },
      ...kinds.map((kind) => ({
        value: kind,
        label: formatFilterValue(kind),
        count: filterReviewSuggestions(suggestions, { kindFilter: kind }).length,
      })),
    ], suggestionKindFilter, (value) => {
      suggestionKindFilter = value as ReviewSuggestionKindFilter;
    });
  };

  const renderHistoryFilterControls = (events: ReviewRoomHistoryEvent[]) => {
    const actors = collectReviewHistoryActors(events);
    const eventTypes = collectReviewHistoryEventTypes(events);
    historyActorFilter = keepValidFilter(historyActorFilter, actors);
    historyEventTypeFilter = keepValidFilter(historyEventTypeFilter, eventTypes);
    body.appendChild(document.createElement('div')).style.cssText = 'border-top:1px solid var(--rr-border-soft);padding-top:8px;';
    renderFilterControls('Actor', [
      { value: 'all', label: 'All actors', count: events.length },
      ...actors.map((actor) => ({
        value: actor,
        label: actor,
        count: filterReviewHistoryEvents(events, { actorFilter: actor }).length,
      })),
    ], historyActorFilter, (value) => {
      historyActorFilter = value;
    });
    renderFilterControls('Event', [
      { value: 'all', label: 'All events', count: events.length },
      ...eventTypes.map((eventType) => ({
        value: eventType,
        label: historyEventTitle({ eventType } as ReviewRoomHistoryEvent),
        count: filterReviewHistoryEvents(events, { eventTypeFilter: eventType }).length,
      })),
    ], historyEventTypeFilter, (value) => {
      historyEventTypeFilter = value;
    });
  };

  const renderTaskFilterControls = (tasks: ReviewRoomAssignmentTask[]) => {
    const actors = collectReviewTaskActors(tasks);
    const statuses = collectReviewTaskStatuses(tasks);
    taskActorFilter = keepValidFilter(taskActorFilter, actors);
    taskStatusFilter = keepValidFilter(taskStatusFilter, statuses) as ReviewTaskStatusFilter;
    body.appendChild(document.createElement('div')).style.cssText = 'border-top:1px solid var(--rr-border-soft);padding-top:8px;';
    renderFilterControls('Actor', [
      { value: 'all', label: 'All actors', count: tasks.length },
      ...actors.map((actor) => ({
        value: actor,
        label: actor,
        count: filterReviewTasks(tasks, { actorFilter: actor }).length,
      })),
    ], taskActorFilter, (value) => {
      taskActorFilter = value;
    });
    renderFilterControls('Status', [
      { value: 'all', label: 'All statuses', count: tasks.length },
      ...statuses.map((status) => ({
        value: status,
        label: formatFilterValue(status),
        count: filterReviewTasks(tasks, { statusFilter: status }).length,
      })),
    ], taskStatusFilter, (value) => {
      taskStatusFilter = value as ReviewTaskStatusFilter;
    });
  };

  const renderHistoryEvents = (events: ReviewRoomHistoryEvent[]) => {
    const filteredEvents = filterReviewHistoryEvents(events, { actorFilter: historyActorFilter, eventTypeFilter: historyEventTypeFilter });
    const visibleEvents = filteredEvents.slice(0, 8);
    body.appendChild(sectionHeading(`History (${filteredEvents.length})`));
    renderHistoryFilterControls(events);
    if (visibleEvents.length === 0) {
      body.appendChild(emptyNote(events.length === 0 ? 'No Review Room history yet.' : 'No history items match these filters.'));
      return;
    }
    for (const event of visibleEvents) {
      const rowView = shapeHistoryRow(event);
      const item = row();
      item.dataset.reviewHistoryEvent = rowView.id;
      item.style.background = 'var(--rr-surface-soft)';
      const meta = document.createElement('div');
      meta.textContent = `${rowView.title} by ${rowView.actorId}${rowView.timestamp ? ` - ${rowView.timestamp}` : ''}`;
      meta.style.cssText = 'font-size:12px;font-weight:750;color:var(--rr-muted);';
      item.appendChild(meta);

      const { beforeText, afterText } = rowView;
      if (beforeText || afterText) {
        const diff = document.createElement('div');
        diff.style.cssText = 'display:grid;gap:7px;';
        if (beforeText) {
          const before = document.createElement('div');
          before.textContent = `Before: ${beforeText}`;
          before.style.cssText = 'font-size:13px;line-height:1.4;color:var(--rr-removed-ink);background:var(--rr-removed-bg);border:1px solid var(--rr-removed-border);border-radius:var(--rr-radius);padding:8px;overflow-wrap:anywhere;';
          diff.appendChild(before);
        }
        if (afterText) {
          const after = document.createElement('div');
          after.textContent = `After: ${afterText}`;
          after.style.cssText = 'font-size:13px;line-height:1.4;color:var(--rr-added-ink);background:var(--rr-added-bg);border:1px solid var(--rr-added-border);border-radius:var(--rr-radius);padding:8px;overflow-wrap:anywhere;';
          diff.appendChild(after);
        }
        item.appendChild(diff);
      }

      if (rowView.targetLabel) {
        const target = document.createElement('div');
        target.textContent = `Target: ${rowView.targetLabel}`;
        target.style.cssText = 'font-size:11px;color:var(--rr-faint);overflow-wrap:anywhere;';
        item.appendChild(target);
      }
      body.appendChild(item);
    }
  };

  const renderPlaceholderTab = (label: string, message: string) => {
    body.appendChild(sectionHeading(label));
    body.appendChild(emptyNote(message));
  };

  const renderTasks = (tasks: ReviewRoomAssignmentTask[]) => {
    const filteredTasks = filterReviewTasks(tasks, { actorFilter: taskActorFilter, statusFilter: taskStatusFilter });
    body.appendChild(sectionHeading(`Tasks (${filteredTasks.length})`));
    renderTaskFilterControls(tasks);
    if (filteredTasks.length === 0) {
      body.appendChild(emptyNote(tasks.length === 0
        ? 'No assignment tasks yet. Mention an agent or collaborator in a comment to create one.'
        : 'No assignment tasks match these filters.'));
      return;
    }
    for (const task of filteredTasks) {
      const item = row();
      item.dataset.reviewTaskId = task.id;
      item.style.background = task.status === 'open' ? 'var(--rr-surface)' : 'var(--rr-surface-soft)';

      const meta = document.createElement('div');
      const timestamp = task.createdAt ? ` - ${new Date(task.createdAt).toLocaleString()}` : '';
      meta.textContent = `${task.assignedToLabel || task.assignedToActorId} · ${task.status}${timestamp}`;
      meta.style.cssText = 'font-size:12px;font-weight:750;color:var(--rr-muted);';
      item.appendChild(meta);

      const excerpt = document.createElement('div');
      excerpt.textContent = task.sourceText || 'Mentioned in a comment thread.';
      excerpt.style.cssText = 'font-size:14px;line-height:1.45;color:var(--rr-ink);background:var(--rr-bg);border:1px solid var(--rr-border-soft);border-radius:var(--rr-radius);padding:8px;overflow-wrap:anywhere;';
      item.appendChild(excerpt);

      const detail = document.createElement('div');
      detail.textContent = `Created by ${task.createdByActorId}${task.sourceId ? ` · Source ${task.sourceId}` : ''}`;
      detail.style.cssText = 'font-size:11px;color:var(--rr-faint);overflow-wrap:anywhere;';
      item.appendChild(detail);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;';
      if (task.status === 'open') {
        const complete = smallButton('Complete', 'primary');
        const dismiss = smallButton('Dismiss');
        complete.onclick = () => {
          void (async () => {
            complete.disabled = true;
            dismiss.disabled = true;
            const success = await host.updateTaskStatus(task.id, 'completed');
            if (!success) {
              renderError('Could not complete this task.');
              return;
            }
            await loadPanel();
          })();
        };
        dismiss.onclick = () => {
          void (async () => {
            complete.disabled = true;
            dismiss.disabled = true;
            const success = await host.updateTaskStatus(task.id, 'dismissed');
            if (!success) {
              renderError('Could not dismiss this task.');
              return;
            }
            await loadPanel();
          })();
        };
        actions.append(complete, dismiss);
      } else {
        const status = document.createElement('span');
        status.textContent = task.status === 'completed' ? 'Completed' : 'Dismissed';
        status.style.cssText = 'display:inline-flex;align-items:center;min-height:28px;border:1px solid var(--rr-border-soft);border-radius:var(--rr-radius-pill);padding:0 9px;font-size:12px;font-weight:750;color:var(--rr-muted);background:var(--rr-surface);';
        actions.appendChild(status);
      }
      item.appendChild(actions);
      body.appendChild(item);
    }
  };

  const renderSelectedTextComposer = (): HTMLElement | null => {
    if (!selectedReviewText) return null;
    const composer = row();
    composer.style.borderTop = '0';
    composer.style.background = 'var(--rr-surface-soft)';
    const label = document.createElement('div');
    label.textContent = 'Review selected text';
    label.style.cssText = 'font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:0.04em;color:var(--rr-muted);';
    const quote = document.createElement('div');
    quote.textContent = selectedReviewText.quote;
    quote.style.cssText = 'font-size:13px;line-height:1.4;color:var(--rr-ink);background:var(--rr-surface);border:1px solid var(--rr-border-soft);border-radius:var(--rr-radius);padding:8px;overflow-wrap:anywhere;';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add a comment...';
    textarea.rows = 3;
    textarea.style.cssText = 'width:100%;box-sizing:border-box;min-height:78px;resize:vertical;border:1px solid var(--rr-control-border);border-radius:var(--rr-radius);padding:9px 10px;font:inherit;font-size:14px;line-height:1.45;color:var(--rr-ink);background:var(--rr-surface);';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const add = smallButton('Comment', 'primary');
    const cancel = smallButton('Cancel');
    add.onclick = () => {
      void (async () => {
        const activeSelection = selectedReviewText;
        if (!activeSelection) return;
        const mark = host.addSelectionComment(activeSelection, textarea.value);
        if (!mark) return;
        add.disabled = true;
        cancel.disabled = true;
        const persisted = await host.persistReviewMarks();
        if (!persisted) {
          renderError('Could not save this comment.');
          return;
        }
        selectedReviewText = null;
        focusedMarkId = mark.id;
        await loadPanel();
      })();
    };
    cancel.onclick = () => {
      selectedReviewText = null;
      void loadPanel();
    };
    actions.append(add, cancel);
    composer.append(label, quote, textarea, actions);
    return composer;
  };

  const renderSuggestions = (suggestions: ReturnType<typeof getReviewRoomSuggestionGroups>) => {
    const visibleSuggestions = filterReviewSuggestions(suggestions, { actorFilter: suggestionActorFilter, kindFilter: suggestionKindFilter });
    body.appendChild(sectionHeading(`Suggestions (${visibleSuggestions.length})`));
    renderSuggestionFilterControls(suggestions);
    if (visibleSuggestions.length === 0) {
      body.appendChild(emptyNote(suggestions.length === 0 ? 'No pending suggestions.' : 'No suggestions match these filters.'));
    }
    for (const suggestion of visibleSuggestions) {
      const item = row();
      attachReviewItemFocus(item, suggestion.id);
      applyFocusedItemStyle(item, suggestion.ids.includes(focusedMarkId ?? ''));
      if (suggestion.ids.includes(focusedMarkId ?? '')) {
        requestAnimationFrame(() => {
          item.scrollIntoView({ block: 'nearest' });
          host.focusMark(suggestion.id);
        });
      }
      const meta = document.createElement('div');
      meta.textContent = `${suggestion.kind} by ${suggestion.by}${suggestion.count > 1 ? ` (${suggestion.count} adjacent chunks)` : ''}`;
      meta.style.cssText = 'font-size:12px;font-weight:750;color:var(--rr-muted);';
      const quote = suggestion.kind === 'insert' ? null : document.createElement('div');
      if (quote) {
        quote.textContent = suggestion.quote || '(insert at document end)';
        quote.style.cssText = 'font-size:13px;line-height:1.4;color:var(--rr-ink);background:var(--rr-bg);border:1px solid var(--rr-border-soft);border-radius:var(--rr-radius);padding:8px;overflow-wrap:anywhere;';
      }
      const content = document.createElement('div');
      content.textContent = suggestion.kind === 'delete' ? 'Delete selected text' : suggestion.content;
      content.style.cssText = 'font-size:14px;line-height:1.45;color:var(--rr-ink);overflow-wrap:anywhere;';
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;align-items:center;';
      const accept = smallButton('Accept', 'primary');
      const reject = smallButton('Reject');
      const runAction = async (action: 'accept' | 'reject') => {
        accept.disabled = true;
        reject.disabled = true;
        for (const suggestionId of suggestion.ids) {
          const succeeded = action === 'accept'
            ? await host.acceptSuggestion(suggestionId)
            : await host.rejectSuggestion(suggestionId);
          if (!succeeded) {
            renderError(`Could not ${action} this suggestion.`);
            return;
          }
        }
        await host.refreshDocumentFromServer();
        await loadPanel();
      };
      accept.onclick = () => { void runAction('accept'); };
      reject.onclick = () => { void runAction('reject'); };
      actions.append(accept, reject);
      if (quote) {
        item.append(meta, quote, content, actions);
      } else {
        item.append(meta, content, actions);
      }
      body.appendChild(item);
    }
  };

  const renderComments = (comments: ReviewComment[]) => {
    const counts = countReviewComments(comments);
    const visibleComments = filterReviewComments(comments, commentFilter, commentActorFilter);
    body.appendChild(sectionHeading(`Comments (${visibleComments.length})`));
    renderCommentFilterControls(comments, counts);
    if (visibleComments.length === 0) {
      body.appendChild(emptyNote(comments.length > 0 && commentActorFilter !== 'all'
        ? 'No comment threads match these filters.'
        : commentFilter === 'resolved'
        ? 'No resolved comment threads.'
        : commentFilter === 'all'
          ? 'No comment threads yet.'
          : 'No open comment threads.'));
    }
    for (const comment of visibleComments) {
      const item = row();
      attachReviewItemFocus(item, comment.id);
      if (comment.id === focusedMarkId) {
        requestAnimationFrame(() => {
          item.scrollIntoView({ block: 'nearest' });
          host.focusMark(comment.id);
        });
      }
      const meta = document.createElement('div');
      meta.textContent = `${comment.by}${comment.replies.length > 0 ? ` · ${comment.replies.length} replies` : ''}${comment.resolved ? ' · Resolved' : ''}`;
      meta.style.cssText = 'font-size:12px;font-weight:750;color:var(--rr-muted);';
      const quote = document.createElement('div');
      quote.textContent = comment.quote || 'Document comment';
      quote.style.cssText = 'font-size:13px;line-height:1.4;color:var(--rr-ink);background:var(--rr-bg);border:1px solid var(--rr-border-soft);border-radius:var(--rr-radius);padding:8px;overflow-wrap:anywhere;';
      const thread = document.createElement('div');
      thread.style.cssText = 'display:grid;gap:8px;';
      const renderMessage = (by: string, textValue: string, at: string) => {
        const message = document.createElement('div');
        message.style.cssText = 'display:grid;gap:3px;';
        const messageMeta = document.createElement('div');
        messageMeta.textContent = at ? `${by} · ${new Date(at).toLocaleString()}` : by;
        messageMeta.style.cssText = 'font-size:12px;color:var(--rr-muted);font-weight:650;';
        const messageText = document.createElement('div');
        messageText.textContent = textValue;
        messageText.style.cssText = 'font-size:14px;line-height:1.45;color:var(--rr-ink);overflow-wrap:anywhere;';
        message.append(messageMeta, messageText);
        thread.appendChild(message);
      };
      renderMessage(comment.by, comment.text, comment.at);
      for (const reply of comment.replies) {
        renderMessage(reply.by, reply.text, reply.at);
      }
      const replyBox = document.createElement('textarea');
      replyBox.placeholder = 'Reply...';
      replyBox.rows = 2;
      replyBox.style.cssText = 'width:100%;box-sizing:border-box;min-height:62px;resize:vertical;border:1px solid var(--rr-control-border);border-radius:var(--rr-radius);padding:8px 9px;font:inherit;font-size:13px;line-height:1.45;color:var(--rr-ink);background:var(--rr-surface);';
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;';
      const reply = smallButton('Reply', 'primary');
      const resolve = smallButton('Resolve');
      const del = smallButton('Delete', 'danger');
      reply.disabled = comment.resolved;
      resolve.disabled = comment.resolved;
      reply.onclick = () => {
        void (async () => {
          const text = replyBox.value.trim();
          if (!text) return;
          reply.disabled = true;
          const added = host.replyToComment(comment.id, text);
          if (!added) {
            renderError('Could not add this reply.');
            return;
          }
          const persisted = await host.persistReviewMarks();
          if (!persisted) {
            renderError('Could not save this reply.');
            return;
          }
          focusedMarkId = comment.id;
          await loadPanel();
        })();
      };
      resolve.onclick = () => {
        void (async () => {
          resolve.disabled = true;
          const success = host.resolveComment(comment.id);
          if (!success) {
            renderError('Could not resolve this thread.');
            return;
          }
          await host.persistReviewMarks();
          focusedMarkId = null;
          await loadPanel();
        })();
      };
      del.onclick = () => {
        void (async () => {
          del.disabled = true;
          const success = host.deleteCommentThread(comment.id);
          if (!success) {
            renderError('Could not delete this thread.');
            return;
          }
          const persisted = await host.persistReviewMarks();
          if (!persisted) {
            renderError('Could not save this deletion.');
            return;
          }
          focusedMarkId = null;
          await loadPanel();
        })();
      };
      actions.append(reply, resolve, del);
      item.append(meta, quote, thread, replyBox, actions);
      body.appendChild(item);
    }
  };

  const loadPanel = async () => {
    renderLoading();
    try {
      const [doc, historyEvents, tasks] = await Promise.all([
        host.fetchDocument(),
        host.fetchHistory(20).catch((error) => {
          console.warn('[review-room] history load failed', error);
          return [] as ReviewRoomHistoryEvent[];
        }),
        host.fetchTasks().catch((error) => {
          console.warn('[review-room] task load failed', error);
          return [] as ReviewRoomAssignmentTask[];
        }),
      ]);
      if (!doc) {
        renderError('Could not load this document.');
        return;
      }
      const suggestions = getReviewRoomSuggestionGroups(doc);
      const comments = deriveReviewComments(doc.marks);

      if (focusedMarkId) {
        if (comments.some((comment) => comment.id === focusedMarkId)) activeTab = 'comments';
        else if (suggestions.some((suggestion) => suggestion.ids.includes(focusedMarkId ?? ''))) activeTab = 'suggestions';
      }

      renderTabBar({
        suggestions: suggestions.length,
        comments: countReviewComments(comments).open,
        history: historyEvents.length,
        tasks: tasks.filter((task) => task.status === 'open').length,
      });

      body.replaceChildren();
      const selectedComposer = activeTab === 'comments' ? renderSelectedTextComposer() : null;
      if (selectedComposer) body.appendChild(selectedComposer);

      if (activeTab === 'suggestions') {
        if (suggestions.length === 0 && comments.length === 0 && historyEvents.length === 0) {
          renderState('No review items', 'Comments and suggestions will appear here when someone adds feedback to this document.');
          return;
        }
        renderSuggestions(suggestions);
        return;
      }
      if (activeTab === 'comments') {
        renderComments(comments);
        return;
      }
      if (activeTab === 'history') {
        renderHistoryEvents(historyEvents);
        return;
      }
      if (activeTab === 'tasks') {
        renderTasks(tasks);
        return;
      }
      renderPlaceholderTab('Publish', 'Publish and baseline checkpoints will appear here when publishing ships.');
    } catch (error) {
      renderError(error instanceof Error ? error.message : 'Could not load review items.');
    }
  };

  await loadPanel();
}
