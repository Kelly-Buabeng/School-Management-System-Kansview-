import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { CreateUserBody, ListUsersQuery, UpdateUserBody, UsersService } from './users.service';

const uuid = new ParseUUIDPipe({ version: undefined, errorHttpStatusCode: 404 });

/** openapi tag `users`. Every change is audited inside its transaction by UsersService. */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users:read')
  list(@Query() query: unknown) {
    return this.users.list(parseWith(ListUsersQuery, query));
  }

  @Post()
  @RequirePermission('users:create')
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() actor: AuthUser) {
    return this.users.create(parseWith(CreateUserBody, body), actor);
  }

  @Get(':id')
  @RequirePermission('users:read')
  get(@Param('id', uuid) id: string) {
    return this.users.get(id);
  }

  @Patch(':id')
  @RequirePermission('users:update')
  update(@Param('id', uuid) id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser) {
    return this.users.update(id, parseWith(UpdateUserBody, body), actor);
  }

  @Post(':id/force-logout')
  @RequirePermission('users:update')
  @HttpCode(204)
  async forceLogout(@Param('id', uuid) id: string, @CurrentUser() actor: AuthUser) {
    await this.users.forceLogout(id, actor);
  }

  @Post(':id/unlock')
  @RequirePermission('users:update')
  @HttpCode(204)
  async unlock(@Param('id', uuid) id: string, @CurrentUser() actor: AuthUser) {
    await this.users.unlock(id, actor);
  }

  @Post(':id/reset-mfa')
  @RequirePermission('users:update')
  @HttpCode(204)
  async resetMfa(@Param('id', uuid) id: string, @CurrentUser() actor: AuthUser) {
    await this.users.resetMfa(id, actor);
  }

  @Post(':id/reset-password')
  @RequirePermission('users:update')
  @HttpCode(200)
  resetPassword(@Param('id', uuid) id: string, @CurrentUser() actor: AuthUser) {
    return this.users.adminResetPassword(id, actor);
  }
}
