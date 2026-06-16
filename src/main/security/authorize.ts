/**
 * The MAIN-side authorization gate. Every privileged IPC handler calls this with
 * the caller's token and the roles permitted for the action. Renderer-side guards
 * are UX only — this is the real check (NS-02).
 */
import type { Role } from '@shared/constants';
import { Errors } from '../errors';
import type { Session, SessionManager } from './session';

export function authorize(sessions: SessionManager, token: string, ...allowedRoles: Role[]): Session {
  const session = sessions.get(token);
  if (!session) throw Errors.unauthenticated();
  sessions.touch(token);
  if (allowedRoles.length > 0 && !allowedRoles.includes(session.role)) {
    throw Errors.forbidden();
  }
  return session;
}
