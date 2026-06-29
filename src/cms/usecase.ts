// Deterministic use-case classifier — CODE decides, never the LLM. First match wins. Mirrors
// archetype.ts. Maps a brief to one of five use cases; the runner forces the engine from that.
export type UseCase = 'ecom' | 'fullstack' | 'multilingual' | 'design' | 'general';

const RULES: [UseCase, RegExp][] = [
  ['ecom', /\b(shop|store|e-?commerce|e-?shop|web-?shop|sell(ing)?|sells?|products?|checkout|\bcart\b|catalog(ue)?|boutique|merch|storefront|dropship|subscriptions?|buy online|online (store|shop))\b/i],
  ['fullstack', /\b(app|application|platform|dashboard|saas|booking|reservations?|reserve|portal|marketplace|directory|listings?|\bcrm\b|\berp\b|members? area|membership|login|sign[- ]?up|orders?|inventory|appointments?|scheduling|tracker|on[- ]?demand)\b/i],
  ['multilingual', /\b(multilingual|bilingual|multi-?language|languages?|i18n|l10n|translat(e|ion|ed)|localized|localised|in (english|french|spanish|german|arabic|portuguese)|عرب|中文)\b/i],
  ['design', /\b(portfolio|agency|studio|brand(ing)?|fashion|\bart\b|artist|gallery|photograph\w*|architect\w*|award|futuristic|design-?led|showcase|creative)\b/i],
];

// engine forced per use case. Only WordPress (incl. WooCommerce for ecom) is wired today; the others
// are the documented targets (Drupal for multilingual, Directus for full-stack) — see docs/CMS-AUTOMATION.md.
export const ENGINE_FOR: Record<UseCase, string> = {
  ecom: 'woocommerce',
  general: 'wordpress',
  design: 'wordpress',
  fullstack: 'wordpress',     // TODO: directus
  multilingual: 'wordpress',  // TODO: drupal
};

export function classifyUseCase(brief: string): UseCase {
  const b = ' ' + String(brief || '') + ' ';
  for (const [name, re] of RULES) if (re.test(b)) return name;
  return 'general';
}
