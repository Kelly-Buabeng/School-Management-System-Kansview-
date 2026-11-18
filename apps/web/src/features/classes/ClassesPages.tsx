import { Anchor, Avatar, Badge, Button, Card, Group, Progress, SimpleGrid, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { listOf } from '@/api/normalise';
import { api } from '@/api/client';
import { useClasses } from '@/api/queries';
import type { ClassInfo, ClassStudent, ListResponse } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { EmptyState, PageHeader, QueryState } from '@/components/ui';
import { formatDate } from '@/lib/format';

export function CapacityBar({ c }: { c: ClassInfo }) {
  const pct = Math.min(100, Math.round((c.enrolledCount * 100) / Math.max(1, c.capacity)));
  const color = pct >= 100 ? 'red' : pct >= 90 ? 'orange' : 'blue';
  return (
    <div>
      <Group justify="space-between" mb={2}>
        <Text size="xs">
          {c.enrolledCount} of {c.capacity} places
        </Text>
        {pct >= 100 && <Badge color="red" size="xs">Full</Badge>}
      </Group>
      <Progress value={pct} color={color} aria-label={`${c.name}: ${c.enrolledCount} of ${c.capacity} places filled`} />
    </div>
  );
}

export function ClassListPage() {
  const query = useClasses();
  return (
    <>
      <PageHeader title="Classes" subtitle="This academic year" />
      <QueryState query={query}>
        {(list) => (
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }}>
            {list.map((c) => (
              <Card key={c.id} withBorder component={Link} to={`/classes/${c.id}`} style={{ textDecoration: 'none' }}>
                <Text fw={700} c="blue.8">
                  {c.name}
                </Text>
                <Text size="xs" c="dimmed" mb="xs">
                  {c.classTeacherName ? `Class teacher: ${c.classTeacherName}` : 'No class teacher set'}
                </Text>
                <CapacityBar c={c} />
              </Card>
            ))}
          </SimpleGrid>
        )}
      </QueryState>
    </>
  );
}

export function ClassRollPage() {
  const { id = '' } = useParams();
  const cls = useQuery({ queryKey: ['class', id], queryFn: () => api.get<ClassInfo>('/classes/{id}', { path: { id } }) });
  const roll = useQuery({ queryKey: ['class', id, 'students'], queryFn: () => api.get<unknown>('/classes/{id}/students', { path: { id } }).then(listOf<ClassStudent>) });
  return (
    <QueryState query={cls}>
      {(c) => (
        <>
          <PageHeader
            title={`${c.name} class roll`}
            subtitle={c.classTeacherName ? `Class teacher: ${c.classTeacherName}` : undefined}
            actions={
              <Can perm="attendance:update">
                <Button component={Link} to={`/attendance?classId=${c.id}`}>
                  Take attendance
                </Button>
              </Can>
            }
          />
          <Card withBorder mb="md" maw={360}>
            <CapacityBar c={c} />
          </Card>
          <QueryState query={roll}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState>No students in this class.</EmptyState>
              ) : (
                <div className="table-scroll">
                  <Table striped miw={480}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={60}>No.</Table.Th>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Gender</Table.Th>
                        <Table.Th>Born</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {list.map((s) => (
                        <Table.Tr key={s.id}>
                          <Table.Td>{s.rollNumber}</Table.Td>
                          <Table.Td>
                            <Group gap="xs" wrap="nowrap">
                              <Avatar src={s.photoUrl} size="sm" alt="" />
                              <Anchor component={Link} to={`/students/${s.id}`} size="sm">
                                {s.fullName}
                              </Anchor>
                              {s.hasMedicalAlert && <Badge color="red" size="xs">Medical</Badge>}
                            </Group>
                          </Table.Td>
                          <Table.Td>{s.gender === 'female' ? 'F' : s.gender === 'male' ? 'M' : ''}</Table.Td>
                          <Table.Td>{formatDate(s.dateOfBirth)}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )
            }
          </QueryState>
        </>
      )}
    </QueryState>
  );
}
