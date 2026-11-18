# Frontend design (approved by the school, 2026-11-18)

Source: the school's design prototype, https://claude.ai/artifact/1HwwGeKKU57qPGcQSj6AaK (views: Desktop, Phone, Design system). Screenshots of every screen are in `screens/`. **This design replaces the earlier default Mantine look.** Where it conflicts with the frozen contracts (API, RBAC, ID format), the contracts win; see "Differences from the prototype" below.

## Design tokens

| Token | Value | Use |
|---|---|---|
| Navy | `#1f3a6e` | Sidebar, primary buttons, selected chips, charts, toggles on |
| Ink | `#1d2433` | Body text |
| Paper | `#f6f3ee` | App background (content area); cards are white |
| Line | `#d8d2c7` | Borders, dividers, inactive toggle/progress track |
| Emergency red | `#b3261e` | **Only** emergency actions/views and arrears. Never for decoration |
| Success | `#dff0e3` | Success message background, "Paid" badge |
| Warning | `#fbf0d4` | Warning messages (e.g. duplicate reference), "Partial" badge |
| Page surround | `#e8e4dd` | Outside the app frame (prototype only) |

- **Type:** *Source Serif 4* for headings and big numbers (KPI figures, totals, page titles, "Kansview" wordmark). *IBM Plex Sans* for body, labels, tables, forms. Sizes **12 / 14 / 16 / 20 / 30**.
- **Fonts must be self-hosted** (e.g. `@fontsource/source-serif-4`, `@fontsource/ibm-plex-sans`): the school runs on a LAN that is often offline, so no Google Fonts CDN.
- **Spacing:** 8 px unit. Desktop content on a 12-column grid.
- **Corners:** small radius (~6–8 px) on inputs, buttons and cards; badges are pills.
- **Money in the web app:** `GH₵ 1,250.00` with thousands separators (KPI tiles may drop decimals: `GH₵ 14,850`). PDFs and SMS keep `GHS` (font/SMS constraints, see CR-0006).

## Components
- **Buttons:** Primary (navy filled, white text), Secondary (white, line border, ink text), Emergency (red filled, white text).
- **Badges:** Paid (success bg, green text), Partial (warning bg, amber text), Arrears (light red bg, red text).
- **Fields:** label above, white input with line border. Error state: red border plus a red helper text below ("Enter a phone number with at least 10 digits.").
- **Messages:** inline boxes. Success = success bg ("Saved. The receipt is ready to print."), Warning = warning bg ("A payment with reference MM-48213 was recorded on 12 Nov for Esi Asante. Check this is not a repeat.").
- **Toggles:** navy when on, line-coloured when off.
- **Chips** (audience pickers): navy filled when selected, navy outline otherwise.
- **Stepper** for wizards: "1. Select class · 2. Preview · 3. Exceptions · 4. Confirm · 5. Result".

## Layout
- **Desktop:**
  - **Sidebar:** fixed **232 px** navy sidebar with the "Kansview" wordmark (serif). The selected item is a lighter navy pill. The signed-in user ("Ama Mensah · Administrator") sits at the bottom.
  - **Top bar:** a global search ("Search name, ID, phone, class", `Ctrl K` hint), a red **Emergency** button, and **Alerts · n**.
  - **Content:** on Paper, with white cards.
- **Phone:**
  - **Header:** a navy header with back button, title, and Find and alerts buttons.
  - **Content:** single column, **44 px minimum tap targets**.
  - **Navigation:** a bottom tab bar with **Home · Students · Pay · Family · More**, and a floating red **Emergency** button above it.

## Screens in the prototype
1. **Sign in** (`01`): split panel. Left is navy with "Kansview School" and the tagline "Student records, fees and family contacts in one place." Right has the form (email, password, "Forgot your password?", Sign in) and the session and lockout note.
2. **Dashboard** (`04`): "Good morning, {name}".
   - **KPI tiles:** Students enrolled, Collected today, Outstanding fees, Attendance today.
   - **Cards:** Enrolment by class (horizontal bars), Fee collection against target (progress bar plus arrears line), Upcoming birthdays, Attendance this week (bars Mon–Fri with %), Recent payments with a "Record a payment" button.
3. **Students** (`05`):
   - A "New admission" button and filters (class, fee status).
   - "Message guardians · n selected".
   - A table with Name, ID, Class and Fees badge.
4. **Guardian** (`06`):
   - The guardian's name, relationship, phone and email, then linked children with balances and the combined balance.
   - An info note explaining an automatic sibling link, with confirm or remove.
5. **Record payment** (`07`):
   - "What is this payment for?" lists each fee line with a description (fee / paid / balance), a toggle, and a "Paying now (GH₵)" amount.
   - The balance on selected fees, plus "Pay full balances".
   - Method, reference number with the inline duplicate warning, and a total received that is split across selected fees.
   - An "Allocation to invoice items" summary, then **Save payment**.
6. **Fee setup** (`08`):
   - Term tabs, then rows of fee name, amount and optional flag with Remove.
   - "Add a fee" and "Copy fees from previous term".
   - The compulsory total per student, then Save.
7. **Receipt** (`09`):
   - The receipt itself: school name, "Official fee receipt", number and date, received from / for, line items, total paid with the method and reference, balance remaining and "Received by".
   - A **Print receipt** button.
8. **Classes and promotion** (`10`): the 5-step promotion wizard ("Basic 5B → Basic 6B (32 students)").
9. **Emergency View** (`11`):
   - An "EMERGENCY VIEW" header in red, with the student and class.
   - Medical alerts in a red-tinted box.
   - "Call in this order", a numbered list of contacts with relationship, phone and a **Call** button.
   - The contact log, and a link to "Send a bulk emergency message".
10. **Bulk message** (`12`): audience chips (class / level / whole school), message box, "This will send an SMS to N guardians.", **Review and send**.
11. **Phone** (`90`): the same screens in the phone shell, shown on the bulk emergency message.

## Differences from the prototype (contracts win)
- **Student ID** keeps the permanent format `KSV-26-00417-7`, not `KV-2031`.
- **Sign-in:** username, password, then an **MFA step** for admin and bursar (Agent D). The prototype shows email/password only.
- **Payment form:** posts explicit allocations. Toggled lines with their "Paying now" amounts map to `allocations[]`, and anything left over becomes credit. It keeps the Idempotency-Key and "Not sure it saved" behaviour.
- **Screens not in the prototype** (attendance, scores and report cards, withdrawals, staff, imports, messages log, settings, users, audit log, adjustments approvals, cash-up, reports) use the same tokens and components. On desktop they go in the sidebar below the prototype's items, or under grouped sections; on phone they go under **More**.
- **Role-aware navigation:** only items the user's permissions allow are shown.
