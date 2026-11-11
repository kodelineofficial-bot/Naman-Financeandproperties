// Export everything for a date range (Settings → Export data) as one Excel file.
// Entries are those dated inside the range; borrowers, employees and templates are
// the full lists (master data); loans are the ones running at any time in the range,
// with their figures as of today.
import { q, supabase } from './supabase.js';
import { LEDGER_KINDS, addDays, modeLabel, toNum, todayStr } from './format.js';
import { displayedLedgerAmount, withPayoutAmounts } from './ledgerAmounts.js';
import { buildXlsx } from './xlsx.js';
import { exportDays } from './exportRange.js';

const PAGE = 1000; // Supabase returns at most 1000 rows per request

/** Every row of a query, page by page. `make` must return a fresh, ordered query. */
async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await q(make().range(from, from + PAGE - 1));
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const num = (v) => (v == null || v === '' ? '' : toNum(v));
const yesNo = (v) => (v == null ? '' : v ? 'Yes' : 'No');
const noCash = new Set(['renewal', 'waiver', 'opening']);
// India day boundaries for timestamp columns
const istStart = (d) => `${d}T00:00:00+05:30`;

// timestamp → '2026-11-11 17:05' in India time (with the year, unlike fmtDateTime)
const fmtDateTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })} ${d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}`;
};

const col = (label, value, width) => ({ label, value: typeof value === 'function' ? value : (r) => r[value], width });

export async function buildExport(from, to, onStep = () => {}) {
  const inRange = (table, dateCol, select = '*') => () =>
    supabase.from(table).select(select).gte(dateCol, from).lte(dateCol, to).order(dateCol).order('id');

  onStep('Reading loans and borrowers…');
  const [settings, borrowers, allLoans] = await Promise.all([
    q(supabase.from('settings').select('*').eq('id', 1).single()),
    fetchAll(() => supabase.from('borrowers').select('*').order('name').order('id')),
    fetchAll(() => supabase.from('loans').select('id,loan_no,borrower_id,deleted_at,renewed_from').order('loan_no').order('id')),
  ]);
  const bName = new Map(borrowers.map((b) => [b.id, b.name]));
  const loanById = new Map(allLoans.map((l) => [l.id, l]));
  const loanNo = (id) => (id && loanById.get(id) ? loanById.get(id).loan_no : '');
  const loanWho = (id) => {
    const l = id && loanById.get(id);
    return l ? `${bName.get(l.borrower_id) || ''}${l.deleted_at ? ' (deleted)' : ''}` : '';
  };

  onStep('Reading the Day Book…');
  const [ledgerRows, payouts, daily, monthly] = await Promise.all([
    fetchAll(() => supabase.from('ledger').select('*').gte('entry_date', from).lte('entry_date', to)
      .order('entry_date').order('created_at').order('id')),
    fetchAll(() => supabase.from('loan_disbursements').select('id,amount').gte('paid_on', from).lte('paid_on', to)
      .neq('mode', 'renewal').neq('mode', 'opening').order('id')),
    fetchAll(() => supabase.from('daily_cashflow').select('*').gte('entry_date', from).lte('entry_date', to).order('entry_date')),
    fetchAll(() => supabase.from('monthly_cashflow').select('*').gte('month', from.slice(0, 7) + '-01').lte('month', to).order('month')),
  ]);
  const ledger = withPayoutAmounts(ledgerRows, payouts);

  onStep('Reading collections, payouts and penalty…');
  const [repayments, disbursements, penalties, loans] = await Promise.all([
    fetchAll(inRange('loan_repayments', 'paid_on')),
    fetchAll(inRange('loan_disbursements', 'paid_on')),
    fetchAll(inRange('loan_penalty_entries', 'paid_on')),
    // running at any time in the range: started by the end, not closed before the start
    fetchAll(() => supabase.from('loan_summary').select('*').lte('loan_date', to)
      .or(`closed_on.is.null,closed_on.gte.${from}`).order('loan_no').order('id')),
  ]);

  onStep('Reading expenses, cash and staff…');
  const [expenses, cashEntries, cashCounts, employees, salaries, advances, attendance, deletions, templates] = await Promise.all([
    fetchAll(inRange('expenses', 'spent_on')),
    fetchAll(inRange('cash_entries', 'entry_date')),
    fetchAll(() => supabase.from('cash_counts').select('*').gte('count_date', from).lte('count_date', to).order('count_date')),
    fetchAll(() => supabase.from('employees').select('*').order('name').order('id')),
    fetchAll(inRange('salary_payments', 'paid_on')),
    fetchAll(inRange('employee_advances', 'given_on')),
    fetchAll(inRange('employee_attendance', 'att_date')),
    fetchAll(() => supabase.from('loan_deletions').select('*').gte('deleted_at', istStart(from)).lt('deleted_at', istStart(addDays(to, 1)))
      .order('deleted_at').order('id')),
    fetchAll(() => supabase.from('message_templates').select('*').order('sort').order('id')),
  ]);
  const eName = new Map(employees.map((e) => [e.id, e.name]));

  onStep('Making the Excel file…');
  const dayBookTotal = (dir) => ledger
    .filter((r) => r.direction === dir && r.mode !== 'upi' && !noCash.has(r.mode))
    .reduce((n, r) => n + toNum(r.amount), 0);
  const first = daily[0];
  const last = daily[daily.length - 1];

  const summary = [
    ['Business', settings?.business_name || ''],
    ['Export from', from],
    ['Export to', to],
    ['Days', exportDays(from, to)],
    ['Made on', `${todayStr()} ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`],
    ['Opening cash (first day with entries)', first ? num(first.opening_balance) : ''],
    ['Closing cash (last day with entries)', last ? num(last.closing_balance) : ''],
    ['Cash in (Day Book, no UPI / adjustments)', Math.round(dayBookTotal('in') * 100) / 100],
    ['Cash out (Day Book, no UPI / adjustments)', Math.round(dayBookTotal('out') * 100) / 100],
    ['Day Book entries', ledger.length],
    ['Collections', repayments.length],
    ['Loan payouts / cuts', disbursements.length],
    ['Penalty entries', penalties.length],
    ['Loans running in range', loans.length],
    ['Borrowers (all)', borrowers.length],
    ['Expenses', expenses.length],
    ['Cash in / out entries', cashEntries.length],
    ['Salary payments', salaries.length],
    ['Staff advances', advances.length],
    ['Attendance marks', attendance.length],
    ['Loans deleted in range', deletions.length],
    ['Settings: interest % / extra % / daily per 10k', `${settings?.default_interest_pct} / ${settings?.default_markup_pct} / ${settings?.default_daily_per_10k}`],
    ['Settings: penalty', settings?.penalty_enabled ? `On · ₹${settings.penalty_per_day}/day from day ${toNum(settings.penalty_grace_days) + 2}` : 'Off'],
    ['Note', 'Entries are the ones dated in this range. Borrowers, employees and templates are full lists. Loan figures (balance, overdue, penalty) are as of the day of export.'],
  ].map(([k, v]) => ({ k, v }));

  const sheets = [
    { name: 'Summary', rows: summary, columns: [col('Item', 'k', 44), col('Value', 'v', 60)] },
    {
      name: 'Day Book',
      rows: ledger,
      columns: [
        col('Date', 'entry_date', 12),
        col('Tag', (r) => LEDGER_KINDS[r.kind]?.label || r.kind, 26),
        col('In / Out', (r) => (r.direction === 'in' ? 'In' : 'Out'), 9),
        col('Amount', (r) => num(displayedLedgerAmount(r)), 12),
        col('Book amount', (r) => num(r.amount), 12),
        col('Mode', (r) => modeLabel(r.mode), 22),
        col('In cash book', (r) => (r.mode === 'upi' || noCash.has(r.mode) ? 'No' : 'Yes'), 12),
        col('Party', 'party', 34),
        col('Note', 'note', 40),
        col('Entered at', (r) => fmtDateTime(r.created_at), 20),
      ],
    },
    {
      name: 'Daily Cash',
      rows: daily,
      columns: [
        col('Date', 'entry_date', 12),
        col('Opening', (r) => num(r.opening_balance)),
        col('Cash counted', (r) => num(r.cash_counted), 13),
        col('Count difference', (r) => num(r.count_difference), 16),
        col('Collections', (r) => num(r.collections), 12),
        col('Penalty', (r) => num(r.penalties)),
        col('Advance kept', (r) => num(r.advances_kept), 13),
        col('Cash in', (r) => num(r.capital_in)),
        col('Loans given', (r) => num(r.disbursements), 12),
        col('Expenses', (r) => num(r.expenses)),
        col('Salary', (r) => num(r.salaries)),
        col('Staff advance', (r) => num(r.employee_advances), 14),
        col('Cash out', (r) => num(r.capital_out)),
        col('Total in', (r) => num(r.total_in)),
        col('Total out', (r) => num(r.total_out)),
        col('Net', (r) => num(r.net)),
        col('Closing', (r) => num(r.closing_balance)),
        col('Entries', (r) => num(r.txn_count)),
      ],
    },
    {
      name: 'Monthly',
      rows: monthly,
      columns: [
        col('Month', (r) => String(r.month).slice(0, 7), 10),
        col('Collections', (r) => num(r.collections), 12),
        col('Penalty', (r) => num(r.penalties)),
        col('Advance kept', (r) => num(r.advances_kept), 13),
        col('Cash in', (r) => num(r.capital_in)),
        col('Loans given', (r) => num(r.disbursements), 12),
        col('Expenses', (r) => num(r.expenses)),
        col('Salary', (r) => num(r.salaries)),
        col('Staff advance', (r) => num(r.employee_advances), 14),
        col('Cash out', (r) => num(r.capital_out)),
        col('Total in', (r) => num(r.total_in)),
        col('Total out', (r) => num(r.total_out)),
        col('Net', (r) => num(r.net)),
        col('Closing', (r) => num(r.closing_balance)),
      ],
    },
    {
      name: 'Collections',
      rows: repayments,
      columns: [
        col('Date', 'paid_on', 12),
        col('Loan #', (r) => loanNo(r.loan_id), 8),
        col('Borrower', (r) => loanWho(r.loan_id), 28),
        col('Amount', (r) => num(r.amount)),
        col('Mode', (r) => modeLabel(r.mode), 22),
        col('Cut into loan #', (r) => loanNo(r.adjusted_into), 14),
        col('Note', 'note', 40),
        col('Entered at', (r) => fmtDateTime(r.created_at), 20),
      ],
    },
    {
      name: 'Loan Payouts',
      rows: disbursements,
      columns: [
        col('Date', 'paid_on', 12),
        col('Loan #', (r) => loanNo(r.loan_id), 8),
        col('Borrower', (r) => loanWho(r.loan_id), 28),
        col('Amount', (r) => num(r.amount)),
        col('Mode', (r) => modeLabel(r.mode), 22),
        col('Cut for loan #', (r) => loanNo(r.cut_from), 14),
        col('Note', 'note', 40),
        col('Entered at', (r) => fmtDateTime(r.created_at), 20),
      ],
    },
    {
      name: 'Penalty',
      rows: penalties,
      columns: [
        col('Date', 'paid_on', 12),
        col('Loan #', (r) => loanNo(r.loan_id), 8),
        col('Borrower', (r) => loanWho(r.loan_id), 28),
        col('Type', 'kind', 10),
        col('Amount', (r) => num(r.amount)),
        col('Mode', (r) => modeLabel(r.mode), 22),
        col('Note', 'note', 40),
        col('Entered at', (r) => fmtDateTime(r.created_at), 20),
      ],
    },
    {
      name: 'Loans',
      rows: loans,
      columns: [
        col('Loan #', 'loan_no', 8),
        col('Borrower', 'borrower_name', 28),
        col('Phone', 'borrower_phone', 14),
        col('Status', 'status', 10),
        col('Loan date', 'loan_date', 12),
        col('Collection from', 'collection_start_date', 14),
        col('Frequency', 'frequency', 10),
        col('Principal', (r) => num(r.principal)),
        col('Interest %', (r) => num(r.interest_pct)),
        col('Interest', (r) => num(r.interest_amount)),
        col('Extra %', (r) => num(r.markup_pct)),
        col('Total to collect', (r) => num(r.total_repayable), 15),
        col('Installment', (r) => num(r.daily_installment), 12),
        col('Days', (r) => num(r.duration_days)),
        col('Advance', (r) => num(r.advance_amount)),
        col('Given', (r) => num(r.disbursed)),
        col('Collected', (r) => num(r.collected_total)),
        col('Forgiven', (r) => num(r.forgiven)),
        col('Balance left', (r) => num(r.outstanding), 13),
        col('Overdue', (r) => num(r.overdue)),
        col('Paid till', 'paid_till', 12),
        col('Last paid', 'last_paid_on', 12),
        col('Expected end', 'expected_end_date', 13),
        col('Penalty charged', (r) => num(r.penalty_charged), 15),
        col('Penalty paid', (r) => num(r.penalty_paid), 13),
        col('Penalty waived', (r) => num(r.penalty_waived), 14),
        col('Penalty due', (r) => num(r.penalty_due), 12),
        col('Penalty off', (r) => yesNo(r.penalty_off), 11),
        col('Renewed from #', (r) => loanNo(loanById.get(r.id)?.renewed_from), 14),
        col('Closed on', 'closed_on', 12),
        col('Defaulter from', 'defaulted_on', 14),
        col('Notes', 'notes', 40),
      ],
    },
    {
      name: 'Borrowers',
      rows: borrowers,
      columns: [
        col('Name', 'name', 28),
        col('Phone', 'phone', 14),
        col('Other phone', 'alt_phone', 14),
        col('Work', 'occupation', 20),
        col('Address', 'address', 34),
        col('ID proof', 'id_proof', 20),
        col('Guarantor', 'guarantor_name', 20),
        col('Guarantor phone', 'guarantor_phone', 15),
        col('Loans (all time)', (r) => allLoans.filter((l) => l.borrower_id === r.id && !l.deleted_at).length, 15),
        col('Photo', 'photo_url', 40),
        col('Notes', 'notes', 40),
        col('Added on', (r) => fmtDateTime(r.created_at), 20),
      ],
    },
    {
      name: 'Expenses',
      rows: expenses,
      columns: [
        col('Date', 'spent_on', 12),
        col('Category', 'category', 20),
        col('Amount', (r) => num(r.amount)),
        col('Mode', (r) => modeLabel(r.mode), 16),
        col('Paid to', 'paid_to', 22),
        col('Description', 'description', 40),
        col('Entered at', (r) => fmtDateTime(r.created_at), 20),
      ],
    },
    {
      name: 'Cash In-Out',
      rows: cashEntries,
      columns: [
        col('Date', 'entry_date', 12),
        col('In / Out', (r) => (r.direction === 'in' ? 'In' : 'Out'), 9),
        col('Amount', (r) => num(r.amount)),
        col('Mode', (r) => modeLabel(r.mode), 16),
        col('Party', 'party', 24),
        col('Description', 'description', 40),
        col('Entered at', (r) => fmtDateTime(r.created_at), 20),
      ],
    },
    {
      name: 'Cash Counts',
      rows: cashCounts,
      columns: [col('Date', 'count_date', 12), col('Cash counted', (r) => num(r.amount), 13), col('Note', 'note', 40), col('Entered at', (r) => fmtDateTime(r.created_at), 20)],
    },
    {
      name: 'Salary',
      rows: salaries,
      columns: [
        col('Paid on', 'paid_on', 12),
        col('Employee', (r) => eName.get(r.employee_id) || '', 22),
        col('For month', (r) => String(r.salary_month || '').slice(0, 7), 10),
        col('Amount', (r) => num(r.amount)),
        col('Mode', (r) => modeLabel(r.mode), 16),
        col('Note', 'note', 40),
      ],
    },
    {
      name: 'Staff Advances',
      rows: advances,
      columns: [
        col('Given on', 'given_on', 12),
        col('Employee', (r) => eName.get(r.employee_id) || '', 22),
        col('Type', 'kind', 12),
        col('Amount', (r) => num(r.amount)),
        col('Cut in month', (r) => String(r.deduct_month || '').slice(0, 7), 12),
        col('Mode', (r) => modeLabel(r.mode), 16),
        col('Note', 'note', 40),
      ],
    },
    {
      name: 'Attendance',
      rows: attendance,
      columns: [
        col('Date', 'att_date', 12),
        col('Employee', (r) => eName.get(r.employee_id) || '', 22),
        col('Status', 'status', 12),
        col('Note', 'note', 40),
      ],
    },
    {
      name: 'Employees',
      rows: employees,
      columns: [
        col('Name', 'name', 22),
        col('Phone', 'phone', 14),
        col('Designation', 'designation', 16),
        col('Address', 'address', 30),
        col('ID proof', 'id_proof', 18),
        col('Joined', 'joining_date', 12),
        col('Monthly salary', (r) => num(r.monthly_salary), 14),
        col('Cut per extra leave day', (r) => num(r.leave_cut_per_day), 20),
        col('Active', (r) => yesNo(r.is_active)),
        col('Notes', 'notes', 40),
      ],
    },
    {
      name: 'Deleted Loans',
      rows: deletions,
      columns: [
        col('Deleted at', (r) => fmtDateTime(r.deleted_at), 20),
        col('Loan #', 'loan_no', 8),
        col('Borrower', 'borrower_name', 24),
        col('How', (r) => (r.mode === 'undo' ? 'Undo everything' : 'Removed, money kept'), 20),
        col('Restored at', (r) => fmtDateTime(r.restored_at), 20),
        col('Details', (r) => (r.summary ? JSON.stringify(r.summary) : ''), 60),
      ],
    },
    {
      name: 'Templates',
      rows: templates,
      columns: [col('Name', 'name', 22), col('Used for', 'use_for', 14), col('Message', 'body', 80)],
    },
  ];

  return { bytes: buildXlsx(sheets), counts: Object.fromEntries(sheets.map((s) => [s.name, s.rows.length])) };
}
