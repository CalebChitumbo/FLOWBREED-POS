/// <reference types="vite/client" />
import type { Api } from '@shared/ipc/api';

declare global {
  interface Window {
    api: Api;
  }
}

export {};
