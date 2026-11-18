// Owner: Agent B.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Audited, CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { parseWith } from '../../common/validation';
import { AcademicSetupService } from './academic-setup.service';
import {
  CreateAcademicYearBody, CreateClassBody, CreateLevelBody, CreateSubjectBody, GradingScaleBody, ListClassesQuery,
  SetLevelSubjectsBody, UpdateAcademicYearBody, UpdateClassBody, UpdateLevelBody, UpdateSubjectBody, UpdateTermBody,
} from './academic-setup.dto';

@Controller()
export class AcademicSetupController {
  constructor(private readonly svc: AcademicSetupService) {}

  @Get('academic-years')
  @RequirePermission('academic_setup:read')
  listYears() { return this.svc.listYears(); }

  @Post('academic-years')
  @RequirePermission('academic_setup:create')
  @Audited('create', 'academic_year')
  createYear(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.createYear(parseWith(CreateAcademicYearBody, body), user); }

  @Patch('academic-years/:id')
  @RequirePermission('academic_setup:update')
  @Audited('update', 'academic_year')
  updateYear(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.updateYear(id, parseWith(UpdateAcademicYearBody, body), user); }

  @Post('academic-years/:id/set-current')
  @HttpCode(200)
  @RequirePermission('academic_setup:update')
  @Audited('update', 'academic_year')
  setCurrent(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.setCurrentYear(id, user); }

  @Patch('terms/:id')
  @RequirePermission('academic_setup:update')
  @Audited('update', 'term')
  updateTerm(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.updateTerm(id, parseWith(UpdateTermBody, body), user); }

  @Get('levels')
  @RequirePermission('academic_setup:read')
  listLevels() { return this.svc.listLevels(); }

  @Post('levels')
  @RequirePermission('academic_setup:create')
  @Audited('create', 'level')
  createLevel(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.createLevel(parseWith(CreateLevelBody, body), user); }

  @Patch('levels/:id')
  @RequirePermission('academic_setup:update')
  @Audited('update', 'level')
  updateLevel(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.updateLevel(id, parseWith(UpdateLevelBody, body), user); }

  @Put('levels/:id/subjects')
  @RequirePermission('academic_setup:update')
  @Audited('update', 'level_subjects')
  setLevelSubjects(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.setLevelSubjects(id, parseWith(SetLevelSubjectsBody, body).subjectIds, user);
  }

  @Get('classes')
  @RequirePermission('academic_setup:read')
  listClasses(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.listClasses(user, parseWith(ListClassesQuery, q)); }

  @Post('classes')
  @RequirePermission('academic_setup:create')
  @Audited('create', 'class')
  createClass(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.createClass(parseWith(CreateClassBody, body), user); }

  @Get('classes/:id')
  @RequirePermission('academic_setup:read')
  getClass(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.getClass(user, id); }

  @Patch('classes/:id')
  @RequirePermission('academic_setup:update')
  @Audited('update', 'class')
  updateClass(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.updateClass(user, id, parseWith(UpdateClassBody, body)); }

  @Get('subjects')
  @RequirePermission('academic_setup:read')
  listSubjects() { return this.svc.listSubjects(); }

  @Post('subjects')
  @RequirePermission('academic_setup:create')
  @Audited('create', 'subject')
  createSubject(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.createSubject(parseWith(CreateSubjectBody, body), user); }

  @Patch('subjects/:id')
  @RequirePermission('academic_setup:update')
  @Audited('update', 'subject')
  updateSubject(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.updateSubject(id, parseWith(UpdateSubjectBody, body), user); }

  @Get('grading-scales')
  @RequirePermission('academic_setup:read')
  listScales() { return this.svc.listGradingScales(); }

  @Post('grading-scales')
  @RequirePermission('settings:update')
  @Audited('create', 'grading_scale')
  createScale(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.saveGradingScale(null, parseWith(GradingScaleBody, body), user); }

  @Put('grading-scales/:id')
  @RequirePermission('settings:update')
  @Audited('update', 'grading_scale')
  replaceScale(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.saveGradingScale(id, parseWith(GradingScaleBody, body), user); }
}
