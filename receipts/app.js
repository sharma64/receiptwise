'use strict';

// ---- helpers ----------------------------------------------------
const $ = (id) => document.getElementById(id);
const money = (n, cur = 'AUD') => {
  if (!Number.isFinite(n)) return '–';
  try { return n.toLocaleString('en-AU', { style: 'currency', currency: cur }); }
  catch { return `${cur} ${n.toFixed(2)}`; }
};
const monthKey = (dateStr) => (dateStr && /^\d{4}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 7) : 'unknown';
const monthLabel = (key) => {
  if (key === 'unknown') return 'No date';
  const [y, m] = key.split('-');
  return new Date(+y, +m - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
};
// Australian financial year: 1 Jul – 30 Jun. A month in Jul–Dec belongs to the
// FY that starts that year; Jan–Jun belongs to the FY that started the year before.
const fyStart = (monthK) => {
  if (monthK === 'unknown') return null;
  const [y, m] = monthK.split('-').map(Number);
  return m >= 7 ? y : y - 1;
};
const fyLabel = (startY) => `FY ${startY}–${String(startY + 1).slice(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORIES = [
  'Tools', 'Materials', 'Fuel', 'Vehicle', 'PPE & Workwear',
  'Food & Drink', 'Training', 'Office & Admin', 'Home Building', 'Other',
];

// ---- tab navigation ---------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const go = tab.dataset.go;
    document.querySelectorAll('[data-screen]').forEach((s) => (s.hidden = s.id !== go));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    window.scrollTo(0, 0);
    if (go === 'list') renderList();
    if (go === 'items') renderItems();
    if (go === 'totals') renderTotals();
    if (go === 'scan') refreshServerUi();
  });
});

function show(id, html, state) {
  const el = $(id);
  el.innerHTML = html;
  el.className = 'result' + (state ? ' ' + state : '');
}

function refreshServerUi() {
  const srv = !!getServer();
  $('no-server-warning').hidden = srv || !!getKey();
  const region = $('data-region');
  region.textContent = srv ? 'synced with server' : 'not connected';
  region.title = srv ? 'Data is synced with your connected server' : 'Connect a server in Settings to scan and sync';
}

// ---- storage: optional extraction-fallback API key -----------------
const KEY_STORE = 'receipts.apiKey';
const getKey = () => localStorage.getItem(KEY_STORE) || '';

$('btn-save-key').addEventListener('click', () => {
  const v = $('set-key').value.trim();
  if (!v) return show('key-status', 'Paste a key first.', 'bad');
  localStorage.setItem(KEY_STORE, v);
  show('key-status', 'Fallback key saved on this device.', 'ok');
});
$('btn-clear-key').addEventListener('click', () => {
  localStorage.removeItem(KEY_STORE);
  $('set-key').value = '';
  show('key-status', 'Fallback key removed.', 'ok');
});

// ---- storage: sync server -----------------------------------------
const SRV_URL = 'receipts.serverUrl';
const SRV_TOKEN = 'receipts.serverToken';
const SRV_DELETES = 'receipts.pendingDeletes';
const DEFAULT_SERVER_URL = `${location.origin}/api`;

const getServer = () => {
  const url = (localStorage.getItem(SRV_URL) || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const token = localStorage.getItem(SRV_TOKEN) || '';
  return url ? { url, token } : null;
};
const pendingDeletes = () => JSON.parse(localStorage.getItem(SRV_DELETES) || '[]');
const setPendingDeletes = (ids) => localStorage.setItem(SRV_DELETES, JSON.stringify(ids));
const queueDelete = (id) => setPendingDeletes([...new Set([...pendingDeletes(), id])]);

async function serverFetch(path, opts = {}) {
  const srv = getServer();
  if (!srv) throw new Error('No server configured.');
  const headers = { ...(opts.headers || {}) };
  if (srv.token) headers.authorization = `Bearer ${srv.token}`;
  const res = await fetch(srv.url + path, {
    ...opts,
    credentials: 'same-origin',
    headers,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `server error ${res.status}`);
  return body;
}

async function refreshLoginState() {
  const srv = getServer();
  const el = $('login-status');
  if (!srv || !el) return false;
  try {
    const res = await fetch(srv.url + '/session', { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    const ok = !!(res.ok && body?.ok);
    el.textContent = ok ? `Signed in as ${body.user || 'user'} — sync ready.` : 'Not signed in.';
    el.className = 'result ' + (ok ? 'ok' : 'bad');
    refreshServerUi();
    return ok;
  } catch (err) {
    el.textContent = `Could not check sign-in: ${err.message}`;
    el.className = 'result bad';
    return false;
  }
}

// Push dirty records and queued deletions, then pull the server's view.
// The server (fed by Ledger) is the source of truth for anything not
// locally dirty; local thumbnails are kept when the server has none.
let syncing = false;
async function syncNow() {
  if (!getServer() || syncing) return false;
  syncing = true;
  try {
    for (const r of (await dbAll()).filter((x) => x._dirty)) {
      const { _dirty, ...rec } = r;
      const { receipt } = await serverFetch('/receipts/upsert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec),
      });
      await dbPut({ ...receipt, thumb: receipt.thumb || rec.thumb || '' });
    }
    for (const id of pendingDeletes()) {
      await serverFetch(`/receipts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
    setPendingDeletes([]);

    const { receipts } = await serverFetch('/receipts');
    const localById = new Map((await dbAll()).map((r) => [r.id, r]));
    const serverIds = new Set(receipts.map((r) => r.id));
    for (const r of receipts) {
      const mine = localById.get(r.id);
      if (mine?._dirty) continue;
      if (!r.thumb && mine?.thumb) r.thumb = mine.thumb;
      await dbPut(r);
    }
    for (const [id, r] of localById) {
      if (!serverIds.has(id) && !r._dirty) await dbDelete(id);
    }
    return true;
  } finally {
    syncing = false;
  }
}

// Fire-and-forget sync after local changes; failures wait for the next one.
const syncSoon = () => { if (getServer()) syncNow().catch(() => {}); };

$('btn-save-server').addEventListener('click', async () => {
  const url = ($('set-server').value.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const token = $('set-token').value.trim();
  if (!url) return show('server-status', 'Enter the server URL.', 'bad');
  localStorage.setItem(SRV_URL, url);
  if (token) localStorage.setItem(SRV_TOKEN, token);
  else localStorage.removeItem(SRV_TOKEN);
  refreshServerUi();
  show('server-status', 'Connecting…');
  try {
    // Mark everything local for push so nothing is lost on first sync.
    for (const r of await dbAll()) {
      if (!r._dirty) { r._dirty = true; await dbPut(r); }
    }
    await syncNow();
    show('server-status', 'Connected — synced.', 'ok');
    renderList();
  } catch (err) {
    show('server-status', `Could not connect: ${esc(err.message)}`, 'bad');
  }
});
$('btn-login-server').addEventListener('click', async () => {
  const url = ($('set-server').value.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const username = $('set-username').value.trim();
  const password = $('set-password').value;
  if (!username || !password) return show('login-status', 'Enter username and password.', 'bad');
  localStorage.setItem(SRV_URL, url);
  localStorage.setItem('receipts.username', username);
  localStorage.removeItem(SRV_TOKEN);
  show('login-status', 'Signing in…');
  try {
    const res = await fetch(url + '/session/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `server error ${res.status}`);
    $('set-password').value = '';
    show('login-status', 'Signed in — syncing…', 'ok');
    await syncNow();
    show('login-status', 'Signed in — synced.', 'ok');
    renderList();
  } catch (err) {
    show('login-status', `Sign-in failed: ${esc(err.message)}`, 'bad');
  }
});
$('btn-logout-server').addEventListener('click', async () => {
  const srv = getServer();
  if (!srv) return;
  await fetch(srv.url + '/session/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  show('login-status', 'Signed out on this device.', 'ok');
});
$('btn-clear-server').addEventListener('click', () => {
  localStorage.removeItem(SRV_URL);
  localStorage.removeItem(SRV_TOKEN);
  $('set-server').value = '';
  $('set-token').value = '';
  refreshServerUi();
  show('server-status', 'Server removed — scanning is disabled until reconnected.', 'ok');
});
$('btn-sync').addEventListener('click', async () => {
  if (!getServer()) return show('server-status', 'Add the server URL and token first.', 'bad');
  show('server-status', 'Syncing…');
  try {
    await syncNow();
    show('server-status', `Synced at ${new Date().toLocaleTimeString('en-AU')}.`, 'ok');
    renderList();
  } catch (err) {
    show('server-status', `Sync failed: ${esc(err.message)}`, 'bad');
  }
});

// ---- storage: IndexedDB -----------------------------------------
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sparkkit-receipts', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('receipts', { keyPath: 'id' });
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
const store = (mode) => db.transaction('receipts', mode).objectStore('receipts');
const dbPut = (r) => new Promise((res, rej) => {
  const q = store('readwrite').put(r); q.onsuccess = () => res(); q.onerror = () => rej(q.error);
});
const dbAll = () => new Promise((res, rej) => {
  const q = store('readonly').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
});
const dbDelete = (id) => new Promise((res, rej) => {
  const q = store('readwrite').delete(id); q.onsuccess = () => res(); q.onerror = () => rej(q.error);
});
const dbClear = () => new Promise((res, rej) => {
  const q = store('readwrite').clear(); q.onsuccess = () => res(); q.onerror = () => rej(q.error);
});

// ---- image processing -------------------------------------------
async function loadScaled(file, maxEdge, quality) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvas.toDataURL('image/jpeg', quality);
}

// ---- AI extraction ----------------------------------------------
// Same contract as the server's contract.py — keep the two in lockstep.
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    is_receipt: { type: 'boolean', description: 'False if the image is not a receipt, invoice or till docket.' },
    merchant: { type: 'string', description: 'Store or business name. Empty string if unreadable.' },
    date: { anyOf: [{ type: 'string', description: 'Purchase date, YYYY-MM-DD.' }, { type: 'null' }] },
    total: { anyOf: [{ type: 'number', description: 'Grand total paid.' }, { type: 'null' }] },
    gst: { anyOf: [{ type: 'number', description: 'GST / tax component if printed.' }, { type: 'null' }] },
    currency: { type: 'string', description: 'ISO 4217 code, e.g. AUD. Assume AUD if not shown.' },
    category: { type: 'string', enum: CATEGORIES },
    payment_method: { anyOf: [{ type: 'string', description: 'e.g. EFTPOS, Visa …1234, cash.' }, { type: 'null' }] },
    items: {
      type: 'array',
      description: 'Line items. Omit loyalty and subtotal lines.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        },
        required: ['description', 'amount'],
        additionalProperties: false,
      },
    },
    notes: { anyOf: [{ type: 'string', description: 'Anything unclear or worth flagging.' }, { type: 'null' }] },
  },
  required: ['is_receipt', 'merchant', 'date', 'total', 'gst', 'currency', 'category', 'payment_method', 'items', 'notes'],
  additionalProperties: false,
};

const PROMPT =
  'Extract the data from this receipt photo. The user is an Australian electrical ' +
  'apprentice organising work expenses and home building expenses. Pick the category ' +
  'that best matches the purchase. If a value is not printed or not readable, use null ' +
  'rather than guessing.';

// Optional last resort when the server can't extract (see Settings →
// Advanced): call the Claude API directly with the fallback key.
async function anthropicExtract(imageDataUrl) {
  const b64 = imageDataUrl.split(',')[1];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': getKey(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  if (body.stop_reason === 'refusal') throw new Error('The model declined to process this image.');
  if (body.stop_reason === 'max_tokens') throw new Error('Response was cut off — try a clearer photo.');
  const text = body.content?.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('No data returned.');
  return JSON.parse(text);
}

async function extractReceipt(imageDataUrl) {
  try {
    return (await serverFetch('/receipts/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl }),
    })).extraction;
  } catch (err) {
    if (!getKey()) throw err;
    return anthropicExtract(imageDataUrl);
  }
}

// ---- line items --------------------------------------------------
// Same stored shape as receipts/items.py — keep the two in lockstep.
// `category: null` means "same as the receipt"; `excluded` is a junk line
// (loyalty, subtotal) kept on the record but left out of item totals.
const newItemId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

function normaliseItem(raw, source = 'extract') {
  if (typeof raw === 'string') raw = { description: raw };
  if (!raw || typeof raw !== 'object') return null;
  const description = String(raw.description ?? '').trim();
  const amount = Number.isFinite(Number(raw.amount)) && raw.amount !== null && raw.amount !== ''
    ? Number(raw.amount) : null;
  if (!description && amount === null) return null;
  return {
    id: String(raw.id || '') || newItemId(),
    description: description || 'Unnamed item',
    amount,
    qty: Number.isFinite(Number(raw.qty)) && raw.qty !== null && raw.qty !== '' ? Number(raw.qty) : null,
    category: CATEGORIES.includes(raw.category) ? raw.category : null,
    excluded: !!raw.excluded,
    source: ['extract', 'notes', 'manual'].includes(raw.source) ? raw.source : source,
  };
}

const normaliseItems = (list, source) =>
  (Array.isArray(list) ? list : []).map((i) => normaliseItem(i, source)).filter(Boolean);

// Flatten receipts into item rows carrying their receipt's context.
function itemRows(receipts) {
  const rows = [];
  for (const r of receipts) {
    for (const item of normaliseItems(r.items)) {
      rows.push({
        ref: `${r.id}:${item.id}`,
        receiptId: r.id,
        itemId: item.id,
        date: r.date,
        merchant: r.merchant,
        currency: r.currency || 'AUD',
        receiptCategory: r.category || 'Other',
        description: item.description,
        amount: item.amount,
        qty: item.qty,
        category: item.category,
        effectiveCategory: item.category || r.category || 'Other',
        excluded: item.excluded,
        source: item.source,
      });
    }
  }
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') ||
    (a.merchant || '').localeCompare(b.merchant || ''));
}

// ---- scan flow ---------------------------------------------------
$('btn-camera').addEventListener('click', () => {
  $('file-input').setAttribute('capture', 'environment');
  $('file-input').click();
});
$('btn-gallery').addEventListener('click', () => {
  $('file-input').removeAttribute('capture');
  $('file-input').click();
});

$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (!getServer() && !getKey()) {
    $('no-server-warning').hidden = false;
    return show('scan-status', 'Add your server URL and token in Settings first.', 'bad');
  }

  show('scan-status', `Processing ${files.length} photo${files.length > 1 ? 's' : ''}…`);
  const queue = $('scan-queue');
  queue.innerHTML = '';
  let saved = 0, failed = 0;

  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'q-item';
    row.innerHTML = '<img alt="" /><span class="q-name"></span><span class="q-state">reading…</span>';
    queue.appendChild(row);
    const state = row.querySelector('.q-state');
    try {
      const thumb = await loadScaled(file, 240, 0.7);
      row.querySelector('img').src = thumb;
      state.textContent = 'extracting…';
      const full = await loadScaled(file, 1568, 0.85);
      const data = await extractReceipt(full);
      if (!data.is_receipt) {
        row.classList.add('fail');
        state.textContent = 'not a receipt — skipped';
        failed++;
        continue;
      }
      const record = {
        id: crypto.randomUUID(),
        added: new Date().toISOString(),
        thumb,
        merchant: data.merchant || 'Unknown merchant',
        date: data.date,
        total: data.total,
        gst: data.gst,
        currency: data.currency || 'AUD',
        category: CATEGORIES.includes(data.category) ? data.category : 'Other',
        payment_method: data.payment_method,
        items: normaliseItems(data.items),
        notes: data.notes,
        _dirty: true,
      };
      await dbPut(record);
      row.classList.add('done');
      row.querySelector('.q-name').textContent = record.merchant;
      state.textContent = `${money(record.total, record.currency)} ✓`;
      saved++;
    } catch (err) {
      row.classList.add('fail');
      state.textContent = err.message.slice(0, 80);
      failed++;
    }
  }

  show('scan-status',
    `<b>${saved}</b> saved` + (failed ? `, ${failed} skipped/failed` : '') +
    (saved ? ' — see the Receipts tab.' : ''),
    failed && !saved ? 'bad' : 'ok');
  if (saved) syncSoon();
});

// ---- receipts list -----------------------------------------------
let cache = [];   // all receipts, refreshed on demand
let currentView = [];

async function refreshCache() {
  cache = await dbAll();
  // Give older locally-cached receipts the current item shape (stable item
  // ids above all — edits address items by id). The server reconciles its own
  // ids on the next pull.
  for (const r of cache) {
    const list = normaliseItems(r.items);
    if (JSON.stringify(list) !== JSON.stringify(r.items ?? [])) {
      r.items = list;
      await dbPut(r);
    }
  }
  // newest date first; undated last
  cache.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function fillSelect(sel, values, current, labelFn = (v) => v) {
  sel.innerHTML = '<option value="">All</option>' +
    values.map((v) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(labelFn(v))}</option>`).join('');
}

async function renderList() {
  await refreshCache();
  const months = [...new Set(cache.map((r) => monthKey(r.date)))];
  fillSelect($('flt-month'), months, $('flt-month').value, monthLabel);
  fillSelect($('flt-cat'), CATEGORIES.filter((c) => cache.some((r) => r.category === c)), $('flt-cat').value);

  const q = $('flt-search').value.trim().toLowerCase();
  const m = $('flt-month').value;
  const c = $('flt-cat').value;

  currentView = cache.filter((r) => {
    if (m && monthKey(r.date) !== m) return false;
    if (c && r.category !== c) return false;
    if (q) {
      const hay = [r.merchant, r.category, r.notes, r.payment_method, ...(r.items || []).map((i) => i.description)]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const total = currentView.reduce((s, r) => s + (Number.isFinite(r.total) ? r.total : 0), 0);
  $('list-count').textContent = cache.length
    ? `${currentView.length} of ${cache.length} receipts · ${money(total)}`
    : 'No receipts yet — scan one from the first tab.';

  $('receipt-list').innerHTML = currentView.length
    ? currentView.map((r) => `
        <div class="r-row" data-id="${r.id}">
          <img src="${r.thumb}" alt="" />
          <div class="r-main">
            <div class="r-merchant">${esc(r.merchant)}</div>
            <div class="r-meta">${esc(r.date || 'no date')} · ${esc(r.category)}</div>
          </div>
          <div class="r-total">${money(r.total, r.currency)}</div>
        </div>`).join('')
    : '<p class="r-empty">Nothing matches the current filters.</p>';
}

['flt-search', 'flt-month', 'flt-cat'].forEach((id) =>
  $(id).addEventListener('input', () => renderList()));

$('receipt-list').addEventListener('click', (e) => {
  const row = e.target.closest('.r-row');
  if (row) openDetail(row.dataset.id);
});

// ---- detail / edit -----------------------------------------------
let editing = null;

function openDetail(id) {
  editing = cache.find((r) => r.id === id);
  if (!editing) return;
  $('d-thumb').src = editing.thumb || '';
  $('d-merchant').value = editing.merchant || '';
  $('d-date').value = editing.date || '';
  $('d-total').value = editing.total ?? '';
  $('d-gst').value = editing.gst ?? '';
  $('d-cat').innerHTML = CATEGORIES.map((c) =>
    `<option${c === editing.category ? ' selected' : ''}>${c}</option>`).join('');
  $('d-payment').value = editing.payment_method || '';
  $('d-notes').value = editing.notes || '';
  renderDetailItems();
  $('detail').showModal();
}

// Items on the open receipt: tap one to categorise it or ignore a junk line.
function renderDetailItems() {
  if (!editing) return;
  const rows = itemRows([editing]);
  $('d-items').innerHTML = rows.length
    ? rows.map((row) => `
        <div class="d-item${row.excluded ? ' ignored' : ''}" data-ref="${row.ref}">
          <span>${esc(row.description)} ${categoryChip(row)}</span>
          <span>${row.amount === null ? '' : money(row.amount, row.currency)}</span>
        </div>`).join('')
    : '<p class="r-empty">No line items on this receipt.</p>';
}

$('d-items').addEventListener('click', (e) => {
  const row = e.target.closest('.d-item');
  if (row) openItemDetail(row.dataset.ref);
});

// Extracted fields are locked — only category and notes can be changed.
$('d-save').addEventListener('click', async () => {
  if (!editing) return;
  Object.assign(editing, {
    category: $('d-cat').value,
    notes: $('d-notes').value.trim() || null,
    _dirty: true,
  });
  await dbPut(editing);
  $('detail').close();
  renderList();
  syncSoon();
});

$('d-delete').addEventListener('click', async () => {
  if (!editing) return;
  if (!confirm('Delete this receipt?')) return;
  await dbDelete(editing.id);
  if (getServer()) queueDelete(editing.id);
  $('detail').close();
  renderList();
  syncSoon();
});

$('d-close').addEventListener('click', () => $('detail').close());

// ---- items screen --------------------------------------------------
// A bare chip is the item's own category; a bracketed one is inherited from
// the receipt, i.e. nobody has looked at this line yet.
const categoryChip = (row) => row.category
  ? `<span class="chip">${esc(row.category)}</span>`
  : `<span class="chip inherit">(${esc(row.receiptCategory)})</span>`;

let itemView = [];   // rows currently shown

const findItemRow = (ref) => itemRows(cache).find((r) => r.ref === ref);

async function renderItems() {
  await refreshCache();
  const rows = itemRows(cache);
  const months = [...new Set(rows.map((r) => monthKey(r.date)))];
  fillSelect($('iflt-month'), months, $('iflt-month').value, monthLabel);
  fillSelect($('iflt-cat'), CATEGORIES.filter((c) => rows.some((r) => r.effectiveCategory === c)), $('iflt-cat').value);
  if (!$('bulk-cat').options.length) {
    $('bulk-cat').innerHTML = '<option value="">Same as the receipt</option>' +
      CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  }

  const q = $('iflt-search').value.trim().toLowerCase();
  const m = $('iflt-month').value;
  const c = $('iflt-cat').value;
  const view = $('iflt-view').value;

  itemView = rows.filter((r) => {
    if (view === 'ignored' ? !r.excluded : r.excluded) return false;
    if (view === 'review' && r.category !== null) return false;
    if (view === 'noamount' && r.amount !== null) return false;
    if (m && monthKey(r.date) !== m) return false;
    if (c && r.effectiveCategory !== c) return false;
    if (q && ![r.description, r.merchant, r.effectiveCategory, r.date].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });

  const counted = itemView.filter((r) => !r.excluded);
  const total = counted.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const toReview = rows.filter((r) => !r.excluded && r.category === null).length;
  $('items-count').textContent = rows.length
    ? `${itemView.length} of ${rows.length} items · ${money(total)}` +
      (toReview ? ` · ${toReview} still need a category` : ' · all categorised')
    : 'No items yet — they arrive with each scanned receipt.';

  // Bulk categorising is only offered on a narrowed view, so a stray tap
  // can't recategorise everything at once.
  const narrowed = !!(q || m || c || view !== 'all');
  $('items-bulk').hidden = !(narrowed && itemView.length);
  $('bulk-count').textContent = itemView.length;

  $('item-list').innerHTML = itemView.length
    ? itemView.map((r) => `
        <div class="i-row${r.excluded ? ' ignored' : ''}" data-ref="${r.ref}">
          <div class="i-main">
            <div class="i-desc">${r.qty ? `${r.qty}× ` : ''}${esc(r.description)}</div>
            <div class="i-meta">${esc(r.date || 'no date')} · ${esc(r.merchant)} ${categoryChip(r)}</div>
          </div>
          <div class="i-amt">${r.amount === null ? '—' : money(r.amount, r.currency)}</div>
        </div>`).join('')
    : '<p class="r-empty">Nothing matches the current filters.</p>';
}

['iflt-search', 'iflt-month', 'iflt-cat', 'iflt-view'].forEach((id) =>
  $(id).addEventListener('input', () => renderItems()));

$('item-list').addEventListener('click', (e) => {
  const row = e.target.closest('.i-row');
  if (row) openItemDetail(row.dataset.ref);
});

// Apply changes to items in place, grouped so each receipt is written once.
async function editItems(refs, changes) {
  const byReceipt = new Map();
  for (const ref of refs) {
    const [receiptId, itemId] = ref.split(':');
    byReceipt.set(receiptId, [...(byReceipt.get(receiptId) || []), itemId]);
  }
  let changed = 0;
  for (const [receiptId, itemIds] of byReceipt) {
    const receipt = cache.find((r) => r.id === receiptId);
    if (!receipt) continue;
    const list = normaliseItems(receipt.items);
    for (const item of list) {
      if (!itemIds.includes(item.id)) continue;
      if ('category' in changes) item.category = CATEGORIES.includes(changes.category) ? changes.category : null;
      if ('excluded' in changes) item.excluded = !!changes.excluded;
      changed++;
    }
    receipt.items = list;
    receipt._dirty = true;
    await dbPut(receipt);
  }
  if (changed) syncSoon();
  return changed;
}

$('btn-bulk-apply').addEventListener('click', async () => {
  const refs = itemView.map((r) => r.ref);
  const category = $('bulk-cat').value;
  const label = category || 'the same category as their receipt';
  if (!refs.length) return;
  if (!confirm(`Set ${refs.length} item${refs.length > 1 ? 's' : ''} to ${label}?`)) return;
  const changed = await editItems(refs, { category });
  await renderItems();
  show('bulk-status', `${changed} item${changed === 1 ? '' : 's'} set to ${esc(label)}.`, 'ok');
});

// ---- item detail / edit ---------------------------------------------
let editingItem = null;

function openItemDetail(ref) {
  const row = findItemRow(ref);
  if (!row) return;
  editingItem = row;
  $('i-desc').textContent = row.description;
  $('i-meta').textContent = `${row.date || 'no date'} · ${row.merchant} · from the ${row.receiptCategory} receipt`;
  $('i-amount').value = row.amount === null ? 'not read' : money(row.amount, row.currency);
  $('i-cat').innerHTML = `<option value="">Same as the receipt (${esc(row.receiptCategory)})</option>` +
    CATEGORIES.map((c) => `<option${c === row.category ? ' selected' : ''}>${esc(c)}</option>`).join('');
  $('i-ignore').checked = row.excluded;
  $('item-detail').showModal();
}

$('i-save').addEventListener('click', async () => {
  if (!editingItem) return;
  await editItems([editingItem.ref], { category: $('i-cat').value, excluded: $('i-ignore').checked });
  $('item-detail').close();
  await refreshCache();
  if (editing) editing = cache.find((r) => r.id === editing.id) || editing;
  renderDetailItems();
  if (!$('items').hidden) renderItems();
});

$('i-open-receipt').addEventListener('click', () => {
  const receiptId = editingItem?.receiptId;
  $('item-detail').close();
  if (receiptId) openDetail(receiptId);
});

$('i-close').addEventListener('click', () => $('item-detail').close());

// ---- totals -------------------------------------------------------
const sum = (arr, f) => arr.reduce((s, r) => s + (Number.isFinite(f(r)) ? f(r) : 0), 0);

async function renderTotals() {
  await refreshCache();

  // Group receipts by month, and note which financial years have data.
  const byMonth = {};
  for (const r of cache) (byMonth[monthKey(r.date)] ||= []).push(r);
  const months = Object.keys(byMonth).sort().reverse();
  const fys = [...new Set(months.map(fyStart).filter((y) => y !== null))].sort((a, b) => b - a);

  // Build the period picker: financial years first (current one = year to date),
  // then individual months. Values are prefixed so we can tell them apart.
  const nowFy = fyStart(new Date().toISOString().slice(0, 7));
  const fyOpts = fys.map((y) =>
    `<option value="fy:${y}">${esc(fyLabel(y))}${y === nowFy ? ' (year to date)' : ''}</option>`).join('');
  const monthOpts = months.map((m) =>
    `<option value="m:${m}">${esc(monthLabel(m))}</option>`).join('');

  const sel = $('tot-period');
  const prev = sel.value;
  // Default to the current financial year when nothing valid is selected yet.
  const defaultVal = fys.includes(nowFy) ? `fy:${nowFy}` : (fys.length ? `fy:${fys[0]}` : (months.length ? `m:${months[0]}` : ''));
  sel.innerHTML =
    (fyOpts ? `<optgroup label="Financial year">${fyOpts}</optgroup>` : '') +
    (monthOpts ? `<optgroup label="Month">${monthOpts}</optgroup>` : '');
  const current = [...sel.options].some((o) => o.value === prev) ? prev : defaultVal;
  sel.value = current;

  // Records for the selected period, and the FY those months sit inside.
  let rs, contextFy;
  if (current.startsWith('fy:')) {
    contextFy = Number(current.slice(3));
    rs = cache.filter((r) => fyStart(monthKey(r.date)) === contextFy);
  } else if (current.startsWith('m:')) {
    const mk = current.slice(2);
    rs = byMonth[mk] || [];
    contextFy = fyStart(mk);
  } else {
    rs = []; contextFy = null;
  }

  $('tot-spend').textContent = rs.length ? money(sum(rs, (r) => r.total)) : '–';
  $('tot-gst').textContent = rs.length ? money(sum(rs, (r) => r.gst)) : '–';
  $('tot-count').textContent = rs.length || '–';

  const catTotals = CATEGORIES
    .map((c) => [c, sum(rs.filter((r) => r.category === c), (r) => r.total)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const maxCat = catTotals[0]?.[1] || 1;
  $('tot-cats').innerHTML = catTotals.map(([c, v]) => `
    <div class="bar-row">
      <span class="bar-label">${esc(c)}</span>
      <div class="bar" style="width:${Math.max(2, (v / maxCat) * 100)}%"></div>
      <span class="bar-val">${money(v)}</span>
    </div>`).join('') || '<p class="r-empty">No receipts in this period.</p>';

  // "By month" breakdown, scoped to the selected financial year (all months if
  // the selection has no date).
  const monthList = contextFy === null ? months : months.filter((m) => fyStart(m) === contextFy);
  $('tot-months-h').textContent = contextFy === null ? 'By month' : `By month · ${fyLabel(contextFy)}`;
  const maxMonth = Math.max(1, ...monthList.map((m) => sum(byMonth[m], (r) => r.total)));
  $('tot-months').innerHTML = monthList.map((m) => {
    const v = sum(byMonth[m], (r) => r.total);
    return `
      <div class="bar-row">
        <span class="bar-label">${esc(monthLabel(m))}</span>
        <div class="bar" style="width:${Math.max(2, (v / maxMonth) * 100)}%"></div>
        <span class="bar-val">${money(v)}</span>
      </div>`;
  }).join('') || '<p class="r-empty">No receipts yet.</p>';
}
$('tot-period').addEventListener('change', renderTotals);

// ---- CSV export ----------------------------------------------------
function toCSV(rows) {
  const cols = ['date', 'merchant', 'category', 'total', 'gst', 'currency', 'payment_method', 'items', 'notes'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push([
      r.date, r.merchant, r.category, r.total, r.gst, r.currency, r.payment_method,
      (r.items || []).map((i) => i.amount != null ? `${i.description} (${i.amount})` : i.description).join('; '),
      r.notes,
    ].map(cell).join(','));
  }
  return lines.join('\r\n');
}

function downloadCSV(rows, name) {
  if (!rows.length) return alert('Nothing to export.');
  const blob = new Blob(['\uFEFF' + toCSV(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function itemsCSV(rows) {
  const cols = ['date', 'merchant', 'description', 'qty', 'amount', 'currency',
    'item_category', 'receipt_category', 'excluded', 'source', 'receipt_id', 'item_id'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map((r) => [
    r.date, r.merchant, r.description, r.qty, r.amount, r.currency,
    r.category || '', r.receiptCategory, r.excluded ? 'yes' : '', r.source, r.receiptId, r.itemId,
  ].map(cell).join(','))].join('\r\n');
}

$('btn-export-items').addEventListener('click', () => {
  if (!itemView.length) return alert('Nothing to export.');
  const blob = new Blob(['\uFEFF' + itemsCSV(itemView)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `receipt-items-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('btn-export').addEventListener('click', () =>
  downloadCSV(currentView, `receipts-${new Date().toISOString().slice(0, 10)}.csv`));
$('btn-export-all').addEventListener('click', async () => {
  await refreshCache();
  downloadCSV(cache, `receipts-all-${new Date().toISOString().slice(0, 10)}.csv`);
});

// ---- danger zone ----------------------------------------------------
$('btn-wipe').addEventListener('click', async () => {
  if (!confirm('Delete ALL receipts stored on this device? Export a CSV first if you need them.')) return;
  await dbClear();
  renderList();
  alert('All receipts deleted.');
});

// ---- init -----------------------------------------------------------
openDB().then(() => {
  $('set-server').value = localStorage.getItem(SRV_URL) || DEFAULT_SERVER_URL;
  $('set-token').value = localStorage.getItem(SRV_TOKEN) || '';
  if ($('set-username')) $('set-username').value = localStorage.getItem('receipts.username') || 'sharma';
  $('set-key').value = getKey();
  refreshServerUi();
  refreshLoginState();
  if (getServer()) {
    syncNow().then(() => { if (!$('list').hidden) renderList(); }).catch(() => {});
  }
});

// ---- service worker (offline shell) ----------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
