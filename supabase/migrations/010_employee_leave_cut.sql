-- =====================================================================
-- 010: Salary cut per absent day set on each employee
--
-- employees.leave_cut_per_day  ₹ cut from salary for each absent day.
--   null  → old rule: monthly salary ÷ days in month (only when
--           Settings → "cut salary for absent days" is on)
--   value → this employee is cut that amount per absent day, even if the
--           Settings switch is off. Half day = half of it. 0 = no cut.
-- "Leave" (paid leave) is never cut.
--
-- Changed: employees + leave_cut_per_day, salary_report
-- =====================================================================

alter table public.employees
  add column if not exists leave_cut_per_day numeric(14,2) check (leave_cut_per_day >= 0);

create or replace function public.salary_report(p_month date)
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
    select e.id, e.name, e.designation, e.phone, e.is_active, e.monthly_salary, e.leave_cut_per_day, m.ndays, m.cut_on,
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
           case when x.leave_cut_per_day is not null
                then round(x.leave_cut_per_day * (x.absent_days + 0.5 * x.half_days))
                when x.cut_on
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
