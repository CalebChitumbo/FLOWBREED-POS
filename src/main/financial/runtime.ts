/**
 * Financial Hub runtime — owns the cloud-dependent lifecycle for the whole app:
 * which SyncTransport the engine runs on (NullTransport until credentials are
 * stored, FirestoreTransport after), and the FinancialBridge with its timer.
 * Storing or removing credentials rebuilds everything in place, no restart
 * needed. MAIN process only.
 */
import { CONFIG_KEYS } from '@shared/constants';
import type { SyncStatus } from '@shared/ipc/contract';
import type { DB } from '../db/connection';
import type { Services } from '../services';
import { SyncEngine } from '../sync/engine';
import { NullTransport } from '../sync/transport';
import { FirestoreTransport } from '../sync/firestore-transport';
import { setSyncEngine } from '../sync';
import { log } from '../logger';
import { FinancialBridge } from './bridge';
import { FirestoreFinancialStore } from './firestore-store';
import type { FinancialStore } from './types';
import {
  clearCredentials,
  getCloud,
  isCloudConfigured,
  resetCloud,
  storeCredentials,
} from './firebase';
import { FINHUB_KEYS } from './keys';

export interface FinancialRuntimeDeps {
  db: DB;
  services: Services;
  onSyncStatus?: (status: SyncStatus) => void;
}

const FIRST_RUN_DELAY_MS = 5_000;
const MIN_BRIDGE_INTERVAL_MS = 60_000;

let deps: FinancialRuntimeDeps | null = null;
let engine: SyncEngine | null = null;
let bridge: FinancialBridge | null = null;
let store: FinancialStore | null = null;
let bridgeTimer: ReturnType<typeof setInterval> | null = null;

/** Boot (or re-boot) the sync engine + bridge from stored configuration. */
export function initFinancialRuntime(d: FinancialRuntimeDeps): void {
  deps = d;
  rebuild();
}

function rebuild(): void {
  if (!deps) throw new Error('Financial runtime not initialised');
  const { db, services, onSyncStatus } = deps;

  engine?.stop();
  if (bridgeTimer) clearInterval(bridgeTimer);
  bridgeTimer = null;
  bridge = null;
  store = null;

  const cloud = getCloud(services.config);
  const transport = cloud ? new FirestoreTransport(cloud.firestore) : new NullTransport();
  engine = new SyncEngine(db, transport, services.config, onSyncStatus);
  setSyncEngine(engine);
  const interval = services.config.getNumber(CONFIG_KEYS.syncIntervalMs, 30_000);
  engine.start(interval);

  if (cloud) {
    store = new FirestoreFinancialStore(cloud.firestore);
    bridge = new FinancialBridge({
      db,
      config: services.config,
      store,
      branches: services.branches,
      inventory: services.inventory,
      audit: services.audit,
      outbox: services.outbox,
    });
    const bridgeInterval = Math.max(MIN_BRIDGE_INTERVAL_MS, interval * 2);
    bridgeTimer = setInterval(() => void runBridgeQuietly(), bridgeInterval);
    setTimeout(() => void runBridgeQuietly(), FIRST_RUN_DELAY_MS);
    log.info(
      `[finhub] Cloud active (project ${cloud.projectId}); bridge cycle every ${bridgeInterval / 1000}s`,
    );
  } else {
    log.info('[finhub] No cloud credentials stored; outbox accumulates offline (NullTransport)');
  }
}

async function runBridgeQuietly(): Promise<void> {
  const b = bridge;
  if (!b) return;
  try {
    const result = await b.run();
    if (result.errors.length > 0) log.warn(`[finhub] bridge: ${result.errors.join(' | ')}`);
  } catch (err) {
    log.error('[finhub] bridge run failed', err);
  }
}

/** Validate, encrypt and store the service-account JSON, then go live. */
export async function configureCloud(serviceAccountJson: string): Promise<{ projectId: string }> {
  if (!deps) throw new Error('Financial runtime not initialised');
  const out = storeCredentials(deps.services.config, serviceAccountJson);
  await resetCloud();
  rebuild();
  return out;
}

/** Remove credentials and fall back to the offline NullTransport. */
export async function disconnectCloud(): Promise<void> {
  if (!deps) throw new Error('Financial runtime not initialised');
  clearCredentials(deps.services.config);
  await resetCloud();
  rebuild();
}

export function getFinancialBridge(): FinancialBridge | null {
  return bridge;
}

export function getFinancialStore(): FinancialStore | null {
  return store;
}

export function cloudConfigured(): boolean {
  return deps ? isCloudConfigured(deps.services.config) : false;
}

export function cloudProjectId(): string | null {
  return deps?.services.config.get(FINHUB_KEYS.projectId) || null;
}

export function stopFinancialRuntime(): void {
  engine?.stop();
  if (bridgeTimer) clearInterval(bridgeTimer);
  bridgeTimer = null;
}
