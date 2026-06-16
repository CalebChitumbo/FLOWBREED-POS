/**
 * THE single IPC contract.
 *
 * `IpcContract` maps every `domain:action` channel to its `{ request, response }`
 * types. The main handler registry, the preload bridge, and the renderer client
 * are all derived from this one map so a call and its handler can never drift.
 *
 * `IpcEvents` maps main -> renderer push channels (`event:*`).
 *
 * As channels are added per milestone, extend `IpcContract` AND the runtime
 * `IPC_CHANNELS` allow-list below (the type map is erased at runtime; the preload
 * needs a concrete list to validate against).
 */

import type { Role } from '../constants';
import type { User } from '../types/domain';

export interface AppInfo {
  name: string;
  version: string;
  schemaVersion: number;
  /** process.platform value, e.g. "win32" | "linux" | "darwin". */
  platform: string;
}

export interface DbPing {
  ok: true;
  tables: number;
}

export interface LoginResult {
  token: string;
  user: User;
}

type Ok = { ok: true };

export interface IpcContract {
  'app:info': { request: void; response: AppInfo };
  'db:ping': { request: void; response: DbPing };

  // ---- Auth (M1) ----
  'auth:bootstrapStatus': { request: void; response: { needsSetup: boolean } };
  'auth:bootstrapAdmin': { request: { username: string; password: string }; response: LoginResult };
  'auth:login': { request: { username: string; password: string }; response: LoginResult };
  'auth:logout': { request: { token: string }; response: Ok };
  'auth:current': { request: { token: string }; response: { user: User } };
  'auth:unlock': { request: { token: string; password: string }; response: Ok };
  'auth:changePassword': {
    request: { token: string; oldPassword: string; newPassword: string };
    response: Ok;
  };

  // ---- Users (M1, administrator only) ----
  'users:list': { request: { token: string }; response: User[] };
  'users:create': {
    request: { token: string; username: string; password: string; role: Role };
    response: User;
  };
  'users:update': {
    request: { token: string; id: string; role?: Role; active?: boolean };
    response: User;
  };
  'users:resetPassword': { request: { token: string; id: string; newPassword: string }; response: Ok };
}

export interface IpcEvents {
  'event:syncStatus': { online: boolean; pending: number };
  'event:lock': { reason: 'inactivity' | 'manual' };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

export type EventChannel = keyof IpcEvents;
export type EventPayload<E extends EventChannel> = IpcEvents[E];

/** Structured error returned to the renderer (NU-02: plain-language messages). */
export interface IpcError {
  code: string;
  message: string;
}

/** Every IPC call resolves to this envelope — never throws across the boundary. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/** Runtime allow-list — keep in sync with `IpcContract` keys. */
export const IPC_CHANNELS = [
  'app:info',
  'db:ping',
  'auth:bootstrapStatus',
  'auth:bootstrapAdmin',
  'auth:login',
  'auth:logout',
  'auth:current',
  'auth:unlock',
  'auth:changePassword',
  'users:list',
  'users:create',
  'users:update',
  'users:resetPassword',
] as const satisfies readonly IpcChannel[];

/** Runtime allow-list — keep in sync with `IpcEvents` keys. */
export const EVENT_CHANNELS = ['event:syncStatus', 'event:lock'] as const satisfies readonly EventChannel[];
