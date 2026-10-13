import { fmtDateFull, fmtMonth, money } from '../lib/format.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const KHATA_STATES = {
  paid:    { label: 'Paid · जमा', short: '✓' },
  advance: { label: 'Paid in advance · एडवांस', short: '✓' },
  partial: { label: 'Half paid · अधूरा', short: '½' },
  missed:  { label: 'Not paid · नहीं दिया', short: '✗' },
  future:  { label: 'Coming days · आने वाले', short: '' },
};

/**
 * Full month calendar(s): weekday header, every date of the month,
 * colour per day, and the money actually received on that date.
 *
 * months: [{ month, days: [{ date, state, received, covered, due }] }]
 * Optional: renderLabel(day) for a custom tooltip.
 */
export function MonthCalendar({ month, days, today, renderTitle, renderExtra, onDayClick }) {
  // Monday-first: getDay() 0=Sun → 6
  const firstDow = (new Date(`${month}T00:00:00`).getDay() + 6) % 7;
  return (
    <div className="cal-month">
      <div className="cal-month-name">{fmtMonth(month)}</div>
      <div className="cal-grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-wd">{w}</div>
        ))}
        {Array.from({ length: firstDow }, (_, i) => (
          <div key={'b' + i} className="cal-blank" />
        ))}
        {days.map((d) => {
          const Tag = onDayClick ? 'button' : 'div';
          return (
            <Tag
              type={onDayClick ? 'button' : undefined}
              key={d.date}
              className={`cal-day st-${d.state} ${d.date === today ? 'is-today' : ''}`}
              title={renderTitle ? renderTitle(d) : fmtDateFull(d.date)}
              onClick={onDayClick ? () => onDayClick(d) : undefined}
            >
              <span className="cal-num">{Number(d.date.slice(8))}</span>
              {renderExtra?.(d)}
            </Tag>
          );
        })}
      </div>
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="cal-legend">
      {items.map(([state, label]) => (
        <span key={state}>
          <i className={`cal-dot st-${state}`} /> {label}
        </span>
      ))}
    </div>
  );
}

/** Loan khata: one calendar per month of the loan. */
export default function KhataCalendar({ cal, today }) {
  const title = (d) => {
    const parts = [fmtDateFull(d.date)];
    if (d.inSchedule) {
      parts.push(KHATA_STATES[d.state]?.label || '');
      if (d.state === 'partial') parts.push(`${money(d.covered)} of ${money(d.due)}`);
    } else {
      parts.push('Not a collection day for this loan');
    }
    if (d.received) parts.push(`Money received this day: ${money(d.received)}`);
    return parts.join('\n');
  };

  return (
    <>
      <Legend
        items={[
          ['paid', `Paid (${cal.counts.paid})`],
          ['advance', `Paid in advance (${cal.counts.advance})`],
          ['partial', `Half paid (${cal.counts.partial})`],
          ['missed', `Not paid (${cal.counts.missed})`],
          ['future', `Coming (${cal.counts.future})`],
        ]}
      />
      <div className="cal-months">
        {cal.months.map((m) => (
          <MonthCalendar
            key={m.month}
            month={m.month}
            days={m.days}
            today={today}
            renderTitle={title}
            renderExtra={(d) => (d.received ? <span className="cal-amt">₹{Math.round(d.received)}</span> : null)}
          />
        ))}
      </div>
      <p className="muted small">
        Small ₹ number = money received on that date. Money is filled day by day from the first day, so ₹300 on a ₹150 loan fills 2 days.
      </p>
    </>
  );
}
