-- =====================================================================
-- 026: Penalty already counted is kept
--
-- Before: penalty was worked out fresh from the payment dates every time.
-- A payment entered later with an earlier date (e.g. UPI received on the
-- 17th, entered on the 18th) made the 17th "not behind" and the penalty
-- already showing went back to 0.
--
-- Now: just before a repayment is added, changed or deleted, the days
-- already counted as penalty for that loan (days before today) are saved
-- in loan_penalty_kept (every day behind, so a running spell stays one
-- spell). A saved day always counts, whatever is entered
-- later. Only the owner lowers it: Take penalty / Waive / Edit penalty.
-- Everything counted at the time this migration runs is saved too.
--
-- New days behind are still added on top. A saved day that runs on into
-- new days behind is the same spell (no second start-day charge).
--
-- New:     loan_penalty_kept, penalty_late_days(), trigger on loan_repayments
-- Changed: loan_penalty (same columns)
-- =====================================================================

create table if not exists public.loan_penalty_kept (
  loan_id uuid not null references public.loans(id) on delete cascade,
  d       date not null,
  kept_at timestamptz not null default now(),
  primary key (loan_id, d)
);
alter table public.loan_penalty_kept enable row level security;
drop policy if exists admin_all on public.loan_penalty_kept;
create policy admin_all on public.loan_penalty_kept for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Day by day: is the loan behind on day d? (one loan, or all loans when p_loan is null)
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
         case when l.status = 'active' then public.today_ist() - 1
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
         coalesce(pre.amt, 0)
           + sum(coalesce(pd.amt, 0)) over (partition by lp.loan_id order by g.d) as upto
  from lp
  cross join lateral generate_series(lp.start_d, lp.to_d, interval '1 day') g(d)
  left join paid_day pd on pd.loan_id = lp.loan_id and pd.paid_on = g.d::date
  left join pre on pre.loan_id = lp.loan_id
  where lp.on_ and lp.to_d >= lp.from_d
)
select loan_id, d, from_d, grace,
       (least(to_collect, public.periods_due(freq, start_d, d - grace) * daily - adv) - upto > 0.001) as is_late
from days
$$;

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
spells as (
  select x.loan_id, x.d, x.from_d, x.grace,
         (x.is_late or k.d is not null) as late,
         coalesce(lag(x.is_late or k.d is not null) over (partition by x.loan_id order by x.d), false) as prev_late
  from public.penalty_late_days(null) x
  left join public.loan_penalty_kept k on k.loan_id = x.loan_id and k.d = x.d
),
counted as (
  select loan_id,
         (count(*) filter (where late)
          -- a new spell of being behind: the free days before the start day are charged too
          + count(*) filter (where late and not prev_late) * (max(grace) + 1))::int as penalty_days
  from spells
  where d >= from_d
  group by loan_id
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

-- Save the days counted so far for one loan
create or replace function public.keep_penalty_days(p_loan uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.loan_penalty_kept (loan_id, d)
  select loan_id, d from public.penalty_late_days(p_loan)
  where is_late  -- every late day, also before the counting start: it decides whether a spell is new
  on conflict do nothing
$$;
revoke execute on function public.keep_penalty_days(uuid) from public, anon, authenticated;

create or replace function public.trg_keep_penalty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.keep_penalty_days(old.loan_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.loan_id <> old.loan_id) then
    perform public.keep_penalty_days(new.loan_id);
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists keep_penalty on public.loan_repayments;
create trigger keep_penalty
  before insert or update or delete on public.loan_repayments
  for each row execute function public.trg_keep_penalty();

-- What shows today stays
insert into public.loan_penalty_kept (loan_id, d)
select loan_id, d from public.penalty_late_days(null)
where is_late  -- every late day, also before the counting start: it decides whether a spell is new
on conflict do nothing;
