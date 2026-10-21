-- =====================================================================
--  032 — Take less, forgive the rest (छूट / माफ़)
--
--  The borrower owes ₹2,000 (overdue, or the full balance to close the
--  loan) and can pay only ₹1,800: take ₹1,800 and forgive ₹200.
--
--  Saved in one transaction by settle_with_discount():
--    loan_repayments   ₹1,800  cash / UPI       (real money, in the Day Book)
--    loan_repayments   ₹200    mode 'waiver'    (forgiven, NOT cash)
--    loan_penalty_entries      penalty taken (paid) / forgiven (waived)
--  The money received goes on the installments first, then the penalty.
--  The forgiven installment part lowers the balance like a payment, so a
--  loan forgiven down to ₹0 closes by itself (and re-opens if the waiver
--  is deleted). Penalty forgiven is a normal penalty waiver.
--
--  'waiver' repayments are kept out of the ledger (Day Book, cash in hand,
--  daily / monthly cashflow), today's collection and the collection sheet.
--
--  Changed: ledger, loan_summary (+ forgiven), collection_sheet
--  New:     settle_with_discount()
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
where lr.mode not in ('renewal', 'waiver')
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

create or replace view public.loan_summary
with (security_invoker = on) as
with d as (
  select loan_id, sum(amount) as disbursed, max(paid_on) as last_disbursed_on
  from public.loan_disbursements
  group by loan_id
),
r as (
  select loan_id,
         sum(amount) as collected,
         max(paid_on) as last_paid_on,
         count(*) as payment_count,
         sum(amount) filter (where paid_on = public.today_ist() and mode not in ('renewal', 'waiver')) as paid_today,
         sum(amount) filter (where mode = 'waiver') as forgiven
  from public.loan_repayments
  group by loan_id
),
-- computed once for all loans, then joined (see header)
pn as materialized (
  select * from public.loan_penalty
),
base as (
  select l.id, l.loan_no, l.borrower_id, l.principal, l.interest_pct, l.interest_amount, l.markup_pct,
         l.total_repayable, l.daily_installment, l.duration_days, l.advance_days, l.advance_amount,
         l.net_disbursable, l.loan_date, l.collection_start_date, l.status, l.closed_on, l.notes,
         l.created_at, l.updated_at,
         b.name as borrower_name, b.phone as borrower_phone,
         b.occupation as borrower_occupation, b.address as borrower_address,
         coalesce(d.disbursed, 0) as disbursed,
         d.last_disbursed_on,
         coalesce(r.collected, 0) as collected_cash,
         coalesce(r.collected, 0) + l.advance_amount as collected_total,
         r.last_paid_on,
         coalesce(r.payment_count, 0) as payment_count,
         coalesce(r.paid_today, 0) as paid_today,
         public.periods_due(l.frequency, l.collection_start_date,
           case when l.status = 'defaulted' and l.defaulted_on is not null
                then least(public.today_ist(), l.defaulted_on - 1)
                else public.today_ist() end) as days_elapsed,
         l.penalty_off, l.frequency, l.defaulted_on, l.paused_days, l.old_defaulter,
         coalesce(r.forgiven, 0) as forgiven
  from public.loans l
  join public.borrowers b on b.id = l.borrower_id
  left join d on d.loan_id = l.id
  left join r on r.loan_id = l.id
)
select base.id, base.loan_no, base.borrower_id, base.principal, base.interest_pct, base.interest_amount,
       base.markup_pct, base.total_repayable, base.daily_installment, base.duration_days, base.advance_days,
       base.advance_amount, base.net_disbursable, base.loan_date, base.collection_start_date, base.status,
       base.closed_on, base.notes, base.created_at, base.updated_at,
       base.borrower_name, base.borrower_phone, base.borrower_occupation, base.borrower_address,
       base.disbursed, base.last_disbursed_on, base.collected_cash, base.collected_total,
       base.last_paid_on, base.payment_count, base.paid_today, base.days_elapsed,
       base.net_disbursable - base.disbursed as pending_disbursement,
       greatest(base.total_repayable - base.collected_total, 0) as outstanding,
       least(base.total_repayable, base.days_elapsed * base.daily_installment) as expected_till_today,
       case when base.status in ('active', 'defaulted')
            then greatest(least(base.total_repayable, base.days_elapsed * base.daily_installment) - base.collected_total, 0)
            else 0 end as overdue,
       public.period_date(base.frequency, base.collection_start_date,
         ceil(greatest(base.total_repayable, 0) / base.daily_installment)::int) as expected_end_date,
       ceil(greatest(base.total_repayable - base.collected_total, 0) / base.daily_installment)::int as installments_left,
       round(case when base.total_repayable > 0 then base.collected_total / base.total_repayable * 100 else 0 end, 1) as progress_pct,
       base.total_repayable - base.principal + base.interest_amount as expected_profit,
       floor(base.collected_total / base.daily_installment)::int as days_covered,
       public.period_date(base.frequency, base.collection_start_date,
         floor(base.collected_total / base.daily_installment)::int) as paid_till,
       base.penalty_off,
       coalesce(pn.penalty_days, 0) as penalty_days,
       coalesce(pn.penalty_rate, 0) as penalty_rate,
       coalesce(pn.penalty_charged, 0) as penalty_charged,
       coalesce(pn.penalty_paid, 0) as penalty_paid,
       coalesce(pn.penalty_waived, 0) as penalty_waived,
       coalesce(pn.penalty_due, 0) as penalty_due,
       base.frequency,
       case when base.status <> 'defaulted'
                 and base.days_elapsed < ceil(greatest(base.total_repayable, 0) / base.daily_installment)::int
            then public.period_date(base.frequency, base.collection_start_date, base.days_elapsed + 1)
       end as next_due_date,
       base.defaulted_on, base.paused_days, base.old_defaulter,
       -- installments forgiven (छूट), counted in collected / balance but not cash
       base.forgiven
from base
left join pn on pn.loan_id = base.id;

create or replace function public.collection_sheet(p_date date)
 returns table(id uuid, loan_no bigint, borrower_id uuid, borrower_name text, borrower_phone text, borrower_address text, status text, daily_installment numeric, collection_start_date date, to_collect numeric, collected_upto numeric, paid_on_date numeric, balance_upto numeric, paid_till date, short_upto numeric, outstanding numeric, advance_amount numeric, frequency text)
 language sql
 stable
 set search_path to 'public'
as $function$
  select l.id, l.loan_no, b.id, b.name, b.phone, b.address, l.status,
         l.daily_installment, l.collection_start_date,
         (l.total_repayable - l.advance_amount) as to_collect,
         coalesce(r.upto, 0) as collected_upto,
         coalesce(r.on_date, 0) as paid_on_date,
         greatest(l.total_repayable - l.advance_amount - coalesce(r.upto, 0), 0) as balance_upto,
         public.period_date(l.frequency, l.collection_start_date,
                            floor((coalesce(r.upto, 0) + l.advance_amount) / l.daily_installment)::int) as paid_till,
         greatest(least(l.total_repayable,
                        public.periods_due(l.frequency, l.collection_start_date,
                          case when l.status = 'defaulted' and l.defaulted_on is not null
                               then least(p_date, l.defaulted_on - 1) else p_date end) * l.daily_installment)
                  - l.advance_amount - coalesce(r.upto, 0), 0) as short_upto,
         greatest(l.total_repayable - l.advance_amount - coalesce(r.total, 0), 0) as outstanding,
         l.advance_amount,
         l.frequency
  from loans l
  join borrowers b on b.id = l.borrower_id
  left join lateral (
    select sum(amount) filter (where paid_on <= p_date)                                      as upto,
           sum(amount) filter (where paid_on = p_date and mode not in ('renewal', 'waiver')) as on_date,
           sum(amount)                                                                       as total
    from loan_repayments x where x.loan_id = l.id
  ) r on true
  where l.collection_start_date <= p_date
    and l.loan_date <= p_date
    and (not l.old_defaulter or coalesce(r.on_date, 0) > 0)
    and (
      l.status in ('active', 'defaulted')
      or coalesce(r.on_date, 0) > 0
      or (l.status = 'closed' and l.closed_on >= p_date)
      or (l.status = 'renewed' and l.closed_on > p_date)
    )
  order by b.name, l.loan_no
$function$;

-- ---------------------------------------------------------------------
-- settle_with_discount: on loan p_loan the borrower owed p_inst_due of
-- installments and p_pen_due of penalty, and paid p_received. The money
-- goes on the installments first, then the penalty; the rest is forgiven.
-- ---------------------------------------------------------------------
create or replace function public.settle_with_discount(
  p_loan uuid, p_date date, p_inst_due numeric, p_pen_due numeric, p_received numeric, p_mode text, p_note text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status   text;
  v_balance  numeric;
  v_penalty  numeric;
  v_inst_in  numeric;
  v_pen_in   numeric;
  v_note     text;
begin
  p_inst_due := round(greatest(coalesce(p_inst_due, 0), 0), 2);
  p_pen_due  := round(greatest(coalesce(p_pen_due, 0), 0), 2);
  p_received := round(greatest(coalesce(p_received, 0), 0), 2);

  select status, outstanding, penalty_due into v_status, v_balance, v_penalty
    from loan_summary where id = p_loan;
  if not found then raise exception 'Loan not found'; end if;
  if v_status not in ('active', 'defaulted') then
    raise exception 'Loan is not running (status: %)', v_status;
  end if;
  if p_inst_due > v_balance + 0.001 then
    raise exception 'Installments ₹% are more than the balance ₹%', p_inst_due, v_balance;
  end if;
  if p_pen_due > v_penalty + 0.001 then
    raise exception 'Penalty ₹% is more than the penalty due ₹%', p_pen_due, v_penalty;
  end if;
  if p_inst_due + p_pen_due <= 0 then raise exception 'Nothing is due'; end if;
  if p_received >= p_inst_due + p_pen_due then
    raise exception 'Received ₹% is not less than the amount due ₹% — nothing to forgive', p_received, p_inst_due + p_pen_due;
  end if;

  v_inst_in := least(p_received, p_inst_due);
  v_pen_in  := round(p_received - v_inst_in, 2);
  v_note := coalesce(nullif(trim(p_note), ''),
    'Due ₹' || trim_scale(p_inst_due + p_pen_due) || ', took ₹' || trim_scale(p_received)
    || ', forgave ₹' || trim_scale(p_inst_due + p_pen_due - p_received));

  -- penalty first, so the loan closing below does not change what is due
  if v_pen_in > 0 then
    insert into loan_penalty_entries (loan_id, kind, paid_on, amount, mode, note)
    values (p_loan, 'paid', p_date, v_pen_in, p_mode, v_note);
  end if;
  if p_pen_due - v_pen_in > 0 then
    insert into loan_penalty_entries (loan_id, kind, paid_on, amount, mode, note)
    values (p_loan, 'waived', p_date, round(p_pen_due - v_pen_in, 2), 'waiver', 'Forgiven (छूट) · ' || v_note);
  end if;
  if v_inst_in > 0 then
    insert into loan_repayments (loan_id, paid_on, amount, mode, note)
    values (p_loan, p_date, v_inst_in, p_mode, v_note);
  end if;
  if p_inst_due - v_inst_in > 0 then
    insert into loan_repayments (loan_id, paid_on, amount, mode, note)
    values (p_loan, p_date, round(p_inst_due - v_inst_in, 2), 'waiver', 'Forgiven (छूट) · ' || v_note);
  end if;
end
$$;
revoke execute on function public.settle_with_discount(uuid, date, numeric, numeric, numeric, text, text) from public, anon;
grant execute on function public.settle_with_discount(uuid, date, numeric, numeric, numeric, text, text) to authenticated;

commit;
