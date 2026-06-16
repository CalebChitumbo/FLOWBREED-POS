/**
 * Typed IPC handler registry. Handlers are registered with `registerHandler`
 * (compile-time bound to the contract) and mounted onto `ipcMain.handle` by
 * `mountIpc`. Every handler result is wrapped in an IpcResult envelope so errors
 * never cross the boundary as exceptions (NU-02 plain-language messages).
 */
import { ipcMain } from 'electron';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc/contract';
import { log } from '../logger';

export type IpcHandler<C extends IpcChannel> = (
  request: IpcRequest<C>,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

// Internal storage erases the per-channel request type (handlers are heterogeneous).
// The public `registerHandler` signature below preserves full type safety per channel.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoredHandler = (request: any) => Promise<unknown> | unknown;

const registry = new Map<IpcChannel, StoredHandler>();

export function registerHandler<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void {
  if (registry.has(channel)) {
    throw new Error(`IPC handler already registered for channel: ${channel}`);
  }
  registry.set(channel, handler as StoredHandler);
}

/** Mount all registered handlers onto ipcMain. Call once after registration. */
export function mountIpc(): void {
  for (const [channel, handler] of registry) {
    ipcMain.handle(channel, async (_event, request): Promise<IpcResult<unknown>> => {
      try {
        const data = await handler(request);
        return { ok: true, data };
      } catch (err) {
        const code = (err as { code?: string })?.code ?? 'INTERNAL';
        const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
        log.error(`[ipc] ${channel} failed:`, err);
        return { ok: false, error: { code, message } };
      }
    });
  }
}
