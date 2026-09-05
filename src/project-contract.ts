// Project contract — intent, exclusions, existing systems. Deterministic.
export type RequestedStack = 'astro' | null;
export type ProjectContract = {
  requestedStack: RequestedStack;
  excludesWebsite: boolean;
  existingBooking: boolean;
  forbidCustomBooking: boolean;
  forbidStore: boolean;
  reasons: string[];
};
export function parseContract(brief: string): ProjectContract {
  const b = ' ' + String(brief || '').toLowerCase() + ' ';
  const reasons: string[] = [];
  const requestedStack: RequestedStack = /\bastro(\.js|\b|-cms)?/.test(b) ? 'astro' : null;
  if (requestedStack) reasons.push('requested stack: astro');
  const excludesWebsite = /\bno website\b|without a website|not a website|no site\b/.test(b);
  if (excludesWebsite) reasons.push('explicit: no website');
  const existingBooking = /\bacuity\b|\bcalendly\b|existing booking|already (books|booking)/.test(b);
  if (existingBooking) reasons.push('existing booking system named');
  const forbidCustomBooking = /do not build a booking|don't build a booking|not a booking platform|do not build a booking platform/.test(b);
  if (forbidCustomBooking) reasons.push('explicit: do not build a booking platform');
  // A class/studio/salon is a website. "shop of bowls" is not a checkout. Agency routing, not keywords.
  const service = /\b(classes?|workshops?|studio|salon|therapist|ceramic|pottery|yoga|pilates)\b/.test(b);
  const notCart = /not a shopping cart|book a class|people book|appointments? not (a )?store/.test(b);
  const explicitSite = /keep it a website|brochure site|not (an )?e-?commerce|not a store|do not build a store|don't build a store/.test(b);
  const forbidStore = notCart || explicitSite || (service && !/\b(checkout|woocommerce|shopping cart|panier)\b/.test(b) && (b.match(/\b(class|workshop|book)\b/g) || []).length >= 1);
  if (forbidStore) reasons.push('service business: website, not a store');
  return { requestedStack, excludesWebsite, existingBooking, forbidCustomBooking, forbidStore, reasons };
}
