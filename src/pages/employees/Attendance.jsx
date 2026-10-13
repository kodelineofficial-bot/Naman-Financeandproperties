import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../components/Toast.jsx';
import { Card, Empty, ErrorBox, ExportButton, Loading, PageHeader, PrintButton, Stat, Tabs } from '../../components/ui.jsx';
import {
  addDays, addMonths, fmtDateFull, fmtMonth, monthEnd, monthStart, todayStr,
} from '../../lib/format.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

export const ATT = {
  present: { label: 'Present', hi: 'हाज़िर', short: 'P', cls: 'att-present' },
  absent:  { label: 'Absent',  hi: 'गैरहाज़िर', short: 'A', cls: 'att-absent' },
  half:    { label: 'Half day', hi: 'आधा दिन', short: '½', cls: 'att-half' },
  leave:   { label: 'Leave',   hi: 'छुट्टी', short: 'L', cls: 'att-leave' },
};
const ORDER = ['present', 'absent', 'half', 'leave'];

/** Save (or clear, when status is null) one employee's attendance for one day. */
export async function setAttendance(employeeId, date, status) {
  if (!status) {
    await q(supabase.from('employee_attendance').delete().eq('employee_id', employeeId).eq('att_date', date));
    return;
  }
  await q(
    supabase
      .from('employee_attendance')
      .upsert({ employee_id: employeeId, att_date: date, status }, { onConflict: 'employee_id,att_date' }),
  );
}

function DayView({ date, setDate }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);

  const { data, loading, error } = useLoad(async () => {
    const [emps, marks] = await Promise.all([
      q(supabase.from('employees').select('id,name,designation,phone,joining_date').eq('is_active', true).lte('joining_date', date).order('name')),
      q(supabase.from('employee_attendance').select('employee_id,status').eq('att_date', date)),
    ]);
    const map = Object.fromEntries(marks.map((m) => [m.employee_id, m.status]));
    return emps.map((e) => ({ ...e, status: map[e.id] || null }));
  }, [date]);

  const rows = data || [];
  const count = (st) => rows.filter((r) => r.status === st).length;
  const unmarked = rows.filter((r) => !r.status);

  async function mark(e, status) {
    const next = e.status === status ? null : status; // tap again to clear
    await run(() => setAttendance(e.id, date, next));
  }

  async function markAllPresent() {
    if (!unmarked.length) return;
    await run(
      () =>
        q(
          supabase
            .from('employee_attendance')
            .upsert(unmarked.map((e) => ({ employee_id: e.id, att_date: date, status: 'present' })), { onConflict: 'employee_id,att_date' }),
        ),
      `${unmarked.length} marked present`,
    );
  }

  return (
    <>
      <div className="date-nav big-date-nav">
        <button className="btn" onClick={() => setDate(addDays(date, -1))}>‹ Yesterday</button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button className="btn" onClick={() => setDate(addDays(date, 1))}>Next ›</button>
        {date !== todayStr() && <button className="btn btn-primary" onClick={() => setDate(todayStr())}>Today</button>}
        <ExportButton
          filename={`attendance-${date}.csv`}
          rows={rows}
          columns={[
            { label: 'Date', value: () => date }, { label: 'Name', key: 'name' }, { label: 'Job', key: 'designation' },
            { label: 'Status', value: (r) => (r.status ? ATT[r.status].label : 'Not marked') },
          ]}
        />
        <PrintButton />
      </div>
      <h2 className="day-title">{fmtDateFull(date)}</h2>

      <div className="stats">
        <Stat label="Present · हाज़िर" value={count('present')} tone="green" />
        <Stat label="Absent · गैरहाज़िर" value={count('absent')} tone={count('absent') ? 'red' : undefined} />
        <Stat label="Half day · आधा दिन" value={count('half')} />
        <Stat label="Not marked yet" value={unmarked.length} tone={unmarked.length ? 'gold' : undefined} />
      </div>

      <Card
        flush
        title={`Staff · कर्मचारी (${rows.length})`}
        actions={
          <button className="btn btn-primary" disabled={busy || !unmarked.length} onClick={markAllPresent}>
            ✓ Mark all remaining Present ({unmarked.length})
          </button>
        }
      >
        <ErrorBox error={error} />
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>No working staff. <Link to="/employees">Add employees →</Link></Empty>
        ) : (
          <div className="att-list">
            {rows.map((e) => (
              <div key={e.id} className="att-row">
                <div className="att-who">
                  <Link to={`/employees/${e.id}`}><strong className="big-name">{e.name}</strong></Link>
                  <div className="muted small">{[e.designation, e.phone].filter(Boolean).join(' · ') || '—'}</div>
                </div>
                <div className="att-btns">
                  {ORDER.map((st) => (
                    <button
                      key={st}
                      type="button"
                      disabled={busy}
                      className={`att-btn ${ATT[st].cls} ${e.status === st ? 'on' : ''}`}
                      onClick={() => mark(e, st)}
                    >
                      <b>{ATT[st].short}</b>
                      <span>{ATT[st].label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <p className="help-box">
        Tap a button to mark. Tap the same button again to remove the mark. <strong>P</strong> = Present, <strong>A</strong> = Absent,
        <strong> ½</strong> = Half day, <strong>L</strong> = Paid leave.
      </p>
    </>
  );
}

function MonthView({ month, setMonth }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const today = todayStr();
  const end = monthEnd(month);

  const { data, loading, error } = useLoad(async () => {
    const [emps, marks] = await Promise.all([
      q(supabase.from('employees').select('id,name,is_active,joining_date').lte('joining_date', end).order('name')),
      q(supabase.from('employee_attendance').select('employee_id,att_date,status').gte('att_date', month).lte('att_date', end)),
    ]);
    const map = {};
    for (const m of marks) map[`${m.employee_id}|${m.att_date}`] = m.status;
    const active = emps.filter((e) => e.is_active || marks.some((m) => m.employee_id === e.id));
    return { emps: active, map };
  }, [month]);

  const dates = useMemo(() => {
    const list = [];
    for (let d = month; d <= end; d = addDays(d, 1)) list.push(d);
    return list;
  }, [month, end]);

  async function cycle(e, d) {
    if (d > today) return toast.info('Cannot mark a future date.');
    const cur = data.map[`${e.id}|${d}`] || null;
    const idx = cur ? ORDER.indexOf(cur) : -1;
    const next = idx + 1 < ORDER.length ? ORDER[idx + 1] : null;
    await run(() => setAttendance(e.id, d, next));
  }

  return (
    <>
      <div className="date-nav big-date-nav">
        <button className="btn" onClick={() => setMonth(addMonths(month, -1))}>‹ Previous month</button>
        <strong className="year">{fmtMonth(month)}</strong>
        <button className="btn" onClick={() => setMonth(addMonths(month, 1))}>Next month ›</button>
        <ExportButton
          filename={`attendance-${month.slice(0, 7)}.csv`}
          rows={data?.emps}
          columns={[
            { label: 'Name', key: 'name' },
            ...dates.map((d) => ({ label: d.slice(8), value: (e) => { const st = data.map[`${e.id}|${d}`]; return st ? ATT[st].short : ''; } })),
            ...ORDER.map((st) => ({ label: ATT[st].label, value: (e) => dates.filter((d) => data.map[`${e.id}|${d}`] === st).length })),
          ]}
        />
        <PrintButton />
      </div>
      <ErrorBox error={error} />
      <Card flush>
        {loading && !data ? (
          <Loading />
        ) : !data?.emps.length ? (
          <Empty>No staff for this month.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table att-sheet">
              <thead>
                <tr>
                  <th className="att-name">Name</th>
                  {dates.map((d) => (
                    <th key={d} className={d === today ? 'is-today' : ''}>
                      {Number(d.slice(8))}
                      <div className="wd">{new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'narrow' })}</div>
                    </th>
                  ))}
                  <th className="num">P</th><th className="num">A</th><th className="num">½</th><th className="num">L</th>
                </tr>
              </thead>
              <tbody>
                {data.emps.map((e) => {
                  const c = { present: 0, absent: 0, half: 0, leave: 0 };
                  return (
                    <tr key={e.id}>
                      <td className="att-name">
                        <Link to={`/employees/${e.id}`}>{e.name}</Link>
                      </td>
                      {dates.map((d) => {
                        const st = data.map[`${e.id}|${d}`];
                        if (st) c[st] += 1;
                        const before = d < e.joining_date;
                        return (
                          <td key={d} className="att-cell-td">
                            {before ? (
                              <span className="att-cell off" />
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                className={`att-cell ${st ? ATT[st].cls : ''} ${d === today ? 'is-today' : ''}`}
                                title={`${e.name} — ${fmtDateFull(d)}: ${st ? ATT[st].label : 'not marked'} (click to change)`}
                                onClick={() => cycle(e, d)}
                              >
                                {st ? ATT[st].short : ''}
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <td className="num amt-in"><strong>{c.present}</strong></td>
                      <td className="num amt-out"><strong>{c.absent}</strong></td>
                      <td className="num">{c.half}</td>
                      <td className="num">{c.leave}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="help-box">Click a box to change it: empty → P → A → ½ → L → empty.</p>
    </>
  );
}

/** Staff attendance register (हाज़िरी रजिस्टर). */
export default function Attendance() {
  const [tab, setTab] = useState('day');
  const [date, setDate] = useState(todayStr());
  const [month, setMonth] = useState(monthStart(todayStr()));

  return (
    <>
      <PageHeader title="Attendance" hindi="हाज़िरी" subtitle="Mark who came to work each day">
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'day', label: 'Daily · रोज़' },
            { value: 'month', label: 'Month register · महीना' },
          ]}
        />
      </PageHeader>
      {tab === 'day' ? <DayView date={date} setDate={setDate} /> : <MonthView month={month} setMonth={setMonth} />}
    </>
  );
}
