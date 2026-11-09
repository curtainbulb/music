import { cases as base } from './cases.js';
import { parserCases } from './parser-cases.js';
import { providerCases } from './provider-cases.js';
import { freeformCases } from './freeform-cases.js';
const cases = [...base, ...parserCases, ...providerCases, ...freeformCases];
let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
