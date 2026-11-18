import { Alert, Badge, Button, Card, FileInput, Group, SegmentedControl, Select, Stack, Stepper, Table, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { listOf } from '@/api/normalise';
import { api, downloadFile, upload } from '@/api/client';
import type { ImportJob, ImportRow, ImportType, ListResponse, Page } from '@/api/types';
import { Can } from '@/auth/AuthContext';
import { notifyError, ProblemAlert } from '@/components/ProblemAlert';
import { EmptyState, PageHeader, QueryState } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';

const TYPES: Record<ImportType, string> = { students_guardians: 'Students and parents', staff: 'Staff', opening_balances: 'Opening fee balances' };
const ROW_COLOURS: Record<ImportRow['status'], string> = { valid: 'green', warning: 'yellow', error: 'red', duplicate: 'orange' };

function Rows({ job }: { job: ImportJob }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('all');
  const rows = useQuery({ queryKey: ['import', job.id, 'rows', status], queryFn: () => api.get<unknown>('/imports/{id}/rows', { path: { id: job.id }, query: { status: status === 'all' ? undefined : status, pageSize: 100 } }).then(listOf<ImportRow>) });
  const resolve = useMutation({
    mutationFn: ({ row, resolution }: { row: number; resolution: string }) => api.patch('/imports/{id}/rows/{rowNumber}', { path: { id: job.id, rowNumber: row }, body: { resolution } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['import', job.id, 'rows'] }),
  });
  return (
    <Stack>
      <SegmentedControl
        value={status}
        onChange={setStatus}
        data={[
          { value: 'all', label: `All (${job.totals.rows})` },
          { value: 'error', label: `Errors (${job.totals.errors})` },
          { value: 'duplicate', label: `Possible duplicates (${job.totals.duplicates})` },
          { value: 'warning', label: `Warnings (${job.totals.warnings})` },
          { value: 'valid', label: `OK (${job.totals.valid})` },
        ]}
        style={{ overflowX: 'auto' }}
      />
      <QueryState query={rows}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>No rows here.</EmptyState>
          ) : (
            <div className="table-scroll">
              <Table fz="sm" miw={760}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Row</Table.Th>
                    <Table.Th>Data</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Problems</Table.Th>
                    <Table.Th>What to do</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.map((r) => (
                    <Table.Tr key={r.rowNumber}>
                      <Table.Td>{r.rowNumber}</Table.Td>
                      <Table.Td>{Object.values(r.data).filter(Boolean).join(' · ')}</Table.Td>
                      <Table.Td>
                        <Badge color={ROW_COLOURS[r.status]} variant="light">
                          {r.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{r.messages.join('; ')}</Table.Td>
                      <Table.Td>
                        {r.status === 'duplicate' ? (
                          <Select
                            size="xs"
                            aria-label={`Resolve row ${r.rowNumber}`}
                            placeholder="Decide…"
                            data={[{ value: 'link_existing', label: `Use existing: ${r.duplicateOf?.label ?? ''}` }, { value: 'create_new', label: 'Create a new record' }, { value: 'skip', label: 'Skip this row' }]}
                            value={r.resolution ?? null}
                            onChange={(v) => v && resolve.mutate({ row: r.rowNumber, resolution: v })}
                          />
                        ) : r.status === 'error' ? (
                          <Text size="xs">Fix in the file and upload again, or it will be skipped</Text>
                        ) : null}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )
        }
      </QueryState>
    </Stack>
  );
}

export default function ImportsPage() {
  const qc = useQueryClient();
  const [type, setType] = useState<ImportType>('students_guardians');
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [commitKey, setCommitKey] = useState(() => newIdempotencyKey('imp'));
  const list = useQuery({ queryKey: ['imports'], queryFn: () => api.get<unknown>('/imports').then(listOf<ImportJob>) });
  const job = useQuery({ queryKey: ['import', jobId], queryFn: () => api.get<ImportJob>('/imports/{id}', { path: { id: jobId! } }), enabled: Boolean(jobId), refetchInterval: (q) => (q.state.data && ['validating', 'committing'].includes(q.state.data.status) ? 2000 : false) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['import', jobId] });
    void qc.invalidateQueries({ queryKey: ['imports'] });
  };
  const up = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append('file', file!);
      fd.append('type', type);
      const j = await upload<ImportJob>('POST', '/imports', {}, fd);
      await api.post('/imports/{id}/validate', { path: { id: j.id } });
      return j;
    },
    onSuccess: (j) => {
      setJobId(j.id);
      setFile(null);
      refresh();
    },
  });
  const commit = useMutation({
    mutationFn: () => api.post('/imports/{id}/commit', { path: { id: jobId! }, idempotencyKey: commitKey }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Import started. Valid rows are being added.' });
      setCommitKey(newIdempotencyKey('imp'));
      refresh();
    },
  });
  const j = job.data;
  const step = !j ? 0 : j.status === 'committed' ? 3 : j.status === 'validated' ? 2 : 1;

  return (
    <>
      <PageHeader title="Import from Excel" subtitle="Upload the school's template, check the preview, fix problems, then import." />
      <Stepper active={step} size="sm" mb="lg" wrap>
        <Stepper.Step label="Upload" />
        <Stepper.Step label="Check" />
        <Stepper.Step label="Fix and import" />
        <Stepper.Step label="Done" />
      </Stepper>
      <Stack>
        {!jobId && (
          <Card withBorder maw={720}>
            <Stack>
              <Select label="What are you importing?" data={Object.entries(TYPES).map(([value, label]) => ({ value, label }))} value={type} onChange={(v) => v && setType(v as ImportType)} allowDeselect={false} />
              <Button variant="subtle" w="fit-content" onClick={() => void downloadFile('/imports/templates/{type}', { type }, {}, `${type}-template.xlsx`).catch((e) => notifications.show(notifyError(e)))}>
                Download the empty template
              </Button>
              <FileInput label="Filled-in file (.xlsx or .csv)" accept=".xlsx,.csv" value={file} onChange={setFile} placeholder="Choose file" />
              <ProblemAlert error={up.error} />
              <Button w="fit-content" disabled={!file} loading={up.isPending} onClick={() => up.mutate()}>
                Upload and check (nothing is saved yet)
              </Button>
            </Stack>
          </Card>
        )}
        {j && (
          <Card withBorder>
            <Group justify="space-between" mb="sm" wrap="wrap">
              <Text fw={700}>
                {j.fileName} — {TYPES[j.type]}
              </Text>
              <Group>
                <Button variant="light" size="xs" onClick={() => void downloadFile('/imports/{id}/error-report.xlsx', { id: j.id }, {}, `${j.fileName}-errors.xlsx`).catch((e) => notifications.show(notifyError(e)))}>
                  Download error report
                </Button>
                <Button variant="default" size="xs" onClick={() => setJobId(null)}>
                  Upload another file
                </Button>
              </Group>
            </Group>
            {j.status === 'committed' ? (
              <Alert color="green" title="Import finished">{j.totals.committed ?? 0} rows were added.</Alert>
            ) : j.status === 'validated' ? (
              <Stack>
                <Rows job={j} />
                {j.totals.errors > 0 && <Alert color="orange">{j.totals.errors} row(s) with errors will be skipped. Download the error report, fix them and upload those rows again later.</Alert>}
                <ProblemAlert error={commit.error} />
                <Can perm="imports:commit" fallback={<Alert color="blue">An administrator must press Import to finish this.</Alert>}>
                  <Button
                    w="fit-content"
                    loading={commit.isPending}
                    onClick={() =>
                      modals.openConfirmModal({
                        title: 'Import the valid rows now?',
                        children: <Text size="sm">{j.totals.valid + j.totals.warnings} row(s) plus resolved duplicates will be added. Rows with errors are skipped.</Text>,
                        labels: { confirm: 'Import', cancel: 'Cancel' },
                        onConfirm: () => commit.mutate(),
                      })
                    }
                  >
                    Import
                  </Button>
                </Can>
              </Stack>
            ) : (
              <Text>Checking the file…</Text>
            )}
          </Card>
        )}
        <QueryState query={list}>
          {(items) => (
            <Table fz="sm" maw={760}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>File</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>When</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((i) => (
                  <Table.Tr key={i.id} onClick={() => setJobId(i.id)} style={{ cursor: 'pointer' }}>
                    <Table.Td>{i.fileName}</Table.Td>
                    <Table.Td>{TYPES[i.type]}</Table.Td>
                    <Table.Td>{formatDateTime(i.createdAt)}</Table.Td>
                    <Table.Td>{i.status}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </QueryState>
      </Stack>
    </>
  );
}
