-- =====================================================================
--  038: Deleting a loan no longer changes old cash by accident
--
--  Before: delete erased the loan and all its entries, so every opening and
--  closing after them moved, with no way back (loan #171, 30 Oct).
--
--  Now every delete goes through delete_loan and is written to loan_deletions
--  with a full copy of the loan and its entries:
--   keep_money  the loan is hidden (loans.deleted_at): gone from lists, the
--               collection sheet and dues totals. Its entries stay in the
--               ledger as "Loan #171 — NAME (deleted)", so cash does not move.
--   undo        entered by mistake: the loan and its entries are removed as
--               before, including cuts on other loans and the renewal of the
--               old loan. Cash changes; loan_delete_preview says by how much.
--  restore_loan brings either kind back.
--
--  Changed: ledger (label), loan_summary and collection_sheet (hide)
--  New: loans.deleted_at, loan_deletions, loan_delete_preview, delete_loan,
--       restore_loan
-- =====================================================================

begin;

alter table public.loans add column if not exists deleted_at timestamptz;

create table if not exists public.loan_deletions (
  id            uuid primary key default gen_random_uuid(),
  loan_id       uuid not null,   -- no foreign key: after undo the loan row is gone
  loan_no       bigint not null,
  borrower_id   uuid not null,
  borrower_name text not null,
  mode          text not null check (mode in ('keep_money', 'undo')),
  summary       jsonb not null,  -- the loan_summary row when it was deleted
  snapshot      jsonb not null,  -- the loan and every entry that goes with it
  deleted_at    timestamptz not null default now(),
  deleted_by    uuid default auth.uid(),
  restored_at   timestamptz
);
create unique index if not exists loan_deletions_one_open
  on public.loan_deletions (loan_id) where restored_at is null;
alter table public.loan_deletions enable row level security;
drop policy if exists admin_all on public.loan_deletions;
create policy admin_all on public.loan_deletions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'loan_deletions') then
    alter publication supabase_realtime add table public.loan_deletions;
  end if;
end $$;

create or replace view public.ledger
with (security_invoker = on) as
WITH cash_disb AS (
         SELECT ld.id,
            ld.loan_id,
            ld.paid_on,
            ld.amount,
            ld.mode,
            ld.note,
            ld.created_at,
            row_number() OVER (PARTITION BY ld.loan_id ORDER BY ld.paid_on, ld.created_at, ld.id) AS rn
           FROM loan_disbursements ld
          WHERE ld.mode <> ALL (ARRAY['renewal'::text, 'opening'::text])
        ), adjusted AS (
         SELECT lr.id,
            lr.loan_id,
            lr.paid_on,
            lr.amount,
            lr.mode,
            lr.note,
            lr.created_at,
            lr.adjusted_into,
            lr.cut_disb_id,
            COALESCE(lr.adjusted_into, nl.id) AS new_loan_id
           FROM loan_repayments lr
             LEFT JOIN LATERAL ( SELECT n.id
                   FROM loans n
                  WHERE n.renewed_from = lr.loan_id
                  ORDER BY n.created_at DESC
                 LIMIT 1) nl ON lr.adjusted_into IS NULL
          WHERE lr.mode = 'renewal'::text
        ), orphan_cut AS (
         SELECT ld.id,
            ld.loan_id,
            ld.paid_on,
            ld.amount,
            ld.mode,
            ld.note,
            ld.created_at
           FROM loan_disbursements ld
          WHERE ld.mode = 'renewal'::text AND NOT (EXISTS ( SELECT 1
                   FROM adjusted a
                  WHERE a.cut_disb_id = ld.id)) AND NOT (EXISTS ( SELECT 1
                   FROM loan_penalty_entries pe
                  WHERE pe.cut_disb_id = ld.id)) AND NOT (EXISTS ( SELECT 1
                   FROM adjusted a
                  WHERE a.cut_disb_id IS NULL AND a.new_loan_id = ld.loan_id AND a.paid_on = ld.paid_on AND a.amount = ld.amount))
        )
 SELECT ld.id,
    ld.paid_on AS entry_date,
    'disbursement'::text AS kind,
    'out'::text AS direction,
    (ld.amount +
        CASE
            WHEN ld.rn = 1 AND ld.mode <> 'upi'::text THEN l.advance_amount
            ELSE 0::numeric
        END)::numeric(14,2) AS amount,
    ld.mode,
    (('Loan #'::text || l.loan_no) || ' — '::text) || b.name
        || CASE WHEN l.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    ld.note,
    l.id AS ref_id,
    ld.created_at
   FROM cash_disb ld
     JOIN loans l ON l.id = ld.loan_id
     JOIN borrowers b ON b.id = l.borrower_id
UNION ALL
 SELECT l.id,
    ld.paid_on AS entry_date,
    'loan_advance'::text AS kind,
    'in'::text AS direction,
    l.advance_amount AS amount,
    COALESCE(l.advance_mode, ld.mode) AS mode,
    (('Loan #'::text || l.loan_no) || ' — '::text) || b.name
        || CASE WHEN l.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    ('Advance '::text || l.advance_days) || ' days kept from loan'::text AS note,
    l.id AS ref_id,
    ld.created_at
   FROM cash_disb ld
     JOIN loans l ON l.id = ld.loan_id
     JOIN borrowers b ON b.id = l.borrower_id
  WHERE ld.rn = 1 AND l.advance_amount > 0::numeric
UNION ALL
 SELECT l.id,
    ld.paid_on AS entry_date,
    'loan_advance_cut'::text AS kind,
    'out'::text AS direction,
    l.advance_amount AS amount,
    COALESCE(l.advance_mode, ld.mode) AS mode,
    (('Loan #'::text || l.loan_no) || ' — '::text) || b.name
        || CASE WHEN l.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    'Advance deducted before payout (not an additional transfer)'::text AS note,
    l.id AS ref_id,
    ld.created_at
   FROM cash_disb ld
     JOIN loans l ON l.id = ld.loan_id
     JOIN borrowers b ON b.id = l.borrower_id
  WHERE ld.rn = 1 AND ld.mode = 'upi'::text AND l.advance_amount > 0::numeric
UNION ALL
 SELECT lr.id,
    lr.paid_on AS entry_date,
    'collection'::text AS kind,
    'in'::text AS direction,
    lr.amount,
    lr.mode,
    (('Loan #'::text || l.loan_no) || ' — '::text) || b.name
        || CASE WHEN l.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    lr.note,
    l.id AS ref_id,
    lr.created_at
   FROM loan_repayments lr
     JOIN loans l ON l.id = lr.loan_id
     JOIN borrowers b ON b.id = l.borrower_id
  WHERE lr.mode <> ALL (ARRAY['renewal'::text, 'waiver'::text])
UNION ALL
 SELECT a.id,
    a.paid_on AS entry_date,
        CASE
            WHEN a.adjusted_into = a.loan_id THEN 'loan_advance'::text
            ELSE 'collection'::text
        END AS kind,
    'in'::text AS direction,
    a.amount,
    a.mode,
    (('Loan #'::text || l.loan_no) || ' — '::text) || b.name
        || CASE WHEN l.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    a.note,
    l.id AS ref_id,
    a.created_at
   FROM adjusted a
     JOIN loans l ON l.id = a.loan_id
     JOIN borrowers b ON b.id = l.borrower_id
  WHERE a.new_loan_id IS NOT NULL
UNION ALL
 SELECT a.id,
    a.paid_on AS entry_date,
    'disbursement'::text AS kind,
    'out'::text AS direction,
    a.amount,
    a.mode,
    (('Loan #'::text || nl.loan_no) || ' — '::text) || b.name
        || CASE WHEN nl.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
        CASE
            WHEN a.adjusted_into = a.loan_id THEN a.note || ' (no cash)'::text
            ELSE (('Loan #'::text || l.loan_no) ||
            CASE
                WHEN l.borrower_id <> nl.borrower_id THEN ' — '::text || ob.name
                ELSE ''::text
            END) ||
            CASE
                WHEN a.adjusted_into IS NULL THEN ' balance adjusted'::text
                ELSE ' overdue cut'::text
            END
        END AS note,
    nl.id AS ref_id,
    a.created_at
   FROM adjusted a
     JOIN loans l ON l.id = a.loan_id
     JOIN borrowers ob ON ob.id = l.borrower_id
     JOIN loans nl ON nl.id = a.new_loan_id
     JOIN borrowers b ON b.id = nl.borrower_id
UNION ALL
 SELECT ld.id,
    ld.paid_on AS entry_date,
    'collection'::text AS kind,
    'in'::text AS direction,
    ld.amount,
    ld.mode,
    (('Loan #'::text || l.loan_no) || ' — '::text) || b.name
        || CASE WHEN l.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    ld.note || ' (old loan deleted, no cash)'::text AS note,
    l.id AS ref_id,
    ld.created_at
   FROM orphan_cut ld
     JOIN loans l ON l.id = ld.loan_id
     JOIN borrowers b ON b.id = l.borrower_id
UNION ALL
 SELECT ld.id,
    ld.paid_on AS entry_date,
    'disbursement'::text AS kind,
    'out'::text AS direction,
    ld.amount,
    ld.mode,
    (('Loan #'::text || l.loan_no) || ' — '::text) || b.name
        || CASE WHEN l.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    ld.note || ' (old loan deleted, no cash)'::text AS note,
    l.id AS ref_id,
    ld.created_at
   FROM orphan_cut ld
     JOIN loans l ON l.id = ld.loan_id
     JOIN borrowers b ON b.id = l.borrower_id
UNION ALL
 SELECT pe.id,
    pe.paid_on AS entry_date,
    'disbursement'::text AS kind,
    'out'::text AS direction,
    pe.amount,
    pe.mode,
    (('Loan #'::text || nl.loan_no) || ' — '::text) || b.name
        || CASE WHEN nl.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    (('Loan #'::text || l.loan_no) ||
        CASE
            WHEN l.borrower_id <> nl.borrower_id THEN ' — '::text || ob.name
            ELSE ''::text
        END) || ' penalty cut'::text AS note,
    nl.id AS ref_id,
    pe.created_at
   FROM loan_penalty_entries pe
     JOIN loan_disbursements cd ON cd.id = pe.cut_disb_id
     JOIN loans l ON l.id = pe.loan_id
     JOIN borrowers ob ON ob.id = l.borrower_id
     JOIN loans nl ON nl.id = cd.loan_id
     JOIN borrowers b ON b.id = nl.borrower_id
  WHERE pe.kind = 'paid'::text
UNION ALL
 SELECT e.id,
    e.spent_on AS entry_date,
    'expense'::text AS kind,
    'out'::text AS direction,
    e.amount,
    e.mode,
    e.category || COALESCE(' — '::text || NULLIF(e.paid_to, ''::text), ''::text) AS party,
    e.description AS note,
    NULL::uuid AS ref_id,
    e.created_at
   FROM expenses e
UNION ALL
 SELECT s.id,
    s.paid_on AS entry_date,
    'salary'::text AS kind,
    'out'::text AS direction,
    s.amount,
    s.mode,
    ((emp.name || ' (salary '::text) || to_char(s.salary_month::timestamp with time zone, 'Mon YYYY'::text)) || ')'::text AS party,
    s.note,
    emp.id AS ref_id,
    s.created_at
   FROM salary_payments s
     JOIN employees emp ON emp.id = s.employee_id
UNION ALL
 SELECT a.id,
    a.given_on AS entry_date,
    'employee_advance'::text AS kind,
    'out'::text AS direction,
    a.amount,
    a.mode,
    ((emp.name || ' ('::text) || a.kind) || ')'::text AS party,
    a.note,
    emp.id AS ref_id,
    a.created_at
   FROM employee_advances a
     JOIN employees emp ON emp.id = a.employee_id
UNION ALL
 SELECT c.id,
    c.entry_date,
        CASE
            WHEN c.direction = 'in'::text THEN 'capital_in'::text
            ELSE 'capital_out'::text
        END AS kind,
    c.direction,
    c.amount,
    c.mode,
    COALESCE(c.party, ''::text) AS party,
    c.description AS note,
    NULL::uuid AS ref_id,
    c.created_at
   FROM cash_entries c
UNION ALL
 SELECT pe.id,
    pe.paid_on AS entry_date,
    'penalty'::text AS kind,
    'in'::text AS direction,
    pe.amount,
    pe.mode,
    (('Loan #'::text || l.loan_no) || ' — '::text) || b.name
        || CASE WHEN l.deleted_at IS NOT NULL THEN ' (deleted)'::text ELSE ''::text END AS party,
    pe.note,
    l.id AS ref_id,
    pe.created_at
   FROM loan_penalty_entries pe
     JOIN loans l ON l.id = pe.loan_id
     JOIN borrowers b ON b.id = l.borrower_id
  WHERE pe.kind = 'paid'::text;

create or replace view public.loan_summary
with (security_invoker = on) as
WITH d AS (
         SELECT loan_disbursements.loan_id,
            sum(loan_disbursements.amount) AS disbursed,
            max(loan_disbursements.paid_on) AS last_disbursed_on
           FROM loan_disbursements
          GROUP BY loan_disbursements.loan_id
        ), r AS (
         SELECT loan_repayments.loan_id,
            sum(loan_repayments.amount) AS collected,
            max(loan_repayments.paid_on) AS last_paid_on,
            count(*) AS payment_count,
            sum(loan_repayments.amount) FILTER (WHERE loan_repayments.paid_on = today_ist() AND (loan_repayments.mode <> ALL (ARRAY['renewal'::text, 'waiver'::text]))) AS paid_today,
            sum(loan_repayments.amount) FILTER (WHERE loan_repayments.mode = 'waiver'::text) AS forgiven
           FROM loan_repayments
          GROUP BY loan_repayments.loan_id
        ), pn AS MATERIALIZED (
         SELECT loan_penalty.loan_id,
            loan_penalty.penalty_days,
            loan_penalty.penalty_rate,
            loan_penalty.penalty_charged,
            loan_penalty.penalty_paid,
            loan_penalty.penalty_waived,
            loan_penalty.penalty_due,
            loan_penalty.penalty_opening,
            loan_penalty.penalty_added
           FROM loan_penalty
        ), base AS (
         SELECT l.id,
            l.loan_no,
            l.borrower_id,
            l.principal,
            l.interest_pct,
            l.interest_amount,
            l.markup_pct,
            l.total_repayable,
            l.daily_installment,
            l.duration_days,
            l.advance_days,
            l.advance_amount,
            l.net_disbursable,
            l.loan_date,
            l.collection_start_date,
            l.status,
            l.closed_on,
            l.notes,
            l.created_at,
            l.updated_at,
            b.name AS borrower_name,
            b.phone AS borrower_phone,
            b.occupation AS borrower_occupation,
            b.address AS borrower_address,
            COALESCE(d.disbursed, 0::numeric) AS disbursed,
            d.last_disbursed_on,
            COALESCE(r.collected, 0::numeric) AS collected_cash,
            COALESCE(r.collected, 0::numeric) + l.advance_amount AS collected_total,
            r.last_paid_on,
            COALESCE(r.payment_count, 0::bigint) AS payment_count,
            COALESCE(r.paid_today, 0::numeric) AS paid_today,
            periods_due(l.frequency, l.collection_start_date,
                CASE
                    WHEN l.status = 'defaulted'::text AND l.defaulted_on IS NOT NULL THEN LEAST(today_ist(), l.defaulted_on - 1)
                    ELSE today_ist()
                END) AS days_elapsed,
            l.penalty_off,
            l.frequency,
            l.defaulted_on,
            l.paused_days,
            l.old_defaulter,
            COALESCE(r.forgiven, 0::numeric) AS forgiven
           FROM loans l
             JOIN borrowers b ON b.id = l.borrower_id
             LEFT JOIN d ON d.loan_id = l.id
             LEFT JOIN r ON r.loan_id = l.id
          WHERE l.deleted_at IS NULL
        )
 SELECT base.id,
    base.loan_no,
    base.borrower_id,
    base.principal,
    base.interest_pct,
    base.interest_amount,
    base.markup_pct,
    base.total_repayable,
    base.daily_installment,
    base.duration_days,
    base.advance_days,
    base.advance_amount,
    base.net_disbursable,
    base.loan_date,
    base.collection_start_date,
    base.status,
    base.closed_on,
    base.notes,
    base.created_at,
    base.updated_at,
    base.borrower_name,
    base.borrower_phone,
    base.borrower_occupation,
    base.borrower_address,
    base.disbursed,
    base.last_disbursed_on,
    base.collected_cash,
    base.collected_total,
    base.last_paid_on,
    base.payment_count,
    base.paid_today,
    base.days_elapsed,
    base.net_disbursable - base.disbursed AS pending_disbursement,
    GREATEST(base.total_repayable - base.collected_total, 0::numeric) AS outstanding,
    LEAST(base.total_repayable, base.days_elapsed::numeric * base.daily_installment) AS expected_till_today,
        CASE
            WHEN base.status = ANY (ARRAY['active'::text, 'defaulted'::text]) THEN GREATEST(LEAST(base.total_repayable, base.days_elapsed::numeric * base.daily_installment) - base.collected_total, 0::numeric)
            ELSE 0::numeric
        END AS overdue,
    period_date(base.frequency, base.collection_start_date, ceil(GREATEST(base.total_repayable, 0::numeric) / base.daily_installment)::integer) AS expected_end_date,
    ceil(GREATEST(base.total_repayable - base.collected_total, 0::numeric) / base.daily_installment)::integer AS installments_left,
    round(
        CASE
            WHEN base.total_repayable > 0::numeric THEN base.collected_total / base.total_repayable * 100::numeric
            ELSE 0::numeric
        END, 1) AS progress_pct,
    base.total_repayable - base.principal + base.interest_amount AS expected_profit,
    floor(base.collected_total / base.daily_installment)::integer AS days_covered,
    period_date(base.frequency, base.collection_start_date, floor(base.collected_total / base.daily_installment)::integer) AS paid_till,
    base.penalty_off,
    COALESCE(pn.penalty_days, 0) AS penalty_days,
    COALESCE(pn.penalty_rate, 0::numeric) AS penalty_rate,
    COALESCE(pn.penalty_charged, 0::numeric) AS penalty_charged,
    COALESCE(pn.penalty_paid, 0::numeric) AS penalty_paid,
    COALESCE(pn.penalty_waived, 0::numeric) AS penalty_waived,
    COALESCE(pn.penalty_due, 0::numeric) AS penalty_due,
    base.frequency,
        CASE
            WHEN base.status <> 'defaulted'::text AND base.days_elapsed < ceil(GREATEST(base.total_repayable, 0::numeric) / base.daily_installment)::integer THEN period_date(base.frequency, base.collection_start_date, base.days_elapsed + 1)
            ELSE NULL::date
        END AS next_due_date,
    base.defaulted_on,
    base.paused_days,
    base.old_defaulter,
    base.forgiven
   FROM base
     LEFT JOIN pn ON pn.loan_id = base.id;

create or replace function public.collection_sheet(p_date date)
returns table(id uuid, loan_no bigint, borrower_id uuid, borrower_name text, borrower_phone text, borrower_address text, status text, daily_installment numeric, collection_start_date date, to_collect numeric, collected_upto numeric, paid_on_date numeric, balance_upto numeric, paid_till date, short_upto numeric, outstanding numeric, advance_amount numeric, frequency text)
language sql
stable
set search_path to 'public'
as $function$
  select l.id, l.loan_no, b.id, b.name, b.phone, b.address, l.status,
         l.daily_installment, l.collection_start_date,
         (l.total_repayable - l.advance_amount) as to_collect,
         coalesce(r.upto, 0) as collected_upto,
         coalesce(r.on_date, 0) as paid_on_date,
         greatest(l.total_repayable - l.advance_amount - coalesce(r.upto, 0), 0) as balance_upto,
         public.period_date(l.frequency, l.collection_start_date,
                            floor((coalesce(r.upto, 0) + l.advance_amount) / l.daily_installment)::int) as paid_till,
         greatest(least(l.total_repayable,
                        public.periods_due(l.frequency, l.collection_start_date,
                          case when l.status = 'defaulted' and l.defaulted_on is not null
                               then least(p_date, l.defaulted_on - 1) else p_date end) * l.daily_installment)
                  - l.advance_amount - coalesce(r.upto, 0), 0) as short_upto,
         greatest(l.total_repayable - l.advance_amount - coalesce(r.total, 0), 0) as outstanding,
         l.advance_amount,
         l.frequency
  from loans l
  join borrowers b on b.id = l.borrower_id
  left join lateral (
    select sum(amount) filter (where paid_on <= p_date)                                      as upto,
           sum(amount) filter (where paid_on = p_date and mode not in ('renewal', 'waiver')) as on_date,
           sum(amount)                                                                       as total
    from loan_repayments x where x.loan_id = l.id
  ) r on true
  where l.deleted_at is null
    and l.collection_start_date <= p_date
    and l.loan_date <= p_date
    and (not l.old_defaulter or coalesce(r.on_date, 0) > 0)
    and (
      l.status in ('active', 'defaulted')
      or coalesce(r.on_date, 0) > 0
      or (l.status = 'closed' and l.closed_on >= p_date)
      or (l.status = 'renewed' and l.closed_on > p_date)
    )
  order by b.name, l.loan_no
$function$;

-- The loan and every row that leaves with it on undo: its own entries, cuts it
-- made on other loans, and the adjustment on the loan it renewed.
create or replace function public.loan_delete_snapshot(p_loan uuid)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $$
declare
  v_loan  loans%rowtype;
  v_disb  uuid[];
  v_reps  jsonb;
  v_pens  jsonb;
  v_note  text;
begin
  select * into v_loan from loans where id = p_loan;
  if not found then raise exception 'Loan not found'; end if;
  v_note := 'Adjusted in new loan #' || v_loan.loan_no;

  select coalesce(array_agg(id), '{}') into v_disb
    from loan_disbursements where loan_id = p_loan or cut_from = p_loan;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into v_reps
    from loan_repayments r
   where r.loan_id = p_loan or r.adjusted_into = p_loan or r.cut_disb_id = any (v_disb)
      or (r.loan_id = v_loan.renewed_from and r.mode = 'renewal' and r.adjusted_into is null and r.note = v_note);
  select coalesce(jsonb_agg(to_jsonb(p)), '[]') into v_pens
    from loan_penalty_entries p where p.loan_id = p_loan or p.cut_disb_id = any (v_disb);

  return jsonb_build_object(
    'loan', to_jsonb(v_loan),
    'borrower', (select to_jsonb(b) from borrowers b where b.id = v_loan.borrower_id),
    'disbursements', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from loan_disbursements d where d.id = any (v_disb)),
    'repayments', v_reps,
    'penalties', v_pens,
    'held', (select coalesce(jsonb_agg(to_jsonb(h)), '[]') from loan_penalty_held h where h.loan_id = p_loan),
    'kept', (select coalesce(jsonb_agg(to_jsonb(k)), '[]') from loan_penalty_kept k where k.loan_id = p_loan),
    'renewed_from_status', (select to_jsonb(o.status) from loans o where o.id = v_loan.renewed_from),
    'renewed_from_closed_on', (select to_jsonb(o.closed_on) from loans o where o.id = v_loan.renewed_from),
    'renewed_into', (select coalesce(jsonb_agg(n.id), '[]') from loans n where n.renewed_from = p_loan)
  );
end $$;

create or replace function public.loan_delete_erase(p_loan uuid, p_snapshot jsonb)
returns void
language plpgsql
set search_path to 'public'
as $$
declare
  v_other uuid;
begin
  -- the adjustment on the renewed loan has no foreign key to this loan
  delete from loan_repayments
   where id in (select (x->>'id')::uuid from jsonb_array_elements(p_snapshot->'repayments') x)
     and loan_id <> p_loan and cut_disb_id is null and adjusted_into is null;
  delete from loans where id = p_loan;

  for v_other in
    select distinct (x->>'loan_id')::uuid from jsonb_array_elements(p_snapshot->'repayments') x
    union select (p_snapshot->'loan'->>'renewed_from')::uuid
  loop
    if v_other is not null and v_other <> p_loan then
      perform recalc_loan_status(v_other);
    end if;
  end loop;
end $$;

-- What undo would do to cash, day by day. Does the erase, measures, rolls it back.
create or replace function public.loan_delete_preview(p_loan uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_before jsonb;
  v_after  jsonb;
  v_days   jsonb;
begin
  if auth.uid() is not null and not is_admin() then raise exception 'not allowed'; end if;
  select coalesce(jsonb_object_agg(entry_date, net), '{}') into v_before from (
    select entry_date, sum(case when direction = 'in' then amount else -amount end) as net
      from ledger where mode <> 'upi' group by entry_date) t;
  begin
    perform loan_delete_erase(p_loan, loan_delete_snapshot(p_loan));
    select coalesce(jsonb_object_agg(entry_date, net), '{}') into v_after from (
      select entry_date, sum(case when direction = 'in' then amount else -amount end) as net
        from ledger where mode <> 'upi' group by entry_date) t;
    raise exception 'preview only' using errcode = 'ZZ001';
  exception when sqlstate 'ZZ001' then
    null;
  end;
  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'change', change) order by d), '[]') into v_days from (
    select k as d, coalesce((v_after->>k)::numeric, 0) - coalesce((v_before->>k)::numeric, 0) as change
      from (select jsonb_object_keys(v_before) as k union select jsonb_object_keys(v_after)) keys
  ) t where change <> 0;
  return jsonb_build_object(
    'days', v_days,
    'total', (select coalesce(sum((x->>'change')::numeric), 0) from jsonb_array_elements(v_days) x));
end $$;

create or replace function public.delete_loan(p_loan uuid, p_mode text)
returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_loan     loans%rowtype;
  v_summary  jsonb;
  v_snapshot jsonb;
  v_who      text;
  v_id       uuid;
begin
  if auth.uid() is not null and not is_admin() then raise exception 'not allowed'; end if;
  if p_mode not in ('keep_money', 'undo') then raise exception 'Unknown delete type'; end if;
  select * into v_loan from loans where id = p_loan for update;
  if not found then raise exception 'Loan not found'; end if;
  if v_loan.deleted_at is not null then raise exception 'Loan #% is already deleted', v_loan.loan_no; end if;

  select to_jsonb(s) into v_summary from loan_summary s where s.id = p_loan;
  v_snapshot := loan_delete_snapshot(p_loan);
  select name into v_who from borrowers where id = v_loan.borrower_id;

  insert into loan_deletions (loan_id, loan_no, borrower_id, borrower_name, mode, summary, snapshot)
  values (p_loan, v_loan.loan_no, v_loan.borrower_id, v_who, p_mode, v_summary, v_snapshot)
  returning id into v_id;

  if p_mode = 'keep_money' then
    update loans set deleted_at = now() where id = p_loan;
  else
    perform loan_delete_erase(p_loan, v_snapshot);
  end if;
  return v_id;
end $$;

create or replace function public.restore_loan(p_deletion uuid)
returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_del   loan_deletions%rowtype;
  v_snap  jsonb;
  v_loan  uuid;
  v_old   loans%rowtype;
  v_old_id uuid;
  v_ins   text;
  v_upd   text;
  v_other uuid;
begin
  if auth.uid() is not null and not is_admin() then raise exception 'not allowed'; end if;
  select * into v_del from loan_deletions where id = p_deletion for update;
  if not found then raise exception 'Deleted loan not found'; end if;
  if v_del.restored_at is not null then raise exception 'Loan #% is already restored', v_del.loan_no; end if;
  v_snap := v_del.snapshot;
  v_loan := v_del.loan_id;

  if v_del.mode = 'keep_money' then
    update loans set deleted_at = null where id = v_loan;
    if not found then raise exception 'Loan #% no longer exists', v_del.loan_no; end if;
    update loan_deletions set restored_at = now() where id = p_deletion;
    return v_loan;
  end if;

  if exists (select 1 from loans where id = v_loan) then
    raise exception 'Loan #% already exists', v_del.loan_no;
  end if;

  -- every other loan it touched must still be there
  select x.other into v_other from (
    select (e->>'loan_id')::uuid as other from jsonb_array_elements(v_snap->'disbursements') e
    union select (e->>'loan_id')::uuid from jsonb_array_elements(v_snap->'repayments') e
    union select (e->>'loan_id')::uuid from jsonb_array_elements(v_snap->'penalties') e
    union select (e->>'cut_from')::uuid from jsonb_array_elements(v_snap->'disbursements') e
    union select (e->>'adjusted_into')::uuid from jsonb_array_elements(v_snap->'repayments') e
  ) x
  where x.other is not null and x.other <> v_loan
    and not exists (select 1 from loans o where o.id = x.other)
  limit 1;
  if v_other is not null then
    raise exception 'Loan #% cannot be restored: another loan it was linked to has been deleted', v_del.loan_no;
  end if;

  v_old_id := (v_snap->'loan'->>'renewed_from')::uuid;
  if v_old_id is not null then
    select * into v_old from loans where id = v_old_id for update;
    if not found then
      raise exception 'Loan #% cannot be restored: the loan it renewed has been deleted', v_del.loan_no;
    end if;
    if v_snap->>'renewed_from_status' = 'renewed' and v_old.status = 'renewed' then
      raise exception 'Loan #% cannot be restored: old loan #% has been renewed again', v_del.loan_no, v_old.loan_no;
    end if;
  end if;

  insert into borrowers select * from jsonb_populate_record(null::borrowers, v_snap->'borrower')
    on conflict (id) do nothing;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
         string_agg(quote_ident(column_name), ', ' order by ordinal_position)
           filter (where column_name not in ('id', 'loan_no', 'status'))
    into v_ins, v_upd
    from information_schema.columns
   where table_schema = 'public' and table_name = 'loans' and is_generated = 'NEVER';

  execute format('insert into loans (%s) overriding system value select %s from jsonb_populate_record(null::loans, $1)', v_ins, v_ins)
    using v_snap->'loan';

  insert into loan_disbursements select * from jsonb_populate_recordset(null::loan_disbursements, v_snap->'disbursements') on conflict (id) do nothing;
  insert into loan_repayments select * from jsonb_populate_recordset(null::loan_repayments, v_snap->'repayments') on conflict (id) do nothing;
  insert into loan_penalty_entries select * from jsonb_populate_recordset(null::loan_penalty_entries, v_snap->'penalties') on conflict (id) do nothing;

  -- Saving the entries re-ran the status triggers: put the loan back exactly as it was.
  update loans set status = v_snap->'loan'->>'status' where id = v_loan and status <> v_snap->'loan'->>'status';
  execute format('update loans t set (%s) = (select %s from jsonb_populate_record(null::loans, $1)) where t.id = $2', v_upd, v_upd)
    using v_snap->'loan', v_loan;

  delete from loan_penalty_entries p where p.loan_id = v_loan
    and p.id not in (select (e->>'id')::uuid from jsonb_array_elements(v_snap->'penalties') e);
  delete from loan_penalty_held where loan_id = v_loan;
  delete from loan_penalty_kept where loan_id = v_loan;
  insert into loan_penalty_held select * from jsonb_populate_recordset(null::loan_penalty_held, v_snap->'held') on conflict do nothing;
  insert into loan_penalty_kept select * from jsonb_populate_recordset(null::loan_penalty_kept, v_snap->'kept') on conflict do nothing;

  update loans set renewed_from = v_loan
   where renewed_from is null
     and id in (select (e #>> '{}')::uuid from jsonb_array_elements(v_snap->'renewed_into') e);

  if v_old_id is not null and v_snap->>'renewed_from_status' = 'renewed' then
    update loans set status = 'renewed', closed_on = (v_snap->>'renewed_from_closed_on')::date where id = v_old_id;
  end if;

  update loan_deletions set restored_at = now() where id = p_deletion;
  return v_loan;
end $$;

revoke all on function public.loan_delete_snapshot(uuid) from public, anon;
revoke all on function public.loan_delete_erase(uuid, jsonb) from public, anon;
revoke all on function public.loan_delete_preview(uuid) from public, anon;
revoke all on function public.delete_loan(uuid, text) from public, anon;
revoke all on function public.restore_loan(uuid) from public, anon;
grant execute on function public.loan_delete_snapshot(uuid) to authenticated;
grant execute on function public.loan_delete_erase(uuid, jsonb) to authenticated;
grant execute on function public.loan_delete_preview(uuid) to authenticated;
grant execute on function public.delete_loan(uuid, text) to authenticated;
grant execute on function public.restore_loan(uuid) to authenticated;

commit;
