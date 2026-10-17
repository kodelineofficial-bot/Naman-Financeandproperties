-- =====================================================================
-- 024: Monthly Loans tab "canceling statement due to statement timeout"
--
-- loan_summary joins loan_penalty, which works out the penalty day by day
-- for every loan. With a filter (Monthly Loans asks only for monthly
-- loans) Postgres picked a nested loop and rebuilt that day-by-day table
-- once per matching loan: 11 monthly loans × ~0.9 s = 9.7 s, over the 8 s
-- limit for logged-in users. The unfiltered Loans list was fine.
--
-- Fix (same columns, same numbers):
--   loan_penalty : "paid before collection started" is a per-loan sum
--                  joined once, not a lookup repeated for every day.
--   loan_summary : the penalty is computed once (materialized) and then
--                  joined, whatever filter the page uses.
-- =====================================================================

create or replace view public.loan_penalty
with (security_invoker = on) as
with s as (
  select penalty_enabled, penalty_per_day, penalty_grace_days, penalty_from
  from public.settings where id = 1
),
base as (
  select l.*,
         (l.penalty_opening_date is not null
          and (l.penalty_reset_at is null
               or l.penalty_opening_date >= (l.penalty_reset_at at time zone 'Asia/Kolkata')::date)) as has_opening
  from public.loans l
),
lp as (
  select l.id as loan_id,
         l.frequency as freq,
         l.daily_installment as daily,
         l.total_repayable - l.advance_amount as to_collect,
         l.advance_amount as adv,
         l.collection_start_date as start_d,
         greatest(l.collection_start_date,
                  case when l.has_opening then l.penalty_opening_date + 1 else s.penalty_from end,
                  coalesce((l.penalty_reset_at at time zone 'Asia/Kolkata')::date, l.collection_start_date)) as from_d,
         case when l.has_opening and not l.penalty_off then l.penalty_opening_amount else 0 end as opening,
         case when l.status = 'active' then public.today_ist() - 1
              when l.status = 'defaulted' then least(public.today_ist(), coalesce(l.defaulted_on, public.today_ist())) - 1
              when l.status in ('closed', 'renewed') then least(public.today_ist() - 1, l.closed_on - 1)
         end as to_d,
         coalesce(l.penalty_per_day, s.penalty_per_day) as rate,
         s.penalty_grace_days as grace,
         (not l.penalty_off
          and coalesce(l.penalty_per_day, s.penalty_per_day) > 0
          and (s.penalty_enabled or l.penalty_per_day is not null)) as on_
  from base l cross join s
),
paid_day as (
  select loan_id, paid_on, sum(amount) as amt
  from public.loan_repayments group by loan_id, paid_on
),
-- everything paid before collection started, once per loan
pre as (
  select lp.loan_id, sum(p.amt) as amt
  from lp join paid_day p on p.loan_id = lp.loan_id and p.paid_on < lp.start_d
  group by lp.loan_id
),
days as (
  select lp.loan_id, g.d::date as d, lp.from_d, lp.freq, lp.daily, lp.to_collect, lp.adv, lp.start_d, lp.grace,
         coalesce(pre.amt, 0)
           + sum(coalesce(pd.amt, 0)) over (partition by lp.loan_id order by g.d) as upto
  from lp
  cross join lateral generate_series(lp.start_d, lp.to_d, interval '1 day') g(d)
  left join paid_day pd on pd.loan_id = lp.loan_id and pd.paid_on = g.d::date
  left join pre on pre.loan_id = lp.loan_id
  where lp.on_ and lp.to_d >= lp.from_d
),
late as (
  select loan_id, d, from_d, grace,
         (least(to_collect, public.periods_due(freq, start_d, d - grace) * daily - adv) - upto > 0.001) as is_late
  from days
),
spells as (
  select loan_id, d, from_d, grace, is_late,
         coalesce(lag(is_late) over (partition by loan_id order by d), false) as prev_late
  from late
),
counted as (
  select loan_id,
         (count(*) filter (where is_late)
          -- a new spell of being behind: the free days before the start day are charged too
          + count(*) filter (where is_late and not prev_late) * (max(grace) + 1))::int as penalty_days
  from spells
  where d >= from_d
  group by loan_id
),
e as (
  select x.loan_id,
         coalesce(sum(x.amount) filter (where x.kind = 'paid'), 0)   as paid,
         coalesce(sum(x.amount) filter (where x.kind = 'waived'), 0) as waived
  from public.loan_penalty_entries x
  join public.loans l on l.id = x.loan_id
  where l.penalty_reset_at is null or x.created_at > l.penalty_reset_at
  group by x.loan_id
)
select lp.loan_id,
       coalesce(c.penalty_days, 0) as penalty_days,
       lp.rate as penalty_rate,
       lp.opening + coalesce(c.penalty_days, 0) * lp.rate as penalty_charged,
       coalesce(e.paid, 0)   as penalty_paid,
       coalesce(e.waived, 0) as penalty_waived,
       greatest(lp.opening + coalesce(c.penalty_days, 0) * lp.rate - coalesce(e.paid, 0) - coalesce(e.waived, 0), 0) as penalty_due,
       lp.opening as penalty_opening
from lp
left join counted c on c.loan_id = lp.loan_id
left join e on e.loan_id = lp.loan_id;

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
         sum(amount) filter (where paid_on = public.today_ist() and mode <> 'renewal') as paid_today
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
         l.penalty_off, l.frequency, l.defaulted_on, l.paused_days, l.old_defaulter
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
       base.defaulted_on, base.paused_days, base.old_defaulter
from base
left join pn on pn.loan_id = base.id;
