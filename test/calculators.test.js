'use strict';

const assert = require('node:assert/strict');
const calc = require('../calculators.js');

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);

for (const [values, expected] of [
  [{ V: 230, I: 10 }, { R: 23, P: 2300 }],
  [{ V: 230, R: 23 }, { I: 10, P: 2300 }],
  [{ V: 230, P: 2300 }, { I: 10, R: 23 }],
  [{ I: 10, R: 23 }, { V: 230, P: 2300 }],
  [{ I: 10, P: 2300 }, { V: 230, R: 23 }],
  [{ R: 23, P: 2300 }, { V: 230, I: 10 }],
]) {
  const result = calc.solveOhms(values);
  assert.equal(result.ok, true);
  for (const [key, value] of Object.entries(expected)) close(result[key], value);
}
assert.equal(calc.solveOhms({ V: 240, I: 10, R: 23 }).ok, false);
assert.equal(calc.solveOhms({ V: -230, I: 10 }).ok, false);

let result = calc.solveVoltageDrop({ solveFor: 'drop', current: 10, length: 20, mvPerAmpPerM: 18, nominal: 230, limitPct: 5 });
assert.equal(result.ok, true); close(result.result, 3.6); assert.equal(result.comparison, true);
assert.equal(calc.solveVoltageDrop({ solveFor: 'drop', current: -10, length: 20, mvPerAmpPerM: 18, nominal: 230, limitPct: 5 }).ok, false);
assert.equal(calc.solveVoltageDrop({ solveFor: 'drop', current: 10, length: 20, mvPerAmpPerM: 18, nominal: 230, limitPct: -1 }).ok, false);

result = calc.threePhase({ lineVoltage: 400, lineCurrent: 10, powerFactor: 0.8 });
assert.equal(result.ok, true); close(result.apparent, Math.sqrt(3) * 4000); close(result.real, Math.sqrt(3) * 3200);
assert.equal(calc.threePhase({ lineVoltage: 400, lineCurrent: 10, powerFactor: 1.2 }).ok, false);

result = calc.conduitFill({ internalDiameter: 20, cableDiameters: [5, 5] });
assert.equal(result.ok, true); close(result.fillPercent, 12.5);
assert.equal(calc.conduitFill({ internalDiameter: 20, cableDiameters: [-5] }).ok, false);

result = calc.derating({ base: 32, load: 20, factors: [0.9, 0.8, 1, 1] });
assert.equal(result.ok, true); close(result.capacity, 23.04); assert.equal(result.comparison, true);
assert.equal(calc.derating({ base: 32, load: 20, factors: [0] }).ok, false);

console.log('calculator tests passed');
