/**
 * In-memory session manager (MAIN only). A successful login mints an opaque
 * random token mapped to the user's identity + role. Tokens live only in memory
 * (gone on app restart). `lastActivity` supports the inactivity model; an optional
 * hard idle cap can auto-invalidate a session server-side.
 */
import { randomBytes } from 'node:crypto';
import type { Role } from '@shared/constants';

export interface Session {
  token: string;
  userId: string;
  username: string;
  role: Role;
  createdAt: number;
  lastActivity: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  /** Optional hard inactivity cap in ms (0 = disabled). */
  constructor(private readonly maxIdleMs = 0) {}

  create(userId: string, username: string, role: Role): Session {
    const now = Date.now();
    const session: Session = {
      token: randomBytes(32).toString('hex'),
      userId,
      username,
      role,
      createdAt: now,
      lastActivity: now,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string): Session | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (this.maxIdleMs > 0 && Date.now() - session.lastActivity > this.maxIdleMs) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  touch(token: string): void {
    const session = this.sessions.get(token);
    if (session) session.lastActivity = Date.now();
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }

  destroyAllForUser(userId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(token);
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}
