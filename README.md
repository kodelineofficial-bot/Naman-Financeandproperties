# Bahi Khata CRM — Money-lending Admin Panel

An admin panel for a daily-collection money-lending business (उधारी / किस्त), with staff salaries, daily expenses, day book and monthly reports. Every screen reads from the same ledger, so cash balances agree everywhere.

**Stack:** React 18 + Vite (frontend, deployed as a Render Static Site) · Supabase (Postgres, Auth, Row Level Security, Realtime). There is no separate backend server: the browser talks to Supabase directly, and RLS makes sure only admins can read or write.

---

## Pages

| Page | What it does |
|---|---|
| **Login** | Email + password (Supabase Auth). Only users in the `admins` table get in. |
| **Dashboard** | Cash in hand, money out in the market, overdue, money still to give, today's collection %, this month's numbers, top overdue (with a WhatsApp reminder button), recent entries. |
| **Daily Collection** (रोज़ की किस्त) | One row per running **daily** loan for any date. Amount is pre-filled with the day's installment + anything short from earlier days (₹150/day, ₹120 paid → ₹180 next day). Save one row or "Save all". Tabs: Not paid / Paid / Overdue. |
| **Monthly Loans** (मासिक किस्त) | One row per **monthly** loan for any month: due date, installment + shortfall carried from earlier months, paid this month, still due, balance. Take payments inline, WhatsApp reminder, CSV export. |
| **Loans** (उधारी खाता) | All loans with progress, balance, overdue and end date. Filter, search, sort, CSV export. |
| **New Loan** | Pick an existing borrower or add a new one, choose **Daily** or **Monthly** loan, then the terms. **Every number is flexible**: auto-calculated fields can be overwritten, and "↺ auto" puts them back. A live *Hisaab* panel shows cash to give, amount to collect, number of installments, last date and profit. |
| **Loan detail** | Terms, a day-by-day *khata* grid (daily loans) or a month-by-month schedule (monthly loans), collections incl. the advance kept at loan time, money given in parts (e.g. 4,100 + 4,000), edit terms, settle, default, cancel, delete, print. |
| **Borrowers** (ग्राहक) | Name, work (काम), phone, address, ID, guarantor, profile photo (Cloudinary), plus all their loans and total balance. |
| **Day Book** (रोज़नामचा) | **Detailed view of one day**: opening cash, every entry in and out, closing cash, loans issued that day, and who did not pay. |
| **Daily Summary** (दिन वार) | **Broad view by day**: one line per day across a date range, broken down by type, with running balance. Click a day to open its Day Book. |
| **Monthly Report** (मासिक) | Twelve months side by side: collections, loans given, expenses, salary, closing cash, new business, interest and extra earned. Includes a bar chart and a drill-down for one month. |
| **Expenses** (खर्चा) | Daily expenses with category, mode and "paid to". Totals by category and CSV export. |
| **Cash In / Out** (पूंजी) | When the owner adds capital or takes money out. This keeps the cash balance correct. |
| **Employees** (कर्मचारी) | Staff with their fixed salary. Record **salary advances or loans** (and choose which month's salary they come out of) and salary payments. Month-wise statement for each person. |
| **Salary Report** | Month end: salary − advances − already paid = **what is still owed**. Pay with one click. |
| **Settings** | Business name, opening cash balance, the default loan terms (all can be changed per loan), and the **late payment penalty** rule (₹ per day, day the penalty starts, count from date). |
| **WhatsApp Templates** (मैसेज टेम्पलेट) | Create / edit the messages sent from every WhatsApp button. Placeholders like `{name}`, `{overdue}`, `{penalty}`, `{total_due}` are filled per borrower. Four ready-made English templates (reminder, penalty notice, final notice, balance statement). The WhatsApp button opens a picker, then WhatsApp with the text ready — just press Send. |

## How the loan maths works (default values; every value can be edited per loan)

```
Loan amount (principal)        10,000
− Interest cut upfront (4%)       400
− Advance kept (10 days × 150)  1,500
= Cash to give                  8,100   ← can be given in parts (4,100 today, 4,000 tomorrow)

Daily installment                 150   (₹150 per ₹10,000)
Total repayable                12,000   (10,000 + 20%  =  150 × 80 days)
− Already kept as advance       1,500
= To collect daily             10,500   → 70 installments of 150

Profit = 400 interest + 2,000 extra = 2,400
```

* **Monthly loans** use the same fields per month: e.g. ₹1,00,000 + 20% = ₹1,20,000 over 12 months = ₹10,000/month, due on the same date every month (31st → last day of short months). Interest cut and advance months work like daily loans.
* **Overdue** = (installments due till today × installment) − (advance + collected so far). A short payment carries forward to the next installment until it is cleared.
* **Penalty (जुर्माना)**: when on, counting the first missed installment day as day 1, every past day from *penalty starts on day* onward that the loan is still behind adds ₹ *per day* (e.g. day 3: miss today and tomorrow, and the penalty starts on the third day even if they pay that day). Today is never counted. Penalty is separate from the loan balance; take it (shows in cash book as *Penalty*) or waive it (माफ़) on the loan page, or switch it off for one loan. **Old penalty (पुरानी)**: for a loan that was behind before the Settings *count from* date, set on the loan page "penalty up to <date> = ₹<amount>" (or *Count from paid till*); from the next day the system counts penalty days itself.
* **Defaulted**: *Mark defaulted* stops the loan — the balance stays as it is, no new installments fall due, no new penalty, and penalty still due is waived (माफ़). Later either **Settle** (take the full balance; the loan closes) or **Resume**: the schedule moves forward by the days it was defaulted, so collection continues from the installment where it stopped.
* A loan **closes on its own** when the full amount is collected, and **re-opens** if a collection is deleted.
* If you type **Duration (days)** yourself, the total becomes daily × days. If you type **Total**, the days are worked out from it.

## How everything stays in sync

Each transaction table (`loan_disbursements`, `loan_repayments`, `expenses`, `salary_payments`, `employee_advances`, `cash_entries`) feeds one SQL view called **`ledger`**. The reports are built on top of it:

* `daily_cashflow` gives day totals and the running cash balance (Day Book, Daily Summary, Dashboard).
* `monthly_cashflow` gives month totals and the running balance (Monthly Report).
* `loan_summary` gives live balance, overdue, progress and end date for each loan.
* `salary_report(month)` gives salary − advances − paid.

When you edit or delete any entry, every report changes with it. Supabase Realtime refreshes all open screens, so if a collection agent enters a payment on their phone, the owner's screen updates too.

**Editing loan terms (migration 020):** changing duration keeps the current installment and recalculates total repayable, so the calendar, end date, balance and collection sheet agree. Changing total recalculates duration. Edit terms also shows each recorded cash/UPI payout. A single fully recorded payout can follow the corrected cash to give automatically; partial or multiple payouts stay individually editable. Old-balance adjustments remain linked and fixed. The terms and payouts save in one database transaction; conflicting edits require reloading. Extending a paid-off loan reopens its remaining balance. Open screens also refresh after reconnecting or returning to the tab.

For an incorrect recorded payout, open **Edit terms**, verify **Recorded money given**, and save. This corrects the original payout on its original date, so the Day Book and all later cash balances recalculate. The new-loans table separates actual handover from old dues adjusted. Excel exports include actual handover and advance breakdown.

**Advance payment mode (migration 021):** New Loan, Renew Loan and Edit terms have a separate **Advance received via** Cash/UPI selector. UPI disbursements show only the amount actually transferred, with no advance added. Cash book out keeps the existing payout + advance rule. Advance income uses its own selected mode: Cash is included in cash income; UPI is shown but excluded from cash balances. The same ledger feeds Day Book, Dashboard, Daily Summary and Monthly Report. Existing loans with no selected advance mode retain their previous payout-based mode until edited.

**Retained advance cut (migration 022):** advance kept is deducted from the loan, so its income needs a matching out entry. A UPI payout of ₹3,550 from ₹3,700 before advance therefore shows ₹3,550 UPI out, ₹150 advance cut/out in the selected advance mode, and ₹150 advance income in the same mode. With Cash advance, the ₹150 cut and ₹150 income cancel in cash balance. Cash payouts already include the cut in their gross out, so no extra cut is added. Cuts appear once, follow the first actual payout date, and are included in daily/monthly loan-given totals. They do not create another repayment or reduce the loan balance twice.

The latest Karan Office clarification is in `supabase/repairs/karan_office_230.sql`: #230 (17 October) is ₹3,700 before advance − ₹150 kept = **₹3,550 actual UPI sent**, with ₹150 Cash advance cut and income. #225 (16 October) keeps ₹2,450 actual UPI sent and records ₹100 Cash advance cut and income. The repair verifies the borrower, loan IDs, dates and amounts; it never subtracts advance again from an already net payout. It restores #230 to ₹3,550 only if the superseded ₹3,400 repair was already applied. Run after migrations 021 and 022; rerunning is safe.

**Cut anyone's dues (migration 027):** New Loan and the loan page (✂ Cut someone's dues) can pay another borrower's overdue + penalty out of the cash still to give. The ledger shows the full loan given, the other loan's collection + penalty income, and cash moves only by what is handed over. Undo per cut on the loan page.

**Advance from a later payout (migration 028):** + Give money on the loan page can keep part of the money as advance installments (pre-filled days × installment, editable, can be switched off). ₹13,000 given with ₹1,800 kept → ₹11,200 handed over; the Day Book shows ₹13,000 loan given (₹1,800 of it adjusted, no cash) and ₹1,800 *Advance kept* income. Undo per advance on the loan page.

**Cut from a deleted loan (migration 029):** an old overdue cut (made before 027) stays in the Day Book even if the old loan was later deleted: in and out on the new loan, same amount, no cash, noted *old loan deleted*. Total In / Total Out include it; cash in hand and loan balances do not change.

**Cash count per day (migration 030):** Day Book → 🪙 *Count cash* saves the cash counted in the drawer at the start of that day. It becomes that day's opening and later days follow from it; earlier days keep their own opening and closing. The difference from the system's figure (closing of the day before) is shown on the Day Book, never hidden. Settings → starting cash is locked behind a checkbox because changing it re-counts every day from the cash start date.

**Give money from several loans + salary free days (migration 031):** + Give money on the loan page lists the borrower's other running loans. Tick any of them and enter how much of this money goes on each (days × installment, overdue, full balance, penalty) — it can be split, e.g. half on one loan and half on another — together with this loan's own advance. ₹10,000 given, ₹500 on #23, ₹500 on #24, ₹300 advance → ₹8,700 handed over; the Day Book shows ₹10,000 loan given, ₹500 + ₹500 collections, ₹300 advance kept. Saved in one transaction; each cut can be undone on the loan page like any dues cut. Salary: the first 3 absent days in a month are free (half day = ½), the cut starts from the 4th (Settings → Free absent days).

**Borrower Take payment (no migration):** the borrower page has ₹ Take payment for all running loans at once. Enter the money received (UPI, cash, change given back); Auto-fill puts it on overdue first, then extra days on every loan; UPI is used first, then cash, so each loan gets its own UPI / cash entries and the Day Book matches the phone and the drawer. Penalty per loan is saved as penalty income. Save works only when Received − On loans = ₹0.

**Day Book:** Total in includes the opening cash, like the paper diary (closing = total in − total out).

**Upgrading an existing installation:** apply any migrations not yet run, in number order, before deploying this frontend (020, 021 and 022 for the advance-mode changes; 023–031 after them). Migration 021 also includes the updated atomic Edit terms function. If 021 and the Karan repair are already applied, run 022 to add the matching cuts; no second data correction is necessary. General migrations do not guess or rewrite historical payouts; the separate Karan repair is narrowly checked.

**Verification:** `npm test` covers term dependencies and calendar/payout regressions. `tests/loanEdits.sql` checks the save function against the real ledger and reports in an isolated database with all migrations applied; all fixtures roll back.
`tests/advanceMode.sql` checks every Cash/UPI payout/advance combination, legacy mode fallback, mode edits, multiple payouts, renewals, and daily/monthly cashflow.

---

## Setup (about 15 minutes)

### 1. Supabase
1. Create a project at https://supabase.com and choose region **Mumbai (ap-south-1)**.
2. **SQL Editor → New query**: paste and **Run** each file in `supabase/migrations/` in order (`001_schema.sql` through `031_give_money_cut_other_loans.sql`).
3. *(Optional demo data)* Run `supabase/seed.sql`.
4. **Authentication → Users → Add user**: enter the owner's email and password, and tick *Auto confirm*.
5. Make that user an admin (SQL Editor):
   ```sql
   insert into public.admins (user_id, name)
   select id, 'Owner' from auth.users where email = 'owner@example.com';
   ```
6. **Authentication → Sign In / Providers → Email**: turn **OFF** "Allow new users to sign up".
7. **Project Settings → API**: copy the **Project URL** and the **anon public key**.

### 2. Run locally
```bash
cp .env.example .env        # paste the URL + anon key
npm install
npm run dev                 # http://localhost:5173
```

### 3. Deploy on Render
1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → pick the repo. `render.yaml` sets up a static site with SPA rewrites.
   *(Or do it by hand: New → Static Site, Build `npm install && npm run build`, Publish dir `dist`, and add a Rewrite rule `/*` → `/index.html`.)*
3. Under Environment, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then deploy.
4. In Supabase → Authentication → URL Configuration, set the **Site URL** to your Render URL.

To add more staff logins later, repeat steps 1.4 and 1.5.

---

## Project structure

```
supabase/
  migrations/001_schema.sql   tables, views, triggers, RLS, realtime
  migrations/002_security_hardening.sql   advisor fixes
  migrations/003_multiday_and_attendance.sql   multi-day payments (paid till), collection sheet, staff attendance
  migrations/004_loan_renewal.sql   loan renewal (old balance cut from new loan, no-cash adjustment)
  migrations/005_no_future_money_dates.sql   money entries cannot have a future date (keeps every page in sync)
  migrations/010_employee_leave_cut.sql   salary cut per absent day set on each employee
  migrations/011_monthly_loans.sql   monthly loans (loans.frequency, periods_due / period_date, views use installments)
  migrations/016_cut_old_overdue.sql   cut old loans' overdue from a new loan (old loans keep running)
  migrations/019_renewal_in_ledger_cash_start.sql   renewal shows as loan given + collection; cash in hand counted from Settings → Cash start date
  migrations/020_edit_loan_terms_sync.sql   save loan terms and payout corrections atomically
  seed.sql                    optional demo data
src/
  lib/        supabase client, formatting, loan maths, data hooks
  context/    auth + settings
  components/ layout (sidebar, cash-in-hand pill), UI kit, toasts
  pages/      Dashboard, Collection, DayBook, DailySummary, Monthly, Expenses, CashBook, Settings
  pages/loans/      LoansList, LoanForm, LoanDetail, Borrowers, BorrowerDetail
  pages/employees/  Employees, EmployeeDetail, SalaryReport
render.yaml   Render blueprint (static site)
```

## Security notes
* The anon key is safe to expose. Without an admin login, RLS returns nothing; this was tested with a non-admin user, who saw 0 rows.
* Keep public sign-ups turned off in Supabase.
* All dates use India time (`Asia/Kolkata`).
