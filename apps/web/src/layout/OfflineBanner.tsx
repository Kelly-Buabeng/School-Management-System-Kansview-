import { Alert } from '@mantine/core';
import { useSyncExternalStore } from 'react';
import { networkStatus } from '@/lib/network';

export function useOnline() {
  return useSyncExternalStore(networkStatus.subscribe, () => networkStatus.online, () => true);
}

/** Shown when the browser is offline OR our last request could not reach the server. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <Alert color="orange" radius={0} py={6} role="status" aria-live="polite" title="No connection to the school server">
      You can keep reading what is on screen. Saves will not go through until the connection is back. Do not re-enter payments until you have checked them.
    </Alert>
  );
}
