// i18n:check — the produced site's language is a build property. These gates pin:
// (1) the string table is COMPLETE (a missing locale for any key can never ship),
// (2) the detector is deterministic and never guesses (ambiguity → English),
// (3) a locale actually changes the rendered page — chrome, lang attribute, client dict —
// (4) and the DEFAULT stays byte-English so every existing site renders exactly as before.
import { LOCALES, STRINGS, L, detectLocale, clientDict, isLocale } from './i18n.ts';
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
  const LEAKS = ['Add to cart', 'Your cart is empty', 'Place order', 'Full name', 'Proceed to checkout', 'Find my booking', 'Search this list', "How you'll pay"];
  const leaked = LEAKS.filter((l) => it.includes(l));
  ok('leak canary: zero English chrome on an Italian site', leaked.length === 0, leaked.join(' | '));
}
// default = English, exactly as before
const en = renderPage(SPEC, CTX as any);
ok('no locale → English chrome, unchanged', en.includes('<html lang="en">') && en.includes('Full name') && en.includes('Place order') && en.includes('"add_to_cart":"Add to cart"'));
ok('bogus locale → English (closed set enforced at render)', renderPage(SPEC, { ...CTX, locale: 'xx' } as any).includes('<html lang="en">'));

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

console.log(`\ni18n:check — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
