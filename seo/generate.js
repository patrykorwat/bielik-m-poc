#!/usr/bin/env node

/**
 * SEO Page Generator for formulo.pl
 *
 * Reads CKE exam datasets and generates static HTML pages
 * that Express serves before the SPA fallback.
 * Google indexes each page individually.
 *
 * Output: seo/pages/ directory with HTML files
 *         seo/sitemap.xml
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(__dirname, 'pages');
const SITE = 'https://formulo.pl';

mkdirSync(OUT, { recursive: true });

// ── Load all datasets ─────────────────────────────────────────────────

function loadDatasets() {
  const sets = [];
  for (const level of ['podstawowa', 'rozszerzona']) {
    const dir = join(ROOT, 'datasets', level);
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const [yearStr, lvlNum] = file.replace('.json', '').split('_');
      const year = parseInt(yearStr);
      const levelName = lvlNum === '1' ? 'podstawowa' : 'rozszerzona';
      const levelLabel = lvlNum === '1' ? 'Podstawowa' : 'Rozszerzona';
      sets.push({ year, level: levelName, levelLabel, tasks: data, file });
    }
  }
  return sets;
}

// ── HTML template helpers ─────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function layout(title, description, canonical, body) {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Formulo">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.28/dist/katex.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.7; color: #1a1a2e; background: #f8f9fc; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1.5rem 2rem; }
    .header a { color: white; text-decoration: none; font-size: 1.5rem; font-weight: 700; }
    .header .subtitle { font-size: 0.9rem; opacity: 0.85; margin-top: 0.25rem; }
    .container { max-width: 800px; margin: 2rem auto; padding: 0 1.5rem; }
    h1 { font-size: 1.6rem; margin-bottom: 1rem; color: #1a1a2e; }
    h2 { font-size: 1.2rem; margin: 1.5rem 0 0.75rem; color: #333; }
    .breadcrumb { font-size: 0.85rem; color: #666; margin-bottom: 1.5rem; }
    .breadcrumb a { color: #667eea; text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .task-card { background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .task-card h3 { font-size: 1rem; color: #667eea; margin-bottom: 0.75rem; }
    .task-content { font-size: 0.95rem; line-height: 1.8; }
    .task-answer { margin-top: 1rem; padding: 0.75rem 1rem; background: #f0f4ff; border-left: 3px solid #667eea; border-radius: 4px; font-weight: 500; }
    .year-card { display: block; background: white; border-radius: 12px; padding: 1.25rem 1.5rem; margin-bottom: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-decoration: none; color: #1a1a2e; transition: transform 0.15s; }
    .year-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
    .year-card .meta { font-size: 0.85rem; color: #888; margin-top: 0.25rem; }
    .cta { display: inline-block; margin-top: 2rem; padding: 0.85rem 2rem; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 1rem; }
    .cta:hover { opacity: 0.9; }
    .footer { text-align: center; padding: 2rem; color: #999; font-size: 0.8rem; margin-top: 2rem; }
    .footer a { color: #667eea; text-decoration: none; }
    .katex-display { margin: 1rem 0; overflow-x: auto; }
    @media (max-width: 600px) { .container { padding: 0 1rem; } h1 { font-size: 1.3rem; } }
  </style>
</head>
<body>
  <div class="header">
    <a href="/">Formulo</a>
    <div class="subtitle">Darmowy asystent matematyczny AI po polsku</div>
  </div>
  <div class="container">
    ${body}
    <a href="/" class="cta">Rozwiąż zadanie z AI</a>
  </div>
  <div class="footer">
    <a href="/">formulo.pl</a> &middot; Darmowy asystent matematyczny oparty na modelu Bielik
  </div>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.28/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.28/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body, {delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]})"></script>
</body>
</html>`;
}

function slug(year, level) {
  return `matura-${level}-${year}`;
}

// ── Generate pages ────────────────────────────────────────────────────

const datasets = loadDatasets();
const sitemapUrls = [];

// 1. Index page: /zadania/
console.log('Generating /zadania/ index...');
const indexCards = datasets.map(ds => {
  const s = slug(ds.year, ds.level);
  return `<a href="/zadania/${s}/" class="year-card">
      <strong>Matura ${ds.levelLabel} ${ds.year}</strong>
      <div class="meta">${ds.tasks.length} zadań</div>
    </a>`;
}).join('\n');

const indexHtml = layout(
  'Zadania maturalne z matematyki | Formulo',
  'Zbiór zadań maturalnych CKE z matematyki (podstawowa i rozszerzona) z lat 2015-2024. Rozwiąż je krok po kroku z AI.',
  `${SITE}/zadania/`,
  `<h1>Zadania maturalne z matematyki</h1>
   <p style="margin-bottom:1.5rem;color:#555">Wybierz rok i poziom. Każde zadanie możesz rozwiązać krok po kroku z pomocą AI.</p>
   ${indexCards}`
);
mkdirSync(join(OUT, 'zadania'), { recursive: true });
writeFileSync(join(OUT, 'zadania', 'index.html'), indexHtml);
sitemapUrls.push(`${SITE}/zadania/`);

// 2. Year pages + task pages
for (const ds of datasets) {
  const s = slug(ds.year, ds.level);
  const yearDir = join(OUT, 'zadania', s);
  mkdirSync(yearDir, { recursive: true });

  // Year listing page
  const taskCards = ds.tasks.map((task, i) => {
    const num = task.metadata?.task_number || (i + 1);
    const pts = task.metadata?.max_points || '';
    const preview = task.question.replace(/\$\$[\s\S]*?\$\$/g, '[wzór]').replace(/\$[^$]+\$/g, '[wzór]').substring(0, 150);
    return `<a href="/zadania/${s}/zadanie-${num}" class="year-card">
        <strong>Zadanie ${num}</strong>${pts ? ` (${pts} pkt)` : ''}
        <div class="meta">${escapeHtml(preview)}...</div>
      </a>`;
  }).join('\n');

  const yearTitle = `Matura ${ds.levelLabel} ${ds.year} | Zadania z matematyki`;
  const yearDesc = `Wszystkie zadania z matury ${ds.level === 'rozszerzona' ? 'rozszerzonej' : 'podstawowej'} z matematyki ${ds.year}. Rozwiąż krok po kroku z AI.`;

  const yearHtml = layout(yearTitle, yearDesc, `${SITE}/zadania/${s}/`,
    `<div class="breadcrumb"><a href="/zadania/">Zadania maturalne</a> &rsaquo; Matura ${ds.levelLabel} ${ds.year}</div>
     <h1>Matura ${ds.levelLabel} ${ds.year} &ndash; Matematyka</h1>
     <p style="margin-bottom:1.5rem;color:#555">${ds.tasks.length} zadań. Kliknij, by zobaczyć treść i rozwiązać z AI.</p>
     ${taskCards}`
  );
  writeFileSync(join(yearDir, 'index.html'), yearHtml);
  sitemapUrls.push(`${SITE}/zadania/${s}/`);

  // Individual task pages
  for (let i = 0; i < ds.tasks.length; i++) {
    const task = ds.tasks[i];
    const num = task.metadata?.task_number || (i + 1);
    const pts = task.metadata?.max_points || '';

    const taskTitle = `Zadanie ${num} | Matura ${ds.levelLabel} ${ds.year} | Formulo`;
    const taskDesc = `Matura ${ds.level === 'rozszerzona' ? 'rozszerzona' : 'podstawowa'} ${ds.year}, zadanie ${num}${pts ? ` (${pts} pkt)` : ''}. Rozwiąż krok po kroku z darmowym asystentem AI.`;

    let optionsHtml = '';
    if (task.options && typeof task.options === 'object') {
      const entries = Object.entries(task.options);
      if (entries.length > 0) {
        optionsHtml = '<div style="margin-top:1rem"><strong>Odpowiedzi:</strong><br>' +
          entries.map(([k, v]) => `${escapeHtml(k)}. ${v}`).join('<br>') + '</div>';
      }
    }

    const answerHtml = task.answer
      ? `<div class="task-answer">Odpowiedź: ${task.answer}</div>`
      : '';

    // Navigation
    const prevNum = i > 0 ? (ds.tasks[i - 1].metadata?.task_number || i) : null;
    const nextNum = i < ds.tasks.length - 1 ? (ds.tasks[i + 1].metadata?.task_number || (i + 2)) : null;
    let nav = '<div style="margin-top:1.5rem;display:flex;justify-content:space-between;font-size:0.9rem">';
    nav += prevNum ? `<a href="/zadania/${s}/zadanie-${prevNum}" style="color:#667eea">Zadanie ${prevNum}</a>` : '<span></span>';
    nav += nextNum ? `<a href="/zadania/${s}/zadanie-${nextNum}" style="color:#667eea">Zadanie ${nextNum}</a>` : '<span></span>';
    nav += '</div>';

    const taskHtml = layout(taskTitle, taskDesc, `${SITE}/zadania/${s}/zadanie-${num}`,
      `<div class="breadcrumb">
         <a href="/zadania/">Zadania</a> &rsaquo;
         <a href="/zadania/${s}/">Matura ${ds.levelLabel} ${ds.year}</a> &rsaquo;
         Zadanie ${num}
       </div>
       <h1>Zadanie ${num}${pts ? ` (${pts} pkt)` : ''}</h1>
       <h2>Matura ${ds.levelLabel} ${ds.year}</h2>
       <div class="task-card">
         <div class="task-content">${task.question}</div>
         ${optionsHtml}
         ${answerHtml}
       </div>
       ${nav}`
    );
    writeFileSync(join(yearDir, `zadanie-${num}.html`), taskHtml);
    sitemapUrls.push(`${SITE}/zadania/${s}/zadanie-${num}`);
  }

  console.log(`  ${s}: ${ds.tasks.length} task pages`);
}

// 3. Topic landing pages
const topics = [
  { slug: 'funkcja-kwadratowa', title: 'Funkcja kwadratowa', desc: 'Zadania maturalne z funkcji kwadratowej: wyznaczanie wierzchołka, miejsc zerowych, postaci kanonicznej, iloczynu i ogólnej. Rozwiąż krok po kroku z AI.',
    content: 'Funkcja kwadratowa to jeden z najczęstszych tematów na maturze z matematyki. Formulo rozwiązuje zadania z funkcji kwadratowej krok po kroku, wyjaśniając każdy etap: od wyznaczania delty, przez miejsca zerowe, po postać kanoniczną i analizę wykresu paraboli. Wspierane typy zadań obejmują równania kwadratowe, nierówności kwadratowe, wyznaczanie wierzchołka paraboli, analizę parametrów a, b, c oraz zadania z wartością największą i najmniejszą funkcji kwadratowej na przedziale.' },
  { slug: 'trygonometria', title: 'Trygonometria', desc: 'Zadania maturalne z trygonometrii: funkcje trygonometryczne, tożsamości, równania i nierówności trygonometryczne. Rozwiąż z AI.',
    content: 'Trygonometria obejmuje funkcje sinus, cosinus, tangens i cotangens, ich wykresy, tożsamości trygonometryczne, wzory redukcyjne oraz równania i nierówności trygonometryczne. Formulo rozwiązuje te zadania symboliczne przez SymPy, podając dokładne wartości (nie przybliżenia dziesiętne). Obsługiwane zagadnienia: wartości funkcji trygonometrycznych dla kątów standardowych, wzory na sumę i różnicę kątów, wzory podwójnego kąta, równania typu sin(x) = a, nierówności trygonometryczne, zastosowania trygonometrii w geometrii (twierdzenie sinusów i cosinusów).' },
  { slug: 'ciagi', title: 'Ciągi arytmetyczne i geometryczne', desc: 'Zadania maturalne z ciągów: ciąg arytmetyczny, geometryczny, sumy częściowe, wzór ogólny. Krok po kroku z AI.',
    content: 'Ciągi liczbowe to obowiązkowy temat maturalny. Formulo obsługuje ciągi arytmetyczne (wzór na n-ty wyraz, suma n wyrazów, własności), ciągi geometryczne (iloraz, suma, zbieżność szeregu geometrycznego), ciągi rekurencyjne oraz zadania tekstowe prowadzące do ciągów. System automatycznie rozpoznaje typ ciągu i dobiera odpowiedni wzór: a_n = a_1 + (n-1)d dla arytmetycznego, a_n = a_1 * q^(n-1) dla geometrycznego.' },
  { slug: 'geometria-analityczna', title: 'Geometria analityczna', desc: 'Zadania maturalne z geometrii analitycznej: proste, okręgi, parabole, odległości, wektory. Rozwiąż z AI.',
    content: 'Geometria analityczna na maturze obejmuje równania prostych (postać ogólna, kierunkowa, odcinkowa), wzajemne położenie prostych (równoległość, prostopadłość), odległość punktu od prostej, równanie okręgu, wzajemne położenie prostej i okręgu, parabole jako wykresy funkcji kwadratowych oraz wektory. Formulo rozwiązuje te zadania symbolicznie, wyznaczając współrzędne punktów przecięcia, odległości, pola figur i inne wielkości geometryczne.' },
  { slug: 'prawdopodobienstwo', title: 'Rachunek prawdopodobieństwa', desc: 'Zadania maturalne z prawdopodobieństwa: prawdopodobieństwo klasyczne, warunkowe, schemat Bernoulliego. Rozwiąż z AI.',
    content: 'Rachunek prawdopodobieństwa na maturze obejmuje prawdopodobieństwo klasyczne (stosunek zdarzeń sprzyjających do wszystkich), prawdopodobieństwo warunkowe, wzór Bayesa, schemat Bernoulliego (powtarzanie doświadczeń niezależnych), drzewa decyzyjne i podstawy kombinatoryki potrzebne do obliczania liczby zdarzeń. Formulo rozwiązuje te zadania krok po kroku, obliczając symboliczne ułamki zamiast przybliżeń dziesiętnych.' },
  { slug: 'pochodne', title: 'Pochodne i analiza funkcji', desc: 'Zadania z pochodnych: obliczanie pochodnych, ekstrema, monotoniczność, styczne, optymalizacja. Rozwiąż z AI.',
    content: 'Pochodne i analiza funkcji to tematy matury rozszerzonej. Formulo obsługuje: obliczanie pochodnych (wielomiany, funkcje wymierne, trygonometryczne, wykładnicze, logarytmiczne), wyznaczanie ekstremów lokalnych i globalnych, badanie monotoniczności, wyznaczanie równania stycznej do wykresu funkcji, zadania optymalizacyjne (szukanie minimum/maksimum) oraz pełny przebieg zmienności funkcji z analizą dziedziny, granic, asymptot i punktów przegięcia.' },
  { slug: 'rownania', title: 'Równania i nierówności', desc: 'Zadania maturalne z równań: wielomianowe, wymierne, z wartością bezwzględną, z parametrem, układy równań. Rozwiąż z AI.',
    content: 'Równania i nierówności to fundament matury z matematyki. Formulo rozwiązuje równania wielomianowe (w tym kwadratowe, sześcienne), równania wymierne, równania z wartością bezwzględną, równania z parametrem, układy równań liniowych i nieliniowych, nierówności wielomianowe, nierówności wymierne oraz nierówności z wartością bezwzględną. System automatycznie sprawdza dziedzinę i eliminuje rozwiązania pozorne.' },
  { slug: 'kombinatoryka', title: 'Kombinatoryka', desc: 'Zadania maturalne z kombinatoryki: permutacje, kombinacje, wariacje, silnia, zasada mnożenia. Rozwiąż z AI.',
    content: 'Kombinatoryka na maturze obejmuje permutacje (uporządkowania zbioru), kombinacje (wybór k z n elementów), wariacje z powtórzeniami i bez, silnię, symbol Newtona, zasadę mnożenia i dodawania oraz twierdzenie o dwumianie Newtona. Formulo rozwiązuje te zadania krok po kroku, weryfikując wynik brute-force (wyliczając wszystkie przypadki, gdy to możliwe).' },
];

mkdirSync(join(OUT, 'tematy'), { recursive: true });

// Topics index
const topicCards = topics.map(t =>
  `<a href="/tematy/${t.slug}" class="year-card">
     <strong>${t.title}</strong>
     <div class="meta">${t.desc.substring(0, 100)}...</div>
   </a>`
).join('\n');

const topicsIndexHtml = layout(
  'Tematy maturalne z matematyki | Formulo',
  'Wszystkie tematy maturalne z matematyki: funkcje, trygonometria, ciągi, geometria, prawdopodobieństwo, pochodne, równania, kombinatoryka.',
  `${SITE}/tematy/`,
  `<h1>Tematy maturalne z matematyki</h1>
   <p style="margin-bottom:1.5rem;color:#555">Wybierz temat i rozwiązuj zadania krok po kroku z pomocą AI.</p>
   ${topicCards}`
);
writeFileSync(join(OUT, 'tematy', 'index.html'), topicsIndexHtml);
sitemapUrls.push(`${SITE}/tematy/`);

for (const t of topics) {
  const topicHtml = layout(
    `${t.title} | Zadania maturalne | Formulo`,
    t.desc,
    `${SITE}/tematy/${t.slug}`,
    `<div class="breadcrumb"><a href="/tematy/">Tematy</a> &rsaquo; ${t.title}</div>
     <h1>${t.title}</h1>
     <div class="task-card">
       <div class="task-content">${t.content}</div>
     </div>
     <h2>Przykładowe zadania</h2>
     <p style="color:#555;margin-bottom:1rem">Wklej dowolne zadanie z tego tematu do Formulo, a AI rozwiąże je krok po kroku z dokładnymi obliczeniami SymPy.</p>`
  );
  writeFileSync(join(OUT, 'tematy', `${t.slug}.html`), topicHtml);
  sitemapUrls.push(`${SITE}/tematy/${t.slug}`);
  console.log(`  topic: ${t.slug}`);
}

// 4. Generate sitemap.xml
sitemapUrls.unshift(SITE + '/');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(url => `  <url><loc>${url}</loc></url>`).join('\n')}
</urlset>`;

writeFileSync(join(__dirname, 'sitemap.xml'), sitemap);
console.log(`\nDone: ${sitemapUrls.length} URLs in sitemap.xml`);
