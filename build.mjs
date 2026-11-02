// Baut aus src/ die beiden fertigen Dateien in dist/.
//   node build.mjs
// Keine Abhängigkeiten nötig (nur Node.js).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

// Linien-Icons (24×24, Strichstärke über CSS)
const ICONS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  pin: '<path d="M12 21s-7-6.1-7-11.2A7 7 0 0 1 19 9.8C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.6"/>',
  gift: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5.5 12v8.5h13V12M12 8v12.5M12 8S10.6 4 8.3 4.2C6.6 4.4 6.7 7 8.4 7.6 9.9 8 12 8 12 8zm0 0s1.4-4 3.7-3.8c1.7.2 1.6 2.8-.1 3.4-1.5.4-3.6.4-3.6.4z"/>',
  paddle: '<circle cx="9.5" cy="9.5" r="6.5"/><path d="M14.3 14.3 20 20"/><circle cx="19.2" cy="5" r="1.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M7.5 14h2M11 14h2M14.5 14h2M7.5 17.2h2M11 17.2h2"/>',
  trophy: '<path d="M8 4h8v5.5a4 4 0 0 1-8 0z"/><path d="M8 6H5.2a3 3 0 0 0 3.1 4.2M16 6h2.8a3 3 0 0 1-3.1 4.2M12 13.5V17M8.5 20.5h7M9.5 17h5v3.5h-5z"/>',
  phone: '<path d="M6.5 3.5h3l1.6 4.4-2.1 1.4a11.5 11.5 0 0 0 5.7 5.7l1.4-2.1 4.4 1.6v3a2 2 0 0 1-2.1 2A16.5 16.5 0 0 1 4.5 5.6a2 2 0 0 1 2-2.1z"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  arrow: '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
const icon = (name) => {
  if (!ICONS[name]) throw new Error(`Unbekanntes Icon: ${name}`);
  return `<svg class="tt-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
};

// E-Mail-Adressen als HTML-Entities: Browser zeigen sie normal an,
// einfache Adress-Sammelprogramme finden sie nicht im Klartext.
const entities = (s) => [...s].map((c) => `&#${c.codePointAt(0)};`).join('');
const obfuscateMail = (html) =>
  html
    .replace(/mailto:/g, entities('mailto:'))
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => entities(m));

// Leerzeilen entfernen (WordPress würde daraus <p>-Tags machen)
const noBlankLines = (s) => s.split('\n').filter((l) => l.trim() !== '').join('\n');

// Für WordPress alles in eine Zeile: So kann auch der klassische Editor
// (Reiter „Text“) keine <p>- oder <br>-Tags in den Block einbauen.
const oneLineHtml = (s) =>
  s.split('\n').map((l) => l.trim()).filter(Boolean)
    .reduce((acc, l) => (acc === '' ? l : acc.endsWith('>') || l.startsWith('<') ? acc + l : `${acc} ${l}`), '');
const minifyCss = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .replace(/:\s+/g, ':')
    .replace(/;}/g, '}')
    .trim();

const blockCssSrc = read('src/block.css');
const blockCss = noBlankLines(blockCssSrc);
const pageCss = noBlankLines(read('src/page.css'));
let block = read('src/block.html').replace(/\{\{icon:([a-z]+)\}\}/g, (_, n) => icon(n));
block = noBlankLines(obfuscateMail(block));

if (/\{\{/.test(block)) throw new Error('Nicht ersetzter Platzhalter im Block');

const header = `<!-- SV Frensdorf · Tischtennis-Seite (WordPress-Block). Einfügen als WPBakery-Element „Raw HTML“, Gutenberg-Block „Individuelles HTML“ oder im klassischen Editor im Reiter „Text“ – nie im visuellen Editor. Anleitung: README.md -->`;
const wordpress = `${header}<style>${minifyCss(blockCssSrc)}</style>${oneLineHtml(block)}\n`;

// Eigenständige Seite: Überschriftenschrift direkt einbetten (keine Anfrage an
// Google o. Ä.). In WordPress lädt das Theme die Schrift bereits selbst.
// Roboto Condensed, SIL Open Font License 1.1 – siehe src/fonts/OFL.txt
const fontB64 = readFileSync(join(root, 'src/fonts/roboto-condensed-latin-700-normal.woff2')).toString('base64');
const fontCss = `/* Roboto Condensed Bold (latin) – Copyright 2011 Google Inc., SIL Open Font License 1.1 */
@font-face { font-family: "Roboto Condensed"; font-style: normal; font-weight: 700; font-display: swap; src: url(data:font/woff2;base64,${fontB64}) format("woff2"); }`;

const page = read('src/page.html')
  .replace('{{PAGE_CSS}}', () => `${fontCss}\n${pageCss}`)
  .replace('{{BLOCK_CSS}}', () => blockCss)
  .replace('{{BLOCK}}', () => block);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/wordpress-block.html'), wordpress);
writeFileSync(join(root, 'dist/tischtennis.html'), noBlankLines(page) + '\n');

for (const f of ['dist/wordpress-block.html', 'dist/tischtennis.html']) {
  const s = read(f);
  const blank = s.trimEnd().split('\n').filter((l) => l.trim() === '').length;
  console.log(`${f}: ${(Buffer.byteLength(s) / 1024).toFixed(1)} KB, Leerzeilen: ${blank}`);
}
