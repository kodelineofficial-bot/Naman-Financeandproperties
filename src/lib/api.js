import { q, supabase } from './supabase.js';
import { toNum } from './format.js';
import { withPayoutAmounts } from './ledgerAmounts.js';

export async function getSettings() {
  return q(supabase.from('settings').select('*').eq('id', 1).single());
}

/** Cash in hand at the END of `date` (inclusive). */
export async function getBalanceAsOf(date) {
  const rows = await q(
    supabase
      .from('daily_cashflow')
      .select('closing_balance')
      .lte('entry_date', date)
      .order('entry_date', { ascending: false })
      .limit(1),
  );
  if (rows.length) return toNum(rows[0].closing_balance);
  const s = await getSettings();
  return toNum(s.opening_balance);
}

/**
 * Cash in hand at the START of `date`: the cash counted that morning (migration 030),
 * else the closing of the previous day with entries. `expected` is what the system
 * worked out before the count, so a count never hides a difference.
 */
export async function getOpeningDetail(date) {
  const [day, rows] = await Promise.all([
    q(supabase.from('daily_cashflow').select('opening_balance,cash_counted,count_difference').eq('entry_date', date).maybeSingle()),
    q(
      supabase
        .from('daily_cashflow')
        .select('closing_balance')
        .lt('entry_date', date)
        .order('entry_date', { ascending: false })
        .limit(1),
    ),
  ]);
  const expected = rows.length ? toNum(rows[0].closing_balance) : toNum((await getSettings()).opening_balance);
  if (day?.cash_counted != null) {
    return { opening: toNum(day.cash_counted), expected, counted: toNum(day.cash_counted), difference: toNum(day.count_difference) };
  }
  return { opening: expected, expected, counted: null, difference: 0 };
}

export async function getOpeningOn(date) {
  return (await getOpeningDetail(date)).opening;
}

export async function getBorrowers() {
  return q(supabase.from('borrowers').select('*').order('name'));
}

export async function getLedger(from, to) {
  const [entries, payouts] = await Promise.all([q(
    supabase
      .from('ledger')
      .select('*')
      .gte('entry_date', from)
      .lte('entry_date', to)
      .order('entry_date', { ascending: true })
      .order('created_at', { ascending: true }),
  ), q(supabase.from('loan_disbursements').select('id,amount')
    .gte('paid_on', from).lte('paid_on', to).neq('mode', 'renewal').neq('mode', 'opening'))]);
  return withPayoutAmounts(entries, payouts);
}

/** Delete one ledger row from the right underlying table. */
const KIND_TABLE = {
  disbursement: 'loan_disbursements',
  collection: 'loan_repayments',
  expense: 'expenses',
  salary: 'salary_payments',
  employee_advance: 'employee_advances',
  capital_in: 'cash_entries',
  capital_out: 'cash_entries',
  penalty: 'loan_penalty_entries',
};

export async function deleteLedgerEntry(row) {
  const table = KIND_TABLE[row.kind];
  if (!table) throw new Error('Unknown entry type');
  await q(supabase.from(table).delete().eq('id', row.id));
}
