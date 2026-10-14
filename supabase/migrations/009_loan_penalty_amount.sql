-- =====================================================================
-- 009: Penalty amount set on each loan (at loan creation)
--
-- loans.penalty_per_day  ₹ per late day for THIS loan.
--   null  → use Settings → penalty_per_day (only when penalty is on there)
--   value → this loan is charged that amount per late day, even if the
--           penalty switch in Settings is off. 0 = no penalty.
-- Grace days and "count from" date still come from Settings.
--
-- Changed: loans + penalty_per_day, loan_penalty (rate per loan)
-- =====================================================================

alter table public.loans
  add column if not exists penalty_per_day numeric(14,2) check (penalty_per_day >= 0);

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
         coalesce(l.penalty_per_day, s.penalty_per_day) as rate,
         s.penalty_grace_days as grace,
         (not l.penalty_off
          and coalesce(l.penalty_per_day, s.penalty_per_day) > 0
          and (s.penalty_enabled or l.penalty_per_day is not null)) as on_
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
