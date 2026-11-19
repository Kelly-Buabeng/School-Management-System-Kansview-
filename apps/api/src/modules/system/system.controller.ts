// Owner: Agent H.
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { RequirePermission } from '../../security/decorators';
import { SystemStatusService, type SystemStatus } from './system-status.service';

@Controller('system')
export class SystemController {
  constructor(@Inject(SystemStatusService) private readonly statusService: SystemStatusService) {}

  /** Admin dashboard tile: last backup, disk space, queue backlog, SMS provider, version. */
  @Get('status')
  @RequirePermission('system:read')
  @Header('Cache-Control', 'no-store')
  status(): Promise<SystemStatus> {
    return this.statusService.status();
  }
}
