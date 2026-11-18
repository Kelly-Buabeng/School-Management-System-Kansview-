import { SetMetadata } from '@nestjs/common';
import type { SessionPhase } from './session.service';

export const LOGIN_PHASE_KEY = 'sms:login-phase';

/**
 * Marks a signed-in route as usable while the session is still part-way through login
 * (MFA code not yet entered, MFA enrolment required, or temporary password to change).
 * Routes without it require a fully signed-in session. Used by auth routes only (logout, me, MFA setup, password change).
 */
export const AllowDuringLogin = (...phases: Exclude<SessionPhase, 'full'>[]) => SetMetadata(LOGIN_PHASE_KEY, phases);
