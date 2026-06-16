import { describe, it, expect } from 'vitest';
import { makeServices } from '../helpers/db';

describe('AuthService + UserService (M1)', () => {
  it('reports needsSetup before any user exists, then false after bootstrap', async () => {
    const { services } = makeServices();
    expect(services.auth.needsSetup()).toBe(true);
    await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    expect(services.auth.needsSetup()).toBe(false);
  });

  it('bootstrapAdmin creates an administrator and returns a usable session', async () => {
    const { services } = makeServices();
    const { token, user } = await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    expect(user.role).toBe('administrator');
    expect(services.sessions.get(token)?.userId).toBe(user.id);
  });

  it('refuses a second bootstrap once a user exists', async () => {
    const { services } = makeServices();
    await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    await expect(services.auth.bootstrapAdmin('admin2', 'anotherpass')).rejects.toThrow(/already/i);
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    const { services } = makeServices();
    await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    const res = await services.auth.login('admin', 'sup3rsecret');
    expect(res.user.username).toBe('admin');
    await expect(services.auth.login('admin', 'WRONG')).rejects.toThrow(/incorrect/i);
    await expect(services.auth.login('ghost', 'whatever')).rejects.toThrow(/incorrect/i);
  });

  it('blocks login for a deactivated account', async () => {
    const { services } = makeServices();
    const admin = await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    const cashier = await services.users.create(
      { username: 'cash', password: 'cashpass1', role: 'cashier' },
      admin.user.id,
    );
    services.users.update(cashier.id, { active: false }, admin.user.id);
    await expect(services.auth.login('cash', 'cashpass1')).rejects.toThrow(/deactivated/i);
  });

  it('enforces unique usernames', async () => {
    const { services } = makeServices();
    const admin = await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    await services.users.create({ username: 'dup', password: 'passpass', role: 'cashier' }, admin.user.id);
    await expect(
      services.users.create({ username: 'dup', password: 'passpass', role: 'manager' }, admin.user.id),
    ).rejects.toThrow(/taken/i);
  });

  it('current() validates the session and returns the user', async () => {
    const { services } = makeServices();
    const { token, user } = await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    expect(services.auth.current(token).id).toBe(user.id);
    services.auth.logout(token);
    expect(() => services.auth.current(token)).toThrow(/log in again/i);
  });

  it('unlock re-verifies the password for the locked session', async () => {
    const { services } = makeServices();
    const { token } = await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    await expect(services.auth.unlock(token, 'sup3rsecret')).resolves.toBeUndefined();
    await expect(services.auth.unlock(token, 'nope')).rejects.toThrow(/incorrect/i);
  });

  it('changePassword updates the hash so the new password works', async () => {
    const { services } = makeServices();
    const { token } = await services.auth.bootstrapAdmin('admin', 'oldpass1');
    await services.auth.changePassword(token, 'oldpass1', 'newpass2');
    await expect(services.auth.login('admin', 'oldpass1')).rejects.toThrow();
    await expect(services.auth.login('admin', 'newpass2')).resolves.toMatchObject({
      user: { username: 'admin' },
    });
  });

  it('writes immutable audit entries for login and user creation', async () => {
    const { db, services } = makeServices();
    const admin = await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    await services.users.create({ username: 'cash', password: 'cashpass1', role: 'cashier' }, admin.user.id);
    const actions = (
      db.prepare('SELECT action FROM audit_log ORDER BY datetime').all() as { action: string }[]
    ).map((r) => r.action);
    expect(actions).toContain('login');
    expect(actions).toContain('user_create');
  });

  it('enqueues created users to the sync outbox (pending)', async () => {
    const { db, services } = makeServices();
    await services.auth.bootstrapAdmin('admin', 'sup3rsecret');
    const row = db
      .prepare("SELECT count(*) AS c FROM sync_queue WHERE entity_type = 'user' AND status = 'pending'")
      .get() as { c: number };
    expect(row.c).toBeGreaterThanOrEqual(1);
  });
});
