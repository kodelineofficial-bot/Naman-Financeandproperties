-- =====================================================================
-- 008: Advance kept at loan time is INCOME, loan given is the full cash
--
-- Example: ₹10,000 @4%, 10 advance days of ₹150
--   Before: cash book showed  Loan given −8,100
--   Now:    cash book shows   Loan given −9,600  (principal − interest)
--                             Advance kept +1,500 (income, एडवांस)
--   Net cash movement is still −8,100, so balances do not change.
--
-- The loan_disbursements table still stores what was physically handed
-- over (8,100), so "To give" on a loan keeps working. Only the ledger
-- (and the daily / monthly cash flow built on it) shows the gross split.
--
-- Rule: the advance is attached to the loan's FIRST cash disbursement
-- (mode <> 'renewal'). A renewal loan with no cash handed over has the
-- advance already netted inside the renewal adjustment, so nothing is shown.
--
-- Changed: ledger            + kind 'loan_advance' (in), first disbursement grossed up
--          daily_cashflow    + advances_kept column (appended)
--          monthly_cashflow  + advances_kept column (appended)
-- =====================================================================

create or replace view public.ledger
with (security_invoker = on) as
with cash_disb as (
  select ld.*,
         row_number() over (partition by ld.loan_id order by ld.paid_on, ld.created_at, ld.id) as rn
  from public.loan_disbursements ld
  where ld.mode <> 'renewal'
)
select ld.id,
       ld.paid_on                                    as entry_date,
       'disbursement'::text                          as kind,
       'out'::text                                   as direction,
       (ld.amount + case when ld.rn = 1 then l.advance_amount else 0 end)::numeric(14,2) as amount,
       ld.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name)    as party,
       ld.note                                       as note,
       l.id                                          as ref_id,
       ld.created_at
from cash_disb ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
union all
-- Advance kept back from the loan = money received (income), same moment as the first payout.
select l.id, ld.paid_on, 'loan_advance', 'in', l.advance_amount, ld.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name),
       ('Advance ' || l.advance_days || ' days kept from loan'), l.id, ld.created_at
from cash_disb ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
where ld.rn = 1 and l.advance_amount > 0
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
         coalesce(sum(amount) filter (where kind = 'penalty'), 0)          as penalties,
         coalesce(sum(amount) filter (where kind = 'loan_advance'), 0)     as advances_kept
  from public.ledger
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
         coalesce(sum(amount) filter (where kind = 'penalty'), 0)          as penalties,
         coalesce(sum(amount) filter (where kind = 'loan_advance'), 0)     as advances_kept
  from public.ledger
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
