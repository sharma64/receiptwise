'use strict';

const assert = require('node:assert/strict');
const sync = require('../receipts/sync.js');

const original = { id: 'synthetic-1', notes: 'before', _dirty: true, _rev: 1 };
const afterEdit = sync.markDirty({ ...original, notes: 'after' });
assert.equal(afterEdit._rev, 2);
assert.equal(sync.shouldApplyResponse(afterEdit, 1), false);
assert.equal(sync.shouldApplyResponse(original, 1), true);
assert.deepEqual(sync.stripLocalMetadata(afterEdit), { id: 'synthetic-1', notes: 'after' });
assert.deepEqual(sync.removeCompletedDeletes(['a', 'b', 'c'], ['a', 'c']), ['b']);

console.log('receipt sync tests passed');
