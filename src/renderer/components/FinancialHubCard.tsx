/**
 * Settings card for the Financial Hub — the live link between this till and the
 * Flowbreeds Financial bookkeeping app. Connect once with the shared Firebase
 * project's service-account key, map this branch to a Financial shop, and the
 * bridge takes it from there (sales up, catalogue + HQ deliveries down).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import type { FinancialShopView, FinhubRunResult, FinhubSettingsView } from '@shared/ipc/contract';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';

export function FinancialHubCard() {
  const [settings, setSettings] = useState<FinhubSettingsView | null>(null);
  const [shops, setShops] = useState<FinancialShopView[]>([]);
  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const [shopId, setShopId] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState('');
  const [pullCatalogue, setPullCatalogue] = useState(true);
  const [applyDeliveries, setApplyDeliveries] = useState(true);
  const [pushStock, setPushStock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<FinhubRunResult | null>(null);

  const loadShops = useCallback(async () => {
    try {
      setShops(await invoke('finhub:shops', { token: requireToken() }));
    } catch (err) {
      setError(`Could not load the Financial app's shops: ${(err as Error).message}`);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const view = await invoke('finhub:getSettings', { token: requireToken() });
      setSettings(view);
      setShopId(view.shopId);
      setTerminalId(view.terminalId);
      setPullCatalogue(view.pullCatalogue);
      setApplyDeliveries(view.applyDeliveries);
      setPushStock(view.pushStock);
      setLastRun(view.lastRun);
      if (view.configured) void loadShops();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadShops]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function connect() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { projectId } = await invoke('finhub:configure', {
        token: requireToken(),
        serviceAccountJson,
      });
      setServiceAccountJson('');
      setMessage(`Connected to Firebase project "${projectId}". Now choose this branch's shop below.`);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await invoke('finhub:disconnect', { token: requireToken() });
      setMessage('Disconnected. Nothing is pushed to the Financial app until you connect again.');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await invoke('finhub:setSettings', {
        token: requireToken(),
        shopId: shopId ?? '',
        terminalId,
        pullCatalogue,
        applyDeliveries,
        pushStock,
      });
      setMessage('Financial Hub settings saved.');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await invoke('finhub:syncNow', { token: requireToken() });
      setLastRun(result);
      if (result.errors.length > 0) {
        setError(result.errors.join(' '));
      } else {
        setMessage(
          `Synced: ${result.pushedSaleDays.length} day(s) of sales pushed, ` +
            `${result.pulledProducts} product(s) updated from the catalogue, ` +
            `${result.appliedMovements} deliver${result.appliedMovements === 1 ? 'y' : 'ies'} applied, ` +
            `${result.pushedMovements} stock movement(s) pushed.`,
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shopOptions = shops.map((s) => ({
    value: s.id,
    label: `${s.name}${s.kind === 'HQ' ? ' (HQ)' : ''}${s.active ? '' : ' — closed'}`,
  }));
  // Keep a saved mapping selectable even if the shop list failed to load.
  if (shopId && !shopOptions.some((o) => o.value === shopId)) {
    shopOptions.push({ value: shopId, label: shopId });
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Financial Hub (Flowbreeds Financial app)</Title>
          {settings?.configured ? (
            <Badge color="green" variant="light">
              Connected — {settings.projectId}
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              Not connected
            </Badge>
          )}
        </Group>
        <Text size="sm" c="dimmed">
          Links this till to the Flowbreeds Financial bookkeeping app. Each day&apos;s takings are
          posted into the app automatically (no more phoning figures to HQ), the product catalogue
          and prices come down from it, and deliveries recorded at HQ land straight into this
          branch&apos;s stock.
        </Text>

        {error && (
          <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {message && (
          <Alert color="green" variant="light" withCloseButton onClose={() => setMessage(null)}>
            {message}
          </Alert>
        )}

        {!settings?.configured ? (
          <>
            <Textarea
              label="Firebase service-account key (JSON)"
              description="Firebase console → Project settings → Service accounts → Generate new private key. Use the SAME Firebase project as the Financial app. The key is stored encrypted on this computer only."
              placeholder='{ "type": "service_account", "project_id": "...", ... }'
              autosize
              minRows={4}
              maxRows={8}
              value={serviceAccountJson}
              onChange={(e) => setServiceAccountJson(e.currentTarget.value)}
            />
            <Group>
              <Button onClick={connect} loading={busy} disabled={!serviceAccountJson.trim()}>
                Connect
              </Button>
            </Group>
          </>
        ) : (
          <>
            <Select
              label="This branch posts its figures to"
              description="The shop in the Financial app that this till's sales, stock and deliveries belong to"
              placeholder="Choose a shop…"
              data={shopOptions}
              value={shopId}
              onChange={setShopId}
              searchable
            />
            <TextInput
              label="Terminal id"
              description="Stamped on every day pushed to the books. Leave it alone once trading — changing it starts a new set of day records."
              value={terminalId}
              onChange={(e) => setTerminalId(e.currentTarget.value)}
            />
            <Switch
              label="Pull products & prices from the Financial catalogue"
              description="Products and price changes made in the Financial app appear here automatically"
              checked={pullCatalogue}
              onChange={(e) => setPullCatalogue(e.currentTarget.checked)}
            />
            <Switch
              label="Apply HQ-recorded deliveries to this branch's stock"
              description="Supplies and transfers entered in the Financial app update stock on hand here"
              checked={applyDeliveries}
              onChange={(e) => setApplyDeliveries(e.currentTarget.checked)}
            />
            <Switch
              label="Push local stock-ins & adjustments to the books"
              description="Stock received or corrected at this till is recorded in the Financial app too"
              checked={pushStock}
              onChange={(e) => setPushStock(e.currentTarget.checked)}
            />
            <Group>
              <Button onClick={saveSettings} loading={busy}>
                Save hub settings
              </Button>
              <Button variant="light" onClick={syncNow} loading={busy} disabled={!settings.shopId}>
                Sync with Financial app now
              </Button>
              <Button variant="subtle" color="red" onClick={disconnect} loading={busy}>
                Disconnect
              </Button>
            </Group>
            {lastRun && (
              <Stack gap={4}>
                <Text size="sm" c="dimmed">
                  Last sync {new Date(lastRun.ranAt).toLocaleString()}: {lastRun.pushedSaleDays.length}{' '}
                  day(s) pushed, {lastRun.pulledProducts} product(s) updated, {lastRun.appliedMovements}{' '}
                  deliveries applied, {lastRun.pushedMovements} stock movement(s) pushed.
                </Text>
                {lastRun.errors.map((e, i) => (
                  <Text key={`e${i}`} size="sm" c="red">
                    {e}
                  </Text>
                ))}
                {lastRun.warnings.slice(0, 5).map((w, i) => (
                  <Text key={`w${i}`} size="sm" c="orange">
                    {w}
                  </Text>
                ))}
                {lastRun.warnings.length > 5 && (
                  <Text size="sm" c="orange">
                    …and {lastRun.warnings.length - 5} more warning(s).
                  </Text>
                )}
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
