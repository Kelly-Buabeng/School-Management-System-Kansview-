import { Controller, Get, Inject, Res } from '@nestjs/common';
import { sql } from 'kysely';
import type { Response } from 'express';
import { Public } from '../../security/decorators';
import { KYSELY, type Db } from '../../common/db/database.module';

/** Reference controller showing the conventions: explicit access decorator, no data leaked. Owner: Agent H. */
@Controller('health')
export class HealthController {
  constructor(@Inject(KYSELY) private readonly db: Db) {}

  @Get('live')
  @Public()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: 'ok' | 'unavailable' }> {
    try {
      await sql`SELECT 1`.execute(this.db);
      return { status: 'ok' };
    } catch {
      res.status(503);
      return { status: 'unavailable' };
    }
  }
}
