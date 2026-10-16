-- =====================================================================
--  017 — Overdue cut shows in the day's money (ledger)
--
--  An overdue cut (016) is money the borrower paid on the old loan out of
--  the new loan. It was kept out of the ledger as "no cash", so the day
--  showed only the cash handed over and the old loans' payment was missing.
--
--  Example: new loan net ₹4,800, ₹900 + ₹1,350 cut, ₹2,550 cash given.
--    Before: Loan given ₹2,550, Collection —
--    Now   : Loan given ₹4,800 (2,550 cash + 900 + 1,350 cut)
--            Collection ₹2,250 (900 + 1,350, on the old loans)
--  The cut is in and out on the same day, so cash in hand does not change.
--
--  Each cut repayment (mode 'renewal', adjusted_into = new loan) gives two
--  rows with the repayment's id: a 'collection' on the old loan and a
--  'disbursement' on the new loan. Full renewal (004) is unchanged.
-- =====================================================================

create or replace view public.ledger
with (security_invoker = on) as
with cash_disb as (
  select ld.id, ld.loan_id, ld.paid_on, ld.amount, ld.mode, ld.note, ld.created_at,
         row_number() over (partition by ld.loan_id order by ld.paid_on, ld.created_at, ld.id) as rn
  from public.loan_disbursements ld
  where ld.mode not in ('renewal', 'opening')
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
where lr.mode <> 'renewal' or lr.adjusted_into is not null
union all
-- overdue cut: the new loan's side (part of the loan given)
select lr.id, lr.paid_on, 'disbursement', 'out', lr.amount, lr.mode,
       ('Loan #' || nl.loan_no || ' — ' || b.name),
       ('Loan #' || l.loan_no || ' overdue cut'), nl.id, lr.created_at
from public.loan_repayments lr
join public.loans l  on l.id = lr.loan_id
join public.loans nl on nl.id = lr.adjusted_into
join public.borrowers b on b.id = nl.borrower_id
where lr.mode = 'renewal' and lr.adjusted_into is not null
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
