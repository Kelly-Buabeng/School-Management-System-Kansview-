import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors, Patch, StreamableFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { parseWith } from '../../common/validation';
import { CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { FIELD_POLICY, type FieldPolicy } from '../../security/field-policy';
import { SCOPE_SERVICE, type ScopeService } from '../../security/scope.service';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import { PDF_SERVICE, type PdfService } from '../../common/contracts';
import { AppError } from '../../common/app-error';
import {
  AdjustmentBody, ClassBalancesQuery, CloseCashUpBody, CreateFeeItemBody, CreateFeeStructureBody, DecideAdjustmentBody, DuplicateCheckQuery,
  GenerateInvoicesBody, ListAdjustmentsQuery, ListFeeStructuresQuery, ListInvoicesQuery, ListPaymentsQuery, OpenCashUpBody, ReallocatePaymentBody,
  RecordPaymentBody, ReplaceFeeStructureLinesBody, ReverseAdjustmentBody, ReversePaymentBody, SetOptionalItemsBody, StatementQuery, UpdateFeeItemBody,
  VoidInvoiceBody, parseId,
} from './dto';
import { z } from 'zod';
import { FeeStructuresService } from './fee-structures.service';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';
import { AdjustmentsService } from './adjustments.service';
import { LedgerServiceImpl } from './ledger.service';
import { CashUpsService } from './cash-ups.service';
import { assertStudentInScope } from './support';

function sendPdf(res: Response, buf: Buffer, filename: string): StreamableFile {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return new StreamableFile(buf);
}

@Controller()
export class FeesController {
  constructor(private readonly fees: FeeStructuresService) {}

  @Get('fee-items') @RequirePermission('fee_structures:read')
  listItems() { return this.fees.listFeeItems(); }

  @Post('fee-items') @RequirePermission('fee_structures:create')
  createItem(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.fees.createFeeItem(parseWith(CreateFeeItemBody, body), user); }

  @Patch('fee-items/:id') @RequirePermission('fee_structures:update')
  updateItem(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.fees.updateFeeItem(parseId(id, 'fee item'), parseWith(UpdateFeeItemBody, body), user);
  }

  @Get('fee-structures') @RequirePermission('fee_structures:read')
  list(@Query() q: unknown) { return this.fees.list(parseWith(ListFeeStructuresQuery, q).termId); }

  @Post('fee-structures') @RequirePermission('fee_structures:create')
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.fees.create(parseWith(CreateFeeStructureBody, body), user); }

  @Get('fee-structures/:id') @RequirePermission('fee_structures:read')
  get(@Param('id') id: string) { return this.fees.get(parseId(id, 'fee structure')); }

  @Put('fee-structures/:id') @RequirePermission('fee_structures:update')
  replace(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.fees.replaceLines(parseId(id, 'fee structure'), parseWith(ReplaceFeeStructureLinesBody, body), user);
  }

  @Post('fee-structures/:id/activate') @HttpCode(200) @RequirePermission('fee_structures:activate')
  activate(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.fees.activate(parseId(id, 'fee structure'), user); }

  @Put('students/:id/optional-items') @RequirePermission('fee_structures:update')
  optional(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.fees.setOptionalItems(parseId(id, 'student'), parseWith(SetOptionalItemsBody, body), user);
  }
}

@Controller()
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post('invoices/generate') @RequirePermission('invoices:create')
  async generate(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const r = await this.invoices.generate(parseWith(GenerateInvoicesBody, body), key, user);
    res.status(r.status);
    return r.body;
  }

  @Get('invoices') @RequirePermission('invoices:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.invoices.list(parseWith(ListInvoicesQuery, q), user); }

  @Get('invoices/:id') @RequirePermission('invoices:read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.invoices.get(parseId(id, 'invoice'), user); }

  @Post('invoices/:id/void') @HttpCode(200) @RequirePermission('invoices:void')
  void(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.invoices.void(parseId(id, 'invoice'), parseWith(VoidInvoiceBody, body).reason, user);
  }

  @Get('invoices/:id/pdf') @RequirePermission('invoices:export')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return sendPdf(res, await this.invoices.pdf(parseId(id, 'invoice'), user), `invoice-${id}.pdf`);
  }
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService, private readonly ledger: LedgerServiceImpl) {}

  @Get('duplicate-check') @RequirePermission('payments:create')
  duplicateCheck(@Query() q: unknown) { return this.payments.duplicateCheck(parseWith(DuplicateCheckQuery, q)); }

  @Get() @RequirePermission('payments:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.payments.list(parseWith(ListPaymentsQuery, q), user); }

  @Post() @RequirePermission('payments:create')
  async record(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const r = await this.payments.record(parseWith(RecordPaymentBody, body), key, user);
    res.status(r.status);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    else this.ledger.scheduleRefresh();
    return r.body;
  }

  @Get(':id') @RequirePermission('payments:read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.payments.get(parseId(id, 'payment'), user); }

  @Put(':id/attachment') @RequirePermission('payments:create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  attach(@Param('id') id: string, @UploadedFile() file: { originalname: string; buffer: Buffer; mimetype?: string } | undefined, @CurrentUser() user: AuthUser) {
    return this.payments.attach(parseId(id, 'payment'), file, user);
  }

  @Post(':id/reverse') @RequirePermission('payments:reverse')
  async reverse(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const r = await this.payments.reverse(parseId(id, 'payment'), parseWith(ReversePaymentBody, body).reason, key, user);
    res.status(r.status);
    this.ledger.scheduleRefresh();
    return r.body;
  }

  @Post(':id/reverse/approve') @HttpCode(200) @RequirePermission('payments:reverse_approve')
  async approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const r = await this.payments.approveReversal(parseId(id, 'payment'), user);
    this.ledger.scheduleRefresh();
    return r;
  }

  @Post(':id/reallocate') @HttpCode(200) @RequirePermission('payments:create')
  reallocate(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.payments.reallocate(parseId(id, 'payment'), parseWith(ReallocatePaymentBody, body).allocations, user);
  }

  @Get(':id/receipt.pdf') @RequirePermission('payments:read')
  async receipt(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return sendPdf(res, await this.payments.receiptPdf(parseId(id, 'payment'), user), `receipt-${id}.pdf`);
  }
}

@Controller()
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService, private readonly ledger: LedgerServiceImpl) {}

  @Get('adjustments') @RequirePermission('adjustments:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.adjustments.list(parseWith(ListAdjustmentsQuery, q), user); }

  @Post('adjustments') @RequirePermission('adjustments:create')
  async request(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const r = await this.adjustments.request(parseWith(AdjustmentBody, body), key, user);
    res.status(r.status);
    return r.body;
  }

  @Post('adjustments/:id/approve') @HttpCode(200) @RequirePermission('adjustments:approve')
  async approve(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const r = await this.adjustments.approve(parseId(id, 'adjustment'), parseWith(DecideAdjustmentBody, body ?? {}).reason, user);
    this.ledger.scheduleRefresh();
    return r;
  }

  @Post('adjustments/:id/reject') @HttpCode(200) @RequirePermission('adjustments:approve')
  reject(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.adjustments.reject(parseId(id, 'adjustment'), parseWith(DecideAdjustmentBody, body ?? {}).reason, user);
  }

  @Post('adjustments/:id/reverse') @HttpCode(200) @RequirePermission('adjustments:approve')
  async reverse(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const r = await this.adjustments.reverse(parseId(id, 'adjustment'), parseWith(ReverseAdjustmentBody, body).reason, user);
    this.ledger.scheduleRefresh();
    return r;
  }

  @Get('students/:id/sibling-discount-suggestion') @RequirePermission('adjustments:create')
  sibling(@Param('id') id: string, @Query() q: unknown, @CurrentUser() user: AuthUser) {
    return this.adjustments.siblingSuggestions(parseId(id, 'student'), parseWith(z.strictObject({ termId: z.uuid() }), q).termId, user);
  }
}

@Controller()
export class BalancesController {
  constructor(
    private readonly ledger: LedgerServiceImpl,
    @Inject(FIELD_POLICY) private readonly fieldPolicy: FieldPolicy,
    @Inject(SCOPE_SERVICE) private readonly scope: ScopeService,
    @Inject(PDF_SERVICE) private readonly pdf: PdfService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get('students/:id/balance') @RequirePermission('balances:read')
  async balance(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const sid = parseId(id, 'student');
    await assertStudentInScope(this.scope, user, sid);
    await this.ledger.ledger(sid); // 404 when the student does not exist
    const b = await this.ledger.balance(sid);
    return this.fieldPolicy.apply('student_finance', { ...b }, user);
  }

  @Get('students/:id/ledger') @RequirePermission('balances:read')
  async studentLedger(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const sid = parseId(id, 'student');
    await assertStudentInScope(this.scope, user, sid);
    if (!user.permissions.has('payments:read')) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see the full ledger');
    }
    return this.ledger.ledger(sid);
  }

  @Get('students/:id/statement.pdf') @RequirePermission('balances:export')
  async statement(@Param('id') id: string, @Query() q: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const sid = parseId(id, 'student');
    await assertStudentInScope(this.scope, user, sid);
    const { from, to } = parseWith(StatementQuery, q);
    const l = await this.ledger.ledger(sid);
    const entries = l.entries.filter((e) => (!from || e.postedAt.slice(0, 10) >= from) && (!to || e.postedAt.slice(0, 10) <= to));
    const buf = await this.pdf.render('fee_statement', { studentId: sid, from: from ?? null, to: to ?? null, entries, balance: await this.ledger.balance(sid) });
    await this.audit.record({ action: 'export', entityType: 'fee_statement', entityId: sid, studentId: sid }, user);
    return sendPdf(res, buf, `statement-${sid}.pdf`);
  }

  @Get('students/:id/arrears-notice.pdf') @RequirePermission('balances:export')
  async arrears(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const sid = parseId(id, 'student');
    await assertStudentInScope(this.scope, user, sid);
    await this.ledger.ledger(sid);
    const buf = await this.pdf.render('arrears_notice', { studentId: sid, balance: await this.ledger.balance(sid) });
    await this.audit.record({ action: 'export', entityType: 'arrears_notice', entityId: sid, studentId: sid }, user);
    return sendPdf(res, buf, `arrears-${sid}.pdf`);
  }

  @Get('guardians/:guardianId/balance') @RequirePermission('balances:read')
  async guardian(@Param('guardianId') id: string, @CurrentUser() user: AuthUser) {
    const g = await this.ledger.guardianBalance(parseId(id, 'guardian'));
    const visible = [];
    for (const c of g.children) if (await this.scope.canAccessStudent(user, c.studentId)) visible.push(this.fieldPolicy.apply('student_finance', { ...c }, user));
    return { ...g, children: visible };
  }

  @Get('guardians/:guardianId/statement.pdf') @RequirePermission('balances:export')
  async guardianStatement(@Param('guardianId') id: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const gid = parseId(id, 'guardian');
    const g = await this.ledger.guardianBalance(gid);
    const buf = await this.pdf.render('guardian_statement', g as unknown as Record<string, unknown>);
    await this.audit.record({ action: 'export', entityType: 'guardian_statement', entityId: gid }, user);
    return sendPdf(res, buf, `guardian-statement-${gid}.pdf`);
  }

  @Get('balances/classes') @RequirePermission('balances:read')
  classes(@Query() q: unknown) { return this.ledger.classBalances(parseWith(ClassBalancesQuery, q).termId); }

  @Get('balances/school') @RequirePermission('balances:read')
  school() { return this.ledger.schoolBalance(); }
}

@Controller('cash-ups')
export class CashUpsController {
  constructor(private readonly cashUps: CashUpsService) {}

  @Get() @RequirePermission('cash_up:read')
  list() { return this.cashUps.list(); }

  @Post() @RequirePermission('cash_up:create')
  open(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.cashUps.open(parseWith(OpenCashUpBody, body ?? {}), user); }

  @Get(':id') @RequirePermission('cash_up:read')
  get(@Param('id') id: string) { return this.cashUps.get(parseId(id, 'cash-up')); }

  @Post(':id/close') @HttpCode(200) @RequirePermission('cash_up:close')
  close(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const b = parseWith(CloseCashUpBody, body);
    return this.cashUps.close(parseId(id, 'cash-up'), b.countedByMethod, b.notes, user);
  }
}
