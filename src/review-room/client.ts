import {
  shareClient,
  type ReviewRoomAgentCredentialResponse,
  type ReviewRoomAgentReviewRunResponse,
  type ReviewRoomAgentReviewRunsResponse,
  type ReviewRoomAssignmentTaskStatus,
  type ReviewRoomAuditReviewedResponse,
  type ReviewRoomBaselinesResponse,
  type ReviewRoomCreateBaselineResponse,
  type ReviewRoomMembersResponse,
  type ReviewRoomRevokeMemberResponse,
  type ReviewRoomRole,
  type ReviewRoomTaskStatusResponse,
  type ReviewRoomTasksResponse,
  type ReviewRoomUpsertMemberResponse,
  type ShareRequestError,
} from '../bridge/share-client';

export type {
  ReviewRoomAgentCredential,
  ReviewRoomAgentCredentialResponse,
  ReviewRoomAgentReviewLifecycleEvent,
  ReviewRoomAgentReviewLifecycleStatus,
  ReviewRoomAgentReviewRun,
  ReviewRoomAgentReviewRunResponse,
  ReviewRoomAgentReviewRunsResponse,
  ReviewRoomAgentReviewRunStatus,
  ReviewRoomAssignmentTask,
  ReviewRoomAssignmentTaskStatus,
  ReviewRoomAuditReviewedResponse,
  ReviewRoomBaselinesResponse,
  ReviewRoomCreateBaselineResponse,
  ReviewRoomDocumentMember,
  ReviewRoomHistoryEvent,
  ReviewRoomHistoryResponse,
  ReviewRoomMembersResponse,
  ReviewRoomPublishedVersion,
  ReviewRoomRevokeMemberResponse,
  ReviewRoomRole,
  ReviewRoomTaskStatusResponse,
  ReviewRoomTasksResponse,
  ReviewRoomUpsertMemberResponse,
} from '../bridge/share-client';

export class ReviewRoomClient {
  fetchHistory(options?: { token?: string; limit?: number; since?: string | null }) {
    return shareClient.fetchReviewRoomHistory(options);
  }

  fetchBaselines(options?: { token?: string; limit?: number }) {
    return shareClient.fetchReviewRoomBaselines(options);
  }

  createBaseline(options?: { token?: string; note?: string | null }) {
    return shareClient.createReviewRoomBaseline(options);
  }

  fetchTasks(options?: { token?: string; status?: ReviewRoomAssignmentTaskStatus | 'all' }) {
    return shareClient.fetchReviewRoomTasks(options);
  }

  updateTaskStatus(
    taskId: string,
    status: Extract<ReviewRoomAssignmentTaskStatus, 'completed' | 'dismissed'>,
    options?: { token?: string },
  ) {
    return shareClient.updateReviewRoomTaskStatus(taskId, status, options);
  }

  markAuditEventReviewed(eventId: string, options?: { token?: string }) {
    return shareClient.markReviewRoomAuditEventReviewed(eventId, options);
  }

  fetchMembers(options?: { token?: string }) {
    return shareClient.fetchReviewRoomMembers(options);
  }

  upsertMember(input: { identityId: string; displayName?: string | null; role: ReviewRoomRole }, options?: { token?: string }) {
    return shareClient.upsertReviewRoomMember(input, options);
  }

  revokeMember(identityId: string, options?: { token?: string }) {
    return shareClient.revokeReviewRoomMember(identityId, options);
  }

  fetchAgentReviewRuns(options?: { token?: string; limit?: number }) {
    return shareClient.fetchReviewRoomAgentReviewRuns(options);
  }

  startAgentReview(idempotencyKey: string, options?: { token?: string; instructions?: string | null; scope?: string | null }) {
    return shareClient.startReviewRoomAgentReview(idempotencyKey, options);
  }

  retryAgentReview(runId: string, options?: { token?: string }) {
    return shareClient.retryReviewRoomAgentReview(runId, options);
  }

  cancelAgentReview(runId: string, options?: { token?: string }) {
    return shareClient.cancelReviewRoomAgentReview(runId, options);
  }

  createAgentCredential(runId: string, options?: { token?: string; agentId?: string | null; agentName?: string | null }) {
    return shareClient.createReviewRoomAgentCredential(runId, options);
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
