/**
 * Typed renderer-side IPC client. Thin wrappers over window.api that unwrap the
 * IpcResult envelope: `invoke` resolves the data or throws a friendly Error;
 * `invokeResult` returns the raw envelope for callers that want to handle errors.
 */
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc/contract';

export function invokeResult<C extends IpcChannel>(
  channel: C,
  ...args: IpcRequest<C> extends void ? [] : [request: IpcRequest<C>]
): Promise<IpcResult<IpcResponse<C>>> {
  return window.api.invoke(channel, ...args);
}

export async function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcRequest<C> extends void ? [] : [request: IpcRequest<C>]
): Promise<IpcResponse<C>> {
  const result = await window.api.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
