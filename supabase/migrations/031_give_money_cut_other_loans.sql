-- =====================================================================
--  031 — Give money: cut from any of the borrower's loans; salary cut
--        from the 4th absent day
--
--  1) Give money (loan page) can keep part of the money for the same
--     borrower's other running loans too, not only this loan's advance.
--     Example: Ravi has #10 (₹200/day) and #12 (₹100/day). Giving ₹5,000
--     on #12, he says "cut ₹600 for #10 and keep ₹500 advance on #12":
--       hand over ₹3,900 · #10 gets ₹600 · #12 gets ₹500 advance
--     Day Book: ₹5,000 loan given (₹1,100 of it no cash), ₹600 #10
--     collection, ₹500 advance kept. Cash moves only by ₹3,900.
--     It reuses cut_dues_into_loan (027) for the other loans and
--     give_loan_money (028) for this loan, in one transaction.
--
--  2) Salary: the first 3 absent days in a month are free (half day =
--     ½ day). The cut starts from the 4th day. 3 absent = no cut,
--     5 absent = 2 days cut. Settings.free_absent_days holds the 3.
--     Paid leave is never cut (as before).
--
--  New:     give_loan_money_cuts(), settings.free_absent_days
--  Changed: salary_report
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- give_loan_money_cuts: give p_amount on loan p_loan. p_cuts is a list of
-- {"loan": uuid, "amount": n, "penalty": n} — other loans' installments /
-- penalty paid out of this money. p_advance = this loan's own advance kept.
-- Handed over = p_amount − cuts − p_advance.
-- ---------------------------------------------------------------------
create or replace function public.give_loan_money_cuts(
  p_loan uuid, p_date date, p_amount numeric, p_advance numeric, p_mode text, p_note text, p_cuts jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cut   jsonb;
  v_amt   numeric;
  v_pen   numeric;
  v_total numeric := 0;
  v_rest  numeric;
begin
  p_amount  := round(coalesce(p_amount, 0), 2);
  p_advance := round(greatest(coalesce(p_advance, 0), 0), 2);
  if p_amount <= 0 then raise exception 'Enter an amount'; end if;

  for v_cut in select * from jsonb_array_elements(coalesce(p_cuts, '[]'::jsonb)) loop
    v_amt := round(greatest(coalesce((v_cut->>'amount')::numeric, 0), 0), 2);
    v_pen := round(greatest(coalesce((v_cut->>'penalty')::numeric, 0), 0), 2);
    if v_amt + v_pen > 0 then
      v_total := v_total + v_amt + v_pen;
      if v_total > p_amount + 0.001 then
        raise exception 'Cuts ₹% are more than the money given ₹%', v_total, p_amount;
      end if;
      perform cut_dues_into_loan((v_cut->>'loan')::uuid, p_loan, v_amt, v_pen, p_date);
    end if;
  end loop;

  v_rest := round(p_amount - v_total, 2);
  if p_advance > v_rest + 0.001 then
    raise exception 'Advance ₹% is more than the money left after cuts ₹%', p_advance, v_rest;
  end if;
  if v_rest > 0 then
    perform give_loan_money(p_loan, p_date, v_rest, p_advance, p_mode,
      coalesce(nullif(trim(p_note), ''),
               case when v_total > 0 then 'Given ₹' || trim_scale(p_amount) || ' − other loans ₹' || trim_scale(v_total)
                    || case when p_advance > 0 then ' − advance ₹' || trim_scale(p_advance) else '' end end));
  end if;
end
$$;
revoke execute on function public.give_loan_money_cuts(uuid, date, numeric, numeric, text, text, jsonb) from public, anon;
grant execute on function public.give_loan_money_cuts(uuid, date, numeric, numeric, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Salary: first free_absent_days (absent + ½ half days) are not cut
-- ---------------------------------------------------------------------
alter table public.settings
  add column if not exists free_absent_days numeric(4,1) not null default 3 check (free_absent_days >= 0);

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
           coalesce((select attendance_cuts_salary from settings where id = 1), true) as cut_on,
           coalesce((select free_absent_days from settings where id = 1), 3) as free_days
  ),
  x as (
    select e.id, e.name, e.designation, e.phone, e.is_active, e.monthly_salary, e.leave_cut_per_day, m.ndays, m.cut_on, m.free_days,
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
           greatest(x.absent_days + 0.5 * x.half_days - x.free_days, 0) as cut_days
    from x
  ),
  z as (
    select y.*,
           case when y.leave_cut_per_day is not null
                then round(y.leave_cut_per_day * y.cut_days)
                when y.cut_on
                then round(y.monthly_salary / y.ndays * y.cut_days)
                else 0 end as absent_cut
    from y
  )
  select id, name, designation, phone, is_active, monthly_salary,
         present_days, absent_days, half_days, leave_days, absent_cut,
         advances, paid,
         monthly_salary - absent_cut - advances - paid as balance
  from z
  where is_active or advances > 0 or paid > 0
  order by name
$$;
grant execute on function public.salary_report(date) to authenticated;
revoke execute on function public.salary_report(date) from public, anon;

commit;
