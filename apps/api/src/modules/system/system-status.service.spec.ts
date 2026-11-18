import { describe, expect, it } from 'vitest';
import { parseComponentStatus, summarise, type BackupComponentStatus, type DiskStatus } from './system-status.service';

const now = new Date('2026-11-18T10:00:00Z');
const okBase: BackupComponentStatus = parseComponentStatus(
  'base-backup',
  JSON.stringify({ component: 'base-backup', result: 'success', updatedAt: '2026-11-18T01:31:00Z', lastSuccessAt: '2026-11-18T01:31:00Z', lastFailureAt: null, message: 'Backup completed', sizeBytes: 123 }),
);
const disk = (freePercent: number): DiskStatus => ({ label: 'data', path: '/x', totalBytes: 100, freeBytes: freePercent, freePercent, low: freePercent < 15 });
const queueOk = { available: true, pending: 0, failed: 0 };

describe('parseComponentStatus', () => {
  it('keeps known fields and extra members', () => {
    expect(okBase).toMatchObject({ component: 'base-backup', result: 'success', lastSuccessAt: '2026-11-18T01:31:00Z', sizeBytes: 123 });
  });
  it('turns garbage into an unknown result instead of throwing', () => {
    expect(parseComponentStatus('wal', '{not json')).toMatchObject({ component: 'wal', result: 'unknown' });
    expect(parseComponentStatus('wal', JSON.stringify({ result: 'weird' })).result).toBe('unknown');
  });
});

describe('summarise', () => {
  it('is ok with a fresh successful backup and healthy disks and queue', () => {
    const s = summarise([okBase], [disk(60)], queueOk, now);
    expect(s).toMatchObject({ overall: 'ok', problems: [], backup: { lastBackupAt: '2026-11-18T01:31:00Z', backupOverdue: false } });
  });
  it('reports a missing backup', () => {
    const s = summarise([], [disk(60)], queueOk, now);
    expect(s.overall).toBe('problem');
    expect(s.problems[0]).toMatch(/No backup/);
  });
  it('reports an overdue backup (older than 26 h)', () => {
    const old = { ...okBase, lastSuccessAt: '2026-11-16T01:31:00Z' };
    const s = summarise([old], [disk(60)], queueOk, now);
    expect(s.backup.backupOverdue).toBe(true);
    expect(s.problems.join()).toMatch(/more than 26 hours/);
  });
  it('reports a failed backup, other failing components, low disk and failed jobs', () => {
    const failed = { ...okBase, result: 'failure' as const, message: 'Backup FAILED: disk missing' };
    const wal = parseComponentStatus('wal-archiver', JSON.stringify({ result: 'failure', message: 'WAL archiving is failing' }));
    const s = summarise([failed, wal], [disk(5)], { available: true, pending: 3, failed: 2 }, now);
    expect(s.overall).toBe('problem');
    expect(s.problems).toEqual([
      'The last backup failed: Backup FAILED: disk missing',
      'WAL archiving is failing',
      'Disk space is low on the data disk (5% free).',
      '2 background job(s) failed (for example SMS sending).',
    ]);
  });
  it('warns (not problem) while off-site copy waits for internet or the queue is unavailable', () => {
    const offsite = parseComponentStatus('offsite', JSON.stringify({ result: 'waiting', message: 'No internet' }));
    expect(summarise([okBase, offsite], [disk(60)], queueOk, now).overall).toBe('warning');
    expect(summarise([okBase], [disk(60)], { available: false, pending: null, failed: null }, now).overall).toBe('warning');
  });
});
