// Owner: Agent B.
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { CancelBody, ClearanceBody, ListWithdrawalsQuery, StartWithdrawalBody, WithdrawalsService } from './withdrawals.service';

@Controller()
export class WithdrawalsController {
  constructor(private readonly svc: WithdrawalsService) {}

  @Post('students/:id/withdrawals')
  @RequirePermission('withdrawals:create')
  @Audited('create', 'withdrawal')
  start(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.start(id, parseWith(StartWithdrawalBody, body), user); }

  @Get('withdrawals')
  @RequirePermission('withdrawals:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.list(user, parseWith(ListWithdrawalsQuery, q)); }

  @Get('withdrawals/:id')
  @RequirePermission('withdrawals:read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.get(id, user); }

  @Put('withdrawals/:id/clearance/:item')
  @RequirePermission('withdrawals:update')
  @Audited('update', 'withdrawal')
  clear(@Param('id') id: string, @Param('item') item: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.setClearance(id, item, parseWith(ClearanceBody, body), user);
  }

  @Post('withdrawals/:id/complete')
  @HttpCode(200)
  @RequirePermission('withdrawals:complete')
  @Audited('update', 'withdrawal')
  complete(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.complete(id, user); }

  @Post('withdrawals/:id/cancel')
  @HttpCode(200)
  @RequirePermission('withdrawals:update')
  @Audited('update', 'withdrawal')
  cancel(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.cancel(id, parseWith(CancelBody, body ?? {}).reason, user); }

  @Get('withdrawals/:id/transfer-letter.pdf')
  @RequirePermission('withdrawals:export')
  @Audited('export', 'transfer_letter')
  async letter(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const { pdf, letterNo } = await this.svc.transferLetter(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="transfer-letter-${letterNo}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }
}
