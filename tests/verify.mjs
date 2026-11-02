// Prüft die gebauten Dateien in dist/.
//   node build.mjs && node tests/verify.mjs          (alle Prüfungen)
//   node tests/verify.mjs --docs                     (zusätzlich Vorschaubilder nach docs/)
//
// Benötigt Playwright (npm i playwright) und curl. Die Online-Quellen
// (myTischtennis, click-TT) sind saisonabhängig verlinkt – siehe SOURCES.
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'tests/output');
const DOCS = process.argv.includes('--docs');
mkdirSync(OUT, { recursive: true });

const WP_FILE = join(root, 'dist/wordpress-block.html');
const PAGE_FILE = join(root, 'dist/tischtennis.html');
const LIVE_PAGE = 'https://svfrensdorf.de/dt_activities/tischtennis/';
const WIDTHS = [1400, 768, 375];

// Online-Quellen für Kontaktdaten und Halle (Stand Saison 2026/27)
const MYTT = 'https://www.mytischtennis.de/click-tt/ByTTV/26--27/ligen';
const SOURCES = {
  team1: `${MYTT}/Erwachsene_Bezirksklasse_C_Gruppe_8_Bamberg_S%C3%BCd_(Bayerischer_TTV_-_Oberfranken-West)/gruppe/524103/mannschaft/3117579/Erwachsene_(4er)/infos`,
  team2: `${MYTT}/Erwachsene_Bezirksklasse_D_Gruppe_8_Bamberg-Nord_(Bayerischer_TTV_-_Oberfranken-West)/gruppe/524179/mannschaft/3115892/Erwachsene_II_(4er)/infos`,
  clickTT: 'https://bttv.click-tt.de/cgi-bin/WebObjects/nuLigaTTDE.woa/wa/clubInfoDisplay?club=23708',
};

// Angaben, die direkt vom Verein stammen (nicht online nachprüfbar)
const FROM_CLUB = [
  ['Training Montag 19:00 – ca. 21:00 Uhr', /Montag\s*19:00 – ca\. 21:00 Uhr/],
  ['Training Freitag 19:00 – ca. 21:00 Uhr', /Freitag\s*19:00 – ca\. 21:00 Uhr/],
  ['Jugend in der Regel bis 20:15 Uhr', /Jugend trainiert in der Regel bis 20:15\s?Uhr/],
  ['Schnupperstunden kostenlos', /Mehrere Schnupperstunden sind kostenlos/],
  ['Leihschläger vorhanden', /Leihschläger sind vorhanden/],
  ['Kein Abteilungsbeitrag', /zusätzlichen Abteilungsbeitrag gibt es nicht/],
  ['Jährliche Vereinsmeisterschaften', /Jedes Jahr spielen wir unsere Vereinsmeisterschaften aus/],
  ['Jeder willkommen', /jeder willkommen/i],
];
const HEIKO_PHONE = '01759111824'; // vom Verein mitgeteilt

// ---------------------------------------------------------------------------
const results = [];
const check = (group, name, pass, detail = '') => results.push({ group, name, pass: !!pass, detail });
const digits = (s) => String(s).replace(/\D/g, '');
const telToNational = (href) => '0' + digits(href).replace(/^49/, '');
const curlStatus = (url) => {
  try {
    return execFileSync('curl', ['-sS', '-L', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '30',
      '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', url], { encoding: 'utf8' }).trim();
  } catch (e) {
    return `Fehler: ${e.message.split('\n')[0]}`;
  }
};

// ---------- 1. Statische Prüfungen ----------
const wpRaw = readFileSync(WP_FILE, 'utf8');
const pageRaw = readFileSync(PAGE_FILE, 'utf8');
for (const [label, s] of [['WordPress-Block', wpRaw], ['Eigenständige Seite', pageRaw]]) {
  check('Statisch', `${label}: kein JavaScript`, !/<script/i.test(s));
  check('Statisch', `${label}: keine externen Quellen (src/url/@import)`,
    !/\ssrc=["']?https?:/i.test(s) && !/url\(\s*["']?(?!data:|#)/i.test(s) && !/@import/i.test(s));
  check('Statisch', `${label}: keine Leerzeilen`, !s.trimEnd().split('\n').some((l) => l.trim() === ''));
  check('Statisch', `${label}: keine Platzhalter übrig`, !/\{\{/.test(s));
  check('Statisch', `${label}: E-Mail-Adressen nicht im Klartext`, !/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(s.replace(/<!--[\s\S]*?-->/g, '')));
}
check('Statisch', 'WordPress-Block ist einzeilig (sicher gegen wpautop)', wpRaw.trimEnd().split('\n').length === 1);

// ---------- Hilfsfunktionen im Browser ----------
async function readBlock(page) {
  return page.evaluate(() => {
    const rootEl = document.querySelector('#svf-tt');
    const people = [...rootEl.querySelectorAll('.tt-person')].map((p) => ({
      name: p.querySelector('.tt-h3').textContent.trim(),
      role: p.querySelector('.tt-person__role').textContent.trim(),
      tel: p.querySelector('a[href^="tel:"]')?.getAttribute('href'),
      telText: p.querySelector('a[href^="tel:"]')?.textContent.trim(),
      mail: p.querySelector('a[href^="mailto:"]')?.getAttribute('href'),
      mailText: p.querySelector('a[href^="mailto:"]')?.textContent.trim(),
    }));
    const links = [...rootEl.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent.trim() }));
    const ids = [...rootEl.querySelectorAll('[id]')].map((e) => e.id).concat(rootEl.id);
    return { text: rootEl.innerText, textContent: rootEl.textContent.replace(/\s+/g, ' '), people, links, ids };
  });
}

async function layoutChecks(page, label, width) {
  const r = await page.evaluate(async () => {
    await document.fonts.ready;
    const root = document.querySelector('#svf-tt');
    const out = {};
    out.docOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const rr = root.getBoundingClientRect();
    out.blockWidth = Math.round(rr.width);
    // Schrift & Theme-Abwehr
    const h2 = root.querySelector('#svf-tt-training-h');
    const s = getComputedStyle(h2);
    out.h2 = { font: s.fontFamily, color: s.color, mb: s.marginBottom, tt: s.textTransform, size: s.fontSize };
    out.fontLoaded = document.fonts.check('700 20px "Roboto Condensed"');
    const li = root.querySelector('.tt-fact');
    out.li = { list: getComputedStyle(li).listStyleType, before: getComputedStyle(li, '::before').content, ml: getComputedStyle(root.querySelector('.tt-facts')).paddingLeft };
    const p = root.querySelector('.tt-text');
    out.p = { font: getComputedStyle(p).fontFamily, size: getComputedStyle(p).fontSize, color: getComputedStyle(p).color };
    // Inhalte ragen nicht aus ihrem Kasten
    const boxSel = '.tt-fact, .tt-card, .tt-hero, .tt-venue, .tt-faq__item, .tt-schedule';
    out.overflow = [];
    for (const el of root.querySelectorAll('.tt-fact__big, .tt-fact__small, .tt-h2, .tt-h3, .tt-hero__title, .tt-btn, .tt-person__link span, .tt-faq__q, .tt-schedule dd, .tt-text')) {
      const box = el.closest(boxSel) || root;
      if (box === el) continue;
      const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (a.width === 0) continue;
      if (a.right > b.right + 1 || a.left < b.left - 1) out.overflow.push(`${el.className || el.tagName}: „${el.textContent.trim().slice(0, 30)}“`);
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) out.overflow.push(`${el.className}: Text breiter als Element („${el.textContent.trim().slice(0, 30)}“)`);
    }
    // Tippflächen
    out.small = [];
    for (const el of root.querySelectorAll('.tt-btn, .tt-person__link, .tt-faq__q, .tt-link--arrow')) {
      const b = el.getBoundingClientRect();
      if (b.width && (b.height < 44 || b.width < 44)) out.small.push(`${el.textContent.trim().slice(0, 25)} (${Math.round(b.width)}×${Math.round(b.height)})`);
    }
    for (const el of root.querySelectorAll('.tt-link:not(.tt-link--arrow)')) {
      const b = el.getBoundingClientRect();
      if (b.height < 24) out.small.push(`${el.textContent.trim()} (${Math.round(b.height)} px hoch)`);
    }
    // Kontrast aller sichtbaren Texte
    const parse = (c) => { const m = c && c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
    const mix = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (x, y) => { const a = lum(x), b = lum(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const backgrounds = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage.includes('gradient')) {
          const base = [...cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0]));
          return base.map((c) => layers.reduceRight((acc, l) => mix(l, acc), c));
        }
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) { if (c.a >= 1) return [layers.reduceRight((acc, l) => mix(l, acc), c)]; layers.push(c); }
      }
      return [layers.reduceRight((acc, l) => mix(l, acc), { r: 255, g: 255, b: 255, a: 1 })];
    };
    out.contrast = { min: 99, fails: [] };
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('.tt-sr, svg')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      for (const bg of backgrounds(el)) {
        const r = ratio(mix(fg, bg), bg);
        out.contrast.min = Math.min(out.contrast.min, r);
        if (r < need) out.contrast.fails.push(`„${el.textContent.trim().slice(0, 30)}“ ${r.toFixed(2)}:1 (nötig ${need}:1)`);
      }
    }
    out.contrast.min = Math.round(out.contrast.min * 100) / 100;
    return out;
  });
  const g = `${label} ${width}px`;
  check(g, 'kein seitliches Scrollen', r.docOverflow <= 0, `${r.docOverflow}px zu breit`);
  check(g, 'Überschriften in Roboto Condensed, Großbuchstaben', /Roboto Condensed/.test(r.h2.font) && r.h2.tt === 'uppercase' && r.fontLoaded, JSON.stringify(r.h2));
  check(g, 'Theme verstellt Überschriften nicht (Farbe/Abstand)', r.h2.color === 'rgb(38, 38, 38)' && r.h2.mb === '18px', JSON.stringify(r.h2));
  check(g, 'Theme verstellt Listen nicht', r.li.list === 'none' && /none|normal/.test(r.li.before) && r.li.ml === '0px', JSON.stringify(r.li));
  check(g, 'Fließtext: Roboto 16px, #4d4d4d', /Roboto/.test(r.p.font) && r.p.size === '16px' && r.p.color === 'rgb(77, 77, 77)', JSON.stringify(r.p));
  check(g, 'nichts ragt aus Kacheln/Karten', r.overflow.length === 0, r.overflow.join('; '));
  check(g, 'Tippflächen groß genug (≥ 44 px, Textlinks ≥ 24 px)', r.small.length === 0, r.small.join('; '));
  check(g, `Kontrast ok (Minimum ${r.contrast.min}:1)`, r.contrast.fails.length === 0, r.contrast.fails.join('; '));
}

async function interactionChecks(page, label) {
  const faq = page.locator('#svf-tt .tt-faq__item').first();
  await faq.locator('summary').click();
  const opened = await faq.evaluate((d) => d.open && d.querySelector('.tt-faq__a').getBoundingClientRect().height > 0);
  await faq.locator('summary').click();
  const closed = await faq.evaluate((d) => !d.open);
  check(label, 'Häufige Fragen klappen auf und zu', opened && closed);
  await page.locator('#svf-tt a[href="#svf-tt-mitmachen"]').click();
  await page.waitForTimeout(600);
  const visible = await page.evaluate(() => {
    const t = document.querySelector('#svf-tt-mitmachen').getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(t.left + 40, window.innerWidth - 5), Math.max(t.top + 12, 1));
    return t.top >= -1 && t.top < window.innerHeight && !!hit && !!hit.closest('#svf-tt-mitmachen');
  });
  check(label, 'Button „Probetraining“ springt sichtbar zu „Mitmachen“', visible);
}

// ---------- Browser starten ----------
const browser = await chromium.launch();

// ---------- 2. Eigenständige Seite ----------
let pageData;
for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const external = [];
  page.on('request', (req) => { if (!/^(file|data):/.test(req.url())) external.push(req.url()); });
  await page.goto(pathToFileURL(PAGE_FILE).href, { waitUntil: 'load' });
  if (!pageData) pageData = await readBlock(page);
  await layoutChecks(page, 'Eigenständige Seite', width);
  if (width !== 768) await interactionChecks(page, `Eigenständige Seite ${width}px`);
  check(`Eigenständige Seite ${width}px`, 'keine Anfragen an fremde Server', external.length === 0, external.join(', '));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(OUT, `eigenstaendig-${width}.png`), fullPage: true });
  await page.close();
}

// ---------- 3. Fakten ----------
const T = pageData.text;
for (const [name, re] of FROM_CLUB) check('Fakten (Verein)', name, re.test(T) || re.test(pageData.textContent));
const heiko = pageData.people.find((p) => p.name === 'Heiko Lorz');
check('Fakten (Verein)', 'Heiko Lorz: Telefon 0175 9111824', heiko && telToNational(heiko.tel) === HEIKO_PHONE && digits(heiko.telText) === HEIKO_PHONE, JSON.stringify(heiko));
check('Fakten', 'Genau drei Ansprechpartner', pageData.people.length === 3, pageData.people.map((p) => p.name).join(', '));
for (const p of pageData.people) {
  check('Fakten', `${p.name}: Anzeige = Link (Telefon & Mail)`,
    p.tel && p.mail && telToNational(p.tel) === digits(p.telText) && p.mail === `mailto:${p.mailText}`, JSON.stringify(p));
}

async function sourceText(url, mustContain) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await browser.newPage({ locale: 'de-DE' });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
      if (text.includes(mustContain)) return text;
    } catch { /* nochmal versuchen */ } finally { await page.close(); }
  }
  return null;
}
const src1 = await sourceText(SOURCES.team1, 'Mannschaftskontakt');
const src2 = await sourceText(SOURCES.team2, 'Mannschaftskontakt');
const srcC = await sourceText(SOURCES.clickTT, 'Spiellokal');
check('Quellen', 'myTischtennis Mannschaft 1 erreichbar', !!src1);
check('Quellen', 'myTischtennis Mannschaft 2 erreichbar', !!src2);
check('Quellen', 'click-TT Vereinsseite erreichbar', !!srcC);
const person = (n) => pageData.people.find((p) => p.name === n) || {};
const sb = person('Sebastian Berthold'), hl = person('Heiko Lorz'), je = person('Jonas Ehrbar');
if (src1) {
  check('Fakten (myTischtennis)', 'Heiko Lorz ist Mannschaftskontakt, Mail stimmt', /Mannschaftskontakt\s*Heiko Lorz/.test(src1) && src1.includes(hl.mailText));
  check('Fakten (myTischtennis)', 'Sebastian Berthold: Mail und Telefon stimmen', src1.includes(sb.mailText) && digits(src1).includes(digits(sb.telText)));
  check('Fakten (myTischtennis)', 'Bayerischer TTV, Bezirk Oberfranken-West', /Bayerischer TTV - Oberfranken-West/.test(src1) && /Bayerischen Tischtennis-Verbands, Bezirk Oberfranken-West/.test(T));
  check('Fakten (myTischtennis)', 'Spiellokal Schulturnhalle Frensdorf, Bahnhofstr. 1, 96158 Frensdorf',
    /Schulturnhalle Frensdorf\s*Bahnhofstr\. 1\s*96158 Frensdorf/.test(src1) && /Schulturnhalle Frensdorf, Bahnhofstr\. 1, 96158 Frensdorf/.test(T));
}
if (src2) {
  check('Fakten (myTischtennis)', 'Jonas Ehrbar ist Mannschaftskontakt, Mail stimmt', /Mannschaftskontakt\s*Jonas Ehrbar/.test(src2) && src2.includes(je.mailText));
  check('Fakten (myTischtennis)', 'Jonas Ehrbar: Telefon stimmt', digits(src2).includes(digits(je.telText)));
}
if (srcC) {
  check('Fakten (click-TT)', 'Abteilungsleiter-Telefon 0159 08482313', digits(srcC).includes(digits(sb.telText)));
  check('Fakten (click-TT)', 'Spiellokal Bahnhofstr. 1, 96158 Frensdorf', /Schulturnhalle Frensdorf\s*Bahnhofstr\. 1, 96158 Frensdorf/.test(srcC));
}

// ---------- 4. Links ----------
const ids = new Set(pageData.ids);
check('Links', 'IDs eindeutig', ids.size === pageData.ids.length);
const seen = new Set();
for (const l of pageData.links) {
  if (l.href.startsWith('#')) { check('Links', `Sprungziel ${l.href} vorhanden`, ids.has(l.href.slice(1))); continue; }
  if (l.href.startsWith('mailto:')) { check('Links', `${l.href} gültig`, /^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(l.href)); continue; }
  if (l.href.startsWith('tel:')) { check('Links', `${l.href} gültig`, /^tel:\+49\d{9,12}$/.test(l.href)); continue; }
  if (seen.has(l.href)) continue;
  seen.add(l.href);
  const external = !/^https:\/\/svfrensdorf\.de\//.test(l.href);
  if (external) check('Links', `öffnet in neuem Fenster: ${l.text.slice(0, 30)}`, l.target === '_blank' && /noopener/.test(l.rel));
  const code = curlStatus(l.href);
  if (/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/.test(l.href) && code === '429') {
    // Google beantwortet automatische Abrufe mit 429 („zu viele Anfragen“); das Link-Format
    // entspricht der offiziellen Maps-URL-Schnittstelle (api=1&destination=…).
    check('Links', `${l.href} → HTTP 429 (Google blockt Skripte; Format geprüft)`, true);
    continue;
  }
  check('Links', `${l.href} → HTTP ${code}`, /^2\d\d$/.test(code));
}
for (const href of new Set([...pageRaw.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&')))) {
  if (seen.has(href)) continue;
  seen.add(href);
  const code = curlStatus(href);
  check('Links', `Seitenrahmen: ${href} → HTTP ${code}`, /^2\d\d$/.test(code));
}

// ---------- 5. WordPress-Block im echten Theme ----------
const wpBlock = wpRaw;
for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.goto(LIVE_PAGE, { waitUntil: 'networkidle', timeout: 90000 });
  } catch (e) {
    check(`WordPress-Theme ${width}px`, 'Live-Seite erreichbar', false, e.message.split('\n')[0]);
    await page.close();
    continue;
  }
  const placed = await page.evaluate((html) => {
    const target = document.querySelector('.dt-activity-single-details');
    if (!target) return false;
    target.innerHTML = html;
    const c = document.querySelector('.dt-cookie-consent');
    if (c) c.style.display = 'none';
    return true;
  }, wpBlock);
  check(`WordPress-Theme ${width}px`, 'Block an Stelle des Platzhalters eingesetzt', placed);
  if (!placed) { await page.close(); continue; }
  await page.waitForTimeout(500);
  const wpData = await readBlock(page);
  const squash = (t) => t.replace(/\s+/g, '');
  check(`WordPress-Theme ${width}px`, 'Inhalt identisch mit eigenständiger Seite', squash(wpData.textContent) === squash(pageData.textContent));
  await layoutChecks(page, 'WordPress-Theme', width);
  if (width !== 768) await interactionChecks(page, `WordPress-Theme ${width}px`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `wordpress-${width}.png`), fullPage: true });
  await page.close();
}
await browser.close();

// ---------- 6. HTML-Validierung ----------
try {
  execFileSync('npx', ['--yes', 'html-validate@9.7.1', '--config', join(root, 'tests/htmlvalidate.json'), PAGE_FILE, WP_FILE], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  check('HTML', 'html-validate: keine Fehler', true);
} catch (e) {
  check('HTML', 'html-validate: keine Fehler', false, (e.stdout || e.message).trim().slice(0, 1500));
}

// ---------- Ergebnis ----------
if (DOCS) {
  copyFileSync(join(OUT, 'wordpress-1400.png'), join(root, 'docs/vorschau-wordpress-desktop.png'));
  copyFileSync(join(OUT, 'wordpress-375.png'), join(root, 'docs/vorschau-wordpress-mobil.png'));
  copyFileSync(join(OUT, 'eigenstaendig-1400.png'), join(root, 'docs/vorschau-eigenstaendig-desktop.png'));
}
let lastGroup = '';
for (const r of results) {
  if (r.group !== lastGroup) { console.log(`\n${r.group}`); lastGroup = r.group; }
  console.log(`  ${r.pass ? '✔' : '✘'} ${r.name}${!r.pass && r.detail ? `\n      → ${r.detail}` : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden${failed ? ` – ${failed} fehlgeschlagen` : ''}.`);
process.exit(failed ? 1 : 0);
