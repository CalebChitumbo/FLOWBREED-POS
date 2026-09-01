/** Financial Hub IPC handlers — connecting this POS to the Flowbreeds Financial
 *  app's Firebase project. Administrator only: this is a Settings-screen feature
 *  that holds cloud credentials and rewrites the branch/shop mapping. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { Errors } from '../errors';
import { readBridgeSettings } from '../financial/bridge';
import { FINHUB_KEYS } from '../financial/keys';
import {
  cloudConfigured,
  cloudProjectId,
  configureCloud,
  disconnectCloud,
  getFinancialBridge,
  getFinancialStore,
} from '../financial/runtime';
import type { FinhubRunResult } from '@shared/ipc/contract';

const tokenStr = z.string().min(1);

export function registerFinhubHandlers(): void {
  registerHandler('finhub:getSettings', (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    const { sessions, config, branches } = getServices();
    authorize(sessions, token, 'administrator');
    const settings = readBridgeSettings(config, branches);
    return {
      configured: cloudConfigured(),
      projectId: cloudProjectId(),
      ...settings,
      lastRunAt: config.get(FINHUB_KEYS.lastRunAt),
      lastRun: config.getJson<FinhubRunResult>(FINHUB_KEYS.lastRunSummary),
    };
  });

  registerHandler('finhub:configure', async (req) => {
    const { token, serviceAccountJson } = z
      .object({ token: tokenStr, serviceAccountJson: z.string().min(2).max(20_000) })
      .parse(req);
    const { sessions, audit } = getServices();
    const session = authorize(sessions, token, 'administrator');
    const result = await configureCloud(serviceAccountJson);
    audit.record({
      userId: session.userId,
      action: 'finhub_configure',
      entityType: 'config',
      newValue: { projectId: result.projectId },
    });
    return result;
  });

  registerHandler('finhub:disconnect', async (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    const { sessions, audit } = getServices();
    const session = authorize(sessions, token, 'administrator');
    await disconnectCloud();
    audit.record({ userId: session.userId, action: 'finhub_disconnect', entityType: 'config' });
    return { ok: true as const };
  });

  registerHandler('finhub:shops', async (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    authorize(getServices().sessions, token, 'administrator');
    const store = getFinancialStore();
    if (!store) throw Errors.validation('Connect to the Financial app first (paste the service-account key).');
    const shops = await store.listShops();
    return shops
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
      .map((s) => ({ id: s.id, name: s.name, kind: String(s.kind ?? 'SHOP'), active: s.active !== false }));
  });

  registerHandler('finhub:setSettings', (req) => {
    const input = z
      .object({
        token: tokenStr,
        shopId: z.string().max(80).optional(),
        terminalId: z.string().min(1).max(40).optional(),
        pullCatalogue: z.boolean().optional(),
        applyDeliveries: z.boolean().optional(),
        pushStock: z.boolean().optional(),
      })
      .parse(req);
    const { sessions, config, audit } = getServices();
    const session = authorize(sessions, input.token, 'administrator');
    if (input.shopId !== undefined) config.set(FINHUB_KEYS.shopId, input.shopId);
    if (input.terminalId !== undefined) config.set(FINHUB_KEYS.terminalId, input.terminalId.trim());
    if (input.pullCatalogue !== undefined)
      config.set(FINHUB_KEYS.pullCatalogue, input.pullCatalogue ? '1' : '0');
    if (input.applyDeliveries !== undefined)
      config.set(FINHUB_KEYS.applyDeliveries, input.applyDeliveries ? '1' : '0');
    if (input.pushStock !== undefined) config.set(FINHUB_KEYS.pushStock, input.pushStock ? '1' : '0');
    audit.record({
      userId: session.userId,
      action: 'finhub_settings',
      entityType: 'config',
      newValue: { shopId: input.shopId, terminalId: input.terminalId },
    });
    return { ok: true as const };
  });

  registerHandler('finhub:syncNow', async (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    authorize(getServices().sessions, token, 'administrator');
    const bridge = getFinancialBridge();
    if (!bridge) throw Errors.validation('Connect to the Financial app first (paste the service-account key).');
    return bridge.run();
  });
}
