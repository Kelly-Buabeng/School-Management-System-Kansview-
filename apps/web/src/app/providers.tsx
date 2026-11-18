import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { AuthProvider } from '@/auth/AuthContext';
import { theme } from './theme';

export { theme };


export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // School internet drops in and out: always try, and retry only problems that may go away by themselves.
        networkMode: 'always',
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
      // Never retry a save automatically: a repeated payment must be a deliberate, idempotent user action.
      mutations: { networkMode: 'always', retry: false },
    },
  });
}

export function AppProviders({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  return (
    <MantineProvider theme={theme} defaultColorScheme="light">
      <QueryClientProvider client={queryClient}>
        <ModalsProvider labels={{ confirm: 'Confirm', cancel: 'Cancel' }}>
          <Notifications position="top-center" limit={3} />
          <AuthProvider>{children}</AuthProvider>
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
