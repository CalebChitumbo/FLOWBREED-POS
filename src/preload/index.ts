/**
 * Preload bridge. Exposes a single frozen, typed `window.api` via contextBridge.
 * The renderer can ONLY reach main through the channels on the runtime allow-lists;
 * no Node / SQLite / fs leaks across. Validates channel names before forwarding.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  EVENT_CHANNELS,
  type IpcChannel,
  type EventChannel,
} from '@shared/ipc/contract';

const channelSet = new Set<string>(IPC_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);

const api = {
  invoke(channel: IpcChannel, request?: unknown) {
    if (!channelSet.has(channel)) {
      return Promise.resolve({
        ok: false as const,
        error: { code: 'BAD_CHANNEL', message: `Unknown IPC channel: ${channel}` },
      });
    }
    return ipcRenderer.invoke(channel, request);
  },

  on(event: EventChannel, callback: (payload: unknown) => void) {
    if (!eventSet.has(event)) return () => {};
    const listener = (_e: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', Object.freeze(api));
