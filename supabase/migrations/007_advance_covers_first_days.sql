-- =====================================================================
-- 007: Advance days are the FIRST days of the loan schedule
--
-- Before: a loan of 80 days with 10 advance days had a 70-day schedule
-- starting on collection_start_date (the advance was ignored in the dates).
-- Now:    the schedule is all 80 days from collection_start_date. The advance
--         kept at loan time covers days 1–10 (they show as paid), and cash
--         is due from day 11 to day 80.
--
-- Changed: loan_summary   expected_till_today / overdue / expected_end_date /
--                         days_covered / paid_till
--          collection_sheet paid_till / short_upto (+ advance_amount column)
--          loan_penalty   a day only counts as late after the advance days
-- =====================================================================

create or replace view public.loan_penalty
with (security_invoker = on) as
with s as (
  select penalty_enabled, penalty_per_day, penalty_grace_days, penalty_from
  from public.settings where id = 1
),
lp as (
  select l.id as loan_id,
         l.daily_installment as daily,
         l.total_repayable - l.advance_amount as to_collect,
         l.advance_amount as adv,
         l.collection_start_date as start_d,
         greatest(l.collection_start_date, s.penalty_from) as from_d,
         -- last day that can be charged: yesterday, or the day before the loan closed
         case when l.status in ('active', 'defaulted') then public.today_ist() - 1
              when l.status in ('closed', 'renewed') then least(public.today_ist() - 1, l.closed_on - 1)
         end as to_d,
         s.penalty_per_day as rate,
         s.penalty_grace_days as grace,
         (s.penalty_enabled and not l.penalty_off and s.penalty_per_day > 0) as on_
  from public.loans l cross join s
),
paid_day as (
  select loan_id, paid_on, sum(amount) as amt
  from public.loan_repayments group by loan_id, paid_on
),
days as (
  select lp.loan_id, g.d::date as d, lp.from_d, lp.daily, lp.to_collect, lp.adv, lp.start_d, lp.grace,
         -- everything paid before collection started, plus a running total from then on
         coalesce((select sum(p.amt) from paid_day p where p.loan_id = lp.loan_id and p.paid_on < lp.start_d), 0)
           + sum(coalesce(pd.amt, 0)) over (partition by lp.loan_id order by g.d) as upto
  from lp
  cross join lateral generate_series(lp.start_d, lp.to_d, interval '1 day') g(d)
  left join paid_day pd on pd.loan_id = lp.loan_id and pd.paid_on = g.d::date
  where lp.on_ and lp.to_d >= lp.from_d
),
counted as (
  select loan_id, count(*)::int as penalty_days
  from days
  where d >= from_d
    and least(to_collect, (d - start_d + 1) * daily - adv) - upto > grace * daily + 0.001
  group by loan_id
),
e as (
  select loan_id,
         coalesce(sum(amount) filter (where kind = 'paid'), 0)   as paid,
         coalesce(sum(amount) filter (where kind = 'waived'), 0) as waived
  from public.loan_penalty_entries group by loan_id
)
select lp.loan_id,
       coalesce(c.penalty_days, 0) as penalty_days,
       lp.rate as penalty_rate,
       coalesce(c.penalty_days, 0) * lp.rate as penalty_charged,
       coalesce(e.paid, 0)   as penalty_paid,
       coalesce(e.waived, 0) as penalty_waived,
       greatest(coalesce(c.penalty_days, 0) * lp.rate - coalesce(e.paid, 0) - coalesce(e.waived, 0), 0) as penalty_due
from lp
left join counted c on c.loan_id = lp.loan_id
left join e on e.loan_id = lp.loan_id;

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
         greatest(public.today_ist() - l.collection_start_date + 1, 0) as days_elapsed,
         l.penalty_off
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
       base.collection_start_date
         + (ceil(greatest(base.total_repayable, 0) / base.daily_installment))::int
         - 1 as expected_end_date,
       ceil(greatest(base.total_repayable - base.collected_total, 0) / base.daily_installment)::int
         as installments_left,
       round(case when base.total_repayable > 0
                  then base.collected_total / base.total_repayable * 100 else 0 end, 1) as progress_pct,
       (base.total_repayable - base.principal + base.interest_amount) as expected_profit,
       floor(base.collected_total / base.daily_installment)::int as days_covered,
       case when base.collected_total >= base.daily_installment
            then base.collection_start_date + floor(base.collected_total / base.daily_installment)::int - 1
       end as paid_till,
       base.penalty_off,
       coalesce(pn.penalty_days, 0)    as penalty_days,
       coalesce(pn.penalty_rate, 0)    as penalty_rate,
       coalesce(pn.penalty_charged, 0) as penalty_charged,
       coalesce(pn.penalty_paid, 0)    as penalty_paid,
       coalesce(pn.penalty_waived, 0)  as penalty_waived,
       coalesce(pn.penalty_due, 0)     as penalty_due
from base
left join public.loan_penalty pn on pn.loan_id = base.id;

drop function if exists public.collection_sheet(date);
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
  advance_amount    numeric
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
         case when coalesce(r.upto, 0) + l.advance_amount >= l.daily_installment
              then l.collection_start_date + floor((coalesce(r.upto, 0) + l.advance_amount) / l.daily_installment)::int - 1
         end as paid_till,
         greatest(least(l.total_repayable,
                        (p_date - l.collection_start_date + 1) * l.daily_installment)
                  - l.advance_amount - coalesce(r.upto, 0), 0) as short_upto,
         greatest(l.total_repayable - l.advance_amount - coalesce(r.total, 0), 0) as outstanding,
         l.advance_amount
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
