import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { Transaction } from '@shared/types/domain';
import type { SalesReport, StockMovementView } from '@shared/types/report';
import { formatMoney, toMajor } from '@shared/money';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';

function isoStart(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}
function isoEndExclusive(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function todayStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}
function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const [start, setStart] = useState(todayStr(-6));
  const [end, setEnd] = useState(todayStr());

  return (
    <Stack>
      <Title order={2}>Reports</Title>
      <Card withBorder radius="md" p="sm">
        <Group>
          <TextInput
            type="date"
            label="From"
            value={start}
            onChange={(e) => setStart(e.currentTarget.value)}
          />
          <TextInput type="date" label="To" value={end} onChange={(e) => setEnd(e.currentTarget.value)} />
          <Button variant="light" mt="lg" onClick={() => { setStart(todayStr()); setEnd(todayStr()); }}>
            Today
          </Button>
          <Button variant="light" mt="lg" onClick={() => { setStart(todayStr(-6)); setEnd(todayStr()); }}>
            Last 7 days
          </Button>
          <Button variant="light" mt="lg" onClick={() => { setStart(todayStr(-29)); setEnd(todayStr()); }}>
            Last 30 days
          </Button>
        </Group>
      </Card>

      <Tabs defaultValue="sales">
        <Tabs.List>
          <Tabs.Tab value="sales">Sales</Tabs.Tab>
          <Tabs.Tab value="transactions">Transactions</Tabs.Tab>
          <Tabs.Tab value="stock">Stock movements</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="sales" pt="md">
          <SalesTab start={start} end={end} />
        </Tabs.Panel>
        <Tabs.Panel value="transactions" pt="md">
          <TransactionsTab start={start} end={end} />
        </Tabs.Panel>
        <Tabs.Panel value="stock" pt="md">
          <StockTab start={start} end={end} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function SalesTab({ start, end }: { start: string; end: string }) {
  const [report, setReport] = useState<SalesReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(
        await invoke('report:sales', { token: requireToken(), start: isoStart(start), end: isoEndExclusive(end) }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, [start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  function exportCsv() {
    if (!report) return;
    const rows = report.topProducts.map((p) => [p.name, p.quantity, toMajor(p.total)]);
    downloadCsv(`sales-${start}_to_${end}.csv`, toCsv(['Product', 'Quantity', 'Total (K)'], rows));
  }

  if (error) return <Alert color="red" variant="light">{error}</Alert>;
  if (!report) return <Text c="dimmed">Loading…</Text>;

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder radius="md" p="lg">
          <Text c="dimmed">Net revenue</Text>
          <Title order={2}>{formatMoney(report.totalRevenue)}</Title>
        </Card>
        <Card withBorder radius="md" p="lg">
          <Text c="dimmed">Transactions</Text>
          <Title order={2}>{report.transactionCount}</Title>
        </Card>
      </SimpleGrid>

      <Group justify="space-between">
        <Title order={4}>Top products</Title>
        <Button size="xs" variant="default" onClick={exportCsv}>
          Export CSV
        </Button>
      </Group>
      <Table withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Product</Table.Th>
            <Table.Th ta="right">Qty</Table.Th>
            <Table.Th ta="right">Total</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {report.topProducts.map((p) => (
            <Table.Tr key={p.productId}>
              <Table.Td>{p.name}</Table.Td>
              <Table.Td ta="right">{p.quantity}</Table.Td>
              <Table.Td ta="right">{formatMoney(p.total)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Title order={4}>Sales by category</Title>
      <Table withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Category</Table.Th>
            <Table.Th ta="right">Total</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {report.byCategory.map((c) => (
            <Table.Tr key={c.category}>
              <Table.Td>{c.category}</Table.Td>
              <Table.Td ta="right">{formatMoney(c.total)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function TransactionsTab({ start, end }: { start: string; end: string }) {
  const [type, setType] = useState<'all' | 'sale' | 'refund'>('all');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Transaction[]>([]);
  const [detail, setDetail] = useState<Transaction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(
        await invoke('report:transactions', {
          token: requireToken(),
          filter: {
            start: isoStart(start),
            end: isoEndExclusive(end),
            type: type === 'all' ? undefined : type,
            query: query || undefined,
          },
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, [start, end, type, query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string) {
    setDetail(await invoke('sale:get', { token: requireToken(), id }));
  }

  function exportCsv() {
    const data = rows.map((t) => [
      t.reference,
      new Date(t.datetime).toLocaleString(),
      t.type,
      t.paymentMethod,
      toMajor(t.grandTotal),
      t.status,
    ]);
    downloadCsv(
      `transactions-${start}_to_${end}.csv`,
      toCsv(['Reference', 'Date', 'Type', 'Payment', 'Total (K)', 'Status'], data),
    );
  }

  return (
    <Stack>
      {error && <Alert color="red" variant="light">{error}</Alert>}
      <Group justify="space-between">
        <Group>
          <SegmentedControl
            value={type}
            onChange={(v) => setType(v as typeof type)}
            data={[
              { label: 'All', value: 'all' },
              { label: 'Sales', value: 'sale' },
              { label: 'Refunds', value: 'refund' },
            ]}
          />
          <TextInput
            placeholder="Search reference"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </Group>
        <Button size="xs" variant="default" onClick={exportCsv}>
          Export CSV
        </Button>
      </Group>
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Reference</Table.Th>
            <Table.Th>Date</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Payment</Table.Th>
            <Table.Th ta="right">Total</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((t) => (
            <Table.Tr key={t.id}>
              <Table.Td>{t.reference}</Table.Td>
              <Table.Td>{new Date(t.datetime).toLocaleString()}</Table.Td>
              <Table.Td>
                <Badge variant="light" color={t.type === 'refund' ? 'orange' : 'green'}>
                  {t.type}
                </Badge>
              </Table.Td>
              <Table.Td>{t.paymentMethod}</Table.Td>
              <Table.Td ta="right">{formatMoney(t.grandTotal)}</Table.Td>
              <Table.Td>
                <Button size="compact-xs" variant="subtle" onClick={() => openDetail(t.id)}>
                  Details
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Modal opened={!!detail} onClose={() => setDetail(null)} title={`Transaction ${detail?.reference ?? ''}`} centered>
        {detail && (
          <Stack gap="xs">
            <Text c="dimmed">{new Date(detail.datetime).toLocaleString()}</Text>
            <Table>
              <Table.Tbody>
                {(detail.items ?? []).map((it) => (
                  <Table.Tr key={it.id}>
                    <Table.Td>{it.productName}</Table.Td>
                    <Table.Td ta="right">{it.quantity}</Table.Td>
                    <Table.Td ta="right">{formatMoney(it.lineTotal)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Group justify="space-between">
              <Text fw={700}>Total</Text>
              <Text fw={700}>{formatMoney(detail.grandTotal)}</Text>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

function StockTab({ start, end }: { start: string; end: string }) {
  const [rows, setRows] = useState<StockMovementView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(
        await invoke('report:stockMovements', {
          token: requireToken(),
          start: isoStart(start),
          end: isoEndExclusive(end),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, [start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  function exportCsv() {
    const data = rows.map((m) => [
      new Date(m.datetime).toLocaleString(),
      m.productName,
      m.type,
      m.quantity,
      m.reason ?? '',
      m.userName,
    ]);
    downloadCsv(
      `stock-movements-${start}_to_${end}.csv`,
      toCsv(['Date', 'Product', 'Type', 'Quantity', 'Reason', 'User'], data),
    );
  }

  return (
    <Stack>
      {error && <Alert color="red" variant="light">{error}</Alert>}
      <Group justify="flex-end">
        <Button size="xs" variant="default" onClick={exportCsv}>
          Export CSV
        </Button>
      </Group>
      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Date</Table.Th>
            <Table.Th>Product</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th ta="right">Qty</Table.Th>
            <Table.Th>Reason</Table.Th>
            <Table.Th>User</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((m) => (
            <Table.Tr key={m.id}>
              <Table.Td>{new Date(m.datetime).toLocaleString()}</Table.Td>
              <Table.Td>{m.productName}</Table.Td>
              <Table.Td>
                <Badge variant="light" color={m.quantity < 0 ? 'red' : 'green'}>
                  {m.type}
                </Badge>
              </Table.Td>
              <Table.Td ta="right">{m.quantity}</Table.Td>
              <Table.Td>{m.reason ?? '—'}</Table.Td>
              <Table.Td>{m.userName}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
