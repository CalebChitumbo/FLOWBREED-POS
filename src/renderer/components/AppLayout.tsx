import { AppShell, Badge, Button, Group, Menu, NavLink, Text, Title } from '@mantine/core';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { useIdleLock } from '../hooks/useIdleLock';
import { UsersPage } from '../pages/UsersPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';

const DEFAULT_LOCK_MS = 5 * 60 * 1000;

interface NavItem {
  path: string;
  label: string;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/checkout', label: 'Checkout' },
  { path: '/products', label: 'Products' },
  { path: '/inventory', label: 'Inventory' },
  { path: '/sessions', label: 'Till Sessions' },
  { path: '/reports', label: 'Reports' },
  { path: '/users', label: 'Users', adminOnly: true },
  { path: '/settings', label: 'Settings' },
];

function NavItems() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const role = useAuthStore((s) => s.user?.role);
  return (
    <>
      {NAV_ITEMS.filter((i) => !i.adminOnly || role === 'administrator').map((item) => (
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

function Header() {
  const { user, lock, logout } = useAuthStore();
  return (
    <Group h="100%" px="md" justify="space-between">
      <Title order={4}>Flowbreeds POS</Title>
      <Group gap="sm">
        <Badge variant="light" color="gray">
          Offline-first
        </Badge>
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
          <Route
            path="/checkout"
            element={
              <PlaceholderPage
                title="Checkout"
                milestone="M3"
                summary="Scan-to-sell, payments, receipts and refunds will live here."
              />
            }
          />
          <Route
            path="/products"
            element={
              <PlaceholderPage
                title="Products"
                milestone="M2"
                summary="Product catalogue, barcodes and pricing management."
              />
            }
          />
          <Route
            path="/inventory"
            element={
              <PlaceholderPage
                title="Inventory"
                milestone="M4"
                summary="Per-branch stock levels, adjustments, stock-in and low-stock alerts."
              />
            }
          />
          <Route
            path="/sessions"
            element={
              <PlaceholderPage
                title="Till Sessions"
                milestone="M5"
                summary="Open/close cashier sessions with float and end-of-day reconciliation."
              />
            }
          />
          <Route
            path="/reports"
            element={
              <PlaceholderPage
                title="Reports"
                milestone="M6"
                summary="Daily and date-range sales, transaction history and stock movement reports."
              />
            }
          />
          <Route path="/users" element={<AdminOnly element={<UsersPage />} />} />
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

function AdminOnly({ element }: { element: React.ReactElement }) {
  const role = useAuthStore((s) => s.user?.role);
  return role === 'administrator' ? element : <Navigate to="/checkout" replace />;
}

export function AppLayout() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
