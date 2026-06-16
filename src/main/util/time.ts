/** Single source of "now" so tests can reason about timestamps. ISO-8601 UTC. */
export function nowIso(): string {
  return new Date().toISOString();
}
