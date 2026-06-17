import type { SyncEngine } from './engine';

let engine: SyncEngine | null = null;

export function setSyncEngine(instance: SyncEngine): void {
  engine = instance;
}

export function getSyncEngine(): SyncEngine {
  if (!engine) throw new Error('Sync engine not initialised');
  return engine;
}
