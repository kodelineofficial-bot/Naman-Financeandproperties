-- Run with migrations up to 038 applied. Fixtures and all changes are rolled back.
begin;
select set_config('request.jwt.claim.sub', (select user_id::text from public.admins limit 1), true);
set local role authenticated;

create function pg_temp.check_true(ok boolean, description text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %', description; end if;
end;
$$;

create function pg_temp.cash() returns text language sql as $$
  select md5(coalesce(string_agg(entry_date || ':' || opening_balance || ':' || closing_balance, '|' order by entry_date), ''))
  from public.daily_cashflow
$$;

create function pg_temp.new_loan(b uuid, total numeric, given numeric) returns uuid language plpgsql as $$
declare l uuid;
begin
  insert into public.loans (borrower_id, principal, total_repayable, daily_installment, duration_days, loan_date, collection_start_date)
    values (b, given, total, 100, ceil(total / 100)::int, '2026-01-01', '2026-01-02') returning id into l;
  insert into public.loan_disbursements (loan_id, amount, paid_on, mode, note) values (l, given, '2026-01-01', 'cash', 'Given');
  return l;
end;
$$;

do $$
declare
  b uuid;
  x uuid;
  old_l uuid;
  new_l uuid;
  run_l uuid;
  z uuid;
  del uuid;
  cash_before text;
  cash_after text;
  preview jsonb;
  closing_before numeric;
  no_before bigint;
  stamp date;
begin
  insert into public.borrowers (name) values ('Delete test') returning id into b;

  -- keep_money: hidden, cash the same, labelled, restorable
  x := pg_temp.new_loan(b, 12000, 10000);
  insert into public.loan_repayments (loan_id, amount, paid_on, mode) values (x, 4000, '2026-02-01', 'cash'), (x, 2700, '2026-02-02', 'cash');
  cash_before := pg_temp.cash();
  del := public.delete_loan(x, 'keep_money');
  perform pg_temp.check_true(pg_temp.cash() = cash_before, 'keep_money: cash does not move');
  perform pg_temp.check_true(not exists (select 1 from public.loan_summary where id = x), 'keep_money: hidden from loan_summary');
  perform pg_temp.check_true(not exists (select 1 from public.collection_sheet('2026-02-01') c where c.id = x), 'keep_money: hidden from collection sheet');
  perform pg_temp.check_true((select count(*) = 3 from public.ledger where ref_id = x and party like '% (deleted)'), 'keep_money: entries stay labelled');
  perform pg_temp.check_true((select (summary->>'collected_total')::numeric = 6700 from public.loan_deletions where id = del), 'keep_money: paid is saved');
  perform public.restore_loan(del);
  perform pg_temp.check_true(exists (select 1 from public.loan_summary where id = x), 'keep_money: restored');
  perform pg_temp.check_true(pg_temp.cash() = cash_before, 'keep_money: cash same after restore');
  perform pg_temp.check_true(not exists (select 1 from public.ledger where ref_id = x and party like '% (deleted)'), 'keep_money: label gone after restore');

  -- preview leaves nothing behind and matches what undo does
  preview := public.loan_delete_preview(x);
  perform pg_temp.check_true(exists (select 1 from public.loans where id = x), 'preview: loan still there');
  perform pg_temp.check_true(pg_temp.cash() = cash_before, 'preview: cash same');
  perform pg_temp.check_true((preview->>'total')::numeric = 10000 - 6700, 'preview: total is payout minus payments');

  -- undo: gone, cash moves by the preview, restore brings all of it back
  closing_before := (select closing_balance from public.daily_cashflow order by entry_date desc limit 1);
  no_before := (select loan_no from public.loans where id = x);
  del := public.delete_loan(x, 'undo');
  perform pg_temp.check_true(not exists (select 1 from public.loans where id = x), 'undo: loan gone');
  perform pg_temp.check_true(not exists (select 1 from public.loan_repayments where loan_id = x), 'undo: entries gone');
  perform pg_temp.check_true(pg_temp.cash() <> cash_before, 'undo: cash moved');
  perform public.restore_loan(del);
  perform pg_temp.check_true(pg_temp.cash() = cash_before, 'undo: cash back after restore');
  perform pg_temp.check_true((select loan_no = no_before and status = 'active' from public.loans where id = x), 'undo: same loan number and status');
  perform pg_temp.check_true((select count(*) = 2 from public.loan_repayments where loan_id = x), 'undo: entries back');

  -- renewal: undo runs the old loan again, restore renews it again
  old_l := pg_temp.new_loan(b, 1000, 800);
  new_l := pg_temp.new_loan(b, 2000, 500);
  update public.loan_disbursements set amount = 100 where loan_id = new_l;
  perform public.renew_loan(old_l, new_l, 300, '2026-03-01');
  perform pg_temp.check_true((select status = 'renewed' from public.loans where id = old_l), 'renewal: old loan renewed');
  cash_before := pg_temp.cash();
  del := public.delete_loan(new_l, 'undo');
  perform pg_temp.check_true((select status = 'active' from public.loans where id = old_l), 'renewal undo: old loan runs again');
  perform pg_temp.check_true(not exists (select 1 from public.loan_repayments where loan_id = old_l and mode = 'renewal'), 'renewal undo: adjustment gone');
  perform public.restore_loan(del);
  perform pg_temp.check_true((select status = 'renewed' from public.loans where id = old_l), 'renewal restore: old loan renewed again');
  perform pg_temp.check_true((select renewed_from = old_l from public.loans where id = new_l), 'renewal restore: link back');
  perform pg_temp.check_true(exists (select 1 from public.loan_repayments where loan_id = old_l and mode = 'renewal'), 'renewal restore: adjustment back');
  perform pg_temp.check_true(pg_temp.cash() = cash_before, 'renewal restore: cash same');

  -- renewal keep_money: the old loan stays renewed
  del := public.delete_loan(new_l, 'keep_money');
  perform pg_temp.check_true((select status = 'renewed' from public.loans where id = old_l), 'renewal keep: old loan stays renewed');
  perform pg_temp.check_true(pg_temp.cash() = cash_before, 'renewal keep: cash same');
  perform public.restore_loan(del);

  -- restore is refused when the old loan was renewed by something else
  del := public.delete_loan(new_l, 'undo');
  z := pg_temp.new_loan(b, 2000, 500);
  update public.loan_disbursements set amount = 100 where loan_id = z;
  perform public.renew_loan(old_l, z, 300, '2026-03-02');
  begin
    perform public.restore_loan(del);
    raise exception 'FAIL: restore should be refused';
  exception when others then
    perform pg_temp.check_true(sqlerrm like '%renewed again%', 'renewal restore refused: ' || sqlerrm);
  end;

  -- a cut on a running loan: undo puts the dues back, restore cuts them again
  run_l := pg_temp.new_loan(b, 1000, 800);
  x := pg_temp.new_loan(b, 2000, 500);
  update public.loan_disbursements set amount = 100 where loan_id = x;
  perform public.cut_dues_into_loan(run_l, x, 200, 0, '2026-03-05');
  perform pg_temp.check_true((select outstanding = 800 from public.loan_summary where id = run_l), 'cut: dues cut');
  cash_before := pg_temp.cash();
  del := public.delete_loan(x, 'undo');
  perform pg_temp.check_true((select outstanding = 1000 from public.loan_summary where id = run_l), 'cut undo: dues back');
  perform public.restore_loan(del);
  perform pg_temp.check_true((select outstanding = 800 from public.loan_summary where id = run_l), 'cut restore: dues cut again');
  perform pg_temp.check_true(pg_temp.cash() = cash_before, 'cut restore: cash same');

  -- defaulted loan comes back frozen on the same day, with nothing extra waived
  x := pg_temp.new_loan(b, 5000, 4000);
  insert into public.loan_repayments (loan_id, amount, paid_on, mode) values (x, 500, '2026-02-01', 'cash');
  update public.loans set status = 'defaulted' where id = x;
  update public.loans set defaulted_on = '2026-02-10', collection_start_date = '2026-01-05' where id = x;
  stamp := (select defaulted_on from public.loans where id = x);
  del := public.delete_loan(x, 'undo');
  perform public.restore_loan(del);
  perform pg_temp.check_true((select status = 'defaulted' and defaulted_on = stamp and collection_start_date = '2026-01-05' from public.loans where id = x), 'defaulted restore: frozen as before');
  perform pg_temp.check_true(not exists (select 1 from public.loan_penalty_entries where loan_id = x), 'defaulted restore: nothing extra waived');

  -- closed loan comes back closed
  x := pg_temp.new_loan(b, 1000, 900);
  insert into public.loan_repayments (loan_id, amount, paid_on, mode) values (x, 400, '2026-02-01', 'cash'), (x, 600, '2026-02-05', 'cash');
  perform pg_temp.check_true((select status = 'closed' from public.loans where id = x), 'closed: closed itself');
  del := public.delete_loan(x, 'undo');
  perform public.restore_loan(del);
  perform pg_temp.check_true((select status = 'closed' and closed_on = '2026-02-05' from public.loans where id = x), 'closed restore: still closed');

  -- nothing restores twice, nothing deletes twice
  begin
    perform public.restore_loan(del);
    raise exception 'FAIL: restored twice';
  exception when others then
    perform pg_temp.check_true(sqlerrm like '%already restored%', 'second restore refused: ' || sqlerrm);
  end;
  perform public.delete_loan(x, 'keep_money');
  begin
    perform public.delete_loan(x, 'keep_money');
    raise exception 'FAIL: deleted twice';
  exception when others then
    perform pg_temp.check_true(sqlerrm like '%already deleted%', 'second delete refused: ' || sqlerrm);
  end;
end $$;

rollback;
