/** User accounts + roles (FU-01..FU-03). Passwords are argon2id hashes, never plaintext. */
import type { DB } from '../db/connection';
import type { Role } from '@shared/constants';
import type { User } from '@shared/types/domain';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { hashPassword } from '../security/password';
import { Errors } from '../errors';
import type { AuditService } from './audit-service';
import type { OutboxService } from './outbox-service';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  active: number;
  last_login: string | null;
  created_at: string;
  updated_at: string;
  sync_status: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: Role;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    active: row.active === 1,
    lastLogin: row.last_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UserService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  count(): number {
    return (this.db.prepare('SELECT count(*) AS c FROM users').get() as { c: number }).c;
  }

  list(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY username').all() as UserRow[];
    return rows.map(toUser);
  }

  findById(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  /** Internal: includes the password hash — for authentication only. */
  findRowByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  async create(input: CreateUserInput, actorId: string): Promise<User> {
    const username = input.username.trim();
    if (!username) throw Errors.validation('A username is required.');
    if (this.findRowByUsername(username)) {
      throw Errors.conflict(`The username "${username}" is already taken.`);
    }
    const hash = await hashPassword(input.password);
    const id = newId();
    const now = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO users (id, username, password_hash, role, active, created_at, updated_at, sync_status)
           VALUES (?, ?, ?, ?, 1, ?, ?, 'pending')`,
        )
        .run(id, username, hash, input.role, now, now);
      this.outbox.enqueue('user', id, 'create', {
        id,
        username,
        role: input.role,
        active: 1,
        createdAt: now,
        updatedAt: now,
      });
      this.audit.record({
        userId: actorId,
        action: 'user_create',
        entityType: 'user',
        entityId: id,
        newValue: { username, role: input.role },
      });
    })();

    return this.findById(id)!;
  }

  update(id: string, patch: { role?: Role; active?: boolean }, actorId: string): User {
    const existing = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!existing) throw Errors.notFound('user');

    const role = patch.role ?? existing.role;
    const active = patch.active === undefined ? existing.active : patch.active ? 1 : 0;
    const now = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE users SET role = ?, active = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`)
        .run(role, active, now, id);
      this.outbox.enqueue('user', id, 'update', {
        id,
        username: existing.username,
        role,
        active,
        updatedAt: now,
      });
      this.audit.record({
        userId: actorId,
        action: 'user_update',
        entityType: 'user',
        entityId: id,
        oldValue: { role: existing.role, active: existing.active },
        newValue: { role, active },
      });
    })();

    return this.findById(id)!;
  }

  async resetPassword(id: string, newPassword: string, actorId: string): Promise<void> {
    const existing = this.db.prepare('SELECT id FROM users WHERE id = ?').get(id) as { id: string } | undefined;
    if (!existing) throw Errors.notFound('user');
    const hash = await hashPassword(newPassword);
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE users SET password_hash = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`)
        .run(hash, now, id);
      this.audit.record({
        userId: actorId,
        action: 'user_password_reset',
        entityType: 'user',
        entityId: id,
      });
    })();
  }

  /** Updates last_login only (informational; does not bump updated_at / sync). */
  recordLogin(id: string): void {
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowIso(), id);
  }

  async setOwnPassword(id: string, newPassword: string): Promise<void> {
    const hash = await hashPassword(newPassword);
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE users SET password_hash = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`)
        .run(hash, now, id);
      this.audit.record({ userId: id, action: 'password_change', entityType: 'user', entityId: id });
    })();
  }
}
