// Owner: Orchestrator. Every domain module is pre-registered here so agents never need to edit this file.
import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config.module';
import { DatabaseModule } from './common/db/database.module';
import { SecurityModule } from './security/security.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AcademicSetupModule } from './modules/academic-setup/academic-setup.module';
import { StudentsModule } from './modules/students/students.module';
import { GuardiansModule } from './modules/guardians/guardians.module';
import { EmergencyModule } from './modules/emergency/emergency.module';
import { EnrolmentModule } from './modules/enrolment/enrolment.module';
import { PromotionModule } from './modules/promotion/promotion.module';
import { StaffModule } from './modules/staff/staff.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { AcademicsModule } from './modules/academics/academics.module';
import { WelfareModule } from './modules/welfare/welfare.module';
import { WithdrawalsModule } from './modules/withdrawals/withdrawals.module';
import { SearchModule } from './modules/search/search.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FinanceModule } from './modules/finance/finance.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { AuditModule } from './modules/audit/audit.module';
import { DataProtectionModule } from './modules/data-protection/data-protection.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { FilesModule } from './modules/files/files.module';
import { ImportsModule } from './modules/imports/imports.module';
import { SystemModule } from './modules/system/system.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    SecurityModule,
    SettingsModule,
    AcademicSetupModule,
    StudentsModule,
    GuardiansModule,
    EmergencyModule,
    EnrolmentModule,
    PromotionModule,
    StaffModule,
    AttendanceModule,
    AcademicsModule,
    WelfareModule,
    WithdrawalsModule,
    SearchModule,
    DashboardModule,
    FinanceModule,
    AuthModule,
    UsersModule,
    AuditModule,
    DataProtectionModule,
    NotificationsModule,
    DocumentsModule,
    FilesModule,
    ImportsModule,
    SystemModule,
  ],
})
export class AppModule {}
