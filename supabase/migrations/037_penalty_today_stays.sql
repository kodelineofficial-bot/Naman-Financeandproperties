-- =====================================================================
--  037 — Penalty showing today stays too
--
--  036 saved the penalty days showing before a payment, except today's
--  when the payment was dated today ("pay on day 3 → no penalty"). So
--  paying the overdue took one day back. NETRPAL VIRENDER #123 (₹50/day):
--  ₹550 in the morning of 24 Oct, ₹600 paid dated today → ₹500.
--
--  Now every penalty day showing at that moment is saved, today included:
--  day 3 shows ₹90, he pays that day → still ₹90; day 6 shows ₹180 → still
--  ₹180. A payment still ends the run: no new days after it. Only the owner
--  lowers penalty: Take penalty / Waive / Edit penalty (or reset / penalty off).
--
--  Changed: keep_penalty_days_at (p_paid_on no longer used, kept for the trigger)
--  Rebuild: payments entered under 036 replayed (9 loans, one day each:
--           JAGMOHAN #54 #55, MANISH RAILWAY #85, AKASH JITTU KULLI #10,
--           RANJIT HOTEL #132, ANKIT KAPIL #17 — 22 Oct; SUSHILA SETHANI #157
--           — 23 Oct; SURENDER RAHUL SAVITRI #116, NETRPAL VIRENDER #123 — 24 Oct)
-- =====================================================================

begin;

create or replace function public.keep_penalty_days_at(p_loan uuid, p_at timestamptz, p_paid_on date)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.loan_penalty_held (loan_id, d, held_at)
  select x.loan_id, x.d, p_at
  from public.penalty_late_days_at(p_loan, p_at) x
  where x.is_late
  on conflict do nothing
$$;
revoke execute on function public.keep_penalty_days_at(uuid, timestamptz, date) from public, anon, authenticated;

-- Rebuild: replay the payments entered under the current rules, in the order
-- they were entered (as each was about to be saved).
do $$
declare r record;
begin
  for r in
    select loan_id, created_at, min(paid_on) as paid_on
    from public.loan_repayments
    where created_at >= '2026-10-21 14:05+00'
    group by loan_id, created_at
    order by created_at
  loop
    perform public.keep_penalty_days_at(r.loan_id, r.created_at, r.paid_on);
  end loop;
end $$;

commit;
