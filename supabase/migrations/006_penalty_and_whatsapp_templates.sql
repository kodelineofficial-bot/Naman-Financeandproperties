-- =====================================================================
--  006 — Late payment penalty (जुर्माना) + WhatsApp message templates
--
--  PENALTY
--  The owner sets the rule in Settings:
--    penalty_per_day     ₹ charged for every day the loan is behind
--    penalty_grace_days  how many installments behind are allowed free
--                        (0 = penalty from the first missed day)
--    penalty_from        days before this date are never charged, so
--                        turning the rule on does not charge old history
--
--  A day counts as a "penalty day" when, at the END of that day, the
--  amount collected is short of the schedule by more than
--  grace_days × daily installment. Today is never counted (the borrower
--  can still pay today). Penalty days are worked out from the payment
--  history, so paying later does not erase penalty already earned.
--
--    penalty_charged = penalty days × penalty_per_day
--    penalty_due     = charged − paid − waived (माफ़)
--
--  Penalty money received is a separate entry (loan_penalty_entries,
--  kind 'paid') — it does NOT reduce the loan balance. It shows in the
--  ledger / cash book as kind 'penalty'. A waiver (kind 'waived') is not cash.
--
--  WHATSAPP TEMPLATES
--  message_templates holds the texts the admin can create / edit.
--  {placeholders} are filled in the browser before WhatsApp opens.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings: penalty rule (off until the owner turns it on)
-- ---------------------------------------------------------------------
alter table public.settings
  add column if not exists penalty_enabled    boolean       not null default false,
  add column if not exists penalty_per_day    numeric(14,2) not null default 0,
  add column if not exists penalty_grace_days int           not null default 0,
  add column if not exists penalty_from       date          not null default public.today_ist();

alter table public.settings drop constraint if exists settings_penalty_check;
alter table public.settings add constraint settings_penalty_check
  check (penalty_per_day >= 0 and penalty_grace_days >= 0);

-- Per-loan switch: no penalty for this loan.
alter table public.loans
  add column if not exists penalty_off boolean not null default false;

-- ---------------------------------------------------------------------
-- Penalty received / waived
-- ---------------------------------------------------------------------
create table if not exists public.loan_penalty_entries (
  id         uuid primary key default gen_random_uuid(),
  loan_id    uuid not null references public.loans (id) on delete cascade,
  paid_on    date not null default public.today_ist(),
  kind       text not null default 'paid' check (kind in ('paid', 'waived')),
  amount     numeric(14,2) not null check (amount > 0),
  mode       text not null default 'cash',
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists loan_pen_loan_idx on public.loan_penalty_entries (loan_id);
create index if not exists loan_pen_date_idx on public.loan_penalty_entries (paid_on);

drop trigger if exists no_future_date on public.loan_penalty_entries;
create trigger no_future_date before insert or update of paid_on on public.loan_penalty_entries
  for each row execute function public.reject_future_money_date('paid_on');

-- ---------------------------------------------------------------------
-- WhatsApp message templates
--   use_for: which button picks it first ('reminder' when only the
--   installment is pending, 'penalty' when penalty is due). One each.
-- ---------------------------------------------------------------------
create table if not exists public.message_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  body       text not null,
  use_for    text check (use_for in ('reminder', 'penalty')),
  sort       int  not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists message_templates_use_for_uq
  on public.message_templates (use_for) where use_for is not null;

drop trigger if exists trg_message_templates_touch on public.message_templates;
create trigger trg_message_templates_touch before update on public.message_templates
  for each row execute function public.touch_updated_at();

-- Ready-made templates (English). Same text as BUILTIN_TEMPLATES in src/lib/messages.js.
insert into public.message_templates (name, body, use_for, sort)
select v.name, v.body, v.use_for, v.sort
from (values
  ('Daily payment reminder',
   E'Hello {name},\n\nThis is a gentle reminder from {business}. Your daily installment of {daily} for Loan #{loan_no} is pending.\n\nPending: {pending_days} day(s) ({overdue})\nPaid till: {paid_till}\n\nPlease pay today. Thank you!',
   'reminder', 1),
  ('Late payment penalty',
   E'Dear {name},\n\nYour daily installment for Loan #{loan_no} has not been paid for {pending_days} day(s).\n\nOverdue amount: {overdue}\nLate penalty ({penalty_rate} per day): {penalty}\nTotal to pay now: {total_due}\n\nPlease pay today to avoid further penalty.\n\n- {business} {business_phone}',
   'penalty', 2),
  ('Final notice',
   E'Dear {name},\n\nFINAL REMINDER for Loan #{loan_no}.\n\nOverdue: {overdue}\nPenalty: {penalty}\nTotal due: {total_due}\nLoan balance: {balance}\n\nPlease clear the dues within 2 days. If not paid, we will have to contact your guarantor.\n\n- {business} {business_phone}',
   null, 3),
  ('Loan balance statement',
   E'Hello {name},\n\nLoan #{loan_no} statement as on {today}:\nDaily installment: {daily}\nPaid till: {paid_till}\nBalance to pay: {balance}\nLast date: {end_date}\n\nThank you,\n{business}',
   null, 4)
) as v(name, body, use_for, sort)
where not exists (select 1 from public.message_templates);

-- ---------------------------------------------------------------------
-- RLS + realtime for the new tables
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['loan_penalty_entries', 'message_templates'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format(
      'create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      t);
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- loan_penalty: one row per loan
-- ---------------------------------------------------------------------
create or replace view public.loan_penalty
with (security_invoker = on) as
with s as (
  select penalty_enabled, penalty_per_day, penalty_grace_days, penalty_from
  from public.settings where id = 1
),
lp as (
  select l.id as loan_id,
         l.daily_installment as daily,
         l.total_repayable - l.advance_amount as to_collect,
         l.collection_start_date as start_d,
         greatest(l.collection_start_date, s.penalty_from) as from_d,
         -- last day that can be charged: yesterday, or the day before the loan closed
         case when l.status in ('active', 'defaulted') then public.today_ist() - 1
              when l.status in ('closed', 'renewed') then least(public.today_ist() - 1, l.closed_on - 1)
         end as to_d,
         s.penalty_per_day as rate,
         s.penalty_grace_days as grace,
         (s.penalty_enabled and not l.penalty_off and s.penalty_per_day > 0) as on_
  from public.loans l cross join s
),
paid_day as (
  select loan_id, paid_on, sum(amount) as amt
  from public.loan_repayments group by loan_id, paid_on
),
days as (
  select lp.loan_id, g.d::date as d, lp.from_d, lp.daily, lp.to_collect, lp.start_d, lp.grace,
         -- everything paid before collection started, plus a running total from then on
         coalesce((select sum(p.amt) from paid_day p where p.loan_id = lp.loan_id and p.paid_on < lp.start_d), 0)
           + sum(coalesce(pd.amt, 0)) over (partition by lp.loan_id order by g.d) as upto
  from lp
  cross join lateral generate_series(lp.start_d, lp.to_d, interval '1 day') g(d)
  left join paid_day pd on pd.loan_id = lp.loan_id and pd.paid_on = g.d::date
  where lp.on_ and lp.to_d >= lp.from_d
),
counted as (
  select loan_id, count(*)::int as penalty_days
  from days
  where d >= from_d
    and least(to_collect, (d - start_d + 1) * daily) - upto > grace * daily + 0.001
  group by loan_id
),
e as (
  select loan_id,
         coalesce(sum(amount) filter (where kind = 'paid'), 0)   as paid,
         coalesce(sum(amount) filter (where kind = 'waived'), 0) as waived
  from public.loan_penalty_entries group by loan_id
)
select lp.loan_id,
       coalesce(c.penalty_days, 0) as penalty_days,
       lp.rate as penalty_rate,
       coalesce(c.penalty_days, 0) * lp.rate as penalty_charged,
       coalesce(e.paid, 0)   as penalty_paid,
       coalesce(e.waived, 0) as penalty_waived,
       greatest(coalesce(c.penalty_days, 0) * lp.rate - coalesce(e.paid, 0) - coalesce(e.waived, 0), 0) as penalty_due
from lp
left join counted c on c.loan_id = lp.loan_id
left join e on e.loan_id = lp.loan_id;

-- ---------------------------------------------------------------------
-- loan_summary: + penalty columns (appended at the end), penalty_off
-- ---------------------------------------------------------------------
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
         sum(amount) filter (where paid_on = public.today_ist() and mode <> 'renewal') as paid_today
  from public.loan_repayments group by loan_id
),
base as (
  select l.id, l.loan_no, l.borrower_id, l.principal, l.interest_pct, l.interest_amount, l.markup_pct,
         l.total_repayable, l.daily_installment, l.duration_days, l.advance_days, l.advance_amount,
         l.net_disbursable, l.loan_date, l.collection_start_date, l.status, l.closed_on, l.notes,
         l.created_at, l.updated_at,
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
         greatest(public.today_ist() - l.collection_start_date + 1, 0) as days_elapsed,
         l.penalty_off
  from public.loans l
  join public.borrowers b on b.id = l.borrower_id
  left join d on d.loan_id = l.id
  left join r on r.loan_id = l.id
)
select base.id, base.loan_no, base.borrower_id, base.principal, base.interest_pct, base.interest_amount,
       base.markup_pct, base.total_repayable, base.daily_installment, base.duration_days, base.advance_days,
       base.advance_amount, base.net_disbursable, base.loan_date, base.collection_start_date, base.status,
       base.closed_on, base.notes, base.created_at, base.updated_at, base.borrower_name, base.borrower_phone,
       base.borrower_occupation, base.borrower_address, base.disbursed, base.last_disbursed_on,
       base.collected_cash, base.collected_total, base.last_paid_on, base.payment_count, base.paid_today,
       base.days_elapsed,
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
       (base.total_repayable - base.principal + base.interest_amount) as expected_profit,
       floor(base.collected_cash / base.daily_installment)::int as days_covered,
       case when base.collected_cash >= base.daily_installment
            then base.collection_start_date + floor(base.collected_cash / base.daily_installment)::int - 1
       end as paid_till,
       base.penalty_off,
       coalesce(pn.penalty_days, 0)    as penalty_days,
       coalesce(pn.penalty_rate, 0)    as penalty_rate,
       coalesce(pn.penalty_charged, 0) as penalty_charged,
       coalesce(pn.penalty_paid, 0)    as penalty_paid,
       coalesce(pn.penalty_waived, 0)  as penalty_waived,
       coalesce(pn.penalty_due, 0)     as penalty_due
from base
left join public.loan_penalty pn on pn.loan_id = base.id;

-- ---------------------------------------------------------------------
-- Ledger: + penalty received (cash in). Waivers are not cash.
-- ---------------------------------------------------------------------
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
where ld.mode <> 'renewal'
union all
select lr.id, lr.paid_on, 'collection', 'in', lr.amount, lr.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name), lr.note, l.id, lr.created_at
from public.loan_repayments lr
join public.loans l on l.id = lr.loan_id
join public.borrowers b on b.id = l.borrower_id
where lr.mode <> 'renewal'
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
from public.cash_entries c
union all
select pe.id, pe.paid_on, 'penalty', 'in', pe.amount, pe.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name), pe.note, l.id, pe.created_at
from public.loan_penalty_entries pe
join public.loans l on l.id = pe.loan_id
join public.borrowers b on b.id = l.borrower_id
where pe.kind = 'paid';

-- daily / monthly cash flow: + penalties column (appended at the end)
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
         count(*) as txn_count,
         coalesce(sum(amount) filter (where kind = 'penalty'), 0)          as penalties
  from public.ledger
  group by entry_date
)
select agg.entry_date, agg.total_in, agg.total_out, agg.collections, agg.disbursements, agg.expenses,
       agg.salaries, agg.employee_advances, agg.capital_in, agg.capital_out, agg.txn_count,
       agg.total_in - agg.total_out as net,
       (select opening_balance from public.settings where id = 1)
         + sum(agg.total_in - agg.total_out) over (order by agg.entry_date) as closing_balance,
       agg.penalties
from agg;

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
         count(*) as txn_count,
         coalesce(sum(amount) filter (where kind = 'penalty'), 0)          as penalties
  from public.ledger
  group by 1
)
select agg.month, agg.total_in, agg.total_out, agg.collections, agg.disbursements, agg.expenses,
       agg.salaries, agg.employee_advances, agg.capital_in, agg.capital_out, agg.txn_count,
       agg.total_in - agg.total_out as net,
       (select opening_balance from public.settings where id = 1)
         + sum(agg.total_in - agg.total_out) over (order by agg.month) as closing_balance,
       agg.penalties
from agg;
