import { useState } from 'react';
import { Alert, Button, Group, Modal, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';

/**
 * Prompts for a manager/administrator's credentials and verifies them WITHOUT
 * starting a new session (NU-03 secondary confirmation for sensitive actions).
 * Calls back with the authorising manager's id.
 */
export function ManagerAuthModal({
  opened,
  title = 'Manager authorisation',
  reason,
  onClose,
  onAuthorized,
}: {
  opened: boolean;
  title?: string;
  reason?: string;
  onClose: () => void;
  onAuthorized: (managerId: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const { userId } = await invoke('auth:authorizeManager', {
        token: requireToken(),
        username,
        password,
      });
      setUsername('');
      setPassword('');
      onAuthorized(userId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered>
      <Stack>
        {reason && <Text c="dimmed">{reason}</Text>}
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <TextInput
          label="Manager username"
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
          autoFocus
        />
        <PasswordInput
          label="Manager password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Authorise
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
