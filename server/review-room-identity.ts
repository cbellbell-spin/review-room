export const REVIEW_ROOM_DEFAULT_WORKSPACE_ID = 'local';
export const REVIEW_ROOM_LOCAL_HUMAN_ID = 'local-human';
export const REVIEW_ROOM_LOCAL_AGENT_ID = 'agent-reviewer';
export const REVIEW_ROOM_LOCAL_WORKSPACE_NAME = 'Local Review Room';
export const REVIEW_ROOM_LOCAL_HUMAN_NAME = 'Local reviewer';
export const REVIEW_ROOM_LOCAL_AGENT_NAME = 'Review agent';

export function normalizeReviewRoomIdentityId(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : REVIEW_ROOM_LOCAL_HUMAN_ID;
}

export function reviewRoomActorForIdentity(identityId: string): string {
  return `review-room:${normalizeReviewRoomIdentityId(identityId)}`;
}
