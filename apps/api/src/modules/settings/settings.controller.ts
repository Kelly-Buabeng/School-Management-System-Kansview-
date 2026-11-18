// Owner: Agent B.
import { Body, Controller, Get, Headers, Patch, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { parseWith } from '../../common/validation';
import { parseIfMatch, parseIfMatchTag } from './common/http';
import { UpdatePoliciesBody } from './policies';
import { SettingsService, UpdateSchoolProfileBody } from './settings.service';

export interface UploadedBlob { originalname: string; buffer: Buffer; mimetype?: string; size?: number }

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('settings/school')
  @RequirePermission('settings:read')
  async getSchool(@Res({ passthrough: true }) res: Response) {
    const p = await this.settings.getSchoolProfile();
    res.setHeader('ETag', `"${p.version}"`);
    return p;
  }

  @Patch('settings/school')
  @RequirePermission('settings:update')
  @Audited('update', 'school_profile')
  async updateSchool(@Body() body: unknown, @Headers('if-match') ifMatch: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const p = await this.settings.updateSchoolProfile(parseWith(UpdateSchoolProfileBody, body), parseIfMatch(ifMatch), user);
    res.setHeader('ETag', `"${p.version}"`);
    return p;
  }

  @Put('settings/school/logo')
  @RequirePermission('settings:update')
  @Audited('update', 'school_profile')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  uploadLogo(@UploadedFile() file: UploadedBlob | undefined, @CurrentUser() user: AuthUser) {
    return this.settings.uploadLogo(file, user);
  }

  @Get('settings/policies')
  @RequirePermission('settings:read')
  async getPolicies(@Res({ passthrough: true }) res: Response) {
    const { policies, etag } = await this.settings.getPolicies();
    res.setHeader('ETag', `"${etag}"`);
    return { ...policies, version: etag };
  }

  @Patch('settings/policies')
  @RequirePermission('settings:update')
  @Audited('update', 'settings')
  async updatePolicies(@Body() body: unknown, @Headers('if-match') ifMatch: string | undefined, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const { policies, etag } = await this.settings.updatePolicies(parseWith(UpdatePoliciesBody, body), parseIfMatchTag(ifMatch), user);
    res.setHeader('ETag', `"${etag}"`);
    return { ...policies, version: etag };
  }
}
