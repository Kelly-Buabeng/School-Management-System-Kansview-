import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, onUnauthorised, setCsrfToken } from '@/api/client';
import type { LoginResponse, Me } from '@/api/types';

type Status = 'loading' | 'anonymous' | 'mfa' | 'authenticated';

interface AuthValue {
  status: Status;
  me: Me | null;
  /** True after the server said the session ended (expired, forced logout). Shown on the sign-in page. */
  sessionExpired: boolean;
  /** Could not even ask the server who we are (offline at start-up). */
  startupError: Error | null;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  login: (username: string, password: string) => Promise<LoginResponse>;
  verifyMfa: (code: string) => Promise<Me>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children, initialMe }: { children: ReactNode; initialMe?: Me }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>(initialMe ? 'authenticated' : 'loading');
  const [me, setMe] = useState<Me | null>(initialMe ?? null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [startupError, setStartupError] = useState<Error | null>(null);

  const applyMe = useCallback((m: Me | null) => {
    setMe(m);
    setCsrfToken(m?.csrfToken);
    setStatus(m ? 'authenticated' : 'anonymous');
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyMe(await api.get<Me>('/auth/me'));
      setStartupError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) applyMe(null);
      else {
        setStartupError(e as Error);
        setStatus((s) => (s === 'loading' ? 'anonymous' : s));
      }
    }
  }, [applyMe]);

  useEffect(() => {
    if (initialMe) setCsrfToken(initialMe.csrfToken);
    else void refresh();
  }, [initialMe, refresh]);

  useEffect(
    () =>
      onUnauthorised(() => {
        setSessionExpired(true);
        applyMe(null);
        queryClient.clear();
      }),
    [applyMe, queryClient],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api.post<LoginResponse>('/auth/login', { body: { username, password } });
      setSessionExpired(false);
      if (res.mfaRequired) setStatus('mfa');
      else if (res.user) applyMe(res.user as Me);
      else await refresh();
      return res;
    },
    [applyMe, refresh],
  );

  const verifyMfa = useCallback(
    async (code: string) => {
      const m = await api.post<Me>('/auth/mfa/verify', { body: { code } });
      applyMe(m);
      return m;
    },
    [applyMe],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      queryClient.clear();
      applyMe(null);
    }
  }, [applyMe, queryClient]);

  const value = useMemo<AuthValue>(() => {
    const perms = new Set(me?.permissions ?? []);
    return {
      status,
      me,
      sessionExpired,
      startupError,
      can: (p) => perms.has(p),
      canAny: (...ps) => ps.some((p) => perms.has(p)),
      login,
      verifyMfa,
      logout,
      refresh,
    };
  }, [status, me, sessionExpired, startupError, login, verifyMfa, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Renders children only when the user has (any of) the permission(s). The server still enforces it. */
export function Can({ perm, children, fallback = null }: { perm: string | string[]; children: ReactNode; fallback?: ReactNode }) {
  const { canAny } = useAuth();
  return <>{canAny(...(Array.isArray(perm) ? perm : [perm])) ? children : fallback}</>;
}
