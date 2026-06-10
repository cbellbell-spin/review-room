// GET-only agent actions are a legacy fallback for sandboxes that cannot send
// POST requests. They perform mutations via GET and accept tokens in query
// strings, so they stay disabled unless explicitly enabled. The same flag
// controls both advertising the routes in agent state and executing them.
export function isGetOnlyActionsEnabled(): boolean {
  return (process.env.PROOF_ADVERTISE_GET_ONLY_ACTIONS || '').trim() === '1';
}
