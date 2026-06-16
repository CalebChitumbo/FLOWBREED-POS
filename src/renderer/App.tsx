import { useEffect } from 'react';
import { Center, Loader } from '@mantine/core';
import { useAuthStore } from './stores/auth';
import { LoginPage } from './pages/LoginPage';
import { BootstrapPage } from './pages/BootstrapPage';
import { AppLayout } from './components/AppLayout';
import { LockOverlay } from './components/LockOverlay';

export function App() {
  const status = useAuthStore((s) => s.status);
  const locked = useAuthStore((s) => s.locked);
  const init = useAuthStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (status === 'loading') {
    return (
      <Center mih="100vh">
        <Loader />
      </Center>
    );
  }
  if (status === 'needsSetup') return <BootstrapPage />;
  if (status === 'unauthenticated') return <LoginPage />;

  return (
    <>
      <AppLayout />
      {locked && <LockOverlay />}
    </>
  );
}
