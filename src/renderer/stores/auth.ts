import { create } from 'zustand';
import type { User } from '@shared/types/domain';
import { invoke } from '../api/client';

export type AuthStatus = 'loading' | 'needsSetup' | 'unauthenticated' | 'authenticated';

interface AuthState {
  token: string | null;
  user: User | null;
  status: AuthStatus;
  locked: boolean;
  init: () => Promise<void>;
  bootstrap: (username: string, password: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  lock: () => void;
  unlock: (password: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  status: 'loading',
  locked: false,

  async init() {
    const { needsSetup } = await invoke('auth:bootstrapStatus');
    set({ status: needsSetup ? 'needsSetup' : 'unauthenticated' });
  },

  async bootstrap(username, password) {
    const { token, user } = await invoke('auth:bootstrapAdmin', { username, password });
    set({ token, user, status: 'authenticated', locked: false });
  },

  async login(username, password) {
    const { token, user } = await invoke('auth:login', { username, password });
    set({ token, user, status: 'authenticated', locked: false });
  },

  async logout() {
    const { token } = get();
    if (token) {
      try {
        await invoke('auth:logout', { token });
      } catch {
        // best-effort; clear locally regardless
      }
    }
    set({ token: null, user: null, status: 'unauthenticated', locked: false });
  },

  lock() {
    if (get().token) set({ locked: true });
  },

  async unlock(password) {
    const { token } = get();
    if (!token) {
      set({ status: 'unauthenticated', locked: false });
      return;
    }
    await invoke('auth:unlock', { token, password });
    set({ locked: false });
  },
}));

/** Read the current session token (throws if absent — callers are inside the shell). */
export function requireToken(): string {
  const { token } = useAuthStore.getState();
  if (!token) throw new Error('Not authenticated.');
  return token;
}
