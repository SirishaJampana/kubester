/* Kubester — cluster map. An architecture diagram (control plane on the left, worker nodes on the right)
   that plays every command as a focused, step-by-step story: the parts that act light up, the rest fades,
   and one labelled arrow shows who talks to whom. */
(function (G) {
  'use strict';
  const KS = G.KS;
  const U = KS.util;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SYSTEM_NS = ['kube-system'];

  const COMPONENT_INFO = {
    api: { name: 'kube-apiserver', q: 57, text: 'The front door. Every request — yours and every controller\'s — passes Authentication → Authorization (RBAC) → Mutating admission → Validation → Validating admission, and is then stored in etcd. Components never talk to each other directly; they watch the API server.' },
    etcd: { name: 'etcd', q: 56, text: 'The distributed key-value database holding ALL cluster state (/registry/pods/…). Only the API server talks to it. It uses Raft, so run 3 or 5 members. Back it up hourly — lose it and the cluster is gone.' },
    sched: { name: 'kube-scheduler', q: 59, text: 'Watches for Pods with no node. Filters out nodes that can\'t run the Pod (resources, taints, affinity, volumes), scores the rest, and binds the Pod to the best one.' },
    cm: { name: 'kube-controller-manager', q: 2, text: 'Runs the reconcile loops: Deployment, ReplicaSet, Node, Job, Endpoints, garbage collector… each compares desired vs actual state and acts to close the gap.' },
    you: { name: 'Your laptop (kubectl)', q: 8, text: 'kubectl turns your commands into HTTPS requests to the API server. Your laptop is OUTSIDE the cluster: ClusterIPs and Pod IPs are not reachable from here.' },
    net: { name: 'The Internet', q: 19, text: 'Image registries live here, and external traffic enters through NodePorts, cloud LoadBalancers, or an Ingress controller.' },
  };
  const ROLE = { api: 'front door', etcd: 'cluster database', sched: 'picks a node', cm: 'keeps desired state' };
  const TITLE = { api: 'API Server', etcd: 'etcd', sched: 'Scheduler', cm: 'Controllers' };
  const ICON = { api: 'door', etcd: 'db', sched: 'target', cm: 'loop' };

  function hue(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return h; }
  function rr(ctx, x, y, w, h, r) {
    w = Math.max(0, w); h = Math.max(0, h);
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  const ease = t => 1 - Math.pow(1 - t, 3);
  const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const center = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const SPEED_MIN = 0.25, SPEED_MAX = 2;
  const SNAPS = [0.5, 1, 1.5, 2];                                    // the slider gently snaps to these
  const fmtSpeed = v => (Math.round(v * 100) / 100).toString().replace(/^0\./, '0.') + '×';
  const DIM = 0.2;   // opacity of everything that is not part of the current step
  const CTRL_NAMES = { deployment: 'Deployment', replicaset: 'ReplicaSet', ReplicaSet: 'ReplicaSet', job: 'Job', Job: 'Job', cronjob: 'CronJob', CronJob: 'CronJob', daemonset: 'DaemonSet', DaemonSet: 'DaemonSet', statefulset: 'StatefulSet', StatefulSet: 'StatefulSet', hpa: 'HPA', gc: 'Garbage-collector', node: 'Node' };
  function plural(k, n) { if (n === 1) return k; if (/s$/.test(k)) return k; if (/y$/.test(k)) return k.slice(0, -1) + 'ies'; return k + 's'; }
  function listNames(names, max) { max = max || 3; const u = [...new Set(names)]; return u.slice(0, max).join(', ') + (u.length > max ? ` +${u.length - max} more` : ''); }

  class ClusterViz {
    constructor(canvas, wrap, opts) {
      this.cv = canvas;
      this.wrap = wrap;
      this.ctx = canvas.getContext('2d');
      this.opts = opts;
      this.pos = {};          // pod uid -> animated rect
      this.marks = [];        // short labels popping over pods
      this.rings = [];
      this.fx = {};           // pod uid -> {kind, until}
      this.hits = [];
      this.hover = null;
      this.selected = null;
      this.flow = opts.flowbar || null;
      this.speed = 1;
      try {
        const v = parseFloat(localStorage.getItem('kubester.speed'));
        if (v >= SPEED_MIN && v <= SPEED_MAX) this.speed = v;
        else { const old = localStorage.getItem('kubester.pace'); if (old === 'slow') this.speed = 0.5; else if (old === 'fast') this.speed = 2; }
      } catch (e) { /* ignore */ }
      this.paused = false;
      this.speedEl = opts.speedCtl || null;
      this.buildFlow();
      this.buildSpeed();
      this.resetDirector();
      this.readColors();
      this.bindMouse();
      new ResizeObserver(() => this.resize()).observe(wrap);
      this.resize();
      const loop = t => { this.frame(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    readColors() {
      const s = getComputedStyle(document.documentElement);
      const v = n => s.getPropertyValue(n).trim();
      this.col = { bg: v('--bg'), panel: v('--panel'), panel2: v('--panel-2'), panel3: v('--panel-3'), border: v('--border'), border2: v('--border-2'), text: v('--text'), text2: v('--text-2'), muted: v('--muted'), accent: v('--accent'), accent2: v('--accent-2'), good: v('--good'), warn: v('--warn'), bad: v('--bad'), info: v('--info'), k8s: v('--k8s') };
      this.light = document.documentElement.dataset.theme === 'light';
    }
    resize() {
      const r = this.wrap.getBoundingClientRect();
      this.W = Math.max(200, r.width);
      this.H = Math.max(120, r.height);
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.cv.width = Math.round(this.W * this.dpr);
      this.cv.height = Math.round(this.H * this.dpr);
    }
    attach(cluster) {
      if (this.unsub) this.unsub.forEach(f => f());
      this.c = cluster;
      this.pos = {};
      this.marks = [];
      this.fx = {};
      this.selected = null;
      this.opts.inspector.hidden = true;
      if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
      this.resetDirector();
      this.unsub = [
        cluster.on('api', e => this.onApi(e)),
        cluster.on('pod-created', p => this.onPodCreated(p)),
        cluster.on('schedule', e => this.onSchedule(e)),
        cluster.on('kubelet', e => this.onKubelet(e)),
        cluster.on('pod-gone', e => this.onPodGone(e)),
        cluster.on('traffic', e => this.onTraffic(e)),
        cluster.on('pod-hit', e => this.addFx(e.uid, 'hit', 700)),
      ];
    }

    // ------------------------------------------------------------------ director: raw cluster events → a paced, numbered story
    // The simulator does a whole chain (request → etcd → controllers → scheduler → kubelet) inside ~100 ms.
    // Events are collected, ordered by phase, merged when they are the same kind of work, and played ONE STEP AT A TIME.
    resetDirector() {
      this.q = [];
      this.cur = null;
      this.nextAt = 0;
      this.batch = [];
      this.arrows = [];
      this.timers = [];
      this.rings = [];
      this.hold = {};            // pod uid -> { stage: 'hidden' | 'queued', at }: not yet "created"/"scheduled" in the story
      this.flights = {};         // pod uid -> { start, dur, sx, sy }: flying from the Pending tray to its node
      this.gate = {};            // pod uid -> { stage: 'creating' | 'starting' }: picture waits for the kubelet steps
      this.focus = null;         // { keys: Set, at, endAt, hasPods }
      this.story = null;
      this.pinned = null;
      this.renderFlow();
    }
    // narrator lines are released when the step they belong to starts playing, so text and picture stay in sync
    narrate(n, show) {
      const tgt = this.batch[this.batch.length - 1];
      if (tgt) { (tgt.narr = tgt.narr || []).push(() => show(n)); return; }
      show(n);
    }
    flushNarr(st) { const l = st.narr || []; st.narr = null; l.forEach(f => { try { f(); } catch (e) { /* ignore */ } }); }
    later(ms, fn) { this.timers.push({ at: this.now() + ms, fn }); }
    addFx(uid, kind, ms) { this.fx[uid] = { kind, until: this.now() + ms, start: this.now(), dur: ms }; }
    // The animation runs on its own clock: real time × speed (0 while paused). Every animated thing is
    // timed with this.now(), so dragging the speed slider or pausing affects what's on screen instantly.
    now() {
      const r = performance.now();
      if (this._vr === undefined) { this._vr = r; this._vt = r; }
      if (!this.frozen) this._vt += (r - this._vr) * (this.paused ? 0 : this.speed);
      this._vr = r;
      return this._vt;
    }
    setSpeed(v) {
      v = Math.round(clamp(+v || 1, SPEED_MIN, SPEED_MAX) * 20) / 20;   // 0.05 steps
      for (const sn of SNAPS) if (Math.abs(v - sn) < 0.051) v = sn;
      this.now();                                                       // bank elapsed time at the old speed
      this.speed = v;
      try { localStorage.setItem('kubester.speed', String(v)); } catch (e) { /* private mode */ }
      this.renderSpeed();
    }
    setPaused(on) {
      this.now();
      this.paused = !!on;
      this.renderSpeed();
      this.renderFlow();
    }
    beginCommand(line) {
      if (this.hiddenSince) this.skipAll();
      for (const s of this.q) s.stale = true;      // leftovers of the previous command hurry through
      this.story = { title: line, steps: [], n: 0, cmd: true, at: this.now() };
      this.pinned = null;
      this.renderFlow();
    }
    endCommand() {
      const s = this.story;
      if (s && s.cmd && !s.steps.length) { s.noop = true; this.renderFlow(); }
    }
    skipAll() {
      const all = (this.cur ? [this.cur.step] : []).concat(this.q);
      this.cur = null; this.q = [];
      for (const st of all) { this.flushNarr(st); if (st.finish) try { st.finish(); } catch (e) { /* ignore */ } st.state = 'done'; }
      this.timers.forEach(t => { try { t.fn(); } catch (e) { /* ignore */ } });
      this.timers = []; this.arrows = []; this.focus = null;
      this.hold = {}; this.flights = {}; this.gate = {};
      this.renderFlow();
    }
    push(step) {
      this.batch.push(step);
      if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flushBatch(), 0);
    }
    flushBatch() {
      this.batchTimer = null;
      const b = this.batch.map((s, i) => [s, i]).sort((x, y) => x[0].phase - y[0].phase || x[1] - y[1]).map(x => x[0]);
      this.batch = [];
      const now = this.now();
      for (const st of b) {
        const last = this.q[this.q.length - 1];
        if (last && last.key === st.key && !last.stale) { last.items.push(...st.items); if (st.narr) last.narr = (last.narr || []).concat(st.narr); continue; }
        if (!this.story || (!this.story.cmd && this.storyIdle(now)) || (this.story.cmd && this.storyIdle(now) && now - this.story.at > 8000)) {
          this.story = { title: 'The cluster is reacting on its own', steps: [], n: 0, cmd: false, at: now };
        }
        st.story = this.story;
        this.story.noop = false;
        st.n = ++this.story.n;
        st.state = 'queued';
        this.story.steps.push(st);
        if (this.story.steps.length > 40) this.story.steps.shift();
        this.q.push(st);
      }
      if (this.q.length > 40) { const drop = this.q.splice(0, this.q.length - 40); drop.forEach(s => { this.flushNarr(s); if (s.finish) s.finish(); s.state = 'done'; }); }
      this.renderFlow();
    }
    storyIdle(now) {
      const s = this.story;
      if (!s) return true;
      if (this.q.some(x => x.story === s) || (this.cur && this.cur.step.story === s)) return false;
      return now - (s.lastEnd || s.at) > 5000;
    }
    runDirector(now) {
      for (let i = 0; i < this.timers.length; i++) { const t = this.timers[i]; if (t.at <= now) { this.timers.splice(i--, 1); try { t.fn(); } catch (e) { /* ignore */ } } }
      if (this.cur && now >= this.cur.end) {
        const st = this.cur.step;
        if (st.finish) try { st.finish(); } catch (e) { /* ignore */ }
        st.state = 'done';
        if (st.story) st.story.lastEnd = now;
        this.cur = null;
        for (const a of this.arrows) if (!a.endAt) a.endAt = now;
        if (this.focus && !this.q.length) this.focus.endAt = now;
        this.renderFlow();
      }
      if (!this.cur && this.q.length && now >= this.nextAt) {
        const st = this.q.shift();
        const backlog = this.q.length;
        let k = backlog > 2 ? Math.min(5, 1 + (backlog - 2) * 0.45) : 1;
        if (st.stale) k = Math.max(k, 4);
        const T = st.base / k;
        st.state = 'active';
        st.dur = T;
        this.cur = { step: st, start: now, end: now + T };
        this.nextAt = now + T + 380 / k;
        if (st.story === this.story) this.pinned = null;
        const wasDim = this.focus && !this.focus.endAt && this.focus.keys.size;
        this.focus = { keys: new Set(), at: wasDim ? now - 1000 : now, endAt: 0, hasPods: false };
        this.flushNarr(st);
        try { st.run(T); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
        this.renderFlow();
      }
      this.arrows = this.arrows.filter(a => !a.endAt || now - a.endAt < 450);
      if (this.focus && this.focus.endAt && now - this.focus.endAt > 500) this.focus = null;
      for (const uid of Object.keys(this.hold)) if (now - this.hold[uid].at > 20000) delete this.hold[uid];
      for (const uid of Object.keys(this.gate)) if (now - this.gate[uid].at > 20000) delete this.gate[uid];
      for (const uid of Object.keys(this.flights)) { const f = this.flights[uid]; if (now > f.start + f.dur + 1500) { delete this.flights[uid]; delete this.hold[uid]; } }
    }

    // ------------------------------------------------------------------ focus & arrows
    setFocus(keys) {
      if (!this.focus) this.focus = { keys: new Set(), at: this.now(), endAt: 0, hasPods: false };
      for (const k of keys) if (k) { this.focus.keys.add(k); if (k.startsWith('pod:')) this.focus.hasPods = true; }
    }
    focusLevel(now) {
      const f = this.focus;
      if (!f || !f.keys.size) return 0;
      let v = clamp((now - f.at) / 300, 0, 1);
      if (f.endAt) v *= clamp(1 - (now - f.endAt) / 450, 0, 1);
      return v;
    }
    isLit(key) { return !this.focus || !this.focus.keys.size || this.focus.keys.has(key); }
    podLit(p, queued) {
      const f = this.focus;
      if (!f || !f.keys.size) return true;
      if (f.keys.has('pod:' + p.metadata.uid)) return true;
      if (f.hasPods) return false;
      return queued ? f.keys.has('queue') : f.keys.has('node:' + p.spec.nodeName) || (p.spec.nodeName === (this.L && this.L.cpNode) && f.keys.has('api'));
    }
    alpha(lit) { return lit ? 1 : 1 - (1 - DIM) * this.fl; }
    arrow(from, to, o) {
      o = o || {};
      this.arrows.push({ from, to, label: o.label, color: o.color || this.col.accent, start: this.now() + (o.delay || 0), dur: Math.max(220, o.dur || 700), dashed: !!o.dashed, bend: o.bend || 0, done: o.done, fired: false, endAt: 0 });
    }
    rectOf(key) {
      const L = this.L;
      if (!L) return null;
      if (L.comp[key]) return L.comp[key];
      if (key === 'queue') return L.queueBox;
      if (key === 'ingress') return L.ingress || L.comp.net;
      const i = key.indexOf(':');
      const t = key.slice(0, i), id = key.slice(i + 1);
      if (t === 'node') return L.nodes.find(x => x.name === id) || (id === L.cpNode ? L.cp : null);
      if (t === 'pod') return this.pos[id] || null;
      if (t === 'svc') return L.svcs.find(x => x.uid === id) || null;
      return null;
    }
    // where the line from the rect's centre towards `p` leaves the rect (plus a small gap)
    edgePoint(r, p) {
      const c = center(r), dx = p.x - c.x, dy = p.y - c.y;
      if (!dx && !dy) return c;
      const s = Math.min(dx ? (r.w / 2 + 5) / Math.abs(dx) : Infinity, dy ? (r.h / 2 + 5) / Math.abs(dy) : Infinity);
      return s >= 1 ? c : { x: c.x + dx * s, y: c.y + dy * s };
    }
    arrowGeom(a) {
      const head = (k, r) => (r && k.startsWith('node:') ? { x: r.x + 8, y: r.y, w: r.w - 16, h: 34 } : r);
      const A = head(a.from, this.rectOf(a.from)), B = head(a.to, this.rectOf(a.to));
      if (!A || !B) return null;
      const p0 = this.edgePoint(A, center(B)), p1 = this.edgePoint(B, center(A));
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
      const nx = -(p1.y - p0.y) / len, ny = (p1.x - p0.x) / len;
      return { p0, p1, c: { x: (p0.x + p1.x) / 2 + nx * a.bend, y: (p0.y + p1.y) / 2 + ny * a.bend }, len };
    }
    quad(g, t) { const u = 1 - t; return { x: u * u * g.p0.x + 2 * u * t * g.c.x + t * t * g.p1.x, y: u * u * g.p0.y + 2 * u * t * g.c.y + t * t * g.p1.y }; }
    mark(x, y, text, color, ms) { const now = this.now(); this.marks.push({ x, y, text, color, start: now, until: now + (ms || 1400) }); }
    markPod(uid, text, color, ms) { const r = this.pos[uid]; if (r) this.mark(r.x + r.w / 2, r.y + r.h / 2, text, color, ms); }

    // ------------------------------------------------------------------ events → steps
    podByName(ns, name) { return this.c.get('Pod', ns, name); }
    onPodCreated(p) { this.hold[p.metadata.uid] = { stage: 'hidden', at: this.now() }; }
    reveal(uids) {
      const now = this.now();
      for (const u of uids) if (this.hold[u] && this.hold[u].stage === 'hidden') this.hold[u] = { stage: 'queued', at: now };
    }
    onApi(e) {
      if (e.kind === 'Event') return;
      const user = !e.internal && !e.controller;
      if (user) return this.userApi(e);
      if (e.verb === 'update' || e.verb === 'get') return;          // status chatter: not shown
      const ctl = e.controller ? CTRL_NAMES[e.controller] || (e.controller[0].toUpperCase() + e.controller.slice(1)) : (e.kind === 'Endpoints' ? 'Endpoints' : e.kind === 'Pod' ? 'ReplicaSet' : 'A');
      const item = { kind: e.kind, name: e.name, ns: e.ns, verb: e.verb };
      if (e.kind === 'Pod') { const p = this.podByName(e.ns, e.name); if (p) item.uid = p.metadata.uid; }
      const self = this;
      this.push({
        phase: 1, key: `ctl:${ctl}:${e.verb}:${e.kind}`, items: [item], base: 1900, icon: '🔁',
        get short() { return `${ctl} controller ${this.items[0].verb === 'delete' ? 'deletes' : 'creates'} ${this.items.length > 1 ? this.items.length + ' ' : ''}${plural(this.items[0].kind, this.items.length)}`; },
        get text() {
          const n = this.items.length, k = this.items[0].kind, names = listNames(this.items.map(i => i.name));
          if (this.items[0].verb === 'delete') return `The ${ctl} controller decides ${n === 1 ? 'a ' + k + ' is' : n + ' ' + plural(k, n) + ' are'} no longer needed and asks the API server to delete ${names}.`;
          if (k === 'ReplicaSet') return `The Deployment controller is watching the API server. It sees the new/changed Deployment and creates ReplicaSet ${names} — the object that keeps the right number of Pods running.`;
          if (k === 'Pod') return `The ${ctl} controller counts Pods, finds ${n} missing and creates ${n === 1 ? 'a new Pod' : n + ' new Pods'}. They are stored in etcd but have no node yet → they wait in the Pending tray.`;
          if (k === 'Endpoints') return `The Endpoints controller finds the Pods that match the Service's selector and records their IPs (Endpoints ${names}).`;
          return `The ${ctl} controller compares desired vs actual state and ${this.items[0].verb}s ${n === 1 ? k : n + ' ' + plural(k, n)} ${names}.`;
        },
        run(T) {
          const n = this.items.length, k = this.items[0].kind, verb = this.items[0].verb;
          self.setFocus(['cm', 'api', 'etcd']);
          if (k === 'Endpoints') this.items.forEach(i => { const s = self.c.get('Service', i.ns, i.name); if (s) self.setFocus(['svc:' + s.metadata.uid]); });
          if (k === 'Pod' && verb === 'delete') self.setFocus(this.items.filter(i => i.uid).map(i => 'pod:' + i.uid));
          self.arrow('cm', 'api', { label: `${verb} ${n > 1 ? n + ' ' : ''}${plural(k, n)}`, color: verb === 'delete' ? self.col.bad : self.col.accent, dur: T * 0.38 });
          self.arrow('api', 'etcd', { label: 'save', color: self.col.accent2, dur: T * 0.28, delay: T * 0.45, done: () => {
            this.finish();
            if (k === 'Pod' && verb === 'create') self.setFocus(['queue'].concat(this.items.filter(i => i.uid).map(i => 'pod:' + i.uid)));
          } });
        },
        finish() { self.reveal(this.items.filter(i => i.uid).map(i => i.uid)); },
      });
    }
    userApi(e) {
      const self = this;
      const verbHttp = { get: 'GET', create: 'POST', update: 'PATCH', delete: 'DELETE' }[e.verb] || e.verb.toUpperCase();
      const item = { kind: e.kind, name: e.name, ns: e.ns, verb: e.verb };
      if (e.kind === 'Pod' && e.name) { const p = this.podByName(e.ns, e.name); if (p) item.uid = p.metadata.uid; }
      const what = items => {
        const kinds = [...new Set(items.map(i => i.kind))];
        if (items[0].verb === 'get') return kinds.map(k => plural(k, 2)).join(', ');
        if (items.length === 1) return `${items[0].kind} "${items[0].name}"`;
        return kinds.length === 1 ? `${items.length} ${plural(kinds[0], items.length)}` : `${items.length} objects (${kinds.join(', ')})`;
      };
      const color = e.verb === 'delete' ? this.col.bad : e.verb === 'get' ? this.col.info : this.col.accent;
      this.push({
        phase: 0, key: 'user-send:' + e.verb, items: [item], base: 1400, icon: '💻',
        get short() { return e.verb === 'get' ? 'kubectl asks the API server' : 'kubectl sends it to the API server'; },
        get text() {
          if (e.verb === 'get') return `kubectl sends an HTTPS request to the API server: “give me the ${what(this.items)}${e.ns && e.ns !== 'default' ? ' in namespace ' + e.ns : ''}”.`;
          return `kubectl turns your command into an HTTPS ${verbHttp} request for ${what(this.items)} and sends it to the API server — the only way into the cluster.`;
        },
        run(T) {
          self.setFocus(['you', 'api']);
          if (e.verb === 'delete') self.setFocus(this.items.filter(i => i.uid).map(i => 'pod:' + i.uid));
          self.arrow('you', 'api', { label: `${verbHttp} ${this.items.length > 1 && e.verb !== 'get' ? this.items.length + ' ' : ''}${e.verb === 'get' ? plural(e.kind, 2).toLowerCase() : plural(e.kind, this.items.length)}`, color, dur: T * 0.6 });
        },
      });
      this.push({
        phase: 0.5, key: 'user-store:' + e.verb, items: [item], base: e.verb === 'get' ? 1800 : 1500, icon: e.verb === 'get' ? '📖' : '🗄',
        get short() { return e.verb === 'get' ? 'Read from etcd, reply' : e.verb === 'delete' ? 'Deleted in etcd' : 'Saved in etcd'; },
        get text() {
          if (e.verb === 'get') return `The API server checks you may read them (RBAC), loads them from etcd and sends the answer back to your terminal.`;
          if (e.verb === 'delete') return `The API server checks permissions (RBAC) and records the deletion in etcd.${this.items[0].kind === 'Pod' ? ' Each Pod gets a grace period to shut down cleanly.' : ''}`;
          return `The API server checks who you are, whether you're allowed (RBAC) and runs admission checks — then saves ${what(this.items)} in etcd. Nothing runs yet: this is only the desired state.`;
        },
        run(T) {
          if (e.verb === 'get') {
            self.setFocus(['you', 'api', 'etcd']);
            self.arrow('api', 'etcd', { label: 'read', color: self.col.info, dur: T * 0.3 });
            self.arrow('api', 'you', { label: '200 OK', color: self.col.good, dashed: true, dur: T * 0.4, delay: T * 0.42 });
          } else {
            self.setFocus(['api', 'etcd']);
            if (e.verb === 'delete') self.setFocus(this.items.filter(i => i.uid).map(i => 'pod:' + i.uid));
            self.arrow('api', 'etcd', { label: e.verb === 'delete' ? 'delete' : 'save', color: e.verb === 'delete' ? self.col.bad : self.col.accent2, dur: T * 0.5, done: () => {
              this.finish();
              const ids = this.items.filter(i => i.uid && e.verb === 'create').map(i => 'pod:' + i.uid);
              if (ids.length) self.setFocus(['queue'].concat(ids));
            } });
          }
        },
        finish() { self.reveal(this.items.filter(i => i.uid).map(i => i.uid)); },
      });
      if (e.kind === 'Service' && (e.verb === 'create' || e.verb === 'delete')) {
        this.push({
          phase: 1.5, key: 'proxy:' + e.verb, items: [item], base: 1800, icon: '🔀', short: 'kube-proxy updates every node',
          get text() {
            const svc = self.c.get('Service', e.ns, e.name);
            return e.verb === 'delete' ? `kube-proxy on every node removes the routing rules of Service ${e.name}.`
              : `kube-proxy runs on EVERY node. It sees Service ${e.name} and programs routing rules, so traffic to ${svc && svc.spec.clusterIP && svc.spec.clusterIP !== 'None' ? svc.spec.clusterIP : 'its ClusterIP'} is spread over the Service's ready Pods.`;
          },
          run(T) {
            const L = self.L;
            const nodes = L.nodes.map(n => 'node:' + n.name);
            self.setFocus(['api'].concat(nodes));
            const svc = self.c.get('Service', e.ns, e.name);
            if (svc) self.setFocus(['svc:' + svc.metadata.uid]);
            nodes.forEach((k, i) => self.arrow('api', k, { label: i === 0 ? 'Service rules' : null, color: self.col.accent2, dur: T * 0.45, delay: i * 90 }));
          },
        });
      }
    }
    onSchedule(e) {
      const self = this;
      this.push({
        phase: 2, key: 'sched', items: [{ uid: e.pod, node: e.node, name: e.name }], base: 2200, icon: '🎯',
        get short() { return `Scheduler places ${this.items.length > 1 ? this.items.length + ' Pods' : 'the Pod'}`; },
        get text() {
          const pairs = this.items.slice(0, 3).map(i => `${i.name} → ${i.node}`).join(', ') + (this.items.length > 3 ? ` +${this.items.length - 3} more` : '');
          return `The scheduler sees Pods without a node. It drops nodes that can't fit them (CPU/memory, taints, affinity), scores the rest and binds each Pod to the best one: ${pairs}.`;
        },
        run(T) {
          const nodes = [...new Set(this.items.map(i => i.node))];
          self.setFocus(['sched', 'queue'].concat(nodes.map(n => 'node:' + n), this.items.map(i => 'pod:' + i.uid)));
          self.arrow('sched', 'queue', { label: 'pick a node', color: self.col.info, dur: T * 0.3 });
          this.items.forEach((it, i) => {
            self.flights[it.uid] = { start: this.now() + T * 0.38 + i * Math.min(140, T * 0.06), dur: T * 0.45 };
            if (!self.hold[it.uid]) self.hold[it.uid] = { stage: 'queued', at: this.now() };
          });
        },
        finish() { for (const it of this.items) { delete self.hold[it.uid]; self.gate[it.uid] = { stage: 'creating', at: this.now() }; } },
      });
    }
    onKubelet(e) {
      const self = this;
      const p = this.c.list('Pod').find(x => x.metadata.uid === e.pod);
      const item = { uid: e.pod, node: e.node, name: p ? p.metadata.name : '?', image: p ? (p.spec.containers[0] || {}).image : '' };
      const nodes = it => listNames([...new Set(it.map(i => i.node))], 3);
      const S = {
        pull: { base: 1800, icon: '⬇', short: 'kubelet pulls the image', text: it => `The kubelet on ${nodes(it)} sees a Pod was assigned to its node and downloads the image ${listNames([...new Set(it.map(i => i.image))], 2)} from the registry (skipped if the node already has it).` },
        start: { base: 1200, icon: '▶', short: 'Containers start', text: it => `The kubelet asks the container runtime (containerd) to start the container${it.length > 1 ? 's' : ''} of ${listNames(it.map(i => i.name))}.` },
        ready: { base: 1200, icon: '✅', short: 'Ready ✓', tone: 'good', text: it => `${listNames(it.map(i => i.name))} ${it.length > 1 ? 'are' : 'is'} Running and Ready — ${it.length > 1 ? 'they' : 'it'} can now receive traffic. Desired state reached.` },
        crash: { base: 1600, icon: '💥', short: 'Container crashed', tone: 'bad', text: it => `A container in ${listNames(it.map(i => i.name))} exited with an error. The kubelet restarts it, waiting longer each time (CrashLoopBackOff). Check: kubectl logs ${it[0].name} --previous` },
        fail: { base: 1800, icon: '⛔', short: 'Image pull failed', tone: 'bad', text: it => `The kubelet could not pull ${listNames([...new Set(it.map(i => i.image))], 2)} — wrong name/tag or a private registry. The Pod shows ErrImagePull, then ImagePullBackOff. Check: kubectl describe pod ${it[0].name}` },
        oom: { base: 1600, icon: '💥', short: 'OOMKilled', tone: 'bad', text: it => `${listNames(it.map(i => i.name))} used more memory than its limit, so it was killed (OOMKilled). Raise the memory limit or fix the leak.` },
      }[e.action];
      if (!S) return;
      this.push({
        phase: 3, key: 'kubelet:' + e.action, items: [item], base: S.base, icon: S.icon, tone: S.tone, short: S.short,
        get text() { return S.text(this.items); },
        run(T) {
          const ns = [...new Set(this.items.map(i => i.node))];
          self.setFocus(ns.map(n => 'node:' + n).concat(this.items.map(i => 'pod:' + i.uid)));
          for (const it of this.items) {
            if (e.action === 'start') self.gate[it.uid] = { stage: 'starting', at: this.now() };
            else if (e.action !== 'pull') delete self.gate[it.uid];
            if (e.action === 'pull') self.addFx(it.uid, 'pull', T);
            else if (e.action === 'start') self.addFx(it.uid, 'start', T);
            else if (e.action === 'ready') { self.addFx(it.uid, 'ready', T); self.markPod(it.uid, 'Ready ✓', self.col.good, T); }
            else if (e.action === 'fail') self.later(T * 0.55, () => self.markPod(it.uid, 'pull failed', self.col.bad, T * 0.5));
            else { self.addFx(it.uid, 'crash', T); self.markPod(it.uid, e.action === 'oom' ? 'OOMKilled' : 'crashed', self.col.bad, T); }
          }
        },
      });
    }
    onPodGone(e) {
      const self = this;
      this.push({
        phase: 3.5, key: 'gone', items: [e], base: 1000, icon: '🗑', short: 'Pods removed',
        get text() { return `The kubelet stopped the containers of ${listNames(this.items.map(i => i.name))} and the Pod${this.items.length > 1 ? 's are' : ' is'} gone from the cluster.`; },
        run(T) { for (const it of this.items) self.markPod(it.uid, 'removed', self.col.muted, T); },
      });
    }
    hopKey(h) {
      if (h.t === 'host') return 'you';
      if (h.t === 'internet') return 'net';
      if (h.t === 'ingress') return 'ingress';
      if (h.t === 'svc' || h.t === 'lb') return 'svc:' + h.id;
      if (h.t === 'pod') return 'pod:' + h.id;
      if (h.t === 'node') return 'node:' + h.id;
      return null;
    }
    hopName(h) {
      if (h.t === 'host') return 'your laptop';
      if (h.t === 'internet') return 'the Internet';
      if (h.t === 'ingress') return 'Ingress';
      if (h.t === 'svc' || h.t === 'lb') { const s = this.c.list('Service').find(x => x.metadata.uid === h.id); return s ? 'Service ' + s.metadata.name : 'a Service'; }
      if (h.t === 'pod') { const p = this.c.list('Pod').find(x => x.metadata.uid === h.id); return p ? 'Pod ' + p.metadata.name : 'a Pod'; }
      if (h.t === 'node') return 'node ' + h.id;
      return '';
    }
    onTraffic(e) {
      const self = this;
      const sig = e.hops.map(h => h.t + ':' + h.id).join('>') + (e.blocked ? '!b' : e.ok ? '' : '!e');
      const names = e.hops.map(h => this.hopName(h)).filter(Boolean);
      this.push({
        phase: 4, key: 'traffic:' + sig, items: [e], base: 2200, icon: e.blocked ? '🚫' : e.ok ? '📨' : '⚠', tone: e.blocked || !e.ok ? 'bad' : null,
        get short() { return (e.blocked ? 'Request blocked' : e.ok ? 'Request & response' : 'Request failed') + (this.items.length > 1 ? ` ×${this.items.length}` : ''); },
        get text() {
          const path = names.join(' → ');
          if (e.blocked) return `A request ${path} was dropped by a NetworkPolicy ✕ — only traffic the policy allows can reach the Pod.`;
          if (!e.ok) return `A request ${path} failed (${e.error === 'refused' ? 'connection refused — nothing listens on that port' : e.error === 'resolve' ? 'the DNS name could not be resolved' : 'timed out — no ready Pod answered'}).`;
          return `A request travels ${path}${names.some(n => n.startsWith('Service')) ? ' — the Service picks one of its ready Pods' : ''}, and the response (${e.code || 200}) comes back${this.items.length > 1 ? ` (×${this.items.length})` : ''}.`;
        },
        run(T) {
          const keys = e.hops.map(h => self.hopKey(h)).filter(k => k && self.rectOf(k));
          self.setFocus(keys);
          if (keys.length < 2) return;
          const seg = (T * 0.55) / (keys.length - 1);
          const color = e.blocked ? self.col.bad : e.ok ? self.col.accent : self.col.warn;
          for (let i = 0; i < keys.length - 1; i++) {
            const last = i === keys.length - 2;
            self.arrow(keys[i], keys[i + 1], { label: i === 0 ? 'request' : null, color, dur: seg * 0.85, delay: i * seg, done: last ? () => {
              const r = self.rectOf(keys[keys.length - 1]);
              if (!r) return;
              if (e.blocked) self.mark(r.x + r.w / 2, r.y + r.h / 2, '✕ blocked', self.col.bad, T * 0.5);
              else if (!e.ok) self.mark(r.x + r.w / 2, r.y + r.h / 2, e.error === 'refused' ? 'refused' : e.error === 'resolve' ? 'DNS?' : 'timeout', self.col.warn, T * 0.5);
            } : null });
          }
          if (e.ok) self.arrow(keys[keys.length - 1], keys[0], { label: String(e.code || 200), color: e.code >= 400 ? self.col.warn : self.col.good, dashed: true, bend: 30, dur: T * 0.32, delay: T * 0.6 });
        },
      });
    }

    // ------------------------------------------------------------------ layout
    filterPod(p) {
      const f = this.opts.getFilter();
      if (SYSTEM_NS.includes(p.metadata.namespace) && !f.showSystem) return false;
      if (f.ns !== '*' && p.metadata.namespace !== f.ns && !(SYSTEM_NS.includes(p.metadata.namespace) && f.showSystem)) return false;
      return true;
    }
    computeLayout() {
      const c = this.c, W = this.W, H = this.H, pad = 14;
      const narrow = W < 640;
      const f = this.opts.getFilter();
      const L = { comp: {}, nodes: [], svcs: [], pvs: [], queue: [], pods: [], narrow };
      const nodesAll = c.list('Node');
      const cpObj = nodesAll.find(n => n.metadata.labels['node-role.kubernetes.io/control-plane'] != null);
      L.cpNode = cpObj ? cpObj.metadata.name : null;
      L.cpObj = cpObj;
      // pods by node (Pods the story has not "created"/"scheduled" yet are held back)
      const byNode = {};
      for (const p of c.list('Pod').filter(x => this.filterPod(x))) {
        const held = this.hold[p.metadata.uid];
        if (held && held.stage === 'hidden') continue;
        if (!p.spec.nodeName || held) { L.queue.push(p); continue; }
        (byNode[p.spec.nodeName] = byNode[p.spec.nodeName] || []).push(p);
      }
      // the control-plane node is drawn as the control-plane block; it gets its own column only if it runs visible Pods
      const workers = nodesAll.filter(n => n !== cpObj || (byNode[n.metadata.name] || []).length);
      const svcs = c.list('Service').filter(s => !(s.metadata.namespace === 'default' && s.metadata.name === 'kubernetes') && !SYSTEM_NS.includes(s.metadata.namespace) && s.metadata.namespace !== 'ingress-nginx' && (f.ns === '*' || s.metadata.namespace === f.ns));
      const ctrl = c.ls('Pod', 'ingress-nginx').length > 0;
      L.showNet = ctrl || svcs.some(s => s.spec.type === 'LoadBalancer' || s.spec.type === 'NodePort');
      const pvs = c.list('PersistentVolume');
      if (!narrow) {
        const youW = 70;
        const cp = L.cp = { x: pad + youW + 28, y: pad, w: clamp(W * 0.33, 270, 390), h: H - 2 * pad };
        this.layoutCP(L, cp);
        L.comp.you = { x: pad, y: L.comp.api.y + L.comp.api.h / 2 - 34, w: youW, h: 68, key: 'you' };
        const rx = cp.x + cp.w + 26;
        this.layoutRight(L, rx, pad, W - pad - rx, H - 2 * pad, workers, byNode, svcs, ctrl, pvs);
      } else {
        const youW = 52;
        const cp = L.cp = { x: pad + youW + 14, y: pad, w: W - 2 * pad - youW - 14, h: clamp(H * 0.3, 160, 200) };
        this.layoutCP(L, cp);
        L.comp.you = { x: pad, y: L.comp.api.y + L.comp.api.h / 2 - 28, w: youW, h: 56, key: 'you' };
        const ry = cp.y + cp.h + 16;
        this.layoutRight(L, pad, ry, W - 2 * pad, H - ry - pad, workers, byNode, svcs, ctrl, pvs);
      }
      // Pending tray
      const q = L.queueBox;
      const tw = Math.min(100, (q.w - 28) / 3), th = Math.max(18, Math.min(26, q.h - 24));
      const per = Math.max(1, Math.floor((q.w - 12 + 6) / (tw + 6)));
      const rows = Math.max(1, Math.floor((q.h - 22 + 4) / (th + 4)));
      L.queue.slice(0, per * rows).forEach((p, i) => L.pods.push({ p, r: { x: q.x + 8 + (i % per) * (tw + 6), y: q.y + 20 + Math.floor(i / per) * (th + 4), w: tw, h: th }, queued: true }));
      L.queueOverflow = Math.max(0, L.queue.length - per * rows);
      return L;
    }
    layoutCP(L, cp) {
      const ix = cp.x + 12, iw = cp.w - 24, top = cp.y + 32;
      const qH = L.narrow ? 46 : clamp((cp.h - 42) * 0.26, 46, 78);
      L.queueBox = { x: ix, y: cp.y + cp.h - 12 - qH, w: iw, h: qH };
      const avail = L.queueBox.y - 14 - top;
      if (!L.narrow) {
        // hub and spoke: Controllers and Scheduler above, etcd below, everything goes through the API server
        const gap = clamp(avail * 0.14, 18, 30);
        const rowH = clamp((avail - 2 * gap) / 3, 30, 54);
        const hw = (iw - 18) / 2;
        L.comp.cm = { x: ix, y: top, w: hw, h: rowH, key: 'cm' };
        L.comp.sched = { x: ix + hw + 18, y: top, w: hw, h: rowH, key: 'sched' };
        const aw = clamp(iw * 0.62, 150, iw);
        L.comp.api = { x: cp.x + (cp.w - aw) / 2, y: top + rowH + gap, w: aw, h: rowH, key: 'api' };
        const ew = clamp(iw * 0.5, 120, iw);
        L.comp.etcd = { x: cp.x + (cp.w - ew) / 2, y: L.comp.api.y + rowH + gap, w: ew, h: rowH, key: 'etcd' };
      } else {
        const gap = 12, rowH = Math.max(28, (avail - gap) / 2), hw = (iw - 14) / 2;
        L.comp.cm = { x: ix, y: top, w: hw, h: rowH, key: 'cm' };
        L.comp.sched = { x: ix + hw + 14, y: top, w: hw, h: rowH, key: 'sched' };
        L.comp.api = { x: ix, y: top + rowH + gap, w: hw, h: rowH, key: 'api' };
        L.comp.etcd = { x: ix + hw + 14, y: top + rowH + gap, w: hw, h: rowH, key: 'etcd' };
      }
    }
    layoutRight(L, x, y, w, h, workers, byNode, svcs, ctrl, pvs) {
      let top = y;
      const netW = 82;
      L.comp.net = { x: x + w - netW, y, w: netW, h: 34, key: 'net' };
      const bandRight = L.showNet ? x + w - netW - 10 : x + w;
      if (svcs.length || ctrl || L.showNet) {
        let bx = x;
        const bh = 34;
        if (ctrl) { L.ingress = { x: bx, y: top, w: 92, h: bh }; bx += 100; }
        const sw = svcs.length ? clamp((bandRight - bx - (svcs.length - 1) * 8) / svcs.length, 100, 180) : 0;
        for (const s of svcs) { if (bx + sw <= bandRight + 1) L.svcs.push({ x: bx, y: top, w: sw, h: bh, uid: s.metadata.uid, obj: s }); bx += sw + 8; }
        L.svcOverflow = svcs.length - L.svcs.length;
        top += bh + 16;
      }
      const pvH = pvs.length ? 42 : 0;
      const nh = y + h - top - (pvH ? pvH + 10 : 0);
      const gap = 12;
      if (!L.narrow) {
        const cw = (w - gap * (workers.length - 1)) / Math.max(1, workers.length);
        workers.forEach((n, i) => L.nodes.push({ x: x + i * (cw + gap), y: top, w: cw, h: Math.max(70, nh), name: n.metadata.name, obj: n }));
      } else {
        const cols = 2, rowsN = Math.ceil(workers.length / cols);
        const cw = (w - gap) / cols, ch = Math.max(90, (nh - gap * (rowsN - 1)) / rowsN);
        workers.forEach((n, i) => L.nodes.push({ x: x + (i % cols) * (cw + gap), y: top + Math.floor(i / cols) * (ch + gap), w: cw, h: ch, name: n.metadata.name, obj: n }));
      }
      for (const n of L.nodes) {
        const list = (byNode[n.name] || []).sort((a, b) => Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp) || a.metadata.name.localeCompare(b.metadata.name));
        n.count = list.length;
        const headH = 34, footH = 20;
        const bx = n.x + 8, by = n.y + headH, bw = n.w - 16, bh = n.h - headH - footH;
        const cols = bw >= 300 ? 2 : 1, g = 6;
        const tw = (bw - (cols - 1) * g) / cols;
        let th = 36;
        while (th > 22 && Math.ceil(list.length / cols) * (th + g) - g > bh) th -= 2;
        const cap = cols * Math.max(1, Math.floor((bh + g) / (th + g)));
        n.overflow = Math.max(0, list.length - cap);
        list.slice(0, cap).forEach((p, i) => L.pods.push({ p, r: { x: bx + (i % cols) * (tw + g), y: by + Math.floor(i / cols) * (th + g), w: tw, h: th } }));
      }
      if (pvH) {
        const py = y + h - pvH;
        const pw = Math.min(120, w / Math.max(1, pvs.length) - 8);
        pvs.forEach((pv, i) => L.pvs.push({ x: x + i * (pw + 8), y: py, w: pw, h: pvH, obj: pv }));
      }
    }

    // ------------------------------------------------------------------ drawing
    frame() {
      const ctx = this.ctx;
      if (!this.c) return;
      if (!this.wrap.offsetParent || this.wrap.clientWidth < 60 || this.wrap.clientHeight < 60) {
        // map hidden (another view / pane): the story pauses and plays when the map is shown again
        if (!this.hiddenSince) { this.now(); this.frozen = true; this.hiddenSince = performance.now(); }
        return;
      }
      if (Math.abs(this.wrap.clientWidth - this.W) > 1 || Math.abs(this.wrap.clientHeight - this.H) > 1) this.resize();
      if (this.themeStamp !== document.documentElement.dataset.theme) { this.themeStamp = document.documentElement.dataset.theme; this.readColors(); }
      if (this.hiddenSince) {
        const away = performance.now() - this.hiddenSince;
        this.hiddenSince = 0;
        this.frozen = false; this._vr = performance.now();             // the story simply waited while the map was hidden
        if (away > 20000 && !(this.story && this.story.cmd && this.now() - this.story.at < 20000)) this.skipAll();
      }
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      let L;
      try { L = this.L = this.computeLayout(); } catch (e) { return; }
      this.hits = [];
      const now = this.now();
      this.runDirector(now);
      this.fl = this.focusLevel(now);
      this.drawControlPlane(L, now);
      this.drawEdge(L, now);
      this.drawNodes(L, now);
      this.drawSvcLinks(L);
      this.drawServices(L, now);
      this.drawPVs(L);
      this.drawPods(L, now);
      this.drawArrows(now);
      this.drawMarks(now);
      if (this.selected) this.refreshInspector();
    }
    text(s, x, y, o) {
      const ctx = this.ctx;
      ctx.font = `${o.weight || 500} ${o.size || 12}px ${o.mono ? "'JetBrains Mono', monospace" : 'Inter, system-ui, sans-serif'}`;
      ctx.fillStyle = o.color || this.col.text;
      ctx.textAlign = o.align || 'left';
      ctx.textBaseline = o.base || 'middle';
      let str = String(s);
      if (o.max) { while (str.length > 2 && ctx.measureText(str).width > o.max) str = str.slice(0, -2) + '…'; if (str.length > 2 && str.endsWith('……')) str = str.slice(0, -1); }
      ctx.fillText(str, x, y);
    }
    box(r, fill, stroke, radius, dash, lw) {
      const ctx = this.ctx;
      rr(ctx, r.x, r.y, r.w, r.h, radius == null ? 10 : radius);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.setLineDash(dash || []); ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); ctx.setLineDash([]); }
    }
    // a card that lights up (thicker border + soft glow) when it is part of the current step
    card(r, lit, color, radius, fill) {
      const ctx = this.ctx, col = this.col;
      const on = lit && this.fl > 0;
      ctx.save();
      if (on) { ctx.shadowColor = color; ctx.shadowBlur = 18 * this.fl; }
      this.box(r, fill || (this.light ? '#ffffff' : col.panel), on ? color : col.border2, radius == null ? 10 : radius, null, on ? 2 : 1);
      ctx.restore();
    }
    nodeReady(node) { const rc = (node.status.conditions || []).find(c => c.type === 'Ready'); return rc && rc.status === 'True'; }
    drawControlPlane(L, now) {
      const ctx = this.ctx, col = this.col;
      const cp = L.cp;
      const anyLit = ['api', 'etcd', 'sched', 'cm', 'queue'].some(k => this.isLit(k)) || this.isLit('node:' + L.cpNode);
      ctx.save();
      ctx.globalAlpha = this.alpha(anyLit) * 0.6 + 0.4;
      const g = ctx.createLinearGradient(cp.x, cp.y, cp.x, cp.y + cp.h);
      g.addColorStop(0, this.light ? '#eef3ff' : 'rgba(50,108,229,.14)');
      g.addColorStop(1, this.light ? '#f8faff' : 'rgba(50,108,229,.04)');
      this.box(cp, g, this.light ? '#c6d4f1' : 'rgba(91,147,255,.32)', 14);
      this.text('CONTROL PLANE', cp.x + 12, cp.y + 16, { size: 10.5, weight: 800, color: col.accent });
      if (L.cpObj) {
        const ok = this.nodeReady(L.cpObj);
        ctx.font = '800 10.5px Inter, system-ui, sans-serif';
        const tx = cp.x + 18 + ctx.measureText('CONTROL PLANE').width;
        this.text(`node ${L.cpNode}`, tx, cp.y + 16, { size: 10, color: col.muted, max: cp.w - (tx - cp.x) - 30 });
        ctx.fillStyle = ok ? col.good : col.bad;
        ctx.beginPath(); ctx.arc(cp.x + cp.w - 16, cp.y + 16, 4, 0, Math.PI * 2); ctx.fill();
        this.hits.push({ r: { x: cp.x, y: cp.y, w: cp.w, h: 26 }, kind: 'node', obj: L.cpObj });
      }
      ctx.restore();
      // spokes: everything talks to the API server
      const a = L.comp.api;
      ctx.save();
      ctx.strokeStyle = this.light ? 'rgba(50,108,229,.25)' : 'rgba(120,160,255,.2)';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 1 - 0.6 * this.fl;
      for (const k of ['you', 'cm', 'sched', 'etcd']) {
        const r = L.comp[k];
        const p0 = this.edgePoint(a, center(r)), p1 = this.edgePoint(r, center(a));
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
      ctx.restore();
      for (const k of ['cm', 'sched', 'api', 'etcd']) {
        const r = L.comp[k];
        const lit = this.isLit(k);
        const color = k === 'etcd' ? col.accent2 : k === 'sched' ? col.info : col.accent;
        ctx.save();
        ctx.globalAlpha = this.alpha(lit);
        this.card(r, lit, color, 10);
        const on = lit && this.fl > 0;
        const small = r.h < 40 || r.w < 130;
        this.icon(ICON[k], r.x + 17, r.y + r.h / 2, on ? color : col.muted);
        if (small) this.text(TITLE[k], r.x + 32, r.y + r.h / 2, { weight: 700, size: 12, max: r.w - 38, color: on ? color : col.text });
        else {
          this.text(TITLE[k], r.x + 32, r.y + r.h / 2 - 7, { weight: 700, size: 12.5, max: r.w - 38, color: on ? color : col.text });
          this.text(ROLE[k], r.x + 32, r.y + r.h / 2 + 9, { size: 10, color: col.muted, max: r.w - 38 });
        }
        ctx.restore();
        this.hits.push({ r, kind: 'comp', key: k });
      }
      // Pending tray
      const q = L.queueBox;
      const qLit = this.isLit('queue');
      ctx.save();
      ctx.globalAlpha = this.alpha(qLit);
      const on = qLit && this.fl > 0;
      this.box(q, this.light ? '#fffaf0' : 'rgba(247,178,59,.06)', on ? col.warn : (L.queue.length ? col.warn : col.border2), 9, [5, 4], on ? 2 : 1);
      this.text(L.queue.length ? `Pending Pods · ${L.queue.length}` : 'Pending Pods', q.x + 9, q.y + 11, { size: 10, weight: 700, color: L.queue.length || on ? col.warn : col.muted });
      if (!L.queue.length && !Object.keys(this.flights).length) this.text('new Pods wait here for the scheduler', q.x + 9, q.y + q.h / 2 + 6, { size: 10, color: col.muted, max: q.w - 18 });
      if (L.queueOverflow) this.text(`+${L.queueOverflow}`, q.x + q.w - 8, q.y + 11, { size: 10, color: col.warn, align: 'right' });
      ctx.restore();
    }
    drawEdge(L) {
      const col = this.col, ctx = this.ctx;
      const you = L.comp.you;
      ctx.save();
      ctx.globalAlpha = this.alpha(this.isLit('you'));
      this.card(you, this.isLit('you'), col.accent, 12);
      this.icon('laptop', you.x + you.w / 2, you.y + you.h / 2 - 9, col.text2);
      this.text('You', you.x + you.w / 2, you.y + you.h - 20, { align: 'center', weight: 700, size: 12 });
      if (!L.narrow) this.text('kubectl', you.x + you.w / 2, you.y + you.h - 8, { align: 'center', size: 9.5, color: col.muted, mono: true });
      ctx.restore();
      this.hits.push({ r: you, kind: 'comp', key: 'you' });
      const net = L.comp.net;
      const focusNet = this.focus && this.focus.keys.has('net') && this.fl > 0;
      if (L.showNet || focusNet) {
        ctx.save();
        ctx.globalAlpha = focusNet && !L.showNet ? this.fl : this.alpha(this.isLit('net'));
        this.card(net, this.isLit('net'), col.info, 10);
        this.icon('globe', net.x + 18, net.y + net.h / 2, col.text2);
        this.text(focusNet ? 'Registry / Web' : 'Internet', net.x + 34, net.y + net.h / 2, { weight: 700, size: 11, max: net.w - 38 });
        ctx.restore();
        this.hits.push({ r: net, kind: 'comp', key: 'net' });
      }
    }
    drawNodes(L) {
      const col = this.col, ctx = this.ctx;
      for (const n of L.nodes) {
        const node = n.obj;
        const ready = this.nodeReady(node);
        const cord = !!node.spec.unschedulable;
        const lit = this.isLit('node:' + n.name);
        ctx.save();
        ctx.globalAlpha = this.alpha(lit);
        this.card(n, lit, col.info, 12, ready ? null : (this.light ? '#fff4f4' : 'rgba(255,93,93,.06)'));
        if (!ready) this.box(n, null, col.bad, 12, [5, 4]);
        this.icon('server', n.x + 17, n.y + 17, col.text2);
        let right = n.x + n.w - 10;
        if (!ready || cord) right -= this.pill(right, n.y + 17, ready ? 'Cordoned' : 'NotReady', ready ? col.warn : col.bad, 'right') + 6;
        else { ctx.fillStyle = col.good; ctx.beginPath(); ctx.arc(right - 4, n.y + 17, 4, 0, Math.PI * 2); ctx.fill(); right -= 14; }
        const taints = (node.spec.taints || []).filter(t => t.key !== 'node.kubernetes.io/unschedulable' && t.effect !== 'PreferNoSchedule');
        this.text(n.name + (taints.length ? '  ⛔' : ''), n.x + 31, n.y + 17, { weight: 700, size: 12.5, max: right - n.x - 36 });
        // footer: how full the node is (what the scheduler looks at)
        const alloc = this.c.nodeAllocated(n.name);
        const cpu = Math.round(100 * alloc.cpu / U.parseCpu(node.status.allocatable.cpu)), mem = Math.round(100 * alloc.mem / U.parseMem(node.status.allocatable.memory));
        this.text(`cpu ${cpu}% · mem ${mem}%`, n.x + 12, n.y + n.h - 10, { size: 9.5, color: cpu > 90 || mem > 90 ? col.bad : col.muted, max: n.w - 70 });
        if (n.overflow) this.text(`+${n.overflow} more`, n.x + n.w - 10, n.y + n.h - 10, { size: 9.5, color: col.muted, align: 'right' });
        if (!n.count && n.h > 90) this.text(ready ? (cord ? 'cordoned — no new Pods' : 'no Pods') : 'node is down', n.x + n.w / 2, n.y + 34 + (n.h - 54) / 2, { size: 10.5, color: ready ? col.muted : col.bad, align: 'center' });
        ctx.restore();
        this.hits.push({ r: { x: n.x, y: n.y, w: n.w, h: 32 }, kind: 'node', obj: node });
      }
    }
    pill(x, y, txt, color, align) {
      const ctx = this.ctx;
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      const w = ctx.measureText(txt).width + 14;
      const px = align === 'right' ? x - w : x;
      rr(ctx, px, y - 8, w, 16, 8);
      ctx.fillStyle = color + (this.light ? '22' : '26'); ctx.fill();
      this.text(txt, px + w / 2, y, { size: 10, weight: 700, color, align: 'center' });
      return w;
    }
    labelPill(txt, x, y, color, alpha) {
      const ctx = this.ctx;
      ctx.font = '700 10.5px Inter, system-ui, sans-serif';
      const w = ctx.measureText(txt).width + 14, h = 19;
      x = clamp(x, w / 2 + 3, this.W - w / 2 - 3);
      y = clamp(y, h / 2 + 3, this.H - h / 2 - 3);
      ctx.save();
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 1;
      rr(ctx, x - w / 2, y - h / 2, w, h, 9.5); ctx.fillStyle = color; ctx.fill();
      ctx.shadowColor = 'transparent';
      this.text(txt, x, y + 0.5, { size: 10.5, weight: 700, color: '#fff', align: 'center' });
      ctx.restore();
    }
    podState(p) {
      const s = KS.podStatus(p, this.c);
      const st = s.status;
      if (p.metadata.deletionTimestamp) return { cat: 'term', s };
      if (/CrashLoop|Error|OOM|ImagePull|ErrImage|ConfigError|InvalidImage|StartError|Failed|Evicted|ExitCode|NeverPull/.test(st)) return { cat: 'bad', s };
      if (st === 'Completed' || p.status.phase === 'Succeeded') return { cat: 'done', s };
      if (st === 'Running') return { cat: KS.podHelpers.isReady(p) ? 'good' : 'warn', s };
      return { cat: 'pend', s };
    }
    drawPods(L, now) {
      const ctx = this.ctx;
      const col = this.col;
      const seen = new Set();
      const flying = [];
      for (const { p, r, queued } of L.pods) {
        const uid = p.metadata.uid;
        seen.add(uid);
        let a = this.pos[uid];
        if (!a) a = this.pos[uid] = { x: r.x, y: r.y, w: r.w, h: r.h, born: now, alpha: 0 };
        const f = this.flights[uid];
        if (f && now >= f.start) {
          if (f.sx == null) { f.sx = a.x; f.sy = a.y; f.sw = a.w; f.sh = a.h; delete this.hold[uid]; this.gate[uid] = { stage: 'creating', at: now }; }
          const t = Math.min(1, (now - f.start) / f.dur), e = easeInOut(t);
          const cx = (f.sx + r.x) / 2, cy = Math.min(f.sy, r.y) - 30;
          a.x = (1 - e) * (1 - e) * f.sx + 2 * (1 - e) * e * cx + e * e * r.x;
          a.y = (1 - e) * (1 - e) * f.sy + 2 * (1 - e) * e * cy + e * e * r.y;
          a.w = f.sw + (r.w - f.sw) * e; a.h = f.sh + (r.h - f.sh) * e;
          if (t >= 1) delete this.flights[uid];
          else { a.alpha = 1; flying.push({ p, a, uid }); continue; }
        } else if (!f) {
          const k = 0.14;
          a.x += (r.x - a.x) * k; a.y += (r.y - a.y) * k; a.w += (r.w - a.w) * k; a.h += (r.h - a.h) * k;
        }
        a.alpha = Math.min(1, a.alpha + 0.07);
        this.drawPodTile(p, a, uid, now, this.podLit(p, queued), false);
      }
      for (const fl of flying) this.drawPodTile(fl.p, fl.a, fl.uid, now, true, true);
      for (const uid of Object.keys(this.pos)) {
        if (seen.has(uid)) continue;
        const a = this.pos[uid];
        if (!a.dying) a.dying = now;
        const t = (now - a.dying) / 900;
        if (t >= 1) { delete this.pos[uid]; continue; }
        ctx.save(); ctx.globalAlpha = (1 - t) * 0.7;
        this.box({ x: a.x + a.w * t * 0.25, y: a.y + a.h * t * 0.25, w: a.w * (1 - t * 0.5), h: a.h * (1 - t * 0.5) }, col.panel2, col.muted, 7, [3, 3]);
        ctx.restore();
      }
    }
    drawPodTile(p, a, uid, now, lit, flying) {
      const ctx = this.ctx;
      const col = this.col;
      let { cat, s } = this.podState(p);
      let status = null;
      if (this.hold[uid] || this.flights[uid]) { cat = cat === 'bad' ? 'bad' : 'pend'; status = this.flights[uid] && this.flights[uid].sx != null ? 'binding to node…' : 'waiting for a node'; }
      else if (this.gate[uid] && (cat === 'good' || cat === 'warn' || cat === 'pend')) {
        if (this.gate[uid].stage === 'creating') { cat = 'pend'; status = 'ContainerCreating'; }
        else if (cat === 'good') { cat = 'warn'; status = 'Running · not ready yet'; }
      }
      let fill, stroke, dash = null, text = col.text;
      if (cat === 'good') { fill = this.light ? '#ebfaf2' : 'rgba(43,213,118,.12)'; stroke = col.good; }
      else if (cat === 'warn') { fill = this.light ? '#fff7e6' : 'rgba(247,178,59,.12)'; stroke = col.warn; }
      else if (cat === 'pend') { fill = this.light ? '#fffaf0' : 'rgba(247,178,59,.07)'; stroke = col.warn; dash = [4, 3]; }
      else if (cat === 'bad') { fill = this.light ? '#ffeeee' : 'rgba(255,93,93,.14)'; stroke = col.bad; }
      else if (cat === 'done') { fill = col.panel2; stroke = col.border2; text = col.muted; }
      else { fill = col.panel2; stroke = col.muted; dash = [3, 3]; text = col.muted; }
      if (flying) fill = this.light ? '#ffffff' : col.panel;
      const fx = this.fx[uid];
      const fxOn = fx && fx.until > now;
      const ox = fxOn && fx.kind === 'crash' ? Math.sin((now - fx.start) / 25) * 3 : 0;
      const pop = a.born ? Math.min(1, (now - a.born) / 380) : 1;
      const sc = 0.6 + 0.4 * ease(pop);
      ctx.save();
      ctx.globalAlpha = a.alpha * this.alpha(lit) * (cat === 'term' ? 0.5 + 0.2 * Math.sin(now / 200) : 1);
      const rect = { x: a.x + ox + a.w * (1 - sc) / 2, y: a.y + a.h * (1 - sc) / 2, w: a.w * sc, h: a.h * sc };
      if (flying) { ctx.shadowColor = col.info; ctx.shadowBlur = 16; }
      else if (fxOn && (fx.kind === 'ready' || fx.kind === 'hit' || fx.kind === 'start')) { ctx.shadowColor = fx.kind === 'hit' ? col.info : col.good; ctx.shadowBlur = 20 * (fx.until - now) / (fx.dur || 900); }
      this.box(rect, fill, stroke, 7, dash, lit && this.fl > 0 && this.focus && this.focus.keys.has('pod:' + uid) ? 2 : 1);
      ctx.shadowBlur = 0;
      const ref = (p.metadata.ownerReferences || []).find(o => o.controller);
      const ownerKey = ref ? (this.c.workloadKeyOf(p) || ref.name) : 'bare:' + p.metadata.name;
      ctx.fillStyle = `hsl(${hue(ownerKey)}, 70%, ${this.light ? 48 : 62}%)`;
      rr(ctx, rect.x, rect.y, 4, rect.h, 2); ctx.fill();
      if (cat === 'pend' && rect.h >= 16) {
        ctx.strokeStyle = col.warn; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(rect.x + 13, rect.y + rect.h / 2, 4.5, now / 160, now / 160 + 4.2); ctx.stroke();
      } else {
        ctx.fillStyle = stroke;
        ctx.beginPath(); ctx.arc(rect.x + 13, rect.y + rect.h / 2, 3.5, 0, Math.PI * 2); ctx.fill();
      }
      if (fxOn && fx.kind === 'pull') status = 'pulling image…';
      const small = rect.h < 28 || rect.w < 74;
      const name = this.shortName(p.metadata.name, rect.w - 30);
      if (small) this.text(name, rect.x + 22, rect.y + rect.h / 2, { size: 9.5, weight: 600, color: text, max: rect.w - 26, mono: true });
      else {
        this.text(name, rect.x + 22, rect.y + rect.h / 2 - 7, { size: 10.5, weight: 600, color: text, max: rect.w - 28, mono: true });
        const rs = s.restarts !== '0' ? ` · ↻${s.restarts.split(' ')[0]}` : '';
        const line = status || ((cat === 'good' ? `${s.ready} ready` : s.status) + rs + (p.metadata.namespace !== 'default' ? ` · ${p.metadata.namespace}` : ''));
        this.text(line, rect.x + 22, rect.y + rect.h / 2 + 8, { size: 9.5, color: status ? (fxOn && fx.kind === 'pull' ? col.info : col.warn) : cat === 'bad' ? col.bad : cat === 'good' ? col.good : col.muted, max: rect.w - 28 });
      }
      if (fxOn && fx.kind === 'pull') {
        const t = Math.min(1, (now - fx.start) / (fx.dur || 1400));
        rr(ctx, rect.x + 6, rect.y + rect.h - 4, rect.w - 10, 2.5, 1.2); ctx.fillStyle = col.panel3; ctx.fill();
        rr(ctx, rect.x + 6, rect.y + rect.h - 4, Math.max(2, (rect.w - 10) * ease(t)), 2.5, 1.2); ctx.fillStyle = col.info; ctx.fill();
      }
      ctx.restore();
      if (this.selected && this.selected.kind === 'pod' && this.selected.uid === uid) { ctx.strokeStyle = col.accent; ctx.lineWidth = 2; rr(ctx, rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4, 9); ctx.stroke(); }
      this.hits.push({ r: rect, kind: 'pod', obj: p });
    }
    shortName(n, maxw) {
      const ctx = this.ctx;
      ctx.font = "600 10px 'JetBrains Mono', monospace";
      if (ctx.measureText(n).width <= maxw) return n;
      const m = n.match(/^(.*)-([a-z0-9]{5})$/);
      if (m) {
        let pre = m[1];
        while (pre.length > 1 && ctx.measureText(pre + '…' + m[2]).width > maxw) pre = pre.slice(0, -1);
        return pre + '…' + m[2];
      }
      return n;
    }
    drawServices(L) {
      const col = this.col, ctx = this.ctx;
      if (L.ingress) {
        const r = L.ingress;
        ctx.save(); ctx.globalAlpha = this.alpha(this.isLit('ingress'));
        this.card(r, this.isLit('ingress'), col.accent2, 17, this.light ? '#f3efff' : 'rgba(139,108,255,.14)');
        this.text('⇄ Ingress', r.x + r.w / 2, r.y + r.h / 2, { size: 11, weight: 700, color: col.accent2, align: 'center', max: r.w - 8 });
        ctx.restore();
        this.hits.push({ r, kind: 'ingress' });
      }
      for (const s of L.svcs) {
        const svc = s.obj;
        const type = svc.spec.type;
        const headless = svc.spec.clusterIP === 'None';
        const c = type === 'NodePort' ? col.accent2 : type === 'LoadBalancer' ? col.info : type === 'ExternalName' ? col.muted : col.accent;
        const lit = this.isLit('svc:' + s.uid);
        ctx.save(); ctx.globalAlpha = this.alpha(lit);
        this.card(s, lit, c, 17);
        if (headless) this.box(s, null, c, 17, [4, 3]);
        const ep = this.c.get('Endpoints', svc.metadata.namespace, svc.metadata.name);
        const n = ((ep && ep.subsets) || []).reduce((acc, x) => acc + (x.addresses || []).length, 0);
        this.text(svc.metadata.name, s.x + 13, s.y + s.h / 2 - 6, { size: 11, weight: 700, max: s.w - 44 });
        const port = svc.spec.ports && svc.spec.ports[0];
        this.text(`${headless ? 'Headless' : type}${port ? ' :' + port.port : ''}${port && port.nodePort ? ' → ' + port.nodePort : ''}`, s.x + 13, s.y + s.h / 2 + 7, { size: 9, color: col.muted, max: s.w - 44 });
        this.pill(s.x + s.w - 7, s.y + s.h / 2, String(n), n ? col.good : (type === 'ExternalName' ? col.muted : col.bad), 'right');
        ctx.restore();
        this.hits.push({ r: s, kind: 'svc', obj: svc });
      }
      if (L.svcOverflow > 0 && L.svcs.length) { const s = L.svcs[L.svcs.length - 1]; this.text(`+${L.svcOverflow}`, s.x + s.w + 6, s.y + s.h / 2, { size: 10, color: col.muted }); }
    }
    // Service → Pod wiring: faint all the time, clear when hovered or part of the current step
    drawSvcLinks(L) {
      const ctx = this.ctx, col = this.col;
      for (const s of L.svcs) {
        const svc = s.obj;
        const ep = this.c.get('Endpoints', svc.metadata.namespace, svc.metadata.name);
        if (!ep) continue;
        const hov = (this.hover && this.hover.kind === 'svc' && this.hover.obj === svc) || (this.selected && this.selected.kind === 'svc' && this.selected.uid === s.uid);
        const svcLit = this.isLit('svc:' + s.uid);
        for (const sub of ep.subsets || []) {
          for (const [list, ready] of [[sub.addresses || [], true], [sub.notReadyAddresses || [], false]]) {
            for (const ad of list) {
              const r = this.pos[ad.targetRef.uid];
              if (!r || this.hold[ad.targetRef.uid]) continue;
              const strong = hov || (svcLit && this.fl > 0 && this.focus.keys.has('svc:' + s.uid));
              const x1 = s.x + s.w / 2, y1 = s.y + s.h, x2 = r.x + r.w / 2, y2 = r.y;
              ctx.save();
              ctx.globalAlpha = strong ? 0.9 : (this.light ? 0.28 : 0.22) * (1 - 0.7 * this.fl);
              ctx.beginPath(); ctx.moveTo(x1, y1); ctx.bezierCurveTo(x1, y1 + 30, x2, y2 - 36, x2, y2);
              ctx.strokeStyle = ready ? col.accent : col.muted; ctx.lineWidth = strong ? 1.8 : 1;
              ctx.setLineDash(ready ? [] : [3, 4]); ctx.stroke();
              ctx.restore();
            }
          }
        }
      }
    }
    drawPVs(L) {
      const col = this.col, ctx = this.ctx;
      for (const pv of L.pvs) {
        const o = pv.obj;
        const c = o.status.phase === 'Bound' ? col.accent2 : col.muted;
        const x = pv.x, y = pv.y + 4, w = pv.w, h = pv.h - 8;
        if (w < 8) continue;
        ctx.save(); ctx.globalAlpha = 1 - 0.7 * this.fl;
        ctx.fillStyle = this.light ? '#f4f0ff' : 'rgba(139,108,255,.12)';
        ctx.strokeStyle = c; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(x + w / 2, y + 4, w / 2, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + h - 4); ctx.ellipse(x + w / 2, y + h - 4, w / 2, 4, 0, Math.PI, 0, true); ctx.lineTo(x + w, y + 4); ctx.fill(); ctx.stroke();
        this.text(o.spec.claimRef ? o.spec.claimRef.name : '(available)', x + w / 2, y + h / 2 + 1, { size: 9.5, weight: 600, align: 'center', max: w - 8, color: col.text2 });
        this.text(`${o.spec.capacity.storage} · ${o.status.phase}`, x + w / 2, y + h - 2, { size: 8.5, align: 'center', max: w - 6, color: col.muted });
        ctx.restore();
        this.hits.push({ r: pv, kind: 'pv', obj: o });
      }
    }
    drawArrows(now) {
      const ctx = this.ctx;
      const labels = [];
      for (const a of this.arrows) {
        const t = (now - a.start) / a.dur;
        if (t < 0) continue;
        const g = this.arrowGeom(a);
        if (!g) { if (t >= 1 && !a.fired) { a.fired = true; if (a.done) try { a.done(); } catch (e) { /* ignore */ } } continue; }
        const p = easeInOut(Math.min(1, t));
        if (t >= 1 && !a.fired) { a.fired = true; this.rings.push({ x: g.p1.x, y: g.p1.y, color: a.color, start: now }); if (a.done) try { a.done(); } catch (e) { /* ignore */ } }
        const fade = a.endAt ? clamp(1 - (now - a.endAt) / 400, 0, 1) : 1;
        if (fade <= 0) continue;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.strokeStyle = a.color; ctx.fillStyle = a.color;
        ctx.lineWidth = 2.6; ctx.lineCap = 'round';
        if (a.dashed) ctx.setLineDash([7, 5]);
        ctx.beginPath();
        const N = 30;
        for (let i = 0; i <= N; i++) { const q = this.quad(g, p * i / N); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }
        ctx.stroke();
        ctx.setLineDash([]);
        const tip = this.quad(g, p), back = this.quad(g, Math.max(0, p - Math.min(0.2, 10 / g.len)));
        const ang = Math.atan2(tip.y - back.y, tip.x - back.x);
        const hs = 11;
        ctx.beginPath(); ctx.moveTo(tip.x + Math.cos(ang) * 2, tip.y + Math.sin(ang) * 2);
        ctx.lineTo(tip.x - hs * Math.cos(ang - 0.42), tip.y - hs * Math.sin(ang - 0.42));
        ctx.lineTo(tip.x - hs * Math.cos(ang + 0.42), tip.y - hs * Math.sin(ang + 0.42));
        ctx.closePath(); ctx.fill();
        if (t < 1) { ctx.shadowColor = a.color; ctx.shadowBlur = 14; ctx.beginPath(); ctx.arc(tip.x, tip.y, 3, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
        if (a.label && p > 0.3) {
          const m = this.quad(g, 0.5);
          const vertical = Math.abs(g.p1.y - g.p0.y) > Math.abs(g.p1.x - g.p0.x);
          ctx.font = '700 10.5px Inter, system-ui, sans-serif';
          const w = ctx.measureText(a.label).width + 14;
          labels.push([a.label, vertical ? m.x + w / 2 + 8 : m.x, vertical ? m.y : m.y - 14, a.color, fade * clamp((p - 0.3) / 0.25, 0, 1)]);
        }
      }
      for (const l of labels) this.labelPill(...l);
      this.rings = this.rings.filter(r => now - r.start < 600);
      for (const r of this.rings) {
        const t = (now - r.start) / 600;
        ctx.save(); ctx.globalAlpha = 0.7 * (1 - t); ctx.strokeStyle = r.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(r.x, r.y, 4 + 16 * ease(t), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
    }
    drawMarks(now) {
      this.marks = this.marks.filter(m => m.until >= now);
      for (const m of this.marks) {
        const t = (now - m.start) / (m.until - m.start);
        if (t < 0) continue;
        this.labelPill(m.text, m.x, m.y, m.color, Math.min(1, t * 6) * (t > 0.8 ? (1 - t) * 5 : 1));
      }
    }
    icon(kind, x, y, color) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      switch (kind) {
        case 'laptop': rr(ctx, x - 13, y - 9, 26, 16, 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - 17, y + 10); ctx.lineTo(x + 17, y + 10); ctx.stroke(); break;
        case 'globe': ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.ellipse(x, y, 5, 12, 0, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.stroke(); break;
        case 'db': ctx.ellipse(x, y - 6, 7, 3, 0, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - 7, y - 6); ctx.lineTo(x - 7, y + 6); ctx.ellipse(x, y + 6, 7, 3, 0, Math.PI, 0, true); ctx.lineTo(x + 7, y - 6); ctx.stroke(); break;
        case 'door': rr(ctx, x - 6, y - 8, 12, 16, 2); ctx.stroke(); ctx.beginPath(); ctx.arc(x + 3, y, 1.3, 0, Math.PI * 2); ctx.fill(); break;
        case 'target': ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke(); break;
        case 'loop': ctx.arc(x, y, 7, 0.3, Math.PI * 1.75); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x + 7, y - 1); ctx.lineTo(x + 2, y - 2); ctx.stroke(); break;
        case 'server': rr(ctx, x - 7, y - 7, 14, 6, 1.5); ctx.stroke(); ctx.beginPath(); rr(ctx, x - 7, y + 1, 14, 6, 1.5); ctx.stroke(); break;
        case 'crown': ctx.moveTo(x - 7, y + 5); ctx.lineTo(x - 7, y - 4); ctx.lineTo(x - 3, y); ctx.lineTo(x, y - 6); ctx.lineTo(x + 3, y); ctx.lineTo(x + 7, y - 4); ctx.lineTo(x + 7, y + 5); ctx.closePath(); ctx.stroke(); break;
      }
      ctx.restore();
    }

    // ------------------------------------------------------------------ flow bar (step-by-step captions)

    // ------------------------------------------------------------------ caption bar: "Step 3 of 8 · what is happening"
    buildFlow() {
      const f = this.flow;
      if (!f) return;
      f.innerHTML = `<div class="fb-cap"><span class="fb-step"></span><div class="fb-body"><b class="fb-title"></b><span class="fb-txt"></span></div></div>
        <div class="fb-row"><span class="fb-cmd"></span><span class="fb-dots"></span>
        <span class="fb-ctl"><button class="fb-skip" title="Jump to the end of the animation">Skip ⏭</button></span></div>`;
      this.fEl = { cap: f.querySelector('.fb-cap'), step: f.querySelector('.fb-step'), title: f.querySelector('.fb-title'), txt: f.querySelector('.fb-txt'), cmd: f.querySelector('.fb-cmd'), dots: f.querySelector('.fb-dots') };
      f.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.classList.contains('fb-skip')) this.skipAll();
        else if (b.dataset.n && this.story) { const st = this.story.steps.find(x => String(x.n) === b.dataset.n); if (st) { this.pinned = this.pinned === st ? null : st; this.renderFlow(); } }
      });
    }
    // ------------------------------------------------------------------ toolbar: ⏸ 🐢 ━━●━━ 🐇 1×
    buildSpeed() {
      const el = this.speedEl;
      if (!el) return;
      el.innerHTML = `<button class="fs-play" title="Pause the animation (Space)" aria-label="Pause animation"></button>
        <span class="fs-slide"><span class="fs-ic" aria-hidden="true">🐢</span><input type="range" class="fs-range" min="${SPEED_MIN}" max="${SPEED_MAX}" step="0.05" list="fs-ticks" aria-label="Animation speed"><span class="fs-ic" aria-hidden="true">🐇</span>
        <datalist id="fs-ticks">${SNAPS.map(v => `<option value="${v}"></option>`).join('')}</datalist></span>
        <button class="fs-val" title="Animation speed · click to reset to 1×"></button>`;
      const range = el.querySelector('.fs-range'), val = el.querySelector('.fs-val');
      range.addEventListener('input', () => this.setSpeed(range.value));
      range.addEventListener('change', () => { range.value = this.speed; });
      range.addEventListener('dblclick', () => this.setSpeed(1));
      el.querySelector('.fs-play').addEventListener('click', () => this.setPaused(!this.paused));
      val.addEventListener('click', e => {
        e.stopPropagation();
        if (window.matchMedia('(max-width: 640px)').matches) el.classList.toggle('open');   // phones: the slider is a pop-up
        else this.setSpeed(1);
      });
      document.addEventListener('click', e => { if (el.classList.contains('open') && !e.target.closest('.flow-speed')) el.classList.remove('open'); });
      // YouTube-style keys while the map has focus: Space = pause, Shift+< / Shift+> = slower / faster
      this.wrap.tabIndex = 0;
      this.wrap.addEventListener('keydown', e => {
        if (e.target.closest('input, select, textarea, button')) return;
        if (e.key === ' ') { e.preventDefault(); this.setPaused(!this.paused); }
        else if (e.key === '<') { e.preventDefault(); this.setSpeed(this.speed - 0.25); }
        else if (e.key === '>') { e.preventDefault(); this.setSpeed(this.speed + 0.25); }
      });
      this.wrap.addEventListener('mousedown', () => { if (document.activeElement !== this.wrap) this.wrap.focus({ preventScroll: true }); });
      this.renderSpeed();
    }
    renderSpeed() {
      const el = this.speedEl, v = this.speed;
      if (this.wrap) this.wrap.classList.toggle('paused', this.paused);
      if (!el) return;
      const play = el.querySelector('.fs-play'), r = el.querySelector('.fs-range');
      play.innerHTML = this.paused
        ? '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><rect x="2.2" y="1.5" width="2.6" height="9" rx=".8" fill="currentColor"/><rect x="7.2" y="1.5" width="2.6" height="9" rx=".8" fill="currentColor"/></svg>';
      play.classList.toggle('on', this.paused);
      play.title = this.paused ? 'Play the animation (Space)' : 'Pause the animation (Space)';
      play.setAttribute('aria-label', this.paused ? 'Play animation' : 'Pause animation');
      el.querySelector('.fs-val').textContent = fmtSpeed(v);
      el.classList.toggle('changed', v !== 1);
      if (document.activeElement !== r) r.value = v;
      r.style.setProperty('--p', ((v - SPEED_MIN) / (SPEED_MAX - SPEED_MIN) * 100) + '%');
      r.setAttribute('aria-valuetext', fmtSpeed(v));
    }
    renderFlow() {
      const f = this.flow, E = this.fEl;
      if (!f || !E) return;
      this.renderSpeed();
      f.classList.toggle('busy', !!(this.cur || this.q.length));
      const s = this.story;
      const show = (cls, step, title, txt) => { E.cap.className = 'fb-cap ' + (cls || ''); E.step.textContent = step; E.title.textContent = title; E.txt.textContent = txt; };
      if (!s) {
        E.cmd.textContent = ''; E.dots.innerHTML = '';
        show('idle', '▶', 'Run a command', 'Each thing the cluster does will play here, one step at a time — the parts involved light up and an arrow shows who talks to whom.');
        return;
      }
      E.cmd.textContent = s.cmd ? '$ ' + s.title : s.title;
      E.cmd.title = E.cmd.textContent;
      E.dots.innerHTML = s.steps.slice(-30).map(st => `<button data-n="${st.n}" class="${st.state}${st.tone ? ' ' + st.tone : ''}${this.pinned === st ? ' pinned' : ''}" title="${st.n}. ${esc(st.short)}" aria-label="Step ${st.n}: ${esc(st.short)}"></button>`).join('');
      const total = s.steps.length ? s.steps[s.steps.length - 1].n : 0;
      const cur = this.pinned || (this.cur && this.cur.step.story === s ? this.cur.step : null);
      if (cur) show((cur.tone || '') + (this.pinned ? ' pinned' : ''), `${cur.n}/${total}`, cur.short, cur.text);
      else if (s.noop) show('idle', '💻', 'Only on your laptop', 'This command did not talk to the cluster, so nothing happens on the map.');
      else if (s.steps.length && s.steps.every(x => x.state === 'done')) {
        const bad = s.steps.some(x => x.tone === 'bad');
        show(bad ? 'bad done' : 'good done', bad ? '!' : '✓', bad ? `Finished with a problem (${total} steps)` : `Done in ${total} steps`, bad ? s.steps.filter(x => x.tone === 'bad').pop().text : 'Click a dot below to replay the explanation of any step.');
      } else if (s.steps.length) show('', '…', 'Next step', '');
      else show('idle', '…', 'Waiting for the cluster…', '');
    }

    // ------------------------------------------------------------------ interaction
    bindMouse() {
      const pt = e => { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      const hit = p => { for (let i = this.hits.length - 1; i >= 0; i--) { const h = this.hits[i]; if (p.x >= h.r.x && p.x <= h.r.x + h.r.w && p.y >= h.r.y && p.y <= h.r.y + h.r.h) return h; } return null; };
      this.cv.addEventListener('mousemove', e => {
        const p = pt(e);
        const h = hit(p);
        this.hover = h;
        this.cv.style.cursor = h ? 'pointer' : 'default';
        const tip = this.opts.tooltip;
        if (!h) { tip.hidden = true; return; }
        tip.innerHTML = this.tipHtml(h);
        tip.hidden = false;
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        tip.style.left = Math.min(this.W - tw - 6, p.x + 14) + 'px';
        tip.style.top = Math.min(this.H - th - 6, p.y + 14) + 'px';
      });
      this.cv.addEventListener('mouseleave', () => { this.hover = null; this.opts.tooltip.hidden = true; });
      this.cv.addEventListener('click', e => {
        const h = hit(pt(e));
        this.opts.tooltip.hidden = true;
        if (!h) { this.selected = null; this.opts.inspector.hidden = true; return; }
        this.selected = { kind: h.kind, key: h.key, uid: h.obj && h.obj.metadata.uid, obj: h.obj };
        this.refreshInspector(true);
      });
    }
    tipHtml(h) {
      const c = this.c;
      if (h.kind === 'pod') { const p = h.obj; const s = KS.podStatus(p, c); return `<b>${esc(p.metadata.name)}</b><br><span class="muted">${esc(p.metadata.namespace)} · ${esc(s.status)} · ${esc(s.ready)} · restarts ${esc(s.restarts)}</span><br><span class="muted">${esc(p.status.podIP || 'no IP yet')} · ${esc(p.spec.nodeName || 'not scheduled')}</span>`; }
      if (h.kind === 'node') { const n = h.obj; return `<b>${esc(n.metadata.name)}</b><br><span class="muted">${esc(n.status.addresses[0].address)} · ${esc(n.metadata.labels['topology.kubernetes.io/zone'] || '')}</span><br>Click for details`; }
      if (h.kind === 'svc') { const s = h.obj; return `<b>Service ${esc(s.metadata.name)}</b><br><span class="muted">${esc(s.spec.type)} · ${esc(s.spec.clusterIP || '')}</span><br><span class="muted">selector: ${esc(s.spec.selector ? Object.entries(s.spec.selector).map(([k, v]) => k + '=' + v).join(',') : '<none>')}</span>`; }
      if (h.kind === 'comp') { const i = COMPONENT_INFO[h.key]; return `<b>${esc(i.name)}</b><br><span class="muted">Click to learn what it does</span>`; }
      if (h.kind === 'pv') return `<b>PersistentVolume</b><br><span class="muted">${esc(h.obj.metadata.name.slice(0, 24))}…</span>`;
      if (h.kind === 'ingress') return '<b>Ingress controller</b><br><span class="muted">ingress-nginx routes HTTP by host/path</span>';
      return '';
    }
    refreshInspector(force) {
      const sel = this.selected;
      if (!sel) return;
      const now = performance.now();
      if (!force && now - (this.inspAt || 0) < 500) return;
      this.inspAt = now;
      const el = this.opts.inspector;
      const c = this.c;
      const btn = cmd => `<button data-cmd="${esc(cmd)}" title="Paste into terminal">${esc(cmd)}</button>`;
      const kv = rows => `<div class="kv">${rows.map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join('')}</div>`;
      let html = '<button class="icon-btn small close" data-close="1" aria-label="Close">✕</button>';
      if (sel.kind === 'pod') {
        const p = c.list('Pod').find(x => x.metadata.uid === sel.uid);
        if (!p) { html += '<h4>Pod deleted</h4><p class="muted">This Pod no longer exists.</p>'; el.innerHTML = html; el.hidden = false; return; }
        const s = KS.podStatus(p, c);
        const { cat } = this.podState(p);
        const ref = (p.metadata.ownerReferences || []).find(o => o.controller);
        const nsf = p.metadata.namespace === 'default' ? '' : ` -n ${p.metadata.namespace}`;
        html += `<h4>${esc(p.metadata.name)}</h4><span class="badge ${cat === 'good' ? 'good' : cat === 'bad' ? 'bad' : cat === 'done' ? 'info' : 'warn'}">${esc(s.status)}</span>`;
        html += kv([['Namespace', esc(p.metadata.namespace)], ['Node', esc(p.spec.nodeName || '— (Pending)')], ['Pod IP', esc(p.status.podIP || '—')], ['Ready', esc(s.ready)], ['Restarts', esc(s.restarts)], ['Owner', ref ? esc(ref.kind + '/' + ref.name) : 'none (bare Pod)'], ['Age', esc(c.age(p))], ['Containers', p.spec.containers.map(x => esc(x.name + ' — ' + x.image)).join('<br>')], ['Labels', esc(U.labelsToString(p.metadata.labels))]]);
        const cs = (p.status.containerStatuses || []).find(x => x.state.waiting && x.state.waiting.message);
        if (cs) html += `<div class="desc">⚠️ ${esc(cs.state.waiting.message.slice(0, 220))}</div>`;
        html += `<div class="actions">${btn(`kubectl describe pod ${p.metadata.name}${nsf}`)}${btn(`kubectl logs ${p.metadata.name}${nsf}`)}${btn(`kubectl exec -it ${p.metadata.name}${nsf} -- sh`)}${btn(`kubectl delete pod ${p.metadata.name}${nsf}`)}</div>`;
      } else if (sel.kind === 'node') {
        const n = c.get('Node', '', sel.obj.metadata.name);
        const rc = (n.status.conditions || []).find(x => x.type === 'Ready');
        const al = c.nodeAllocated(n.metadata.name);
        html += `<h4>${esc(n.metadata.name)}</h4><span class="badge ${rc && rc.status === 'True' ? 'good' : 'bad'}">${rc && rc.status === 'True' ? 'Ready' : 'NotReady'}</span> ${n.spec.unschedulable ? '<span class="badge warn">SchedulingDisabled</span>' : ''}`;
        html += kv([['Role', n.metadata.labels['node-role.kubernetes.io/control-plane'] != null ? 'control-plane' : 'worker'], ['IP', esc(c.nodeIP(n.metadata.name))], ['Zone', esc(n.metadata.labels['topology.kubernetes.io/zone'] || '')], ['CPU req.', `${U.fmtCpu(al.cpu || 0)} / ${n.status.allocatable.cpu}`], ['Memory req.', `${al.mem ? U.fmtMem(al.mem) : '0'} / ${n.status.allocatable.memory}`], ['Pods', String(al.pods)], ['Taints', (n.spec.taints || []).map(t => esc(`${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`)).join('<br>') || 'none'], ['Runtime', esc(n.status.nodeInfo.containerRuntimeVersion)]]);
        html += `<div class="desc">The kubelet on this node runs the containers of the Pods the scheduler assigned here; kube-proxy programs Service routing.</div>`;
        html += `<div class="actions">${btn(`kubectl describe node ${n.metadata.name}`)}${btn(`kubectl ${n.spec.unschedulable ? 'uncordon' : 'cordon'} ${n.metadata.name}`)}${btn(`kubectl drain ${n.metadata.name} --ignore-daemonsets`)}${btn(`sim node ${c.rt.nodes[n.metadata.name].up ? 'down' : 'up'} ${n.metadata.name}`)}</div>`;
      } else if (sel.kind === 'svc') {
        const s = c.list('Service').find(x => x.metadata.uid === sel.uid);
        if (!s) { this.selected = null; el.hidden = true; return; }
        const ep = c.get('Endpoints', s.metadata.namespace, s.metadata.name);
        const addrs = ((ep && ep.subsets) || []).flatMap(x => (x.addresses || []).map(a => `${a.ip} (${a.targetRef.name})`));
        const nsf = s.metadata.namespace === 'default' ? '' : ` -n ${s.metadata.namespace}`;
        html += `<h4>Service ${esc(s.metadata.name)}</h4><span class="badge info">${esc(s.spec.type)}</span>`;
        html += kv([['ClusterIP', esc(s.spec.clusterIP || '—')], ['Ports', esc((s.spec.ports || []).map(p => `${p.port}→${p.targetPort}${p.nodePort ? ' (node ' + p.nodePort + ')' : ''}`).join(', '))], ['Selector', esc(s.spec.selector ? Object.entries(s.spec.selector).map(([k, v]) => k + '=' + v).join(',') : '<none>')], ['DNS', esc(`${s.metadata.name}.${s.metadata.namespace}.svc.cluster.local`)], ['Endpoints', addrs.length ? addrs.map(esc).join('<br>') : '<span style="color:var(--bad)">none — no ready Pods match the selector</span>']]);
        html += `<div class="actions">${btn(`kubectl describe svc ${s.metadata.name}${nsf}`)}${btn(`kubectl get endpoints ${s.metadata.name}${nsf}`)}${btn(`kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- curl -s ${s.metadata.name}.${s.metadata.namespace}`)}</div>`;
      } else if (sel.kind === 'comp') {
        const i = COMPONENT_INFO[sel.key];
        html += `<h4>${esc(i.name)}</h4><div class="desc">${esc(i.text)}</div>`;
        const cmds = { api: ['kubectl get --help', 'kubectl api-resources', 'kubectl get pods -n kube-system -l component=kube-apiserver'], etcd: ['kubectl get pods -n kube-system -l component=etcd', 'kubectl describe pod etcd-controlplane -n kube-system'], sched: ['kubectl get events --field-selector reason=Scheduled', 'kubectl get pods -n kube-system -l component=kube-scheduler'], cm: ['kubectl get events --sort-by=.lastTimestamp', 'kubectl get rs'], you: ['kubectl config view', 'kubectl version'], net: ['kubectl get svc -A', 'kubectl get ingress -A'] }[sel.key] || [];
        html += `<div class="actions">${cmds.map(btn).join('')}<button data-q="${i.q}">📖 Handbook Q${i.q}</button></div>`;
      } else if (sel.kind === 'pv') {
        const o = c.get('PersistentVolume', '', sel.obj.metadata.name);
        if (!o) { this.selected = null; el.hidden = true; return; }
        html += `<h4>PersistentVolume</h4><span class="badge info">${esc(o.status.phase)}</span>`;
        html += kv([['Name', esc(o.metadata.name)], ['Capacity', esc(o.spec.capacity.storage)], ['Claim', esc(o.spec.claimRef ? o.spec.claimRef.namespace + '/' + o.spec.claimRef.name : '—')], ['Class', esc(o.spec.storageClassName || '')], ['Reclaim', esc(o.spec.persistentVolumeReclaimPolicy)]]);
        html += `<div class="actions">${btn('kubectl get pv,pvc -A')}${btn(`kubectl describe pv ${o.metadata.name}`)}</div>`;
      } else if (sel.kind === 'ingress') {
        html += '<h4>Ingress controller (ingress-nginx)</h4><div class="desc">A reverse proxy running as Pods in the ingress-nginx namespace. It watches Ingress objects and routes HTTP requests by host and path to Services.</div>';
        html += `<div class="actions">${btn('kubectl get ingress -A')}${btn('kubectl get pods,svc -n ingress-nginx')}<button data-q="19">📖 Handbook Q19</button></div>`;
      }
      el.innerHTML = html;
      el.hidden = false;
      el.onclick = e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.close) { this.selected = null; el.hidden = true; return; }
        if (b.dataset.cmd) this.opts.onCommand(b.dataset.cmd);
        if (b.dataset.q) this.opts.onHandbook(+b.dataset.q);
      };
    }
  }

  KS.ClusterViz = ClusterViz;
})(typeof window !== 'undefined' ? window : globalThis);
