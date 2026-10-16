-- =====================================================================
--  018 — UPI payments are shown but not counted in the day's money
--
--  UPI entries stay in the ledger (Day Book lists them, the loan balance
--  still goes down), but they are left out of total in / total out and
--  cash in hand. Only daily_cashflow and monthly_cashflow change: a UPI
--  row adds 0 to every total. txn_count still counts every entry.
-- =====================================================================

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
         coalesce(sum(amount) filter (where kind = 'disbursement'), 0)     as disbursements,
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
)
select agg.entry_date, agg.total_in, agg.total_out, agg.collections, agg.disbursements, agg.expenses,
       agg.salaries, agg.employee_advances, agg.capital_in, agg.capital_out, agg.txn_count,
       agg.total_in - agg.total_out as net,
       (select opening_balance from public.settings where id = 1)
         + sum(agg.total_in - agg.total_out) over (order by agg.entry_date) as closing_balance,
       agg.penalties,
       agg.advances_kept
from agg;

create or replace view public.monthly_cashflow
with (security_invoker = on) as
with l as (
  select entry_date, kind, direction,
         case when mode = 'upi' then 0 else amount end as amount
  from public.ledger
),
agg as (
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
         coalesce(sum(amount) filter (where kind = 'penalty'), 0)          as penalties,
         coalesce(sum(amount) filter (where kind = 'loan_advance'), 0)     as advances_kept
  from l
  group by 1
)
select agg.month, agg.total_in, agg.total_out, agg.collections, agg.disbursements, agg.expenses,
       agg.salaries, agg.employee_advances, agg.capital_in, agg.capital_out, agg.txn_count,
       agg.total_in - agg.total_out as net,
       (select opening_balance from public.settings where id = 1)
         + sum(agg.total_in - agg.total_out) over (order by agg.month) as closing_balance,
       agg.penalties,
       agg.advances_kept
from agg;
