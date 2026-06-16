import { useState } from 'react';
import { Alert, Box, Button, Center, Group, PasswordInput, Stack, Text, Title, Paper } from '@mantine/core';
import { useAuthStore } from '../stores/auth';

/** Full-screen lock shown after inactivity; requires the user's password to resume. */
export function LockOverlay() {
  const { user, unlock, logout } = useAuthStore();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await unlock(password);
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box
      pos="fixed"
      inset={0}
      style={{ zIndex: 1000, backdropFilter: 'blur(4px)', background: 'rgba(20,20,20,0.55)' }}
    >
      <Center mih="100vh">
        <Paper withBorder shadow="xl" p="xl" radius="md" w={380}>
          <form onSubmit={submit}>
            <Stack>
              <div>
                <Title order={3}>Screen locked</Title>
                <Text c="dimmed" size="sm">
                  Signed in as {user?.username}. Enter your password to continue.
                </Text>
              </div>
              {error && (
                <Alert color="red" variant="light">
                  {error}
                </Alert>
              )}
              <PasswordInput
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                autoFocus
                required
              />
              <Group justify="space-between">
                <Button variant="subtle" color="gray" onClick={() => void logout()}>
                  Log out
                </Button>
                <Button type="submit" loading={busy}>
                  Unlock
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>
      </Center>
    </Box>
  );
}
