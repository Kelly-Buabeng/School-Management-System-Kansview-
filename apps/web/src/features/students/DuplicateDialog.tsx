import { Alert, Anchor, Button, Card, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import type { DuplicateCandidate } from '@/api/types';
import { displayPhone, formatDate } from '@/lib/format';

/**
 * Shown when the server says this child may already be registered (409 STUDENT_POSSIBLE_DUPLICATE).
 * The user must either open the existing record or give a reason why this is a different child.
 */
export function DuplicateDialog({
  opened,
  candidates,
  onCancel,
  onConfirm,
  saving,
}: {
  opened: boolean;
  candidates: DuplicateCandidate[];
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  saving?: boolean;
}) {
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 5;
  return (
    <Modal opened={opened} onClose={onCancel} title="This child may already be registered" size="lg">
      <Stack>
        <Alert color="yellow">Check these records first. Admitting the same child twice creates two fee accounts and two student IDs.</Alert>
        {candidates.map((c) => (
          <Card key={c.id} withBorder>
            <Group justify="space-between" wrap="wrap">
              <div>
                <Text fw={700}>
                  {c.fullName} <Text span c="dimmed" ff="monospace" size="sm">({c.studentCode})</Text>
                </Text>
                <Text size="sm">
                  Born {formatDate(c.dateOfBirth)}
                  {c.className ? ` · ${c.className}` : ''}
                  {c.guardianPhone ? ` · Parent ${displayPhone(c.guardianPhone)}` : ''}
                </Text>
                <Text size="xs" c="dimmed">
                  Matches: {(c.matchReasons ?? ["Similar name and date of birth"]).join(', ')}
                </Text>
              </div>
              <Anchor href={`/students/${c.id}`} target="_blank" rel="noopener">
                Open this record
              </Anchor>
            </Group>
          </Card>
        ))}
        <Textarea
          label="If this is a different child, explain why"
          description="For example: “Different parents — twins share a name with a former pupil.” This is recorded."
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          minRows={2}
          error={reason && !ok ? 'Write at least 5 characters' : undefined}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            Go back and check
          </Button>
          <Button color="orange" disabled={!ok} loading={saving} onClick={() => onConfirm(reason.trim())}>
            Admit as a different child
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
