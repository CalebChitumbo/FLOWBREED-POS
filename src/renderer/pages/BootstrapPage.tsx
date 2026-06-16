import { useState } from 'react';
import { Alert, Button, Center, PasswordInput, Stack, Text, TextInput, Title, Paper } from '@mantine/core';
import { useAuthStore } from '../stores/auth';

/** First-run minimal admin creation (the full setup wizard arrives in M8). */
export function BootstrapPage() {
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await bootstrap(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center mih="100vh" bg="gray.0">
      <Paper withBorder shadow="md" p="xl" radius="md" w={420}>
        <form onSubmit={submit}>
          <Stack>
            <div>
              <Title order={2}>Welcome to Flowbreeds POS</Title>
              <Text c="dimmed" size="sm">
                Create the administrator account to get started.
              </Text>
            </div>
            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}
            <TextInput
              label="Administrator username"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              required
              autoFocus
            />
            <PasswordInput
              label="Password"
              description="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            <PasswordInput
              label="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              required
            />
            <Button type="submit" loading={busy} fullWidth size="md">
              Create account
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
