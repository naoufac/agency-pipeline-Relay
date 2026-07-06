// ORCHESTRATOR — reads a brief and selects the right {deliverable, stack, builder, chain}.
// WHY: the original pipeline hardcoded "directus_site" everywhere. Now each brief can map to
// a WordPress site, WooCommerce shop, full-stack app, or email campaign — each with its own
// dependency chain. This module is the ONLY place that makes that decision.
//
// INVARIANTS (shared with every worker):
// 1. Task shape is frozen: {seq,title,department,verify,depends_on:number[],artifact:string|null}.
// 2. `params.cms` stays 'directus' forever — cms:check.ts asserts it and this module never touches it.
// 3. 'directus_site' is the DEFAULT: a plain brief → identical DAG as validate() produces today.
// 4. The deterministic detect() is the FLOOR; the LLM may only upgrade within a compatible set.
// 5. ALL new runtime paths are feature-flagged so the 24-suite check chain stays green.

import type { Archetype } from './archetype.ts';
import { archetypeFor, needsData } from './archetype.ts';

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

export type DeliverableId =
  | 'directus_site'
  | 'landing_page'
  | 'brand_identity'
  | 'wp_site'
  | 'wp_woocommerce'
  | 'fullstack_app'
  | 'campaign';

export type CapId =
  // FORCED SPINE — every deliverable gets these
  | 'understand'
  | 'research'
  | 'branding'
  | 'design_guidelines'
  | 'qa'
  // BRANCH capabilities — vary by deliverable + detected needs
  | 'content_copy'
  | 'database'
  | 'policies'
  | 'integrations'
  | 'compose'
  | 'render'
  | 'wp_provision'
  | 'ecom_catalog'
  | 'app_api'
  | 'campaign_assets'
  | 'brand_guidelines';

export interface Deliverable {
  id: DeliverableId;
  label: string;
  /** Deterministic regex floor score. directus_site returns baseline 1 always. */
  detect(brief: string): number;
  stack: string;
  /** Builder registry key — 'directus'|'wordpress'|'app'|'campaign' */
  builder: string;
  /** Branch caps this deliverable MAY add beyond the spine */
  branchCaps: CapId[];
  /** The archetype this deliverable maps to */
  archetypeCompat: Archetype;
  /** Deliverables this one can upgrade to (LLM-upgrade-compatible set) */
  upgradesTo: DeliverableId[];
}

export interface Capability {
  id: CapId;
  department: string;
  verify: string;
  kind: 'spine' | 'branch';
  dependsOn: CapId[];
  artifact?: string;
}

export interface OrchestrationResult {
  deliverable: DeliverableId;
  stack: string;
  builder: string;
  detectedNeeds: CapId[];
  reason: string;
  /** T3/T19: human-readable "why" string — deliverable + signals + chain summary.
   * e.g. "wp_woocommerce (FR ecom signals: boutique, vendre) · chain: research->brand->...->wp"
   * Non-empty guaranteed: at minimum reports the deliverable and its chain head. */
  chainReason: string;
  archetype: Archetype;
}

// Shape that composeChain emits — frozen Task shape from planner.ts:77
type Task = {
  seq: number;
  title: string;
  department: string;
  verify: string;
  depends_on: number[];
  artifact: string | null;
};

// ────────────────────────────────────────────────────────────────────────────
// CAPABILITIES REGISTRY
// WHY: a single registry so departments + verify strings are always consistent
// with the existing verify.ts dispatch table (no invented verify strings).
// ────────────────────────────────────────────────────────────────────────────

export const CAPABILITIES: Record<CapId, Capability> = {
  // SPINE — forced for every deliverable
  understand: {
    id: 'understand', department: 'strategy', verify: 'min:280',
    kind: 'spine', dependsOn: [],
  },
  research: {
    id: 'research', department: 'research', verify: 'min:280',
    kind: 'spine', dependsOn: ['understand'],
  },
  branding: {
    id: 'branding', department: 'branding', verify: 'wcag',
    kind: 'spine', dependsOn: ['research'],
  },
  design_guidelines: {
    id: 'design_guidelines', department: 'design', verify: 'min:280',
    kind: 'spine', dependsOn: ['branding'],
  },
  qa: {
    id: 'qa', department: 'qa', verify: 'site_consistent',
    kind: 'spine', dependsOn: [], // filled dynamically in composeChain (after render)
  },

  // BRANCH caps — injected based on deliverable + detected needs
  content_copy: {
    id: 'content_copy', department: 'content', verify: 'json',
    kind: 'branch', dependsOn: ['research'],
  },
  database: {
    id: 'database', department: 'database', verify: 'app_db',
    kind: 'branch', dependsOn: ['understand'], artifact: 'schema.sql',
  },
  policies: {
    id: 'policies', department: 'policies', verify: 'policies_ok',
    kind: 'branch', dependsOn: ['understand'],
  },
  integrations: {
    id: 'integrations', department: 'integrations', verify: 'calendar_feed',
    kind: 'branch', dependsOn: ['database'],
  },
  compose: {
    id: 'compose', department: 'compose', verify: 'site_model',
    kind: 'branch', dependsOn: [], // filled dynamically (fan-in from all thinking caps)
  },
  render: {
    id: 'render', department: 'render', verify: 'site_renders',
    kind: 'branch', dependsOn: ['compose'],
  },
  wp_provision: {
    id: 'wp_provision', department: 'wp_provision', verify: 'wp_provisioned',
    kind: 'branch', dependsOn: ['compose'],
  },
  ecom_catalog: {
    id: 'ecom_catalog', department: 'database', verify: 'app_db',
    kind: 'branch', dependsOn: ['understand'], artifact: 'schema.sql',
  },
  app_api: {
    id: 'app_api', department: 'app_api', verify: 'app_api_ok',
    kind: 'branch', dependsOn: ['database'],
  },
  campaign_assets: {
    id: 'campaign_assets', department: 'content', verify: 'json',
    kind: 'branch', dependsOn: ['research'],
  },
  // T2: brand_guidelines — the visual/identity deliverable for brand_identity projects
  brand_guidelines: {
    id: 'brand_guidelines', department: 'design', verify: 'min:280',
    kind: 'branch', dependsOn: ['design_guidelines'],
  },
};

// ────────────────────────────────────────────────────────────────────────────
// DELIVERABLES REGISTRY
// WHY: a closed set of substrates, each with a deterministic floor detector.
// Mirrors archetype.ts's RULES table — first/highest score wins; directus_site
// is the immovable baseline (score=1 always).
// ────────────────────────────────────────────────────────────────────────────

// Priority order for tie-breaking (most-specific first, mirrors archetype.ts store>app ordering).
// landing_page and brand_identity are placed BEFORE directus_site because they are more specific
// than the baseline; brand_identity is checked before landing_page since "branding only" is very
// explicit. Both score from zero so they only win when their signals are unambiguous.
const PRIORITY: DeliverableId[] = [
  'wp_woocommerce', 'fullstack_app', 'wp_site', 'campaign', 'brand_identity', 'landing_page', 'directus_site',
];

export const DELIVERABLES: Record<DeliverableId, Deliverable> = {
  // ── DEFAULT (must always win for a plain/simple/landing brief) ──────────
  directus_site: {
    id: 'directus_site',
    label: 'Directus website',
    detect(brief: string): number {
      const b = ' ' + brief.toLowerCase() + ' ';
      let score = 1; // constant baseline — this is THE floor
      // T1 NOTE: "landing" / "one-page" signals have been removed from this booster because
      // landing_page is now a first-class deliverable that handles those briefs.
      // directus_site still wins for plain/brochure/portfolio briefs that don't trigger landing_page.
      if (/\b(simple site|coming soon|brochure|portfolio|business card)\b/.test(b)) score += 3;
      return score;
    },
    stack: 'directus',
    builder: 'directus',
    archetypeCompat: 'site',
    branchCaps: ['content_copy'],
    upgradesTo: ['wp_site', 'wp_woocommerce', 'fullstack_app'],
  },

  // ── T1: Landing page (single high-conversion page, archetype=site, builder=directus) ──
  // WHY: "landing" / "one-page" / "page de vente" / "atterrissage" signals warrant a
  // shape-forced single-page plan (1 page, no multi-page nav), still rendered via Directus.
  // Confidence tie-break: each matched signal adds 3 points; a plain site that also says
  // "landing" should cleanly beat directus_site's baseline-1.
  landing_page: {
    id: 'landing_page',
    label: 'Landing page',
    detect(brief: string): number {
      const b = ' ' + brief.toLowerCase() + ' ';
      let score = 0;
      // EN signals: landing, one-page, squeeze page, sales page, coming soon, conversion page
      const enMatches = (b.match(/\b(landing[- ]?page|one[- ]?page|squeeze[- ]?page|sales[- ]?page|coming[- ]?soon|conversion[- ]?page|product[- ]?page|hero[- ]?page|sign[- ]?up page|launch page)\b/g) || []).length;
      // FR signals: page de vente, page d'atterrissage, atterrissage, page unique, page de capture
      const frMatches = (b.match(/\b(page de vente|atterrissage|page d.atterrissage|page unique|page de capture|page de lancement)\b/g) || []).length;
      // IT signals: pagina di atterraggio, pagina unica, pagina di vendita, pagina singola
      const itMatches = (b.match(/\b(pagina di atterraggio|pagina unica|pagina di vendita|pagina singola|pagina promozionale|pagina lancio)\b/g) || []).length;
      score += (enMatches + frMatches + itMatches) * 3;
      return score;
    },
    stack: 'directus',
    builder: 'directus',
    archetypeCompat: 'site',
    branchCaps: ['content_copy'],
    upgradesTo: ['wp_site', 'directus_site'],
  },

  // ── T2: Brand identity (name/palette/type/guidelines ONLY — no rendered site) ──
  // WHY: a "brand identity" / "logo" / "branding only" brief should yield a brand package
  // (name, palette, typography, guidelines document) with NO compose/render/qa-site steps.
  // Builder is 'campaign' (no renderer needed); the chain ends at design_guidelines + brand_guidelines.
  // Confidence: each signal adds 3 points so it decisively beats directus_site baseline.
  brand_identity: {
    id: 'brand_identity',
    label: 'Brand identity package',
    detect(brief: string): number {
      const b = ' ' + brief.toLowerCase() + ' ';
      let score = 0;
      // EN signals: brand identity, logo design, branding only, visual identity, brand guidelines, brand name
      const enMatches = (b.match(/\b(brand identity|logo design|branding only|visual identity|brand guidelines?|brand name|identity design|brand pack(age)?|logotype|wordmark|brand style guide)\b/g) || []).length;
      // FR signals: identité de marque, identité visuelle, logo, charte graphique, nom de marque, guide de marque
      const frMatches = (b.match(/\b(identit[ée] de marque|identit[ée] visuelle|charte graphique|nom de marque|guide de marque|logo uniquement|seulement le logo|branding seul)\b/g) || []).length;
      // IT signals: identità del marchio, identità visiva, guida del brand, pacchetto brand, nome del marchio
      const itMatches = (b.match(/\b(identit[àa] del marchio|identit[àa] visiva|guida del brand|pacchetto brand|nome del marchio|solo il logo|branding senza sito)\b/g) || []).length;
      score += (enMatches + frMatches + itMatches) * 3;
      return score;
    },
    stack: 'campaign',  // no web renderer — just docs/assets
    builder: 'campaign',
    archetypeCompat: 'site',
    branchCaps: ['brand_guidelines'],
    upgradesTo: [],
  },

  // ── WordPress CMS site (blog/news/content-heavy) ──────────────────────
  wp_site: {
    id: 'wp_site',
    label: 'WordPress site',
    detect(brief: string): number {
      const b = ' ' + brief.toLowerCase() + ' ';
      let score = 0;
      // T3: expanded EN + FR + IT content-site signals.
      // EN: blog, news, magazine, editorial, CMS, WordPress, publish, multi-author, newsroom, press,
      //     content hub, media site, column, contributor, author, posts, publication, web magazine.
      // FR: actualités, revue, journal, rédaction, chronique, auteurs, billet, contenu éditorial,
      //     site de presse, tribune, blog d'entreprise, publications.
      // IT: rivista, notizie, editoriale, articoli, pubblicazione, cronaca, redazione, sito di notizie,
      //     giornale online, webzine, contributi, contenuti.
      const matches = (b.match(/\b(blog|news|magazine|editorial|content[- ]?site|content[- ]?hub|publish|articles?|cms|wordpress|multi[- ]?author|newsroom|press|column|contributor|author|posts?|media[- ]?site|web[- ]?magazine|actualit[ée]s?|revue|journal|r[ée]daction|chronique|auteurs?|billet|contenu[- ]?[ée]ditorial|site de presse|tribune|blog d.entreprise|publications?|rivista|notizie|editoriale|articoli?|pubblicazione|cronaca|redazione|sito di notizie|giornale online|webzine|contributi|contenuti)\b/g) || []).length;
      // cap at 4 so a single signal doesn't blow past woocommerce
      score += Math.min(4, matches * 2);
      return score;
    },
    stack: 'wordpress',
    builder: 'wordpress',
    archetypeCompat: 'site',
    branchCaps: ['content_copy', 'wp_provision'],
    upgradesTo: ['wp_woocommerce', 'fullstack_app'],
  },

  // ── WooCommerce (e-commerce / online store) ────────────────────────────
  wp_woocommerce: {
    id: 'wp_woocommerce',
    label: 'WooCommerce store',
    detect(brief: string): number {
      const b = ' ' + brief.toLowerCase() + ' ';
      let score = 0;
      // T3: expanded EN + FR + IT ecom signals.
      // EN: shop, store, e-commerce, webshop, cart, checkout, catalog, products, sell online, woocommerce,
      //     marketplace for goods, merchandise, add to cart, order, shipping, inventory, stock.
      // FR: boutique en ligne, vendre, vente, panier, paiement, achat, commande, livraison, produits,
      //     catalogue, magasin en ligne, article en vente, prix, promotions, stock.
      // IT: negozio, vendere, vendita, carrello, pagamento, acquisto, ordine, spedizione, prodotti,
      //     catalogo, listino, inventario, merce, articoli in vendita, shop online.
      const matches = (b.match(/\b(shop|store|e-?commerce|e-?shop|woo(commerce)?|online[- ]?store|sell (online|products?)|checkout|\bcart\b|catalog(ue)?|webshop|merch|merchandise|inventory|stock|shipping|livraison|commande|boutique en ligne|vendre|vente|panier|paiement|achat|prix|promotions|magasin en ligne|prestashop|negozio|vendere|vendita|carrello|pagamento|acquist\w*|ordine|spedizione|catalogo|listino|inventario)\b/g) || []).length;
      score += Math.min(6, matches * 3);
      return score;
    },
    stack: 'woocommerce',
    builder: 'wordpress',
    archetypeCompat: 'store',
    branchCaps: ['content_copy', 'wp_provision', 'ecom_catalog', 'database'],
    upgradesTo: [],
  },

  // ── Full-stack app (SaaS / dashboard / marketplace / booking platform) ─
  fullstack_app: {
    id: 'fullstack_app',
    label: 'Full-stack application',
    detect(brief: string): number {
      const b = ' ' + brief.toLowerCase() + ' ';
      let score = 0;
      // T3: expanded EN + FR + IT app signals.
      // EN: app, application, platform, SaaS, dashboard, booking, tracker, portal, marketplace,
      //     directory, CRM, ERP, scheduling, fleet, backend, API, full-stack, member area, admin panel.
      // FR: appli, application, plateforme, tableau de bord, réservation, suivi, portail, annuaire,
      //     planning, flotte, gestion, logiciel, outil, espace membre, panneau admin.
      // IT: applicazione, piattaforma, cruscotto, prenotazione, tracciamento, portale, directory,
      //     pianificazione, flotta, gestione, software, strumento, area membri, pannello admin.
      const matches = (b.match(/\b(app|appli|application|platform|plateforme|piattaforma|saas|dashboard|tableau de bord|cruscotto|booking|reservation|r[ée]servation|prenotazione|settlement|tracker|tracking|suivi|tracciamento|portal|portail|marketplace|directory|annuaire|crm|erp|scheduling|planning|on[- ]?demand|fleet|flotte|api|backend|full[- ]?stack|member[- ]?area|admin[- ]?panel|gestion|logiciel|outil|espace[- ]?membre|panneau[- ]?admin|gestione|software|strumento|area[- ]?membri|pannello[- ]?admin|iscrizione|abbonamento|subscription|membership)\b/g) || []).length;
      score += Math.min(6, matches * 3);
      return score;
    },
    stack: 'node-postgres',
    builder: 'app',
    archetypeCompat: 'app',
    branchCaps: ['content_copy', 'database', 'policies', 'integrations', 'app_api'],
    upgradesTo: [],
  },

  // ── Campaign (email/social/ad creative — NO rendered site) ─────────────
  campaign: {
    id: 'campaign',
    label: 'Marketing campaign assets',
    detect(brief: string): number {
      const b = ' ' + brief.toLowerCase() + ' ';
      let score = 0;
      // T3: expanded EN + FR + IT campaign signals.
      // EN: email campaign, newsletter blast, social media campaign, ad creative, video ad,
      //     mailing, drip campaign, marketing assets, flyer, banner ads, promotional email.
      // FR: campagne email, campagne emailing, campagne publicitaire, newsletter, mailing,
      //     publicité, création publicitaire, réseaux sociaux, posts sponsorisés, annonce.
      // IT: campagna email, newsletter, mailing, campagna pubblicitaria, annuncio, creatività,
      //     social media, post sponsorizzati, banner, volantino, materiale promozionale.
      const matches = (b.match(/\b(email[- ]?campaign|newsletter[- ]?blast|social[- ]?(media[- ]?)?(campaign|posts?)|ad[- ]?creative|video[- ]?ad|mailing|drip[- ]?campaign|marketing[- ]?assets|flyer|banner[- ]?ads?|promotional[- ]?email|campagne[- ]?email|campagne[- ]?emailing|campagne[- ]?publicitaire|newsletter|publicit[ée]|cr[ée]ation[- ]?publicitaire|r[ée]seaux[- ]?sociaux|posts?[- ]?sponsoris[ée]s?|annonce|campagna[- ]?email|campagna[- ]?pubblicitaria|annuncio|creativit[àa]|post[- ]?sponsorizzati|materiale[- ]?promozionale)\b/g) || []).length;
      score += Math.min(9, matches * 3);
      return score;
    },
    stack: 'campaign',
    builder: 'campaign',
    archetypeCompat: 'site',
    branchCaps: ['campaign_assets'],
    upgradesTo: [],
  },
};

// ────────────────────────────────────────────────────────────────────────────
// SIGNAL EXTRACTOR — T3: extract the matched signal words from a brief for a
// given deliverable, so chainReason can name them (e.g. "FR ecom signals: boutique, vendre").
// WHY: a human needs to be able to audit why the orchestrator chose a deliverable.
// ────────────────────────────────────────────────────────────────────────────

// Regex patterns per deliverable (mirrors the detect() patterns but returns capture groups).
const SIGNAL_PATTERNS: Partial<Record<DeliverableId, RegExp>> = {
  landing_page:   /\b(landing[- ]?page|one[- ]?page|squeeze[- ]?page|sales[- ]?page|coming[- ]?soon|conversion[- ]?page|product[- ]?page|atterrissage|page de vente|page d.atterrissage|page unique|page de capture|pagina di atterraggio|pagina unica|pagina di vendita|pagina singola)\b/gi,
  brand_identity: /\b(brand identity|logo design|branding only|visual identity|brand guidelines?|logotype|wordmark|identit[ée] de marque|identit[ée] visuelle|charte graphique|identit[àa] del marchio|identit[àa] visiva|guida del brand)\b/gi,
  wp_site:        /\b(blog|news|magazine|editorial|wordpress|multi[- ]?author|newsroom|actualit[ée]s?|revue|journal|r[ée]daction|rivista|notizie|editoriale|articoli?|pubblicazione|redazione)\b/gi,
  wp_woocommerce: /\b(shop|store|e-?commerce|checkout|\bcart\b|catalog(ue)?|webshop|boutique en ligne|vendre|panier|paiement|negozio|vendere|carrello|pagamento|acquist\w*|inventory|spedizione)\b/gi,
  fullstack_app:  /\b(saas|dashboard|platform|booking|reservation|r[ée]servation|prenotazione|tracker|marketplace|crm|erp|plateforme|tableau de bord|piattaforma|cruscotto|tracciamento|portale|subscription|membership)\b/gi,
  campaign:       /\b(email[- ]?campaign|newsletter|mailing|drip[- ]?campaign|ad[- ]?creative|flyer|campagne[- ]?email|campagne[- ]?publicitaire|campagna[- ]?email|campagna[- ]?pubblicitaria)\b/gi,
};

function extractSignals(brief: string, deliverable: DeliverableId): string[] {
  const pat = SIGNAL_PATTERNS[deliverable];
  if (!pat) return [];
  const raw = brief.match(pat) || [];
  // deduplicate, lowercase, cap at 5 so the string stays readable
  return [...new Set(raw.map(s => s.toLowerCase().replace(/\s+/g, ' ')))].slice(0, 5);
}

// ────────────────────────────────────────────────────────────────────────────
// CHAIN REASON BUILDER — T3/T19: produce a human-readable "why" string.
// Format: "<deliverable> (<lang> <type> signals: <word>, <word>) · chain: step1->step2->..."
// WHY: the board shows this to owners so they can audit the routing decision.
// ────────────────────────────────────────────────────────────────────────────

function buildChainReason(
  deliverable: DeliverableId,
  brief: string,
  chain: { department: string }[],
  llmReason?: string,
): string {
  const del = DELIVERABLES[deliverable];
  const signals = extractSignals(brief, deliverable);

  // Detect dominant language for the label
  const b = ' ' + brief.toLowerCase() + ' ';
  const frScore = (b.match(/\b(le|la|les|un|une|des|du|est|pour|avec|votre|notre|de|en|et|ou|je|nous|vous|ils|boutique|vendre|marque|site|annuaire)\b/g) || []).length;
  const itScore = (b.match(/\b(il|la|le|un|una|dei|del|della|per|con|vostro|nostro|di|in|e|o|io|noi|voi|loro|negozio|vendere|marchio|sito|directory)\b/g) || []).length;
  const lang = frScore >= 4 ? 'FR' : itScore >= 4 ? 'IT' : 'EN';

  const signalPart = signals.length > 0
    ? ` (${lang} signals: ${signals.join(', ')})`
    : '';

  // Chain summary: department sequence, abbreviated
  const chainSteps = chain.map(t => t.department).join('->');

  let reason = `${deliverable}${signalPart} · chain: ${chainSteps}`;
  if (llmReason) reason += ` · llm: ${llmReason.slice(0, 80)}`;
  return reason;
}

// ────────────────────────────────────────────────────────────────────────────
// FLOOR DETECTOR
// WHY: argmax over all deliverable scores; ties resolve by PRIORITY order.
// ────────────────────────────────────────────────────────────────────────────

export function detectDeliverable(brief: string): DeliverableId {
  let best: DeliverableId = 'directus_site';
  let bestScore = 0;

  for (const id of PRIORITY) {
    const score = DELIVERABLES[id].detect(brief);
    // strict ">" so PRIORITY order resolves ties (most-specific first)
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────────────────────
// NEED DETECTION — deterministic branch capability detection
// WHY: reuses the same predicates as validate() (planner.ts:195-209) so the
// classic directus_site path produces an IDENTICAL branch set.
// ────────────────────────────────────────────────────────────────────────────

export function detectNeeds(brief: string, archetype: Archetype, deliverable: DeliverableId): CapId[] {
  const needs = new Set<CapId>();
  const b = ' ' + brief.toLowerCase() + ' ';

  // T1: landing_page — only content_copy + its own compose/render in composeChain; no data steps.
  if (deliverable === 'landing_page') {
    needs.add('content_copy');
    return [...needs];
  }

  // T2: brand_identity — brand_guidelines ONLY; no site/data/render steps.
  if (deliverable === 'brand_identity') {
    needs.add('brand_guidelines');
    return [...needs];
  }

  // content_copy is enabled for every deliverable that lists it
  const del = DELIVERABLES[deliverable];
  if (del.branchCaps.includes('content_copy')) needs.add('content_copy');

  // THE PROJECT DICTATES ITS STEPS. The data branch (database + policies + integrations) is NOT
  // pulled in by the archetype floor alone (that dragged policies/calendar onto a blog and even an
  // email campaign — nonsense steps the owner rightly rejected). It fires only when EITHER:
  //   (a) the brief explicitly signals bookings/reservations/scheduling (a real dynamic branch), OR
  //   (b) the DELIVERABLE genuinely runs on data (its branchCaps declare 'database').
  // And NEVER for a campaign (no site, no schema).
  const wantsBooking = /\b(book(ing)?s?|reservations?|appointments?|scheduling|calendar|slots?|availability|table|r[ée]servations?|rendez[- ]?vous|prenotazion\w*|prenota\w*|agenda)\b/.test(b);
  const deliverableUsesData = del.branchCaps.includes('database') || deliverable === 'fullstack_app' || deliverable === 'wp_woocommerce';
  // directus_site can carry a booking branch on demand (e.g. a restaurant); a wp_site/blog does not,
  // unless the brief itself asks for bookings.
  const dataCapable = deliverableUsesData || deliverable === 'directus_site';
  if (deliverable !== 'campaign' && (deliverableUsesData || (wantsBooking && dataCapable))) {
    needs.add('database');
    needs.add('policies');
    needs.add('integrations');
  }

  // ecom_catalog for woocommerce
  if (deliverable === 'wp_woocommerce') {
    needs.add('ecom_catalog');
    needs.add('database'); // ecom_catalog depends on schema
  }

  // app_api branch (feature-flagged at runtime; present in chain when deliverable is fullstack_app)
  if (deliverable === 'fullstack_app') needs.add('app_api');

  // wp_provision for WordPress-based deliverables
  if (deliverable === 'wp_site' || deliverable === 'wp_woocommerce') needs.add('wp_provision');

  // campaign gets ONLY its own asset branch — no site/data steps
  if (deliverable === 'campaign') needs.add('campaign_assets');

  return [...needs];
}

// ────────────────────────────────────────────────────────────────────────────
// CHAIN COMPOSER
// WHY: assembles the frozen Task[] shape from the selected capabilities.
// For directus_site this produces a superset-equal of validate()'s output.
// ────────────────────────────────────────────────────────────────────────────

export function composeChain(
  deliverable: DeliverableId,
  detectedNeeds: CapId[],
  pages: { slug: string; title: string }[] = [{ slug: 'index', title: 'Home' }],
): Task[] {
  const tasks: Task[] = [];
  let seq = 0;

  // Helper: emit a task and return its seq
  function emit(
    title: string,
    department: string,
    verify: string,
    depends_on: number[],
    artifact: string | null = null,
  ): number {
    seq++;
    tasks.push({ seq, title, department, verify, depends_on, artifact });
    return seq;
  }

  // ── 1. FORCED SPINE: understand → research → branding → design_guidelines ──
  const understandSeq = emit('Audience & positioning', 'strategy', 'min:280', []);
  const researchSeq   = emit('Market & competitor research', 'research', 'min:280', [understandSeq]);
  const brandingSeq   = emit('Brand system (tokens)', 'branding', 'wcag', [researchSeq]);
  const designSeq     = emit('Design guidelines', 'design', 'min:280', [brandingSeq]);

  // thinking seqs (fan-in base)
  const thinkingSeqs = [understandSeq, researchSeq, brandingSeq, designSeq];

  // ── 2. BRANCH capabilities ──────────────────────────────────────────────
  const needs = new Set(detectedNeeds);
  let dbSeq: number | null = null;

  // database (+ ecom_catalog treated as an alias)
  if (needs.has('database') || needs.has('ecom_catalog')) {
    dbSeq = emit('Data model (database schema)', 'database', 'app_db', [understandSeq], 'schema.sql');
    thinkingSeqs.push(dbSeq);
  }

  // policies
  if (needs.has('policies')) {
    const policiesSeq = emit('Business rules (notice, capacity, cancellation)', 'policies', 'policies_ok', [understandSeq]);
    thinkingSeqs.push(policiesSeq);
  }

  // integrations (depends on database if present, else understand)
  if (needs.has('integrations')) {
    const intgDep = dbSeq !== null ? dbSeq : understandSeq;
    const intgSeq = emit('Owner integrations (live calendar feed)', 'integrations', 'calendar_feed', [intgDep]);
    thinkingSeqs.push(intgSeq);
  }

  // content_copy
  if (needs.has('content_copy')) {
    const copySeq = emit('Information architecture & copy', 'content', 'json', [researchSeq]);
    thinkingSeqs.push(copySeq);
  }

  // app_api (feature-flagged; runner checks RELAY_APP_API at dispatch time)
  if (needs.has('app_api') && dbSeq !== null) {
    const apiSeq = emit('App API (generated REST endpoints)', 'app_api', 'app_api_ok', [dbSeq]);
    thinkingSeqs.push(apiSeq);
  }

  // ── 3. BUILD TAIL per builder ────────────────────────────────────────────
  if (deliverable === 'campaign') {
    // campaign: campaign_assets → qa (no compose/render)
    const assetsSeq = emit('Campaign assets', 'content', 'json', [researchSeq]);
    emit('QA — campaign review', 'qa', 'site_consistent', [assetsSeq]);
    return renumber(tasks);
  }

  // T2: brand_identity — spine + brand_guidelines; NO compose/render/qa-site
  // WHY: the client wants a brand package ONLY (name, palette, type, guidelines).
  // There is no website to render. The chain ends after design_guidelines + brand_guidelines.
  if (deliverable === 'brand_identity') {
    const bgSeq = emit('Brand guidelines document (name, palette, typography, usage)', 'design', 'min:280', [designSeq]);
    emit('QA — brand guidelines review', 'qa', 'site_consistent', [bgSeq]);
    return renumber(tasks);
  }

  // T1: landing_page — spine + content_copy + a SINGLE compose + render + qa
  // WHY: a landing page is shape-forced to ONE page (no multi-page nav). The chain is
  // the standard spine augmented by content_copy, then a single compose+render pair.
  // This is still a Directus render so it passes the same site gates.
  if (deliverable === 'landing_page') {
    // content_copy for conversion-focused copy
    if (needs.has('content_copy')) {
      const copySeq = emit('Conversion copy (hero, CTA, social proof, benefits)', 'content', 'json', [researchSeq]);
      thinkingSeqs.push(copySeq);
    }
    // force exactly ONE page (the landing page shape invariant)
    const landingPages = [{ slug: 'index', title: 'Home' }];
    const composeSeq = emit('Compose the landing page (one CMS → single page)', 'compose', 'site_model', [...thinkingSeqs]);
    const rSeq = emit('Render the Home page', 'render', 'site_renders', [composeSeq], 'index.html');
    emit('QA — acceptance (1 nav · 1 logo · 1 palette, every page)', 'qa', 'site_consistent', [rSeq]);
    return renumber(tasks);
  }

  // wp_provision (WordPress-based deliverables: after compose)
  // We emit compose first, then wp_provision depends on it
  const composeSeq = emit(
    'Compose the site (one CMS → all pages)',
    'compose',
    'site_model',
    [...thinkingSeqs], // fan-in from ALL thinking tasks
  );

  if (needs.has('wp_provision')) {
    emit('Provision WordPress site', 'wp_provision', 'wp_provisioned', [composeSeq]);
    // wp_provision is informational; pages still render from compose
  }

  // per-page render (one task per page)
  const renderSeqs: number[] = [];
  for (const pg of pages) {
    const rSeq = emit(`Render the ${pg.title} page`, 'render', 'site_renders', [composeSeq], `${pg.slug}.html`);
    renderSeqs.push(rSeq);
  }

  // QA acceptance — after every page is on disk
  emit('QA — acceptance (1 nav · 1 logo · 1 palette, every page)', 'qa', 'site_consistent', renderSeqs);

  return renumber(tasks);
}

// Renumber seqs 1..n and remap depends_on. Mirrors planner.ts:184-185.
function renumber(tasks: Task[]): Task[] {
  tasks.sort((a, b) => a.seq - b.seq);
  const rm: Record<number, number> = {};
  tasks.forEach((t, i) => { rm[t.seq] = i + 1; });
  tasks.forEach(t => {
    t.depends_on = [...new Set(t.depends_on.map(d => rm[d]).filter(d => d !== undefined && d < (rm[t.seq] || t.seq)))];
    t.seq = rm[t.seq];
  });
  return tasks;
}

// ────────────────────────────────────────────────────────────────────────────
// ORCHESTRATE — main entry point
// WHY: combines floor detection + optional LLM upgrade + need detection.
// Returns the orchestration result used by buildPlan() in planner.ts.
// ────────────────────────────────────────────────────────────────────────────

export async function orchestrate(
  brief: string,
  opts: { llm?: (sys: string, user: string, maxTokens: number, flags: any) => Promise<string> } = {},
): Promise<OrchestrationResult> {
  const floor = detectDeliverable(brief);
  let deliverable: DeliverableId = floor;
  let reason = `floor: regex scored ${floor}`;

  // LLM upgrade is ONLY allowed when the floor is directus_site (the default) and a live
  // LLM is available. For any other floor, the classifier is definitive (mirrors archetypeFor).
  if (floor === 'directus_site' && opts.llm) {
    const floorDel = DELIVERABLES['directus_site'];
    const upgradeSet = floorDel.upgradesTo.join('|');
    const sys = `You are the Orchestrator. Given a client brief, select the RIGHT deliverable from this closed set ONLY:
directus_site (default Directus CMS website)
wp_site (WordPress blog/news/content site)
wp_woocommerce (WooCommerce e-commerce store)
fullstack_app (full-stack Node+Postgres app: SaaS, dashboard, booking, marketplace)
campaign (email/social/ad campaign assets — NO website)

Output ONLY a JSON object: {"deliverable":"<id>","reason":"<one sentence>"}.
Valid ids: ${upgradeSet}|directus_site. Default to directus_site for any plain/simple/landing/brochure brief.`;

    try {
      const raw = await Promise.race([
        opts.llm(sys, 'BRIEF: ' + brief, 200, { web: false }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('orchestrate timeout')), 15000)),
      ]);
      const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
      if (s >= 0 && e > s) {
        const parsed = JSON.parse(raw.slice(s, e + 1));
        const proposed = parsed?.deliverable as DeliverableId;
        // Validate it's in the compatible upgrade set (or same as floor)
        if (proposed && (proposed === 'directus_site' || (floorDel.upgradesTo as string[]).includes(proposed))) {
          // Re-run the floor check: if proposed would have a lower score than floor, ignore.
          // (This ensures the LLM cannot downgrade — it can only upgrade.)
          if (proposed !== 'directus_site') {
            deliverable = proposed;
            reason = `llm upgraded directus_site → ${proposed}: ${String(parsed?.reason || '').slice(0, 120)}`;
          } else {
            reason = `llm confirmed directus_site: ${String(parsed?.reason || '').slice(0, 120)}`;
          }
        }
        // if proposed is invalid or not in the upgrade set: silently keep floor (never crash)
      }
    } catch {
      // LLM failed/timed out → keep floor silently
    }
  }

  const del = DELIVERABLES[deliverable];

  // Archetype: take the MAX of what archetypeFor() classifies and what the deliverable says.
  // WHY: archetypeFor() is the existing archetype floor (app-check verifies it). The deliverable
  // must not weaken it (a booking brief that resolves to fullstack_app is still 'app').
  const classifiedArchetype = archetypeFor(del.archetypeCompat, brief);
  // Take the stronger of the two
  const archetype: Archetype =
    (classifiedArchetype === 'store' || del.archetypeCompat === 'store') ? 'store' :
    (classifiedArchetype === 'app'   || del.archetypeCompat === 'app')   ? 'app' :
    'site';

  const detectedNeeds = detectNeeds(brief, archetype, deliverable) as CapId[];

  // T3/T19: build the human-readable chainReason from the assembled chain.
  // We compose a preview chain (with default 1-page) purely to extract the department sequence.
  const previewChain = composeChain(deliverable, detectedNeeds, [{ slug: 'index', title: 'Home' }]);
  const llmReasonForChain = reason.startsWith('llm') ? reason : undefined;
  const chainReason = buildChainReason(deliverable, brief, previewChain, llmReasonForChain);

  return { deliverable, stack: del.stack, builder: del.builder, detectedNeeds, reason, chainReason, archetype };
}

// ────────────────────────────────────────────────────────────────────────────
// applyDeliverable — NO-OP for directus_site; replaces build tail for others.
// WHY: keeps validate()'s classic plan completely untouched for the default path.
// For non-default deliverables, composeChain() provides the tasks.
// ────────────────────────────────────────────────────────────────────────────

export function applyDeliverable(
  built: { tasks: any[]; pages: any[]; theme: any; archetype: any; shape: any; notes?: string[] },
  orchestration: OrchestrationResult,
): { tasks: any[]; pages: any[]; theme: any; archetype: any; shape: any; notes?: string[] } {
  // CRITICAL: for the default deliverable (directus_site), return built UNCHANGED.
  // This is the single load-bearing compatibility guarantee — the 24 existing gates
  // see the EXACT task set validate() produces today.
  if (orchestration.deliverable === 'directus_site') {
    return built;
  }

  // T1: landing_page — force exactly ONE page before composing the chain.
  // WHY: the shape invariant is 1 page; we must not pass built.pages (which the LLM may have
  // proposed as multi-page) into composeChain — that would emit multiple render tasks.
  const chainPages = orchestration.deliverable === 'landing_page'
    ? [{ slug: 'index', title: 'Home' }]
    : built.pages;

  // For other deliverables, use composeChain to build the task list.
  // The spine + branch caps are assembled from the orchestration result.
  const tasks = composeChain(orchestration.deliverable, orchestration.detectedNeeds, chainPages);

  // T1: landing_page also forces the page set to exactly one page in the plan.
  const finalPages = orchestration.deliverable === 'landing_page'
    ? [{ slug: 'index', title: 'Home' }]
    : built.pages;

  return {
    ...built,
    pages: finalPages,
    tasks,
    // Archetype is promoted if the orchestration requires it
    archetype: orchestration.archetype,
  };
}
