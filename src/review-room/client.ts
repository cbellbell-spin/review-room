import {
  shareClient,
  type ShareRequestError,
  type ShareRole,
} from '../bridge/share-client';

export type { ShareRequestError } from '../bridge/share-client';

export interface ReviewRoomHistoryEvent {
  id: string;
  workspaceId?: string;
  documentId?: string | null;
  actorId: string;
  actorType: string;
  eventType: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  rationale?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ReviewRoomHistoryResponse {
  success: boolean;
  events: ReviewRoomHistoryEvent[];
  document?: Record<string, unknown>;
}

export interface ReviewRoomAuditReviewedResponse {
  success: boolean;
  alreadyReviewed?: boolean;
  event: ReviewRoomHistoryEvent;
}

export interface ReviewRoomPublishedVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  proofRevision?: number | null;
  contentLength: number;
  createdByIdentityId: string;
  createdAt: string;
  note?: string | null;
}

export interface ReviewRoomBaselinesResponse {
  success: boolean;
  latest?: ReviewRoomPublishedVersion | null;
  baselines: ReviewRoomPublishedVersion[];
  document?: Record<string, unknown>;
}

export interface ReviewRoomCreateBaselineResponse {
  success: boolean;
  baseline: ReviewRoomPublishedVersion;
  document?: Record<string, unknown>;
}

export type ReviewRoomAssignmentTaskStatus = 'open' | 'running' | 'delegated' | 'dismissed' | 'completed';

export interface ReviewRoomAssignmentTask {
  id: string;
  documentId: string;
  proofEventId?: number | null;
  sourceType: string;
  sourceId?: string | null;
  sourceText?: string | null;
  createdByActorId: string;
  createdByActorType: string;
  assignedToActorId: string;
  assignedToActorType: 'human' | 'agent';
  assignedToLabel: string;
  managerIdentityId?: string | null;
  status: ReviewRoomAssignmentTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface ReviewRoomTasksResponse {
  success: boolean;
  tasks: ReviewRoomAssignmentTask[];
  document?: Record<string, unknown>;
}

export interface ReviewRoomTaskStatusResponse {
  success: boolean;
  task: ReviewRoomAssignmentTask;
}

export type ReviewRoomAgentReviewRunStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'lease_expired';

export type ReviewRoomAgentReviewLifecycleStatus =
  | ReviewRoomAgentReviewRunStatus
  | 'access_created'
  | 'access_revoked'
  | 'access_expired';

export interface ReviewRoomAgentReviewLifecycleEvent {
  eventType: string;
  status: ReviewRoomAgentReviewLifecycleStatus;
  occurredAt: string;
  actorId?: string | null;
  message?: string | null;
}

export interface ReviewRoomAgentReviewRun {
  id: string;
  documentId: string;
  agentId?: string | null;
  claimedByAgentId?: string | null;
  requestedByIdentityId: string;
  status: ReviewRoomAgentReviewRunStatus;
  attemptCount: number;
  scope: string;
  instructions?: string | null;
  leaseExpiresAt?: string | null;
  claimedAt?: string | null;
  heartbeatAt?: string | null;
  agentAccessExpiresAt?: string | null;
  agentAccessRevokedAt?: string | null;
  resultCount: number;
  failedOutputCount: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  lifecycle: ReviewRoomAgentReviewLifecycleEvent[];
}

export interface ReviewRoomAgentReviewRunsResponse {
  success: boolean;
  canStart: boolean;
  runs: ReviewRoomAgentReviewRun[];
}

export interface ReviewRoomAgentReviewRunResponse {
  success: boolean;
  reused?: boolean;
  run: ReviewRoomAgentReviewRun;
}

export interface ReviewRoomAgentCredential {
  id: string;
  reviewRequestId: string;
  agentId: string;
  agentName: string;
  token: string;
  expiresAt: string;
}

export interface ReviewRoomAgentCredentialResponse {
  success: boolean;
  credential: ReviewRoomAgentCredential;
}

export type ReviewRoomRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface ReviewRoomDocumentMember {
  documentId: string;
  identityId: string;
  identityKind?: string | null;
  displayName: string;
  role: ReviewRoomRole;
  shareRole: ShareRole;
  createdAt: string;
  updatedAt: string;
  openPath: string;
  accessToken?: string | null;
}

export interface ReviewRoomMembersResponse {
  success: boolean;
  document?: Record<string, unknown>;
  currentMember?: ReviewRoomDocumentMember | null;
  members: ReviewRoomDocumentMember[];
}

export interface ReviewRoomUpsertMemberResponse {
  success: boolean;
  document?: Record<string, unknown>;
  member: ReviewRoomDocumentMember;
  identityInvitePath?: string | null;
  identityInviteExpiresAt?: string | null;
}

export interface ReviewRoomRevokeMemberResponse {
  success: boolean;
  identityId: string;
  status: 'revoked';
}

function isReviewRoomAssignmentTaskStatus(value: unknown): value is ReviewRoomAssignmentTaskStatus {
  return value === 'open'
    || value === 'running'
    || value === 'delegated'
    || value === 'dismissed'
    || value === 'completed';
}

function isReviewRoomAgentReviewLifecycleStatus(value: unknown): value is ReviewRoomAgentReviewLifecycleStatus {
  return value === 'queued'
    || value === 'claimed'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'lease_expired'
    || value === 'access_created'
    || value === 'access_revoked'
    || value === 'access_expired';
}

function parseReviewRoomPublishedVersion(value: Record<string, unknown>): ReviewRoomPublishedVersion {
  return {
    id: typeof value.id === 'string' ? value.id : '',
    documentId: typeof value.documentId === 'string' ? value.documentId : '',
    versionNumber: typeof value.versionNumber === 'number' && Number.isFinite(value.versionNumber)
      ? Math.trunc(value.versionNumber)
      : 0,
    proofRevision: typeof value.proofRevision === 'number' && Number.isFinite(value.proofRevision)
      ? Math.trunc(value.proofRevision)
      : null,
    contentLength: typeof value.contentLength === 'number' && Number.isFinite(value.contentLength)
      ? Math.max(0, Math.trunc(value.contentLength))
      : 0,
    createdByIdentityId: typeof value.createdByIdentityId === 'string' ? value.createdByIdentityId : 'unknown',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    note: typeof value.note === 'string' ? value.note : null,
  };
}

function isReviewRoomRole(value: unknown): value is ReviewRoomRole {
  return value === 'owner' || value === 'editor' || value === 'commenter' || value === 'viewer';
}

function parseShareRole(value: unknown): ShareRole {
  return value === 'owner_bot' || value === 'editor' || value === 'commenter' || value === 'viewer'
    ? value
    : 'viewer';
}

function parseReviewRoomDocumentMember(value: Record<string, unknown>): ReviewRoomDocumentMember {
  return {
    documentId: typeof value.documentId === 'string' ? value.documentId : '',
    identityId: typeof value.identityId === 'string' ? value.identityId : '',
    identityKind: typeof value.identityKind === 'string' ? value.identityKind : null,
    displayName: typeof value.displayName === 'string' ? value.displayName : '',
    role: isReviewRoomRole(value.role) ? value.role : 'viewer',
    shareRole: parseShareRole(value.shareRole),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    openPath: typeof value.openPath === 'string' ? value.openPath : '',
    accessToken: typeof value.accessToken === 'string' ? value.accessToken : null,
  };
}

function parseReviewRoomHistoryEvent(event: Record<string, unknown>): ReviewRoomHistoryEvent {
  return {
    id: String(event.id),
    workspaceId: typeof event.workspaceId === 'string' ? event.workspaceId : undefined,
    documentId: typeof event.documentId === 'string' ? event.documentId : null,
    actorId: typeof event.actorId === 'string' ? event.actorId : 'unknown',
    actorType: typeof event.actorType === 'string' ? event.actorType : 'unknown',
    eventType: String(event.eventType),
    targetType: typeof event.targetType === 'string' ? event.targetType : null,
    targetId: typeof event.targetId === 'string' ? event.targetId : null,
    before: event.before && typeof event.before === 'object' && !Array.isArray(event.before)
      ? event.before as Record<string, unknown>
      : null,
    after: event.after && typeof event.after === 'object' && !Array.isArray(event.after)
      ? event.after as Record<string, unknown>
      : null,
    rationale: typeof event.rationale === 'string' ? event.rationale : null,
    metadata: event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? event.metadata as Record<string, unknown>
      : {},
    createdAt: typeof event.createdAt === 'string' ? event.createdAt : '',
  };
}

function parseReviewRoomAssignmentTask(task: Record<string, unknown>, fallbackStatus: ReviewRoomAssignmentTaskStatus = 'open'): ReviewRoomAssignmentTask {
  return {
    id: typeof task.id === 'string' ? task.id : '',
    documentId: typeof task.documentId === 'string' ? task.documentId : '',
    proofEventId: typeof task.proofEventId === 'number' ? task.proofEventId : null,
    sourceType: typeof task.sourceType === 'string' ? task.sourceType : 'comment',
    sourceId: typeof task.sourceId === 'string' ? task.sourceId : null,
    sourceText: typeof task.sourceText === 'string' ? task.sourceText : null,
    createdByActorId: typeof task.createdByActorId === 'string' ? task.createdByActorId : 'unknown',
    createdByActorType: typeof task.createdByActorType === 'string' ? task.createdByActorType : 'unknown',
    assignedToActorId: typeof task.assignedToActorId === 'string' ? task.assignedToActorId : 'unknown',
    assignedToActorType: task.assignedToActorType === 'human' ? 'human' : 'agent',
    assignedToLabel: typeof task.assignedToLabel === 'string' ? task.assignedToLabel : 'Unknown assignee',
    managerIdentityId: typeof task.managerIdentityId === 'string' ? task.managerIdentityId : null,
    status: isReviewRoomAssignmentTaskStatus(task.status) ? task.status : fallbackStatus,
    createdAt: typeof task.createdAt === 'string' ? task.createdAt : '',
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : '',
    completedAt: typeof task.completedAt === 'string' ? task.completedAt : null,
  };
}

function parseReviewRoomAgentReviewRun(run: Record<string, unknown>): ReviewRoomAgentReviewRun {
  const status = run.status === 'queued'
    || run.status === 'claimed'
    || run.status === 'running'
    || run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'cancelled'
    || run.status === 'lease_expired'
    ? run.status
    : 'failed';
  return {
    id: typeof run.id === 'string' ? run.id : '',
    documentId: typeof run.documentId === 'string' ? run.documentId : '',
    agentId: typeof run.claimedByAgentId === 'string' ? run.claimedByAgentId : null,
    claimedByAgentId: typeof run.claimedByAgentId === 'string' ? run.claimedByAgentId : null,
    requestedByIdentityId: typeof run.requestedByIdentityId === 'string' ? run.requestedByIdentityId : '',
    status,
    attemptCount: typeof run.attemptCount === 'number' ? run.attemptCount : 1,
    scope: typeof run.scope === 'string' ? run.scope : 'document',
    instructions: typeof run.instructions === 'string' ? run.instructions : null,
    leaseExpiresAt: typeof run.leaseExpiresAt === 'string' ? run.leaseExpiresAt : null,
    claimedAt: typeof run.claimedAt === 'string' ? run.claimedAt : null,
    heartbeatAt: typeof run.heartbeatAt === 'string' ? run.heartbeatAt : null,
    agentAccessExpiresAt: typeof run.agentAccessExpiresAt === 'string' ? run.agentAccessExpiresAt : null,
    agentAccessRevokedAt: typeof run.agentAccessRevokedAt === 'string' ? run.agentAccessRevokedAt : null,
    resultCount: typeof run.resultCount === 'number' ? run.resultCount : 0,
    failedOutputCount: typeof run.failedOutputCount === 'number' ? run.failedOutputCount : 0,
    errorCode: typeof run.errorCode === 'string' ? run.errorCode : null,
    errorMessage: typeof run.errorMessage === 'string' ? run.errorMessage : null,
    createdAt: typeof run.createdAt === 'string' ? run.createdAt : '',
    updatedAt: typeof run.updatedAt === 'string' ? run.updatedAt : '',
    startedAt: typeof run.startedAt === 'string' ? run.startedAt : null,
    completedAt: typeof run.completedAt === 'string' ? run.completedAt : null,
    cancelledAt: typeof run.cancelledAt === 'string' ? run.cancelledAt : null,
    lifecycle: Array.isArray(run.lifecycle)
      ? run.lifecycle
        .filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === 'object' && !Array.isArray(event))
        .map((event) => ({
          eventType: typeof event.eventType === 'string' ? event.eventType : 'agent_review.status',
          status: isReviewRoomAgentReviewLifecycleStatus(event.status) ? event.status : status,
          occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt : '',
          actorId: typeof event.actorId === 'string' ? event.actorId : null,
          message: typeof event.message === 'string' ? event.message : null,
        }))
        .filter((event) => Boolean(event.occurredAt))
      : [],
  };
}

export class ReviewRoomClient {
  private getSlug(): string | null {
    return shareClient.getSlug();
  }

  private getDocumentUrl(path: string): string | null {
    const slug = this.getSlug();
    if (!slug) return null;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${shareClient.getOriginBaseUrl()}/review-room/api/documents/${encodeURIComponent(slug)}${normalizedPath}`;
  }

  private headers(token?: string, json: boolean = false): Record<string, string> {
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...shareClient.getShareAuthHeaders(token),
    };
  }

  private parseError(response: Response): Promise<ShareRequestError> {
    return shareClient.parseShareRequestError(response);
  }

  async fetchHistory(options?: { token?: string; limit?: number; since?: string | null }): Promise<ReviewRoomHistoryResponse | ShareRequestError | null> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options?.limit ?? 20)));
    const params = new URLSearchParams({ limit: String(limit) });
    if (options?.since) params.set('since', options.since);
    const url = this.getDocumentUrl(`/history?${params.toString()}`);
    if (!url) return null;
    const response = await fetch(url, { headers: this.headers(options?.token) });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const rawEvents = Array.isArray(payload?.events) ? payload.events : [];
    return {
      success: payload?.success === true,
      document: payload?.document && typeof payload.document === 'object' && !Array.isArray(payload.document)
        ? payload.document as Record<string, unknown>
        : undefined,
      events: rawEvents
        .filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === 'object' && !Array.isArray(event))
        .filter((event) => typeof event.id === 'string' && typeof event.eventType === 'string')
        .map(parseReviewRoomHistoryEvent),
    };
  }

  async fetchBaselines(options?: { token?: string; limit?: number }): Promise<ReviewRoomBaselinesResponse | ShareRequestError | null> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options?.limit ?? 20)));
    const url = this.getDocumentUrl(`/baselines?limit=${limit}`);
    if (!url) return null;
    const response = await fetch(url, { headers: this.headers(options?.token) });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const rawBaselines = Array.isArray(payload?.baselines) ? payload.baselines : [];
    const latest = payload?.latest && typeof payload.latest === 'object' && !Array.isArray(payload.latest)
      ? parseReviewRoomPublishedVersion(payload.latest as Record<string, unknown>)
      : null;
    return {
      success: payload?.success === true,
      latest,
      document: payload?.document && typeof payload.document === 'object' && !Array.isArray(payload.document)
        ? payload.document as Record<string, unknown>
        : undefined,
      baselines: rawBaselines
        .filter((baseline): baseline is Record<string, unknown> => Boolean(baseline) && typeof baseline === 'object' && !Array.isArray(baseline))
        .filter((baseline) => typeof baseline.id === 'string')
        .map(parseReviewRoomPublishedVersion),
    };
  }

  async createBaseline(options?: { token?: string; note?: string | null }): Promise<ReviewRoomCreateBaselineResponse | ShareRequestError | null> {
    const url = this.getDocumentUrl('/baselines');
    if (!url) return null;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options?.token, true),
      body: JSON.stringify({ note: options?.note ?? null }),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const baseline = payload?.baseline && typeof payload.baseline === 'object' && !Array.isArray(payload.baseline)
      ? parseReviewRoomPublishedVersion(payload.baseline as Record<string, unknown>)
      : null;
    if (!baseline) return { success: false, baseline: {} as ReviewRoomPublishedVersion };
    return {
      success: payload?.success === true,
      baseline,
      document: payload?.document && typeof payload.document === 'object' && !Array.isArray(payload.document)
        ? payload.document as Record<string, unknown>
        : undefined,
    };
  }

  async fetchTasks(options?: { token?: string; status?: ReviewRoomAssignmentTaskStatus | 'all' }): Promise<ReviewRoomTasksResponse | ShareRequestError | null> {
    const status = options?.status ?? 'all';
    const url = this.getDocumentUrl(`/tasks?status=${encodeURIComponent(status)}`);
    if (!url) return null;
    const response = await fetch(url, { headers: this.headers(options?.token) });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    return {
      success: payload?.success === true,
      document: payload?.document && typeof payload.document === 'object' && !Array.isArray(payload.document)
        ? payload.document as Record<string, unknown>
        : undefined,
      tasks: rawTasks
        .filter((task): task is Record<string, unknown> => Boolean(task) && typeof task === 'object' && !Array.isArray(task))
        .filter((task) => typeof task.id === 'string')
        .map((task) => parseReviewRoomAssignmentTask(task)),
    };
  }

  async updateTaskStatus(
    taskId: string,
    status: Extract<ReviewRoomAssignmentTaskStatus, 'completed' | 'dismissed'>,
    options?: { token?: string },
  ): Promise<ReviewRoomTaskStatusResponse | ShareRequestError | null> {
    const url = this.getDocumentUrl(`/tasks/${encodeURIComponent(taskId)}/status`);
    if (!url) return null;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options?.token, true),
      body: JSON.stringify({ status }),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const task = payload?.task && typeof payload.task === 'object' && !Array.isArray(payload.task)
      ? payload.task as Record<string, unknown>
      : null;
    if (!task) return { success: false, task: {} as ReviewRoomAssignmentTask };
    return {
      success: payload?.success === true,
      task: parseReviewRoomAssignmentTask({ id: taskId, ...task }, status),
    };
  }

  async markAuditEventReviewed(eventId: string, options?: { token?: string }): Promise<ReviewRoomAuditReviewedResponse | ShareRequestError | null> {
    if (!eventId.trim()) return null;
    const url = this.getDocumentUrl(`/audit/${encodeURIComponent(eventId)}/reviewed`);
    if (!url) return null;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options?.token, true),
      body: JSON.stringify({}),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const event = payload?.event && typeof payload.event === 'object' && !Array.isArray(payload.event)
      ? parseReviewRoomHistoryEvent(payload.event as Record<string, unknown>)
      : null;
    if (!event) return { success: false, event: {} as ReviewRoomHistoryEvent };
    return {
      success: payload?.success === true,
      alreadyReviewed: payload?.alreadyReviewed === true,
      event,
    };
  }

  async fetchMembers(options?: { token?: string }): Promise<ReviewRoomMembersResponse | ShareRequestError | null> {
    const url = this.getDocumentUrl('/members');
    if (!url) return null;
    const response = await fetch(url, { headers: this.headers(options?.token) });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const rawMembers = Array.isArray(payload?.members) ? payload.members : [];
    const currentMember = payload?.currentMember && typeof payload.currentMember === 'object' && !Array.isArray(payload.currentMember)
      ? parseReviewRoomDocumentMember(payload.currentMember as Record<string, unknown>)
      : null;
    return {
      success: payload?.success === true,
      document: payload?.document && typeof payload.document === 'object' && !Array.isArray(payload.document)
        ? payload.document as Record<string, unknown>
        : undefined,
      currentMember,
      members: rawMembers
        .filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === 'object' && !Array.isArray(member))
        .filter((member) => typeof member.identityId === 'string')
        .map(parseReviewRoomDocumentMember),
    };
  }

  async upsertMember(input: { identityId: string; displayName?: string | null; role: ReviewRoomRole }, options?: { token?: string }): Promise<ReviewRoomUpsertMemberResponse | ShareRequestError | null> {
    const url = this.getDocumentUrl('/members');
    if (!url) return null;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options?.token, true),
      body: JSON.stringify({
        identityId: input.identityId,
        displayName: input.displayName ?? null,
        role: input.role,
      }),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const member = payload?.member && typeof payload.member === 'object' && !Array.isArray(payload.member)
      ? parseReviewRoomDocumentMember(payload.member as Record<string, unknown>)
      : null;
    if (!member) return { success: false, member: {} as ReviewRoomDocumentMember };
    return {
      success: payload?.success === true,
      document: payload?.document && typeof payload.document === 'object' && !Array.isArray(payload.document)
        ? payload.document as Record<string, unknown>
        : undefined,
      member,
      identityInvitePath: typeof payload?.identityInvitePath === 'string' ? payload.identityInvitePath : null,
      identityInviteExpiresAt: typeof payload?.identityInviteExpiresAt === 'string' ? payload.identityInviteExpiresAt : null,
    };
  }

  async revokeMember(identityId: string, options?: { token?: string }): Promise<ReviewRoomRevokeMemberResponse | ShareRequestError | null> {
    const url = this.getDocumentUrl(`/members/${encodeURIComponent(identityId)}`);
    if (!url) return null;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.headers(options?.token),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    return {
      success: payload?.success === true,
      identityId: typeof payload?.identityId === 'string' ? payload.identityId : identityId,
      status: 'revoked',
    };
  }

  async fetchAgentReviewRuns(options?: { token?: string; limit?: number }): Promise<ReviewRoomAgentReviewRunsResponse | ShareRequestError | null> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options?.limit ?? 20)));
    const url = this.getDocumentUrl(`/review-runs?limit=${limit}`);
    if (!url) return null;
    const response = await fetch(url, { headers: this.headers(options?.token) });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const runs = Array.isArray(payload?.runs) ? payload.runs : [];
    return {
      success: payload?.success === true,
      canStart: payload?.canStart === true,
      runs: runs
        .filter((run): run is Record<string, unknown> => Boolean(run) && typeof run === 'object' && !Array.isArray(run))
        .map(parseReviewRoomAgentReviewRun),
    };
  }

  async startAgentReview(idempotencyKey: string, options?: { token?: string; instructions?: string | null; scope?: string | null }): Promise<ReviewRoomAgentReviewRunResponse | ShareRequestError | null> {
    const url = this.getDocumentUrl('/review-runs');
    if (!url) return null;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options?.token, true),
      body: JSON.stringify({
        idempotencyKey,
        scope: options?.scope ?? undefined,
        instructions: options?.instructions ?? undefined,
      }),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const run = payload?.run && typeof payload.run === 'object' && !Array.isArray(payload.run)
      ? parseReviewRoomAgentReviewRun(payload.run as Record<string, unknown>)
      : null;
    if (!run) return { success: false, run: {} as ReviewRoomAgentReviewRun };
    return { success: payload?.success === true, reused: payload?.reused === true, run };
  }

  async retryAgentReview(runId: string, options?: { token?: string }): Promise<ReviewRoomAgentReviewRunResponse | ShareRequestError | null> {
    if (!runId.trim()) return null;
    const url = this.getDocumentUrl(`/review-runs/${encodeURIComponent(runId)}/retry`);
    if (!url) return null;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options?.token, true),
      body: JSON.stringify({}),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const run = payload?.run && typeof payload.run === 'object' && !Array.isArray(payload.run)
      ? parseReviewRoomAgentReviewRun(payload.run as Record<string, unknown>)
      : null;
    if (!run) return { success: false, run: {} as ReviewRoomAgentReviewRun };
    return { success: payload?.success === true, run };
  }

  async cancelAgentReview(runId: string, options?: { token?: string }): Promise<ReviewRoomAgentReviewRunResponse | ShareRequestError | null> {
    if (!runId.trim()) return null;
    const url = this.getDocumentUrl(`/review-runs/${encodeURIComponent(runId)}/cancel`);
    if (!url) return null;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options?.token, true),
      body: JSON.stringify({}),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const run = payload?.run && typeof payload.run === 'object' && !Array.isArray(payload.run)
      ? parseReviewRoomAgentReviewRun(payload.run as Record<string, unknown>)
      : null;
    if (!run) return { success: false, run: {} as ReviewRoomAgentReviewRun };
    return { success: payload?.success === true, run };
  }

  async createAgentCredential(runId: string, options?: { token?: string; agentId?: string | null; agentName?: string | null }): Promise<ReviewRoomAgentCredentialResponse | ShareRequestError | null> {
    if (!runId.trim()) return null;
    const url = this.getDocumentUrl(`/review-runs/${encodeURIComponent(runId)}/agent-credential`);
    if (!url) return null;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(options?.token, true),
      body: JSON.stringify({ agentId: options?.agentId ?? undefined, agentName: options?.agentName ?? undefined }),
    });
    if (!response.ok) return this.parseError(response);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const raw = payload?.credential && typeof payload.credential === 'object' && !Array.isArray(payload.credential)
      ? payload.credential as Record<string, unknown>
      : null;
    if (!raw) return { success: false, credential: {} as ReviewRoomAgentCredential };
    return {
      success: payload?.success === true,
      credential: {
        id: typeof raw.id === 'string' ? raw.id : '',
        reviewRequestId: typeof raw.reviewRequestId === 'string' ? raw.reviewRequestId : '',
        agentId: typeof raw.agentId === 'string' ? raw.agentId : '',
        agentName: typeof raw.agentName === 'string' ? raw.agentName : 'External review agent',
        token: typeof raw.token === 'string' ? raw.token : '',
        expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
      },
    };
  }
}

export type ReviewRoomClientResult =
  | ReviewRoomAgentCredentialResponse
  | ReviewRoomAgentReviewRunResponse
  | ReviewRoomAgentReviewRunsResponse
  | ReviewRoomAuditReviewedResponse
  | ReviewRoomBaselinesResponse
  | ReviewRoomCreateBaselineResponse
  | ReviewRoomMembersResponse
  | ReviewRoomRevokeMemberResponse
  | ReviewRoomTaskStatusResponse
  | ReviewRoomTasksResponse
  | ReviewRoomUpsertMemberResponse
  | ShareRequestError
  | null;

export const reviewRoomClient = new ReviewRoomClient();
