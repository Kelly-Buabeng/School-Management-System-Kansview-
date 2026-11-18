import { describe, expect, it } from 'vitest';
import {
  actionNeedsTarget, arrearsFlag, canUndoNow, checkCommit, closedEnrolmentStatus, defaultPlacement, pickClassForLevel,
  statusAfter, undoDeadline, type ClassInfo, type LevelInfo,
} from './promotion-rules';

const levels = new Map<string, LevelInfo>([
  ['p5', { id: 'p5', nextLevelId: 'p6', isFinalLevel: false }],
  ['p6', { id: 'p6', nextLevelId: 'jhs1', isFinalLevel: false }],
  ['jhs3', { id: 'jhs3', nextLevelId: null, isFinalLevel: true }],
]);
const next: ClassInfo[] = [
  { id: 'p6b', levelId: 'p6', stream: 'B', academicYearId: 'y2' },
  { id: 'p6a', levelId: 'p6', stream: 'A', academicYearId: 'y2' },
  { id: 'jhs1', levelId: 'jhs1', stream: null, academicYearId: 'y2' },
];

describe('promotion rules', () => {
  it('promotes to the next level, same stream', () => {
    expect(defaultPlacement({ id: 'x', levelId: 'p5', stream: 'B', academicYearId: 'y1' }, levels, next)).toEqual({ action: 'promote', targetClassId: 'p6b' });
  });
  it('falls back to the first stream, or the single class, when the stream does not exist', () => {
    expect(defaultPlacement({ id: 'x', levelId: 'p5', stream: 'C', academicYearId: 'y1' }, levels, next).targetClassId).toBe('p6a');
    expect(defaultPlacement({ id: 'x', levelId: 'p6', stream: 'A', academicYearId: 'y1' }, levels, next).targetClassId).toBe('jhs1');
    expect(pickClassForLevel('kg1', null, next)).toBeNull();
  });
  it('graduates the final level', () => {
    expect(defaultPlacement({ id: 'x', levelId: 'jhs3', stream: null, academicYearId: 'y1' }, levels, next)).toEqual({ action: 'graduate', targetClassId: null });
  });
  it('flags arrears per policy', () => {
    expect(arrearsFlag(100, 'off')).toBe(false);
    expect(arrearsFlag(100, 'warn')).toBe(true);
    expect(arrearsFlag(0, 'block')).toBe(false);
    expect(arrearsFlag(-500, 'block')).toBe(false);
  });
  it('maps actions to statuses', () => {
    expect(statusAfter('graduate')).toBe('alumni');
    expect(statusAfter('transfer_out')).toBe('transferred_out');
    expect(statusAfter('withdraw')).toBe('withdrawn');
    expect(statusAfter('promote')).toBeNull();
    expect(closedEnrolmentStatus('repeat')).toBe('repeated');
    expect(closedEnrolmentStatus('promote')).toBe('completed');
    expect(closedEnrolmentStatus('transfer_out')).toBe('withdrawn');
    expect(actionNeedsTarget('graduate')).toBe(false);
    expect(actionNeedsTarget('repeat')).toBe(true);
  });
  it('checks commit: block needs override, targets, capacity', () => {
    const cap = new Map([['p6a', { name: 'P6 A', capacity: 2, existing: 1 }]]);
    const problems = checkCommit(
      [
        { id: '1', studentName: 'Ama', action: 'promote', targetClassId: 'p6a', arrearsFlag: true, overrideReason: null },
        { id: '2', studentName: 'Kofi', action: 'promote', targetClassId: 'p6a', arrearsFlag: true, overrideReason: 'Paying in instalments' },
        { id: '3', studentName: 'Esi', action: 'promote', targetClassId: null, arrearsFlag: false, overrideReason: null },
        { id: '4', studentName: 'Yaw', action: 'repeat', targetClassId: 'p5a', arrearsFlag: true, overrideReason: null },
      ],
      'block',
      cap,
    );
    expect(problems.map((p) => [p.itemId, p.code])).toEqual([
      ['1', 'ARREARS_OVERRIDE_REQUIRED'], ['3', 'NO_TARGET_CLASS'], ['p6a', 'CLASS_OVER_CAPACITY'],
    ]);
    expect(checkCommit([{ id: '1', studentName: 'Ama', action: 'promote', targetClassId: 'p6b', arrearsFlag: true, overrideReason: null }], 'warn', new Map())).toEqual([]);
  });
  it('computes the undo window', () => {
    const d = undoDeadline(new Date('2026-08-01T10:00:00Z'), 14);
    expect(d.toISOString()).toBe('2026-08-15T10:00:00.000Z');
    expect(canUndoNow(d, new Date('2026-08-15T09:59:59Z'))).toBe(true);
    expect(canUndoNow(d, new Date('2026-08-15T10:00:01Z'))).toBe(false);
    expect(canUndoNow(null)).toBe(false);
  });
});
