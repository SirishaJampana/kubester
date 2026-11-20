/* Kubester — terminal UI: input, history, completion, heredocs, colors, async execution of shell generators. */
(function (G) {
  'use strict';
  const KS = G.KS;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const GOOD = /\b(Running|Ready|Completed|Succeeded|Bound|Active|deployed|Complete|Available|condition met|successfully rolled out|yes)\b/g;
  const PEND = /\b(Pending|ContainerCreating|Terminating|PodInitializing|NotReady|SchedulingDisabled|Unknown|Released|Waiting|pending-install|pending-upgrade|pending-rollback|superseded|Init:\d+\/\d+|&lt;pending&gt;|&lt;unknown&gt;)/g;
  const BAD = /\b(CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|CreateContainerConfigError|Evicted|InvalidImageName|StartError|ErrImageNeverPull|Error|Failed|failed|Init:CrashLoopBackOff|Init:Error|BackoffLimitExceeded|Forbidden|Unhealthy|FailedScheduling|FailedMount|FailedCreate|no)\b/g;
  const VERB = /^(\S+\/\S+|\S+ "[^"]+") (created|configured|unchanged|deleted|force deleted|scaled|exposed|labeled|unlabeled|annotated|patched|rolled back|restarted|edited|autoscaled|cordoned|uncordoned|drained|evicted|tainted|untainted|image updated|env updated|resource requirements updated|replaced|paused|resumed)( .*)?$/;

  function highlight(line, stream) {
    if (stream === 'err' || /^(error|Error from server|error:|curl: \(|wget: |bash: |sh: |command terminated|OCI runtime|jq: error)/.test(line)) {
      if (/^\(Kubester/.test(line)) return `<span class="t-tip">${esc(line)}</span>`;
      if (/^Warning:|^Flag --|^Defaulted container|^Found \d+ pods|^W\d{4}/.test(line)) return `<span class="t-warn">${esc(line)}</span>`;
      if (/^No resources found|^No events found/.test(line)) return `<span class="t-dim">${esc(line)}</span>`;
      return `<span class="t-err">${esc(line)}</span>`;
    }
    if (/^\(Kubester/.test(line) || /^\(dropped by|^\(blocked by/.test(line)) return `<span class="t-tip">${esc(line)}</span>`;
    let h = esc(line);
    const m = line.match(VERB);
    if (m) return `${esc(m[1])} <span class="t-good">${esc(m[2])}</span>${esc(m[3] || '')}`;
    if (/^([A-Z][A-Z0-9()%.\-/]*(\s{2,}|\s(?=[A-Z(]))){1,}[A-Z][A-Z0-9()%.\-/ ]*$/.test(line.trim()) && /\s{2,}/.test(line)) return `<span class="t-head">${h}</span>`;
    if (/^[⏩🔥📉🔌🔋💽⏱️♻️]/.test(line)) return `<span class="t-banner">${h}</span>`;
    h = h.replace(/^(\s*(?:- )?)([\w.\-/]+):(?=\s|$)/, '$1<span class="t-yaml-key">$2</span>:');
    h = h.replace(BAD, '<span class="t-bad">$1</span>').replace(GOOD, '<span class="t-good">$1</span>').replace(PEND, '<span class="t-pend">$1</span>');
    return h;
  }

  class Terminal {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts;
      this.shell = opts.shell;
      this.out = document.createElement('div');
      this.out.className = 'term-out';
      this.el.appendChild(this.out);
      this.inputLine = document.createElement('div');
      this.inputLine.className = 'term-input-line';
      this.promptEl = document.createElement('span');
      this.input = document.createElement('input');
      this.input.className = 'term-input';
      this.input.setAttribute('aria-label', 'Terminal input');
      this.input.setAttribute('autocomplete', 'off');
      this.input.setAttribute('autocapitalize', 'off');
      this.input.setAttribute('spellcheck', 'false');
      this.inputLine.append(this.promptEl, this.input);
      this.el.appendChild(this.inputLine);
      this.suggest = document.createElement('div');
      this.suggest.className = 'term-suggest';
      this.el.appendChild(this.suggest);
      this.pending = { out: '', err: '' };
      this.queue = [];
      this.busy = false;
      this.mode = null; // {kind:'heredoc'|'interactive', ...}
      this.histIdx = null;
      this.lastTab = 0;
      this.bind();
      this.renderPrompt();
    }

    // ------------------------------------------------------------------ output
    write(s, stream) {
      stream = stream || 'out';
      if (s.startsWith('\x1b[watch]')) { this.setWatch(s.slice(8)); return; }
      if (s.includes('\x1bc')) { this.clear(); s = s.replace(/\x1bc/g, ''); if (!s) return; }
      const other = stream === 'out' ? 'err' : 'out';
      if (this.pending[other]) { this.appendLine(this.pending[other], other); this.pending[other] = ''; }
      const text = this.pending[stream] + s;
      const lines = text.split('\n');
      this.pending[stream] = lines.pop();
      lines.forEach(l => this.appendLine(l, stream));
      this.scroll();
    }
    flush() { ['out', 'err'].forEach(k => { if (this.pending[k]) { this.appendLine(this.pending[k], k); this.pending[k] = ''; } }); }
    appendLine(line, stream) {
      const d = document.createElement('div');
      d.className = /\S {3,}\S/.test(line) && !/^\s*#/.test(line) ? 'term-line nowrap' : 'term-line';
      d.innerHTML = highlight(line, stream) || '&nbsp;';
      this.out.appendChild(d);
      while (this.out.childNodes.length > 3000) this.out.removeChild(this.out.firstChild);
    }
    echo(promptHtml, cmd) {
      const d = document.createElement('div');
      d.className = 'term-line';
      d.innerHTML = promptHtml + `<span class="t-cmd">${esc(cmd)}</span>`;
      this.out.appendChild(d);
    }
    html(h) { const d = document.createElement('div'); d.className = 'term-line'; d.innerHTML = h; this.out.appendChild(d); this.scroll(); }
    setWatch(text) {
      if (!this.watchEl) { this.watchEl = document.createElement('div'); this.watchEl.className = 'watch-block'; this.out.appendChild(this.watchEl); }
      this.watchEl.innerHTML = text.split('\n').map((l, i) => `<div class="term-line">${i === 0 ? `<span class="t-dim">${esc(l)}</span>` : highlight(l, 'out') || '&nbsp;'}</div>`).join('');
      this.scroll();
    }
    clear() { this.out.innerHTML = ''; this.watchEl = null; }
    scroll() { this.el.scrollTop = this.el.scrollHeight; }

    promptHtml() {
      if (this.mode && this.mode.kind === 'heredoc') return '<span class="t-dim">&gt; </span>';
      if (this.mode && this.mode.kind === 'interactive') return `<span class="t-cprompt">${esc(this.mode.inter.prompt())}</span>`;
      const p = this.shell.prompt();
      return `<span class="t-prompt">${esc(p.user)}</span>:<span class="t-path">${esc(p.cwd)}</span>${p.sym} `;
    }
    renderPrompt() {
      this.promptEl.innerHTML = this.promptHtml();
      const hide = this.busy && !(this.mode && this.mode.kind === 'interactive');
      const hadFocus = document.activeElement === this.input;
      this.inputLine.style.display = hide ? 'none' : 'flex';
      if (hide && hadFocus) this.el.focus({ preventScroll: true });
      if (!hide && document.activeElement === this.el) this.input.focus({ preventScroll: true });
      if (!hide && this.typeahead && !this.queue.length) { this.input.value += this.typeahead; this.typeahead = ''; }
    }
    focus() { if (this.inputLine.style.display !== 'none') this.input.focus({ preventScroll: true }); else this.el.focus({ preventScroll: true }); }

    // ------------------------------------------------------------------ input
    bind() {
      this.el.addEventListener('mouseup', () => { if (!window.getSelection().toString()) this.focus(); });
      this.input.addEventListener('keydown', e => this.onKey(e));
      this.typeahead = '';
      this.el.addEventListener('keydown', e => {
        if (e.target === this.input) return;
        this.onBusyKey(e);
      });
      // keys pressed while nothing has focus still reach the terminal (Learn view only)
      document.addEventListener('keydown', e => {
        const a = document.activeElement;
        if (a && a !== document.body) return;
        if (!this.el.offsetParent) return;
        const modal = document.getElementById('editor-modal');
        if (modal && !modal.hidden) return;
        if (this.inputLine.style.display !== 'none' && !e.ctrlKey && !e.metaKey && e.key.length === 1) { e.preventDefault(); this.input.focus(); this.input.value += e.key; return; }
        this.onBusyKey(e);
      });
      this.input.addEventListener('paste', e => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (text && text.includes('\n')) {
          e.preventDefault();
          const lines = text.replace(/\r\n/g, '\n').split('\n');
          if (lines[lines.length - 1] === '') lines.pop();
          lines[0] = this.input.value + lines[0];
          this.input.value = '';
          this.enqueue(lines);
        }
      });
    }
    onBusyKey(e) {
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); this.typeahead = ''; this.interrupt(); return; }
      if (!this.busy || (this.mode && this.mode.kind === 'interactive')) { if (this.inputLine.style.display !== 'none' && e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.input.focus(); this.input.value += e.key; } return; }
      if (e.key === 'Enter') { e.preventDefault(); this.queue.push(this.typeahead); this.typeahead = ''; return; }
      if (e.key === 'Backspace') { e.preventDefault(); this.typeahead = this.typeahead.slice(0, -1); return; }
      if (e.key === 'Tab') { e.preventDefault(); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.typeahead += e.key; }
    }
    onKey(e) {
      const v = this.input.value;
      if (e.key === 'Enter') { e.preventDefault(); this.input.value = ''; this.suggest.textContent = ''; this.submit(v); return; }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        if (this.input.selectionStart !== this.input.selectionEnd) return; // allow copy
        e.preventDefault();
        if (this.busy && !(this.mode && this.mode.kind === 'interactive')) { this.interrupt(); return; }
        this.echo(this.promptHtml(), v + '^C');
        this.input.value = '';
        if (this.mode && this.mode.kind === 'heredoc') { this.mode = null; }
        this.renderPrompt();
        this.scroll();
        return;
      }
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); this.clear(); return; }
      if (e.ctrlKey && (e.key === 'd' || e.key === 'D') && this.mode && this.mode.kind === 'interactive' && !v) { e.preventDefault(); this.submit('exit'); return; }
      if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) { e.preventDefault(); this.input.value = ''; return; }
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); this.input.setSelectionRange(0, 0); return; }
      if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); this.input.setSelectionRange(v.length, v.length); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const hist = this.mode && this.mode.kind === 'interactive' ? this.mode.history : this.shell.history;
        if (!hist.length) return;
        if (this.histIdx == null) { this.histIdx = hist.length; this.draft = v; }
        this.histIdx = Math.max(0, Math.min(hist.length, this.histIdx + (e.key === 'ArrowUp' ? -1 : 1)));
        this.input.value = this.histIdx === hist.length ? this.draft || '' : hist[this.histIdx];
        setTimeout(() => this.input.setSelectionRange(this.input.value.length, this.input.value.length));
        return;
      }
      if (e.key === 'Tab') { e.preventDefault(); this.complete(); return; }
      this.histIdx = null;
      this.suggest.textContent = '';
    }
    complete() {
      if (this.mode) return;
      const v = this.input.value;
      const pos = this.input.selectionStart;
      const before = v.slice(0, pos);
      const cands = this.shell.complete(before);
      if (!cands.length) return;
      const lastWord = before.split(/\s+/).pop();
      let common = cands[0];
      for (const c of cands) { let i = 0; while (i < common.length && i < c.length && common[i] === c[i]) i++; common = common.slice(0, i); }
      const add = cands.length === 1 ? cands[0] + (/[/=]$/.test(cands[0]) ? '' : ' ') : common;
      if (add.length > lastWord.length || cands.length === 1) {
        const nv = before.slice(0, before.length - lastWord.length) + add + v.slice(pos);
        this.input.value = nv;
        const np = before.length - lastWord.length + add.length;
        this.input.setSelectionRange(np, np);
        this.suggest.textContent = '';
      } else {
        const now = Date.now();
        if (now - this.lastTab < 800 || cands.length <= 12) this.suggest.textContent = cands.slice(0, 60).join('   ') + (cands.length > 60 ? `   … (${cands.length})` : '');
        this.lastTab = now;
        this.scroll();
      }
    }
    enqueue(lines) { this.queue.push(...lines); if (!this.busy) this.drain(); }
    async drain() {
      while (this.queue.length && !this.busy) {
        const l = this.queue.shift();
        await this.submit(l);
      }
    }
    // type a command visibly, then run it (used by lesson ▶ buttons)
    async typeAndRun(cmd) {
      if (this.busy && !(this.mode && this.mode.kind === 'interactive')) return false;
      this.focus();
      this.input.value = '';
      for (let i = 0; i < cmd.length; i += Math.max(1, Math.round(cmd.length / 28))) { this.input.value = cmd.slice(0, i + 1); await new Promise(r => setTimeout(r, 12)); }
      this.input.value = '';
      await this.submit(cmd);
      return true;
    }
    paste(cmd) { this.input.value = cmd; this.focus(); this.input.setSelectionRange(cmd.length, cmd.length); }

    async submit(line) {
      this.histIdx = null;
      if (this.mode && this.mode.kind === 'heredoc') {
        this.echo(this.promptHtml(), line);
        if (line.replace(this.mode.strip ? /^\t+/ : /$^/, '') === this.mode.delim) {
          const m = this.mode;
          this.mode = null;
          await this.execute(m.cmd, m.lines.join('\n') + '\n');
        } else { this.mode.lines.push(this.mode.strip ? line.replace(/^\t+/, '') : line); this.renderPrompt(); }
        this.scroll();
        return;
      }
      if (this.mode && this.mode.kind === 'interactive') {
        this.echo(this.promptHtml(), line);
        if (line.trim()) this.mode.history.push(line);
        const io = { out: s => this.write(s, 'out'), err: s => this.write(s, 'err') };
        let r;
        try { r = this.mode.inter.run(line, io); } catch (e) { this.write(`sh: ${e.message}\n`, 'err'); r = {}; }
        this.flush();
        if (r && r.exit) { const done = this.mode.done; this.mode = null; done({ code: r.code || 0 }); }
        this.renderPrompt();
        this.scroll();
        return;
      }
      if (this.busy) { this.queue.push(line); return; }
      const hd = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/);
      this.echo(this.promptHtml(), line);
      if (hd) {
        this.mode = { kind: 'heredoc', delim: hd[3], strip: hd[1] === '-', lines: [], cmd: line.replace(hd[0], '').replace(/\s+$/, '') };
        this.renderPrompt();
        this.scroll();
        return;
      }
      await this.execute(line);
    }

    async execute(line, stdin) {
      if (!line.trim()) { this.renderPrompt(); this.scroll(); return; }
      this.busy = true;
      this.watchEl = null;
      this.opts.onCommandStart && this.opts.onCommandStart(line);
      this.renderPrompt();
      const io = { out: s => this.write(s, 'out'), err: s => this.write(s, 'err') };
      const gen = this.shell.run(line, io, stdin);
      let send;
      let code = 0;
      try {
        for (;;) {
          const r = gen.next(send);
          send = undefined;
          if (r.done) { code = r.value || 0; break; }
          const y = r.value || {};
          if (y.sleep != null) {
            const res = await this.sleep(y.sleep);
            if (res === 'cancel') { gen.return(130); code = 130; break; }
          } else if (y.fastForward) {
            this.flush();
            await this.opts.fastForward(y.fastForward);
          } else if (y.clear) this.clear();
          else if (y.task) send = await this.runTask(y.task);
          else if (y.interactive) send = await this.runInteractive(y.interactive);
          else if (y.editor) { this.flush(); send = await this.opts.openEditor(y.editor, this); }
        }
      } catch (e) {
        this.write(`error: ${e.message}\n`, 'err');
        if (typeof console !== 'undefined') console.error(e);
      }
      this.flush();
      this.busy = false;
      this.cancelFn = null;
      this.opts.onBusy && this.opts.onBusy(false);
      this.renderPrompt();
      this.scroll();
      this.opts.onCommandDone && this.opts.onCommandDone(line, code);
      if (this.queue.length) setTimeout(() => this.drain(), 30);
    }
    sleep(ms) {
      return new Promise(resolve => {
        this.opts.onBusy && this.opts.onBusy(true);
        const t = setTimeout(() => { this.cancelFn = null; resolve('ok'); }, Math.min(ms, 120000));
        this.cancelFn = () => { clearTimeout(t); this.write('^C\n', 'out'); resolve('cancel'); };
      });
    }
    runTask(task) {
      return new Promise(resolve => {
        this.opts.onBusy && this.opts.onBusy(true);
        let last = performance.now();
        const finish = res => {
          clearInterval(iv);
          this.cancelFn = null;
          this.opts.onBusy && this.opts.onBusy(false);
          this.flush();
          if (res && res.interactive) { this.runInteractive(res.interactive).then(resolve); return; }
          resolve({ code: res && res.code != null ? res.code : res === 'cancel' ? 130 : 0 });
        };
        const iv = setInterval(() => {
          const now = performance.now();
          const dt = Math.min(1000, now - last);
          last = now;
          let res;
          try { res = task.tick(dt); } catch (e) { this.write(`error: ${e.message}\n`, 'err'); res = { code: 1 }; }
          if (res) finish(res);
        }, 100);
        this.cancelFn = () => { try { task.cancel && task.cancel(); } catch (e) { /* ignore */ } this.flush(); this.write('^C\n', 'out'); finish('cancel'); };
      });
    }
    runInteractive(inter) {
      return new Promise(resolve => {
        this.flush();
        this.mode = { kind: 'interactive', inter, history: [], done: resolve };
        this.html(`<span class="term-ctx-badge">inside ${esc(inter.title || 'container')} — type <b>exit</b> (or Ctrl+D) to return to your laptop</span>`);
        this.busy = true;
        this.renderPrompt();
        this.inputLine.style.display = 'flex';
        this.focus();
      }).then(r => { this.busy = true; return r; });
    }
    interrupt() {
      if (this.cancelFn) { const f = this.cancelFn; this.cancelFn = null; f(); return; }
    }
    banner() {
      this.html('<span class="t-banner">Kubester terminal — this is your <b>laptop</b> with kubectl configured for a simulated 4-node cluster.</span>');
      this.html('<span class="t-dim">Type <span class="t-cmd">help</span> for tips · click a command in the lesson · <kbd>Tab</kbd> completes · <kbd>↑</kbd> history · <kbd>Ctrl</kbd>+<kbd>C</kbd> stops a running command</span>');
    }
  }

  KS.Terminal = Terminal;
  KS.termHighlight = highlight;
})(typeof window !== 'undefined' ? window : globalThis);
