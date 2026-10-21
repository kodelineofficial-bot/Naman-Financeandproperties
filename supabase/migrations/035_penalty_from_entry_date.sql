-- =====================================================================
--  035 — Penalty counts from the day the loan was entered
--
--  Old loans were put in the software later (most on 15 October) with
--  their past collections entered in one go. Before that day the
--  software does not know which days were paid, so they must not count.
--  Karan Gulsan #66: loan from 17 July, entered on 15 October with
--  ₹11,520 paid that day → no penalty (034 charged 14 October).
--
--  Penalty now starts from the latest of: collection start, Settings
--  "count from", a hand-set "penalty up to" date, a reset, and the day
--  the loan was entered. Unpaid days before that start are not part of a
--  run either: the 3 days in a row are counted from the start.
--
--  Changed: penalty_late_days() (same columns)
-- =====================================================================

begin;

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
                  coalesce((l.penalty_reset_at at time zone 'Asia/Kolkata')::date, l.collection_start_date),
                  -- the day the loan was entered in the software: days before it are not known
                  (l.created_at at time zone 'Asia/Kolkata')::date) as from_d,
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
-- missed: nothing paid that day and still behind after it (from the counting start only,
-- so days before it do not make a run longer)
m as (
  select *,
         (d >= from_d
          and paid_today <= 0
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

commit;
