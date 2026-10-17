-- Run only against an isolated test database with migrations 001-021 applied:
-- psql -v ON_ERROR_STOP=1 -f tests/loanEdits.sql
-- Fixtures and all changes are rolled back.
begin;
insert into auth.users (id) values ('00000000-0000-0000-0000-000000000020');
insert into public.admins (user_id, name) values ('00000000-0000-0000-0000-000000000020', 'Loan sync test');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000020', true);
set local role authenticated;

create function pg_temp.check_true(ok boolean, description text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %', description; end if;
end;
$$;

create function pg_temp.save_terms(loan_id uuid, terms jsonb, payout_amount numeric default null)
returns uuid language sql as $$
  select public.edit_loan_terms(loan_id, terms,
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', coalesce(payout_amount, amount), 'original_amount', amount))
      from public.loan_disbursements where loan_disbursements.loan_id = $1 and mode not in ('renewal', 'opening')), '[]'::jsonb),
    (select updated_at from public.loans where id = loan_id));
$$;

do $$
declare
  b uuid;
  l uuid;
  other_loan uuid;
  payout_id uuid;
  original_stamp timestamptz;
  cash_before numeric;
  rep_id uuid;
  bad_payouts jsonb;
begin
  update settings set opening_balance = 0, cash_start_date = null, penalty_enabled = false where id = 1;
  insert into borrowers (name) values ('Karan office — regression fixture') returning id into b;
  insert into loans (borrower_id, principal, total_repayable, daily_installment, duration_days, loan_date, collection_start_date)
    values (b, 2550, 2700, 30, 90, '2026-01-01', '2026-01-01') returning id into l;
  insert into loan_disbursements (loan_id, amount, paid_on, mode, note)
    values (l, 2550, '2026-01-01', 'cash', 'Given at loan creation') returning id into payout_id;
  insert into loan_repayments (loan_id, amount, paid_on) values (l, 60, '2026-01-02') returning id into rep_id;
  select closing_balance into cash_before from daily_cashflow order by entry_date desc limit 1;

  perform pg_temp.save_terms(l, '{"principal":2450,"duration_days":100,"total_repayable":3000}', 2450);
  perform pg_temp.check_true((select duration_days = 100 and expected_end_date = '2026-04-10' and outstanding = 2940
    and disbursed = 2450 and pending_disbursement = 0 from loan_summary where id = l), '90 → 100 days updates loan summary and end date');
  perform pg_temp.check_true((select amount = 2450 and entry_date = '2026-01-01' from ledger where id = payout_id), 'original Day Book payout corrected 2550 → 2450');
  perform pg_temp.check_true((select total_out = 2450 from daily_cashflow where entry_date = '2026-01-01'), 'daily out corrected');
  perform pg_temp.check_true((select closing_balance = cash_before + 100 from daily_cashflow order by entry_date desc limit 1), 'cash balance increases by correction');
  perform pg_temp.check_true((select total_out = 2450 from monthly_cashflow where month = '2026-01-01'), 'monthly out corrected');
  perform pg_temp.check_true((select short_upto = 270 and balance_upto = 2940 and paid_till = '2026-01-02'
    from collection_sheet('2026-01-11') where id = l), 'collection sheet uses updated terms and original repayments');
  perform pg_temp.check_true((select amount = 60 from loan_repayments where id = rep_id), 'existing repayment unchanged');

  -- A correction to just the actual payout leaves an explicit pending balance.
  perform pg_temp.save_terms(l, '{}', 2400);
  perform pg_temp.check_true((select pending_disbursement = 50 from loan_summary where id = l), 'partial payout stays partial');
  perform pg_temp.save_terms(l, '{}', 2450);

  -- Failed edits cannot leave changed terms behind.
  begin
    perform pg_temp.save_terms(l, '{"notes":"must roll back","principal":2300}', 2450);
    raise exception 'Expected payout limit failure';
  exception when others then
    if sqlerrm not like 'Recorded payouts exceed%' then raise; end if;
  end;
  perform pg_temp.check_true((select principal = 2450 and notes is null from loans where id = l), 'invalid payout rolls back all terms');
  begin
    perform pg_temp.save_terms(l, '{"duration_days":101}');
    raise exception 'Expected inconsistent schedule failure';
  exception when others then
    if sqlerrm not like 'Duration must match%' then raise; end if;
  end;

  -- Reject changes from stale screens, including payouts modified elsewhere.
  select updated_at into original_stamp from loans where id = l;
  begin
    perform edit_loan_terms(l, '{}', '[]', original_stamp - interval '1 second');
    raise exception 'Expected stale loan failure';
  exception when others then
    if sqlerrm not like 'This loan changed%' then raise; end if;
  end;
  bad_payouts := jsonb_build_array(jsonb_build_object('id', payout_id, 'amount', 2450, 'original_amount', 2550));
  begin
    perform edit_loan_terms(l, '{}', bad_payouts, original_stamp);
    raise exception 'Expected stale payout failure';
  exception when others then
    if sqlerrm not like 'A payout changed%' then raise; end if;
  end;

  -- A fully paid loan reopens when its duration/total is extended.
  insert into loan_repayments (loan_id, amount, paid_on) values (l, 2940, '2026-01-03');
  perform pg_temp.check_true((select status = 'closed' from loans where id = l), 'fully paid loan closed');
  perform pg_temp.save_terms(l, '{"duration_days":110,"total_repayable":3300,"status":"closed"}');
  perform pg_temp.check_true((select status = 'active' and outstanding = 300 and closed_on is null from loan_summary where id = l), 'extended paid loan reopens');
  perform pg_temp.save_terms(l, '{"duration_days":100,"total_repayable":3000,"status":"active"}');
  perform pg_temp.check_true((select status = 'closed' from loans where id = l), 'lowered total automatically closes paid loan');

  -- Partial final installments and monthly dates agree with the calendar math.
  perform pg_temp.save_terms(l, '{"duration_days":101,"total_repayable":3005}');
  perform pg_temp.check_true((select expected_end_date = '2026-04-11' and outstanding = 5 from loan_summary where id = l), 'partial final installment retained');
  perform pg_temp.save_terms(l, '{"frequency":"monthly","duration_days":18,"daily_installment":200,"total_repayable":3600,"collection_start_date":"2026-01-31"}');
  perform pg_temp.check_true((select expected_end_date = '2027-06-30' and duration_days = 18 from loan_summary where id = l), 'monthly end date correct');

  -- Advance remains a separate income row; gross out minus advance is actual cash.
  perform pg_temp.save_terms(l, '{"advance_days":1,"advance_amount":200}', 2250);
  perform pg_temp.check_true((select amount = 2450 from ledger where id = payout_id and kind = 'disbursement'), 'gross disbursement includes advance');
  perform pg_temp.check_true((select amount = 200 from ledger where ref_id = l and kind = 'loan_advance'), 'advance income synced');
  perform pg_temp.check_true((select closing_balance = 750 from daily_cashflow order by entry_date desc limit 1), 'advance correction updates net cash');

  -- UPI payout correction is visible without affecting physical cash.
  update loan_disbursements set mode = 'upi' where id = payout_id;
  select closing_balance into cash_before from daily_cashflow order by entry_date desc limit 1;
  perform pg_temp.save_terms(l, '{}', 2200);
  perform pg_temp.check_true((select amount = 2200 from ledger where id = payout_id), 'UPI ledger shows the actual transfer without advance');
  perform pg_temp.check_true((select closing_balance = cash_before from daily_cashflow order by entry_date desc limit 1), 'UPI stays excluded from cash');

  -- Protected old-loan adjustments cannot be edited as actual payouts.
  insert into loans (borrower_id, principal, total_repayable, daily_installment, duration_days, loan_date, collection_start_date)
    values (b, 1000, 1000, 10, 100, '2026-01-01', '2026-01-01') returning id into other_loan;
  insert into loan_disbursements (loan_id, amount, mode, paid_on) values (other_loan, 500, 'renewal', '2026-01-01');
  insert into loan_disbursements (loan_id, amount, mode, paid_on) values (other_loan, 500, 'cash', '2026-01-01');
  perform pg_temp.save_terms(other_loan, '{"principal":900}', 400);
  perform pg_temp.check_true((select amount = 500 from loan_disbursements where loan_id = other_loan and mode = 'renewal'), 'renewal amount unchanged');
  insert into loan_disbursements (loan_id, amount, mode, paid_on) values (other_loan, 100, 'cash', '2026-01-02');
  perform pg_temp.save_terms(other_loan, '{"principal":950}', 200);
  perform pg_temp.check_true((select disbursed = 900 and pending_disbursement = 50 from loan_summary where id = other_loan), 'multiple payouts corrected while adjustment stays fixed');
  bad_payouts := (select jsonb_agg(jsonb_build_object('id', id, 'amount', 100, 'original_amount', amount)) from loan_disbursements where loan_id = other_loan);
  begin
    perform edit_loan_terms(other_loan, '{}', bad_payouts, (select updated_at from loans where id = other_loan));
    raise exception 'Expected protected adjustment failure';
  exception when others then
    if sqlerrm not like 'Payouts changed%' then raise; end if;
  end;
  raise notice 'PASS: loan summary, Day Book, daily/monthly cashflow, collections, status, atomic validation, stale edits, advances, UPI, multiple payouts and renewal protection';
end;
$$;

-- A signed-in user outside admins cannot call the edit endpoint.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
do $$
begin
  begin
    perform edit_loan_terms(gen_random_uuid(), '{}', '[]', now());
    raise exception 'Expected authorization failure';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: non-admin edits rejected';
end;
$$;
rollback;
