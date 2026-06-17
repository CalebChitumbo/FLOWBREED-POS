/**
 * Branch identity (Section 8). Each install is tagged to one branch, stored in
 * app_config. A default "Main Branch" is created on first run; the full setup
 * wizard (M8) lets the owner rename/configure it.
 */
import type { DB } from '../db/connection';
import type { Branch } from '@shared/types/domain';
import { CONFIG_KEYS } from '@shared/constants';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { Errors } from '../errors';
import type { ConfigService } from './config-service';
import type { OutboxService } from './outbox-service';

interface BranchRow {
  id: string;
  name: string;
  details: string | null;
  created_at: string;
  updated_at: string;
}

function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    name: row.name,
    details: row.details,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BranchService {
  constructor(
    private readonly db: DB,
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
  ) {}

  getById(id: string): Branch | undefined {
    const row = this.db.prepare('SELECT * FROM branches WHERE id = ?').get(id) as BranchRow | undefined;
    return row ? toBranch(row) : undefined;
  }

  /** Ensure this install is tagged to a branch; create a default if none exists. */
  ensureDefault(): string {
    const configured = this.config.get(CONFIG_KEYS.branchId);
    if (configured && this.getById(configured)) return configured;

    const any = this.db.prepare('SELECT id FROM branches LIMIT 1').get() as { id: string } | undefined;
    if (any) {
      this.config.set(CONFIG_KEYS.branchId, any.id);
      return any.id;
    }

    const id = newId();
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO branches (id, name, details, created_at, updated_at, sync_status)
           VALUES (?, 'Main Branch', NULL, ?, ?, 'pending')`,
        )
        .run(id, now, now);
      this.outbox.enqueue('branch', id, 'create', { id, name: 'Main Branch' });
    })();
    this.config.set(CONFIG_KEYS.branchId, id);
    this.config.set(CONFIG_KEYS.branchName, 'Main Branch');
    return id;
  }

  getCurrentId(): string {
    const id = this.config.get(CONFIG_KEYS.branchId);
    if (!id) throw Errors.validation('No branch is configured for this install.');
    return id;
  }

  getCurrent(): Branch {
    const branch = this.getById(this.getCurrentId());
    if (!branch) throw Errors.notFound('branch');
    return branch;
  }

  rename(name: string): Branch {
    const id = this.getCurrentId();
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE branches SET name = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`)
        .run(name, now, id);
      this.outbox.enqueue('branch', id, 'update', { id, name });
    })();
    this.config.set(CONFIG_KEYS.branchName, name);
    return this.getCurrent();
  }
}
