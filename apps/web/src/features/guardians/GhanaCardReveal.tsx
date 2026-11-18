import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/api/client';
import { Can } from '@/auth/AuthContext';
import { ProblemAlert } from '@/components/ProblemAlert';

/** Ghana Card is always masked; ADMIN may reveal it with a reason (the reveal is audited). */
export function GhanaCardReveal({ guardianId, last4 }: { guardianId: string; last4?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [full, setFull] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () => api.post<{ ghanaCardNumber: string | null }>('/guardians/{guardianId}/ghana-card/reveal', { path: { guardianId }, body: { reason } }),
    onSuccess: (r) => {
      setFull(r.ghanaCardNumber ?? 'Not recorded');
      setOpen(false);
      setReason('');
      // Hide again after a minute so it is not left on screen.
      setTimeout(() => setFull(null), 60_000);
    },
  });
  if (!last4 && !full) return <Text span>Not recorded</Text>;
  return (
    <Group gap="xs" wrap="wrap">
      <Text span>
        {full ?? `GHA-•••••${last4}-•`}
      </Text>
      {full ? (
        <Button size="compact-xs" variant="subtle" onClick={() => setFull(null)}>
          Hide
        </Button>
      ) : (
        <Can perm="ghana_card:reveal">
          <Button size="compact-xs" variant="default" onClick={() => setOpen(true)}>
            Reveal
          </Button>
        </Can>
      )}
      <Modal opened={open} onClose={() => setOpen(false)} title="Reveal Ghana Card number">
        <Stack>
          <Text size="sm">This is recorded in the audit log with your name and reason.</Text>
          <ProblemAlert error={reveal.error} />
          <Textarea label="Why do you need the full number?" value={reason} onChange={(e) => setReason(e.currentTarget.value)} minRows={2} data-autofocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => reveal.mutate()} loading={reveal.isPending} disabled={reason.trim().length < 5}>
              Reveal
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Group>
  );
}
