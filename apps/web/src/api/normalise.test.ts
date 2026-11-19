import { describe, expect, it } from 'vitest';
import { normDashboard } from './normalise';

describe('normDashboard (real API shape)', () => {
  it('reads per-class enrolment from `enrolled`, as GET /dashboard returns it', () => {
    const d = normDashboard({
      widgets: {
        enrolmentByClass: {
          totalStudents: 90,
          classes: [
            { classId: 'c1', className: 'Creche', capacity: 30, enrolled: 40, boys: 16, girls: 24 },
            { classId: 'c2', className: 'Nursery', capacity: 45, enrolled: 50, boys: 23, girls: 27 },
          ],
        },
        finance: { termName: 'Term 1', billedPesewas: 1000, collectedPesewas: 600, outstandingPesewas: 400, collectionRatePercent: 60 },
      },
    });
    expect(d.enrolmentByClass).toEqual([
      { className: 'Creche', count: 40, capacity: 30 },
      { className: 'Nursery', count: 50, capacity: 45 },
    ]);
    expect(d.collection).toMatchObject({ collectedPesewas: 600, targetPesewas: 1000 });
  });
});
