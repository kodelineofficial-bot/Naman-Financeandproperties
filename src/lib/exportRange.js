import { addDays, daysBetween, shiftMonths } from './format.js';

// Export date range: at least 1 day (start = end is one day), at most 1 month
// (1 Oct → 31 Oct, 15 Oct → 14 Nov, 1 Feb → 28 Feb), and not after today.

/** Last end date allowed for a start date: one month later, minus a day. */
export const maxExportEnd = (from) => addDays(shiftMonths(from, 1), -1);

/** Returns an error message, or '' when the range is fine. */
export function exportRangeError(from, to, today) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '')) return 'Pick a start and an end date.';
  if (to < from) return 'End date cannot be before the start date (at least 1 day).';
  if (today && to > today) return 'End date cannot be after today.';
  if (to > maxExportEnd(from)) return `At most 1 month at a time — for this start date the end can be up to ${maxExportEnd(from)}.`;
  return '';
}

export const exportDays = (from, to) => daysBetween(from, to) + 1;
