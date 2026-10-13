-- =====================================================================
--  003 — Multi-day payments + employee attendance
--
--  1. A payment of 2 × / 4 × the daily installment now "fills" that many
--     days. Every loan gets `days_covered` and `paid_till` (the last day
--     that is fully paid for). The collection sheet uses this, so someone
--     who paid 4 days at once is not shown as "not paid" the next 3 days.
--  2. Employee attendance (हाज़िरी): present / absent / half day / leave.
--     Absent days can be cut from salary (Settings → on by default).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Loan summary: + days_covered, paid_till  (columns appended at the end)
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
         sum(amount) filter (where paid_on = public.today_ist()) as paid_today
  from public.loan_repayments group by loan_id
),
base as (
  select l.*,
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
         greatest(public.today_ist() - l.collection_start_date + 1, 0) as days_elapsed
  from public.loans l
  join public.borrowers b on b.id = l.borrower_id
  left join d on d.loan_id = l.id
  left join r on r.loan_id = l.id
)
select base.*,
       base.net_disbursable - base.disbursed as pending_disbursement,
       greatest(base.total_repayable - base.collected_total, 0) as outstanding,
       least(base.total_repayable,
             base.advance_amount + base.days_elapsed * base.daily_installment) as expected_till_today,
       case when base.status in ('active', 'defaulted') then
         greatest(least(base.total_repayable,
                        base.advance_amount + base.days_elapsed * base.daily_installment)
                  - base.collected_total, 0)
       else 0 end as overdue,
       base.collection_start_date
         + (ceil(greatest(base.total_repayable - base.advance_amount, 0) / base.daily_installment))::int
         - 1 as expected_end_date,
       ceil(greatest(base.total_repayable - base.collected_total, 0) / base.daily_installment)::int
         as installments_left,
       round(case when base.total_repayable > 0
                  then base.collected_total / base.total_repayable * 100 else 0 end, 1) as progress_pct,
       (base.total_repayable - base.principal + base.interest_amount) as expected_profit,
       floor(base.collected_cash / base.daily_installment)::int as days_covered,
       case when base.collected_cash >= base.daily_installment
            then base.collection_start_date + floor(base.collected_cash / base.daily_installment)::int - 1
       end as paid_till
from base;

-- ---------------------------------------------------------------------
-- Collection sheet for any date (works for past dates too)
--   collected_upto : everything paid on or before p_date
--   paid_on_date   : paid on p_date itself
--   paid_till      : last day fully covered by collected_upto
--   short_upto     : how much is behind schedule as of p_date
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
  outstanding       numeric
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
         case when coalesce(r.upto, 0) >= l.daily_installment
              then l.collection_start_date + floor(coalesce(r.upto, 0) / l.daily_installment)::int - 1
         end as paid_till,
         greatest(least(l.total_repayable - l.advance_amount,
                        (p_date - l.collection_start_date + 1) * l.daily_installment)
                  - coalesce(r.upto, 0), 0) as short_upto,
         greatest(l.total_repayable - l.advance_amount - coalesce(r.total, 0), 0) as outstanding
  from loans l
  join borrowers b on b.id = l.borrower_id
  left join lateral (
    select sum(amount) filter (where paid_on <= p_date) as upto,
           sum(amount) filter (where paid_on = p_date)  as on_date,
           sum(amount)                                  as total
    from loan_repayments x where x.loan_id = l.id
  ) r on true
  where l.collection_start_date <= p_date
    and l.loan_date <= p_date
    and (
      l.status in ('active', 'defaulted')
      or coalesce(r.on_date, 0) > 0                    -- closed later, but paid on this day
      or (l.status = 'closed' and l.closed_on >= p_date)
    )
  order by b.name, l.loan_no
$$;
grant execute on function public.collection_sheet(date) to authenticated;
revoke execute on function public.collection_sheet(date) from public, anon;

-- ---------------------------------------------------------------------
-- Employee attendance (हाज़िरी)
-- ---------------------------------------------------------------------
create table if not exists public.employee_attendance (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  att_date    date not null,
  status      text not null check (status in ('present', 'absent', 'half', 'leave')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (employee_id, att_date)
);
create index if not exists emp_att_date_idx on public.employee_attendance (att_date);

drop trigger if exists trg_emp_att_touch on public.employee_attendance;
create trigger trg_emp_att_touch before update on public.employee_attendance
  for each row execute function public.touch_updated_at();

alter table public.employee_attendance enable row level security;
drop policy if exists admin_all on public.employee_attendance;
create policy admin_all on public.employee_attendance
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public'
                       and tablename = 'employee_attendance') then
    alter publication supabase_realtime add table public.employee_attendance;
  end if;
end
$$;

-- Cut salary for absent days? (absent = 1 day, half day = ½ day, leave = no cut)
alter table public.settings
  add column if not exists attendance_cuts_salary boolean not null default true;

-- ---------------------------------------------------------------------
-- Salary report now includes attendance
--   per day      = monthly salary ÷ days in that month
--   absent_cut   = per day × (absent + ½ × half days)   (if the setting is on)
--   balance      = salary − absent_cut − advances − paid
-- ---------------------------------------------------------------------
drop function if exists public.salary_report(date);
create function public.salary_report(p_month date)
returns table (
  employee_id    uuid,
  name           text,
  designation    text,
  phone          text,
  is_active      boolean,
  monthly_salary numeric,
  present_days   int,
  absent_days    int,
  half_days      int,
  leave_days     int,
  absent_cut     numeric,
  advances       numeric,
  paid           numeric,
  balance        numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with m as (
    select date_trunc('month', p_month)::date as month,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date as month_end,
           extract(day from date_trunc('month', p_month) + interval '1 month - 1 day')::int as ndays,
           coalesce((select attendance_cuts_salary from settings where id = 1), true) as cut_on
  ),
  x as (
    select e.id, e.name, e.designation, e.phone, e.is_active, e.monthly_salary, m.ndays, m.cut_on,
           coalesce((select sum(a.amount) from employee_advances a
                     where a.employee_id = e.id and a.deduct_month = m.month), 0) as advances,
           coalesce((select sum(s.amount) from salary_payments s
                     where s.employee_id = e.id and s.salary_month = m.month), 0) as paid,
           (select count(*) from employee_attendance t
             where t.employee_id = e.id and t.att_date between m.month and m.month_end and t.status = 'present')::int as present_days,
           (select count(*) from employee_attendance t
             where t.employee_id = e.id and t.att_date between m.month and m.month_end and t.status = 'absent')::int as absent_days,
           (select count(*) from employee_attendance t
             where t.employee_id = e.id and t.att_date between m.month and m.month_end and t.status = 'half')::int as half_days,
           (select count(*) from employee_attendance t
             where t.employee_id = e.id and t.att_date between m.month and m.month_end and t.status = 'leave')::int as leave_days
    from employees e, m
    where e.joining_date <= m.month_end
  ),
  y as (
    select x.*,
           case when x.cut_on
                then round(x.monthly_salary / x.ndays * (x.absent_days + 0.5 * x.half_days))
                else 0 end as absent_cut
    from x
  )
  select id, name, designation, phone, is_active, monthly_salary,
         present_days, absent_days, half_days, leave_days, absent_cut,
         advances, paid,
         monthly_salary - absent_cut - advances - paid as balance
  from y
  where is_active or advances > 0 or paid > 0
  order by name
$$;
grant execute on function public.salary_report(date) to authenticated;
revoke execute on function public.salary_report(date) from public, anon;
