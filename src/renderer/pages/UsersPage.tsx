import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { User } from '@shared/types/domain';
import type { Role } from '@shared/constants';
import { ROLES } from '@shared/constants';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }));

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, createCtl] = useDisclosure(false);
  const [resetUser, setResetUser] = useState<User | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await invoke('users:list', { token: requireToken() }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(user: User) {
    try {
      await invoke('users:update', { token: requireToken(), id: user.id, active: !user.active });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function changeRole(user: User, role: Role) {
    try {
      await invoke('users:update', { token: requireToken(), id: user.id, role });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Users &amp; Access</Title>
        <Button onClick={createCtl.open}>Add user</Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" onClose={() => setError(null)} withCloseButton>
          {error}
        </Alert>
      )}

      <Table striped highlightOnHover withTableBorder verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Username</Table.Th>
            <Table.Th>Role</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Last login</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {users.map((u) => (
            <Table.Tr key={u.id}>
              <Table.Td fw={500}>{u.username}</Table.Td>
              <Table.Td>
                <Select
                  size="xs"
                  data={ROLE_OPTIONS}
                  value={u.role}
                  onChange={(v) => v && changeRole(u, v as Role)}
                  allowDeselect={false}
                  w={150}
                />
              </Table.Td>
              <Table.Td>
                <Badge color={u.active ? 'green' : 'gray'} variant="light">
                  {u.active ? 'Active' : 'Disabled'}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never'}
                </Text>
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Switch
                    checked={u.active}
                    onChange={() => toggleActive(u)}
                    label="Enabled"
                    size="sm"
                  />
                  <Button size="xs" variant="light" onClick={() => setResetUser(u)}>
                    Reset password
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <CreateUserModal
        opened={createOpen}
        onClose={createCtl.close}
        onCreated={() => {
          createCtl.close();
          void load();
        }}
      />
      <ResetPasswordModal user={resetUser} onClose={() => setResetUser(null)} />
    </Stack>
  );
}

function CreateUserModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('cashier');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await invoke('users:create', { token: requireToken(), username, password, role });
      setUsername('');
      setPassword('');
      setRole('cashier');
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Add user" centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <TextInput
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
          required
        />
        <PasswordInput
          label="Password"
          description="At least 6 characters"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
        />
        <Select
          label="Role"
          data={ROLE_OPTIONS}
          value={role}
          onChange={(v) => v && setRole(v as Role)}
          allowDeselect={false}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!user) return;
    setError(null);
    setBusy(true);
    try {
      await invoke('users:resetPassword', { token: requireToken(), id: user.id, newPassword: password });
      setPassword('');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={!!user} onClose={onClose} title={`Reset password — ${user?.username ?? ''}`} centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <PasswordInput
          label="New password"
          description="At least 6 characters"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Reset
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
