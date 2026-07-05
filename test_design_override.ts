import { renderPage } from './src/render.ts';

const pages = [{ slug: 'index', title: 'Home' }];

const baseSpec = {
  brand: {
    name: 'Test Site',
    tokens: {
      bg: '#ffffff',
      primary: '#4f46e5'
    },
    design: {
      palette: {
        bg: '#1a1a1a',
        primary: '#222222'
      },
      source: 'figma'
    }
  },
  sections: [
    {
      type: 'hero',
      headline: 'Welcome'
    }
  ]
};

const html = renderPage(baseSpec, {
  pages,
  slug: 'index',
  title: 'Home',
  theme: 'modern'
});

// Extract the FULL :root section
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (styleMatch) {
  const style = styleMatch[1];
  // Find the full :root{...}
  const rootStart = style.indexOf(':root{');
  const rootEnd = style.indexOf('}', rootStart);
  if (rootStart >= 0 && rootEnd >= 0) {
    const rootSection = style.substring(rootStart, rootEnd + 1);
    console.log('FULL :root section:');
    console.log(rootSection);
    console.log('\n---');
    
    // Count occurrences of each var
    const bgMatches = rootSection.match(/--bg:#[0-9a-f]+/gi) || [];
    const textMatches = rootSection.match(/--text:#[0-9a-f]+/gi) || [];
    const primaryMatches = rootSection.match(/--primary:#[0-9a-f]+/gi) || [];
    
    console.log(`\n--bg occurrences: ${bgMatches.length}`);
    bgMatches.forEach((m, i) => console.log(`  ${i+1}: ${m}`));
    
    console.log(`\n--text occurrences: ${textMatches.length}`);
    textMatches.forEach((m, i) => console.log(`  ${i+1}: ${m}`));
    
    console.log(`\n--primary occurrences: ${primaryMatches.length}`);
    primaryMatches.forEach((m, i) => console.log(`  ${i+1}: ${m}`));
  }
}
