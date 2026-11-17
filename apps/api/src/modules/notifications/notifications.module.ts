// Owner: Agent F. See docs/plan/phase1-agent-tasks.md. Do not edit from another agent; raise a change request.
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import { NOTIFICATION_SERVICE } from '../../common/contracts';
import { DeliveryProcessor } from './delivery.processor';
import { MessageDispatcher } from './message-dispatcher';
import { QueueNotificationService } from './notification.service';
import { NotificationsWorker } from './notifications.worker';
import { MESSAGE_PROVIDER } from './providers/message-provider';
import { createMessageProvider } from './providers/provider.registry';
import { BossService } from './queue/boss.service';

@Global()
@Module({
  providers: [
    BossService,
    { provide: MESSAGE_PROVIDER, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => createMessageProvider(cfg) },
    MessageDispatcher,
    DeliveryProcessor,
    NotificationsWorker,
    QueueNotificationService,
    { provide: NOTIFICATION_SERVICE, useExisting: QueueNotificationService },
  ],
  exports: [NOTIFICATION_SERVICE, MESSAGE_PROVIDER],
})
export class NotificationsModule {}
