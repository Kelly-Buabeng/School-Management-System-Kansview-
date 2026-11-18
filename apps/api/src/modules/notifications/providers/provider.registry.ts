// Owner: Agent F. Chooses the SMS provider from SMS_SMS_PROVIDER.
import type { AppConfig } from '../../../common/config';
import type { MessageProvider } from './message-provider';
import { MockProvider } from './mock.provider';

export function createMessageProvider(cfg: Pick<AppConfig, 'SMS_SMS_PROVIDER'>): MessageProvider {
  switch (cfg.SMS_SMS_PROVIDER) {
    case 'mock':
      return new MockProvider();
    default:
      // Real adapters are skeletons only in v1 (ghana-sms.provider.ts). Fail fast rather than silently drop messages.
      throw new Error(`SMS provider "${cfg.SMS_SMS_PROVIDER}" is not available in this version. Set SMS_SMS_PROVIDER=mock.`);
  }
}
