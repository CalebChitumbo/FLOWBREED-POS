import { useState } from 'react';
import { Alert, Button, Center, PasswordInput, Stack, Text, TextInput, Title, Paper } from '@mantine/core';
import { useAuthStore } from '../stores/auth';

export function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center mih="100vh" bg="gray.0">
      <Paper withBorder shadow="md" p="xl" radius="md" w={380}>
        <form onSubmit={submit}>
          <Stack>
            <div>
              <Title order={2}>Flowbreeds POS</Title>
              <Text c="dimmed" size="sm">
                Sign in to start your shift
              </Text>
            </div>
            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}
            <TextInput
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              autoFocus
              required
              data-autofocus
            />
            <PasswordInput
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            <Button type="submit" loading={busy} fullWidth size="md">
              Sign in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
