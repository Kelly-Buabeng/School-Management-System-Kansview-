import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { parseWith } from '../../common/validation';
import { Access, CurrentUser, Public } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { AllowDuringLogin } from '../../security/login-phase.decorator';
import { clientIp } from '../../security/request-context';
import { readSessionCookie } from '../../security/session-resolver.impl';
import { SESSION_COOKIE, SessionService, type NewSession } from '../../security/session.service';
import { AuthService, type ClientInfo } from './auth.service';
import { LoginBody, MfaCodeBody, MfaDisableBody, PasswordChangeBody, ResetBody, ResetRequestBody } from './auth.dto';

/** openapi tag `auth`. Audit events are written by AuthService (login, login_failed, logout, updates). */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly sessions: SessionService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parseWith(LoginBody, body);
    const r = await this.auth.login(b.username, b.password, this.client(req), res);
    this.setCookie(res, r.session);
    return r.body;
  }

  @Post('mfa/verify')
  @Access('mfa-pending-session')
  @HttpCode(200)
  async verifyMfa(@Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.verifyMfa(user, parseWith(MfaCodeBody, body).code, this.client(req), res);
    this.setCookie(res, r.session);
    return r.body;
  }

  @Post('mfa/setup')
  @Access('self')
  @AllowDuringLogin('mfa_enrolment')
  @HttpCode(200)
  startMfaSetup(@CurrentUser() user: AuthUser) {
    return this.auth.startMfaSetup(user);
  }

  @Post('mfa/enable')
  @Access('self')
  @AllowDuringLogin('mfa_enrolment')
  @HttpCode(200)
  async enableMfa(@Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.enableMfa(user, parseWith(MfaCodeBody, body).code, this.client(req));
    if (r.session) this.setCookie(res, r.session);
    return r.body;
  }

  @Post('mfa/disable')
  @Access('self')
  @HttpCode(204)
  async disableMfa(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.auth.disableMfa(user, parseWith(MfaDisableBody, body).password);
  }

  @Post('logout')
  @Access('self')
  @AllowDuringLogin('mfa_pending', 'mfa_enrolment', 'password_change')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
  }

  @Get('me')
  @Access('self')
  @AllowDuringLogin('mfa_pending', 'mfa_enrolment', 'password_change')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.getMe(user);
  }

  @Post('password/change')
  @Access('self')
  @AllowDuringLogin('password_change')
  @HttpCode(204)
  async changePassword(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const b = parseWith(PasswordChangeBody, body);
    await this.auth.changePassword(user, b.currentPassword, b.newPassword);
  }

  @Post('password/reset-request')
  @Public()
  @HttpCode(202)
  async requestReset(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.requestPasswordReset(parseWith(ResetRequestBody, body).username, clientIp(req), res);
    return { message: 'If the account exists, a reset message has been sent. Otherwise ask the administrator to reset your password.' };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(204)
  async reset(@Body() body: unknown) {
    const b = parseWith(ResetBody, body);
    await this.auth.resetPassword(b.token, b.newPassword);
  }

  private client(req: Request): ClientInfo {
    const ua = req.headers['user-agent'];
    return { ip: clientIp(req), userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null, existingSessionRaw: readSessionCookie(req as never) };
  }

  private setCookie(res: Response, s: NewSession): void {
    res.cookie(SESSION_COOKIE, s.rawId, this.sessions.cookieOptions(s.expiresAt));
  }
}
