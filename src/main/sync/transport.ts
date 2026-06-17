/**
 * The sync engine depends on this interface, never on Firebase directly. A real
 * FirestoreTransport (Admin SDK) is wired in M10; InMemoryTransport (tests/dev) and
 * NullTransport (prod until cloud is configured) implement the same contract, so the
 * whole enqueue -> push -> ack -> pull -> conflict lifecycle is testable on Linux.
 */
export interface SyncPushItem {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  doc: Record<string, unknown> | null; // full current row (camelCase); null for delete
  updatedAt: string | null;
}

export interface SyncPullItem {
  entityType: string;
  entityId: string;
  doc: Record<string, unknown>;
  updatedAt: string;
  deleted?: boolean;
}

export interface PushOutcome {
  entityId: string;
  ok: boolean;
  error?: string;
}

export interface SyncTransport {
  isOnline(): boolean | Promise<boolean>;
  push(items: SyncPushItem[]): Promise<PushOutcome[]>;
  pull(entityTypes: string[], since: string | null): Promise<SyncPullItem[]>;
}

/** Default prod transport until a Firebase project is configured (M10): always
 *  offline, so the outbox accumulates safely and nothing is lost. */
export class NullTransport implements SyncTransport {
  isOnline(): boolean {
    return false;
  }
  async push(): Promise<PushOutcome[]> {
    return [];
  }
  async pull(): Promise<SyncPullItem[]> {
    return [];
  }
}
