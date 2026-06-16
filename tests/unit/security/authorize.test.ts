import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../../src/main/security/session';
import { authorize } from '../../../src/main/security/authorize';

describe('authorize (MAIN role gate)', () => {
  it('throws UNAUTHENTICATED for an unknown token', () => {
    const mgr = new SessionManager();
    expect(() => authorize(mgr, 'nope')).toThrowError(/log in again/i);
  });

  it('throws FORBIDDEN when the role is not permitted', () => {
    const mgr = new SessionManager();
    const s = mgr.create('u1', 'cashier1', 'cashier');
    expect(() => authorize(mgr, s.token, 'administrator')).toThrowError(/permission/i);
  });

  it('returns the session when the role is permitted', () => {
    const mgr = new SessionManager();
    const s = mgr.create('u1', 'admin1', 'administrator');
    const session = authorize(mgr, s.token, 'administrator', 'manager');
    expect(session.userId).toBe('u1');
  });

  it('allows any authenticated role when no roles are specified', () => {
    const mgr = new SessionManager();
    const s = mgr.create('u1', 'cashier1', 'cashier');
    expect(authorize(mgr, s.token).role).toBe('cashier');
  });
});
