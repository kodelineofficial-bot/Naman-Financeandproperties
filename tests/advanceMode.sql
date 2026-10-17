-- Isolated test database only, with migrations 001-022 applied.
begin;
insert into auth.users (id) values ('00000000-0000-0000-0000-000000000021');
insert into admins (user_id, name) values ('00000000-0000-0000-0000-000000000021', 'Advance mode test');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
set local role authenticated;
do $$
declare
  b uuid;
  l uuid;
  p uuid;
  case_row record;
  cash_delta numeric;
  cash_before numeric;
  old_loan uuid;
begin
  update settings set opening_balance = 0, cash_start_date = null, penalty_enabled = false where id = 1;
  insert into borrowers (name) values ('Advance modes fixture') returning id into b;
  for case_row in select * from (values
    ('cash', 'cash', 3700, -3550),
    ('cash', 'upi', 3700, -3700),
    ('upi', 'cash', 3550, 0),
    ('upi', 'upi', 3550, 0)
  ) as cases(payout_mode, advance_mode, book_out, cash_net) loop
    insert into loans (borrower_id, principal, total_repayable, daily_installment, duration_days, advance_amount, advance_days, advance_mode, loan_date, collection_start_date)
      values (b, 5000, 6000, 150, 40, 150, 1, case_row.advance_mode, '2026-10-17', '2026-10-17') returning id into l;
    insert into loan_disbursements (loan_id, paid_on, amount, mode)
      values (l, '2026-10-17', 3550, case_row.payout_mode) returning id into p;
    if not exists (select 1 from ledger where id = p and amount = case_row.book_out and kind = 'disbursement') then
      raise exception 'Wrong book out for % payout / % advance', case_row.payout_mode, case_row.advance_mode;
    end if;
    if not exists (select 1 from ledger where ref_id = l and kind = 'loan_advance' and amount = 150 and mode = case_row.advance_mode) then
      raise exception 'Wrong advance receipt mode';
    end if;
    if case_row.payout_mode = 'upi' and not exists (select 1 from ledger where ref_id = l and kind = 'loan_advance_cut' and amount = 150 and mode = case_row.advance_mode) then
      raise exception 'UPI-funded advance needs its matching cut';
    end if;
    if case_row.payout_mode = 'cash' and exists (select 1 from ledger where ref_id = l and kind = 'loan_advance_cut') then
      raise exception 'Cash gross out already includes the advance; extra cut would duplicate it';
    end if;
    select sum(case when mode = 'upi' then 0 when direction = 'in' then amount else -amount end)
      into cash_delta from ledger where ref_id = l;
    if cash_delta <> case_row.cash_net then raise exception 'Wrong cash delta: %', cash_delta; end if;
    -- Adding another payout must not duplicate the advance or add it to UPI.
    insert into loan_disbursements (loan_id, paid_on, amount, mode) values (l, '2026-10-17', 100, 'upi');
    if (select count(*) from ledger where ref_id = l and kind = 'loan_advance') <> 1 then raise exception 'Duplicate advance'; end if;
    if case_row.payout_mode = 'upi' and (select count(*) from ledger where ref_id = l and kind = 'loan_advance_cut') <> 1 then raise exception 'Duplicate advance cut'; end if;
  end loop;

  -- Historical advance modes continue following the first payout until edited.
  update loans set advance_mode = null where id = l;
  if not exists (select 1 from ledger where ref_id = l and kind = 'loan_advance' and mode = 'upi') then
    raise exception 'Historical UPI advance mode was lost';
  end if;
  -- Edit mode without changing repayments, total, or advance amount.
  select closing_balance into cash_before from daily_cashflow where entry_date = '2026-10-17';
  perform edit_loan_terms(l, '{"advance_mode":"cash"}',
    (select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'original_amount', amount)) from loan_disbursements where loan_id = l),
    (select updated_at from loans where id = l));
  if not exists (select 1 from ledger where ref_id = l and kind = 'loan_advance' and mode = 'cash' and amount = 150) then
    raise exception 'Editing advance mode did not update income';
  end if;
  if not exists (select 1 from daily_cashflow where entry_date = '2026-10-17' and closing_balance = cash_before) then
    raise exception 'Changing a retained advance to Cash must change both cut and income, without extra cash';
  end if;
  if not exists (select 1 from loan_summary where id = l and collected_total = 150 and total_repayable = 6000) then
    raise exception 'Changing advance mode changed loan collections';
  end if;
  begin
    update loans set advance_mode = 'invalid' where id = l;
    raise exception 'Invalid advance mode accepted';
  exception when check_violation then null;
  end;

  -- Full renewal keeps adjustments intact and uses the independently chosen advance mode.
  insert into loans (borrower_id, principal, total_repayable, daily_installment, duration_days, loan_date, collection_start_date)
    values (b, 1000, 1000, 10, 100, '2026-10-01', '2026-10-01') returning id into old_loan;
  insert into loans (borrower_id, principal, total_repayable, daily_installment, duration_days, advance_amount, advance_days, advance_mode, loan_date, collection_start_date)
    values (b, 5000, 6000, 150, 40, 150, 1, 'cash', '2026-10-17', '2026-10-17') returning id into l;
  perform renew_loan(old_loan, l, 1000, '2026-10-17');
  insert into loan_disbursements (loan_id, paid_on, amount, mode) values (l, '2026-10-17', 3550, 'upi') returning id into p;
  if not exists (select 1 from ledger where id = p and kind = 'disbursement' and amount = 3550 and mode = 'upi') then raise exception 'Renewal UPI wrong'; end if;
  if not exists (select 1 from ledger where ref_id = l and kind = 'loan_advance' and amount = 150 and mode = 'cash') then raise exception 'Renewal advance mode wrong'; end if;
  if not exists (select 1 from ledger where ref_id = l and kind = 'loan_advance_cut' and amount = 150 and mode = 'cash') then raise exception 'Renewal advance cut missing'; end if;
  if not exists (select 1 from loans where id = old_loan and status = 'renewed') then raise exception 'Renewal link broken'; end if;

  if (select total_in - total_out from daily_cashflow where entry_date = '2026-10-17') <>
     (select net from monthly_cashflow where month = '2026-10-01') then raise exception 'Daily/monthly cashflow disagree'; end if;
  raise notice 'PASS: Cash/UPI matrix, cash income, actual UPI amounts, multiple payouts, legacy loans, mode edits, renewal and reports';
end;
$$;
rollback;
