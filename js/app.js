/* Kubester — application shell: lessons, progress, views, editor, wiring. */
(function () {
  'use strict';
  const KS = window.KS;
  const U = KS.util;
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = s => KS.md.render(s);

  // ------------------------------------------------------------------ persistence (best effort)
  const store = {
    get(k, d) { try { const v = localStorage.getItem('kubester.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('kubester.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const progress = store.get('progress.v1', {}); // lessonId -> {steps:[...], quiz:{qi: chosen}, done:bool}
  const saveProgress = () => store.set('progress.v1', progress);

  // ------------------------------------------------------------------ ordered curriculum
  const LESSONS = KS.MODULES.flatMap(m => KS.LESSONS.filter(l => l.module === m.id));
  const SANDBOX = { id: 'sandbox', title: 'Sandbox (free play)', module: 'start', steps: [], quiz: [], minutes: 0, refs: [], intro: `A fresh cluster with no instructions — break things on purpose!

Ideas to try:
- \`kubectl create deployment web --image=nginx --replicas=3\` then \`kubectl delete pod <one>\`
- \`kubectl expose deployment web --port=80 --type=NodePort\` and \`curl 192.168.49.11:<nodePort>\`
- \`sim node down worker-1\` then \`sim fast-forward 6m\` — watch Pods move
- \`kubectl run bad --image=nginx:9.9\` — what does ImagePullBackOff look like?
- \`helm install demo kubester/webapp\`
- \`kubectl apply -f https://k8s.io/examples/pods/probe/exec-liveness.yaml\`

Files to play with live in \`~/manifests\` — try \`ls manifests\`.` };
  const lessonById = id => (id === 'sandbox' ? SANDBOX : LESSONS.find(l => l.id === id));
  const totalSteps = LESSONS.reduce((a, l) => a + l.steps.length, 0);
  const qToLessons = {};
  LESSONS.forEach(l => (l.refs || []).forEach(q => (qToLessons[q] = qToLessons[q] || []).push(l)));

  // ------------------------------------------------------------------ runtime state
  let cluster = null;
  let speed = 1;
  let current = null;            // current lesson object
  let doneSteps = new Set();
  let shell, term, viz, ctx;
  let lastEval = 0;

  function newCluster() {
    const c = new KS.Cluster({ seed: Math.floor(Math.random() * 1e9), startTime: Date.now() });
    c.on('narrate', narrate);
    return c;
  }

  // ------------------------------------------------------------------ narrator
  const narrEl = $('#narrator');
  function narrate(n) {
    const empty = narrEl.querySelector('.narr-empty');
    if (empty) empty.remove();
    const d = document.createElement('div');
    d.className = 'narr ' + (n.level || 'info');
    const t = new Date(n.at);
    d.innerHTML = `<span class="t">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span><span>${esc(n.icon)} ${esc(n.text)}</span>`;
    narrEl.appendChild(d);
    while (narrEl.childNodes.length > 60) narrEl.removeChild(narrEl.firstChild);
    narrEl.scrollTop = narrEl.scrollHeight;
  }
  function clearNarrator(msg) { narrEl.innerHTML = `<div class="narr-empty">${esc(msg || 'The narrator explains what the cluster does after each command.')}</div>`; }

  // ------------------------------------------------------------------ toasts & confetti
  function toast(text, kind) {
    const d = document.createElement('div');
    d.className = 'toast ' + (kind || '');
    d.textContent = text;
    $('#toasts').appendChild(d);
    setTimeout(() => { d.style.transition = 'opacity .4s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 450); }, 2600);
  }
  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cv = $('#confetti');
    const cx = cv.getContext('2d');
    cv.width = innerWidth; cv.height = innerHeight;
    const colors = ['#326ce5', '#2bd576', '#f7b23b', '#8b6cff', '#3fc5f0', '#ff5d5d'];
    const parts = Array.from({ length: 140 }, () => ({ x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4, r: Math.random() * 6 + 3, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * 6 }));
    const t0 = performance.now();
    const step = t => {
      const dt = (t - t0) / 1000;
      cx.clearRect(0, 0, cv.width, cv.height);
      parts.forEach(p => { p.vy += 0.38; p.x += p.vx; p.y += p.vy; p.a += 0.15; cx.save(); cx.translate(p.x, p.y); cx.rotate(p.a); cx.fillStyle = p.c; cx.globalAlpha = Math.max(0, 1 - dt / 2.4); cx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); cx.restore(); });
      if (dt < 2.5) requestAnimationFrame(step); else cx.clearRect(0, 0, cv.width, cv.height);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ editor modal
  function openEditor(editor) {
    return new Promise(resolve => {
      const modal = $('#editor-modal'), ta = $('#editor-text'), gut = $('#editor-gutter'), err = $('#editor-error');
      $('#editor-title').textContent = `${editor.filename}${editor.isNew ? '  (new file)' : ''}`;
      ta.value = editor.content;
      err.hidden = true;
      const lines = () => { const n = ta.value.split('\n').length; gut.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); gut.scrollTop = ta.scrollTop; };
      lines();
      modal.hidden = false;
      setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 30);
      const close = (code, msg) => {
        modal.hidden = true;
        ta.oninput = ta.onscroll = ta.onkeydown = null;
        $('#editor-save').onclick = $('#editor-cancel').onclick = null;
        if (msg) term.write(msg + '\n', 'out');
        resolve({ code });
        setTimeout(() => term.focus(), 30);
      };
      const save = () => {
        let r;
        try { r = editor.save(ta.value); } catch (e) { r = { error: 'error: ' + e.message }; }
        if (r && r.error) { err.textContent = r.error; err.hidden = false; return; }
        close(0, r && r.message);
      };
      ta.oninput = lines;
      ta.onscroll = () => (gut.scrollTop = ta.scrollTop);
      ta.onkeydown = e => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.key === 'o' || e.key === 'O')) { e.preventDefault(); save(); }
        else if (e.key === 'Escape' || ((e.ctrlKey) && (e.key === 'x' || e.key === 'X'))) { e.preventDefault(); close(0, /^\/tmp\/kubectl-edit/.test(editor.filename) ? 'Edit cancelled, no changes made.' : ''); }
        else if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); lines(); }
      };
      $('#editor-save').onclick = save;
      $('#editor-cancel').onclick = () => close(0, /^\/tmp\/kubectl-edit/.test(editor.filename) ? 'Edit cancelled, no changes made.' : '');
    });
  }

  // ------------------------------------------------------------------ fast forward with a "time warp" effect
  async function fastForward(ms) {
    const wrap = $('#canvas-wrap');
    wrap.style.transition = 'filter .2s';
    wrap.style.filter = 'hue-rotate(25deg) saturate(1.4)';
    let left = ms;
    while (left > 0) {
      const chunk = Math.min(left, 20000);
      cluster.fastForward(chunk);
      left -= chunk;
      updateClock();
      await new Promise(r => setTimeout(r, 16));
    }
    wrap.style.filter = '';
  }

  // ------------------------------------------------------------------ cluster loop
  let lastTick = performance.now();
  function loop() {
    const now = performance.now();
    const real = Math.min(500, now - lastTick);
    lastTick = now;
    let sim = real * speed;
    try {
      while (sim > 0) { const d = Math.min(sim, 250); cluster.tick(d); sim -= d; }
    } catch (e) { console.error(e); }
    if (now - lastEval > 450) { lastEval = now; evaluateSteps(); updateClock(); refreshNsFilter(); }
  }
  function updateClock() {
    const d = new Date(cluster.now);
    $('#cluster-clock').textContent = `· ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}${speed !== 1 ? ` · ${speed}×` : ''}`;
    $('#term-context').textContent = `learner@laptop · context kubernetes-admin@kubester · ns ${cluster.context.namespace}`;
  }
  let nsSig = '';
  function refreshNsFilter() {
    const sel = $('#ns-filter');
    const names = cluster.list('Namespace').map(n => n.metadata.name).filter(n => !['kube-system', 'kube-public', 'kube-node-lease'].includes(n));
    const sig = names.join(',');
    if (sig === nsSig) return;
    nsSig = sig;
    const cur = sel.value || '*';
    sel.innerHTML = `<option value="*">All namespaces</option>` + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = names.includes(cur) || cur === '*' ? cur : '*';
  }

  // ------------------------------------------------------------------ lessons
  function startLesson(id, opts) {
    opts = opts || {};
    const lesson = lessonById(id) || LESSONS[0];
    current = lesson;
    store.set('lesson', lesson.id);
    location.hash = '#lesson/' + lesson.id;
    // fresh cluster for every lesson (the very first one reuses the cluster created at boot)
    if (!opts.reuse) cluster = newCluster();
    shell.attach(cluster);
    viz.attach(cluster);
    ctx.reset();
    nsSig = '';
    clearNarrator(lesson.incident ? '🚨 Incident in progress — investigate with get / describe / logs.' : null);
    if (lesson.setup) {
      const prevQuiet = cluster.quiet;
      cluster.quiet = true;
      try { lesson.setup(cluster, shell); } catch (e) { console.error(e); }
      cluster.quiet = prevQuiet;
    }
    const p = progress[lesson.id] || {};
    doneSteps = new Set(opts.restart ? [] : p.steps || []);
    if (opts.restart) { progress[lesson.id] = { steps: [], quiz: {} }; saveProgress(); }
    term.clear();
    term.banner();
    if (lesson.id !== 'sandbox') term.html(`<span class="t-good">── ${esc(lesson.title)} ──</span> <span class="t-dim">a fresh cluster is ready${lesson.incident ? ' (with a problem to fix)' : ''}</span>`);
    renderCurriculum();
    renderLesson();
    closeMenu();
    if (window.innerWidth <= 1080) setPane('lesson');
    updateClock();
  }
  function evaluateSteps() {
    if (!current || !current.steps.length) return;
    let changed = false;
    for (const s of current.steps) {
      if (doneSteps.has(s.index)) continue;
      let ok = false;
      try { ok = !!s.check(ctx); } catch (e) { ok = false; }
      if (ok) { doneSteps.add(s.index); changed = true; markStepDone(s); }
    }
    if (changed) {
      const p = (progress[current.id] = progress[current.id] || { steps: [], quiz: {} });
      p.steps = [...doneSteps];
      const all = doneSteps.size === current.steps.length;
      if (all && !p.done) { p.done = true; saveProgress(); celebrate(); }
      saveProgress();
      updateProgressRing();
      renderCurriculum();
    }
  }
  function markStepDone(s) {
    const el = document.querySelector(`.step[data-i="${s.index}"]`);
    if (el) {
      el.classList.add('done', 'just-done');
      el.querySelector('.num').textContent = '✓';
    }
    toast(`✓ Step ${s.index + 1} done`);
    updateCurrentStep();
  }
  function updateCurrentStep() {
    document.querySelectorAll('.step').forEach(e => e.classList.remove('current'));
    const next = current.steps.find(s => !doneSteps.has(s.index));
    if (next) {
      const el = document.querySelector(`.step[data-i="${next.index}"]`);
      if (el) { el.classList.add('current'); if (document.activeElement && document.activeElement.closest('.terminal')) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
    const head = $('#steps-count');
    if (head) head.textContent = `${doneSteps.size}/${current.steps.length} done`;
    if (doneSteps.size === current.steps.length) renderDoneBanner();
  }
  function celebrate() {
    confetti();
    toast(`🎉 Lesson complete: ${current.title}`, 'info');
    renderDoneBanner();
  }
  function renderDoneBanner() {
    const box = $('#done-banner');
    if (!box || box.dataset.shown) return;
    box.dataset.shown = '1';
    const idx = LESSONS.indexOf(current);
    const next = LESSONS[idx + 1];
    box.innerHTML = `<div class="lesson-done"><h3>🎉 All steps done!</h3><div class="md">${md(current.incident ? 'Incident resolved. Write the post-mortem in your head: *what was the symptom, which command revealed the cause, and how would you prevent it?*' : 'Nice work. Check your understanding with the quiz below, or move on.')}</div>${next ? `<div class="lesson-nav"><button class="btn primary" data-go="${next.id}">Next: ${esc(next.title)} →</button></div>` : ''}</div>`;
  }
  function stepCmdHtml(s, reveal) {
    if (!s.cmd) return '';
    const filled = KS.lessonFill(s.cmd, cluster, cluster.context.namespace);
    if (current.incident && s.hint && !reveal) return `<button class="hint-btn" data-reveal="${s.index}">💡 Stuck? Show the solution</button>`;
    return `<div class="cmd" data-i="${s.index}"><code title="Click to paste into the terminal">${esc(filled)}</code><button class="copy" title="Copy">⧉</button><button class="run" title="Type and run it in the terminal">▶ Run</button></div>`;
  }
  function renderLesson() {
    const l = current;
    const el = $('#lesson');
    const mod = KS.MODULES.find(m => m.id === l.module) || { title: '', icon: '' };
    const idx = LESSONS.indexOf(l);
    let h = '';
    if (l.id === 'welcome') {
      h += `<div class="hero"><h2>Learn Kubernetes by doing.</h2><p>A live, animated cluster and a real-feeling terminal — no install. Every command you type changes the map on the right.</p><div class="hero-stats"><div><b>${LESSONS.length}</b>lessons</div><div><b>${totalSteps}</b>hands-on steps</div><div><b>10</b>incident labs</div><div><b>110</b>handbook topics</div></div></div>`;
    }
    h += `<div class="lesson-kicker">${esc(mod.icon)} ${esc(mod.title)}${l.minutes ? ` <span class="muted">· ~${l.minutes} min</span>` : ''}${idx >= 0 ? ` <span class="muted">· ${idx + 1}/${LESSONS.length}</span>` : ''}</div>`;
    h += `<h1 class="lesson-title">${esc(l.title)}</h1>`;
    if ((l.refs || []).length) h += `<div class="chips">${l.refs.map(q => `<button class="chip" data-q="${q}" title="${esc((KS.GUIDE.questions[q - 1] || {}).title || '')}">📖 Q${q} ${esc(((KS.GUIDE.questions[q - 1] || {}).title || '').split(/[-–(]/)[0].trim().slice(0, 34))}</button>`).join('')}</div>`;
    if (l.ticket) h += `<div class="ticket"><b>🚨 Incident ticket</b>${esc(l.ticket)}</div>`;
    h += `<details class="concept" ${doneSteps.size && l.steps.length ? '' : 'open'}><summary>${l.incident ? '🧭 Playbook' : '💡 Concept'}</summary><div class="md">${md(l.intro)}</div></details>`;
    if (l.steps.length) {
      h += `<div class="steps-head"><h3>${l.incident ? 'Investigate & fix' : 'Hands-on'}</h3><span class="muted" id="steps-count">${doneSteps.size}/${l.steps.length} done</span></div>`;
      for (const s of l.steps) {
        const done = doneSteps.has(s.index);
        h += `<div class="step ${done ? 'done' : ''}" data-i="${s.index}"><span class="num">${done ? '✓' : s.index + 1}</span><div class="md">${md(s.text)}</div>${stepCmdHtml(s, done)}${s.hint && !l.incident ? `<button class="hint-btn" data-hint="${s.index}">Hint</button><div class="hint-text" hidden>${esc(s.hint)}</div>` : ''}</div>`;
      }
      h += '<div id="done-banner"></div>';
    }
    if ((l.quiz || []).length) {
      const p = progress[l.id] || {};
      h += `<div class="quiz"><h3>🧠 Quick check</h3>`;
      l.quiz.forEach((q, qi) => {
        const chosen = p.quiz && p.quiz[qi];
        h += `<div class="q" data-qi="${qi}"><div class="q-text">${KS.md.inline(q.q)}</div>`;
        q.options.forEach((o, oi) => {
          const cls = chosen != null ? (oi === q.answer ? 'right' : oi === chosen ? 'wrong' : '') : '';
          h += `<button class="q-opt ${cls}" data-oi="${oi}" ${chosen != null ? 'disabled' : ''}>${KS.md.inline(o)}</button>`;
        });
        h += `<div class="q-why" ${chosen != null ? '' : 'hidden'}>${chosen === q.answer ? '✅ Correct. ' : chosen != null ? '❌ Not quite. ' : ''}${KS.md.inline(q.why || '')}</div></div>`;
      });
      h += '</div>';
    }
    const next = LESSONS[idx + 1], prev = LESSONS[idx - 1];
    h += `<div class="lesson-nav">${prev ? `<button class="btn ghost" data-go="${prev.id}">← ${esc(prev.title)}</button>` : ''}${next ? `<button class="btn" data-go="${next.id}">${esc(next.title)} →</button>` : ''}<button class="btn ghost danger" data-restart="1" title="Fresh cluster and clear this lesson's progress">↺ Restart lesson</button></div>`;
    el.innerHTML = h;
    el.parentElement.scrollTop = 0;
    updateCurrentStep();
    if (doneSteps.size === l.steps.length && l.steps.length) renderDoneBanner();
  }
  function onLessonClick(e) {
    const t = e.target;
    const q = t.closest('[data-q]');
    if (q && !t.closest('.inspector')) { openHandbook(+q.dataset.q); return; }
    const go = t.closest('[data-go]');
    if (go) { startLesson(go.dataset.go); return; }
    if (t.closest('[data-restart]')) { startLesson(current.id, { restart: true }); toast('Lesson restarted with a fresh cluster', 'info'); return; }
    const reveal = t.closest('[data-reveal]');
    if (reveal) { const s = current.steps[+reveal.dataset.reveal]; reveal.outerHTML = stepCmdHtml(s, true) + `<div class="hint-text">${esc(s.hint || '')}</div>`; return; }
    const hint = t.closest('[data-hint]');
    if (hint) { const ht = hint.nextElementSibling; ht.hidden = !ht.hidden; return; }
    const cmd = t.closest('.cmd');
    if (cmd) {
      const s = current.steps[+cmd.dataset.i];
      const filled = KS.lessonFill(s.cmd, cluster, cluster.context.namespace);
      cmd.querySelector('code').textContent = filled;
      if (t.closest('.run')) { if (window.innerWidth <= 1080) setPane('terminal'); term.typeAndRun(filled).then(okRun => { if (!okRun) toast('The terminal is busy — press Ctrl+C to stop the running command first', 'warn'); }); }
      else if (t.closest('.copy')) { navigator.clipboard && navigator.clipboard.writeText(filled).then(() => toast('Copied', 'info'), () => {}); }
      else { term.paste(filled); if (window.innerWidth <= 1080) setPane('terminal'); }
      return;
    }
    const opt = t.closest('.q-opt');
    if (opt && !opt.disabled) {
      const qEl = opt.closest('.q');
      const qi = +qEl.dataset.qi, oi = +opt.dataset.oi;
      const qq = current.quiz[qi];
      const p = (progress[current.id] = progress[current.id] || { steps: [...doneSteps], quiz: {} });
      p.quiz = p.quiz || {};
      p.quiz[qi] = oi;
      saveProgress();
      qEl.querySelectorAll('.q-opt').forEach((b, i) => { b.disabled = true; if (i === qq.answer) b.classList.add('right'); else if (i === oi) b.classList.add('wrong'); });
      const why = qEl.querySelector('.q-why');
      why.hidden = false;
      why.innerHTML = (oi === qq.answer ? '✅ Correct. ' : '❌ Not quite. ') + KS.md.inline(qq.why || '');
    }
  }

  // ------------------------------------------------------------------ curriculum sidebar & progress
  function renderCurriculum() {
    let h = `<button class="lesson-link sandbox-link ${current && current.id === 'sandbox' ? 'active' : ''}" data-lesson="sandbox"><span class="dot">🧪</span>Sandbox (free play)</button>`;
    for (const m of KS.MODULES) {
      const ls = LESSONS.filter(l => l.module === m.id);
      const done = ls.filter(l => (progress[l.id] || {}).done).length;
      h += `<div class="mod"><div class="mod-title">${m.icon} ${esc(m.title)}<span class="count">${done}/${ls.length}</span></div>`;
      for (const l of ls) {
        const p = progress[l.id] || {};
        const n = (p.steps || []).length;
        const cls = p.done ? 'done' : n ? 'partial' : '';
        h += `<button class="lesson-link ${cls} ${current && current.id === l.id ? 'active' : ''}" data-lesson="${l.id}" style="--p:${Math.round(100 * n / Math.max(1, l.steps.length))}%"><span class="dot">${p.done ? '✓' : ''}</span>${esc(l.title)}<span class="mins">${l.minutes}m</span></button>`;
      }
      h += '</div>';
    }
    $('#curriculum').innerHTML = h;
  }
  function updateProgressRing() {
    const done = LESSONS.reduce((a, l) => a + Math.min(l.steps.length, ((progress[l.id] || {}).steps || []).length), 0);
    const pct = Math.round((100 * done) / totalSteps);
    $('#progress-text').textContent = pct + '%';
    $('#ring-fg').style.strokeDashoffset = String(94.25 * (1 - pct / 100));
    $('#progress-pill').title = `${done} of ${totalSteps} steps · ${LESSONS.filter(l => (progress[l.id] || {}).done).length}/${LESSONS.length} lessons complete`;
  }

  // ------------------------------------------------------------------ views
  function showView(v) {
    document.querySelectorAll('.view').forEach(e => e.classList.toggle('active', e.id === 'view-' + v));
    document.querySelectorAll('.tab').forEach(e => e.classList.toggle('active', e.dataset.view === v));
    if (v === 'handbook' && !$('#hb-article').innerHTML) openHandbook(1, true);
    if (v === 'flashcards') renderFlashcards();
    if (v === 'cheatsheet') renderCheatsheet();
    if (v === 'learn') setTimeout(() => { viz.resize(); term.focus(); }, 30);
  }

  // ------------------------------------------------------------------ handbook
  const G = KS.GUIDE;
  function renderHbList(filter) {
    const f = (filter || '').toLowerCase();
    let h = '';
    for (const sec of G.sections) {
      const qs = G.questions.filter(q => q.section === sec.id && (!f || q.title.toLowerCase().includes(f) || q.md.toLowerCase().includes(f)));
      if (!qs.length) continue;
      h += `<div class="hb-sec">${esc(sec.title)}</div>`;
      h += qs.map(q => `<button class="hb-item" data-hq="${q.n}"><b>Q${q.n}</b><span>${esc(q.title)}</span></button>`).join('');
    }
    $('#hb-items').innerHTML = h || '<p class="muted" style="padding:10px">No matches.</p>';
    markHbActive();
  }
  let hbCurrent = 1;
  function markHbActive() { document.querySelectorAll('.hb-item').forEach(b => b.classList.toggle('active', +b.dataset.hq === hbCurrent)); }
  function openHandbook(n, silent) {
    const q = G.questions[n - 1];
    if (!q) return;
    hbCurrent = n;
    if (!silent) { showView('handbook'); location.hash = '#handbook/Q' + n; }
    const sec = G.sections.find(s => s.id === q.section);
    const practice = qToLessons[n] || [];
    let h = `<div class="hb-meta"><span class="badge info">Q${n}</span><span>${esc(sec.title)}</span></div><h1>${esc(q.title)}</h1>`;
    if (practice.length) h += `<div class="practice">🧪 <b>Practice this hands-on:</b> ${practice.map(l => `<a href="#lesson/${l.id}" data-golesson="${l.id}">${esc(l.title)}</a>`).join(' · ')}</div>`;
    h += `<div class="md">${md(q.md)}</div>`;
    h += `<div class="hb-pager">${n > 1 ? `<button class="btn" data-hq="${n - 1}">← Q${n - 1}</button>` : '<span></span>'}${n < 110 ? `<button class="btn" data-hq="${n + 1}">Q${n + 1} →</button>` : ''}</div>`;
    const art = $('#hb-article');
    art.innerHTML = h;
    art.scrollTop = 0;
    markHbActive();
    const item = document.querySelector(`.hb-item[data-hq="${n}"]`);
    if (item) item.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ flashcards
  const fcState = store.get('fc.v1', { known: {}, sec: 0 });
  let fcDeck = [], fcIdx = 0, fcFlipped = false;
  function buildDeck() {
    fcDeck = G.questions.filter(q => (!fcState.sec || q.section === fcState.sec) && !fcState.known[q.n]);
    for (let i = fcDeck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fcDeck[i], fcDeck[j]] = [fcDeck[j], fcDeck[i]]; }
    fcIdx = 0;
  }
  function renderFlashcards() {
    if (!fcDeck.length || fcIdx >= fcDeck.length) buildDeck();
    const knownCount = Object.keys(fcState.known).length;
    const q = fcDeck[fcIdx];
    let h = `<div class="fc-top"><select id="fc-sec" aria-label="Section"><option value="0">All levels</option>${G.sections.map(s => `<option value="${s.id}" ${fcState.sec === s.id ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select><button class="btn ghost" id="fc-reset">Reset progress</button><span class="fc-stats">✅ ${knownCount}/110 mastered · ${fcDeck.length - fcIdx} left in this round</span></div>`;
    if (!q) h += `<div class="fc-face" style="position:relative"><h2>🎉 You've mastered every card in this set!</h2><p class="muted">Reset progress or choose another level.</p></div>`;
    else {
      h += `<div class="card3d"><div class="fc-card ${fcFlipped ? 'flipped' : ''}" id="fc-card" tabindex="0" role="button" aria-label="Flip card">
        <div class="fc-face"><span class="q-num">Q${q.n} · ${esc(G.sections[q.section - 1].title)}</span><h2>${esc(q.title)}</h2><p class="muted">Answer out loud first — like in an interview. Then flip.</p><span class="tap">Click or press Space to flip</span></div>
        <div class="fc-face fc-back"><span class="q-num">Q${q.n}</span><div class="md" style="margin-top:8px">${md(q.summary)}</div><span class="tap"><a href="#handbook/Q${q.n}" data-hbq="${q.n}">Read the full answer in the Handbook →</a></span></div>
      </div></div>
      <div class="fc-actions"><button class="btn" id="fc-again">🔁 Review again</button><button class="btn primary" id="fc-know">✅ I knew it</button></div>`;
    }
    $('#fc-wrap').innerHTML = h;
  }
  function fcNext(known) {
    const q = fcDeck[fcIdx];
    if (q && known) { fcState.known[q.n] = 1; store.set('fc.v1', fcState); }
    if (q && !known) fcDeck.push(q);
    fcIdx++;
    fcFlipped = false;
    renderFlashcards();
  }

  // ------------------------------------------------------------------ cheat sheet
  const CHEATS = [
    ['Look around', [['kubectl get nodes -o wide', 'nodes, IPs, versions'], ['kubectl get pods -A', 'every Pod in every namespace'], ['kubectl get all', 'common objects in this namespace'], ['kubectl get pods -o wide --show-labels', 'IPs, nodes and labels'], ['kubectl get events --sort-by=.lastTimestamp', 'what just happened'], ['kubectl api-resources', 'every resource type + short names']]],
    ['Debug a Pod', [['kubectl describe pod <pod>', 'state, conditions & Events'], ['kubectl logs <pod> --previous', 'logs of the crashed instance'], ['kubectl logs -f deploy/<name>', 'follow a deployment\'s logs'], ['kubectl exec -it <pod> -- sh', 'shell inside the container'], ['kubectl debug -it <pod> --image=busybox --target=<c>', 'toolbox for distroless images'], ['kubectl top pods', 'live CPU / memory']]],
    ['Create & change', [['kubectl create deployment web --image=nginx --replicas=3', 'a Deployment'], ['kubectl expose deployment web --port=80 --target-port=8080', 'a Service'], ['kubectl run tmp --rm -it --image=busybox -- sh', 'throw-away shell Pod'], ['kubectl apply -f file.yaml', 'declarative create/update'], ['kubectl edit deployment web', 'edit live object'], ['kubectl delete -f file.yaml', 'delete what a file created']]],
    ['YAML fast', [['kubectl run p --image=nginx --dry-run=client -o yaml > p.yaml', 'generate a Pod skeleton'], ['kubectl create deploy d --image=nginx --dry-run=client -o yaml > d.yaml', 'generate a Deployment'], ['kubectl explain pod.spec.containers', 'field documentation'], ['kubectl diff -f file.yaml', 'preview changes'], ['kubectl get deploy web -o yaml', 'see the full live object']]],
    ['Rollouts & scaling', [['kubectl set image deploy/web nginx=nginx:1.27', 'new version'], ['kubectl rollout status deploy/web', 'watch progress'], ['kubectl rollout history deploy/web', 'revisions'], ['kubectl rollout undo deploy/web', 'roll back'], ['kubectl scale deploy web --replicas=5', 'scale'], ['kubectl autoscale deploy web --cpu-percent=50 --min=1 --max=5', 'HPA']]],
    ['Config & security', [['kubectl create configmap cfg --from-literal=KEY=value', 'ConfigMap'], ['kubectl create secret generic s --from-literal=pw=x', 'Secret (base64!)'], ["kubectl get secret s -o jsonpath='{.data.pw}' | base64 -d", 'decode a Secret'], ['kubectl auth can-i list pods --as=system:serviceaccount:ns:sa', 'test RBAC'], ['kubectl create role r --verb=get,list --resource=pods', 'a Role'], ['kubectl label ns prod pod-security.kubernetes.io/enforce=restricted', 'Pod Security']]],
    ['Nodes & scheduling', [['kubectl cordon <node>', 'stop new Pods'], ['kubectl drain <node> --ignore-daemonsets', 'evict Pods'], ['kubectl uncordon <node>', 'allow scheduling again'], ['kubectl taint nodes <node> key=val:NoSchedule', 'repel Pods'], ['kubectl label node <node> disktype=ssd', 'label for nodeSelector'], ['kubectl describe node <node>', 'capacity, allocated, conditions']]],
    ['Output tricks', [['kubectl get pods -o name', 'just names'], ["kubectl get pods -o jsonpath='{.items[*].metadata.name}'", 'jsonpath'], ['kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName', 'custom columns'], ['kubectl get pods -w', 'watch changes (Ctrl+C)'], ['kubectl get pods -l app=web', 'filter by label'], ['kubectl config set-context --current --namespace=dev', 'switch namespace']]],
  ];
  function renderCheatsheet() {
    let h = `<h1>Cheat sheet</h1><p class="muted">Click any command to paste it into the terminal.</p><div class="cs-grid">`;
    for (const [title, rows] of CHEATS) h += `<div class="cs-card"><h3>${esc(title)}</h3>${rows.map(([c, d]) => `<div class="cs-row"><code data-paste="${esc(c)}">${esc(c)}</code><span>${esc(d)}</span></div>`).join('')}</div>`;
    h += `</div><h2 style="margin-top:34px">Interview quick reference</h2><p class="muted">From the guide's cheat sheet.</p><table class="cs-table">${G.cheat.map(r => `<tr><td>${esc(r.topic)}</td><td class="md">${KS.md.inline(r.point)}</td></tr>`).join('')}</table>`;
    h += `<h2 style="margin-top:34px">How to use this guide in interviews</h2><div class="md">${md(G.tips)}</div>`;
    $('#cs-wrap').innerHTML = h;
  }

  // ------------------------------------------------------------------ layout helpers
  function setPane(p) {
    $('#view-learn').dataset.pane = p;
    document.querySelectorAll('.mobile-switch button').forEach(b => b.classList.toggle('active', b.dataset.pane === p));
    if (p !== 'lesson') setTimeout(() => { viz.resize(); if (p === 'terminal') term.focus(); }, 30);
  }
  function setMenu(open) {
    $('#sidebar').classList.toggle('open', open);
    $('#sidebar-backdrop').classList.toggle('show', open);
    $('#btn-menu').setAttribute('aria-expanded', String(open));
    if (open) { const a = $('#curriculum .active, #curriculum [aria-current]'); if (a) a.scrollIntoView({ block: 'nearest' }); }
  }
  function closeMenu() { setMenu(false); }
  const MAX_ICON = { expand: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>', collapse: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"/></svg>' };
  function setMax(which) {
    const view = $('#view-learn');
    if (which) view.dataset.max = which; else delete view.dataset.max;
    document.querySelectorAll('.max-btn').forEach(b => {
      const on = b.dataset.max === which;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('on', on);
      b.innerHTML = on ? MAX_ICON.collapse : MAX_ICON.expand;
      b.title = on ? 'Exit full screen (Esc)' : (b.dataset.max === 'lesson' ? 'Full screen lesson (Esc to exit)' : 'Full screen cluster & terminal (Esc to exit)');
    });
    setTimeout(() => { viz.resize(); if (which === 'workspace') term.focus(); }, 30);
  }
  function initVSplitter() {
    const sp = $('#vsplitter'), view = $('#view-learn');
    const apply = px => {
      if (px == null) view.style.removeProperty('--lesson-w');
      else view.style.setProperty('--lesson-w', px + 'px');
      viz.resize();
    };
    const clamp = px => Math.round(Math.max(280, Math.min(window.innerWidth - 420, px)));
    const saved = store.get('lessonW', null);
    if (saved) apply(clamp(saved));
    let drag = false;
    sp.addEventListener('pointerdown', e => { drag = true; sp.setPointerCapture(e.pointerId); sp.classList.add('drag'); document.body.classList.add('col-resizing'); e.preventDefault(); });
    sp.addEventListener('pointermove', e => {
      if (!drag) return;
      const px = clamp(e.clientX - view.getBoundingClientRect().left);
      apply(px); store.set('lessonW', px);
    });
    const end = () => { drag = false; sp.classList.remove('drag'); document.body.classList.remove('col-resizing'); };
    sp.addEventListener('pointerup', end); sp.addEventListener('pointercancel', end);
    sp.addEventListener('dblclick', () => { apply(null); store.set('lessonW', null); });
    sp.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const cur = $('#lesson-pane').getBoundingClientRect().width;
      const px = clamp(cur + (e.key === 'ArrowRight' ? 30 : -30));
      apply(px); store.set('lessonW', px);
    });
    window.addEventListener('resize', () => { const v = store.get('lessonW', null); if (v) apply(clamp(v)); });
  }
  function initSplitter() {
    const sp = $('#splitter'), cl = $('#cluster-panel'), tp = $('#terminal-panel'), ws = $('#workspace');
    const saved = store.get('split', null);
    if (saved) { cl.style.flex = `0 0 ${saved}%`; tp.style.flex = '1 1 auto'; }
    let drag = false;
    sp.addEventListener('pointerdown', e => { drag = true; sp.setPointerCapture(e.pointerId); });
    sp.addEventListener('pointermove', e => {
      if (!drag) return;
      const r = ws.getBoundingClientRect();
      const pct = Math.max(22, Math.min(80, ((e.clientY - r.top) / r.height) * 100));
      cl.style.flex = `0 0 ${pct}%`; tp.style.flex = '1 1 auto';
      viz.resize();
      store.set('split', pct);
    });
    sp.addEventListener('pointerup', () => (drag = false));
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    const theme = store.get('theme', window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
    cluster = newCluster();
    shell = new KS.HostShell(cluster, {});
    ctx = new KS.LessonCtx(() => cluster, shell);
    shell.hooks = {
      afterCommand: (line, code) => { ctx.record('line', line, code); },
      onKubectl: (args, code) => ctx.record('kubectl', (args[0] === 'helm' || args[0] === 'sim' ? '' : 'kubectl ') + args.join(' '), code),
      hint: () => { const s = current && current.steps.find(x => !doneSteps.has(x.index)); return s ? `Step ${s.index + 1}: ${s.hint || 'try: ' + KS.lessonFill(s.cmd, cluster, cluster.context.namespace)}` : null; },
      setSpeed: x => setSpeed(x),
      resetCluster: () => setTimeout(() => startLesson(current ? current.id : 'sandbox'), 10),
    };
    term = new KS.Terminal($('#terminal'), {
      shell,
      getSpeed: () => speed,
      fastForward,
      openEditor,
      onBusy: b => { $('#running-pill').hidden = !b; },
      onCommandDone: () => { setTimeout(evaluateSteps, 60); lastEval = performance.now(); },
    });
    viz = new KS.ClusterViz($('#cluster-canvas'), $('#canvas-wrap'), {
      tooltip: $('#tooltip'), inspector: $('#inspector'),
      getFilter: () => ({ ns: $('#ns-filter').value || '*', showSystem: $('#toggle-system').checked }),
      onCommand: cmd => { term.paste(cmd); if (window.innerWidth <= 1080) setPane('terminal'); },
      onHandbook: q => openHandbook(q),
    });
    viz.attach(cluster);
    // events
    $('#lesson').addEventListener('click', onLessonClick);
    $('#curriculum').addEventListener('click', e => { const b = e.target.closest('[data-lesson]'); if (b) { startLesson(b.dataset.lesson); showView('learn'); } });
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { showView(t.dataset.view); location.hash = t.dataset.view === 'learn' ? '#lesson/' + (current ? current.id : 'welcome') : '#' + t.dataset.view; }));
    $('#brand').addEventListener('click', e => { e.preventDefault(); showView('learn'); startLesson('welcome'); });
    $('#btn-theme').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; store.set('theme', t); });
    $('#btn-menu').addEventListener('click', () => { if (!$('#view-learn').classList.contains('active')) { showView('learn'); setMenu(true); return; } setMenu(!$('#sidebar').classList.contains('open')); });
    $('#sidebar-backdrop').addEventListener('click', closeMenu);
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !$('#editor-modal').hidden) return;
      if ($('#sidebar').classList.contains('open')) closeMenu();
      else if ($('#view-learn').dataset.max) setMax(null);
    });
    document.querySelectorAll('.max-btn').forEach(b => b.addEventListener('click', () => setMax($('#view-learn').dataset.max === b.dataset.max ? null : b.dataset.max)));
    $('#btn-close-menu').addEventListener('click', closeMenu);
    $('#btn-term-clear').addEventListener('click', () => { term.clear(); term.focus(); });
    $('#btn-legend').addEventListener('click', () => {
      const lg = $('#legend');
      lg.hidden = !lg.hidden;
      lg.innerHTML = `<i style="background:var(--good)"></i>Running &amp; ready<i style="background:var(--warn)"></i>Pending / starting / not ready<i style="background:var(--bad)"></i>Crashing / failing<i style="background:var(--muted)"></i>Completed / terminating<i style="background:linear-gradient(90deg,#f66,#6af,#6f6)"></i>Left stripe = owner (same color = same Deployment)<i style="background:var(--accent)"></i>Line Service → ready Pod (dashed = not ready)`;
    });
    document.querySelectorAll('.speed button').forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
    $('#ns-filter').addEventListener('change', () => {});
    document.querySelectorAll('.mobile-switch button').forEach(b => b.addEventListener('click', () => setPane(b.dataset.pane)));
    $('#hb-search').addEventListener('input', e => renderHbList(e.target.value));
    $('#hb-items').addEventListener('click', e => { const b = e.target.closest('[data-hq]'); if (b) openHandbook(+b.dataset.hq); });
    $('#hb-article').addEventListener('click', e => {
      const b = e.target.closest('[data-hq]'); if (b) { openHandbook(+b.dataset.hq); return; }
      const a = e.target.closest('[data-golesson]'); if (a) { e.preventDefault(); showView('learn'); startLesson(a.dataset.golesson); return; }
      const q = e.target.closest('a.qref'); if (q) openHandbook(+q.dataset.q);
    });
    $('#fc-wrap').addEventListener('click', e => {
      if (e.target.closest('#fc-card') && !e.target.closest('a')) { fcFlipped = !fcFlipped; $('#fc-card').classList.toggle('flipped', fcFlipped); return; }
      if (e.target.closest('#fc-know')) fcNext(true);
      if (e.target.closest('#fc-again')) fcNext(false);
      if (e.target.closest('#fc-reset')) { fcState.known = {}; store.set('fc.v1', fcState); buildDeck(); renderFlashcards(); }
      const a = e.target.closest('[data-hbq]'); if (a) { e.preventDefault(); openHandbook(+a.dataset.hbq); }
    });
    $('#fc-wrap').addEventListener('change', e => { if (e.target.id === 'fc-sec') { fcState.sec = +e.target.value; store.set('fc.v1', fcState); buildDeck(); fcFlipped = false; renderFlashcards(); } });
    document.addEventListener('keydown', e => {
      if (!$('#view-flashcards').classList.contains('active')) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fcFlipped = !fcFlipped; const c = $('#fc-card'); if (c) c.classList.toggle('flipped', fcFlipped); }
      if (e.key === 'ArrowRight') fcNext(true);
      if (e.key === 'ArrowLeft') fcNext(false);
    });
    $('#cs-wrap').addEventListener('click', e => { const c = e.target.closest('[data-paste]'); if (c) { showView('learn'); location.hash = '#lesson/' + current.id; term.paste(c.dataset.paste); } });
    window.addEventListener('hashchange', route);
    initSplitter();
    initVSplitter();
    renderHbList();
    updateProgressRing();
    setInterval(loop, 100);
    // first lesson
    const h = location.hash;
    const saved = store.get('lesson', 'welcome');
    startLesson(/^#lesson\//.test(h) ? h.slice(8) : saved, { reuse: true });
    route();
    setTimeout(() => term.focus(), 200);
  }
  function setSpeed(x) {
    speed = x;
    document.querySelectorAll('.speed button').forEach(b => b.classList.toggle('active', +b.dataset.speed === x));
    updateClock();
  }
  function route() {
    const h = location.hash;
    let m;
    if ((m = h.match(/^#handbook\/Q(\d+)$/))) { openHandbook(+m[1]); return; }
    if (h === '#handbook') { showView('handbook'); return; }
    if (h === '#flashcards') { showView('flashcards'); return; }
    if (h === '#cheatsheet') { showView('cheatsheet'); return; }
    if ((m = h.match(/^#lesson\/([\w-]+)$/))) { showView('learn'); if (!current || current.id !== m[1]) startLesson(m[1]); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
