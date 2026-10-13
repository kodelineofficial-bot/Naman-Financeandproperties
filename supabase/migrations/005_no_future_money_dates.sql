-- 005: money can only be received / given on today or an earlier date (India time).
--
-- Why: a payment saved with a future date (e.g. "19 Oct" typed as "paid till")
-- shows on the loan page but not on today's collection sheet, cash book or day
-- book — the screens disagree. The "how many days" buttons already decide the
-- paid-till date, so the date field must only mean "the day the money came".

create or replace function public.reject_future_money_date()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  d date := (to_jsonb(new) ->> tg_argv[0])::date;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if d > today then
    raise exception 'Date % is in the future. Use the day the money actually came / went (today or earlier). Aage ki tareekh nahi daal sakte.', to_char(d, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists no_future_date on public.loan_repayments;
create trigger no_future_date before insert or update of paid_on on public.loan_repayments
  for each row execute function public.reject_future_money_date('paid_on');

drop trigger if exists no_future_date on public.loan_disbursements;
create trigger no_future_date before insert or update of paid_on on public.loan_disbursements
  for each row execute function public.reject_future_money_date('paid_on');

drop trigger if exists no_future_date on public.expenses;
create trigger no_future_date before insert or update of spent_on on public.expenses
  for each row execute function public.reject_future_money_date('spent_on');

drop trigger if exists no_future_date on public.cash_entries;
create trigger no_future_date before insert or update of entry_date on public.cash_entries
  for each row execute function public.reject_future_money_date('entry_date');

drop trigger if exists no_future_date on public.salary_payments;
create trigger no_future_date before insert or update of paid_on on public.salary_payments
  for each row execute function public.reject_future_money_date('paid_on');

drop trigger if exists no_future_date on public.employee_advances;
create trigger no_future_date before insert or update of given_on on public.employee_advances
  for each row execute function public.reject_future_money_date('given_on');

-- Move rows already saved with a future date back to the day they were entered.
update public.loan_repayments set paid_on = (created_at at time zone 'Asia/Kolkata')::date
  where paid_on > (now() at time zone 'Asia/Kolkata')::date;
update public.loan_disbursements set paid_on = (created_at at time zone 'Asia/Kolkata')::date
  where paid_on > (now() at time zone 'Asia/Kolkata')::date;
update public.expenses set spent_on = (created_at at time zone 'Asia/Kolkata')::date
  where spent_on > (now() at time zone 'Asia/Kolkata')::date;
update public.cash_entries set entry_date = (created_at at time zone 'Asia/Kolkata')::date
  where entry_date > (now() at time zone 'Asia/Kolkata')::date;
update public.salary_payments set paid_on = (created_at at time zone 'Asia/Kolkata')::date
  where paid_on > (now() at time zone 'Asia/Kolkata')::date;
update public.employee_advances set given_on = (created_at at time zone 'Asia/Kolkata')::date
  where given_on > (now() at time zone 'Asia/Kolkata')::date;
