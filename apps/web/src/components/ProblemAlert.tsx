import { Alert, Button, Group, List, Text } from '@mantine/core';
import { ApiError, NetworkError } from '@/api/client';

/** Plain-English title for any error. */
export function errorTitle(error: unknown): string {
  if (error instanceof ApiError) return error.problem.title;
  if (error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}

export function notifyError(error: unknown) {
  return { color: 'red', title: 'Not saved', message: errorTitle(error) } as const;
}

/**
 * Shows a problem+json error (title, detail, field errors, reference number) or a network error.
 * Use `onRetry` only for reads or idempotent saves.
 */
export function ProblemAlert({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  if (!error) return null;
  if (error instanceof NetworkError) {
    return (
      <Alert color="orange" title={title ?? 'No connection to the school server'} role="alert">
        <Text size="sm">{error.message}</Text>
        {onRetry && (
          <Button mt="xs" size="xs" variant="white" color="orange" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Alert>
    );
  }
  const p = error instanceof ApiError ? error.problem : null;
  const color = p && p.status === 403 ? 'grape' : 'red';
  return (
    <Alert color={color} title={title ?? errorTitle(error)} role="alert">
      {title && <Text size="sm" fw={600}>{errorTitle(error)}</Text>}
      {p?.detail && <Text size="sm">{p.detail}</Text>}
      {p?.errors && p.errors.length > 0 && (
        <List size="sm" mt={4}>
          {p.errors.map((e) => (
            <List.Item key={`${e.field}-${e.code}`}>{e.message}</List.Item>
          ))}
        </List>
      )}
      <Group justify="space-between" mt={4}>
        {p?.requestId ? (
          <Text size="xs" c="dimmed">
            Reference for support: {p.requestId}
          </Text>
        ) : (
          <span />
        )}
        {onRetry && (
          <Button size="xs" variant="light" color={color} onClick={onRetry}>
            Try again
          </Button>
        )}
      </Group>
    </Alert>
  );
}
