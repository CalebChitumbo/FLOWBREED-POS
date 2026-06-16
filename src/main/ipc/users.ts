/** User-management IPC handlers (M1). Administrator-only; gated in MAIN. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { ROLES } from '@shared/constants';

const roleSchema = z.enum(ROLES);

export function registerUserHandlers(): void {
  registerHandler('users:list', (req) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req);
    const { sessions, users } = getServices();
    authorize(sessions, token, 'administrator');
    return users.list();
  });

  registerHandler('users:create', (req) => {
    const { token, username, password, role } = z
      .object({
        token: z.string().min(1),
        username: z.string().min(1).max(64),
        password: z.string().min(6, 'Use at least 6 characters.').max(256),
        role: roleSchema,
      })
      .parse(req);
    const { sessions, users } = getServices();
    const session = authorize(sessions, token, 'administrator');
    return users.create({ username, password, role }, session.userId);
  });

  registerHandler('users:update', (req) => {
    const { token, id, role, active } = z
      .object({
        token: z.string().min(1),
        id: z.string().min(1),
        role: roleSchema.optional(),
        active: z.boolean().optional(),
      })
      .parse(req);
    const { sessions, users } = getServices();
    const session = authorize(sessions, token, 'administrator');
    return users.update(id, { role, active }, session.userId);
  });

  registerHandler('users:resetPassword', async (req) => {
    const { token, id, newPassword } = z
      .object({
        token: z.string().min(1),
        id: z.string().min(1),
        newPassword: z.string().min(6, 'Use at least 6 characters.').max(256),
      })
      .parse(req);
    const { sessions, users } = getServices();
    const session = authorize(sessions, token, 'administrator');
    await users.resetPassword(id, newPassword, session.userId);
    return { ok: true as const };
  });
}
