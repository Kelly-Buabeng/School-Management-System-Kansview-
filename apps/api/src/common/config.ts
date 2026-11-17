import { z } from 'zod';

const Env = z.object({
  SMS_NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SMS_PORT: z.coerce.number().int().default(3000),
  SMS_DB_URL: z.string().url(),
  SMS_SCHOOL_CODE: z.string().regex(/^[A-Z]{3}$/).default('KSV'),
  SMS_TIMEZONE: z.literal('Africa/Accra').default('Africa/Accra'),
  SMS_MASTER_KEY_FILE: z.string().optional(),
  SMS_SESSION_SECRET_FILE: z.string().optional(),
  SMS_FILE_STORAGE_DIR: z.string().default('./var/storage'),
  SMS_CLAMAV_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMS_CLAMAV_HOST: z.string().default('clamav'),
  SMS_SMS_PROVIDER: z.enum(['mock', 'hubtel', 'mnotify', 'arkesel']).default('mock'),
});
export type AppConfig = z.infer<typeof Env>;

/** Reads configuration from the environment. Fails fast at startup with a clear message. Secrets come from *_FILE paths. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return parsed.data;
}
export const APP_CONFIG = Symbol('APP_CONFIG');
