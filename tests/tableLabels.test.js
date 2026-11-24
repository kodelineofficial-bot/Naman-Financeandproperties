import test from 'node:test';
import assert from 'node:assert/strict';
import { cellLabels, headerLabels } from '../src/lib/tableLabels.js';

test('header labels spread over colSpan columns', () => {
  assert.deepEqual(headerLabels([{ text: ' Borrower ' }, { text: 'Paid\n  amount', span: 2 }, { text: '' }]), ['Borrower', 'Paid amount', 'Paid amount', '']);
});

test('cell labels follow columns; a cell spanning columns gets no label', () => {
  const labels = ['Borrower', 'Due', 'Paid', 'Balance'];
  assert.deepEqual(cellLabels(labels, [{}, {}, {}, {}]), labels);
  assert.deepEqual(cellLabels(labels, [{ span: 2 }, {}, {}]), ['', 'Paid', 'Balance']);
  assert.deepEqual(cellLabels(labels, [{}, {}]), ['Borrower', 'Due']);
});
