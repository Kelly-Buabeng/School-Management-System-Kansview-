// Owner: Agent F. Routes for the `messages` OpenAPI tag.
import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../common/app-error';
import { parseWith } from '../../common/validation';
import { Audited, CurrentUser, RequirePermission, type AuthUser } from '../../security';
import { CreateTemplateBody, ListMessagesQuery, ListRecipientsQuery, SendMessageBody, UpdateTemplateBody } from './messages.schemas';
import { MessagesService } from './messages.service';

const Id = z.uuid();
function parseId(raw: string, what: string): string {
  const r = Id.safeParse(raw);
  if (!r.success) throw AppError.notFound(what);
  return r.data;
}

@Controller('message-templates')
export class MessageTemplatesController {
  constructor(private readonly svc: MessagesService) {}

  @Get()
  @RequirePermission('templates:read')
  list() {
    return this.svc.listTemplates();
  }

  @Post()
  @RequirePermission('templates:create')
  @Audited('create', 'message_template')
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.createTemplate(parseWith(CreateTemplateBody, body), user);
  }

  @Patch(':id')
  @RequirePermission('templates:update')
  @Audited('update', 'message_template')
  update(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') ifMatch: string | undefined, @CurrentUser() user: AuthUser) {
    return this.svc.updateTemplate(parseId(id, 'template'), parseWith(UpdateTemplateBody, body), ifMatch, user);
  }
}

@Controller('messages')
export class MessagesController {
  constructor(private readonly svc: MessagesService) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('messages:send')
  preview(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.preview(parseWith(SendMessageBody, body), user);
  }

  @Get()
  @RequirePermission('messages:read')
  list(@Query() q: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.list(parseWith(ListMessagesQuery, q), user);
  }

  @Post()
  @RequirePermission('messages:send')
  @Audited('create', 'message')
  async send(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.send(parseWith(SendMessageBody, body), key, user);
    res.status(r.status);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return r.body;
  }

  @Get(':id')
  @RequirePermission('messages:read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.get(parseId(id, 'message'), user);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('messages:bulk_approve')
  @Audited('approve', 'message')
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.approve(parseId(id, 'message'), user);
  }

  @Get(':id/recipients')
  @RequirePermission('messages:read')
  recipients(@Param('id') id: string, @Query() q: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.recipients(parseId(id, 'message'), parseWith(ListRecipientsQuery, q), user);
  }

  @Post(':id/retry-failed')
  @HttpCode(202)
  @RequirePermission('messages:send')
  retry(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.retryFailed(parseId(id, 'message'), user);
  }
}
