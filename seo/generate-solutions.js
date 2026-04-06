#!/usr/bin/env node

/**
 * SEO Solution Page Generator for formulo.pl
 *
 * Generates individual solution/detail pages for each task with:
 * - Full question text with KaTeX rendering
 * - Correct answer highlighted
 * - Multiple choice options (if applicable)
 * - Call-to-action button to solve in Formulo
 * - Links to other tasks from same year
 * - Breadcrumb navigation
 * - JSON-LD structured data
 *
 * Output: seo/pages/zadania/matura-[level]-[year]/rozwiazanie-[tasknum].html
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

function encodeForURL(text) {
  // Remove HTML tags and LaTeX delimiters, create a shorter preview
  return encodeURIComponent(text.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]+\$/g, '').substring(0, 150));
}

function slug(year, level) {
  return `matura-${level}-${year}`;
}

function layout(title, description, canonical, body, jsonLd = null) {
  let jsonLdScript = '';
  if (jsonLd) {
    jsonLdScript = `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>\n  `;
  }

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
    h3 { font-size: 1rem; margin: 1rem 0 0.5rem; color: #333; }
    .breadcrumb { font-size: 0.85rem; color: #666; margin-bottom: 1.5rem; }
    .breadcrumb a { color: #667eea; text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .task-card { background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .task-card h3 { font-size: 1rem; color: #667eea; margin-bottom: 0.75rem; }
    .task-content { font-size: 0.95rem; line-height: 1.8; }
    .task-question { font-size: 0.95rem; line-height: 1.8; margin-bottom: 1rem; }
    .task-options { margin-top: 1rem; padding: 1rem; background: #f5f7ff; border-radius: 6px; }
    .task-option { margin: 0.5rem 0; padding: 0.5rem 0; border-bottom: 1px solid rgba(102, 126, 234, 0.1); }
    .task-option:last-child { border-bottom: none; }
    .task-option.correct { background: #e8f5e9; padding: 0.75rem; border-radius: 4px; border-left: 3px solid #4caf50; margin-bottom: 0.5rem; font-weight: 500; }
    .task-answer { margin-top: 1rem; padding: 0.75rem 1rem; background: #c8e6c9; border-left: 3px solid #4caf50; border-radius: 4px; font-weight: 500; }
    .task-answer-label { font-size: 0.85rem; color: #2e7d32; text-transform: uppercase; letter-spacing: 0.5px; }
    .cta-button { display: inline-block; padding: 0.9rem 1.8rem; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 1rem; margin: 1.5rem 0; transition: opacity 0.2s; }
    .cta-button:hover { opacity: 0.9; }
    .nav-section { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #e0e0e0; }
    .nav-section h3 { color: #666; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 1rem; }
    .related-tasks { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; }
    .related-task-link { padding: 0.75rem; background: white; border-radius: 6px; border: 1px solid #e0e0e0; text-decoration: none; color: #667eea; font-size: 0.9rem; text-align: center; transition: all 0.2s; }
    .related-task-link:hover { border-color: #667eea; background: #f5f7ff; }
    .related-task-link.current { background: #667eea; color: white; font-weight: 600; cursor: default; }
    .navigation { margin-top: 2rem; display: flex; justify-content: space-between; gap: 1rem; }
    .nav-link { flex: 1; padding: 0.75rem; background: white; border-radius: 6px; border: 1px solid #e0e0e0; text-decoration: none; color: #667eea; text-align: center; font-size: 0.9rem; transition: all 0.2s; }
    .nav-link:hover { border-color: #667eea; background: #f5f7ff; }
    .nav-link.disabled { opacity: 0.3; cursor: default; }
    .nav-link.disabled:hover { border-color: #e0e0e0; background: white; }
    .year-card { display: block; background: white; border-radius: 12px; padding: 1.25rem 1.5rem; margin-bottom: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-decoration: none; color: #1a1a2e; transition: transform 0.15s; }
    .year-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
    .year-card .meta { font-size: 0.85rem; color: #888; margin-top: 0.25rem; }
    .cta { display: inline-block; margin-top: 2rem; padding: 0.85rem 2rem; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 1rem; }
    .cta:hover { opacity: 0.9; }
    .footer { text-align: center; padding: 2rem; color: #999; font-size: 0.8rem; margin-top: 2rem; }
    .footer a { color: #667eea; text-decoration: none; }
    .katex-display { margin: 1rem 0; overflow-x: auto; }
    @media (max-width: 600px) {
      .container { padding: 0 1rem; }
      h1 { font-size: 1.3rem; }
      .related-tasks { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
      .navigation { flex-direction: column; }
    }
  </style>
  ${jsonLdScript}</head>
<body>
  <div class="header">
    <a href="/">Formulo</a>
    <div class="subtitle">Darmowy asystent matematyczny AI po polsku</div>
  </div>
  <div class="container">
    ${body}
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

// ── Generate pages ────────────────────────────────────────────────────

const datasets = loadDatasets();
let totalPages = 0;

// Generate per-task solution pages
for (const ds of datasets) {
  const s = slug(ds.year, ds.level);
  const yearDir = join(OUT, 'zadania', s);
  mkdirSync(yearDir, { recursive: true });

  for (let i = 0; i < ds.tasks.length; i++) {
    const task = ds.tasks[i];
    const num = task.metadata?.task_number || (i + 1);
    const pts = task.metadata?.max_points || '';
    const levelLabel = ds.levelLabel;

    // Build title and description
    const taskTitle = `Matura ${levelLabel} ${ds.year} matematyka zadanie ${num} - rozwiązanie | Formulo`;
    const taskDesc = `Matura ${ds.level === 'rozszerzona' ? 'rozszerzona' : 'podstawowa'} ${ds.year}, zadanie ${num}${pts ? ` (${pts} pkt)` : ''}. Pełne rozwiązanie z odpowiedzią i wyjaśnieniami. Rozwiąż to zadanie krok po kroku z darmowym asystentem AI Formulo.`;

    // Build canonical URL
    const canonical = `${SITE}/zadania/${s}/rozwiazanie-${num}`;

    // Build JSON-LD structured data
    const questionPreview = task.question.replace(/\$\$[\s\S]*?\$\$/g, '[wzór]').replace(/\$[^$]+\$/g, '[wzór]').substring(0, 200);

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "EducationalResource",
      "name": `Zadanie ${num} - Matura ${levelLabel} ${ds.year} - Matematyka`,
      "description": taskDesc,
      "url": canonical,
      "educationalLevel": ds.level === 'rozszerzona' ? 'Extended' : 'Standard',
      "isPartOf": {
        "@type": "Course",
        "name": `Matura Matematyka ${levelLabel} ${ds.year}`,
        "url": `${SITE}/zadania/${s}/`
      }
    };

    // If task has answer, add to JSON-LD
    if (task.answer) {
      jsonLd.answer = {
        "@type": "Answer",
        "text": task.answer
      };
    }

    // Build options HTML
    let optionsHtml = '';
    if (task.options && typeof task.options === 'object') {
      const entries = Object.entries(task.options);
      if (entries.length > 0) {
        optionsHtml = '<h3>Opcje odpowiedzi</h3><div class="task-options">';
        entries.forEach(([key, val]) => {
          const isCorrect = task.answer && key.toUpperCase() === task.answer.toUpperCase();
          if (isCorrect) {
            optionsHtml += `<div class="task-option correct">
              <div class="task-answer-label">✓ Prawidłowa odpowiedź</div>
              <strong>${escapeHtml(key).toUpperCase()}.</strong> ${val}
            </div>`;
          } else {
            optionsHtml += `<div class="task-option">
              <strong>${escapeHtml(key).toUpperCase()}.</strong> ${val}
            </div>`;
          }
        });
        optionsHtml += '</div>';
      }
    }

    // Build answer display
    let answerHtml = '';
    if (task.answer) {
      if (task.options && typeof task.options === 'object' && Object.keys(task.options).length > 0) {
        // Already shown in options above for multiple choice
      } else {
        // For open-ended tasks
        answerHtml = `<div class="task-answer">
          <div class="task-answer-label">Odpowiedź</div>
          ${task.answer}
        </div>`;
      }
    }

    // Build related/previous/next navigation
    const prevNum = i > 0 ? (ds.tasks[i - 1].metadata?.task_number || i) : null;
    const nextNum = i < ds.tasks.length - 1 ? (ds.tasks[i + 1].metadata?.task_number || (i + 2)) : null;

    let navigationHtml = '<div class="navigation">';
    if (prevNum) {
      navigationHtml += `<a href="/zadania/${s}/rozwiazanie-${prevNum}" class="nav-link">← Zadanie ${prevNum}</a>`;
    } else {
      navigationHtml += `<div class="nav-link disabled"></div>`;
    }
    if (nextNum) {
      navigationHtml += `<a href="/zadania/${s}/rozwiazanie-${nextNum}" class="nav-link">Zadanie ${nextNum} →</a>`;
    } else {
      navigationHtml += `<div class="nav-link disabled"></div>`;
    }
    navigationHtml += '</div>';

    // Build related tasks from same year (show all tasks with current highlighted)
    const relatedTasksHtml = ds.tasks.map((t, idx) => {
      const tNum = t.metadata?.task_number || (idx + 1);
      const isCurrent = tNum === num;
      return `<a href="/zadania/${s}/rozwiazanie-${tNum}" class="related-task-link${isCurrent ? ' current' : ''}">Zadanie ${tNum}</a>`;
    }).join('');

    // Build main body
    const body = `
      <div class="breadcrumb">
        <a href="/">Formulo</a> &rsaquo;
        <a href="/zadania/">Zadania</a> &rsaquo;
        <a href="/zadania/${s}/">Matura ${levelLabel} ${ds.year}</a> &rsaquo;
        Zadanie ${num}
      </div>

      <h1>Matura ${levelLabel} ${ds.year} – Zadanie ${num}</h1>
      <p style="color: #666; margin-bottom: 1.5rem;">
        ${pts ? `<strong>Punkty: ${pts}</strong> &middot; ` : ''}
        <strong>Rozwiązanie</strong>
      </p>

      <div class="task-card">
        <h2>Treść zadania</h2>
        <div class="task-question">${task.question}</div>
      </div>

      ${optionsHtml}
      ${answerHtml}

      <a href="/?q=${encodeForURL(task.question)}" class="cta-button">→ Rozwiąż to zadanie w Formulo</a>

      <div class="nav-section">
        <h3>Inne zadania z tego roku</h3>
        <div class="related-tasks">
          ${relatedTasksHtml}
        </div>
      </div>

      <div class="nav-section">
        ${navigationHtml}
      </div>
    `;

    const taskHtml = layout(taskTitle, taskDesc, canonical, body, jsonLd);
    writeFileSync(join(yearDir, `rozwiazanie-${num}.html`), taskHtml);
    totalPages++;
  }

  console.log(`  ${s}: ${ds.tasks.length} solution pages`);
}

console.log(`\nDone: ${totalPages} solution pages generated in seo/pages/zadania/`);
