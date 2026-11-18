// Owner: Agent C. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Module } from '@nestjs/common';
import { LEDGER_SERVICE } from '../../common/contracts';
import { FinanceStore } from './finance-store';
import { FeeStructuresService } from './fee-structures.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';
import { AdjustmentsService } from './adjustments.service';
import { LedgerServiceImpl } from './ledger.service';
import { CashUpsService } from './cash-ups.service';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import {
  AdjustmentsController, BalancesController, CashUpsController, FeesController, InvoicesController, PaymentsController,
} from './finance.controllers';

/**
 * Fees, invoices, manual payments (v1: recorded by the bursar only, no gateway), adjustments, ledger, cash-ups, reports.
 * Global so other modules can inject LEDGER_SERVICE by token.
 */
@Global()
@Module({
  controllers: [FeesController, InvoicesController, PaymentsController, AdjustmentsController, BalancesController, CashUpsController, ReportsController],
  providers: [
    FinanceStore, FeeStructuresService, InvoicesService, PaymentsService, AdjustmentsService, LedgerServiceImpl, CashUpsService, ReportsService,
    { provide: LEDGER_SERVICE, useExisting: LedgerServiceImpl },
  ],
  exports: [LEDGER_SERVICE],
})
export class FinanceModule {}
