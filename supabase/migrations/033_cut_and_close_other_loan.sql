-- =====================================================================
--  033 — Renew one loan and close another person's loan from it
--
--  Two borrowers come together: "renew Dave's loan, and clear my loan
--  out of the same new loan". The new loan pays Dave's old balance
--  (renewal, as before) and also closes G2's loan. Both old loans end.
--
--  G2 owes ₹4,000 balance + ₹300 penalty. Cut ₹3,800 + ₹200 penalty and
--  close it: ₹4,000 is cut from the new loan's cash (as in 027), and the
--  rest — ₹200 installments + ₹100 penalty — is forgiven (छूट), no cash.
--  G2's balance is ₹0, so the loan closes.
--
--  The forgiven part is saved as in 032 (repayment mode 'waiver',
--  penalty entry kind 'waived'), linked to the cut with cut_disb_id, so
--  Undo cut / deleting the new loan removes it too (on delete cascade).
--  It is not in the Day Book: 'waiver' repayments and waived penalty are
--  already kept out of the ledger.
--
--  New: cut_and_close_into_loan()
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- cut_and_close_into_loan: cut p_amount (installments) and p_penalty of
-- loan p_old from loan p_new's cash still to give, then forgive what is
-- left on p_old so it closes. Any borrower. Returns the disbursement id.
-- ---------------------------------------------------------------------
create or replace function public.cut_and_close_into_loan(p_old uuid, p_new uuid, p_amount numeric, p_penalty numeric, p_date date)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_balance numeric;
  v_pen_due numeric;
  v_no      int;
  v_new_no  int;
  v_inst    numeric;
  v_pen     numeric;
  v_disb    uuid;
  v_note    text;
begin
  p_amount  := round(greatest(coalesce(p_amount, 0), 0), 2);
  p_penalty := round(greatest(coalesce(p_penalty, 0), 0), 2);

  -- what is due before the cut (the cut can close the loan and change it)
  select outstanding, coalesce(penalty_due, 0), loan_no into v_balance, v_pen_due, v_no
    from loan_summary where id = p_old;
  if not found then raise exception 'Loan to cut from not found'; end if;

  v_disb := cut_dues_into_loan(p_old, p_new, p_amount, p_penalty, p_date);

  v_inst := round(greatest(v_balance - p_amount, 0), 2);
  v_pen  := round(greatest(v_pen_due - p_penalty, 0), 2);
  select loan_no into v_new_no from loans where id = p_new;
  v_note := 'Forgiven (छूट) · loan #' || v_no || ' closed from loan #' || v_new_no;

  if v_pen > 0 then
    insert into loan_penalty_entries (loan_id, kind, paid_on, amount, mode, note, cut_disb_id)
    values (p_old, 'waived', p_date, v_pen, 'waiver', v_note, v_disb);
  end if;
  if v_inst > 0 then
    insert into loan_repayments (loan_id, paid_on, amount, mode, note, cut_disb_id)
    values (p_old, p_date, v_inst, 'waiver', v_note, v_disb);
  end if;

  return v_disb;
end
$$;
revoke execute on function public.cut_and_close_into_loan(uuid, uuid, numeric, numeric, date) from public, anon;
grant execute on function public.cut_and_close_into_loan(uuid, uuid, numeric, numeric, date) to authenticated;

commit;
