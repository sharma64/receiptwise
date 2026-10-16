'use strict';

// Small, pure helpers for the browser sync outbox. Keep revision metadata
// device-local: it must never be sent to a compatible receipts server.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ReceiptWiseSync = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const revisionOf = (record) => Number.isSafeInteger(record?._rev) && record._rev >= 0 ? record._rev : 0;
  const markDirty = (record) => ({ ...record, _dirty: true, _rev: revisionOf(record) + 1 });
  const stripLocalMetadata = ({ _dirty, _rev, ...record }) => record;
  const shouldApplyResponse = (current, sentRevision) =>
    !current || !current._dirty || revisionOf(current) <= sentRevision;
  const removeCompletedDeletes = (pending, attempted) => {
    const done = new Set(attempted);
    return pending.filter((id) => !done.has(id));
  };
  return { revisionOf, markDirty, stripLocalMetadata, shouldApplyResponse, removeCompletedDeletes };
}));
