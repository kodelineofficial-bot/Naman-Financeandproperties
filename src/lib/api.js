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

/** Cash in hand at the START of `date` (i.e. closing of the previous day with entries). */
export async function getOpeningOn(date) {
  const rows = await q(
    supabase
      .from('daily_cashflow')
      .select('closing_balance')
      .lt('entry_date', date)
      .order('entry_date', { ascending: false })
      .limit(1),
  );
  if (rows.length) return toNum(rows[0].closing_balance);
  const s = await getSettings();
  return toNum(s.opening_balance);
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
