import { Link, useNavigate } from 'react-router-dom';
import { Amount, Card, Empty, ErrorBox, ExportButton, Loading, PageHeader, PrintButton, Stat } from '../components/ui.jsx';
import { getBalanceAsOf } from '../lib/api.js';
import {
  LEDGER_KINDS, fmtDateFull, fmtDateShort, fmtMonth, money, monthStart, sum, toNum, todayStr, whatsappLink,
} from '../lib/format.js';
import { useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

export default function Dashboard() {
  const navigate = useNavigate();
  const today = todayStr();
  const month = monthStart(today);

  const { data, loading, error } = useLoad(async () => {
    const [balance, todayRow, loans, monthRow, loansMonth, salary, recent] = await Promise.all([
      getBalanceAsOf(today),
      q(supabase.from('daily_cashflow').select('*').eq('entry_date', today).maybeSingle()),
      q(
        supabase
          .from('loan_summary')
          .select(
            'id,loan_no,borrower_name,borrower_phone,daily_installment,outstanding,overdue,pending_disbursement,paid_today,status,collection_start_date,last_paid_on,principal,paid_till',
          )
          .in('status', ['active', 'defaulted']),
      ),
      q(supabase.from('monthly_cashflow').select('*').eq('month', month).maybeSingle()),
      q(supabase.from('loans_monthly').select('*').eq('month', month).maybeSingle()),
      q(supabase.rpc('salary_report', { p_month: month })),
      q(
        supabase
          .from('ledger')
          .select('*')
          .order('entry_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(12),
      ),
    ]);

    // Due today = running loan that was not already covered (paid in advance) before today.
    const coveredAhead = (l) => toNum(l.paid_today) === 0 && l.paid_till && l.paid_till >= today;
    const dueToday = loans.filter(
      (l) =>
        l.status === 'active' &&
        l.collection_start_date <= today &&
        (toNum(l.outstanding) > 0 || toNum(l.paid_today) > 0) &&
        !coveredAhead(l),
    );
    return {
      balance,
      todayRow: todayRow || {},
      monthRow: monthRow || {},
      loansMonth: loansMonth || {},
      loans,
      expectedToday: sum(dueToday, (l) => Math.min(toNum(l.daily_installment), toNum(l.outstanding) + toNum(l.paid_today))),
      collectedToday: sum(loans, 'paid_today'),
      notPaidToday: dueToday.filter((l) => toNum(l.paid_today) === 0).length,
      dueCount: dueToday.length,
      outstanding: sum(loans, 'outstanding'),
      overdue: sum(loans, 'overdue'),
      pendingDisb: sum(loans, 'pending_disbursement'),
      principalOut: sum(loans, 'principal'),
      salaryDue: sum(salary.filter((s) => toNum(s.balance) > 0), 'balance'),
      topOverdue: [...loans].filter((l) => toNum(l.overdue) > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 8),
      recent,
    };
  }, [today]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const d = data;
  const collectPct = d.expectedToday > 0 ? Math.round((d.collectedToday / d.expectedToday) * 100) : 0;

  return (
    <>
      <PageHeader title="Dashboard" hindi="डैशबोर्ड" subtitle={fmtDateFull(today)}>
        <Link to="/collection" className="btn btn-primary">
          ₹ Collect today
        </Link>
        <Link to="/loans/new" className="btn">
          + New loan
        </Link>
        <Link to="/attendance" className="btn">
          ☑ Attendance
        </Link>
        <ExportButton
          label="Running loans"
          filename={`running-loans-${today}.csv`}
          rows={d.loans}
          columns={[
            { label: 'Loan #', key: 'loan_no' }, { label: 'Name', key: 'borrower_name' }, { label: 'Phone', key: 'borrower_phone' },
            { label: 'Principal', key: 'principal' }, { label: 'Daily', key: 'daily_installment' },
            { label: 'Paid today', key: 'paid_today' }, { label: 'Paid till', key: 'paid_till' },
            { label: 'Balance', key: 'outstanding' }, { label: 'Overdue', key: 'overdue' }, { label: 'Status', key: 'status' },
          ]}
        />
        <PrintButton />
      </PageHeader>
      <ErrorBox error={error} />

      <div className="stats">
        <Stat label="Cash in hand · रोकड़" value={money(d.balance)} tone={d.balance < 0 ? 'red' : 'gold'} hint="Opening + all in − all out" onClick={() => navigate('/daybook')} />
        <Stat label="Market outstanding · बाज़ार में" value={money(d.outstanding)} hint={`${d.loans.length} open loans`} onClick={() => navigate('/loans')} />
        <Stat label="Overdue · बकाया" value={money(d.overdue)} tone={d.overdue > 0 ? 'red' : 'green'} hint="Behind daily schedule" onClick={() => navigate('/loans?sort=overdue')} />
        <Stat label="To give · देना बाकी" value={money(d.pendingDisb)} hint="Loan amount not yet handed over" />
      </div>

      <div className="grid-2">
        <Card title="Today · आज">
          <div className="today-collect">
            <div>
              <div className="muted small">Collected today</div>
              <div className="big-num amt-in">{money(d.collectedToday)}</div>
              <div className="muted small">
                of {money(d.expectedToday)} expected · {collectPct}%
              </div>
            </div>
            <div className="ring" style={{ '--p': Math.min(collectPct, 100) }}>
              <span>{collectPct}%</span>
            </div>
          </div>
          <div className="kv-list">
            <div><span>Borrowers yet to pay today</span><strong>{d.notPaidToday} / {d.dueCount}</strong></div>
            <div><span>Total in today</span><Amount value={d.todayRow.total_in} dir="in" /></div>
            <div><span>Loans given today</span><Amount value={d.todayRow.disbursements} dir="out" /></div>
            <div><span>Expenses today</span><Amount value={d.todayRow.expenses} dir="out" /></div>
            <div><span>Total out today</span><Amount value={d.todayRow.total_out} dir="out" /></div>
          </div>
          <Link to={`/daybook?date=${today}`} className="link-more">Open today’s day book →</Link>
        </Card>

        <Card title={`This month · ${fmtMonth(month)}`}>
          <div className="kv-list">
            <div><span>Collections</span><Amount value={d.monthRow.collections} dir="in" /></div>
            <div><span>Loans given (cash out)</span><Amount value={d.monthRow.disbursements} dir="out" /></div>
            <div><span>New loans</span><strong>{d.loansMonth.loans_count || 0} · {money(d.loansMonth.principal_issued)}</strong></div>
            <div><span>Interest cut upfront</span><strong className="amt-in">{money(d.loansMonth.interest_earned)}</strong></div>
            <div><span>Expenses</span><Amount value={d.monthRow.expenses} dir="out" /></div>
            <div><span>Salary + staff advances paid</span><Amount value={toNum(d.monthRow.salaries) + toNum(d.monthRow.employee_advances)} dir="out" /></div>
            <div><span>Salary still to pay</span><strong className={d.salaryDue > 0 ? 'amt-out' : ''}>{money(d.salaryDue)}</strong></div>
            <div className="kv-total"><span>Net cash flow</span><Amount value={d.monthRow.net} strong /></div>
          </div>
          <Link to="/monthly" className="link-more">Monthly report →</Link>
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Top overdue · सबसे ज़्यादा बकाया" flush>
          {d.topOverdue.length === 0 ? (
            <Empty>Everyone is on schedule. 🎉</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Borrower</th><th className="num">Overdue</th><th>Last paid</th><th /></tr>
              </thead>
              <tbody>
                {d.topOverdue.map((l) => {
                  const wa = whatsappLink(
                    l.borrower_phone,
                    `Namaste ${l.borrower_name}, aapki kisht ka ${money(l.overdue)} baaki hai. Kripya jaldi jama karein.`,
                  );
                  return (
                    <tr key={l.id} className="clickable" onClick={() => navigate(`/loans/${l.id}`)}>
                      <td>
                        <strong>{l.borrower_name}</strong>
                        <div className="muted small">#{l.loan_no} · {l.borrower_phone || 'no phone'}</div>
                      </td>
                      <td className="num amt-out">{money(l.overdue)}</td>
                      <td>{fmtDateShort(l.last_paid_on)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {wa && <a className="btn btn-sm btn-wa" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent entries · हाल की एंट्री" flush>
          {d.recent.length === 0 ? (
            <Empty>No transactions yet.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {d.recent.map((r) => (
                  <tr key={r.kind + r.id}>
                    <td className="nowrap">{fmtDateShort(r.entry_date)}</td>
                    <td>
                      <div>{r.party}</div>
                      <div className="muted small">{LEDGER_KINDS[r.kind]?.short}</div>
                    </td>
                    <td className="num"><Amount value={r.amount} dir={r.direction} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
