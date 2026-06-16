import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../../src/main/security/session';

describe('SessionManager', () => {
  it('creates a session with a unique opaque token', () => {
    const mgr = new SessionManager();
    const a = mgr.create('u1', 'alice', 'cashier');
    const b = mgr.create('u2', 'bob', 'manager');
    expect(a.token).not.toEqual(b.token);
    expect(a.token).toHaveLength(64); // 32 bytes hex
    expect(mgr.get(a.token)?.username).toBe('alice');
  });

  it('destroys a session', () => {
    const mgr = new SessionManager();
    const s = mgr.create('u1', 'alice', 'cashier');
    mgr.destroy(s.token);
    expect(mgr.get(s.token)).toBeUndefined();
  });

  it('destroys all sessions for a user', () => {
    const mgr = new SessionManager();
    const s1 = mgr.create('u1', 'alice', 'cashier');
    const s2 = mgr.create('u1', 'alice', 'cashier');
    mgr.destroyAllForUser('u1');
    expect(mgr.get(s1.token)).toBeUndefined();
    expect(mgr.get(s2.token)).toBeUndefined();
  });

  it('expires a session past the idle cap', () => {
    const mgr = new SessionManager(10); // 10ms cap
    const s = mgr.create('u1', 'alice', 'cashier');
    // Force lastActivity into the past.
    const session = mgr.get(s.token)!;
    session.lastActivity = Date.now() - 1000;
    expect(mgr.get(s.token)).toBeUndefined();
  });
});
