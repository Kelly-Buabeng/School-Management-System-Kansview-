import { createTheme, MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { AuthProvider } from '@/auth/AuthContext';

export const theme = createTheme({
  primaryColor: 'blue',
  // Shade 8 (#1971c2) on white is 4.6:1, meeting WCAG AA for normal text.
  primaryShade: { light: 8, dark: 6 },
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  defaultRadius: 'md',
  components: {
    Button: { defaultProps: { size: 'sm' } },
    TextInput: { defaultProps: { size: 'sm' } },
  },
});

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
