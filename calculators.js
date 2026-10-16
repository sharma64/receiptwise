'use strict';

// Pure calculator functions. UI code owns presentation; this module owns
// numerical validation and never makes a compliance decision.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SparkitCalculators = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const finite = (value) => Number.isFinite(value);
  const positive = (value) => finite(value) && value > 0;
  const error = (message) => ({ ok: false, message });

  function solveOhms(values) {
    const supplied = Object.entries(values).filter(([, value]) => value !== null && value !== undefined);
    if (supplied.length !== 2) return error('Enter exactly two values. Change an input to replace a calculated value.');
    if (supplied.some(([, value]) => !positive(value))) return error('Voltage, current, resistance and power must be greater than zero.');
    const known = Object.fromEntries(supplied);
    let V, I, R, P;
    if (known.V && known.I) { V = known.V; I = known.I; R = V / I; P = V * I; }
    else if (known.V && known.R) { V = known.V; R = known.R; I = V / R; P = V * I; }
    else if (known.V && known.P) { V = known.V; P = known.P; I = P / V; R = V / I; }
    else if (known.I && known.R) { I = known.I; R = known.R; V = I * R; P = V * I; }
    else if (known.I && known.P) { I = known.I; P = known.P; V = P / I; R = V / I; }
    else if (known.R && known.P) { R = known.R; P = known.P; I = Math.sqrt(P / R); V = I * R; }
    if (![V, I, R, P].every(positive)) return error('That combination cannot be solved safely. Check the inputs.');
    return { ok: true, V, I, R, P };
  }

  function solveVoltageDrop({ solveFor, drop, current, length, mvPerAmpPerM, nominal, limitPct }) {
    const values = { drop, current, length, mvPerAmpPerM };
    const required = {
      drop: ['current', 'length', 'mvPerAmpPerM'],
      current: ['drop', 'length', 'mvPerAmpPerM'],
      length: ['drop', 'current', 'mvPerAmpPerM'],
      mvPerAmpPerM: ['drop', 'current', 'length'],
    }[solveFor];
    if (!required) return error('Choose a value to solve for.');
    if (required.some((key) => !positive(values[key]))) return error('Fill the other three fields with values greater than zero.');
    let result;
    if (solveFor === 'drop') result = (length * current * mvPerAmpPerM) / 1000;
    if (solveFor === 'current') result = (drop * 1000) / (length * mvPerAmpPerM);
    if (solveFor === 'length') result = (drop * 1000) / (current * mvPerAmpPerM);
    if (solveFor === 'mvPerAmpPerM') result = (drop * 1000) / (current * length);
    if (!positive(result)) return error('That combination cannot be solved safely. Check the inputs.');
    const calculatedDrop = solveFor === 'drop' ? result : drop;
    let percentage = null;
    let comparison = null;
    if (nominal !== null && nominal !== undefined) {
      if (!positive(nominal)) return error('Nominal voltage must be greater than zero.');
      percentage = (calculatedDrop / nominal) * 100;
      if (limitPct !== null && limitPct !== undefined && limitPct !== '') {
        if (!finite(limitPct) || limitPct < 0) return error('The comparison limit must be zero or greater.');
        comparison = percentage <= limitPct;
      }
    }
    return { ok: true, result, percentage, comparison };
  }

  function threePhase({ lineVoltage, lineCurrent, powerFactor }) {
    if (!positive(lineVoltage) || !positive(lineCurrent)) return error('Line voltage and line current must be greater than zero.');
    if (powerFactor !== null && powerFactor !== undefined && (!finite(powerFactor) || powerFactor <= 0 || powerFactor > 1)) {
      return error('Power factor must be greater than 0 and no more than 1.');
    }
    const apparent = Math.sqrt(3) * lineVoltage * lineCurrent;
    const phaseVoltage = lineVoltage / Math.sqrt(3);
    const real = powerFactor === null || powerFactor === undefined ? null : apparent * powerFactor;
    const reactive = real === null ? null : Math.sqrt(Math.max(apparent ** 2 - real ** 2, 0));
    return { ok: true, apparent, phaseVoltage, real, reactive };
  }

  function conduitFill({ internalDiameter, cableDiameters }) {
    if (!positive(internalDiameter)) return error('Enter a conduit internal diameter greater than zero.');
    if (!Array.isArray(cableDiameters) || !cableDiameters.length || cableDiameters.some((value) => !positive(value))) {
      return error('Add one or more cable diameters greater than zero.');
    }
    const area = (diameter) => (Math.PI / 4) * diameter ** 2;
    const conduitArea = area(internalDiameter);
    const cableArea = cableDiameters.reduce((sum, diameter) => sum + area(diameter), 0);
    return { ok: true, conduitArea, cableArea, fillPercent: (cableArea / conduitArea) * 100 };
  }

  function derating({ base, load, factors }) {
    if (!positive(base)) return error('Base current-carrying capacity must be greater than zero.');
    if (load !== null && load !== undefined && (!finite(load) || load < 0)) return error('Design load cannot be negative.');
    if (!Array.isArray(factors) || factors.some((value) => !positive(value))) return error('Each correction factor must be greater than zero.');
    const capacity = factors.reduce((value, factor) => value * factor, base);
    return { ok: true, capacity, comparison: load === null || load === undefined ? null : capacity >= load };
  }

  return { solveOhms, solveVoltageDrop, threePhase, conduitFill, derating };
}));
