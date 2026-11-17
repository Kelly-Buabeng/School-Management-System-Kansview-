import pino from 'pino';

/** Structured JSON logger. Redacts secrets and personal data paths. */
export const logger = pino({
  level: process.env.SMS_LOG_LEVEL ?? (process.env.SMS_NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]',
      '*.password', '*.newPassword', '*.totp', '*.ghanaCardNumber', '*.allergies', '*.chronicConditions',
      '*.medicationNotes', '*.specialNeeds', '*.mfaSecret',
    ],
    censor: '[redacted]',
  },
});
