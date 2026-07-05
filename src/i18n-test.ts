// i18n:check — the produced site's language is a build property. These gates pin:
// (1) the string table is COMPLETE (a missing locale for any key can never ship),
// (2) the detector is deterministic and never guesses (ambiguity → English),
// (3) a locale actually changes the rendered page — chrome, lang attribute, client dict —
// (4) and the DEFAULT stays byte-English so every existing site renders exactly as before.
import { LOCALES, STRINGS, L, detectLocale, clientDict, isLocale, currencyFor, curSym, columnLabel, fmtMoney } from './i18n.ts';
import { renderPage } from './render.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra); }
};

// ---- completeness: every key speaks every locale ----
{
  let missing = 0;
  for (const [key, row] of Object.entries(STRINGS))
    for (const loc of LOCALES)
      if (typeof row[loc] !== 'string' || !row[loc].length) { missing++; console.error('    missing', key, loc); }
  ok(`table complete: ${Object.keys(STRINGS).length} keys × ${LOCALES.length} locales, none missing`, missing === 0);
}
ok('unknown key throws (a typo dies in the suite, not as "undefined" on a page)', (() => { try { L('en', 'no_such_key_xyz'); return false; } catch { return true; } })());
ok('unknown locale falls back to English', L('pt' as any, 'add_to_cart') === 'Add to cart' && !isLocale('pt'));
ok('interpolation fills {n} slots', L('it', 'only_n_left', { n: 3 }) === 'Solo 3 disponibili');

// ---- detection: deterministic, never guessing ----
ok('it: taqueria brief in Italian', detectLocale('una taqueria di quartiere con prenotazioni per il weekend e un blog di ricette di famiglia') === 'it');
ok('it: barber brief in Italian', detectLocale('app di prenotazione per un parrucchiere — i clienti scelgono il barbiere, il servizio e l’orario') === 'it');
ok('fr: boutique brief in French', detectLocale('une boutique en ligne pour une créatrice de bougies artisanales avec des parfums classiques') === 'fr');
ok('fr: accent-initial marker matches (unicode boundary — \\b is ASCII-only)', detectLocale('nous voulons être une entreprise où être bien est la règle chez nous') === 'fr');
ok('es: restaurant brief in Spanish', detectLocale('una tienda online para una pastelería con recetas de la semana y reservas') === 'es');
ok('de: booking brief in German', detectLocale('eine Buchungs-App für einen Friseur — Kunden wählen den Service und die Zeit, mit Terminen') === 'de');
ok('en: English brief stays English', detectLocale('a barbershop booking app — customers pick a barber, a service and a time slot') === 'en');
ok('ambiguity → English (never guess)', detectLocale('pizza bar') === 'en' && detectLocale('') === 'en');

// ---- render: the locale changes the page ----
const SPEC = { brand: { name: 'Trattoria X', tokens: { bg: '#fff', primary: '#123456' } }, sections: [
  { type: 'hero', headline: 'Benvenuti' },
  { type: 'checkout', title: 'Cassa' },
  { type: 'cart', title: 'Carrello' },
  { type: 'find', },
] };
const CTX = { pages: [{ slug: 'index', title: 'Home' }], slug: 'index', title: 'Home' };
const it = renderPage(SPEC, { ...CTX, locale: 'it' } as any);
ok('lang attribute follows the locale', it.includes('<html lang="it">'));
ok('checkout chrome is Italian (labels + CTA)', it.includes('Nome e cognome') && it.includes('Invia ordine') && it.includes('Come pagherai'));
ok('cart + find chrome is Italian', it.includes('Il tuo carrello è vuoto.') && it.includes('Trova la mia prenotazione') && it.includes('Apri la mia ricevuta'));
ok('client dict is Italian (the browser runtime speaks it too)', it.includes('"add_to_cart":"Aggiungi al carrello"') && it.includes('"proceed_checkout":"Vai alla cassa"'));
ok('footer standing links are Italian', it.includes('>Trova la mia prenotazione</a>') || !it.includes('find.html'));
// leak canary: NO English chrome may survive on a non-English site
{
  const LEAKS = ['Add to cart', 'Your cart is empty', 'Place order', 'Full name', 'Proceed to checkout', 'Find my booking', 'Search this list', "How you'll pay", 'How this site was built', 'Production record'];
  const leaked = LEAKS.filter((l) => it.includes(l));
  ok('leak canary: zero English chrome on an Italian site', leaked.length === 0, leaked.join(' | '));
}
// default = English, exactly as before
const en = renderPage(SPEC, CTX as any);
ok('no locale → English chrome, unchanged', en.includes('<html lang="en">') && en.includes('Full name') && en.includes('Place order') && en.includes('"add_to_cart":"Add to cart"'));
ok('bogus locale → English (closed set enforced at render)', renderPage(SPEC, { ...CTX, locale: 'xx' } as any).includes('<html lang="en">'));

// ---- THE CHAIN performs in the site's language ----
{
  const { SECTIONS } = await import('./components.ts');
  const data = { brief: 'una trattoria', scope: { difficulty: 2, includes: [{ name: 'booking', promise: 'prenotazioni online' }], excludes: [] },
    blueprint: { kind: 'x', theme: 'warm' }, tables: [{ name: 'reservations', isPrivate: true }, { name: 'dishes', rows: 8 }],
    run: { total: 12, wallSecs: 300, repairs: 2, rebuilds: 0 }, checks: ['privacy'], review: { passed: true, issues: 0, probed: true },
    android: { url: 'https://x.naples.agency/app.apk', qr: '<svg/>' } };
  const itChain = SECTIONS.chain(data, { locale: 'it' } as any);
  ok('chain: Italian headings throughout', itChain.includes('Registro di produzione') && itChain.includes('Il brief') && itChain.includes('La promessa') && itChain.includes('I controlli superati'));
  ok('chain: Italian dynamic lines (records, repairs, review, android)', itChain.includes('8 voci, presentate pubblicamente') && itChain.includes('2 riparazioni automatiche') && itChain.includes('SUPERATA') && itChain.includes('È anche un’app Android'));
  const enLeaks = ['Production record', 'The brief', 'The promise', 'records, publicly presented', 'Independent review', 'It is also an Android app'].filter((l) => itChain.includes(l));
  ok('chain: zero English on the Italian production record', enLeaks.length === 0, enLeaks.join(' | '));
  const enChain = SECTIONS.chain(data, {} as any);
  ok('chain: English byte-compatible by default', enChain.includes('Production record') && enChain.includes('8 records, publicly presented') && enChain.includes('✓ Independent review: PASSED') && enChain.includes('It is also an Android app'));
}

// ---- currency: a build property; English stays $, the euro-zone locales get € ----
ok('currency: en → $, it/fr/es/de → €', curSym('en') === '$' && curSym('it') === '€' && curSym('de') === '€' && currencyFor('fr') === 'EUR' && currencyFor(undefined) === 'USD');
ok('client dict carries the symbol + format flag', clientDict('it').cur === '€' && clientDict('it').meur === '1' && clientDict(undefined).cur === '$' && clientDict(undefined).meur === '');
ok('fmtMoney: en byte-identical with history, EUR reads European', fmtMoney('en', 12) === '$12.00' && fmtMoney('it', 12) === '12,00 €' && fmtMoney('de', 9.5) === '9,50 €' && fmtMoney(undefined, 3) === '$3.00');
ok('PDP price renders European money on an Italian site', (() => {
  const pdp = renderPage({ brand: { name: 'X', tokens: {} }, sections: [{ type: 'product', row: { id: 1, title: 'Vaso', price: 12 } }] }, { ...CTX, locale: 'it' } as any);
  return pdp.includes('12,00 €') && !pdp.includes('$12.00');
})());
ok('PDP price stays $ by default (existing sites untouched)', (() => {
  const pdp = renderPage({ brand: { name: 'X', tokens: {} }, sections: [{ type: 'product', row: { id: 1, title: 'Vase', price: 12 } }] }, CTX as any);
  return pdp.includes('$12.00');
})());

// ---- form labels: common schema columns speak the locale; English is byte-identical fallback ----
ok('columnLabel: it knows the common columns', columnLabel('it', 'customer_name', 'Customer name') === 'Nome e cognome' && columnLabel('it', 'party_size', 'Party size') === 'Numero di persone');
ok('columnLabel: en ALWAYS uses the fallback (byte-compat)', columnLabel('en', 'customer_name', 'Customer name') === 'Customer name' && columnLabel(undefined, 'email', 'Email!') === 'Email!');
ok('columnLabel: unknown column falls back to humanize, never breaks', columnLabel('it', 'favorite_dinosaur', 'Favorite dinosaur') === 'Favorite dinosaur');

// ---- action errors: the visitor's language at the exact moment of rejection ----
ok('error strings: Italian slot-taken + sold-out', L('it', 'err_slot_taken').includes('orario') && L('it', 'err_sold_out_item', { t: 'Vaso' }) === '"Vaso" è esaurito');
ok('error strings: English byte-exact with history (gates elsewhere assert them)', L('en', 'err_slot_taken') === 'that slot was just taken — pick another time' && L('en', 'err_only_n_of', { n: 2, t: 'Mug' }) === 'only 2 of "Mug" left — reduce the quantity');
{
  const appdb = readFileSync(new URL('./appdb.ts', import.meta.url), 'utf8');
  ok('appdb: every visitor error goes through L() (no hardcoded English left)', !appdb.includes("'your name is required'") && !appdb.includes('is in the past — pick an upcoming date`') && appdb.includes('localeOf'));
}
{
  const canary = readFileSync(new URL('./canary.ts', import.meta.url), 'utf8');
  ok('canary rotation includes the Italian flight', canary.includes('trattoria di quartiere con prenotazioni'));
}

// ---- client dict: every key it promises exists in every locale ----
{
  const d = clientDict('de');
  ok('client dict complete for de', Object.values(d).every((v) => typeof v === 'string' && v.length > 0) && d.sold_out === 'Ausverkauft');
}

// ---- threading: plan writes the locale; render reads it (source pins) ----
import { readFileSync } from 'node:fs';
const planner = readFileSync(new URL('./planner.ts', import.meta.url), 'utf8');
ok('planner: locale detected at plan AND replan', (planner.match(/locale: detectLocale\(brief\)/g) || []).length >= 2);
const runner = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');
ok('runner: locale threaded into both render paths', (runner.match(/locale: \(ctx as any\)\.locale/g) || []).length >= 2);
const live = readFileSync(new URL('./cms/live.ts', import.meta.url), 'utf8');
ok('live pages: locale threaded into every renderPage', (live.match(/locale: params\.locale/g) || []).length >= 7);
const cmsD = readFileSync(new URL('./cms/directus.ts', import.meta.url), 'utf8');
const cmsF = readFileSync(new URL('./cms/finalize.ts', import.meta.url), 'utf8');
ok('CMS re-serve path carries the locale (the leak the Italian E2E caught)', cmsD.includes('locale: (ctx as any).locale') && cmsF.includes('locale: params.locale'));

console.log(`\ni18n:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
