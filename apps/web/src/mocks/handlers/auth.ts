import { getDb, KNOWN } from '../db';
import { audit, getSession, json, meOf, newCsrf, noContent, problem, r, setSession } from '../http';

const MFA_MANDATORY = ['ADMIN', 'BURSAR'];

export const authHandlers = [
  r.post('/auth/login', 'public', async ({ body }) => {
    const { username, password } = await body<{ username?: string; password?: string }>();
    const db = getDb();
    const user = db.users.find((u) => u.username.toLowerCase() === String(username ?? '').trim().toLowerCase());
    if (user?.status === 'locked') return problem(423, 'AUTH_ACCOUNT_LOCKED', 'This account is locked after too many wrong passwords. Ask the administrator to unlock it.');
    if (user?.status === 'disabled') return problem(401, 'AUTH_ACCOUNT_DISABLED', 'This account has been turned off. Ask the administrator.');
    if (!user || user.password !== password) {
      if (user) {
        user.failedLogins += 1;
        if (user.failedLogins >= 5) user.status = 'locked';
      }
      audit(user ?? null, 'login_failed', 'user', `Failed sign-in for "${username}"`);
      return problem(401, 'AUTH_INVALID_CREDENTIALS', 'Wrong username or password.');
    }
    user.failedLogins = 0;
    const needsMfa = user.mfaEnabled || user.roles.some((ro) => MFA_MANDATORY.includes(ro));
    if (needsMfa) {
      setSession({ userId: user.id, stage: 'mfa_pending', csrf: newCsrf() });
      return json({ mfaRequired: true, mfaEnrolmentRequired: !user.mfaEnabled, mustChangePassword: user.mustChangePassword });
    }
    setSession({ userId: user.id, stage: 'active', csrf: newCsrf() });
    user.lastLoginAt = new Date().toISOString();
    audit(user, 'login', 'user', 'Signed in');
    return json({ mfaRequired: false, mustChangePassword: user.mustChangePassword, user: meOf(user) });
  }),

  r.post('/auth/mfa/verify', 'mfa-pending-session', async ({ body }) => {
    const s = getSession();
    if (!s || s.stage !== 'mfa_pending') return problem(401, 'UNAUTHENTICATED', 'Please sign in with your password first.');
    const { code } = await body<{ code?: string }>();
    const user = getDb().users.find((u) => u.id === s.userId)!;
    if (String(code ?? '').replace(/\s/g, '') !== KNOWN.mfaCode) {
      audit(user, 'login_failed', 'user', 'Wrong MFA code');
      return problem(401, 'AUTH_MFA_INVALID', 'That code is not right. Check the time on your phone and try the newest code.');
    }
    setSession({ ...s, stage: 'active' });
    user.mfaEnabled = true;
    user.lastLoginAt = new Date().toISOString();
    audit(user, 'login', 'user', 'Signed in (MFA)');
    return json(meOf(user));
  }),

  r.get('/auth/me', 'self', ({ user }) => json(meOf(user))),

  r.post('/auth/logout', 'self', ({ user }) => {
    audit(user, 'logout', 'user', 'Signed out');
    setSession(null);
    return noContent();
  }),

  r.post('/auth/password/change', 'self', async ({ user, body }) => {
    const { currentPassword, newPassword } = await body<{ currentPassword?: string; newPassword?: string }>();
    if (currentPassword !== user.password) return problem(400, 'VALIDATION_FAILED', 'Your current password is not right.', { errors: [{ field: 'currentPassword', code: 'INVALID', message: 'Current password is not right' }] });
    if (!newPassword || newPassword.length < 10 || newPassword === currentPassword) {
      return problem(422, 'AUTH_PASSWORD_TOO_WEAK', 'Choose a longer password.', { errors: [{ field: 'newPassword', code: 'WEAK', message: 'Use at least 10 characters, different from the old one' }] });
    }
    user.password = newPassword;
    user.mustChangePassword = false;
    audit(user, 'update', 'user', 'Changed own password');
    return noContent();
  }),

  r.post('/auth/password/reset-request', 'public', () => new Response(null, { status: 202 })),
];
