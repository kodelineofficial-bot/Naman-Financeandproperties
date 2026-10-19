-- =====================================================================
--  030 — Cash count per day (opening cash that does not rewrite old days)
--
--  Until now cash in hand had one anchor: Settings opening balance +
--  cash start date. Changing either moved every day's opening and closing,
--  so fixing today's opening also changed 17 Oct, 18 Oct, …
--
--  Now the owner can count the drawer on any day (Day Book → Count cash).
--  The count is the opening cash at the START of that day:
--    closing(day) = latest count on or before day
--                   + every day's (in − out) from that count's day to day
--  Days before the first count still use Settings (opening balance from
--  the cash start date), so nothing already shown changes.
--  The difference between the count and the system's closing of the day
--  before is shown, never hidden.
--
--  New:     cash_counts
--  Changed: daily_cashflow (new columns at the end: opening_balance,
--           cash_counted, count_difference; count days get a row even with
--           no entries), monthly_cashflow (closing = last day's closing)
-- =====================================================================

begin;

create table if not exists public.cash_counts (
  count_date  date primary key,
  amount      numeric(14,2) not null check (amount >= 0),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$
begin
  alter table public.cash_counts enable row level security;
  drop policy if exists admin_all on public.cash_counts;
  create policy admin_all on public.cash_counts for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cash_counts') then
    alter publication supabase_realtime add table public.cash_counts;
  end if;
end $$;

create or replace view public.daily_cashflow
with (security_invoker = on) as
with l as (
  select entry_date, kind, direction,
         case when mode = 'upi' then 0 else amount end as amount
  from public.ledger
),
agg as (
  select entry_date,
         coalesce(sum(amount) filter (where direction = 'in'), 0)  as total_in,
         coalesce(sum(amount) filter (where direction = 'out'), 0) as total_out,
         coalesce(sum(amount) filter (where kind = 'collection'), 0)       as collections,
         coalesce(sum(amount) filter (where kind in ('disbursement', 'loan_advance_cut')), 0)     as disbursements,
         coalesce(sum(amount) filter (where kind = 'expense'), 0)          as expenses,
         coalesce(sum(amount) filter (where kind = 'salary'), 0)           as salaries,
         coalesce(sum(amount) filter (where kind = 'employee_advance'), 0) as employee_advances,
         coalesce(sum(amount) filter (where kind = 'capital_in'), 0)       as capital_in,
         coalesce(sum(amount) filter (where kind = 'capital_out'), 0)      as capital_out,
         count(*) as txn_count,
         coalesce(sum(amount) filter (where kind = 'penalty'), 0)          as penalties,
         coalesce(sum(amount) filter (where kind = 'loan_advance'), 0)     as advances_kept
  from l
  group by entry_date
),
s as (select opening_balance, cash_start_date from public.settings where id = 1),
-- every day with entries or a cash count; latest count on or before the day
d as (
  select coalesce(agg.entry_date, c.count_date) as entry_date,
         coalesce(agg.total_in, 0) as total_in, coalesce(agg.total_out, 0) as total_out,
         coalesce(agg.collections, 0) as collections, coalesce(agg.disbursements, 0) as disbursements,
         coalesce(agg.expenses, 0) as expenses, coalesce(agg.salaries, 0) as salaries,
         coalesce(agg.employee_advances, 0) as employee_advances,
         coalesce(agg.capital_in, 0) as capital_in, coalesce(agg.capital_out, 0) as capital_out,
         coalesce(agg.txn_count, 0) as txn_count,
         coalesce(agg.penalties, 0) as penalties, coalesce(agg.advances_kept, 0) as advances_kept,
         c.amount as cash_counted
  from agg
  full join public.cash_counts c on c.count_date = agg.entry_date
),
g as (
  select d.*,
         d.total_in - d.total_out as net,
         max(case when d.cash_counted is not null then d.entry_date end) over (order by d.entry_date) as anchor_date
  from d
),
c as (
  select g.*,
         case when g.anchor_date is null then
                s.opening_balance
                  + sum(case when s.cash_start_date is null or g.entry_date >= s.cash_start_date
                             then g.net else 0 end) over (partition by g.anchor_date order by g.entry_date)
              else
                first_value(g.cash_counted) over (partition by g.anchor_date order by g.entry_date)
                  + sum(g.net) over (partition by g.anchor_date order by g.entry_date)
         end as closing_balance
  from g cross join s
),
o as (
  select c.*,
         coalesce(lag(c.closing_balance) over (order by c.entry_date), s.opening_balance) as system_opening
  from c cross join s
)
select o.entry_date, o.total_in, o.total_out, o.collections, o.disbursements, o.expenses,
       o.salaries, o.employee_advances, o.capital_in, o.capital_out, o.txn_count,
       o.net,
       o.closing_balance,
       o.penalties,
       o.advances_kept,
       coalesce(o.cash_counted, o.system_opening)  as opening_balance,
       o.cash_counted,
       o.cash_counted - o.system_opening           as count_difference
from o;

create or replace view public.monthly_cashflow
with (security_invoker = on) as
with l as (
  select entry_date, kind, direction,
         case when mode = 'upi' then 0 else amount end as amount
  from public.ledger
),
agg as (
  select date_trunc('month', l.entry_date)::date as month,
         coalesce(sum(amount) filter (where direction = 'in'), 0)  as total_in,
         coalesce(sum(amount) filter (where direction = 'out'), 0) as total_out,
         coalesce(sum(amount) filter (where kind = 'collection'), 0)       as collections,
         coalesce(sum(amount) filter (where kind in ('disbursement', 'loan_advance_cut')), 0)     as disbursements,
         coalesce(sum(amount) filter (where kind = 'expense'), 0)          as expenses,
         coalesce(sum(amount) filter (where kind = 'salary'), 0)           as salaries,
         coalesce(sum(amount) filter (where kind = 'employee_advance'), 0) as employee_advances,
         coalesce(sum(amount) filter (where kind = 'capital_in'), 0)       as capital_in,
         coalesce(sum(amount) filter (where kind = 'capital_out'), 0)      as capital_out,
         count(*) as txn_count,
         coalesce(sum(amount) filter (where kind = 'penalty'), 0)          as penalties,
         coalesce(sum(amount) filter (where kind = 'loan_advance'), 0)     as advances_kept
  from l
  group by 1
)
select agg.month, agg.total_in, agg.total_out, agg.collections, agg.disbursements, agg.expenses,
       agg.salaries, agg.employee_advances, agg.capital_in, agg.capital_out, agg.txn_count,
       agg.total_in - agg.total_out as net,
       -- the month's cash in hand is the closing of its last day (cash counts included)
       (select dc.closing_balance from public.daily_cashflow dc
        where dc.entry_date < (agg.month + interval '1 month')::date
        order by dc.entry_date desc limit 1) as closing_balance,
       agg.penalties,
       agg.advances_kept
from agg;

commit;
