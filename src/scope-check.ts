// scope:check — registry invariants + evaluateScope() contract. Pure: no LLM, no DB.
// Exit 1 on any failure. Run: npm run scope:check.
import { evaluateScope, CAP_REGISTRY, UNSUP_REGISTRY, ALL_SCOPE_NAMES } from './scope.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

// ---- registry sanity ----
const capNames = CAP_REGISTRY.map(c => c.name);
ok('registry names unique', new Set(capNames).size === capNames.length);
for (const cap of CAP_REGISTRY)  ok(`cap regex "${cap.name}" is RegExp`,  cap.detect instanceof RegExp);
for (const u   of UNSUP_REGISTRY) ok('unsup regex is RegExp',              u.detect instanceof RegExp);

// ---- VERBATIM FedEx brief ----
const FEDEX = 'Full stack delivery app with location followup - user account - clients account - delivey follow up Fedex API integration';
const fedex = evaluateScope(FEDEX, 'app');
ok('fedex: includes tracking',         fedex.includes.some(i => i.name === 'tracking'));
ok('fedex: includes accounts',         fedex.includes.some(i => i.name === 'accounts'));
ok('fedex: excludes has API miss',     fedex.excludes.length >= 1 && !!fedex.excludes[0].alternative);
ok('fedex: difficulty >= 3',           fedex.difficulty >= 3);

// ---- barbershop booking app ----
const barber = evaluateScope('a barbershop booking app', 'app');
ok('barber: includes booking',         barber.includes.some(i => i.name === 'booking'));
ok('barber: includes receipts',        barber.includes.some(i => i.name === 'receipts'));
ok('barber: includes editing',         barber.includes.some(i => i.name === 'editing'));
ok('barber: excludes empty',           barber.excludes.length === 0);
ok('barber: difficulty 2',             barber.difficulty === 2);

// ---- plain brochure (site) ----
const plain = evaluateScope('a clean corporate website for a law firm', 'site');
ok('plain site: difficulty 1',         plain.difficulty === 1);
ok('plain site: no crash',             true);

// ---- determinism ----
ok('determinism: two calls deep-equal',
  JSON.stringify(evaluateScope(FEDEX, 'app')) === JSON.stringify(evaluateScope(FEDEX, 'app')));

// ---- no name outside registry ever appears ----
for (const scope of [fedex, barber, plain]) {
  for (const item of scope.includes)
    ok(`"${item.name}" is a registered capability`, ALL_SCOPE_NAMES.has(item.name));
}

console.log(`\nscope:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
