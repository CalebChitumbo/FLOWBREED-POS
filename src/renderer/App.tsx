import { useEffect, useState } from 'react';
import { Badge, Card, Container, Group, Stack, Text, Title } from '@mantine/core';
import { invoke } from './api/client';
import type { AppInfo } from '@shared/ipc/contract';

/**
 * M0 smoke screen: confirms the renderer ↔ preload ↔ main ↔ SQLite round-trip
 * works (app:info + db:ping). Replaced by the real router/shell in M1.
 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tables, setTables] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke('app:info')
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
    invoke('db:ping')
      .then((r) => setTables(r.tables))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>Flowbreeds POS</Title>
          <Badge color={error ? 'red' : tables ? 'green' : 'gray'} size="lg">
            {error ? 'Error' : tables ? 'Ready' : 'Starting…'}
          </Badge>
        </Group>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="xs">
            <Text fw={600}>System status</Text>
            {error && <Text c="red">{error}</Text>}
            <Group justify="space-between">
              <Text c="dimmed">Version</Text>
              <Text>{info?.version ?? '—'}</Text>
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">Schema version</Text>
              <Text>{info?.schemaVersion ?? '—'}</Text>
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">Platform</Text>
              <Text>{info?.platform ?? '—'}</Text>
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">Local DB tables</Text>
              <Text>{tables ?? '—'}</Text>
            </Group>
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}
