/**
 * On a phone every `.table` turns into cards (see styles.css, "Phone tables"),
 * and each cell shows its column name in front of it. The column name comes
 * from the table's header, copied into the cell as `data-label`.
 *
 * Doing this once here, for every table on every page, means no page has to
 * add labels by hand, and new rows (a payment saved, a page change) are labelled
 * as soon as React puts them on screen.
 */

/** Header text for each column of a header row, spreading colSpan headers over their columns. */
export function headerLabels(cells) {
  const out = [];
  for (const c of cells) {
    const text = (c.text || '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < (c.span || 1); i++) out.push(text);
  }
  return out;
}

/** Label for each cell of a body row: '' for a cell spanning several columns (a total line). */
export function cellLabels(labels, cells) {
  const out = [];
  let col = 0;
  for (const c of cells) {
    const span = c.span || 1;
    out.push(span > 1 ? '' : labels[col] || '');
    col += span;
  }
  return out;
}

function labelTable(table) {
  const head = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!head) return;
  const labels = headerLabels([...head.cells].map((c) => ({ text: c.textContent, span: c.colSpan })));
  for (const section of [...table.tBodies, table.tFoot].filter(Boolean)) {
    for (const row of section.rows) {
      const cells = [...row.cells];
      const names = cellLabels(labels, cells.map((c) => ({ span: c.colSpan })));
      cells.forEach((cell, i) => {
        if (cell.getAttribute('data-label') !== names[i]) cell.setAttribute('data-label', names[i]);
      });
    }
  }
}

export function startTableLabels(root = document.body) {
  let queued = false;
  const run = () => {
    queued = false;
    root.querySelectorAll('table.table').forEach(labelTable);
  };
  const queue = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(run);
    }
  };
  // Only child changes are watched, so setting data-label never re-triggers this.
  new MutationObserver(queue).observe(root, { childList: true, subtree: true, characterData: true });
  queue();
}
