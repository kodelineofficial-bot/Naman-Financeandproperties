-- =====================================================================
--  036 — Penalty once shown stays (only the owner lowers it)
--
--  034 worked penalty out from payment dates only, so a payment entered
--  late with an earlier date took back penalty already showing.
--  MAHEMBER VIRENDER: missed 17–22 Oct, ₹180 on the morning of the 22nd;
--  ₹1,200 dated 21 Oct entered on the 22nd → penalty fell to ₹120.
--
--  Now: just before a payment is added, changed or deleted, the penalty
--  days showing at that moment are saved (loan_penalty_held). A saved day
--  always counts. Only the owner lowers it: Take penalty / Waive / Edit
--  penalty (or reset / penalty off).
--  Today is saved only when the payment is for an earlier day: a payment
--  dated today still ends today's run (pay on day 3 → no penalty).
--
--  The days saved by 026 (loan_penalty_kept, other rules) are no longer
--  used. Payments entered since the current rules (035, 21 Oct evening)
--  are replayed in the order they were entered, so penalty taken back by
--  late entries comes back (17 loans, all from entries of 22 Oct dated
--  21 Oct). Earlier catch-up entries are not replayed: other rules were
--  in force then and those amounts were never shown.
--
--  New:     loan_penalty_held, penalty_late_days_at(loan, at) — the days as they were at a time
--  Changed: penalty_late_days() (same columns), loan_penalty (same columns)
--  Trigger: keep_penalty on loan_repayments (back)
-- =====================================================================

begin;

create table if not exists public.loan_penalty_held (
  loan_id uuid not null references public.loans(id) on delete cascade,
  d       date not null,
  held_at timestamptz not null default now(),
  primary key (loan_id, d)
);
alter table public.loan_penalty_held enable row level security;
drop policy if exists admin_all on public.loan_penalty_held;
create policy admin_all on public.loan_penalty_held for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Day by day as at time p_at: only payments entered before it, days up to
-- that day. p_at null = now, with everything entered.
create or replace function public.penalty_late_days_at(p_loan uuid, p_at timestamptz)
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
  where (p_loan is null or l.id = p_loan)
    and (p_at is null or l.created_at < p_at)
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
         least(case when l.status = 'active' then public.today_ist()
                    when l.status = 'defaulted' then least(public.today_ist(), coalesce(l.defaulted_on, public.today_ist())) - 1
                    when l.status in ('closed', 'renewed') then least(public.today_ist() - 1, l.closed_on - 1)
               end,
               coalesce((p_at at time zone 'Asia/Kolkata')::date, public.today_ist())) as to_d,
         s.penalty_grace_days as grace,
         (not l.penalty_off
          and coalesce(l.penalty_per_day, s.penalty_per_day) > 0
          and (s.penalty_enabled or l.penalty_per_day is not null)) as on_
  from base l cross join s
),
paid_day as (
  select r.loan_id, r.paid_on, sum(r.amount) as amt
  from public.loan_repayments r
  where (p_loan is null or r.loan_id = p_loan)
    and (p_at is null or r.created_at < p_at)
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

create or replace function public.penalty_late_days(p_loan uuid)
returns table (loan_id uuid, d date, from_d date, grace int, is_late boolean)
language sql
stable
as $$
  select * from public.penalty_late_days_at(p_loan, null)
$$;

-- A saved day counts as a penalty day (inside the loan's counting range).
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
  select x.loan_id, (count(*) filter (where x.is_late or k.d is not null))::int as penalty_days
  from public.penalty_late_days(null) x
  left join public.loan_penalty_held k on k.loan_id = x.loan_id and k.d = x.d
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

-- Save the penalty days showing at p_at for one loan. The day of p_at itself
-- only when the payment being changed is for an earlier day.
create or replace function public.keep_penalty_days_at(p_loan uuid, p_at timestamptz, p_paid_on date)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.loan_penalty_held (loan_id, d, held_at)
  select x.loan_id, x.d, p_at
  from public.penalty_late_days_at(p_loan, p_at) x
  where x.is_late
    and (x.d < (p_at at time zone 'Asia/Kolkata')::date or p_paid_on < (p_at at time zone 'Asia/Kolkata')::date)
  on conflict do nothing
$$;
revoke execute on function public.keep_penalty_days_at(uuid, timestamptz, date) from public, anon, authenticated;

drop function if exists public.keep_penalty_days(uuid);

create or replace function public.trg_keep_penalty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.keep_penalty_days_at(old.loan_id, now(),
      case when tg_op = 'UPDATE' then greatest(old.paid_on, new.paid_on) else old.paid_on end);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.loan_id <> old.loan_id) then
    perform public.keep_penalty_days_at(new.loan_id, now(), new.paid_on);
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists keep_penalty on public.loan_repayments;
create trigger keep_penalty
  before insert or update or delete on public.loan_repayments
  for each row execute function public.trg_keep_penalty();

-- Rebuild: replay the payments entered under the current rules, in the order
-- they were entered (as each was about to be saved).
do $$
declare r record;
begin
  for r in
    select loan_id, created_at, min(paid_on) as paid_on
    from public.loan_repayments
    where created_at >= '2026-10-21 14:05+00'
    group by loan_id, created_at
    order by created_at
  loop
    perform public.keep_penalty_days_at(r.loan_id, r.created_at, r.paid_on);
  end loop;
end $$;

commit;
