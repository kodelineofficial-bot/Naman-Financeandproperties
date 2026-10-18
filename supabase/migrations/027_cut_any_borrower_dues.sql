-- =====================================================================
--  027 — Cut anyone's dues (overdue + penalty) from a loan's cash
--
--  Dave takes a ₹3,000 loan. G2 (another borrower) owes ₹800 overdue and
--  ₹200 penalty, and Dave says "cut G2's dues from my money". Dave gets
--  ₹2,000 cash; G2's loan is paid up to date and the penalty is cleared.
--
--  In the day's money (ledger):
--    out  Loan given to Dave   ₹3,000  (2,000 cash + 800 + 200 cut)
--    in   G2 collection        ₹800    (repayment on G2's loan)
--    in   G2 penalty           ₹200    (penalty income)
--  The cut part is in and out on the same day, so cash in hand moves only
--  by the ₹2,000 really handed over.
--
--  Works for the borrower's own running loans too (016 did only the
--  overdue part). Can be done when the loan is created, or later from the
--  loan page while money is still to give (to give = net − all given).
--
--  How it is recorded (one cut = one disbursement row on the new loan):
--    new loan : disbursement mode 'renewal', cut_from = other loan,
--               amount = overdue part + penalty part
--    other    : repayment mode 'renewal', adjusted_into = new loan,
--               cut_disb_id = that disbursement             (overdue part)
--    other    : penalty entry kind 'paid', mode 'renewal',
--               cut_disb_id = that disbursement             (penalty part)
--  Deleting the disbursement row (Undo cut on the loan page) or either loan
--  removes all of it (on delete cascade).
--
--  New:     loan_disbursements.cut_from, loan_repayments.cut_disb_id,
--           loan_penalty_entries.cut_disb_id, cut_dues_into_loan()
--  Changed: ledger — penalty cut also shows as part of the loan given;
--           a cut from another borrower names them in the note
-- =====================================================================

begin;

alter table public.loan_disbursements
  add column if not exists cut_from uuid references public.loans (id) on delete cascade;
alter table public.loan_repayments
  add column if not exists cut_disb_id uuid references public.loan_disbursements (id) on delete cascade;
alter table public.loan_penalty_entries
  add column if not exists cut_disb_id uuid references public.loan_disbursements (id) on delete cascade;
create index if not exists loan_disb_cut_from_idx on public.loan_disbursements (cut_from);
create index if not exists loan_rep_cut_disb_idx on public.loan_repayments (cut_disb_id);
create index if not exists loan_pen_cut_disb_idx on public.loan_penalty_entries (cut_disb_id);

-- ---------------------------------------------------------------------
-- cut_dues_into_loan: cut p_amount (balance / overdue) and p_penalty of
-- loan p_old from loan p_new's cash still to give. Any borrower.
-- Returns the new loan's disbursement row id.
-- ---------------------------------------------------------------------
create or replace function public.cut_dues_into_loan(p_old uuid, p_new uuid, p_amount numeric, p_penalty numeric, p_date date)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old     loans%rowtype;
  v_new     loans%rowtype;
  v_old_who text;
  v_new_who text;
  v_balance numeric;
  v_pen_due numeric;
  v_given   numeric;
  v_total   numeric;
  v_disb    uuid;
  v_label   text;
begin
  if p_old < p_new then
    perform 1 from loans where id = p_old for update;
    perform 1 from loans where id = p_new for update;
  else
    perform 1 from loans where id = p_new for update;
    perform 1 from loans where id = p_old for update;
  end if;
  select * into v_old from loans where id = p_old;
  if not found then raise exception 'Loan to cut from not found'; end if;
  select * into v_new from loans where id = p_new;
  if not found then raise exception 'Loan not found'; end if;
  if p_old = p_new then raise exception 'A loan cannot cut its own dues'; end if;
  if v_old.status not in ('active', 'defaulted') then
    raise exception 'Loan #% is not running (status: %)', v_old.loan_no, v_old.status;
  end if;
  if v_new.status in ('cancelled', 'renewed') then
    raise exception 'Loan #% is %', v_new.loan_no, v_new.status;
  end if;

  p_amount  := round(greatest(coalesce(p_amount, 0), 0), 2);
  p_penalty := round(greatest(coalesce(p_penalty, 0), 0), 2);
  v_total   := p_amount + p_penalty;
  if v_total <= 0 then raise exception 'Enter an amount to cut'; end if;

  select greatest(v_old.total_repayable - v_old.advance_amount - coalesce(sum(amount), 0), 0)
    into v_balance from loan_repayments where loan_id = p_old;
  if p_amount > v_balance + 0.001 then
    raise exception 'Cut ₹% is more than loan #% balance ₹%', p_amount, v_old.loan_no, v_balance;
  end if;

  select coalesce(penalty_due, 0) into v_pen_due from loan_penalty where loan_id = p_old;
  if p_penalty > coalesce(v_pen_due, 0) + 0.001 then
    raise exception 'Penalty cut ₹% is more than loan #% penalty due ₹%', p_penalty, v_old.loan_no, coalesce(v_pen_due, 0);
  end if;

  select coalesce(sum(amount), 0) into v_given from loan_disbursements where loan_id = p_new;
  if v_given + v_total > v_new.net_disbursable + 0.001 then
    raise exception 'Dues ₹% are more than loan #%''s money still to give ₹% — make the loan bigger or cut less',
      v_total, v_new.loan_no, greatest(v_new.net_disbursable - v_given, 0);
  end if;

  select name into v_old_who from borrowers where id = v_old.borrower_id;
  select name into v_new_who from borrowers where id = v_new.borrower_id;
  v_label := 'Loan #' || v_old.loan_no
          || case when v_old.borrower_id <> v_new.borrower_id then ' — ' || v_old_who else '' end;

  insert into loan_disbursements (loan_id, paid_on, amount, mode, note, cut_from)
  values (p_new, p_date, v_total, 'renewal',
          v_label || ' dues cut'
            || case when p_penalty > 0 then ' (overdue ₹' || p_amount || ' + penalty ₹' || p_penalty || ')' else '' end,
          p_old)
  returning id into v_disb;

  if p_amount > 0 then
    insert into loan_repayments (loan_id, paid_on, amount, mode, note, adjusted_into, cut_disb_id)
    values (p_old, p_date, p_amount, 'renewal',
            'Cut from loan #' || v_new.loan_no || ' — ' || v_new_who, p_new, v_disb);
  end if;
  if p_penalty > 0 then
    insert into loan_penalty_entries (loan_id, paid_on, kind, amount, mode, note, cut_disb_id)
    values (p_old, p_date, 'paid', p_penalty, 'renewal',
            'Cut from loan #' || v_new.loan_no || ' — ' || v_new_who, v_disb);
  end if;

  return v_disb;
end
$$;
revoke execute on function public.cut_dues_into_loan(uuid, uuid, numeric, numeric, date) from public, anon;
grant execute on function public.cut_dues_into_loan(uuid, uuid, numeric, numeric, date) to authenticated;

-- ---------------------------------------------------------------------
-- Ledger (same columns as 022)
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
       ('Loan #' || l.loan_no
          || case when l.borrower_id <> nl.borrower_id then ' — ' || ob.name else '' end
          || case when a.adjusted_into is null then ' balance adjusted' else ' overdue cut' end),
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
