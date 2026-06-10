// CJB design tokens for Review Room product surfaces (cockpit, sidebar,
// dashboard). Injected as CSS custom properties so Review Room UI shares one
// palette without restyling generic Proof editor internals.

export const REVIEW_ROOM_TOKEN_STYLE_ID = 'review-room-tokens';

const TOKEN_CSS = `:root {
  --rr-bg: #f7f8f3;
  --rr-surface: #ffffff;
  --rr-surface-soft: #fbfcf8;
  --rr-ink: #1f2933;
  --rr-muted: #607064;
  --rr-faint: #7b897c;
  --rr-border: #dfe5d7;
  --rr-border-soft: #edf1e9;
  --rr-control-border: #cbd7c6;
  --rr-accent: #266854;
  --rr-on-accent: #ffffff;
  --rr-accent-soft: #eef4e9;
  --rr-danger: #b42318;
  --rr-danger-deep: #8f1f17;
  --rr-danger-border: #f0b4ae;
  --rr-removed-ink: #5f3730;
  --rr-removed-bg: #fff7f5;
  --rr-removed-border: #f3d2cc;
  --rr-added-ink: #1f5f4c;
  --rr-added-bg: #f2faf6;
  --rr-added-border: #cfe8dc;
  --rr-radius: 6px;
  --rr-radius-pill: 999px;
  --rr-focus-ring: 0 0 0 2px rgba(38, 104, 84, 0.35);
  --rr-focus-inset: inset 4px 0 0 #266854;
  --rr-shadow-overlay: -16px 0 44px rgba(31, 41, 51, 0.18);
}`;

export function ensureReviewRoomTokens(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(REVIEW_ROOM_TOKEN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = REVIEW_ROOM_TOKEN_STYLE_ID;
  style.textContent = TOKEN_CSS;
  document.head.appendChild(style);
}
