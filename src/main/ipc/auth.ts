/** Auth IPC handlers (M1). Requests validated with zod at the boundary. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';

const credentials = z.object({
  username: z.string().min(1, 'Enter a username.').max(64),
  password: z.string().min(1, 'Enter a password.').max(256),
});
const tokenOnly = z.object({ token: z.string().min(1) });

export function registerAuthHandlers(): void {
  registerHandler('auth:bootstrapStatus', () => ({
    needsSetup: getServices().auth.needsSetup(),
  }));

  registerHandler('auth:bootstrapAdmin', (req) => {
    const { username, password } = credentials
      .extend({ password: z.string().min(6, 'Use at least 6 characters.').max(256) })
      .parse(req);
    return getServices().auth.bootstrapAdmin(username, password);
  });

  registerHandler('auth:login', (req) => {
    const { username, password } = credentials.parse(req);
    return getServices().auth.login(username, password);
  });

  registerHandler('auth:logout', (req) => {
    const { token } = tokenOnly.parse(req);
    getServices().auth.logout(token);
    return { ok: true as const };
  });

  registerHandler('auth:current', (req) => {
    const { token } = tokenOnly.parse(req);
    return { user: getServices().auth.current(token) };
  });

  registerHandler('auth:unlock', async (req) => {
    const { token, password } = tokenOnly.extend({ password: z.string().min(1) }).parse(req);
    await getServices().auth.unlock(token, password);
    return { ok: true as const };
  });

  registerHandler('auth:changePassword', async (req) => {
    const { token, oldPassword, newPassword } = tokenOnly
      .extend({
        oldPassword: z.string().min(1),
        newPassword: z.string().min(6, 'Use at least 6 characters.').max(256),
      })
      .parse(req);
    await getServices().auth.changePassword(token, oldPassword, newPassword);
    return { ok: true as const };
  });

  registerHandler('auth:authorizeManager', async (req) => {
    const { token, username, password } = tokenOnly
      .extend({ username: z.string().min(1), password: z.string().min(1) })
      .parse(req);
    // Caller must be an authenticated user (e.g. the cashier requesting an override).
    authorize(getServices().sessions, token);
    return getServices().auth.authorizeManager(username, password);
  });
}
