-- =====================================================================
--  028 — Keep advance from a later payout
--
--  A loan's cash is often handed over in parts. On any part the borrower
--  can say "keep ₹1,000 of this as advance installments". Example: still
--  to give ₹3,000, advance ₹1,000 kept → ₹2,000 really handed over.
--
--  In the day's money (ledger):
--    out  Loan given           ₹2,000  (cash / UPI, what was handed over)
--    out  Loan given           ₹1,000  (advance kept from this payout, no cash)
--    in   Advance kept         ₹1,000  (income — installments paid ahead)
--  Loan given = ₹3,000, the ₹1,000 is in and out on the same day, so cash
--  in hand moves only by the ₹2,000.
--
--  How it is recorded (same shape as a dues cut, 027, but on its own loan):
--    disbursement mode p_mode            amount = part − advance (if > 0)
--    disbursement mode 'renewal', cut_from = this loan, amount = advance
--    repayment    mode 'renewal', adjusted_into = this loan,
--                 cut_disb_id = that disbursement (fills the next days)
--  "Undo" on the loan page deletes the 'renewal' disbursement and the
--  repayment goes with it (on delete cascade).
--
--  New:     give_loan_money()
--  Changed: ledger — the repayment side of an own-loan advance is
--           'loan_advance' (Advance kept), not a collection
-- =====================================================================

begin;

create or replace function public.give_loan_money(p_loan uuid, p_date date, p_amount numeric, p_advance numeric, p_mode text, p_note text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_loan    loans%rowtype;
  v_balance numeric;
  v_cash    numeric;
  v_disb    uuid;
  v_units   numeric;
  v_label   text;
begin
  select * into v_loan from loans where id = p_loan for update;
  if not found then raise exception 'Loan not found'; end if;
  if v_loan.status in ('cancelled', 'renewed') then
    raise exception 'Loan #% is %', v_loan.loan_no, v_loan.status;
  end if;

  p_amount  := round(coalesce(p_amount, 0), 2);
  p_advance := round(greatest(coalesce(p_advance, 0), 0), 2);
  if p_amount <= 0 then raise exception 'Enter an amount'; end if;
  if p_advance > p_amount + 0.001 then
    raise exception 'Advance ₹% is more than the money given ₹%', p_advance, p_amount;
  end if;

  v_cash := round(p_amount - p_advance, 2);
  if v_cash > 0 then
    insert into loan_disbursements (loan_id, paid_on, amount, mode, note)
    values (p_loan, p_date, v_cash, p_mode,
            coalesce(nullif(trim(p_note), ''),
                     case when p_advance > 0 then 'Given ₹' || trim_scale(p_amount) || ' − advance ₹' || trim_scale(p_advance) end));
  end if;

  if p_advance > 0 then
    select greatest(v_loan.total_repayable - v_loan.advance_amount - coalesce(sum(amount), 0), 0)
      into v_balance from loan_repayments where loan_id = p_loan;
    if p_advance > v_balance + 0.001 then
      raise exception 'Advance ₹% is more than loan #% balance ₹%', p_advance, v_loan.loan_no, v_balance;
    end if;

    v_units := round(p_advance / nullif(v_loan.daily_installment, 0), 1);
    v_label := 'Advance'
      || case when v_units is not null
              then ' ' || trim_scale(v_units) || case when v_loan.frequency = 'monthly' then ' month' else ' day' end
                   || case when v_units = 1 then '' else 's' end
              else '' end
      || ' kept from ₹' || trim_scale(p_amount) || ' given';

    insert into loan_disbursements (loan_id, paid_on, amount, mode, note, cut_from)
    values (p_loan, p_date, p_advance, 'renewal', v_label, p_loan)
    returning id into v_disb;

    insert into loan_repayments (loan_id, paid_on, amount, mode, note, adjusted_into, cut_disb_id)
    values (p_loan, p_date, p_advance, 'renewal', v_label, p_loan, v_disb);
  end if;
end
$$;
revoke execute on function public.give_loan_money(uuid, date, numeric, numeric, text, text) from public, anon;
grant execute on function public.give_loan_money(uuid, date, numeric, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Ledger (same columns as 027)
-- ---------------------------------------------------------------------
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
