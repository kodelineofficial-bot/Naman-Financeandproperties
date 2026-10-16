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

---

## Setup (about 15 minutes)

### 1. Supabase
1. Create a project at https://supabase.com and choose region **Mumbai (ap-south-1)**.
2. **SQL Editor → New query**: paste and **Run** each file in `supabase/migrations/` in order (`001_schema.sql`, `002_security_hardening.sql`, `003_multiday_and_attendance.sql`, `004_loan_renewal.sql`, `005_no_future_money_dates.sql`, `006_penalty_and_whatsapp_templates.sql`, `007_advance_covers_first_days.sql`, `008_advance_as_income.sql`, `009_loan_penalty_amount.sql`, `010_employee_leave_cut.sql`, `011_monthly_loans.sql`, `012_default_freeze_resume.sql`, `013_profile_photos.sql`, `014_old_defaulters.sql`, `015_penalty_opening.sql`).
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
