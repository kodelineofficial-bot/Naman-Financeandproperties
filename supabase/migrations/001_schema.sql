-- =====================================================================
--  Bahi Khata CRM — money-lending admin panel
--  Supabase / Postgres schema
--
--  Run this whole file once in Supabase → SQL Editor (or `supabase db push`).
--
--  Design principle: every rupee that moves is a row in one of the
--  transaction tables. The `ledger` view unions them all, and every report
--  (day book, daily summary, monthly, dashboard balance) is built on that
--  view — so all pages always agree with each other.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- "Today" in India, regardless of the server's UTC clock.
create or replace function public.today_ist()
returns date
language sql
stable
as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- ---------------------------------------------------------------------
-- Admins (who is allowed into the panel)
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

-- ---------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id                    int primary key default 1 check (id = 1),
  business_name         text    not null default 'Bahi Khata',
  owner_name            text,
  phone                 text,
  address               text,
  -- Cash in hand on the day you start using the software.
  opening_balance       numeric(14,2) not null default 0,
  -- Defaults that pre-fill the "New loan" form. Every value is editable per loan.
  default_interest_pct  numeric(6,2)  not null default 4,     -- upfront interest cut (4% of 10,000 = 400)
  default_markup_pct    numeric(6,2)  not null default 20,    -- 10,000 → 12,000 total repayable
  default_daily_per_10k numeric(14,2) not null default 150,   -- ₹150/day per ₹10,000
  default_advance_days  int           not null default 10,    -- installments kept upfront
  updated_at            timestamptz   not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Borrowers (उधार लेने वाले)
-- ---------------------------------------------------------------------
create table if not exists public.borrowers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  phone           text,
  alt_phone       text,
  occupation      text,            -- what work they do (काम)
  address         text,
  id_proof        text,            -- Aadhaar / PAN no. etc. (optional)
  guarantor_name  text,
  guarantor_phone text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists borrowers_name_idx  on public.borrowers (lower(name));
create index if not exists borrowers_phone_idx on public.borrowers (phone);

-- ---------------------------------------------------------------------
-- Loans (उधारी)
--
-- Worked example (all values are per-loan and editable):
--   principal           10,000
--   interest_pct 4%  →  interest_amount 400 (cut upfront)
--   daily_installment   150
--   total_repayable     12,000  (= 150 × 80 days, i.e. 20% markup)
--   advance_days 10  →  advance_amount 1,500 (10 installments kept upfront)
--   net_disbursable     10,000 − 400 − 1,500 = 8,100   (can be given in parts)
--   to collect daily    12,000 − 1,500 = 10,500  (70 days × 150)
-- ---------------------------------------------------------------------
create table if not exists public.loans (
  id                    uuid primary key default gen_random_uuid(),
  loan_no               bigint generated always as identity unique,
  borrower_id           uuid not null references public.borrowers (id) on delete restrict,
  principal             numeric(14,2) not null check (principal > 0),
  interest_pct          numeric(6,2)  not null default 0,
  interest_amount       numeric(14,2) not null default 0 check (interest_amount >= 0),
  markup_pct            numeric(6,2)  not null default 0,
  total_repayable       numeric(14,2) not null check (total_repayable > 0),
  daily_installment     numeric(14,2) not null check (daily_installment > 0),
  duration_days         int           not null check (duration_days > 0),
  advance_days          int           not null default 0 check (advance_days >= 0),
  advance_amount        numeric(14,2) not null default 0 check (advance_amount >= 0),
  net_disbursable       numeric(14,2) generated always as (principal - interest_amount - advance_amount) stored,
  loan_date             date not null default public.today_ist(),
  collection_start_date date not null default public.today_ist(),
  status                text not null default 'active'
                        check (status in ('active', 'closed', 'defaulted', 'cancelled')),
  closed_on             date,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint loans_advance_le_total check (advance_amount <= total_repayable),
  constraint loans_net_non_negative check (principal - interest_amount - advance_amount >= 0)
);
create index if not exists loans_borrower_idx on public.loans (borrower_id);
create index if not exists loans_status_idx   on public.loans (status);
create index if not exists loans_date_idx     on public.loans (loan_date);

-- Money GIVEN to the borrower (net amount can be paid out in several parts).
create table if not exists public.loan_disbursements (
  id         uuid primary key default gen_random_uuid(),
  loan_id    uuid not null references public.loans (id) on delete cascade,
  paid_on    date not null default public.today_ist(),
  amount     numeric(14,2) not null check (amount > 0),
  mode       text not null default 'cash',
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists loan_disb_loan_idx on public.loan_disbursements (loan_id);
create index if not exists loan_disb_date_idx on public.loan_disbursements (paid_on);

-- Money COLLECTED back from the borrower (daily installments).
create table if not exists public.loan_repayments (
  id         uuid primary key default gen_random_uuid(),
  loan_id    uuid not null references public.loans (id) on delete cascade,
  paid_on    date not null default public.today_ist(),
  amount     numeric(14,2) not null check (amount > 0),
  mode       text not null default 'cash',
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists loan_rep_loan_idx on public.loan_repayments (loan_id);
create index if not exists loan_rep_date_idx on public.loan_repayments (paid_on);

-- ---------------------------------------------------------------------
-- Employees (कर्मचारी)
-- ---------------------------------------------------------------------
create table if not exists public.employees (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  phone          text,
  designation    text,
  address        text,
  id_proof       text,
  joining_date   date not null default public.today_ist(),
  monthly_salary numeric(14,2) not null default 0 check (monthly_salary >= 0),
  is_active      boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Salary advance or loan taken by an employee. Deducted from the salary of `deduct_month`.
create table if not exists public.employee_advances (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.employees (id) on delete cascade,
  given_on     date not null default public.today_ist(),
  amount       numeric(14,2) not null check (amount > 0),
  kind         text not null default 'advance' check (kind in ('advance', 'loan')),
  deduct_month date not null default date_trunc('month', public.today_ist())::date,
  mode         text not null default 'cash',
  note         text,
  created_at   timestamptz not null default now(),
  constraint employee_advances_month_first check (deduct_month = date_trunc('month', deduct_month)::date)
);
create index if not exists emp_adv_emp_idx   on public.employee_advances (employee_id);
create index if not exists emp_adv_month_idx on public.employee_advances (deduct_month);
create index if not exists emp_adv_date_idx  on public.employee_advances (given_on);

-- Salary actually paid out.
create table if not exists public.salary_payments (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.employees (id) on delete cascade,
  salary_month date not null,
  paid_on      date not null default public.today_ist(),
  amount       numeric(14,2) not null check (amount > 0),
  mode         text not null default 'cash',
  note         text,
  created_at   timestamptz not null default now(),
  constraint salary_payments_month_first check (salary_month = date_trunc('month', salary_month)::date)
);
create index if not exists sal_pay_emp_idx   on public.salary_payments (employee_id);
create index if not exists sal_pay_month_idx on public.salary_payments (salary_month);
create index if not exists sal_pay_date_idx  on public.salary_payments (paid_on);

-- ---------------------------------------------------------------------
-- Daily expenses (खर्चा)
-- ---------------------------------------------------------------------
create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  spent_on    date not null default public.today_ist(),
  category    text not null default 'Misc',
  amount      numeric(14,2) not null check (amount > 0),
  mode        text not null default 'cash',
  paid_to     text,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists expenses_date_idx     on public.expenses (spent_on);
create index if not exists expenses_category_idx on public.expenses (category);

-- ---------------------------------------------------------------------
-- Cash book adjustments: capital added by owner, owner withdrawals,
-- other income, bank deposits, etc.
-- ---------------------------------------------------------------------
create table if not exists public.cash_entries (
  id          uuid primary key default gen_random_uuid(),
  entry_date  date not null default public.today_ist(),
  direction   text not null check (direction in ('in', 'out')),
  amount      numeric(14,2) not null check (amount > 0),
  mode        text not null default 'cash',
  party       text,
  description text,
  created_at  timestamptz not null default now()
);
create index if not exists cash_entries_date_idx on public.cash_entries (entry_date);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
drop trigger if exists trg_borrowers_touch on public.borrowers;
create trigger trg_borrowers_touch before update on public.borrowers
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_loans_touch on public.loans;
create trigger trg_loans_touch before update on public.loans
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_employees_touch on public.employees;
create trigger trg_employees_touch before update on public.employees
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_expenses_touch on public.expenses;
create trigger trg_expenses_touch before update on public.expenses
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_settings_touch on public.settings;
create trigger trg_settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Auto-close / re-open loans when collections reach the total
-- ---------------------------------------------------------------------
create or replace function public.recalc_loan_status(p_loan uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due       numeric;
  v_status    text;
  v_collected numeric;
  v_last      date;
begin
  select total_repayable - advance_amount, status
    into v_due, v_status
    from loans where id = p_loan;

  if not found then
    return null;
  end if;

  select coalesce(sum(amount), 0), max(paid_on)
    into v_collected, v_last
    from loan_repayments where loan_id = p_loan;

  if v_status in ('active', 'defaulted') and v_collected >= v_due then
    update loans set status = 'closed', closed_on = coalesce(v_last, today_ist()) where id = p_loan;
    return 'closed';
  elsif v_status = 'closed' and v_collected < v_due then
    update loans set status = 'active', closed_on = null where id = p_loan;
    return 'active';
  end if;

  return v_status;
end
$$;

create or replace function public.trg_repayment_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform recalc_loan_status(old.loan_id);
  else
    perform recalc_loan_status(new.loan_id);
    if tg_op = 'UPDATE' and old.loan_id <> new.loan_id then
      perform recalc_loan_status(old.loan_id);
    end if;
  end if;
  return null;
end
$$;

drop trigger if exists trg_loan_repayments_status on public.loan_repayments;
create trigger trg_loan_repayments_status
  after insert or update or delete on public.loan_repayments
  for each row execute function public.trg_repayment_status();

-- Only admins may call it from the API.
revoke execute on function public.recalc_loan_status(uuid) from public, anon;

-- ---------------------------------------------------------------------
-- VIEWS (security_invoker = on → RLS of the caller applies)
-- ---------------------------------------------------------------------

-- One row per loan with live balances.
create or replace view public.loan_summary
with (security_invoker = on) as
with d as (
  select loan_id, sum(amount) as disbursed, max(paid_on) as last_disbursed_on
  from public.loan_disbursements group by loan_id
),
r as (
  select loan_id,
         sum(amount)                                         as collected,
         max(paid_on)                                        as last_paid_on,
         count(*)                                            as payment_count,
         sum(amount) filter (where paid_on = public.today_ist()) as paid_today
  from public.loan_repayments group by loan_id
),
base as (
  select l.*,
         b.name       as borrower_name,
         b.phone      as borrower_phone,
         b.occupation as borrower_occupation,
         b.address    as borrower_address,
         coalesce(d.disbursed, 0)  as disbursed,
         d.last_disbursed_on,
         coalesce(r.collected, 0)  as collected_cash,
         coalesce(r.collected, 0) + l.advance_amount as collected_total,
         r.last_paid_on,
         coalesce(r.payment_count, 0) as payment_count,
         coalesce(r.paid_today, 0) as paid_today,
         greatest(public.today_ist() - l.collection_start_date + 1, 0) as days_elapsed
  from public.loans l
  join public.borrowers b on b.id = l.borrower_id
  left join d on d.loan_id = l.id
  left join r on r.loan_id = l.id
)
select base.*,
       base.net_disbursable - base.disbursed as pending_disbursement,
       greatest(base.total_repayable - base.collected_total, 0) as outstanding,
       least(base.total_repayable,
             base.advance_amount + base.days_elapsed * base.daily_installment) as expected_till_today,
       case when base.status in ('active', 'defaulted') then
         greatest(least(base.total_repayable,
                        base.advance_amount + base.days_elapsed * base.daily_installment)
                  - base.collected_total, 0)
       else 0 end as overdue,
       base.collection_start_date
         + (ceil(greatest(base.total_repayable - base.advance_amount, 0) / base.daily_installment))::int
         - 1 as expected_end_date,
       ceil(greatest(base.total_repayable - base.collected_total, 0) / base.daily_installment)::int
         as installments_left,
       round(case when base.total_repayable > 0
                  then base.collected_total / base.total_repayable * 100 else 0 end, 1) as progress_pct,
       (base.total_repayable - base.principal + base.interest_amount) as expected_profit
from base;

-- Every rupee in or out, from every table, in one place.
create or replace view public.ledger
with (security_invoker = on) as
select ld.id,
       ld.paid_on                                    as entry_date,
       'disbursement'::text                          as kind,
       'out'::text                                   as direction,
       ld.amount,
       ld.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name)    as party,
       ld.note                                       as note,
       l.id                                          as ref_id,
       ld.created_at
from public.loan_disbursements ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
union all
select lr.id, lr.paid_on, 'collection', 'in', lr.amount, lr.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name), lr.note, l.id, lr.created_at
from public.loan_repayments lr
join public.loans l on l.id = lr.loan_id
join public.borrowers b on b.id = l.borrower_id
union all
select e.id, e.spent_on, 'expense', 'out', e.amount, e.mode,
       (e.category || coalesce(' — ' || nullif(e.paid_to, ''), '')), e.description, null::uuid, e.created_at
from public.expenses e
union all
select s.id, s.paid_on, 'salary', 'out', s.amount, s.mode,
       (emp.name || ' (salary ' || to_char(s.salary_month, 'Mon YYYY') || ')'), s.note, emp.id, s.created_at
from public.salary_payments s
join public.employees emp on emp.id = s.employee_id
union all
select a.id, a.given_on, 'employee_advance', 'out', a.amount, a.mode,
       (emp.name || ' (' || a.kind || ')'), a.note, emp.id, a.created_at
from public.employee_advances a
join public.employees emp on emp.id = a.employee_id
union all
select c.id, c.entry_date,
       case when c.direction = 'in' then 'capital_in' else 'capital_out' end,
       c.direction, c.amount, c.mode, coalesce(c.party, ''), c.description, null::uuid, c.created_at
from public.cash_entries c;

-- Day-by-day totals with running cash balance.
create or replace view public.daily_cashflow
with (security_invoker = on) as
with agg as (
  select entry_date,
         coalesce(sum(amount) filter (where direction = 'in'), 0)  as total_in,
         coalesce(sum(amount) filter (where direction = 'out'), 0) as total_out,
         coalesce(sum(amount) filter (where kind = 'collection'), 0)       as collections,
         coalesce(sum(amount) filter (where kind = 'disbursement'), 0)     as disbursements,
         coalesce(sum(amount) filter (where kind = 'expense'), 0)          as expenses,
         coalesce(sum(amount) filter (where kind = 'salary'), 0)           as salaries,
         coalesce(sum(amount) filter (where kind = 'employee_advance'), 0) as employee_advances,
         coalesce(sum(amount) filter (where kind = 'capital_in'), 0)       as capital_in,
         coalesce(sum(amount) filter (where kind = 'capital_out'), 0)      as capital_out,
         count(*) as txn_count
  from public.ledger
  group by entry_date
)
select agg.*,
       agg.total_in - agg.total_out as net,
       (select opening_balance from public.settings where id = 1)
         + sum(agg.total_in - agg.total_out) over (order by agg.entry_date) as closing_balance
from agg;

-- Month-by-month totals with running cash balance.
create or replace view public.monthly_cashflow
with (security_invoker = on) as
with agg as (
  select date_trunc('month', entry_date)::date as month,
         coalesce(sum(amount) filter (where direction = 'in'), 0)  as total_in,
         coalesce(sum(amount) filter (where direction = 'out'), 0) as total_out,
         coalesce(sum(amount) filter (where kind = 'collection'), 0)       as collections,
         coalesce(sum(amount) filter (where kind = 'disbursement'), 0)     as disbursements,
         coalesce(sum(amount) filter (where kind = 'expense'), 0)          as expenses,
         coalesce(sum(amount) filter (where kind = 'salary'), 0)           as salaries,
         coalesce(sum(amount) filter (where kind = 'employee_advance'), 0) as employee_advances,
         coalesce(sum(amount) filter (where kind = 'capital_in'), 0)       as capital_in,
         coalesce(sum(amount) filter (where kind = 'capital_out'), 0)      as capital_out,
         count(*) as txn_count
  from public.ledger
  group by 1
)
select agg.*,
       agg.total_in - agg.total_out as net,
       (select opening_balance from public.settings where id = 1)
         + sum(agg.total_in - agg.total_out) over (order by agg.month) as closing_balance
from agg;

-- Loans issued per month (business volume & income booked).
create or replace view public.loans_monthly
with (security_invoker = on) as
select date_trunc('month', loan_date)::date as month,
       count(*)                                    as loans_count,
       sum(principal)                              as principal_issued,
       sum(interest_amount)                        as interest_earned,
       sum(advance_amount)                         as advance_kept,
       sum(total_repayable - principal)            as markup_booked,
       sum(total_repayable)                        as total_repayable
from public.loans
where status <> 'cancelled'
group by 1;

-- ---------------------------------------------------------------------
-- Salary report for a month
-- balance = salary − advances deducted this month − salary already paid
-- ---------------------------------------------------------------------
create or replace function public.salary_report(p_month date)
returns table (
  employee_id    uuid,
  name           text,
  designation    text,
  phone          text,
  is_active      boolean,
  monthly_salary numeric,
  advances       numeric,
  paid           numeric,
  balance        numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with m as (select date_trunc('month', p_month)::date as month),
  x as (
    select e.id, e.name, e.designation, e.phone, e.is_active, e.monthly_salary,
           coalesce((select sum(a.amount) from employee_advances a, m
                     where a.employee_id = e.id and a.deduct_month = m.month), 0) as advances,
           coalesce((select sum(s.amount) from salary_payments s, m
                     where s.employee_id = e.id and s.salary_month = m.month), 0) as paid
    from employees e, m
    where e.joining_date <= (m.month + interval '1 month - 1 day')::date
  )
  select id, name, designation, phone, is_active, monthly_salary, advances, paid,
         monthly_salary - advances - paid as balance
  from x
  where is_active or advances > 0 or paid > 0
  order by name
$$;

-- ---------------------------------------------------------------------
-- Row Level Security — only users listed in public.admins can do anything
-- ---------------------------------------------------------------------
alter table public.admins enable row level security;
drop policy if exists admins_self_read on public.admins;
create policy admins_self_read on public.admins
  for select to authenticated using (user_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array[
    'settings', 'borrowers', 'loans', 'loan_disbursements', 'loan_repayments',
    'employees', 'employee_advances', 'salary_payments', 'expenses', 'cash_entries'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format(
      'create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      t);
  end loop;
end
$$;

grant execute on function public.salary_report(date) to authenticated;
grant execute on function public.recalc_loan_status(uuid) to authenticated;
grant execute on function public.today_ist() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: lets every open screen refresh when data changes elsewhere
-- (e.g. collection boy enters a payment on his phone → owner's screen updates).
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'borrowers', 'loans', 'loan_disbursements', 'loan_repayments',
      'employees', 'employee_advances', 'salary_payments', 'expenses', 'cash_entries', 'settings'
    ] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end
$$;

-- =====================================================================
--  AFTER RUNNING THIS FILE:
--  1. Supabase → Authentication → Users → "Add user" (email + password)
--  2. Make that user an admin:
--       insert into public.admins (user_id, name)
--       select id, 'Owner' from auth.users where email = 'owner@example.com';
--  3. Authentication → Sign In / Providers → turn OFF "Allow new users to sign up".
-- =====================================================================
