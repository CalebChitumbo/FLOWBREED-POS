/**
 * Authentication + session lifecycle (FU-01, FU-05, NS-01..NS-02).
 * Login verifies the argon2 hash, mints a session token, records the login in the
 * audit log. Unlock re-verifies the same user's password to clear an inactivity lock.
 */
import type { User } from '@shared/types/domain';
import { verifyPassword } from '../security/password';
import type { SessionManager } from '../security/session';
import { AppError, Errors } from '../errors';
import type { AuditService } from './audit-service';
import type { UserService } from './user-service';

export interface LoginResult {
  token: string;
  user: User;
}

export class AuthService {
  constructor(
    private readonly users: UserService,
    private readonly sessions: SessionManager,
    private readonly audit: AuditService,
  ) {}

  needsSetup(): boolean {
    return this.users.count() === 0;
  }

  /** Create the very first administrator (only when no users exist) and log in. */
  async bootstrapAdmin(username: string, password: string): Promise<LoginResult> {
    if (!this.needsSetup()) {
      throw Errors.conflict('Setup has already been completed.');
    }
    await this.users.create({ username, password, role: 'administrator' }, 'system');
    return this.login(username, password);
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const row = this.users.findRowByUsername(username.trim());
    if (!row) throw Errors.authFailed();
    if (row.active !== 1) throw new AppError('ACCOUNT_DISABLED', 'This account has been deactivated.');

    const ok = await verifyPassword(row.password_hash, password);
    if (!ok) throw Errors.authFailed();

    const session = this.sessions.create(row.id, row.username, row.role);
    this.users.recordLogin(row.id);
    this.audit.record({ userId: row.id, action: 'login' });
    return { token: session.token, user: this.users.findById(row.id)! };
  }

  current(token: string): User {
    const session = this.sessions.get(token);
    if (!session) throw Errors.unauthenticated();
    this.sessions.touch(token);
    const user = this.users.findById(session.userId);
    if (!user) throw Errors.unauthenticated();
    return user;
  }

  logout(token: string): void {
    const session = this.sessions.get(token);
    if (session) this.audit.record({ userId: session.userId, action: 'logout' });
    this.sessions.destroy(token);
  }

  /** Re-verify the locked session's own password to resume (FU-05). */
  async unlock(token: string, password: string): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) throw Errors.unauthenticated();
    const row = this.users.findRowByUsername(session.username);
    if (!row || !(await verifyPassword(row.password_hash, password))) {
      throw Errors.authFailed();
    }
    this.sessions.touch(token);
  }

  async changePassword(token: string, oldPassword: string, newPassword: string): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) throw Errors.unauthenticated();
    const row = this.users.findRowByUsername(session.username);
    if (!row || !(await verifyPassword(row.password_hash, oldPassword))) {
      throw Errors.authFailed();
    }
    await this.users.setOwnPassword(session.userId, newPassword);
  }

  /**
   * Verify a manager/administrator's credentials WITHOUT creating a session — used
   * for on-the-spot overrides (e.g. a cashier applying a discount). Returns the
   * authorising manager's id.
   */
  async authorizeManager(username: string, password: string): Promise<{ userId: string; username: string }> {
    const row = this.users.findRowByUsername(username.trim());
    if (!row || row.active !== 1) throw Errors.authFailed();
    if (row.role !== 'manager' && row.role !== 'administrator') throw Errors.forbidden();
    if (!(await verifyPassword(row.password_hash, password))) throw Errors.authFailed();
    return { userId: row.id, username: row.username };
  }
}
