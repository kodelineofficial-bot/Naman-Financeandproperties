-- =====================================================================
-- 014: Old defaulters (पुराने डिफ़ॉल्टर) — dues from before this software
--
-- The client has defaulters whose loans were given before the CRM was
-- started. They are added straight in as a DEFAULTED loan, marked
-- loans.old_defaulter = true:
--   principal         = original loan amount (or the balance if unknown)
--   total_repayable   = balance still to take (बाकी)
--   daily_installment = the same balance, duration 1 day, no interest,
--                       no advance, no penalty (penalty_off)
--   one loan_disbursements row with mode 'opening' = the old payout.
--     It keeps "To give" at 0 but is NOT cash out today, so the ledger
--     (cash book / day book / cash flow) leaves it out.
-- Every payment is a normal loan_repayments row: it shows in the cash
-- book as a collection and the balance goes down. At 0 the loan closes
-- by itself; deleting a payment later re-opens it as defaulted again.
--
-- Changed: loans + old_defaulter
--          ledger            (disbursements with mode 'opening' left out)
--          loan_summary      (+ old_defaulter appended)
--          collection_sheet  (old defaulters only on days they paid)
--          recalc_loan_status (old defaulter re-opens as 'defaulted')
-- =====================================================================

alter table public.loans
  add column if not exists old_defaulter boolean not null default false;
create index if not exists loans_old_defaulter_idx on public.loans (old_defaulter) where old_defaulter;

-- ---------------------------------------------------------------------
-- Ledger: an 'opening' payout (old loan, before the software) is not cash.
-- Same as 008 except the cash_disb filter.
-- ---------------------------------------------------------------------
create or replace view public.ledger
with (security_invoker = on) as
with cash_disb as (
  select ld.*,
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

-- ---------------------------------------------------------------------
-- Loan summary: same as 012, + old_defaulter appended.
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
         public.periods_due(l.frequency, l.collection_start_date,
           case when l.status = 'defaulted' and l.defaulted_on is not null
                then least(public.today_ist(), l.defaulted_on - 1)
                else public.today_ist() end) as days_elapsed,
         l.penalty_off,
         l.frequency,
         l.defaulted_on,
         l.paused_days,
         l.old_defaulter
  from public.loans l
  join public.borrowers b on b.id = l.borrower_id
  left join d on d.loan_id = l.id
  left join r on r.loan_id = l.id
)
select base.id, base.loan_no, base.borrower_id, base.principal, base.interest_pct, base.interest_amount,
       base.markup_pct, base.total_repayable, base.daily_installment, base.duration_days, base.advance_days,
       base.advance_amount, base.net_disbursable, base.loan_date, base.collection_start_date, base.status,
       base.closed_on, base.notes, base.created_at, base.updated_at, base.borrower_name, base.borrower_phone,
       base.borrower_occupation, base.borrower_address, base.disbursed, base.last_disbursed_on,
       base.collected_cash, base.collected_total, base.last_paid_on, base.payment_count, base.paid_today,
       base.days_elapsed,
       base.net_disbursable - base.disbursed as pending_disbursement,
       greatest(base.total_repayable - base.collected_total, 0) as outstanding,
       least(base.total_repayable, base.days_elapsed * base.daily_installment) as expected_till_today,
       case when base.status in ('active', 'defaulted') then
         greatest(least(base.total_repayable, base.days_elapsed * base.daily_installment)
                  - base.collected_total, 0)
       else 0 end as overdue,
       public.period_date(base.frequency, base.collection_start_date,
                          ceil(greatest(base.total_repayable, 0) / base.daily_installment)::int) as expected_end_date,
       ceil(greatest(base.total_repayable - base.collected_total, 0) / base.daily_installment)::int
         as installments_left,
       round(case when base.total_repayable > 0
                  then base.collected_total / base.total_repayable * 100 else 0 end, 1) as progress_pct,
       (base.total_repayable - base.principal + base.interest_amount) as expected_profit,
       floor(base.collected_total / base.daily_installment)::int as days_covered,
       public.period_date(base.frequency, base.collection_start_date,
                          floor(base.collected_total / base.daily_installment)::int) as paid_till,
       base.penalty_off,
       coalesce(pn.penalty_days, 0)    as penalty_days,
       coalesce(pn.penalty_rate, 0)    as penalty_rate,
       coalesce(pn.penalty_charged, 0) as penalty_charged,
       coalesce(pn.penalty_paid, 0)    as penalty_paid,
       coalesce(pn.penalty_waived, 0)  as penalty_waived,
       coalesce(pn.penalty_due, 0)     as penalty_due,
       base.frequency,
       case when base.status <> 'defaulted'
             and base.days_elapsed < ceil(greatest(base.total_repayable, 0) / base.daily_installment)::int
            then public.period_date(base.frequency, base.collection_start_date, base.days_elapsed + 1)
       end as next_due_date,
       base.defaulted_on,
       base.paused_days,
       base.old_defaulter
from base
left join public.loan_penalty pn on pn.loan_id = base.id;

-- ---------------------------------------------------------------------
-- Collection sheet: same as 012, but an old defaulter is not part of the
-- daily round — it only shows on a day it actually paid.
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
  outstanding       numeric,
  advance_amount    numeric,
  frequency         text
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
    select sum(amount) filter (where paid_on <= p_date)                       as upto,
           sum(amount) filter (where paid_on = p_date and mode <> 'renewal')  as on_date,
           sum(amount)                                                        as total
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
$$;

-- ---------------------------------------------------------------------
-- recalc_loan_status: same as 004, but a cleared old defaulter that is no
-- longer fully paid (payment deleted / balance raised) goes back to
-- 'defaulted', not 'active'.
-- ---------------------------------------------------------------------
create or replace function public.recalc_loan_status(p_loan uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due       numeric;
  v_status    text;
  v_old       boolean;
  v_collected numeric;
  v_last      date;
  v_renewal   boolean;
begin
  if auth.uid() is not null and not is_admin() then
    raise exception 'not allowed';
  end if;

  select total_repayable - advance_amount, status, old_defaulter
    into v_due, v_status, v_old
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
    update loans set status = case when v_old then 'defaulted' else 'active' end, closed_on = null where id = p_loan;
    return case when v_old then 'defaulted' else 'active' end;
  elsif v_status = 'renewed' and not coalesce(v_renewal, false) then
    -- the renewal adjustment was deleted → loan is running again
    update loans set status = case when v_collected >= v_due then 'closed'
                                   when v_old then 'defaulted' else 'active' end,
                     closed_on = case when v_collected >= v_due then coalesce(v_last, today_ist()) end
     where id = p_loan;
    return (select status from loans where id = p_loan);
  end if;

  return v_status;
end
$$;
revoke execute on function public.recalc_loan_status(uuid) from public, anon;
grant execute on function public.recalc_loan_status(uuid) to authenticated;
