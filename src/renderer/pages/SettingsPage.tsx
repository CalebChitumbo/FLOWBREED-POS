import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Group,
  NumberInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { CONFIG_KEYS } from '@shared/constants';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';
import { FinancialHubCard } from '../components/FinancialHubCard';

export function SettingsPage() {
  const [branchName, setBranchName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [contact, setContact] = useState('');
  const [printerName, setPrinterName] = useState('');
  const [syncSeconds, setSyncSeconds] = useState(30);
  const [lockMinutes, setLockMinutes] = useState(5);
  const [lowStockDefault, setLowStockDefault] = useState(0);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const branch = await invoke('branch:get', { token: requireToken() });
        setBranchName(branch.name);
        const cfg = await invoke('config:get', {
          token: requireToken(),
          keys: [
            CONFIG_KEYS.receiptHeader,
            CONFIG_KEYS.printerName,
            CONFIG_KEYS.syncIntervalMs,
            CONFIG_KEYS.lockTimeoutMs,
            CONFIG_KEYS.lowStockDefault,
            'backup.lastAt',
          ],
        });
        if (cfg[CONFIG_KEYS.receiptHeader]) {
          const header = JSON.parse(cfg[CONFIG_KEYS.receiptHeader]!) as {
            businessName?: string;
            address?: string;
            contact?: string;
          };
          setBusinessName(header.businessName ?? '');
          setAddress(header.address ?? '');
          setContact(header.contact ?? '');
        }
        setPrinterName(cfg[CONFIG_KEYS.printerName] ?? '');
        if (cfg[CONFIG_KEYS.syncIntervalMs]) setSyncSeconds(Number(cfg[CONFIG_KEYS.syncIntervalMs]) / 1000);
        if (cfg[CONFIG_KEYS.lockTimeoutMs]) setLockMinutes(Number(cfg[CONFIG_KEYS.lockTimeoutMs]) / 60000);
        if (cfg[CONFIG_KEYS.lowStockDefault]) setLowStockDefault(Number(cfg[CONFIG_KEYS.lowStockDefault]));
        setLastBackup(cfg['backup.lastAt']);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  async function save() {
    setError(null);
    setMessage(null);
    try {
      const token = requireToken();
      await invoke('branch:rename', { token, name: branchName });
      await invoke('config:set', {
        token,
        key: CONFIG_KEYS.receiptHeader,
        value: JSON.stringify({ businessName, address, contact }),
      });
      await invoke('config:set', { token, key: CONFIG_KEYS.printerName, value: printerName });
      await invoke('config:set', { token, key: CONFIG_KEYS.syncIntervalMs, value: String(syncSeconds * 1000) });
      await invoke('config:set', { token, key: CONFIG_KEYS.lockTimeoutMs, value: String(lockMinutes * 60000) });
      await invoke('config:set', { token, key: CONFIG_KEYS.lowStockDefault, value: String(lowStockDefault) });
      setMessage('Settings saved. Some changes (sync interval, lock timeout) apply after the next restart.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function backup() {
    setError(null);
    setMessage(null);
    try {
      const { path } = await invoke('backup:run', { token: requireToken() });
      if (path) {
        setMessage(`Backup saved to ${path}`);
        setLastBackup(new Date().toISOString());
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function testPrint() {
    setError(null);
    setMessage(null);
    try {
      const token = requireToken();
      // Use the name in the box even if not saved yet, so trying names is quick.
      await invoke('config:set', { token, key: CONFIG_KEYS.printerName, value: printerName });
      await invoke('print:test', { token });
      setMessage('Test receipt sent to the printer. If nothing came out, check the printer name and its Paper light.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function checkUpdate() {
    setError(null);
    setMessage(null);
    try {
      const { available, version } = await invoke('update:check', { token: requireToken() });
      setMessage(available ? `Update available: v${version}` : 'You are on the latest version.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const backupStale = lastBackup ? Date.now() - new Date(lastBackup).getTime() > 7 * 24 * 3600 * 1000 : true;

  return (
    <Stack maw={680}>
      <Title order={2}>Settings</Title>
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

      <Card withBorder radius="md" p="lg">
        <Stack>
          <Title order={4}>Branch &amp; receipt</Title>
          <TextInput label="Branch name" value={branchName} onChange={(e) => setBranchName(e.currentTarget.value)} />
          <TextInput
            label="Business name (receipt header)"
            value={businessName}
            onChange={(e) => setBusinessName(e.currentTarget.value)}
            placeholder="Flowbreeds Farms Shop"
          />
          <Group grow>
            <TextInput label="Address" value={address} onChange={(e) => setAddress(e.currentTarget.value)} />
            <TextInput label="Contact" value={contact} onChange={(e) => setContact(e.currentTarget.value)} />
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="md" p="lg">
        <Stack>
          <Title order={4}>Hardware &amp; behaviour</Title>
          <Group align="flex-end">
            <TextInput
              style={{ flex: 1 }}
              label="Receipt printer name"
              description='Exactly as shown in Windows "Devices and Printers", e.g. EPSON TM-T88V Receipt'
              value={printerName}
              onChange={(e) => setPrinterName(e.currentTarget.value)}
            />
            <Button variant="light" onClick={testPrint}>
              Print test receipt
            </Button>
          </Group>
          <Group grow>
            <NumberInput
              label="Sync interval (seconds)"
              min={5}
              value={syncSeconds}
              onChange={(v) => setSyncSeconds(typeof v === 'number' ? v : Number(v) || 30)}
            />
            <NumberInput
              label="Auto-lock after (minutes)"
              min={1}
              value={lockMinutes}
              onChange={(v) => setLockMinutes(typeof v === 'number' ? v : Number(v) || 5)}
            />
            <NumberInput
              label="Default low-stock threshold"
              min={0}
              value={lowStockDefault}
              onChange={(v) => setLowStockDefault(typeof v === 'number' ? v : Number(v) || 0)}
            />
          </Group>
        </Stack>
      </Card>

      <Group>
        <Button onClick={save}>Save settings</Button>
      </Group>

      <Divider my="sm" />

      <FinancialHubCard />

      <Divider my="sm" />

      <Card withBorder radius="md" p="lg">
        <Stack>
          <Title order={4}>Backup &amp; updates</Title>
          <Group justify="space-between">
            <div>
              <Text>Local database backup</Text>
              <Text size="sm" c={backupStale ? 'red' : 'dimmed'}>
                {lastBackup ? `Last backup: ${new Date(lastBackup).toLocaleString()}` : 'No backup taken yet'}
                {backupStale ? ' — please back up soon' : ''}
              </Text>
            </div>
            <Button variant="light" onClick={backup}>
              Back up now
            </Button>
          </Group>
          <Group justify="space-between">
            <Text>Software updates</Text>
            <Button variant="light" onClick={checkUpdate}>
              Check for updates
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
