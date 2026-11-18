/* Kubester — animated cluster map (canvas 2D). Reads cluster state every frame; animates events. */
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
    net: { name: 'The Internet', q: 19, text: 'External traffic enters through NodePorts, cloud LoadBalancers, or an Ingress controller.' },
  };

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

  class ClusterViz {
    constructor(canvas, wrap, opts) {
      this.cv = canvas;
      this.wrap = wrap;
      this.ctx = canvas.getContext('2d');
      this.opts = opts;
      this.pos = {};          // uid -> animated rect
      this.particles = [];
      this.marks = [];        // floating text / crosses
      this.glow = {};         // component -> until
      this.fx = {};           // pod uid -> {kind, until}
      this.hits = [];
      this.hover = null;
      this.selected = null;
      this.lastApi = {};
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
      this.particles = [];
      this.marks = [];
      this.fx = {};
      this.selected = null;
      this.opts.inspector.hidden = true;
      this.unsub = [
        cluster.on('api', e => this.onApi(e)),
        cluster.on('schedule', e => this.onSchedule(e)),
        cluster.on('kubelet', e => this.onKubelet(e)),
        cluster.on('traffic', e => this.onTraffic(e)),
        cluster.on('pod-hit', e => this.addFx(e.uid, 'hit', 500)),
        cluster.on('controller', () => this.pulse('cm')),
      ];
    }

    // ------------------------------------------------------------------ events → animations
    pulse(k, ms) { this.glow[k] = performance.now() + (ms || 700); }
    addFx(uid, kind, ms) { this.fx[uid] = { kind, until: performance.now() + ms, start: performance.now() }; }
    onApi(e) {
      if (!this.L || e.kind === 'Event') return;
      const now = performance.now();
      const key = (e.internal ? 'i' : 'u') + e.verb + e.kind;
      if (now - (this.lastApi[key] || 0) < (e.internal ? 400 : 120)) return;
      this.lastApi[key] = now;
      const L = this.L;
      const from = e.internal ? L.comp.cm : L.comp.you;
      const color = e.verb === 'delete' ? this.col.bad : e.verb === 'get' ? this.col.info : this.col.accent;
      this.particle([this.anchor(from, 'c'), this.anchor(L.comp.api, 'c')], color, e.internal ? 3 : 5, () => {
        this.pulse('api');
        if (e.verb !== 'get') this.particle([this.anchor(L.comp.api, 'c'), this.anchor(L.comp.etcd, 'c')], this.col.accent2, 4, () => this.pulse('etcd'));
        else this.particle([this.anchor(L.comp.api, 'c'), this.anchor(L.comp.etcd, 'c'), this.anchor(L.comp.api, 'c'), this.anchor(from, 'c')], this.col.info, 3);
      }, e.internal ? 1.3 : 1);
      if (!e.internal) this.pulse('you', 400);
    }
    onSchedule(e) {
      if (!this.L) return;
      this.pulse('sched', 900);
      const n = this.L.nodes.find(x => x.name === e.node);
      if (n) this.particle([this.anchor(this.L.comp.sched, 'c'), { x: n.x + n.w / 2, y: n.y + 8 }], this.col.info, 4);
    }
    onKubelet(e) {
      const now = performance.now();
      if (e.action === 'pull') this.addFx(e.pod, 'pull', 1400);
      if (e.action === 'start') this.addFx(e.pod, 'start', 700);
      if (e.action === 'ready') this.addFx(e.pod, 'ready', 900);
      if (e.action === 'crash' || e.action === 'fail') { this.addFx(e.pod, 'crash', 700); const r = this.pos[e.pod]; if (r) this.marks.push({ x: r.x + r.w / 2, y: r.y, text: e.action === 'fail' ? 'pull failed' : 'crash!', color: this.col.bad, until: now + 1400, start: now }); }
      if (e.action === 'oom') { this.addFx(e.pod, 'crash', 900); const r = this.pos[e.pod]; if (r) this.marks.push({ x: r.x + r.w / 2, y: r.y, text: 'OOMKilled', color: this.col.bad, until: now + 1800, start: now }); }
    }
    onTraffic(e) {
      if (!this.L) return;
      const pts = [];
      for (const h of e.hops) {
        const p = this.hopPoint(h);
        if (p) pts.push(p);
      }
      if (pts.length < 2) return;
      const okColor = this.col.good;
      const color = e.blocked ? this.col.bad : e.ok ? okColor : this.col.warn;
      this.particle(pts, color, 5, () => {
        const end = pts[pts.length - 1];
        const now = performance.now();
        if (e.blocked) this.marks.push({ x: end.x, y: end.y, cross: true, color: this.col.bad, text: 'blocked', until: now + 1600, start: now });
        else if (!e.ok) this.marks.push({ x: end.x, y: end.y, cross: true, color: this.col.warn, text: e.error === 'refused' ? 'refused' : e.error === 'resolve' ? 'DNS?' : 'timeout', until: now + 1500, start: now });
        else {
          if (e.code >= 400) this.marks.push({ x: end.x, y: end.y - 6, text: String(e.code), color: this.col.warn, until: now + 1300, start: now });
          this.particle(pts.slice().reverse(), okColor, 3, null, 1.8);
        }
      }, 0.9);
    }
    hopPoint(h) {
      const L = this.L;
      if (h.t === 'host') return this.anchor(L.comp.you, 'c');
      if (h.t === 'internet') return this.anchor(L.comp.net, 'c');
      if (h.t === 'ingress') return L.ingress ? { x: L.ingress.x + L.ingress.w / 2, y: L.ingress.y + L.ingress.h / 2 } : this.anchor(L.comp.net, 'c');
      if (h.t === 'svc' || h.t === 'lb') { const s = L.svcs.find(x => x.uid === h.id); return s ? { x: s.x + s.w / 2, y: s.y + s.h / 2 } : null; }
      if (h.t === 'pod') { const r = this.pos[h.id]; return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null; }
      if (h.t === 'node') { const n = L.nodes.find(x => x.name === h.id); return n ? { x: n.x + n.w / 2, y: n.y + 10 } : null; }
      return null;
    }
    particle(pts, color, size, done, speedMul) {
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      const dur = Math.max(260, Math.min(1500, len / (0.75 * (speedMul || 1))));
      this.particles.push({ pts, color, size, done, start: performance.now(), dur, len });
      if (this.particles.length > 160) this.particles.splice(0, this.particles.length - 160);
    }
    anchor(r, where) { return where === 'c' ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: r.x + r.w / 2, y: r.y + r.h }; }

    // ------------------------------------------------------------------ layout
    filterPod(p) {
      const f = this.opts.getFilter();
      if (SYSTEM_NS.includes(p.metadata.namespace) && !f.showSystem) return false;
      if (f.ns !== '*' && p.metadata.namespace !== f.ns && !(SYSTEM_NS.includes(p.metadata.namespace) && f.showSystem)) return false;
      return true;
    }
    computeLayout() {
      const c = this.c;
      const W = this.W, H = this.H;
      const pad = 12;
      const narrow = W < 620;
      const cpH = narrow ? Math.max(118, Math.min(150, H * 0.22)) : Math.max(86, Math.min(132, H * 0.22));
      const L = { comp: {}, nodes: [], svcs: [], pvs: [], queue: [], pods: [], narrow };
      // top row
      const sideW = narrow ? 52 : 92;
      L.comp.you = { x: pad, y: pad, w: sideW, h: cpH, key: 'you' };
      L.comp.net = { x: W - pad - sideW, y: pad, w: sideW, h: cpH, key: 'net' };
      const cp = { x: pad + sideW + 10, y: pad, w: W - 2 * pad - 2 * sideW - 20, h: cpH };
      L.cp = cp;
      if (narrow) {
        // 2x2 component grid + a thin queue strip
        const innerX = cp.x + 8, innerW = cp.w - 16;
        const compY = cp.y + 22, gridH = cp.h - 22 - 26;
        const cw = (innerW - 6) / 2, ch = (gridH - 6) / 2;
        ['sched', 'api', 'etcd', 'cm'].forEach((k, i) => (L.comp[k] = { x: innerX + (i % 2) * (cw + 6), y: compY + Math.floor(i / 2) * (ch + 6), w: cw, h: ch, key: k }));
        L.queueBox = { x: innerX, y: cp.y + cp.h - 24, w: innerW, h: 18, strip: true };
      } else {
        const queueW = Math.min(160, Math.max(90, cp.w * 0.2));
        const innerX = cp.x + 10, innerW = cp.w - 20 - queueW - 10;
        const compY = cp.y + 24, compH = cp.h - 34;
        const cw = innerW / 4 - 8;
        ['sched', 'api', 'etcd', 'cm'].forEach((k, i) => (L.comp[k] = { x: innerX + i * (cw + 8) + 4, y: compY, w: cw, h: compH, key: k }));
        L.queueBox = { x: cp.x + cp.w - queueW - 10, y: compY, w: queueW, h: compH };
      }
      // services lane
      const svcY = cp.y + cp.h + 12;
      const f = this.opts.getFilter();
      let svcs = c.list('Service').filter(s => !(s.metadata.namespace === 'default' && s.metadata.name === 'kubernetes') && !SYSTEM_NS.includes(s.metadata.namespace) && (f.ns === '*' || s.metadata.namespace === f.ns || s.metadata.namespace === 'ingress-nginx'));
      const ctrlInstalled = c.ls('Pod', 'ingress-nginx').length > 0;
      const svcH = 30;
      let x = pad;
      if (ctrlInstalled) { L.ingress = { x, y: svcY, w: narrow ? 70 : 104, h: svcH }; x += L.ingress.w + 10; }
      svcs = svcs.filter(s => !(s.metadata.namespace === 'ingress-nginx'));
      const avail = W - pad - x;
      const sw = svcs.length ? Math.max(70, Math.min(170, (avail - (svcs.length - 1) * 8) / svcs.length)) : 0;
      svcs.forEach((s, i) => { if (x + sw <= W - pad + 1) L.svcs.push({ x, y: svcY, w: sw, h: svcH, uid: s.metadata.uid, obj: s }); x += sw + 8; });
      L.svcOverflow = svcs.length - L.svcs.length;
      // storage lane
      const pvs = c.list('PersistentVolume');
      const pvH = pvs.length ? 40 : 0;
      // nodes
      const nodesY = svcY + svcH + 14;
      const nodesH = H - nodesY - pad - (pvH ? pvH + 10 : 0);
      const nodes = c.list('Node');
      const gap = 10;
      if (narrow) {
        const cols = 2, rowsN = Math.ceil(nodes.length / cols);
        const w = (W - 2 * pad - gap) / cols, h = Math.max(80, (nodesH - gap * (rowsN - 1)) / rowsN);
        nodes.forEach((n, i) => L.nodes.push({ x: pad + (i % cols) * (w + gap), y: nodesY + Math.floor(i / cols) * (h + gap), w, h, name: n.metadata.name, obj: n, cp: n.metadata.labels['node-role.kubernetes.io/control-plane'] != null }));
      } else {
        const weights = nodes.map(n => (n.metadata.labels['node-role.kubernetes.io/control-plane'] != null ? 0.86 : 1));
        const tw = weights.reduce((a, b) => a + b, 0);
        let nx = pad;
        nodes.forEach((n, i) => {
          const w = ((W - 2 * pad - gap * (nodes.length - 1)) * weights[i]) / tw;
          L.nodes.push({ x: nx, y: nodesY, w, h: Math.max(60, nodesH), name: n.metadata.name, obj: n, cp: weights[i] < 1 });
          nx += w + gap;
        });
      }
      // pods
      const all = c.list('Pod').filter(p => this.filterPod(p));
      const byNode = {};
      for (const p of all) {
        if (!p.spec.nodeName) { L.queue.push(p); continue; }
        (byNode[p.spec.nodeName] = byNode[p.spec.nodeName] || []).push(p);
      }
      for (const n of L.nodes) {
        const list = (byNode[n.name] || []).sort((a, b) => Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp) || a.metadata.name.localeCompare(b.metadata.name));
        const hidden = c.ls('Pod', 'kube-system').filter(p => p.spec.nodeName === n.name).length;
        n.sysHidden = f.showSystem ? 0 : hidden;
        const headH = 50;
        const bx = n.x + 8, by = n.y + headH, bw = n.w - 16, bh = n.h - headH - 8;
        let tileW = Math.min(narrow ? 92 : 168, bw), tileH = narrow ? 30 : 36, g = 6;
        let cols, rows;
        for (let k = 0; k < 8; k++) {
          cols = Math.max(1, Math.floor((bw + g) / (tileW + g)));
          rows = Math.max(1, Math.floor((bh + g) / (tileH + g)));
          if (cols * rows >= list.length || tileW <= 56) break;
          tileW = Math.max(56, tileW * 0.85); tileH = Math.max(20, tileH * 0.9); g = Math.max(3, g - 1);
        }
        cols = Math.max(1, Math.floor((bw + g) / (tileW + g)));
        tileW = Math.min(tileW * 1.0, (bw - (cols - 1) * g) / cols);
        const cap = cols * Math.max(1, Math.floor((bh + g) / (tileH + g)));
        n.overflow = Math.max(0, list.length - cap);
        list.slice(0, cap).forEach((p, i) => {
          const r = { x: bx + (i % cols) * (tileW + g), y: by + Math.floor(i / cols) * (tileH + g), w: tileW, h: tileH };
          L.pods.push({ p, r });
        });
      }
      // queue pods (unscheduled) inside control plane box
      const q = L.queueBox;
      if (q.strip) {
        const n = Math.max(0, Math.floor((q.w - 70) / 46));
        L.queue.slice(0, n).forEach((p, i) => L.pods.push({ p, r: { x: q.x + 66 + i * 46, y: q.y + 2, w: 42, h: q.h - 4 }, queued: true }));
        L.queueOverflow = Math.max(0, L.queue.length - n);
      } else {
        const qw = Math.min(q.w - 12, 100), qh = 18;
        L.queue.slice(0, Math.max(1, Math.floor((q.h - 22) / (qh + 4)))).forEach((p, i) => L.pods.push({ p, r: { x: q.x + 6, y: q.y + 18 + i * (qh + 4), w: qw, h: qh }, queued: true }));
        L.queueOverflow = Math.max(0, L.queue.length - Math.max(1, Math.floor((q.h - 22) / (qh + 4))));
      }
      // pvs
      if (pvH) {
        const py = H - pad - pvH;
        const pw = Math.min(120, (W - 2 * pad) / Math.max(1, pvs.length) - 8);
        pvs.forEach((pv, i) => L.pvs.push({ x: pad + i * (pw + 8), y: py, w: pw, h: pvH, obj: pv }));
      }
      return L;
    }

    // ------------------------------------------------------------------ drawing
    frame(t) {
      const ctx = this.ctx;
      if (!this.c) return;
      if (!this.wrap.offsetParent || this.wrap.clientWidth < 60 || this.wrap.clientHeight < 60) return;
      if (Math.abs(this.wrap.clientWidth - this.W) > 1 || Math.abs(this.wrap.clientHeight - this.H) > 1) this.resize();
      if (this.themeStamp !== document.documentElement.dataset.theme) { this.themeStamp = document.documentElement.dataset.theme; this.readColors(); }
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      let L;
      try { L = this.L = this.computeLayout(); } catch (e) { return; }
      this.hits = [];
      const now = performance.now();
      this.drawTop(L, now);
      this.drawNodes(L, now);
      this.drawSvcLinks(L);
      this.drawServices(L, now);
      this.drawPods(L, now);
      this.drawPVs(L);
      this.drawParticles(now);
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
    box(r, fill, stroke, radius, dash) {
      const ctx = this.ctx;
      rr(ctx, r.x, r.y, r.w, r.h, radius == null ? 10 : radius);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.setLineDash(dash || []); ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); }
    }
    glowing(k, now) { return (this.glow[k] || 0) > now; }
    drawTop(L, now) {
      const ctx = this.ctx;
      const col = this.col;
      // you
      const you = L.comp.you;
      this.box(you, col.panel, this.glowing('you', now) ? col.accent : col.border, 12);
      this.icon('laptop', you.x + you.w / 2, you.y + you.h / 2 - 10, col.text2);
      this.text('You', you.x + you.w / 2, you.y + you.h - 30, { align: 'center', weight: 700, size: 12 });
      if (!L.narrow) this.text('kubectl', you.x + you.w / 2, you.y + you.h - 15, { align: 'center', size: 10.5, color: col.muted, mono: true });
      this.hits.push({ r: you, kind: 'comp', key: 'you' });
      const net = L.comp.net;
      this.box(net, col.panel, col.border, 12);
      this.icon('globe', net.x + net.w / 2, net.y + net.h / 2 - 10, col.text2);
      this.text(L.narrow ? 'Web' : 'Internet', net.x + net.w / 2, net.y + net.h - 22, { align: 'center', weight: 700, size: 12 });
      this.hits.push({ r: net, kind: 'comp', key: 'net' });
      // control plane panel
      const cp = L.cp;
      const g = ctx.createLinearGradient(cp.x, cp.y, cp.x, cp.y + cp.h);
      g.addColorStop(0, this.light ? '#eef3ff' : 'rgba(50,108,229,.16)');
      g.addColorStop(1, this.light ? '#f7f9ff' : 'rgba(50,108,229,.05)');
      this.box(cp, g, this.light ? '#c6d4f1' : 'rgba(91,147,255,.35)', 14);
      this.text('CONTROL PLANE', cp.x + 12, cp.y + 13, { size: 10, weight: 700, color: col.accent });
      if (cp.w > 220) this.text('the brain', cp.x + 108, cp.y + 13, { size: 10, color: col.muted });
      const comps = L.narrow
        ? [['sched', 'Sched', ''], ['api', 'API', ''], ['etcd', 'etcd', ''], ['cm', 'Ctrl', '']]
        : [['sched', 'Scheduler', 'kube-scheduler'], ['api', 'API Server', 'kube-apiserver'], ['etcd', 'etcd', `${this.c.rv - 1000} writes`], ['cm', 'Controllers', 'controller-manager']];
      for (const [k, title, sub] of comps) {
        const r = L.comp[k];
        const on = this.glowing(k, now);
        if (on) { ctx.save(); ctx.shadowColor = k === 'etcd' ? col.accent2 : col.accent; ctx.shadowBlur = 18; }
        this.box(r, col.panel, on ? (k === 'etcd' ? col.accent2 : col.accent) : col.border2, 10);
        if (on) ctx.restore();
        if (k === 'etcd') this.icon('db', r.x + 16, r.y + r.h / 2, on ? col.accent2 : col.muted);
        else if (k === 'api') this.icon('door', r.x + 16, r.y + r.h / 2, on ? col.accent : col.muted);
        else if (k === 'sched') this.icon('target', r.x + 16, r.y + r.h / 2, on ? col.info : col.muted);
        else this.icon('loop', r.x + 16, r.y + r.h / 2, on ? col.accent : col.muted);
        const tx = r.x + 32, maxw = r.w - 38;
        if (sub) {
          this.text(title, tx, r.y + r.h / 2 - 7, { weight: 700, size: 12, max: maxw });
          this.text(sub, tx, r.y + r.h / 2 + 9, { size: 10, color: col.muted, mono: k !== 'etcd', max: maxw });
        } else this.text(title, tx, r.y + r.h / 2, { weight: 700, size: 11, max: maxw });
        this.hits.push({ r, kind: 'comp', key: k });
      }
      // links
      ctx.strokeStyle = col.border2; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      const a = L.comp.api, e = L.comp.etcd, s = L.comp.sched, m = L.comp.cm;
      ctx.beginPath();
      ctx.moveTo(you.x + you.w, you.y + you.h / 2); ctx.lineTo(cp.x, you.y + you.h / 2);
      ctx.stroke(); ctx.setLineDash([]);
      void a; void e; void s; void m;
      // queue
      const q = L.queueBox;
      this.box(q, this.light ? '#fff8ea' : 'rgba(247,178,59,.07)', L.queue.length ? col.warn : col.border, 8, [4, 3]);
      this.text(L.queue.length ? `Pending (${L.queue.length})` : (q.strip ? 'Queue' : 'Scheduling queue'), q.x + 8, q.y + (q.strip ? q.h / 2 : 9), { size: 10, weight: 600, color: L.queue.length ? col.warn : col.muted, max: q.strip ? 60 : q.w - 12 });
      if (L.queueOverflow) this.text(`+${L.queueOverflow} more`, q.x + q.w - 6, q.y + q.h - 8, { size: 10, align: 'right', color: col.warn });
    }
    drawNodes(L, now) {
      const col = this.col;
      for (const n of L.nodes) {
        const node = n.obj;
        const rc = (node.status.conditions || []).find(c => c.type === 'Ready');
        const ready = rc && rc.status === 'True';
        const down = !ready;
        const cord = !!node.spec.unschedulable;
        this.box(n, this.light ? (down ? '#fff1f1' : '#ffffff') : (down ? 'rgba(255,93,93,.07)' : col.panel), down ? col.bad : (n.cp ? (this.light ? '#c6d4f1' : 'rgba(91,147,255,.35)') : col.border2), 12, down ? [5, 4] : null);
        if (cord) {
          const ctx = this.ctx;
          ctx.save(); rr(ctx, n.x, n.y, n.w, 44, 12); ctx.clip();
          ctx.strokeStyle = this.light ? 'rgba(201,130,0,.18)' : 'rgba(247,178,59,.12)'; ctx.lineWidth = 6;
          for (let i = -50; i < n.w + 50; i += 16) { ctx.beginPath(); ctx.moveTo(n.x + i, n.y + 44); ctx.lineTo(n.x + i + 44, n.y); ctx.stroke(); }
          ctx.restore();
        }
        this.icon(n.cp ? 'crown' : 'server', n.x + 16, n.y + 15, n.cp ? col.accent : col.text2);
        const stTxt = down ? 'NotReady' : cord ? 'Cordoned' : 'Ready';
        const stCol = down ? col.bad : cord ? col.warn : col.good;
        let pw;
        if (n.w < 200) { this.ctx.fillStyle = stCol; this.ctx.beginPath(); this.ctx.arc(n.x + n.w - 16, n.y + 15, 5, 0, Math.PI * 2); this.ctx.fill(); pw = 14; }
        else pw = this.pill(n.x + n.w - 10, n.y + 15, stTxt, stCol, 'right');
        this.text(n.name, n.x + 30, n.y + 15, { weight: 700, size: 12.5, max: n.w - 46 - pw });
        const zone = node.metadata.labels['topology.kubernetes.io/zone'] || '';
        const alloc = this.c.nodeAllocated(n.name);
        const capCpu = U.parseCpu(node.status.allocatable.cpu), capMem = U.parseMem(node.status.allocatable.memory);
        const taints = (node.spec.taints || []).filter(t => t.key !== 'node.kubernetes.io/unschedulable');
        let info = `${zone}${n.cp ? ' · control-plane' : ''}`;
        if (taints.length) info += ` · ⛔ ${taints.map(t => t.key.split('/').pop()).join(',')}`;
        if (n.sysHidden) info += ` · +${n.sysHidden} sys`;
        this.text(info, n.x + 12, n.y + 32, { size: 10, color: col.muted, max: n.w - 104 });
        // resource bars
        const bw = Math.min(80, n.w * 0.3), bx = n.x + n.w - bw - 10;
        this.bar(bx, n.y + 28, bw, alloc.cpu / capCpu, 'cpu');
        this.bar(bx, n.y + 37, bw, alloc.mem / capMem, 'mem');
        if (n.overflow) this.text(`+${n.overflow} more pods`, n.x + n.w - 10, n.y + n.h - 10, { size: 10, color: col.muted, align: 'right' });
        this.hits.push({ r: { x: n.x, y: n.y, w: n.w, h: 44 }, kind: 'node', obj: node });
      }
    }
    bar(x, y, w, frac, label) {
      const ctx = this.ctx;
      const col = this.col;
      frac = Math.max(0, Math.min(1, frac || 0));
      rr(ctx, x, y, w, 5, 2.5); ctx.fillStyle = col.panel3; ctx.fill();
      if (frac > 0) { rr(ctx, x, y, Math.max(3, w * frac), 5, 2.5); ctx.fillStyle = frac > 0.9 ? col.bad : frac > 0.7 ? col.warn : col.accent; ctx.fill(); }
      this.text(label, x - 4, y + 3, { size: 8.5, color: col.muted, align: 'right', mono: true });
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
      for (const { p, r, queued } of L.pods) {
        const uid = p.metadata.uid;
        seen.add(uid);
        let a = this.pos[uid];
        if (!a) {
          // new pods appear from the scheduling queue (or pop in place)
          const q = L.queueBox;
          a = this.pos[uid] = { x: queued ? r.x : q.x + 6, y: queued ? r.y : q.y + 18, w: r.w, h: r.h, born: now, alpha: 0 };
        }
        const k = 0.16;
        a.x += (r.x - a.x) * k; a.y += (r.y - a.y) * k; a.w += (r.w - a.w) * k; a.h += (r.h - a.h) * k;
        a.alpha = Math.min(1, a.alpha + 0.08);
        a.lastSeen = now;
        const { cat, s } = this.podState(p);
        let fill, stroke, dash = null, text = col.text;
        if (cat === 'good') { fill = this.light ? '#e9f9f0' : 'rgba(43,213,118,.13)'; stroke = col.good; }
        else if (cat === 'warn') { fill = this.light ? '#fff7e6' : 'rgba(247,178,59,.12)'; stroke = col.warn; }
        else if (cat === 'pend') { fill = this.light ? '#fffaf0' : 'rgba(247,178,59,.07)'; stroke = col.warn; dash = [4, 3]; }
        else if (cat === 'bad') { fill = this.light ? '#ffeded' : 'rgba(255,93,93,.15)'; stroke = col.bad; }
        else if (cat === 'done') { fill = col.panel2; stroke = col.border2; text = col.muted; }
        else { fill = col.panel2; stroke = col.muted; dash = [3, 3]; text = col.muted; }
        let ox = 0;
        const fx = this.fx[uid];
        if (fx && fx.until > now && fx.kind === 'crash') ox = Math.sin((now - fx.start) / 25) * 3;
        ctx.save();
        ctx.globalAlpha = a.alpha * (cat === 'term' ? 0.5 + 0.2 * Math.sin(now / 200) : 1);
        const rect = { x: a.x + ox, y: a.y, w: a.w, h: a.h };
        if (fx && fx.until > now && (fx.kind === 'ready' || fx.kind === 'hit' || fx.kind === 'start')) {
          ctx.shadowColor = fx.kind === 'hit' ? col.info : col.good;
          ctx.shadowBlur = 16 * (fx.until - now) / 900;
        }
        if (cat === 'bad') { ctx.shadowColor = col.bad; ctx.shadowBlur = 6 + 4 * Math.sin(now / 250); }
        this.box(rect, fill, stroke, 7, dash);
        ctx.shadowBlur = 0;
        // owner stripe
        const ref = (p.metadata.ownerReferences || []).find(o => o.controller);
        const ownerKey = ref ? (this.c.workloadKeyOf(p) || ref.name) : 'bare:' + p.metadata.name;
        ctx.fillStyle = `hsl(${hue(ownerKey)}, 72%, ${this.light ? 48 : 62}%)`;
        rr(ctx, rect.x, rect.y, 4, rect.h, 2); ctx.fill();
        // spinner for pending
        if (cat === 'pend' && rect.h >= 18) {
          ctx.strokeStyle = col.warn; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(rect.x + 13, rect.y + rect.h / 2, 4.5, now / 160, now / 160 + 4.2); ctx.stroke();
        } else {
          ctx.fillStyle = stroke;
          ctx.beginPath(); ctx.arc(rect.x + 13, rect.y + rect.h / 2, 3.5, 0, Math.PI * 2); ctx.fill();
        }
        const small = rect.h < 24 || rect.w < 74;
        const name = this.shortName(p.metadata.name, rect.w - (small ? 26 : 30));
        if (small) this.text(name, rect.x + 21, rect.y + rect.h / 2, { size: 9.5, weight: 600, color: text, max: rect.w - 24, mono: true });
        else {
          const big = rect.h >= 34;
          this.text(name, rect.x + 22, rect.y + rect.h / 2 - (big ? 7 : 6), { size: big ? 10.5 : 10, weight: 600, color: text, max: rect.w - 28, mono: true });
          const rs = s.restarts !== '0' && big ? ` · ↻${s.restarts.split(' ')[0]}` : '';
          this.text((cat === 'good' ? `${s.ready} ready` : s.status) + rs + (big && p.metadata.namespace !== 'default' ? ` · ${p.metadata.namespace}` : ''), rect.x + 22, rect.y + rect.h / 2 + (big ? 8 : 7), { size: big ? 9.5 : 9, color: cat === 'bad' ? col.bad : cat === 'good' ? col.good : col.muted, max: rect.w - 28 });
        }
        if (fx && fx.until > now && fx.kind === 'pull') this.text('⬇', rect.x + rect.w - 9, rect.y + 9, { size: 10, color: col.info, align: 'center' });
        ctx.restore();
        if (this.selected && this.selected.kind === 'pod' && this.selected.uid === uid) { ctx.strokeStyle = col.accent; ctx.lineWidth = 2; rr(ctx, rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4, 9); ctx.stroke(); }
        this.hits.push({ r: rect, kind: 'pod', obj: p });
      }
      // pods that just vanished: fade out
      for (const uid of Object.keys(this.pos)) {
        if (seen.has(uid)) continue;
        const a = this.pos[uid];
        if (!a.dying) a.dying = now;
        const t = (now - a.dying) / 450;
        if (t >= 1) { delete this.pos[uid]; continue; }
        ctx.save(); ctx.globalAlpha = (1 - t) * 0.6;
        this.box({ x: a.x + a.w * t * 0.25, y: a.y + a.h * t * 0.25, w: a.w * (1 - t * 0.5), h: a.h * (1 - t * 0.5) }, col.panel2, col.muted, 7, [3, 3]);
        ctx.restore();
      }
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
    drawServices(L, now) {
      const col = this.col;
      if (L.ingress) {
        const r = L.ingress;
        this.box(r, this.light ? '#f1ecff' : 'rgba(139,108,255,.14)', col.accent2, 15);
        this.text('⇄ Ingress', r.x + r.w / 2, r.y + r.h / 2, { size: 11, weight: 700, color: col.accent2, align: 'center', max: r.w - 8 });
        this.hits.push({ r, kind: 'ingress' });
      }
      if (!L.svcs.length && !L.ingress) {
        this.text('No Services yet — Services appear here and link to their Pods', 14, L.cp.y + L.cp.h + 27, { size: 11, color: col.muted });
      }
      for (const s of L.svcs) {
        const svc = s.obj;
        const type = svc.spec.type;
        const headless = svc.spec.clusterIP === 'None';
        const c = type === 'NodePort' ? col.accent2 : type === 'LoadBalancer' ? col.info : type === 'ExternalName' ? col.muted : col.accent;
        const hov = this.hover && this.hover.kind === 'svc' && this.hover.obj === svc;
        this.box(s, this.light ? '#ffffff' : col.panel, c, 15, headless ? [4, 3] : null);
        if (hov) { this.ctx.strokeStyle = c; this.ctx.lineWidth = 2; rr(this.ctx, s.x, s.y, s.w, s.h, 15); this.ctx.stroke(); }
        const ep = this.c.get('Endpoints', svc.metadata.namespace, svc.metadata.name);
        const n = ((ep && ep.subsets) || []).reduce((a, x) => a + (x.addresses || []).length, 0);
        this.text(svc.metadata.name, s.x + 12, s.y + s.h / 2 - 5, { size: 11, weight: 700, max: s.w - 40 });
        this.text(`${headless ? 'Headless' : type}${svc.spec.ports && svc.spec.ports[0] ? ' :' + svc.spec.ports[0].port : ''}${svc.spec.ports && svc.spec.ports[0] && svc.spec.ports[0].nodePort ? '→' + svc.spec.ports[0].nodePort : ''}`, s.x + 12, s.y + s.h / 2 + 7, { size: 9, color: col.muted, max: s.w - 40 });
        this.pill(s.x + s.w - 6, s.y + s.h / 2, String(n), n ? col.good : (type === 'ExternalName' ? col.muted : col.bad), 'right');
        this.hits.push({ r: s, kind: 'svc', obj: svc });
      }
      if (L.svcOverflow > 0) this.text(`+${L.svcOverflow}`, this.W - 14, L.cp.y + L.cp.h + 27, { size: 10, color: col.muted, align: 'right' });
    }
    drawSvcLinks(L) {
      const ctx = this.ctx;
      const col = this.col;
      const podRects = {};
      L.pods.forEach(({ p }) => { const a = this.pos[p.metadata.uid]; if (a) podRects[p.metadata.uid] = a; });
      for (const s of L.svcs) {
        const svc = s.obj;
        const ep = this.c.get('Endpoints', svc.metadata.namespace, svc.metadata.name);
        if (!ep) continue;
        const hov = this.hover && this.hover.kind === 'svc' && this.hover.obj === svc;
        for (const sub of ep.subsets || []) {
          for (const [list, ready] of [[sub.addresses || [], true], [sub.notReadyAddresses || [], false]]) {
            for (const a of list) {
              const r = podRects[a.targetRef.uid];
              if (!r) continue;
              const x1 = s.x + s.w / 2, y1 = s.y + s.h, x2 = r.x + r.w / 2, y2 = r.y;
              ctx.beginPath();
              ctx.moveTo(x1, y1);
              ctx.bezierCurveTo(x1, y1 + 30, x2, y2 - 40, x2, y2);
              ctx.strokeStyle = ready ? (hov ? col.accent : col.accent + (this.light ? '66' : '55')) : col.muted + '66';
              ctx.lineWidth = hov ? 2 : 1;
              ctx.setLineDash(ready ? [] : [3, 4]);
              ctx.stroke();
              ctx.setLineDash([]);
            }
          }
        }
      }
      if (L.ingress) {
        for (const ing of this.c.list('Ingress')) {
          if (!ing.status.loadBalancer.ingress) continue;
          for (const rule of ing.spec.rules || []) for (const pth of (rule.http && rule.http.paths) || []) {
            const s = L.svcs.find(x => x.obj.metadata.name === pth.backend.service.name && x.obj.metadata.namespace === ing.metadata.namespace);
            if (!s) continue;
            ctx.beginPath();
            const x1 = L.ingress.x + L.ingress.w, y1 = L.ingress.y + L.ingress.h / 2;
            ctx.moveTo(x1, y1);
            ctx.bezierCurveTo(x1 + 20, y1 - 26, s.x + s.w / 2, s.y - 22, s.x + s.w / 2, s.y);
            ctx.strokeStyle = col.accent2 + '88'; ctx.lineWidth = 1.2; ctx.stroke();
          }
        }
      }
    }
    drawPVs(L) {
      const col = this.col;
      if (!L.pvs.length) return;
      const ctx = this.ctx;
      for (const pv of L.pvs) {
        const o = pv.obj;
        const bound = o.status.phase === 'Bound';
        const c = bound ? col.accent2 : col.muted;
        // cylinder
        const x = pv.x, y = pv.y + 4, w = pv.w, h = pv.h - 8;
        ctx.fillStyle = this.light ? '#f4f0ff' : 'rgba(139,108,255,.12)';
        ctx.strokeStyle = c; ctx.lineWidth = 1;
        if (w < 8) continue;
        ctx.beginPath(); ctx.ellipse(x + w / 2, y + 4, w / 2, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + h - 4); ctx.ellipse(x + w / 2, y + h - 4, w / 2, 4, 0, Math.PI, 0, true); ctx.lineTo(x + w, y + 4); ctx.fill(); ctx.stroke();
        const claim = o.spec.claimRef ? o.spec.claimRef.name : '(available)';
        this.text(claim, x + w / 2, y + h / 2 + 1, { size: 9.5, weight: 600, align: 'center', max: w - 8, color: col.text2 });
        this.text(`${o.spec.capacity.storage} · ${o.status.phase}`, x + w / 2, y + h - 2, { size: 8.5, align: 'center', max: w - 6, color: col.muted });
        this.hits.push({ r: pv, kind: 'pv', obj: o });
        // link to pods using the claim
        if (o.spec.claimRef) {
          for (const { p } of L.pods) {
            if (p.metadata.namespace !== o.spec.claimRef.namespace) continue;
            if (!(p.spec.volumes || []).some(v => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === o.spec.claimRef.name)) continue;
            const r = this.pos[p.metadata.uid];
            if (!r) continue;
            ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(r.x + r.w / 2, r.y + r.h);
            ctx.strokeStyle = col.accent2 + '77'; ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
          }
        }
      }
    }
    drawParticles(now) {
      const ctx = this.ctx;
      const keep = [];
      for (const pt of this.particles) {
        const t = (now - pt.start) / pt.dur;
        if (t >= 1) { if (pt.done) { try { pt.done(); } catch (e) { /* ignore */ } } continue; }
        keep.push(pt);
        const d = ease(t) * pt.len;
        let acc = 0, x = pt.pts[0].x, y = pt.pts[0].y;
        for (let i = 1; i < pt.pts.length; i++) {
          const a = pt.pts[i - 1], b = pt.pts[i];
          const seg = Math.hypot(b.x - a.x, b.y - a.y);
          if (acc + seg >= d) { const f = seg ? (d - acc) / seg : 0; x = a.x + (b.x - a.x) * f; y = a.y + (b.y - a.y) * f; break; }
          acc += seg; x = b.x; y = b.y;
        }
        ctx.save();
        ctx.shadowColor = pt.color; ctx.shadowBlur = 12;
        ctx.fillStyle = pt.color;
        ctx.beginPath(); ctx.arc(x, y, pt.size, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      this.particles = keep;
    }
    drawMarks(now) {
      const keep = [];
      for (const m of this.marks) {
        if (m.until < now) continue;
        keep.push(m);
        const t = (now - m.start) / (m.until - m.start);
        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = 1 - t * t;
        if (m.cross) {
          ctx.strokeStyle = m.color; ctx.lineWidth = 3;
          const s = 7;
          ctx.beginPath(); ctx.moveTo(m.x - s, m.y - s); ctx.lineTo(m.x + s, m.y + s); ctx.moveTo(m.x + s, m.y - s); ctx.lineTo(m.x - s, m.y + s); ctx.stroke();
          this.text(m.text, m.x, m.y - 16, { size: 10, weight: 700, color: m.color, align: 'center' });
        } else this.text(m.text, m.x, m.y - 8 - t * 18, { size: 11, weight: 800, color: m.color, align: 'center' });
        ctx.restore();
      }
      this.marks = keep;
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
