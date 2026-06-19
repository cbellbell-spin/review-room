const ACTOR_PALETTE = [
  { accent: '#2563EB', tint: 'rgba(37, 99, 235, 0.16)' },
  { accent: '#7C3AED', tint: 'rgba(124, 58, 237, 0.16)' },
  { accent: '#0F766E', tint: 'rgba(15, 118, 110, 0.17)' },
  { accent: '#B45309', tint: 'rgba(180, 83, 9, 0.17)' },
  { accent: '#BE185D', tint: 'rgba(190, 24, 93, 0.16)' },
  { accent: '#4D7C0F', tint: 'rgba(77, 124, 15, 0.17)' },
] as const;

export type ActorColor = (typeof ACTOR_PALETTE)[number];

function hashActor(actorId: string): number {
  let hash = 2166136261;
  for (const char of actorId.trim().toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getActorColor(actorId: string): ActorColor {
  return ACTOR_PALETTE[hashActor(actorId) % ACTOR_PALETTE.length];
}

export function formatActorLabel(actorId: string, labels: Readonly<Record<string, string>> = {}): string {
  const normalized = actorId.trim();
  const identityId = normalized.startsWith('human:')
    ? normalized.slice('human:'.length)
    : normalized.startsWith('review-room:')
      ? normalized.slice('review-room:'.length)
      : normalized;
  return labels[normalized] || labels[identityId] || normalized || 'Unknown collaborator';
}
