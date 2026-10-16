-- =====================================================================
-- 015: Penalty up to a date, set by hand on one loan
--
-- Settings → "count from" date (penalty_from) keeps old days out of the
-- penalty: a loan that was behind long before that date only gets the
-- days after it. For such a loan the owner can now set on the loan page:
--   "penalty up to <date> = ₹<amount>"
-- The amount is added as it is, and from the next day the system counts
-- penalty days itself (the Settings "count from" date no longer applies to
-- this loan). Amount 0 with the day before collection started = count
-- every missed day of the loan.
--
-- Default / resume (penalty_reset_at, migration 012) starts penalty
-- afresh, so a hand-set penalty dated before the reset is dropped.
--
-- Changed: loans + penalty_opening_date, penalty_opening_amount
--          loan_penalty (+ penalty_opening column, appended)
-- =====================================================================

alter table public.loans
  add column if not exists penalty_opening_date   date,
  add column if not exists penalty_opening_amount numeric(14,2) not null default 0
    check (penalty_opening_amount >= 0);

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
days as (
  select lp.loan_id, g.d::date as d, lp.from_d, lp.freq, lp.daily, lp.to_collect, lp.adv, lp.start_d, lp.grace,
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
    and least(to_collect, public.periods_due(freq, start_d, d - grace) * daily - adv) - upto > 0.001
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
