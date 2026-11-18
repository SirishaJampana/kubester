#!/usr/bin/env node
/*
 * Converts mdfiles/Kubernetes_Interview_Preparation_Guide.md into js/guide-data.js
 * (a plain <script> file so the site works from file:// with no server).
 *
 *   node tools/build-guide.js
 *
 * It also repairs artefacts from the PDF->markdown conversion (merged bullets, glued words)
 * and a few wrong cross-references, so the Handbook links point at the right topic.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'mdfiles', 'Kubernetes_Interview_Preparation_Guide.md');
const OUT = path.join(ROOT, 'js', 'guide-data.js');

let md = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

// --- 1. text repairs -------------------------------------------------------
// "load e Service discovery" -> bullet list item (the PDF bullet glyph became " e ")
md = md.replace(/ e (?=[A-Z][a-z])/g, '\n- ');

const glued = [
  ['TLStermination', 'TLS termination'], [' bya ', ' by a '], ['Whena PVCreferences', 'When a PVC references'],
  ['Stand ards', 'Standards'], ['Podis', 'Pod is'], ['needa ', 'need a '], ['Labelthe', 'Label the'],
  ['perzone', 'per zone'], ['Runtwo', 'Run two'], ['Runa ', 'Run a '], ['ata time', 'at a time'],
  ['fora ', 'for a '], ['calla ', 'call a '], ['deploymentin', 'deployment in'],
  ['WaitForFirstConsumeris', 'WaitForFirstConsumer is'], ['metricexposed', 'metric exposed'],
  ['anon-root', 'a non-root'], ['YAMLfrom', 'YAML from'], ['YAMLreadable', 'YAML readable'],
  ['10services', '10 services'], ['toa Service', 'to a Service'], ['PVCin', 'PVC in'], ['CNis', 'CNIs'],
  ['kube -bench', 'kube-bench'], ['force -delete', 'force-delete'], ['force -evicts', 'force-evicts'],
  ['force -drain', 'force-drain'], ["chown''d", "chown'd"], ['Scale -up', 'Scale-up'],
  ['kube - proxy', 'kube-proxy'], ['pod-name - c ', 'pod-name -c '], ['auth can -i', 'auth can-i'],
  ['--to revision=3', '--to-revision=3'], ['svc service - name', 'svc service-name'],
  ['validatingwebhookconfigu ration', 'validatingwebhookconfiguration'], ['ceil{currentReplicas', 'ceil(currentReplicas'],
  ['node -monitor-grace-period', 'node-monitor-grace-period'], ['REVISION _ NUMBER', 'REVISION_NUMBER'],
  ['-- keep-history', '--keep-history'], ['( -- image-gc-high-threshold', '(--image-gc-high-threshold'],
  ['- XX:Native MemoryTracking', '-XX:NativeMemoryTracking'], ["jq'.items", "jq '.items"], ["jq -r'.items", "jq -r '.items"],
  [' - o json', ' -o json'], ['Image PullBackOff', 'ImagePullBackOff'], ['MTLS via', 'mTLS via'],
  ['policies. \'', "policies.'"], ['namespace. \'', "namespace.'"], ['cluster.\'', "cluster.'"],
];
for (const [a, b] of glued) md = md.split(a).join(b);

// Wrong cross-references in the source (they point at unrelated questions).
const refFixes = [
  ['External Secrets Operator. See Q49 for details.', 'External Secrets Operator. See Q77 and Q52 for details.'],
  ['preventing Job completion. See Q68 for details.', 'preventing Job completion. See Q73 for details.'],
  ['Exit code 137 means OOM killed (see Q78)', 'Exit code 137 means OOM killed (see Q89)'],
  ['increase the limit. See Q78 for detailed OOM debugging.', 'increase the limit. See Q89 for detailed OOM debugging.'],
  ['that is stuck in Pending (see Q77)', 'that is stuck in Pending (see Q88)'],
  ['Check for the SIGTERM race condition (Q79)', 'Check for the SIGTERM race condition (Q90)'],
];
for (const [a, b] of refFixes) {
  if (!md.includes(a)) console.warn('[build-guide] cross-ref fix not applied (text changed?):', a.slice(0, 60));
  md = md.split(a).join(b);
}

// --- 2. split into questions -------------------------------------------------
const lines = md.split('\n');
const sections = [];
const questions = [];
let curSection = null;
let curQ = null;
let cheatStart = -1;

const sectionRe = /^## Section (\d) - (.+?) \(Q(\d+)-Q(\d+)\)\s*$/;
const qRe = /^### Q(\d+): (.+)$/;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const sm = line.match(sectionRe);
  if (sm) {
    curSection = { id: +sm[1], title: sm[2].trim(), from: +sm[3], to: +sm[4] };
    sections.push(curSection);
    curQ = null;
    continue;
  }
  if (/^## Interview Tips/.test(line)) { curQ = null; curSection = null; continue; }
  if (/^## Quick Reference Cheat Sheet/.test(line)) { cheatStart = i + 1; break; }
  const qm = line.match(qRe);
  if (qm && curSection) {
    curQ = { n: +qm[1], title: qm[2].trim(), section: curSection.id, body: [] };
    questions.push(curQ);
    continue;
  }
  if (curQ) curQ.body.push(line);
}

// interview tips block
const tipsMatch = md.match(/## Interview Tips - How to Use This Guide\n([\s\S]*?)\n## Quick Reference/);
const tips = tipsMatch ? tipsMatch[1].trim() : '';

// cheat sheet table
const cheat = [];
if (cheatStart > 0) {
  for (const l of lines.slice(cheatStart)) {
    const m = l.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!m || /^-+$/.test(m[1].replace(/\s/g, '')) || m[1] === 'Topic') continue;
    cheat.push({ topic: m[1], point: m[2] });
  }
}

function summarize(body) {
  // first real paragraph after "The Simple Answer" (or the first paragraph at all)
  const text = body.join('\n');
  const simple = text.split(/#### The Simple Answer\n/)[1] || text;
  const para = simple.split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#') && !s.startsWith('|'));
  if (!para) return 'Comparison table: ' + body.filter(l => /^\|/.test(l)).slice(0, 1).join('').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim() + ' (open the Handbook for the full table).';
  return para.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

const out = {
  title: 'Kubernetes Interview Preparation Guide',
  sections,
  questions: questions.map(q => ({
    n: q.n, title: q.title, section: q.section,
    summary: summarize(q.body),
    md: q.body.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  })),
  tips,
  cheat,
};

if (out.questions.length !== 110) {
  console.error(`[build-guide] expected 110 questions, found ${out.questions.length}`);
  process.exit(1);
}
out.questions.forEach((q, i) => {
  if (q.n !== i + 1) { console.error('[build-guide] question numbering gap at', q.n); process.exit(1); }
  if (!q.summary) { console.error('[build-guide] empty summary for Q' + q.n); process.exit(1); }
});

const banner = '/* AUTO-GENERATED by tools/build-guide.js from mdfiles/Kubernetes_Interview_Preparation_Guide.md — do not edit by hand. */\n';
fs.writeFileSync(OUT, banner + '(function (G) { (G.KS = G.KS || {}).GUIDE = ' + JSON.stringify(out) + '; })(typeof window !== "undefined" ? window : globalThis);\n');
console.log(`[build-guide] wrote ${path.relative(ROOT, OUT)}: ${out.questions.length} questions, ${sections.length} sections, ${cheat.length} cheat-sheet rows`);
