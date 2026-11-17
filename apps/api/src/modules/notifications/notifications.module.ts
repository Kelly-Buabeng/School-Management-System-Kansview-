// Owner: Agent F. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NOTIFICATION_SERVICE, type NotificationService } from '../../common/contracts';

// SCAFFOLD STUB(S): replace with the real implementation and update the binding below.
@Injectable()
export class StubNotificationService implements NotificationService {
  private readonly logger = new Logger('NotificationStub');
  async enqueue(template: string, recipients: unknown[]): Promise<{ messageId: string }> {
    this.logger.debug(`would queue ${template} to ${recipients.length} recipient(s)`);
    return { messageId: randomUUID() };
  }
}

@Global()
@Module({
  providers: [{ provide: NOTIFICATION_SERVICE, useClass: StubNotificationService }],
  exports: [NOTIFICATION_SERVICE],
})
export class NotificationsModule {}
