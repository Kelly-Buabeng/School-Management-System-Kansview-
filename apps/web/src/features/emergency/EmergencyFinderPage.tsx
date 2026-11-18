import { Avatar, Button, Card, Group, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/api/client';
import type { Page, StudentSummary } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { EmptyState, PageHeader, Pill, QueryState } from '@/components/ui';

/** Emergency button target: find the child fast, then open their Emergency View. */
export default function EmergencyFinderPage() {
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q.trim(), 250);
  const query = useQuery({
    queryKey: ['emergency-find', debounced],
    queryFn: ({ signal }) => api.get<Page<StudentSummary>>('/students', { query: { q: debounced, pageSize: 10, status: 'active' }, signal }),
    enabled: debounced.length >= 2,
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Emergency" subtitle="Find the child to see medical alerts and who to call." />
      <Stack maw={720}>
        <TextInput size="lg" label="Child's name or student ID" placeholder="e.g. Kwame Mensah" value={q} onChange={(e) => setQ(e.currentTarget.value)} autoFocus />
        {debounced.length >= 2 && (
          <QueryState query={query} label="Searching…">
            {(d) =>
              d.data.length === 0 ? (
                <EmptyState>No child found.</EmptyState>
              ) : (
                <Stack gap="xs">
                  {d.data.map((s) => (
                    <Card key={s.id} component={Link} to={`/students/${s.id}/emergency`} style={{ textDecoration: 'none', color: 'inherit' }} p="sm">
                      <Group wrap="nowrap">
                        <Avatar src={s.photoUrl} size={44} alt="" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text fw={600}>{s.fullName}</Text>
                          <Text size="sm" c="dimmed">
                            {s.className} · {s.studentCode}
                          </Text>
                        </div>
                        {s.hasMedicalAlert && <Pill tone="arrears">Medical alert</Pill>}
                      </Group>
                    </Card>
                  ))}
                </Stack>
              )
            }
          </QueryState>
        )}
        <Can perm="messages:emergency">
          <Button component={Link} to="/messages?kind=emergency" variant="outline" color="red" size="md" w="fit-content">
            Send a bulk emergency message
          </Button>
        </Can>
      </Stack>
    </>
  );
}
