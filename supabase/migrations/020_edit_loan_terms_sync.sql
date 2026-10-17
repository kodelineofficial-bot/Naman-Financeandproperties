-- Save corrected terms and actual payouts together. All existing ledger and
-- cashflow views then see the correction on the original transaction date.
create or replace function public.edit_loan_terms(
  p_loan uuid,
  p_terms jsonb,
  p_disbursements jsonb,
  p_expected_updated_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old loans%rowtype;
  v_new loans%rowtype;
  v_row jsonb;
  v_disb loan_disbursements%rowtype;
  v_count int;
  v_payout numeric := 0;
begin
  if not is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into v_old from loans where id = p_loan for update;
  if not found then
    raise exception 'Loan not found';
  end if;
  if p_expected_updated_at is distinct from v_old.updated_at then
    raise exception 'This loan changed while you were editing. Reload Edit terms and try again.';
  end if;
  if p_terms is null or jsonb_typeof(p_terms) <> 'object'
     or p_disbursements is null or jsonb_typeof(p_disbursements) <> 'array' then
    raise exception 'Invalid loan edit';
  end if;
  v_new := jsonb_populate_record(v_old, p_terms);
  if v_new.daily_installment <= 0 or v_new.total_repayable <= 0
     or v_new.duration_days is distinct from ceil(v_new.total_repayable / nullif(v_new.daily_installment, 0))::int then
    raise exception 'Duration must match the total repayable and installment. Re-enter the duration or total.';
  end if;
  if v_new.loan_date > today_ist() or v_new.collection_start_date < v_new.loan_date then
    raise exception 'Check the loan date and collection start date.';
  end if;

  perform 1 from loan_disbursements where loan_id = p_loan for update;
  select count(*) into v_count from loan_disbursements
    where loan_id = p_loan and mode not in ('renewal', 'opening');
  if jsonb_array_length(p_disbursements) <> v_count
     or (select count(distinct value->>'id') from jsonb_array_elements(p_disbursements)) <> v_count then
    raise exception 'Payouts changed while you were editing. Reload Edit terms and try again.';
  end if;
  select coalesce(sum(amount), 0) into v_payout from loan_disbursements
    where loan_id = p_loan and mode in ('renewal', 'opening');

  for v_row in select value from jsonb_array_elements(p_disbursements) loop
    select * into v_disb from loan_disbursements
      where id = (v_row->>'id')::uuid and loan_id = p_loan
        and mode not in ('renewal', 'opening');
    if not found or v_disb.amount is distinct from (v_row->>'original_amount')::numeric then
      raise exception 'A payout changed while you were editing. Reload Edit terms and try again.';
    end if;
    if (v_row->>'amount')::numeric is null or (v_row->>'amount')::numeric <= 0
       or (v_row->>'amount')::numeric <> round((v_row->>'amount')::numeric, 2) then
      raise exception 'Each payout must be more than 0, with at most two decimal places.';
    end if;
    v_payout := v_payout + (v_row->>'amount')::numeric;
  end loop;
  if v_payout > v_new.principal - v_new.interest_amount - v_new.advance_amount then
    raise exception 'Recorded payouts exceed cash to give. Correct the amount handed over.';
  end if;

  update loans set
    frequency = v_new.frequency,
    principal = v_new.principal,
    interest_pct = v_new.interest_pct,
    interest_amount = v_new.interest_amount,
    markup_pct = v_new.markup_pct,
    total_repayable = v_new.total_repayable,
    daily_installment = v_new.daily_installment,
    duration_days = v_new.duration_days,
    advance_days = v_new.advance_days,
    advance_amount = v_new.advance_amount,
    penalty_per_day = v_new.penalty_per_day,
    loan_date = v_new.loan_date,
    collection_start_date = v_new.collection_start_date,
    notes = v_new.notes,
    status = v_new.status,
    closed_on = case when v_new.status = 'closed' then coalesce(v_old.closed_on, today_ist())
                     when v_new.status = 'active' then null else v_old.closed_on end
  where id = p_loan;

  for v_row in select value from jsonb_array_elements(p_disbursements) loop
    update loan_disbursements set amount = (v_row->>'amount')::numeric
      where id = (v_row->>'id')::uuid and loan_id = p_loan
        and amount is distinct from (v_row->>'amount')::numeric;
  end loop;

  -- An extended, previously paid-off loan must reopen. Explicit settlement or
  -- default choices are kept; cancelled and renewed loans keep their status.
  if v_new.status = 'active' or (
    v_new.status = v_old.status and v_new.status in ('closed', 'defaulted')
    and (v_new.total_repayable, v_new.advance_amount) is distinct from (v_old.total_repayable, v_old.advance_amount)
  ) then
    perform recalc_loan_status(p_loan);
  end if;
  return p_loan;
end;
$$;

revoke execute on function public.edit_loan_terms(uuid, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.edit_loan_terms(uuid, jsonb, jsonb, timestamptz) to authenticated;
