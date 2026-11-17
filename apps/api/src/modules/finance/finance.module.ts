// Owner: Agent C. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Injectable, Module } from '@nestjs/common';
import { LEDGER_SERVICE, type LedgerService, type StudentBalance } from '../../common/contracts';

// SCAFFOLD STUB(S): replace with the real implementation and update the binding below.
@Injectable()
export class StubLedgerService implements LedgerService {
  async balance(studentId: string): Promise<StudentBalance> {
    return { studentId, balancePesewas: 0, currentTermOutstandingPesewas: 0, arrearsPesewas: 0, creditPesewas: 0, lastPaymentAt: null };
  }
  async outstandingByStudent(ids: string[]): Promise<Map<string, number>> { return new Map(ids.map((i) => [i, 0])); }
  async termCollectionSummary(): Promise<{ billedPesewas: number; collectedPesewas: number; outstandingPesewas: number }> {
    return { billedPesewas: 0, collectedPesewas: 0, outstandingPesewas: 0 };
  }
}

@Global()
@Module({
  providers: [{ provide: LEDGER_SERVICE, useClass: StubLedgerService }],
  exports: [LEDGER_SERVICE],
})
export class FinanceModule {}
