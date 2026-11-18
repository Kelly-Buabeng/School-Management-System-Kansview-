// Owner: Agent B.
import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { CreateRunBody, PromotionService, UndoBody, UpdateItemBody } from './promotion.service';

@Controller('promotion-runs')
export class PromotionController {
  constructor(private readonly svc: PromotionService) {}

  @Get()
  @RequirePermission('promotion:read')
  list() { return this.svc.list(); }

  @Post()
  @RequirePermission('promotion:create')
  @Audited('create', 'promotion_run')
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.create(parseWith(CreateRunBody, body), user); }

  @Get(':id')
  @RequirePermission('promotion:read')
  get(@Param('id') id: string) { return this.svc.get(id); }

  @Patch(':id/items/:itemId')
  @RequirePermission('promotion:update')
  update(@Param('id') id: string, @Param('itemId') itemId: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.updateItem(id, itemId, parseWith(UpdateItemBody, body), user);
  }

  @Post(':id/commit')
  @HttpCode(200)
  @RequirePermission('promotion:commit')
  @Audited('update', 'promotion_run')
  commit(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @CurrentUser() user: AuthUser) { return this.svc.commit(id, key, user); }

  @Post(':id/undo')
  @HttpCode(200)
  @RequirePermission('promotion:undo')
  @Audited('update', 'promotion_run')
  undo(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.undo(id, parseWith(UndoBody, body).reason, user); }
}
