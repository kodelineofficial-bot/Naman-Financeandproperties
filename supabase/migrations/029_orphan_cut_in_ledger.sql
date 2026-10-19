-- =====================================================================
--  029 — Overdue cut whose old loan was deleted
--
--  Before 027 an overdue cut was saved as two rows with no link between
--  them: a 'renewal' disbursement on the new loan and a 'renewal'
--  repayment on the old loan. The ledger builds both Day Book lines (in
--  and out) from the repayment. When the old loan is deleted its repayment
--  goes with it, so the cut disappeared from the Day Book although the
--  new loan still shows it (Karan Office: #225 ₹1,350 on 16 Oct and
--  #230 ₹3,900 on 17 Oct, both from deleted loan #67).
--
--  Now such a cut still shows in the day's money:
--    in   Collection   ₹3,900  (renewal, no cash)
--    out  Loan given   ₹3,900  (renewal, no cash)
--  Both lines are on the new loan. Cash in hand does not change; Total In
--  and Total Out do. Loan balances do not change (they never read the
--  ledger).
--
--  Changed: ledger
-- =====================================================================

begin;

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
  select lr.id, lr.loan_id, lr.paid_on, lr.amount, lr.mode, lr.note, lr.created_at, lr.adjusted_into, lr.cut_disb_id,
         coalesce(lr.adjusted_into, nl.id) as new_loan_id
  from public.loan_repayments lr
  left join lateral (
    select n.id from public.loans n
    where n.renewed_from = lr.loan_id
    order by n.created_at desc
    limit 1
  ) nl on lr.adjusted_into is null
  where lr.mode = 'renewal'
),
-- a cut on the new loan whose old-loan side is gone (old loan deleted before
-- 027 linked the two with cut_from / cut_disb_id, so it did not cascade)
orphan_cut as (
  select ld.id, ld.loan_id, ld.paid_on, ld.amount, ld.mode, ld.note, ld.created_at
  from public.loan_disbursements ld
  where ld.mode = 'renewal'
    and not exists (select 1 from adjusted a where a.cut_disb_id = ld.id)
    and not exists (select 1 from public.loan_penalty_entries pe where pe.cut_disb_id = ld.id)
    and not exists (select 1 from adjusted a
                    where a.cut_disb_id is null and a.new_loan_id = ld.loan_id
                      and a.paid_on = ld.paid_on and a.amount = ld.amount)
)
select ld.id,
       ld.paid_on                                    as entry_date,
       'disbursement'::text                          as kind,
       'out'::text                                   as direction,
       (ld.amount + case when ld.rn = 1 and ld.mode <> 'upi' then l.advance_amount else 0 end)::numeric(14,2) as amount,
       ld.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name)    as party,
       ld.note,
       l.id                                          as ref_id,
       ld.created_at
from cash_disb ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
union all
select l.id, ld.paid_on, 'loan_advance', 'in', l.advance_amount, coalesce(l.advance_mode, ld.mode),
       ('Loan #' || l.loan_no || ' — ' || b.name),
       ('Advance ' || l.advance_days || ' days kept from loan'), l.id, ld.created_at
from cash_disb ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
where ld.rn = 1 and l.advance_amount > 0
union all
-- A retained advance is a cut from the loan, not fresh money from outside.
-- Cash payouts already contain this cut in their gross out. UPI transfers
-- stay actual, so put the matching cut in a separate row in the advance mode.
select l.id, ld.paid_on, 'loan_advance_cut', 'out', l.advance_amount, coalesce(l.advance_mode, ld.mode),
       ('Loan #' || l.loan_no || ' — ' || b.name),
       'Advance deducted before payout (not an additional transfer)', l.id, ld.created_at
from cash_disb ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
where ld.rn = 1 and ld.mode = 'upi' and l.advance_amount > 0
union all
select lr.id, lr.paid_on, 'collection', 'in', lr.amount, lr.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name), lr.note, l.id, lr.created_at
from public.loan_repayments lr
join public.loans l on l.id = lr.loan_id
join public.borrowers b on b.id = l.borrower_id
where lr.mode <> 'renewal'
union all
-- adjusted: the old loan's side (collection; advance kept from its own payout, 028)
select a.id, a.paid_on,
       case when a.adjusted_into = a.loan_id then 'loan_advance' else 'collection' end,
       'in', a.amount, a.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name), a.note, l.id, a.created_at
from adjusted a
join public.loans l on l.id = a.loan_id
join public.borrowers b on b.id = l.borrower_id
where a.new_loan_id is not null
union all
-- adjusted: the new loan's side (part of the loan given)
select a.id, a.paid_on, 'disbursement', 'out', a.amount, a.mode,
       ('Loan #' || nl.loan_no || ' — ' || b.name),
       case when a.adjusted_into = a.loan_id then a.note || ' (no cash)'
            else ('Loan #' || l.loan_no
              || case when l.borrower_id <> nl.borrower_id then ' — ' || ob.name else '' end
              || case when a.adjusted_into is null then ' balance adjusted' else ' overdue cut' end) end,
       nl.id, a.created_at
from adjusted a
join public.loans l  on l.id = a.loan_id
join public.borrowers ob on ob.id = l.borrower_id
join public.loans nl on nl.id = a.new_loan_id
join public.borrowers b on b.id = nl.borrower_id
union all
-- orphan cut: the old loan's collection (in) and the new loan's loan given
-- (out) on the same day, no cash; shown on the new loan as the old one is gone
select ld.id, ld.paid_on, 'collection', 'in', ld.amount, ld.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name),
       (ld.note || ' (old loan deleted, no cash)'), l.id, ld.created_at
from orphan_cut ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
union all
select ld.id, ld.paid_on, 'disbursement', 'out', ld.amount, ld.mode,
       ('Loan #' || l.loan_no || ' — ' || b.name),
       (ld.note || ' (old loan deleted, no cash)'), l.id, ld.created_at
from orphan_cut ld
join public.loans l on l.id = ld.loan_id
join public.borrowers b on b.id = l.borrower_id
union all
-- penalty cut (027): the new loan's side (part of the loan given); the
-- penalty income itself is the 'penalty' row below
select pe.id, pe.paid_on, 'disbursement', 'out', pe.amount, pe.mode,
       ('Loan #' || nl.loan_no || ' — ' || b.name),
       ('Loan #' || l.loan_no
          || case when l.borrower_id <> nl.borrower_id then ' — ' || ob.name else '' end
          || ' penalty cut'),
       nl.id, pe.created_at
from public.loan_penalty_entries pe
join public.loan_disbursements cd on cd.id = pe.cut_disb_id
join public.loans l  on l.id = pe.loan_id
join public.borrowers ob on ob.id = l.borrower_id
join public.loans nl on nl.id = cd.loan_id
join public.borrowers b on b.id = nl.borrower_id
where pe.kind = 'paid'
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

commit;
