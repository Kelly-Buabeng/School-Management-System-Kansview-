# Kansview web app (`@sms/web`)

The admin web app for the school office. React 19, Vite 7, TypeScript 5.9, React Router 7, TanStack Query 5,
React Hook Form + Zod 4, Mantine 8 under a custom theme. API calls go through `openapi-fetch`, typed from `@sms/contracts`.
Money is formatted only with `@sms/shared` (`formatCedis`/`parseCedis`; integer pesewas, never floats).
Dates are shown in Africa/Accra time.

## Run it

```bash
pnpm install
pnpm --filter @sms/shared --filter @sms/contracts build
pnpm --filter @sms/web dev            # mock API (MSW), http://localhost:5173
```

### API mode: `VITE_API_MODE=mock|real`

- `mock` (the default for `dev`): an in-browser fake API (MSW, `src/mocks/`) with a seeded fake school. Every name is
  fake and phones are in the `+23324000xxxx` test range. Sign in as `admin`, `bursar`, `head`, `registrar`, `teacher` or
  `newclerk` (forced password change), all with password `password123`. Admin and bursar then need MFA code `123456`.
  A small **Demo network** panel (bottom left) simulates slow, offline, or "the reply to the next save is lost". Use it to
  show the "Not sure it saved" flow. The fake data resets when the page reloads.
- `real` (the default for production builds): same-origin `/api/v1`, session cookie, and `X-CSRF-Token` from `/auth/me`.
  In development, Vite proxies `/api` to `SMS_API_ORIGIN` (default `http://localhost:3000`):

  ```bash
  VITE_API_MODE=real SMS_API_ORIGIN=http://localhost:3000 pnpm --filter @sms/web dev
  ```

  The dev sign-ins and TOTP secrets are in `db/seeds/README.md`. Differences between the real API and the spec are
  handled in `src/api/normalise.ts` and listed in `docs/contracts/change-requests/CR-0008-e-…`.

## Design

The look follows the school's approved design (`docs/design/README.md`):
- **Theme:** `src/app/theme.ts` and `src/app/global.css` define the tokens: navy `#1f3a6e`, ink, paper, line,
  success and warning. Emergency red `#b3261e` is used only for emergency actions and views and for arrears.
- **Fonts:** Source Serif 4 for headings and big numbers, IBM Plex Sans for body text. They are self-hosted with
  `@fontsource` (latin and latin-ext only), so no font CDN is needed on the school LAN.
- **Shared components** (`src/components/ui.tsx`):
  - Kpi, Section (white card) and Message (success / warning / danger)
  - Pill and FeeBadge (Paid / Partial / Arrears)
  - Chip (audience pickers, term tabs) and StepPills (wizard stepper)
- **Shell** (`src/layout/AppLayout.tsx`, `shell.css`):
  - Desktop: a 232 px navy sidebar and a top bar with search (`Ctrl K` or `/`), Emergency and Alerts · n.
  - Phone (below 992 px): a navy header, bottom tabs Home · Students · Pay · Family · More, and a floating
    Emergency button.
- **Contracts win:** the real student code format (`KSV-26-00417-7`), the username + MFA sign-in, and explicit
  payment allocations built from the per-fee "Paying now" amounts.

Screenshots of the main screens (desktop 1366 px and phone 360 px, mock data) are in `docs/screenshots/`.
To retake them: `pnpm build && pnpm preview &` then `node e2e/screenshots.mjs docs/screenshots`.

## Scripts

| Script | What it does |
|---|---|
| `dev` / `build` / `preview` | Vite dev server / production build / serve `dist` on :4173 |
| `typecheck`, `lint` | `tsc --noEmit` |
| `test` | Vitest + Testing Library component tests, using the same MSW handlers in Node |
| `test:e2e` | Playwright smoke tests against `vite preview` in mock mode (`--trace off`) |

## Layout

```
src/api/        client (openapi-fetch, ApiError/NetworkError, CSRF, Idempotency-Key), types, shared queries, normalise
src/auth/       session context, sign-in / MFA / password pages, copy of the role → permission map
src/layout/     app shell (sidebar / phone tabs), role-aware navigation, global search (Ctrl K or "/"), offline banner, demo network panel
src/components/ shared design components (ui.tsx), problem+json display, student picker
src/features/   one folder per area; every screen is lazy-loaded
src/mocks/      MSW handlers + in-memory fake database
e2e/            Playwright smoke tests
```

## Behaviour that matters

- **Payments**: the `Idempotency-Key` is created when the form opens. It is reused if the save is retried after a
  network error or timeout, and replaced only after the server has definitely refused the save. "Saved" appears only
  after a 201. If the answer is lost, the form locks and says **"Not sure it saved — check before trying again"**, then
  looks the payment up by its key (`GET /payments?idempotencyKey=`). A duplicate MoMo or bank reference is flagged as
  the bursar types (`/payments/duplicate-check`). The 409 needs a written reason to override.
- **Permissions**: menus and buttons follow the `permissions` from `/auth/me`. The server is always the real control.
- **Session expiry**: any 401 sends the user to sign in with a "You were signed out" message, then returns them to the
  page they were on.
- **Offline**: the banner appears when the browser is offline **or** a request could not reach the server.

## Size

Initial JS on first load, measured with `vite build` after the redesign: about **173 KB gzipped**
(entry 81 KB + React/Router 92 KB). CSS is 32 KB more. The self-hosted fonts (seven woff2 files, about 140 KB in total) are
fetched as text needs them. Every screen is a separate chunk of 1–6 KB. The mock API (about 120 KB) loads only in mock mode.
