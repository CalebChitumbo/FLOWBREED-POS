/**
 * The shape exposed on `window.api` by the preload bridge.
 * Implemented in src/preload/index.ts; consumed (typed) in the renderer.
 */
import type {
  IpcChannel,
  IpcRequest,
  IpcResponse,
  IpcResult,
  EventChannel,
  EventPayload,
} from './contract';

export interface Api {
  /** Invoke a typed request/response channel. Resolves to a result envelope. */
  invoke<C extends IpcChannel>(
    channel: C,
    ...args: IpcRequest<C> extends void ? [] : [request: IpcRequest<C>]
  ): Promise<IpcResult<IpcResponse<C>>>;

  /** Subscribe to a main -> renderer event. Returns an unsubscribe function. */
  on<E extends EventChannel>(event: E, callback: (payload: EventPayload<E>) => void): () => void;
}
