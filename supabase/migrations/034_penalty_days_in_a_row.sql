-- =====================================================================
--  034 — Penalty only for days unpaid in a row
--
--  Before (023/026): penalty was charged while the loan was behind
--  schedule. Missing one day twice (16th and 22nd, paying every other
--  day) left him 2 days behind, and penalty started.
--
--  Now: a day is "missed" when nothing was paid that day and the loan is
--  behind. Penalty is charged only for a run of missed days in a row that
--  reaches the start day (Settings "Penalty starts on day", 3 by default):
--    ₹30/day: day 1 ₹0, day 2 ₹0, day 3 ₹90 (all 3 days), day 4 ₹120 …
--  Any payment on a day ends the run. Paid 10–15, missed 16, paid 17–21,
--  missed 22, paid again → no penalty.
--
--  Today counts as a missed day while nothing is paid today (so day 3
--  shows ₹90 on day 3). A payment today ends the run.
--
--  Worked out from the payment dates only. Days saved by 026
--  (loan_penalty_kept) are no longer used: a payment entered late with
--  its real date (UPI of the 17th entered on the 18th, a collection sheet
--  filled next day) means that day was paid, so it ends the run.
--  Penalty received / waived / added by hand stays as it is.
--
--  Changed: penalty_late_days(), loan_penalty
--  Dropped: trigger keep_penalty on loan_repayments
-- =====================================================================

begin;

-- Day by day: is day d a penalty day (in a run of missed days long enough)?
-- Same name and columns as before (used by loan_penalty).
create or replace function public.penalty_late_days(p_loan uuid)
returns table (loan_id uuid, d date, from_d date, grace int, is_late boolean)
language sql
stable
as $$
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
  where p_loan is null or l.id = p_loan
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
         case when l.status = 'active' then public.today_ist()
              when l.status = 'defaulted' then least(public.today_ist(), coalesce(l.defaulted_on, public.today_ist())) - 1
              when l.status in ('closed', 'renewed') then least(public.today_ist() - 1, l.closed_on - 1)
         end as to_d,
         s.penalty_grace_days as grace,
         (not l.penalty_off
          and coalesce(l.penalty_per_day, s.penalty_per_day) > 0
          and (s.penalty_enabled or l.penalty_per_day is not null)) as on_
  from base l cross join s
),
paid_day as (
  select r.loan_id, r.paid_on, sum(r.amount) as amt
  from public.loan_repayments r
  where p_loan is null or r.loan_id = p_loan
  group by r.loan_id, r.paid_on
),
-- everything paid before collection started, once per loan
pre as (
  select lp.loan_id, sum(p.amt) as amt
  from lp join paid_day p on p.loan_id = lp.loan_id and p.paid_on < lp.start_d
  group by lp.loan_id
),
days as (
  select lp.loan_id, g.d::date as d, lp.from_d, lp.freq, lp.daily, lp.to_collect, lp.adv, lp.start_d, lp.grace,
         coalesce(pd.amt, 0) as paid_today,
         coalesce(pre.amt, 0)
           + sum(coalesce(pd.amt, 0)) over (partition by lp.loan_id order by g.d) as upto
  from lp
  cross join lateral generate_series(lp.start_d, lp.to_d, interval '1 day') g(d)
  left join paid_day pd on pd.loan_id = lp.loan_id and pd.paid_on = g.d::date
  left join pre on pre.loan_id = lp.loan_id
  where lp.on_ and lp.to_d >= lp.from_d
),
-- missed: nothing paid that day and still behind after it
m as (
  select *,
         (paid_today <= 0
          and least(to_collect, public.periods_due(freq, start_d, d) * daily - adv) - upto > 0.001) as missed
  from days
),
-- days missed in a row share one run (date − position among missed days)
runs as (
  select *,
         d - (row_number() over (partition by loan_id, missed order by d))::int as run_id
  from m
)
select loan_id, d, from_d, grace,
       (missed and count(*) over (partition by loan_id, missed, run_id) >= grace + 2) as is_late
from runs
$$;

drop trigger if exists keep_penalty on public.loan_repayments;

-- Every penalty day is now in the run itself: no extra start-day charge.
create or replace view public.loan_penalty
with (security_invoker = on) as
with s as (
  select penalty_enabled, penalty_per_day from public.settings where id = 1
),
lp as (
  select l.id as loan_id,
         case when l.penalty_opening_date is not null
                   and not l.penalty_off
                   and (l.penalty_reset_at is null
                        or l.penalty_opening_date >= (l.penalty_reset_at at time zone 'Asia/Kolkata')::date)
              then l.penalty_opening_amount else 0 end as opening,
         coalesce(l.penalty_per_day, s.penalty_per_day) as rate
  from public.loans l cross join s
),
counted as (
  select x.loan_id, (count(*) filter (where x.is_late))::int as penalty_days
  from public.penalty_late_days(null) x
  where x.d >= x.from_d
  group by x.loan_id
),
e as (
  select x.loan_id,
         coalesce(sum(x.amount) filter (where x.kind = 'paid'), 0)   as paid,
         coalesce(sum(x.amount) filter (where x.kind = 'waived'), 0) as waived,
         -- raised by hand ("Edit penalty"); like the opening amount, not counted while penalty is off
         coalesce(sum(x.amount) filter (where x.kind = 'added' and not l.penalty_off), 0) as added
  from public.loan_penalty_entries x
  join public.loans l on l.id = x.loan_id
  where l.penalty_reset_at is null or x.created_at > l.penalty_reset_at
  group by x.loan_id
)
select lp.loan_id,
       coalesce(c.penalty_days, 0) as penalty_days,
       lp.rate as penalty_rate,
       lp.opening + coalesce(c.penalty_days, 0) * lp.rate + coalesce(e.added, 0) as penalty_charged,
       coalesce(e.paid, 0)   as penalty_paid,
       coalesce(e.waived, 0) as penalty_waived,
       greatest(lp.opening + coalesce(c.penalty_days, 0) * lp.rate + coalesce(e.added, 0)
                - coalesce(e.paid, 0) - coalesce(e.waived, 0), 0) as penalty_due,
       lp.opening as penalty_opening,
       coalesce(e.added, 0) as penalty_added
from lp
left join counted c on c.loan_id = lp.loan_id
left join e on e.loan_id = lp.loan_id;

commit;
