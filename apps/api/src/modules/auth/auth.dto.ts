import { z } from 'zod';

export const LoginBody = z.strictObject({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
});

export const MfaCodeBody = z.strictObject({ code: z.string().trim().min(6).max(20) });
export const MfaDisableBody = z.strictObject({ password: z.string().min(1).max(256) });

export const PasswordChangeBody = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(1024),
});

export const ResetRequestBody = z.strictObject({ username: z.string().trim().min(1).max(254) });

export const ResetBody = z.strictObject({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(1).max(1024),
});

/** GET /auth/me and the `user` part of login responses (openapi Me schema plus additive fields). */
export interface MeDto {
  id: string;
  username: string;
  fullName: string;
  roles: string[];
  permissions: string[];
  csrfToken: string;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  /** 'full' | 'mfa_pending' | 'mfa_enrolment' | 'password_change' */
  sessionPhase: string;
}

export interface LoginResponseDto {
  mfaRequired: boolean;
  mfaEnrolmentRequired: boolean;
  mustChangePassword: boolean;
  user: MeDto;
}
