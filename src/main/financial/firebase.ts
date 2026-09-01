/**
 * Firebase Admin connector. Owns the service-account credential lifecycle
 * (encrypted at rest with Electron safeStorage — never plain text, per the M10
 * plan) and the singleton admin app/Firestore handle that BOTH the sync
 * transport and the FinancialBridge share. The only file in the financial/
 * module that imports Electron or firebase-admin app bootstrap, so everything
 * else stays unit-testable in plain Node.
 */
import { safeStorage } from 'electron';
import { cert, deleteApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { ConfigService } from '../services/config-service';
import { Errors } from '../errors';
import { log } from '../logger';
import { FINHUB_KEYS } from './keys';

const APP_NAME = 'flowbreeds-financial-hub';

export interface CloudHandles {
  firestore: Firestore;
  projectId: string;
}

interface ServiceAccountJson {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

let cached: { app: App; handles: CloudHandles } | null = null;

export function isCloudConfigured(config: ConfigService): boolean {
  return Boolean(config.get(FINHUB_KEYS.credentials));
}

function parseServiceAccount(json: string): Required<ServiceAccountJson> {
  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(json) as ServiceAccountJson;
  } catch {
    throw Errors.validation('That is not valid JSON. Paste the whole service-account file.');
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw Errors.validation(
      'That JSON is missing project_id, client_email or private_key — paste the service-account key file downloaded from the Firebase console.',
    );
  }
  return parsed as Required<ServiceAccountJson>;
}

/** Validate + encrypt + store the service-account JSON. Returns the project id. */
export function storeCredentials(config: ConfigService, serviceAccountJson: string): { projectId: string } {
  const account = parseServiceAccount(serviceAccountJson);
  if (!safeStorage.isEncryptionAvailable()) {
    throw Errors.validation(
      'This computer cannot store the cloud key securely (OS encryption is unavailable). Cloud sync stays off.',
    );
  }
  const encrypted = safeStorage.encryptString(serviceAccountJson);
  config.set(FINHUB_KEYS.credentials, encrypted.toString('base64'));
  config.set(FINHUB_KEYS.projectId, account.project_id);
  return { projectId: account.project_id };
}

/** ConfigService has no delete; an empty value reads as "not configured". */
export function clearCredentials(config: ConfigService): void {
  config.set(FINHUB_KEYS.credentials, '');
  config.set(FINHUB_KEYS.projectId, '');
}

function readCredentials(config: ConfigService): Required<ServiceAccountJson> | null {
  const b64 = config.get(FINHUB_KEYS.credentials);
  if (!b64) return null;
  try {
    const json = safeStorage.decryptString(Buffer.from(b64, 'base64'));
    return parseServiceAccount(json);
  } catch (err) {
    log.error('[finhub] Could not decrypt stored cloud credentials', err);
    return null;
  }
}

/** The shared admin Firestore handle, or null when no credentials are stored. */
export function getCloud(config: ConfigService): CloudHandles | null {
  if (cached) return cached.handles;
  const account = readCredentials(config);
  if (!account) return null;

  // A stale app can survive a hot-reload; reuse it rather than double-init.
  const existing = getApps().find((a) => a.name === APP_NAME);
  const app =
    existing ??
    initializeApp(
      {
        credential: cert({
          projectId: account.project_id,
          clientEmail: account.client_email,
          privateKey: account.private_key,
        }),
      },
      APP_NAME,
    );
  const firestore = getFirestore(app);
  try {
    firestore.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if Firestore was already used on this app — fine.
  }
  cached = { app, handles: { firestore, projectId: account.project_id } };
  return cached.handles;
}

/** Tear down the cached admin app (after credentials change or removal). */
export async function resetCloud(): Promise<void> {
  const app = cached?.app;
  cached = null;
  if (app) await deleteApp(app).catch(() => undefined);
}
