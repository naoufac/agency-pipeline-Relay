// Simulate contrast calculation
function lum([r, g, b]: number[]): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function rgb(h: string): [number, number, number] {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function contrast(a: string, b: string): number {
  const L1 = lum(rgb(a)), L2 = lum(rgb(b));
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

// Original design: light bg + dark text
console.log('ORIGINAL (theme derived):');
console.log(`bg: #ffffff, text: #0b1220`);
console.log(`Contrast: ${contrast('#ffffff', '#0b1220').toFixed(2)}`);
console.log(`WCAG AA (4.5:1): ${contrast('#ffffff', '#0b1220') >= 4.5 ? 'PASS' : 'FAIL'}`);

// After design override: dark bg + dark text
console.log('\nAFTER DESIGN OVERRIDE (without re-derivation):');
console.log(`bg: #1a1a1a (design), text: #0b1220 (not re-derived)`);
console.log(`Contrast: ${contrast('#1a1a1a', '#0b1220').toFixed(2)}`);
console.log(`WCAG AA (4.5:1): ${contrast('#1a1a1a', '#0b1220') >= 4.5 ? 'PASS' : 'FAIL'}`);

// What SHOULD happen if text were re-derived
function pickOn(bg: string) {
  return contrast('#ffffff', bg) >= contrast('#0b1220', bg) ? '#ffffff' : '#0b1220';
}

const correctText = pickOn('#1a1a1a');
console.log('\nCORRECT (if text were re-derived):');
console.log(`bg: #1a1a1a (design), text: ${correctText} (re-derived)`);
console.log(`Contrast: ${contrast('#1a1a1a', correctText).toFixed(2)}`);
console.log(`WCAG AA (4.5:1): ${contrast('#1a1a1a', correctText) >= 4.5 ? 'PASS' : 'FAIL'}`);
