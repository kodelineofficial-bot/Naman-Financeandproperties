-- =====================================================================
-- 012: Defaulted loans are frozen; resuming moves the schedule forward
--
-- Mark defaulted (status → 'defaulted'):
--   loans.defaulted_on = today. From that day the loan stops growing:
--   no new installments become due (overdue stays where it was) and no
--   new penalty days are counted. Penalty still due at that moment is
--   waived (a 'waived' entry, note "Loan marked defaulted").
--
-- Leaving defaulted:
--   → 'active' (resume): the schedule moves forward by the days the loan
--     was defaulted (collection_start_date + those days, kept in
--     loans.paused_days), so the borrower continues from the installment
--     where they stopped.
--   → closed / renewed / cancelled (e.g. settled with the full balance):
--     nothing is shifted.
--   Either way penalty starts afresh: loans.penalty_reset_at = now(), only
--   days from that date and penalty entries made after it are counted.
--
-- Changed: loans + defaulted_on, paused_days, penalty_reset_at
--          trigger loans_default_status (before) + loans_default_waive (after)
--          loan_penalty, loan_summary (+ defaulted_on, paused_days), collection_sheet
-- =====================================================================

alter table public.loans
  add column if not exists defaulted_on     date,
  add column if not exists paused_days      int not null default 0,
  add column if not exists penalty_reset_at timestamptz;

-- Loans already defaulted before this change: frozen from today.
update public.loans set defaulted_on = public.today_ist()
where status = 'defaulted' and defaulted_on is null;

-- ---------------------------------------------------------------------
-- Status change → freeze / resume
-- ---------------------------------------------------------------------
create or replace function public.loans_default_status()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_shift int;
begin
  if new.status = 'defaulted' and old.status is distinct from 'defaulted' then
    new.defaulted_on := today_ist();
  elsif old.status = 'defaulted' and new.status <> 'defaulted' then
    if new.status = 'active' and old.defaulted_on is not null then
      v_shift := greatest(today_ist() - old.defaulted_on, 0);
      new.collection_start_date := new.collection_start_date + v_shift;
      new.paused_days := coalesce(old.paused_days, 0) + v_shift;
    end if;
    new.defaulted_on := null;
    new.penalty_reset_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists loans_default_status on public.loans;
create trigger loans_default_status before update of status on public.loans
  for each row execute function public.loans_default_status();

-- After marking defaulted: waive the penalty that is still due.
create or replace function public.loans_default_waive()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_due numeric;
begin
  if new.status = 'defaulted' and old.status is distinct from 'defaulted' then
    select penalty_due into v_due from loan_penalty where loan_id = new.id;
    if coalesce(v_due, 0) > 0 then
      insert into loan_penalty_entries (loan_id, paid_on, kind, amount, mode, note)
      values (new.id, today_ist(), 'waived', v_due, 'cash', 'Loan marked defaulted');
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists loans_default_waive on public.loans;
create trigger loans_default_waive after update of status on public.loans
  for each row execute function public.loans_default_waive();

-- ---------------------------------------------------------------------
-- Penalty: stops on the day the loan is defaulted; restarts from
-- penalty_reset_at.
-- ---------------------------------------------------------------------
create or replace view public.loan_penalty
with (security_invoker = on) as
with s as (
  select penalty_enabled, penalty_per_day, penalty_grace_days, penalty_from
  from public.settings where id = 1
),
lp as (
  select l.id as loan_id,
         l.frequency as freq,
         l.daily_installment as daily,
         l.total_repayable - l.advance_amount as to_collect,
         l.advance_amount as adv,
         l.collection_start_date as start_d,
         greatest(l.collection_start_date, s.penalty_from,
                  coalesce((l.penalty_reset_at at time zone 'Asia/Kolkata')::date, l.collection_start_date)) as from_d,
         l.penalty_reset_at as reset_at,
         case when l.status = 'active' then public.today_ist() - 1
              when l.status = 'defaulted' then least(public.today_ist(), coalesce(l.defaulted_on, public.today_ist())) - 1
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
       coalesce(c.penalty_days, 0) * lp.rate as penalty_charged,
       coalesce(e.paid, 0)   as penalty_paid,
       coalesce(e.waived, 0) as penalty_waived,
       greatest(coalesce(c.penalty_days, 0) * lp.rate - coalesce(e.paid, 0) - coalesce(e.waived, 0), 0) as penalty_due
from lp
left join counted c on c.loan_id = lp.loan_id
left join e on e.loan_id = lp.loan_id;

-- ---------------------------------------------------------------------
-- Loan summary: a defaulted loan counts installments only up to the day
-- before it was defaulted (+ defaulted_on, paused_days appended).
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
         l.paused_days
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
       base.paused_days
from base
left join public.loan_penalty pn on pn.loan_id = base.id;

-- ---------------------------------------------------------------------
-- Collection sheet: a defaulted loan's shortfall stays as it was on the
-- day before it was defaulted.
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
    and (
      l.status in ('active', 'defaulted')
      or coalesce(r.on_date, 0) > 0
      or (l.status = 'closed' and l.closed_on >= p_date)
      or (l.status = 'renewed' and l.closed_on > p_date)
    )
  order by b.name, l.loan_no
$$;
