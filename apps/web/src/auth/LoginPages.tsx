import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Anchor, Box, Button, Center, PasswordInput, PinInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { api, API_MODE, ApiError } from '@/api/client';
import { ProblemAlert } from '@/components/ProblemAlert';
import { useAuth } from './AuthContext';

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  // Split panel: navy brand panel (hidden on small phones) and the form on Paper.
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexWrap: 'wrap', background: 'var(--k-paper)' }}>
      <Box visibleFrom="sm" style={{ flex: '1 1 40%', background: 'var(--k-navy)', color: '#fff', padding: '48px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '100vh' }}>
        <Text className="k-serif" fz={30} fw={600}>
          Kansview School
        </Text>
        <Text className="k-serif" fz={30} lh={1.25} maw={420}>
          Student records, fees and family contacts in one place.
        </Text>
      </Box>
      <Center component="main" style={{ flex: '1 1 50%' }} p="lg">
        <div style={{ width: '100%', maxWidth: 360 }}>
          <Text hiddenFrom="sm" className="k-serif" fz={20} fw={600} c="navy.7" mb="md">
            Kansview School
          </Text>
          <Title order={1} mb="md">
            {title}
          </Title>
          {children}
        </div>
      </Center>
    </div>
  );
}

const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/');

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username'),
  password: z.string().min(1, 'Enter your password'),
});

export function LoginPage() {
  const { status, me, login, sessionExpired, startupError } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema), defaultValues: { username: '', password: '' } });

  if (status === 'authenticated') return <Navigate to={me?.mustChangePassword ? `/change-password?next=${encodeURIComponent(next)}` : next} replace />;
  if (status === 'mfa') return <Navigate to={`/mfa?next=${encodeURIComponent(next)}`} replace />;
  if (status === 'enrol') return <Navigate to={`/mfa/setup?next=${encodeURIComponent(next)}`} replace />;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const res = await login(v.username, v.password);
      if (res.mfaRequired) navigate(`/mfa?next=${encodeURIComponent(next)}`, { replace: true });
      else if (res.mfaEnrolmentRequired) navigate(`/mfa/setup?next=${encodeURIComponent(next)}`, { replace: true });
    } catch (e) {
      setError(e);
      form.setValue('password', '');
    }
  });

  return (
    <AuthCard title="Sign in">
      <form onSubmit={onSubmit} noValidate>
        <Stack>
          {sessionExpired && (
            <Alert color="yellow" title="You were signed out">
              Your session ended. Sign in again to continue. Anything not saved before this message will need to be entered again.
            </Alert>
          )}
          {startupError && !error && <ProblemAlert error={startupError} />}
          <ProblemAlert error={error} />
          <TextInput size="md" label="Username" autoComplete="username" autoCapitalize="none" autoFocus {...form.register('username')} error={form.formState.errors.username?.message} />
          <PasswordInput size="md" label="Password" autoComplete="current-password" {...form.register('password')} error={form.formState.errors.password?.message} />
          <Text size="sm">
            Forgot your password? Ask the school administrator to reset it.
          </Text>
          <Button type="submit" size="md" loading={form.formState.isSubmitting} fullWidth>
            Sign in
          </Button>
          <Text size="xs" c="dimmed">
            Your session ends after a period without activity. After 5 wrong passwords the account is locked for a while. Contact an administrator to unlock it sooner.
          </Text>
          {API_MODE === 'mock' && (
            <Alert color="gray" title="Demo accounts (fake data)">
              <Text size="xs">
                admin, bursar, head, registrar, teacher, newclerk — password <b>password123</b>. Admin and bursar then need code <b>123456</b>.
              </Text>
            </Alert>
          )}
        </Stack>
      </form>
    </AuthCard>
  );
}

export function MfaPage() {
  const { status, verifyMfa, me } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [error, setError] = useState<unknown>(null);
  const form = useForm<{ code: string }>({ defaultValues: { code: '' } });

  if (status === 'authenticated') return <Navigate to={me?.mustChangePassword ? '/change-password' : next} replace />;
  if (status !== 'mfa') return <Navigate to="/login" replace />;

  const onSubmit = form.handleSubmit(async ({ code }) => {
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      form.setError('code', { message: 'Enter the 6-digit code' });
      return;
    }
    try {
      await verifyMfa(code);
    } catch (e) {
      setError(e);
      form.setValue('code', '');
    }
  });

  return (
    <AuthCard title="Enter your security code">
      <form onSubmit={onSubmit} noValidate>
        <Stack>
          <Text size="sm">Open the authenticator app on your phone and type the 6-digit code for Kansview.</Text>
          <ProblemAlert error={error} />
          <Box>
            <Text component="label" htmlFor="mfa-code" size="sm" fw={500}>
              6-digit code
            </Text>
            <Controller
              control={form.control}
              name="code"
              render={({ field }) => (
                <PinInput id="mfa-code" length={6} type="number" oneTimeCode autoFocus value={field.value} onChange={field.onChange} aria-label="6-digit code" size="md" mt={4} />
              )}
            />
            {form.formState.errors.code && (
              <Text c="red.8" size="sm" mt={4}>
                {form.formState.errors.code.message}
              </Text>
            )}
          </Box>
          <Button type="submit" loading={form.formState.isSubmitting} fullWidth>
            Continue
          </Button>
          <Anchor href="/login" size="sm">
            Use a different account
          </Anchor>
        </Stack>
      </form>
    </AuthCard>
  );
}

const pwSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current (temporary) password'),
    newPassword: z.string().min(10, 'Use at least 10 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'The two new passwords are different' })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ['newPassword'], message: 'Choose a password different from the old one' });

export function ChangePasswordPage() {
  const { status, me, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = safeNext(new URLSearchParams(location.search).get('next'));
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.infer<typeof pwSchema>>({ resolver: zodResolver(pwSchema), defaultValues: { currentPassword: '', newPassword: '', confirm: '' } });
  if (status !== 'authenticated') return <Navigate to="/login" replace />;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api.post('/auth/password/change', { body: { currentPassword: v.currentPassword, newPassword: v.newPassword } });
      notifications.show({ color: 'green', title: 'Password changed', message: 'Use your new password next time you sign in.' });
      await refresh();
      navigate(next, { replace: true });
    } catch (e) {
      if (e instanceof ApiError) for (const [field, message] of Object.entries(e.fieldErrors())) form.setError(field as 'newPassword', { message });
      setError(e);
    }
  });

  return (
    <AuthCard title={me?.mustChangePassword ? 'Choose your own password' : 'Change password'}>
      <form onSubmit={onSubmit} noValidate>
        <Stack>
          {me?.mustChangePassword && <Text size="sm">You signed in with a temporary password. Choose a new one before you continue.</Text>}
          <ProblemAlert error={error} />
          <PasswordInput label="Current password" autoComplete="current-password" {...form.register('currentPassword')} error={form.formState.errors.currentPassword?.message} />
          <PasswordInput label="New password" description="At least 10 characters. A short sentence is easy to remember." autoComplete="new-password" {...form.register('newPassword')} error={form.formState.errors.newPassword?.message} />
          <PasswordInput label="Type the new password again" autoComplete="new-password" {...form.register('confirm')} error={form.formState.errors.confirm?.message} />
          <Button type="submit" loading={form.formState.isSubmitting}>
            Save new password
          </Button>
        </Stack>
      </form>
    </AuthCard>
  );
}

export function MfaSetupPage() {
  const { status, startMfaSetup, enableMfa } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [setup, setSetup] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (status !== 'enrol' && !codes) return <Navigate to={status === 'authenticated' ? next : '/login'} replace />;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="Set up your security code">
      <Stack>
        <ProblemAlert error={error} />
        {codes ? (
          <>
            <Alert color="green" title="Done">Write these recovery codes on paper and keep them safe. Each works once if you lose your phone.</Alert>
            <Text ff="monospace" fw={700}>{codes.join('  ')}</Text>
            <Button onClick={() => navigate(next, { replace: true })}>I have written them down</Button>
          </>
        ) : !setup ? (
          <>
            <Text size="sm">Administrators and bursars must use a phone authenticator app (for example Google Authenticator). It takes one minute.</Text>
            <Button loading={busy} onClick={() => void run(async () => setSetup(await startMfaSetup()))}>Start</Button>
          </>
        ) : (
          <>
            <Text size="sm">In the authenticator app choose “Enter a setup key” and type this key:</Text>
            <Text ff="monospace" fw={700} style={{ wordBreak: 'break-all' }}>{setup.secret}</Text>
            <TextInput label="Then type the 6-digit code it shows" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))} />
            <Button disabled={code.length !== 6} loading={busy} onClick={() => void run(async () => setCodes(await enableMfa(code)))}>Turn on</Button>
          </>
        )}
      </Stack>
    </AuthCard>
  );
}
