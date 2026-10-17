-- =====================================================================
-- 023: Penalty counts from the first missed day once it starts
--
-- Before: with "penalty starts on day 3" a borrower who stopped paying
-- got ₹30 on day 3, ₹60 on day 4 …  (only the days after the free days).
-- Now: on the start day the free days are charged too —
--   ₹30/day, start day 3 → day 3 = ₹90, day 4 = ₹120, day 5 = ₹150 …
-- i.e. each spell of being behind adds (start day − 1) = grace + 1 extra
-- days the moment it reaches the start day.
--
-- Paying the overdue does not take away penalty already counted (days
-- already behind stay counted). If the borrower falls behind again,
-- a new spell starts and its penalty is added on top of the old one.
--
-- A spell already running before the counting start (Settings "count
-- from" date, a hand-set "penalty up to" amount, or a resume after
-- default) gets no extra days: those days were settled by that start.
--
-- Changed: loan_penalty (same columns)
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
