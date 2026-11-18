// Owner: Agent B. Pure promotion rules (no DB): target class choice, arrears flags, commit checks, undo window.

export type PromotionAction = 'promote' | 'repeat' | 'skip' | 'withdraw' | 'transfer_out' | 'graduate';
export type ArrearsPolicy = 'off' | 'warn' | 'block';

export interface LevelInfo {
  id: string;
  nextLevelId: string | null;
  isFinalLevel: boolean;
}

export interface ClassInfo {
  id: string;
  levelId: string;
  stream: string | null;
  academicYearId: string;
}

/**
 * Default action and target class for a student in `fromClass`:
 * - final level → graduate (no target);
 * - otherwise the class of level.next_level_id in the target year, same stream when such a class exists,
 *   else the only class of that level, else the first by stream (alphabetical). No class → null target (must be fixed).
 */
export function defaultPlacement(
  fromClass: ClassInfo,
  levels: Map<string, LevelInfo>,
  targetYearClasses: ClassInfo[],
): { action: PromotionAction; targetClassId: string | null } {
  const level = levels.get(fromClass.levelId);
  if (!level || level.isFinalLevel || !level.nextLevelId) return { action: 'graduate', targetClassId: null };
  return { action: 'promote', targetClassId: pickClassForLevel(level.nextLevelId, fromClass.stream, targetYearClasses) };
}

export function pickClassForLevel(levelId: string, stream: string | null, classes: ClassInfo[]): string | null {
  const candidates = classes.filter((c) => c.levelId === levelId).sort((a, b) => (a.stream ?? '').localeCompare(b.stream ?? ''));
  if (candidates.length === 0) return null;
  const sameStream = candidates.find((c) => (c.stream ?? null) === (stream ?? null));
  return (sameStream ?? candidates[0]!).id;
}

/** Arrears flag: true when the student owes money and the policy is not off. */
export function arrearsFlag(outstandingPesewas: number, policy: ArrearsPolicy): boolean {
  return policy !== 'off' && outstandingPesewas > 0;
}

/** Which actions need a target class in the new year. */
export function actionNeedsTarget(action: PromotionAction): boolean {
  return action === 'promote' || action === 'repeat' || action === 'skip';
}

/** Student status after the action is committed (unchanged = null). */
export function statusAfter(action: PromotionAction): 'withdrawn' | 'transferred_out' | 'alumni' | null {
  switch (action) {
    case 'withdraw': return 'withdrawn';
    case 'transfer_out': return 'transferred_out';
    case 'graduate': return 'alumni';
    default: return null;
  }
}

/** Status written on the closed (old) enrolment. */
export function closedEnrolmentStatus(action: PromotionAction): 'completed' | 'repeated' | 'withdrawn' {
  if (action === 'repeat') return 'repeated';
  if (action === 'withdraw' || action === 'transfer_out') return 'withdrawn';
  return 'completed';
}

export interface ItemForCheck {
  id: string;
  studentName: string;
  action: PromotionAction;
  targetClassId: string | null;
  arrearsFlag: boolean;
  overrideReason: string | null;
}

export interface CommitProblem {
  itemId: string;
  code: 'NO_TARGET_CLASS' | 'ARREARS_OVERRIDE_REQUIRED' | 'CLASS_OVER_CAPACITY';
  message: string;
}

/**
 * Validates a draft before commit. With policy `block`, every flagged student that would move up (promote/skip)
 * needs an override reason. Capacity is checked per target class (existing open enrolments + incoming).
 */
export function checkCommit(
  items: ItemForCheck[],
  policy: ArrearsPolicy,
  capacity: Map<string, { name: string; capacity: number | null; existing: number }>,
): CommitProblem[] {
  const problems: CommitProblem[] = [];
  const incoming = new Map<string, number>();
  for (const it of items) {
    if (actionNeedsTarget(it.action)) {
      if (!it.targetClassId) {
        problems.push({ itemId: it.id, code: 'NO_TARGET_CLASS', message: `${it.studentName}: choose a class for next year` });
        continue;
      }
      incoming.set(it.targetClassId, (incoming.get(it.targetClassId) ?? 0) + 1);
    }
    if (policy === 'block' && it.arrearsFlag && (it.action === 'promote' || it.action === 'skip') && !it.overrideReason?.trim()) {
      problems.push({ itemId: it.id, code: 'ARREARS_OVERRIDE_REQUIRED', message: `${it.studentName} has unpaid fees: give a reason to promote anyway, or choose another action` });
    }
  }
  for (const [classId, n] of incoming) {
    const c = capacity.get(classId);
    if (c && c.capacity !== null && c.existing + n > c.capacity) {
      problems.push({ itemId: classId, code: 'CLASS_OVER_CAPACITY', message: `${c.name} would have ${c.existing + n} students but its capacity is ${c.capacity}` });
    }
  }
  return problems;
}

export function undoDeadline(committedAt: Date, windowDays: number): Date {
  return new Date(committedAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
}

export function canUndoNow(deadline: Date | null, now: Date = new Date()): boolean {
  return deadline !== null && now.getTime() <= deadline.getTime();
}
