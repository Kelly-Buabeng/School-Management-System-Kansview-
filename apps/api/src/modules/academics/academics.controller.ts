// Owner: Agent B.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { AcademicsService, ClassPdfQuery, GenerateBody, ListCardsQuery, PublishBody, RemarksBody, SaveScoresBody, ScoresQuery } from './academics.service';

const sendPdf = (res: Response, r: { pdf: Buffer; filename: string }) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(r.pdf);
};

@Controller()
export class AcademicsController {
  constructor(private readonly svc: AcademicsService) {}

  @Get('classes/:id/scores')
  @RequirePermission('academics:read')
  scores(@Param('id') id: string, @Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.getScores(id, parseWith(ScoresQuery, q), user); }

  @Put('classes/:id/scores')
  @RequirePermission('academics:update')
  @Audited('update', 'term_scores')
  save(@Param('id') id: string, @Query() q: unknown, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.saveScores(id, parseWith(ScoresQuery, q), parseWith(SaveScoresBody, body), user);
  }

  @Post('terms/:id/scores/lock')
  @HttpCode(200)
  @RequirePermission('academics:publish')
  @Audited('update', 'term_scores_lock')
  lock(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.lock(id, user); }

  @Post('terms/:id/report-cards/generate')
  @HttpCode(202)
  @RequirePermission('academics:update')
  generate(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.generate(id, parseWith(GenerateBody, body), user); }

  @Get('report-cards')
  @RequirePermission('academics:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.list(user, parseWith(ListCardsQuery, q)); }

  @Post('report-cards/publish')
  @HttpCode(200)
  @RequirePermission('academics:publish')
  @Audited('update', 'report_cards_publish')
  publish(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.publish(parseWith(PublishBody, body), user); }

  @Get('report-cards/class-pdf')
  @RequirePermission('academics:export')
  @Audited('export', 'report_cards_class')
  async classPdf(@Query() q: unknown, @CurrentUser() user: AuthUser, @Res() res: Response) { sendPdf(res, await this.svc.classPdf(parseWith(ClassPdfQuery, q), user)); }

  @Patch('report-cards/:id')
  @RequirePermission('academics:update')
  @Audited('update', 'report_card')
  remarks(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.updateRemarks(id, parseWith(RemarksBody, body), user); }

  @Get('report-cards/:id/pdf')
  @RequirePermission('academics:export')
  @Audited('export', 'report_card')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response) { sendPdf(res, await this.svc.cardPdf(id, user)); }
}
