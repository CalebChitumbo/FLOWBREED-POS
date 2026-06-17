import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Divider, Group, Modal, Stack, Table, Text, Title } from '@mantine/core';
import type { OpenSessionView } from '@shared/ipc/contract';
import type { TillSession, TillSessionTotals } from '@shared/types/domain';
import { formatMoney } from '@shared/money';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';

export function SessionsPage() {
  const [sessions, setSessions] = useState<OpenSessionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ session: OpenSessionView; totals: TillSessionTotals } | null>(null);
  const [closed, setClosed] = useState<TillSession | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await invoke('session:listOpen', { token: requireToken() }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function view(session: OpenSessionView) {
    try {
      const totals = await invoke('session:summary', { token: requireToken(), sessionId: session.id });
      setViewing({ session, totals });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function close(sessionId: string) {
    try {
      const result = await invoke('session:close', { token: requireToken(), sessionId });
      setViewing(null);
      setClosed(result);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Till Sessions</Title>
        <Button variant="default" onClick={() => void load()}>
          Refresh
        </Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Table striped highlightOnHover withTableBorder verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Cashier</Table.Th>
            <Table.Th>Opened</Table.Th>
            <Table.Th ta="right">Opening float</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sessions.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={4}>
                <Text c="dimmed" ta="center" py="md">
                  No open sessions.
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {sessions.map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td fw={500}>{s.cashierName}</Table.Td>
              <Table.Td>{new Date(s.openTime).toLocaleString()}</Table.Td>
              <Table.Td ta="right">{formatMoney(s.openingFloat)}</Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Button size="compact-sm" variant="light" onClick={() => view(s)}>
                    View totals
                  </Button>
                  <Button size="compact-sm" color="orange" onClick={() => close(s.id)}>
                    Close
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Modal opened={!!viewing} onClose={() => setViewing(null)} title="Session totals (live)" centered>
        {viewing && (
          <Stack>
            <SummaryRows totals={viewing.totals} openingFloat={viewing.session.openingFloat} />
            <Button color="orange" onClick={() => close(viewing.session.id)}>
              Close this session
            </Button>
          </Stack>
        )}
      </Modal>

      <Modal opened={!!closed} onClose={() => setClosed(null)} title="Session closed" centered>
        {closed?.totals && (
          <Stack>
            <SummaryRows totals={closed.totals} openingFloat={closed.openingFloat} />
            <Button onClick={() => setClosed(null)}>Done</Button>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

function SummaryRows({ totals, openingFloat }: { totals: TillSessionTotals; openingFloat: number }) {
  const expectedCash = openingFloat + totals.totalCash;
  const row = (label: string, value: string) => (
    <Group justify="space-between">
      <Text c="dimmed">{label}</Text>
      <Text>{value}</Text>
    </Group>
  );
  return (
    <Stack gap="xs">
      {row('Transactions', String(totals.txnCount))}
      {row('Net sales', formatMoney(totals.totalSales))}
      <Divider />
      {row('Cash', formatMoney(totals.totalCash))}
      {row('Card', formatMoney(totals.totalCard))}
      {row('Mobile money', formatMoney(totals.totalMobile))}
      {row('Discounts', formatMoney(totals.discountTotal))}
      {row('Voids', String(totals.voidCount))}
      <Divider />
      {row('Opening float', formatMoney(openingFloat))}
      <Group justify="space-between">
        <Text fw={700}>Expected cash in drawer</Text>
        <Text fw={700}>{formatMoney(expectedCash)}</Text>
      </Group>
    </Stack>
  );
}
