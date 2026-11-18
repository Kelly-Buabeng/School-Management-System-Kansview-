import { Controller, Get, Inject, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { parseWith } from '../../common/validation';
import { CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { AUDIT_SERVICE, type AuditService } from '../../security/audit.service';
import { AgingQuery, CollectionsQuery, DailyCashUpQuery, DefaultersQuery, ReconciliationQuery } from './dto';
import { ReportsService, type Report } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService, @Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  private async send(res: Response, r: Report, format: 'json' | 'xlsx' | 'pdf', name: string, user: AuthUser): Promise<unknown> {
    await this.audit.record({ action: 'export', entityType: 'finance_report', entityId: null, changes: { report: { after: name }, format: { after: format }, filters: { after: r.filters } } }, user);
    if (format === 'json') return r;
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Cache-Control', 'no-store');
    if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.xlsx"`);
      return new StreamableFile(Buffer.from(await this.reports.toXlsx(r)));
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.pdf"`);
    return new StreamableFile(await this.reports.toPdf(r));
  }

  @Get('collections') @RequirePermission('finance_reports:read')
  async collections(@Query() q: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const p = parseWith(CollectionsQuery, q);
    return this.send(res, await this.reports.collections(p.groupBy, p.from, p.to), p.format, 'collections', user);
  }

  @Get('aging') @RequirePermission('finance_reports:read')
  async aging(@Query() q: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const p = parseWith(AgingQuery, q);
    return this.send(res, await this.reports.aging(), p.format, 'aging', user);
  }

  @Get('defaulters') @RequirePermission('finance_reports:read')
  async defaulters(@Query() q: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const p = parseWith(DefaultersQuery, q);
    return this.send(res, await this.reports.defaulters(p.minOutstandingPesewas, p.classId), p.format, 'defaulters', user);
  }

  @Get('daily-cash-up') @RequirePermission('finance_reports:read')
  async daily(@Query() q: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const p = parseWith(DailyCashUpQuery, q);
    return this.send(res, await this.reports.dailyCashUp(p.date), p.format, 'daily-cash-up', user);
  }

  @Get('reconciliation') @RequirePermission('finance_reports:read')
  async reconciliation(@Query() q: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const p = parseWith(ReconciliationQuery, q);
    return this.send(res, await this.reports.reconciliation(p.from, p.to), p.format, 'reconciliation', user);
  }
}
