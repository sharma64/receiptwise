'use strict';

// ---- helpers ----------------------------------------------------
const $ = (id) => document.getElementById(id);
const num = (id) => {
  const raw = $(id).value.replace(/,/g, '').trim();
  if (!raw) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
};
const fmt = (n, d = 2) => {
  if (!Number.isFinite(n)) return '–';
  const r = Math.round(n * 10 ** d) / 10 ** d;
  return r.toLocaleString('en-AU', { maximumFractionDigits: d });
};
const show = (id, html, state) => {
  const el = $(id);
  el.innerHTML = html;
  el.className = 'result' + (state ? ' ' + state : '');
};

// ---- tab navigation ---------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const go = tab.dataset.go;
    document.querySelectorAll('[data-screen]').forEach((s) => (s.hidden = s.id !== go));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    window.scrollTo(0, 0);
  });
});

// ---- Ohm's law / power wheel ------------------------------------
const ohmInputs = ['ohm-v', 'ohm-i', 'ohm-r', 'ohm-p'];
ohmInputs.forEach((id) => $(id).addEventListener('input', () => delete $(id).dataset.derived));

function calcOhms() {
  const entered = {
    V: $('ohm-v').dataset.derived ? null : num('ohm-v'),
    I: $('ohm-i').dataset.derived ? null : num('ohm-i'),
    R: $('ohm-r').dataset.derived ? null : num('ohm-r'),
    P: $('ohm-p').dataset.derived ? null : num('ohm-p'),
  };
  const result = SparkitCalculators.solveOhms(entered);
  if (!result.ok) return show('ohm-result', result.message, 'bad');
  const values = { V: ['ohm-v', result.V], I: ['ohm-i', result.I], R: ['ohm-r', result.R], P: ['ohm-p', result.P] };
  Object.entries(values).forEach(([key, [id, value]]) => {
    $(id).value = fmt(value, 3);
    if (entered[key] === null) $(id).dataset.derived = 'true';
    else delete $(id).dataset.derived;
  });
  show('ohm-result',
    `<b>${fmt(result.V, 2)} V</b> · <b>${fmt(result.I, 3)} A</b> · <b>${fmt(result.R, 2)} Ω</b> · <b>${fmt(result.P, 2)} W</b>`,
    'ok');
}

// ---- Voltage drop solver (any 3 -> 4th) -------------------------
function calcVdrop() {
  const solveFor = $('vd-solve').value;
  const result = SparkitCalculators.solveVoltageDrop({
    solveFor, drop: num('vd-vd'), current: num('vd-i'), length: num('vd-l'),
    mvPerAmpPerM: num('vd-k'), nominal: num('vd-nominal'), limitPct: num('vd-limit'),
  });
  if (!result.ok) return show('vd-result', result.message, 'bad');
  const output = { vd: ['vd-vd', 'Voltage drop', 'V', 2], i: ['vd-i', 'Current', 'A', 2], l: ['vd-l', 'Route length', 'm', 2], k: ['vd-k', 'Required mV/A/m', 'mV/A/m', 3] }[solveFor];
  $(output[0]).value = fmt(result.result, output[3]);
  let extra = result.percentage === null ? '' : `\nDrop = ${fmt(result.percentage, 2)}% of ${fmt(num('vd-nominal'), 0)}V`;
  if (result.comparison !== null) extra += result.comparison
    ? ` — <span class="tag-ok">within your ${fmt(num('vd-limit'), 1)}% comparison</span>`
    : ` — <span class="tag-bad">exceeds your ${fmt(num('vd-limit'), 1)}% comparison</span>`;
  else if (result.percentage !== null) extra += ' — add a job/standard comparison if needed.';
  show('vd-result', `<b>${output[1]}: ${fmt(result.result, output[3])} ${output[2]}</b>${extra}`, result.comparison === false ? 'bad' : result.comparison === true ? 'ok' : '');
}

// keep nominal voltage in step with phase choice
$('vd-phase').addEventListener('change', (e) => {
  $('vd-nominal').value = e.target.value === 'three' ? '400' : '230';
});

// ---- Three-phase ------------------------------------------------
function calcThree() {
  const VL = num('tp-vl'), IL = num('tp-il'), pf = num('tp-pf');
  const result = SparkitCalculators.threePhase({ lineVoltage: VL, lineCurrent: IL, powerFactor: pf });
  if (!result.ok) return show('tp-result', result.message, 'bad');
  $('tp-vph').value = fmt(result.phaseVoltage, 1);
  if (result.real === null) {
    return show('tp-result', `<b>Apparent power S = ${fmt(result.apparent / 1000, 2)} kVA</b>\nWye phase voltage = ${fmt(result.phaseVoltage, 1)} V\nAdd a power factor for kW / kVAR.`, 'ok');
  }
  show('tp-result',
    `<b>P = ${fmt(result.real / 1000, 2)} kW</b> · S = ${fmt(result.apparent / 1000, 2)} kVA · Q = ${fmt(result.reactive / 1000, 2)} kVAR\nWye phase voltage = ${fmt(result.phaseVoltage, 1)} V · pf ${fmt(pf, 2)}`,
    'ok');
}

// ---- Conduit fill -----------------------------------------------
const cfWrap = $('cf-cables');
function addCable(d = '') {
  const row = document.createElement('div');
  row.className = 'cable-row';
  row.innerHTML =
    `<label>Cable Ø <span>mm (overall)</span>
       <input type="text" inputmode="decimal" class="cf-d" placeholder="e.g. 7.4" value="${d}" /></label>
     <button type="button" aria-label="Remove cable">✕</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  cfWrap.appendChild(row);
}
$('cf-add').addEventListener('click', () => addCable());
addCable(); addCable(); // start with two

function calcConduit() {
  const ds = [...document.querySelectorAll('.cf-d')]
    .map((el) => parseFloat(el.value)).filter((v) => Number.isFinite(v) && v > 0);
  const result = SparkitCalculators.conduitFill({ internalDiameter: num('cf-id'), cableDiameters: ds });
  if (!result.ok) return show('cf-result', result.message, 'bad');
  show('cf-result',
    `<b>Geometric fill = ${fmt(result.fillPercent, 1)}%</b> (${ds.length} cable${ds.length > 1 ? 's' : ''})\nCable area ${fmt(result.cableArea, 1)} mm² of conduit area ${fmt(result.conduitArea, 1)} mm²\nCheck the applicable enclosure/space-factor rule before using this result.`,
    '');
}

// ---- Deratings --------------------------------------------------
function calcDerate() {
  const base = num('dr-base'), load = num('dr-load');
  const ka = num('dr-ka') ?? 1, kg = num('dr-kg') ?? 1, ki = num('dr-ki') ?? 1, ko = num('dr-ko') ?? 1;
  const result = SparkitCalculators.derating({ base, load, factors: [ka, kg, ki, ko] });
  if (!result.ok) return show('dr-result', result.message, 'bad');
  let line = `<b>Corrected capacity = ${fmt(result.capacity, 1)} A</b>\nBase ${fmt(base, 1)} A × ${fmt(ka, 2)} × ${fmt(kg, 2)} × ${fmt(ki, 2)} × ${fmt(ko, 2)}`;
  if (load !== null) {
    line += `\nDesign load ${fmt(load, 1)} A — ` +
      (result.comparison ? '<span class="tag-ok">capacity is above this load</span>' : '<span class="tag-bad">capacity is below this load</span>') +
      '\nThis is a numerical comparison; confirm cable selection requirements.';
    return show('dr-result', line, result.comparison ? 'ok' : 'bad');
  }
  show('dr-result', line, '');
}

// ---- wiring buttons ---------------------------------------------
const calcs = { ohms: calcOhms, vdrop: calcVdrop, three: calcThree, conduit: calcConduit, derate: calcDerate };
document.querySelectorAll('[data-calc]').forEach((b) =>
  b.addEventListener('click', () => calcs[b.dataset.calc]()));

const clearSets = {
  ohms: ['ohm-v', 'ohm-i', 'ohm-r', 'ohm-p', 'ohm-result'],
  vdrop: ['vd-vd', 'vd-i', 'vd-l', 'vd-k', 'vd-result'],
  three: ['tp-vl', 'tp-il', 'tp-pf', 'tp-vph', 'tp-result'],
  conduit: ['cf-id', 'cf-result'],
  derate: ['dr-base', 'dr-load', 'dr-result'],
};
document.querySelectorAll('[data-clear]').forEach((b) =>
  b.addEventListener('click', () => {
    (clearSets[b.dataset.clear] || []).forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (el.classList.contains('result')) { el.innerHTML = ''; el.className = 'result'; }
      else el.value = '';
      delete el.dataset?.derived;
    });
    if (b.dataset.clear === 'derate') ['dr-ka', 'dr-kg', 'dr-ki', 'dr-ko'].forEach((id) => ($(id).value = '1.00'));
  }));

// ---- Ask a standard ---------------------------------------------
// Signposts only: point to the standard + clause and give light orientation.
// Deliberately does NOT hand over the regulated figures — apprentices read,
// learn, and the licensed person carries final responsibility.
const KB = [
  { q: 'Maximum voltage drop allowed?', topic: 'Voltage drop limits',
    std: 'AS/NZS 3000 — Clause 3.6.2', tool: 'vdrop',
    gist: 'The maximum permissible voltage drop and how it is shared across the installation.',
    keys: 'voltage drop volt drop vd percent max limit run length' },
  { q: 'RCD required on power points / lighting?', topic: 'Additional protection (RCDs)',
    std: 'AS/NZS 3000 — Section 2.6',
    gist: 'Which final subcircuits need RCD protection and the maximum trip current.',
    keys: 'rcd safety switch power point gpo socket lighting protection trip ma' },
  { q: 'Cable identification colours', topic: 'Conductor identification',
    std: 'AS/NZS 3000 — Clause 3.8',
    gist: 'Approved colours for active, neutral and earth, including three-phase.',
    keys: 'cable colour color active neutral earth phase identification wire' },
  { q: 'Conduit fill / cable space factor', topic: 'Wiring enclosures — space factor',
    std: 'AS/NZS 3000 — Section 3', tool: 'conduit',
    gist: 'Permissible cable space factor for the number of cables in an enclosure.',
    keys: 'conduit fill space factor enclosure how many cables duct' },
  { q: 'Automatic disconnection times', topic: 'Earth fault — disconnection times',
    std: 'AS/NZS 3000 — Section 1.5 & Section 5',
    gist: 'Required disconnection times by circuit type and earthing arrangement.',
    keys: 'disconnection time fault clearance seconds earthing loop impedance' },
  { q: 'What does an IP rating mean?', topic: 'Ingress protection ratings',
    std: 'AS 60529',
    gist: 'What each IP digit certifies against solids/dust and against water.',
    keys: 'ip rating ingress protection dust water ip65 ip66 ip44 degrees' },
  { q: 'Standard supply voltages (single / three phase)', topic: 'Standard voltages',
    std: 'AS 60038', tool: 'three',
    gist: 'Nominal supply voltages and the line-to-phase relationship.',
    keys: 'voltage 230 400 415 single three phase nominal supply line' },
  { q: 'GPO / switch mounting heights', topic: 'Mounting heights & accessibility',
    std: 'AS/NZS 3000 + AS 1428.1',
    gist: '3000 sets no general height; AS 1428.1 governs accessible heights — check the job spec.',
    keys: 'gpo height power point switch socket mounting accessible 1428' },
  { q: 'Main earthing conductor sizing', topic: 'Earthing — conductor sizing',
    std: 'AS/NZS 3000 — Section 5 (Table 5.1)',
    gist: 'Sizing the main earthing conductor from the active conductor size.',
    keys: 'earth size main earthing conductor protective ground table 5.1 men' },
  { q: 'Maximum demand (domestic)', topic: 'Maximum demand assessment',
    std: 'AS/NZS 3000 — Appendix C',
    gist: 'The assessment (column) method for maximum demand by load group.',
    keys: 'maximum demand max demand load assessment domestic column method' },
  { q: 'Cable current-carrying capacity / sizing', topic: 'Current-carrying capacity',
    std: 'AS/NZS 3008.1.1', tool: 'conduit',
    gist: 'Base current ratings, then derating for temperature, grouping and install method.',
    keys: 'cable size current carrying capacity ccc rating ampacity derate 3008' },
  { q: 'Minimum cable size for a circuit', topic: 'Selecting cable size',
    std: 'AS/NZS 3008 + AS/NZS 3000', tool: 'vdrop',
    gist: 'Driven by current-carrying capacity AND voltage drop for the actual load.',
    keys: 'minimum cable size lighting power 2.5 1.5 csa select circuit' },
  { q: 'MEN / earthing system requirements', topic: 'Earthing system (MEN)',
    std: 'AS/NZS 3000 — Section 5',
    gist: 'Multiple Earthed Neutral system requirements and connections.',
    keys: 'men earthing system neutral earth bond section 5 equipotential' },
  { q: 'Power factor explained', topic: 'Power factor fundamentals',
    std: 'Fundamentals (no single clause)', tool: 'three',
    gist: 'Real vs apparent power; power factor = cosφ.',
    keys: 'power factor cos phi kw kva reactive' },
];

const TOOL_NAMES = { vdrop: 'Voltage Drop', three: 'Three-Phase', conduit: 'Conduit & Deratings', ohms: "Ohm's Law" };
const askInput = $('ask-input');
const askResults = $('ask-results');

function askSearch(q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return KB
    .map((e) => {
      const hay = (e.q + ' ' + e.topic + ' ' + e.keys).toLowerCase();
      return { e, score: tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.e);
}

function askRenderList(list) {
  if (!list.length) {
    askResults.innerHTML = '<div class="ask-sug" data-empty>No match yet — try “voltage drop”, “RCD”, “conduit”, “colours”, “earthing”.</div>';
  } else {
    askResults.innerHTML = list
      .map((e) => `<div class="ask-sug" data-i="${KB.indexOf(e)}"><span class="sug-q">${e.q}</span><span class="sug-std">${e.std}</span></div>`)
      .join('');
  }
  askResults.hidden = false;
}

function askRenderAnswer(e) {
  const openBtn = e.tool
    ? `<button class="btn open" data-open="${e.tool}">Open ${TOOL_NAMES[e.tool]} calc →</button>`
    : '';
  askResults.innerHTML =
    `<div class="ask-answer">
       <p class="topic">${e.topic}</p>
       <p class="std">📖 ${e.std}</p>
       <p class="gist">${e.gist}</p>
       ${openBtn}
       <p class="own">Read the clause and learn it — once you're licensed this is yours to know, and final responsibility always sits with the licensed person.</p>
     </div>`;
  askResults.hidden = false;
}

askInput.addEventListener('input', () => {
  const q = askInput.value.trim();
  if (q.length < 2) { askResults.hidden = true; askResults.innerHTML = ''; return; }
  askRenderList(askSearch(q));
});
askInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    const top = askSearch(askInput.value.trim())[0];
    if (top) askRenderAnswer(top);
  }
});
askResults.addEventListener('click', (ev) => {
  ev.stopPropagation(); // keep the "tap outside to close" handler from firing on our own clicks
  const sug = ev.target.closest('.ask-sug');
  if (sug && sug.dataset.i !== undefined) return askRenderAnswer(KB[+sug.dataset.i]);
  const open = ev.target.closest('[data-open]');
  if (open) {
    document.querySelector(`.tab[data-go="${open.dataset.open}"]`).click();
    askResults.hidden = true;
    askInput.value = '';
  }
});
document.addEventListener('click', (ev) => {
  if (!$('ask').contains(ev.target)) askResults.hidden = true;
});

// ---- service worker (offline) -----------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
