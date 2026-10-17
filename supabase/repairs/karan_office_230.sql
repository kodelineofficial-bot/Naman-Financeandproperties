-- Latest user clarification: #230 actual payout is 3550, not 3400.
-- Before advance: 3700; advance kept: 150 Cash; actual UPI sent: 3550.
-- Yesterday's #225 keeps its actual 2450 UPI payout and 100 Cash advance.
-- Apply migrations 021 and 022 first. The checks prevent editing a different loan.
begin;
do $$
declare
  v_loan loans%rowtype;
  v_payout loan_disbursements%rowtype;
  v_case record;
begin
  for v_case in select * from (values
    (230, '2026-10-17'::date, '7f21da59-87a6-41fd-9db9-03cbd100b1dd'::uuid, 150, 3550),
    (225, '2026-10-16'::date, 'f0e89833-3633-44bd-8291-fb3d1f89f861'::uuid, 100, 2450)
  ) as cases(loan_no, loan_date, loan_id, advance, payout) loop
    select l.* into strict v_loan from loans l join borrowers b on b.id = l.borrower_id
    where l.loan_no = v_case.loan_no and l.loan_date = v_case.loan_date
      and upper(trim(b.name)) = 'KARAN OFFICE'
      and l.id = v_case.loan_id
    for update of l;
    if v_loan.advance_amount <> v_case.advance then
      raise exception 'Loan #% advance differs from the verified amount; stop and review.', v_case.loan_no;
    end if;
    select * into strict v_payout from loan_disbursements
    where loan_id = v_loan.id and mode = 'upi' and paid_on = v_case.loan_date
      and (amount = v_case.payout or (v_case.loan_no = 230 and amount = 3400))
    for update;
    update loans set advance_mode = 'cash' where id = v_loan.id and advance_mode is distinct from 'cash';
    -- Only restores 3550 if the superseded 3400 correction was already applied.
    -- Never subtract the retained advance a second time from the actual payout.
    update loan_disbursements set amount = v_case.payout where id = v_payout.id and amount <> v_case.payout;
  end loop;
end;
$$;
select party, kind, mode, amount, entry_date from ledger
  where ref_id in ('7f21da59-87a6-41fd-9db9-03cbd100b1dd', 'f0e89833-3633-44bd-8291-fb3d1f89f861')
    and kind in ('loan_advance', 'loan_advance_cut', 'disbursement')
  order by kind, mode, amount;
select entry_date, advances_kept, total_in, total_out, closing_balance
  from daily_cashflow where entry_date in ('2026-10-16', '2026-10-17') order by entry_date;
commit;
