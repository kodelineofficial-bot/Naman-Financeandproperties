-- =====================================================================
--  016 — Cut old loans' overdue from a new loan (बकाया काटें)
--
--  A borrower with running loans takes one more loan. The owner can cut
--  the overdue (or any part of the balance) of one or more of those
--  loans from the new loan's cash. Unlike renewal (004) the old loans
--  stay running: the cut counts as a payment on them, and the rest is
--  collected with the normal schedule.
--
--  Example: Loan A ₹5,000 has ₹900 overdue, Loan B ₹12,000 has ₹1,350
--  overdue. New loan net ₹8,100 → ₹2,250 cut → ₹5,850 cash given.
--  Loan A and B are paid up to date and keep running.
--
--  How it is recorded (no cash moves for the cut part), like renewal:
--    old loan : repayment    mode = 'renewal', adjusted_into = new loan
--    new loan : disbursement mode = 'renewal'
--  The repayment is linked to the new loan, so deleting the new loan
--  removes the cut on the old loans too (on delete cascade).
--
--  Changed: loan_repayments + adjusted_into
--           recalc_loan_status: a 'renewed' loan stays renewed only while
--             a loan is renewed from it (an overdue cut is also mode
--             'renewal', so the old "any renewal row" test is not enough)
--           + cut_overdue_into_loan()
-- =====================================================================

alter table public.loan_repayments
  add column if not exists adjusted_into uuid references public.loans (id) on delete cascade;
create index if not exists loan_rep_adjusted_into_idx on public.loan_repayments (adjusted_into);

create or replace function public.recalc_loan_status(p_loan uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due       numeric;
  v_status    text;
  v_old       boolean;
  v_collected numeric;
  v_last      date;
  v_renewal   boolean;
begin
  if auth.uid() is not null and not is_admin() then
    raise exception 'not allowed';
  end if;

  select total_repayable - advance_amount, status, old_defaulter
    into v_due, v_status, v_old
    from loans where id = p_loan;

  if not found then
    return null;
  end if;

  select coalesce(sum(amount), 0), max(paid_on),
         bool_or(mode = 'renewal' and adjusted_into is null)
    into v_collected, v_last, v_renewal
    from loan_repayments where loan_id = p_loan;

  if v_status in ('active', 'defaulted') and v_collected >= v_due then
    update loans set status = 'closed', closed_on = coalesce(v_last, today_ist()) where id = p_loan;
    return 'closed';
  elsif v_status = 'closed' and v_collected < v_due then
    update loans set status = case when v_old then 'defaulted' else 'active' end, closed_on = null where id = p_loan;
    return case when v_old then 'defaulted' else 'active' end;
  elsif v_status = 'renewed'
        and not (coalesce(v_renewal, false) and exists (select 1 from loans where renewed_from = p_loan)) then
    -- the renewal adjustment (or the new loan) was deleted → loan is running again
    update loans set status = case when v_collected >= v_due then 'closed'
                                   when v_old then 'defaulted' else 'active' end,
                     closed_on = case when v_collected >= v_due then coalesce(v_last, today_ist()) end
     where id = p_loan;
    return (select status from loans where id = p_loan);
  end if;

  return v_status;
end
$$;
revoke execute on function public.recalc_loan_status(uuid) from public, anon;
grant execute on function public.recalc_loan_status(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- cut_overdue_into_loan: cut p_amount of old loan p_old from new loan
-- p_new's cash. Call once per old loan, right after inserting the new loan.
-- ---------------------------------------------------------------------
create or replace function public.cut_overdue_into_loan(p_old uuid, p_new uuid, p_amount numeric, p_date date)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old     loans%rowtype;
  v_new     loans%rowtype;
  v_balance numeric;
  v_cut     numeric;
begin
  select * into v_old from loans where id = p_old for update;
  if not found then raise exception 'Old loan not found'; end if;
  select * into v_new from loans where id = p_new for update;
  if not found then raise exception 'New loan not found'; end if;
  if p_old = p_new then raise exception 'A loan cannot cut its own overdue'; end if;
  if v_old.status not in ('active', 'defaulted') then
    raise exception 'Loan #% is not running (status: %)', v_old.loan_no, v_old.status;
  end if;
  if v_old.borrower_id <> v_new.borrower_id then
    raise exception 'Both loans must be of the same borrower';
  end if;

  select greatest(v_old.total_repayable - v_old.advance_amount - coalesce(sum(amount), 0), 0)
    into v_balance from loan_repayments where loan_id = p_old;

  p_amount := round(coalesce(p_amount, 0), 2);
  if p_amount <= 0 then return; end if;
  if p_amount > v_balance + 0.001 then
    raise exception 'Cut ₹% is more than loan #% balance ₹%', p_amount, v_old.loan_no, v_balance;
  end if;

  select coalesce(sum(amount), 0) into v_cut
    from loan_disbursements where loan_id = p_new and mode = 'renewal';
  if v_cut + p_amount > v_new.net_disbursable + 0.001 then
    raise exception 'Old dues ₹% are more than the new loan''s cash ₹% — make the new loan bigger',
      v_cut + p_amount, v_new.net_disbursable;
  end if;

  insert into loan_repayments (loan_id, paid_on, amount, mode, note, adjusted_into)
  values (p_old, p_date, p_amount, 'renewal', 'Overdue cut in new loan #' || v_new.loan_no, p_new);
  insert into loan_disbursements (loan_id, paid_on, amount, mode, note)
  values (p_new, p_date, p_amount, 'renewal', 'Loan #' || v_old.loan_no || ' overdue cut');
end
$$;
revoke execute on function public.cut_overdue_into_loan(uuid, uuid, numeric, date) from public, anon;
grant execute on function public.cut_overdue_into_loan(uuid, uuid, numeric, date) to authenticated;
