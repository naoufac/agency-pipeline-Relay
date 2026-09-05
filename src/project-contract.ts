// Project contract — intent, exclusions, existing systems. Deterministic.
export type RequestedStack = 'astro' | null;
export type ProjectContract = {
  requestedStack: RequestedStack;
  excludesWebsite: boolean;
  existingBooking: boolean;
  forbidCustomBooking: boolean;
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
  return { requestedStack, excludesWebsite, existingBooking, forbidCustomBooking, reasons };
}
