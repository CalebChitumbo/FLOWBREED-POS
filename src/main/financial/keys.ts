/** app_config keys owned by the Financial Hub integration (main process only —
 *  the renderer reads these through the finhub:* IPC handlers, never directly). */
export const FINHUB_KEYS = {
  /** safeStorage-encrypted service-account JSON, base64. */
  credentials: 'finhub.credentials',
  /** Plain project id, for display in Settings. */
  projectId: 'finhub.projectId',
  /** The Financial app shop slug this branch's figures post to. */
  shopId: 'finhub.shopId',
  /** Terminal identity stamped on every pushed day (doc id + updatedBy). */
  terminalId: 'finhub.terminalId',
  /** '1'/'0' toggles. */
  pullCatalogue: 'finhub.pullCatalogue',
  applyDeliveries: 'finhub.applyDeliveries',
  pushStock: 'finhub.pushStock',
  /** High-water marks. */
  lastSaleSyncAt: 'finhub.lastSaleSyncAt',
  lastProductPullAt: 'finhub.lastProductPullAt',
  lastMovementPullAt: 'finhub.lastMovementPullAt',
  lastStockPushAt: 'finhub.lastStockPushAt',
  /** Last run report (JSON BridgeRunResult) for the Settings screen. */
  lastRunAt: 'finhub.lastRunAt',
  lastRunSummary: 'finhub.lastRunSummary',
} as const;
