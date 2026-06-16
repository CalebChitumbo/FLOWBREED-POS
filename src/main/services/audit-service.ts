/**
 * Writes append-only audit entries (FU-04, NS-04). The table is UPDATE/DELETE-proof
 * via triggers; this service is the only writer. Call inside the same transaction
 * as the action being audited where possible.
 */
import type { DB } from '../db/connection';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import type { AuditEntry } from '@shared/types/domain';

export interface AuditInput {
  userId: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

function serialise(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export class AuditService {
  constructor(private readonly db: DB) {}

  record(input: AuditInput): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, old_value, new_value, datetime)
         VALUES (@id, @userId, @action, @entityType, @entityId, @oldValue, @newValue, @datetime)`,
      )
      .run({
        id: newId(),
        userId: input.userId,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        oldValue: serialise(input.oldValue),
        newValue: serialise(input.newValue),
        datetime: nowIso(),
      });
  }

  list(limit = 200): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log ORDER BY datetime DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      action: r.action as string,
      entityType: (r.entity_type as string) ?? null,
      entityId: (r.entity_id as string) ?? null,
      oldValue: (r.old_value as string) ?? null,
      newValue: (r.new_value as string) ?? null,
      datetime: r.datetime as string,
    }));
  }
}
