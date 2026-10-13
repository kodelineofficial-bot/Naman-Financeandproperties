-- =====================================================================
--  004 — Loan renewal (रिन्यू)
--
--  A borrower with a running loan takes a new loan. The old loan's
--  remaining balance is cut from the new loan's cash, the old loan is
--  marked 'renewed', and the new loan starts fresh.
--
--  Example: old loan has ₹4,500 left. New ₹10,000 loan → net ₹8,100
--  (after interest 400 + advance 1,500) → ₹4,500 adjusted → ₹3,600 cash.
--
--  How it is recorded (no cash moves for the adjusted part):
--    old loan : repayment   ₹4,500  mode = 'renewal'
--    new loan : disbursement ₹4,500 mode = 'renewal'
--  Both rows count for loan balances, but are kept OUT of the ledger /
--  cash book / day book / collection totals, because no cash changed hands.
--  If the owner gives a discount (adjusts less than the balance), the
--  rest is simply waived (चूट) and the old loan is still marked renewed.
-- =====================================================================

alter table public.loans drop constraint if exists loans_status_check;
alter table public.loans add constraint loans_status_check
  check (status in ('active', 'closed', 'defaulted', 'cancelled', 'renewed'));

alter table public.loans
  add column if not exists renewed_from uuid references public.loans (id) on delete set null;
create index if not exists loans_renewed_from_idx on public.loans (renewed_from);

-- Re-open also works for renewed loans if their adjustment entry is deleted.
create or replace function public.recalc_loan_status(p_loan uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due       numeric;
  v_status    text;
  v_collected numeric;
  v_last      date;
  v_renewal   boolean;
begin
  if auth.uid() is not null and not is_admin() then
    raise exception 'not allowed';
  end if;

  select total_repayable - advance_amount, status
    into v_due, v_status
    from loans where id = p_loan;

  if not found then
    return null;
  end if;

  select coalesce(sum(amount), 0), max(paid_on), bool_or(mode = 'renewal')
    into v_collected, v_last, v_renewal
    from loan_repayments where loan_id = p_loan;

  if v_status in ('active', 'defaulted') and v_collected >= v_due then
    update loans set status = 'closed', closed_on = coalesce(v_last, today_ist()) where id = p_loan;
    return 'closed';
  elsif v_status = 'closed' and v_collected < v_due then
    update loans set status = 'active', closed_on = null where id = p_loan;
    return 'active';
  elsif v_status = 'renewed' and not coalesce(v_renewal, false) then
    -- the renewal adjustment was deleted → loan is running again
    update loans set status = case when v_collected >= v_due then 'closed' else 'active' end,
                     closed_on = case when v_collected >= v_due then coalesce(v_last, today_ist()) end
     where id = p_loan;
    return (select status from loans where id = p_loan);
  end if;

  return v_status;
end
$$;
revoke execute on function public.recalc_loan_status(uuid) from public, anon;
grant execute on function public.recalc_loan_status(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- renew_loan: link the new loan to the old one and record the adjustment.
-- Call right after inserting the new loan.
-- ---------------------------------------------------------------------
create or replace function public.renew_loan(p_old uuid, p_new uuid, p_adjust numeric, p_date date)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old     loans%rowtype;
  v_new     loans%rowtype;
  v_balance numeric;
begin
  select * into v_old from loans where id = p_old for update;
  if not found then raise exception 'Old loan not found'; end if;
  select * into v_new from loans where id = p_new for update;
  if not found then raise exception 'New loan not found'; end if;
  if v_old.status not in ('active', 'defaulted') then
    raise exception 'Old loan #% is not running (status: %)', v_old.loan_no, v_old.status;
  end if;
  if v_old.borrower_id <> v_new.borrower_id then
    raise exception 'Both loans must be of the same borrower';
  end if;

  select greatest(v_old.total_repayable - v_old.advance_amount - coalesce(sum(amount), 0), 0)
    into v_balance from loan_repayments where loan_id = p_old;

  p_adjust := round(coalesce(p_adjust, 0), 2);
  if p_adjust < 0 then raise exception 'Adjustment cannot be negative'; end if;
  if p_adjust > v_balance + 0.001 then
    raise exception 'Adjustment ₹% is more than old balance ₹%', p_adjust, v_balance;
  end if;
  if p_adjust > v_new.net_disbursable + 0.001 then
    raise exception 'Old balance ₹% is more than the new loan''s cash ₹% — make the new loan bigger', p_adjust, v_new.net_disbursable;
  end if;

  update loans set renewed_from = p_old where id = p_new;

  if p_adjust > 0 then
    insert into loan_repayments (loan_id, paid_on, amount, mode, note)
    values (p_old, p_date, p_adjust, 'renewal', 'Adjusted in new loan #' || v_new.loan_no);
    insert into loan_disbursements (loan_id, paid_on, amount, mode, note)
    values (p_new, p_date, p_adjust, 'renewal', 'Old loan #' || v_old.loan_no || ' balance adjusted');
  end if;

  -- The repayment trigger may have closed it; renewed wins.
  update loans set status = 'renewed', closed_on = p_date where id = p_old;
end
$$;
revoke execute on function public.renew_loan(uuid, uuid, numeric, date) from public, anon;
grant execute on function public.renew_loan(uuid, uuid, numeric, date) to authenticated;

-- ---------------------------------------------------------------------
-- Ledger: renewal adjustments are not cash → keep them out.
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
from public.cash_entries c;

-- ---------------------------------------------------------------------
-- loan_summary: "paid today" counts cash only (same columns as before).
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
         greatest(public.today_ist() - l.collection_start_date + 1, 0) as days_elapsed
  from public.loans l
  join public.borrowers b on b.id = l.borrower_id
  left join d on d.loan_id = l.id
  left join r on r.loan_id = l.id
)
select base.*,
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
       end as paid_till
from base;

-- ---------------------------------------------------------------------
-- Collection sheet: renewal adjustment is not "paid on this day";
-- renewed loans show on days before they were renewed.
-- ---------------------------------------------------------------------
create or replace function public.collection_sheet(p_date date)
returns table (
  id                uuid,
  loan_no           bigint,
  borrower_id       uuid,
  borrower_name     text,
  borrower_phone    text,
  borrower_address  text,
  status            text,
  daily_installment numeric,
  collection_start_date date,
  to_collect        numeric,
  collected_upto    numeric,
  paid_on_date      numeric,
  balance_upto      numeric,
  paid_till         date,
  short_upto        numeric,
  outstanding       numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select l.id, l.loan_no, b.id, b.name, b.phone, b.address, l.status,
         l.daily_installment, l.collection_start_date,
         (l.total_repayable - l.advance_amount) as to_collect,
         coalesce(r.upto, 0) as collected_upto,
         coalesce(r.on_date, 0) as paid_on_date,
         greatest(l.total_repayable - l.advance_amount - coalesce(r.upto, 0), 0) as balance_upto,
         case when coalesce(r.upto, 0) >= l.daily_installment
              then l.collection_start_date + floor(coalesce(r.upto, 0) / l.daily_installment)::int - 1
         end as paid_till,
         greatest(least(l.total_repayable - l.advance_amount,
                        (p_date - l.collection_start_date + 1) * l.daily_installment)
                  - coalesce(r.upto, 0), 0) as short_upto,
         greatest(l.total_repayable - l.advance_amount - coalesce(r.total, 0), 0) as outstanding
  from loans l
  join borrowers b on b.id = l.borrower_id
  left join lateral (
    select sum(amount) filter (where paid_on <= p_date)                       as upto,
           sum(amount) filter (where paid_on = p_date and mode <> 'renewal')  as on_date,
           sum(amount)                                                        as total
    from loan_repayments x where x.loan_id = l.id
  ) r on true
  where l.collection_start_date <= p_date
    and l.loan_date <= p_date
    and (
      l.status in ('active', 'defaulted')
      or coalesce(r.on_date, 0) > 0
      or (l.status = 'closed' and l.closed_on >= p_date)
      or (l.status = 'renewed' and l.closed_on > p_date)
    )
  order by b.name, l.loan_no
$$;
grant execute on function public.collection_sheet(date) to authenticated;
revoke execute on function public.collection_sheet(date) from public, anon;
