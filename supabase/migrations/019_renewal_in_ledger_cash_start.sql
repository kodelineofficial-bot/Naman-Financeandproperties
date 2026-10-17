-- =====================================================================
--  019 — Renewal shows in the day's money + cash start date
--
--  1) Full renewal (004) now shows like an overdue cut (017):
--     Example: new ₹10,000 loan, net ₹9,600, old loan ₹5,000 left,
--     ₹4,600 cash handed over.
--       Before: Loan given ₹4,600, Collection —
--       Now   : Loan given ₹9,600 (4,600 cash + 5,000 adjusted)
--               Collection ₹5,000 (on the old loan)
--     In and out on the same day, so cash in hand does not change.
--     A discount (chhoot) is still not counted, only what was adjusted.
--
--  2) settings.cash_start_date: cash in hand is counted only from this
--     day, starting from settings.opening_balance. Entries before it
--     (old loans typed in later) still show in the Day Book and still
--     count for loan balances, but not for cash in hand.
--     Empty = count everything (old behaviour).
-- =====================================================================

alter table public.settings add column if not exists cash_start_date date;

create or replace view public.ledger
with (security_invoker = on) as
with cash_disb as (
  select ld.id, ld.loan_id, ld.paid_on, ld.amount, ld.mode, ld.note, ld.created_at,
         row_number() over (partition by ld.loan_id order by ld.paid_on, ld.created_at, ld.id) as rn
  from public.loan_disbursements ld
  where ld.mode not in ('renewal', 'opening')
),
-- every adjusted repayment (renewal or overdue cut) with the new loan it went into
adjusted as (
  select lr.id, lr.loan_id, lr.paid_on, lr.amount, lr.mode, lr.note, lr.created_at, lr.adjusted_into,
         coalesce(lr.adjusted_into, nl.id) as new_loan_id
  from public.loan_repayments lr
  left join lateral (
    select n.id from public.loans n
    where n.renewed_from = lr.loan_id
    order by n.created_at desc
    limit 1
  ) nl on lr.adjusted_into is null
  where lr.mode = 'renewal'
)
select ld.id,
       ld.paid_on                                    as entry_date,
       'disbursement'::text                          as kind,
       'out'::text                                   as direction,
       (ld.amount + case when ld.rn = 1 then l.advance_amount else 0 end)::numeric(14,2) as amount,
       ld.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name)    as party,
       ld.note,
       l.id                                          as ref_id,
       ld.created_at
from cash_disb ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
union all
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
-- adjusted: the old loan's side (collection)
select a.id, a.paid_on, 'collection', 'in', a.amount, a.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name), a.note, l.id, a.created_at
from adjusted a
join public.loans l on l.id = a.loan_id
join public.borrowers b on b.id = l.borrower_id
where a.new_loan_id is not null
union all
-- adjusted: the new loan's side (part of the loan given)
select a.id, a.paid_on, 'disbursement', 'out', a.amount, a.mode,
       ('Loan #' || nl.loan_no || ' — ' || b.name),
       ('Loan #' || l.loan_no || case when a.adjusted_into is null then ' balance adjusted' else ' overdue cut' end),
       nl.id, a.created_at
from adjusted a
join public.loans l  on l.id = a.loan_id
join public.loans nl on nl.id = a.new_loan_id
join public.borrowers b on b.id = nl.borrower_id
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

-- Cash in hand = opening + net of the days from cash_start_date on.
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
),
s as (select opening_balance, cash_start_date from public.settings where id = 1)
select agg.entry_date, agg.total_in, agg.total_out, agg.collections, agg.disbursements, agg.expenses,
       agg.salaries, agg.employee_advances, agg.capital_in, agg.capital_out, agg.txn_count,
       agg.total_in - agg.total_out as net,
       s.opening_balance
         + sum(case when s.cash_start_date is null or agg.entry_date >= s.cash_start_date
                    then agg.total_in - agg.total_out else 0 end) over (order by agg.entry_date) as closing_balance,
       agg.penalties,
       agg.advances_kept
from agg cross join s;

create or replace view public.monthly_cashflow
with (security_invoker = on) as
with s as (select opening_balance, cash_start_date from public.settings where id = 1),
l as (
  select entry_date, kind, direction,
         case when mode = 'upi' then 0 else amount end as amount
  from public.ledger
),
agg as (
  select date_trunc('month', l.entry_date)::date as month,
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
         coalesce(sum(amount) filter (where kind = 'loan_advance'), 0)     as advances_kept,
         coalesce(sum(case when direction = 'in' then amount else -amount end)
                  filter (where s.cash_start_date is null or l.entry_date >= s.cash_start_date), 0) as counted_net
  from l cross join s
  group by 1
)
select agg.month, agg.total_in, agg.total_out, agg.collections, agg.disbursements, agg.expenses,
       agg.salaries, agg.employee_advances, agg.capital_in, agg.capital_out, agg.txn_count,
       agg.total_in - agg.total_out as net,
       s.opening_balance + sum(agg.counted_net) over (order by agg.month) as closing_balance,
       agg.penalties,
       agg.advances_kept
from agg cross join s;
