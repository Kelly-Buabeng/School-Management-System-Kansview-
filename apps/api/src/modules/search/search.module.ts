// Owner: Agent B. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Controller, Get, Module, Query } from '@nestjs/common';
import { parseWith } from '../../common/validation';
import { CurrentUser, RequirePermission } from '../../security/decorators';
import type { AuthUser } from '../../security/auth-user';
import { SearchQuery, SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  @RequirePermission('search:read')
  search(@Query() q: unknown, @CurrentUser() user: AuthUser) { return this.svc.search(user, parseWith(SearchQuery, q)); }
}

@Module({ controllers: [SearchController], providers: [SearchService] })
export class SearchModule {}
