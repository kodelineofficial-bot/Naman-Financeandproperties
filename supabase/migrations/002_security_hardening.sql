-- Fixes from the Supabase security advisor.

-- Pin search_path on the helper functions.
alter function public.today_ist() set search_path = public;
alter function public.touch_updated_at() set search_path = public;

-- Trigger function: never callable over the API (the trigger still fires).
revoke execute on function public.trg_repayment_status() from public, anon, authenticated;

-- is_admin() is needed by RLS for signed-in users only.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- recalc_loan_status: signed-in non-admins may not call it.
create or replace function public.recalc_loan_status(p_loan uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due       numeric;
  v_status    text;
  v_collected numeric;
  v_last      date;
begin
  if auth.uid() is not null and not is_admin() then
    raise exception 'not allowed';
  end if;

  select total_repayable - advance_amount, status
    into v_due, v_status
    from loans where id = p_loan;

  if not found then
    return null;
  end if;

  select coalesce(sum(amount), 0), max(paid_on)
    into v_collected, v_last
    from loan_repayments where loan_id = p_loan;

  if v_status in ('active', 'defaulted') and v_collected >= v_due then
    update loans set status = 'closed', closed_on = coalesce(v_last, today_ist()) where id = p_loan;
    return 'closed';
  elsif v_status = 'closed' and v_collected < v_due then
    update loans set status = 'active', closed_on = null where id = p_loan;
    return 'active';
  end if;

  return v_status;
end
$$;
revoke execute on function public.recalc_loan_status(uuid) from public, anon;
grant execute on function public.recalc_loan_status(uuid) to authenticated;
