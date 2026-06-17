import { useEffect, useState } from 'react';
import { AppShell, Badge, Button, Group, Menu, NavLink, Text, Title, Tooltip } from '@mantine/core';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { Role } from '@shared/constants';
import type { SyncStatus } from '@shared/ipc/contract';
import { invoke } from '../api/client';
import { requireToken, useAuthStore } from '../stores/auth';
import { useIdleLock } from '../hooks/useIdleLock';
import { UsersPage } from '../pages/UsersPage';
import { ProductsPage } from '../pages/ProductsPage';
import { CheckoutPage } from '../pages/CheckoutPage';
import { InventoryPage } from '../pages/InventoryPage';
import { SessionsPage } from '../pages/SessionsPage';
import { ReportsPage } from '../pages/ReportsPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';

const DEFAULT_LOCK_MS = 5 * 60 * 1000;
const MANAGER: Role[] = ['manager', 'administrator'];
const ADMIN: Role[] = ['administrator'];

interface NavItem {
  path: string;
  label: string;
  roles?: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { path: '/checkout', label: 'Checkout' },
  { path: '/products', label: 'Products', roles: MANAGER },
  { path: '/inventory', label: 'Inventory', roles: MANAGER },
  { path: '/sessions', label: 'Till Sessions', roles: MANAGER },
  { path: '/reports', label: 'Reports', roles: MANAGER },
  { path: '/users', label: 'Users', roles: ADMIN },
  { path: '/settings', label: 'Settings', roles: ADMIN },
];

function NavItems() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const role = useAuthStore((s) => s.user?.role);
  return (
    <>
      {NAV_ITEMS.filter((i) => !i.roles || (role !== undefined && i.roles.includes(role))).map((item) => (
        <NavLink
          key={item.path}
          label={item.label}
          active={pathname.startsWith(item.path)}
          onClick={() => navigate(item.path)}
        />
      ))}
    </>
  );
}

function SyncIndicator() {
  const [status, setStatus] = useState<SyncStatus>({ online: false, pending: 0 });

  useEffect(() => {
    invoke('sync:status', { token: requireToken() })
      .then(setStatus)
      .catch(() => undefined);
    const off = window.api.on('event:syncStatus', (s) => setStatus(s));
    return off;
  }, []);

  async function syncNow() {
    setStatus(await invoke('sync:now', { token: requireToken() }).catch(() => status));
  }

  const label = status.online ? 'Online' : 'Offline';
  const color = status.online ? 'green' : 'gray';
  return (
    <Tooltip label={status.pending > 0 ? `${status.pending} change(s) waiting to sync` : 'All changes synced'}>
      <Badge
        variant="light"
        color={status.pending > 0 ? 'yellow' : color}
        style={{ cursor: 'pointer' }}
        onClick={() => void syncNow()}
      >
        {label}
        {status.pending > 0 ? ` · ${status.pending} pending` : ''}
      </Badge>
    </Tooltip>
  );
}

function Header() {
  const { user, lock, logout } = useAuthStore();
  return (
    <Group h="100%" px="md" justify="space-between">
      <Title order={4}>Flowbreeds POS</Title>
      <Group gap="sm">
        <SyncIndicator />
        <Menu position="bottom-end" withArrow>
          <Menu.Target>
            <Button variant="subtle">
              {user?.username}{' '}
              <Badge ml="xs" size="sm" variant="light">
                {user?.role}
              </Badge>
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={lock}>Lock screen</Menu.Item>
            <Menu.Item color="red" onClick={() => void logout()}>
              Log out
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Group>
  );
}

function Shell() {
  const lock = useAuthStore((s) => s.lock);
  const locked = useAuthStore((s) => s.locked);
  useIdleLock(DEFAULT_LOCK_MS, lock, !locked);

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'xs' }} padding="md">
      <AppShell.Header>
        <Header />
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        <NavItems />
        <Text size="xs" c="dimmed" mt="auto" p="xs">
          Flowbreeds Farms Shop
        </Text>
      </AppShell.Navbar>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<Navigate to="/checkout" replace />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/products" element={<RoleGuard roles={MANAGER} element={<ProductsPage />} />} />
          <Route path="/inventory" element={<RoleGuard roles={MANAGER} element={<InventoryPage />} />} />
          <Route path="/sessions" element={<RoleGuard roles={MANAGER} element={<SessionsPage />} />} />
          <Route path="/reports" element={<RoleGuard roles={MANAGER} element={<ReportsPage />} />} />
          <Route path="/users" element={<RoleGuard roles={ADMIN} element={<UsersPage />} />} />
          <Route
            path="/settings"
            element={
              <PlaceholderPage
                title="Settings"
                milestone="M8"
                summary="Branch, printer, sync and security configuration."
              />
            }
          />
          <Route path="*" element={<Navigate to="/checkout" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}

function RoleGuard({ roles, element }: { roles: Role[]; element: React.ReactElement }) {
  const role = useAuthStore((s) => s.user?.role);
  return role && roles.includes(role) ? element : <Navigate to="/checkout" replace />;
}

export function AppLayout() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
