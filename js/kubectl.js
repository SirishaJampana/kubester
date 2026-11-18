/* Kubester — kubectl: argument parsing, printers and ~40 subcommands. No DOM. */
(function (G) {
  'use strict';
  const KS = G.KS;
  const U = KS.util;
  const R = KS.runtime;
  const H = KS.podHelpers;
  const yaml = G.jsyaml;

  // ------------------------------------------------------------------ YAML helpers
  function sortDeep(o) {
    if (Array.isArray(o)) return o.map(sortDeep);
    if (o && typeof o === 'object') { const r = {}; Object.keys(o).sort().forEach(k => { if (o[k] !== undefined) r[k] = sortDeep(o[k]); }); return r; }
    return o;
  }
  function toYaml(o) { return yaml.dump(sortDeep(o), { noArrayIndent: true, lineWidth: -1, noRefs: true, quotingType: '"' }); }
  function toJson(o) { return JSON.stringify(sortDeep(o), null, 4); }
  function parseDocs(text, source) {
    try {
      const docs = [];
      yaml.loadAll(text, d => { if (d == null) return; if (d.kind === 'List' && Array.isArray(d.items)) d.items.forEach(x => docs.push(x)); else docs.push(d); });
      return { docs };
    } catch (e) {
      if (/^\s*[{[]/.test(text)) {
        try { const d = JSON.parse(text); return { docs: d.kind === 'List' ? d.items : [d] }; } catch (e2) { /* fallthrough */ }
      }
      const line = e.mark ? e.mark.line + 1 : '?';
      const reason = (e.reason || e.message || '').replace(/\s*\(\d+:\d+\)$/, '');
      return { error: `error: error parsing ${source}: error converting YAML to JSON: yaml: line ${line}: ${reason}` };
    }
  }
  KS.toYaml = toYaml;
  KS.toJson = toJson;
  KS.parseDocs = parseDocs;

  // ------------------------------------------------------------------ jsonpath (kubectl subset)
  function jpTokens(path) {
    const toks = [];
    let i = 0;
    const s = path.trim().replace(/^\$/, '');
    while (i < s.length) {
      if (s[i] === '.') {
        if (s[i + 1] === '.') { i += 2; let n = ''; while (i < s.length && /[\w-]/.test(s[i])) n += s[i++]; toks.push({ t: 'deep', n }); continue; }
        i++;
        let n = '';
        while (i < s.length && !/[.[]/.test(s[i])) n += s[i++];
        if (n) toks.push({ t: 'field', n });
        continue;
      }
      if (s[i] === '[') {
        let depth = 0, j = i;
        for (; j < s.length; j++) { if (s[j] === '[') depth++; if (s[j] === ']') { depth--; if (!depth) break; } }
        const inner = s.slice(i + 1, j).trim();
        i = j + 1;
        if (inner === '*') toks.push({ t: 'all' });
        else if (/^-?\d+$/.test(inner)) toks.push({ t: 'idx', n: +inner });
        else if (/^-?\d*:-?\d*$/.test(inner)) { const [a, b] = inner.split(':'); toks.push({ t: 'slice', a: a === '' ? null : +a, b: b === '' ? null : +b }); }
        else if (/^['"].*['"]$/.test(inner)) toks.push({ t: 'field', n: inner.slice(1, -1) });
        else if (inner.startsWith('?(')) {
          const m = inner.match(/^\?\(@((?:\.[\w-]+|\['[^']+'\])+)\s*(==|!=|<|>)\s*(.+)\)$/);
          if (m) toks.push({ t: 'filter', path: m[1], op: m[2], v: m[3].trim().replace(/^["']|["']$/g, '') });
          else { const m2 = inner.match(/^\?\(@((?:\.[\w-]+)+)\)$/); toks.push({ t: 'exists', path: m2 ? m2[1] : '' }); }
        } else toks.push({ t: 'field', n: inner });
        continue;
      }
      // bare start without dot
      let n = '';
      while (i < s.length && !/[.[]/.test(s[i])) n += s[i++];
      if (n) toks.push({ t: 'field', n });
    }
    return toks;
  }
  function jpEval(path, root) {
    let cur = [root];
    for (const tk of jpTokens(path)) {
      const next = [];
      for (const v of cur) {
        if (v == null) continue;
        if (tk.t === 'field') { if (typeof v === 'object' && tk.n in v) next.push(v[tk.n]); }
        else if (tk.t === 'all') { if (Array.isArray(v)) next.push(...v); else if (typeof v === 'object') next.push(...Object.values(v)); }
        else if (tk.t === 'idx') { if (Array.isArray(v)) { const x = v[tk.n < 0 ? v.length + tk.n : tk.n]; if (x !== undefined) next.push(x); } }
        else if (tk.t === 'slice') { if (Array.isArray(v)) next.push(...v.slice(tk.a == null ? 0 : tk.a, tk.b == null ? undefined : tk.b)); }
        else if (tk.t === 'filter' || tk.t === 'exists') {
          const arr = Array.isArray(v) ? v : [v];
          arr.forEach(it => {
            const got = jpEval(tk.path, it)[0];
            if (tk.t === 'exists') { if (got !== undefined) next.push(it); return; }
            const a = got == null ? '' : String(got);
            const ok = tk.op === '==' ? a === tk.v : tk.op === '!=' ? a !== tk.v : tk.op === '<' ? +a < +tk.v : +a > +tk.v;
            if (ok) next.push(it);
          });
        } else if (tk.t === 'deep') {
          const walk = x => { if (x && typeof x === 'object') { if (!Array.isArray(x) && tk.n in x) next.push(x[tk.n]); Object.values(x).forEach(walk); } };
          walk(v);
        }
      }
      cur = next;
    }
    return cur;
  }
  const jpStr = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  function jsonpathTemplate(tpl, data) {
    // tokens: text | {expr} | {range expr} ... {end}
    const parts = [];
    let i = 0;
    while (i < tpl.length) {
      const o = tpl.indexOf('{', i);
      if (o < 0) { parts.push({ text: tpl.slice(i) }); break; }
      if (o > i) parts.push({ text: tpl.slice(i, o) });
      let depth = 0, j = o, inStr = null;
      for (; j < tpl.length; j++) {
        const ch = tpl[j];
        if (inStr) { if (ch === inStr && tpl[j - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (!depth) break; }
      }
      if (j >= tpl.length) throw new Error('unclosed action');
      parts.push({ expr: tpl.slice(o + 1, j).trim() });
      i = j + 1;
    }
    let pos = 0;
    function run(ctx, stopAtEnd) {
      let s = '';
      while (pos < parts.length) {
        const p = parts[pos++];
        if (p.text != null) { s += p.text; continue; }
        const e = p.expr;
        if (e === 'end') { if (stopAtEnd) return s; throw new Error('unexpected end'); }
        if (e.startsWith('range ')) {
          const items = jpEval(e.slice(6), ctx);
          const start = pos;
          if (!items.length) {
            let depth = 1;
            while (pos < parts.length && depth) { const q = parts[pos++]; if (q.expr && q.expr.startsWith('range ')) depth++; if (q.expr === 'end') depth--; }
          }
          items.forEach(it => { pos = start; s += run(it, true); });
          continue;
        }
        if (/^["'].*["']$/.test(e)) { s += e.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t'); continue; }
        if (e === '@') { s += jpStr(ctx); continue; }
        s += jpEval(e, ctx).map(jpStr).join(' ');
      }
      return s;
    }
    return run(data, false);
  }
  KS.jsonpath = { eval: jpEval, template: jsonpathTemplate };

  // ------------------------------------------------------------------ flags
  const VALUE_FLAGS = new Set(['namespace', 'output', 'selector', 'filename', 'container', 'image', 'port', 'replicas', 'env', 'labels', 'dry-run', 'grace-period', 'cascade', 'sort-by', 'field-selector', 'tail', 'since', 'since-time', 'to-revision', 'revision', 'type', 'target-port', 'name', 'protocol', 'cpu-percent', 'cpu', 'memory', 'min', 'max', 'for', 'timeout', 'as', 'as-group', 'target', 'copy-to', 'class', 'rule', 'from-literal', 'from-file', 'from-env-file', 'docker-server', 'docker-username', 'docker-password', 'docker-email', 'verb', 'resource', 'clusterrole', 'role', 'serviceaccount', 'user', 'group', 'schedule', 'restart', 'hard', 'min-available', 'max-unavailable', 'value', 'description', 'limits', 'requests', 'context', 'patch', 'kustomize', 'resource-name', 'from', 'cert', 'key', 'template', 'chunk-size', 'address', 'pod-running-timeout', 'session-affinity', 'external-ip', 'cluster-ip', 'overrides', 'profile', 'duration', 'default-backend', 'annotation', 'field-manager', 'subresource', 'api-group', 'label-columns', 'tcp', 'node-port', 'external-name', 'image-pull-policy', 'current-replicas', 'cluster', 'kubeconfig', 'request-timeout', 'types', 'containers', 'keys', 'prefix', 'preemption-policy', 'pod-selector', 'limit-bytes', 'max-log-requests', 'v', 'annotations', 'set-image', 'raw', 'resource-version', 'expose-port', 'load-balancer-ip', 'record-type', 'version', 'value-from']);
  const BOOL_OVERRIDES = { logs: { f: 'follow', p: 'previous' }, exec: { f: 'filename' }, top: {}, run: { l: 'labels' } };
  const SHORT = { n: 'namespace', o: 'output', l: 'selector', f: 'filename', c: 'container', A: 'all-namespaces', w: 'watch', i: 'stdin', t: 'tty', p: 'patch', k: 'kustomize', L: 'label-columns', R: 'recursive', h: 'help', q: 'quiet', v: 'v' };
  const MULTI = new Set(['env', 'from-literal', 'from-file', 'filename', 'image', 'rule', 'annotation', 'tcp', 'label-columns', 'verb', 'resource', 'resource-name', 'user', 'group', 'serviceaccount', 'hard', 'labels']);
  const GLOBAL_FLAGS = ['namespace', 'as', 'as-group', 'context', 'kubeconfig', 'help', 'v', 'request-timeout', 'cluster', 'user'];
  const CMD_FLAGS = {
    get: ['output', 'selector', 'all-namespaces', 'watch', 'watch-only', 'show-labels', 'label-columns', 'sort-by', 'field-selector', 'no-headers', 'filename', 'ignore-not-found', 'output-watch-events', 'chunk-size', 'raw', 'show-kind', 'recursive', 'kustomize', 'server-print', 'subresource', 'template', 'show-managed-fields'],
    describe: ['selector', 'all-namespaces', 'filename', 'show-events', 'recursive', 'chunk-size'],
    create: ['filename', 'dry-run', 'output', 'save-config', 'validate', 'edit', 'kustomize', 'recursive', 'image', 'replicas', 'port', 'tcp', 'node-port', 'external-name', 'from-literal', 'from-file', 'from-env-file', 'type', 'docker-server', 'docker-username', 'docker-password', 'docker-email', 'cert', 'key', 'from', 'schedule', 'restart', 'verb', 'resource', 'resource-name', 'role', 'clusterrole', 'user', 'group', 'serviceaccount', 'class', 'rule', 'default-backend', 'annotation', 'hard', 'value', 'description', 'global-default', 'preemption-policy', 'selector', 'min-available', 'max-unavailable', 'append-hash', 'duration', 'clusterip', 'field-manager', 'record'],
    run: ['image', 'port', 'labels', 'env', 'restart', 'command', 'rm', 'stdin', 'tty', 'dry-run', 'output', 'expose', 'image-pull-policy', 'overrides', 'annotations', 'attach', 'privileged', 'pod-running-timeout', 'quiet', 'leave-stdin-open'],
    apply: ['filename', 'kustomize', 'recursive', 'dry-run', 'output', 'prune', 'selector', 'server-side', 'force', 'validate', 'force-conflicts', 'field-manager', 'wait', 'overwrite', 'all', 'grace-period', 'timeout', 'record'],
    delete: ['filename', 'selector', 'all', 'all-namespaces', 'force', 'grace-period', 'now', 'cascade', 'wait', 'ignore-not-found', 'kustomize', 'recursive', 'dry-run', 'field-selector', 'timeout', 'output', 'raw', 'interactive'],
    edit: ['output', 'filename', 'save-config', 'validate', 'record', 'subresource'],
    scale: ['replicas', 'current-replicas', 'selector', 'all', 'filename', 'resource-version', 'timeout', 'dry-run', 'output', 'record'],
    set: ['all', 'selector', 'local', 'dry-run', 'output', 'record', 'filename', 'container', 'containers', 'env', 'from', 'list', 'keys', 'prefix', 'overwrite', 'resolve', 'limits', 'requests'],
    rollout: ['to-revision', 'revision', 'timeout', 'watch', 'output', 'filename', 'selector', 'record', 'dry-run'],
    expose: ['port', 'target-port', 'type', 'name', 'protocol', 'selector', 'labels', 'external-ip', 'cluster-ip', 'session-affinity', 'dry-run', 'output', 'filename', 'load-balancer-ip', 'overrides', 'record'],
    label: ['overwrite', 'all', 'selector', 'all-namespaces', 'list', 'local', 'dry-run', 'output', 'resource-version', 'filename', 'field-selector'],
    annotate: ['overwrite', 'all', 'selector', 'all-namespaces', 'list', 'local', 'dry-run', 'output', 'resource-version', 'filename', 'field-selector'],
    taint: ['overwrite', 'all', 'selector', 'dry-run', 'output', 'validate'],
    cordon: ['selector', 'dry-run'], uncordon: ['selector', 'dry-run'],
    drain: ['ignore-daemonsets', 'delete-emptydir-data', 'delete-local-data', 'force', 'grace-period', 'timeout', 'selector', 'pod-selector', 'disable-eviction', 'dry-run', 'skip-wait-for-delete-timeout', 'chunk-size'],
    logs: ['follow', 'previous', 'container', 'tail', 'timestamps', 'since', 'since-time', 'selector', 'all-containers', 'prefix', 'max-log-requests', 'limit-bytes', 'pod-running-timeout', 'ignore-errors'],
    exec: ['container', 'stdin', 'tty', 'filename', 'pod-running-timeout', 'quiet'],
    'port-forward': ['address', 'pod-running-timeout'],
    debug: ['image', 'target', 'stdin', 'tty', 'copy-to', 'container', 'share-processes', 'replace', 'attach', 'quiet', 'profile', 'env', 'set-image', 'same-node', 'keep-labels', 'image-pull-policy', 'arguments-only'],
    top: ['selector', 'all-namespaces', 'sort-by', 'containers', 'no-headers', 'sum', 'use-protocol-buffers', 'show-capacity', 'field-selector'],
    explain: ['recursive', 'api-version', 'output'],
    diff: ['filename', 'kustomize', 'recursive', 'server-side', 'selector', 'prune', 'field-manager', 'force-conflicts'],
    autoscale: ['min', 'max', 'cpu-percent', 'cpu', 'memory', 'name', 'dry-run', 'output', 'filename', 'record'],
    auth: ['list', 'all-namespaces', 'subresource', 'no-headers', 'quiet', 'output'],
    config: ['current', 'namespace', 'cluster', 'user', 'minify', 'raw', 'flatten', 'output', 'no-headers'],
    'api-resources': ['namespaced', 'api-group', 'verbs', 'output', 'no-headers', 'sort-by', 'cached'],
    'api-versions': [],
    'cluster-info': ['output-directory', 'all-namespaces'],
    version: ['client', 'output', 'short'],
    patch: ['patch', 'type', 'dry-run', 'output', 'filename', 'local', 'subresource', 'record'],
    replace: ['filename', 'force', 'grace-period', 'dry-run', 'output', 'wait', 'cascade', 'validate', 'save-config'],
    wait: ['for', 'timeout', 'selector', 'all', 'all-namespaces', 'filename', 'field-selector', 'local'],
    events: ['for', 'types', 'watch', 'all-namespaces', 'output', 'no-headers', 'chunk-size'],
    kustomize: [], cp: [], attach: [], proxy: [], certificate: [], completion: [], plugin: [], alpha: [], options: [], help: [],
  };

  function parseArgs(argv, cmd) {
    const flags = {};
    const pos = [];
    let dash = null;
    const over = BOOL_OVERRIDES[cmd] || {};
    const takesValue = name => VALUE_FLAGS.has(name) && !(cmd === 'logs' && (name === 'follow' || name === 'previous'));
    const setFlag = (name, val) => {
      if (MULTI.has(name)) (flags[name] = flags[name] || []).push(val);
      else flags[name] = val;
    };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { dash = argv.slice(i + 1); break; }
      if (a.startsWith('--') && a.length > 2) {
        let name = a.slice(2), val;
        const eq = name.indexOf('=');
        if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
        if (val === undefined && takesValue(name) && !(name === 'dry-run' && (argv[i + 1] == null || !/^(client|server|none)$/.test(argv[i + 1]))) && !(name === 'record')) {
          if (i + 1 >= argv.length) return { error: `error: flag needs an argument: --${name}` };
          val = argv[++i];
        }
        if (val === undefined) val = name === 'dry-run' ? 'client' : true;
        if (val === 'true') val = true;
        if (val === 'false') val = false;
        setFlag(name, val);
        continue;
      }
      if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
        const ch = a[1];
        const long = over[ch] || SHORT[ch];
        if (!long) return { error: `error: unknown shorthand flag: '${ch}' in ${a}` };
        if (takesValue(long)) {
          let val = a.length > 2 ? a.slice(2).replace(/^=/, '') : argv[++i];
          if (val == null) return { error: `error: flag needs an argument: '${ch}' in -${ch}` };
          setFlag(long, val);
        } else {
          for (const c2 of a.slice(1)) {
            const l2 = over[c2] || SHORT[c2];
            if (!l2) return { error: `error: unknown shorthand flag: '${c2}' in ${a}` };
            setFlag(l2, true);
          }
        }
        continue;
      }
      pos.push(a);
    }
    // validate flag names
    const allowed = new Set(GLOBAL_FLAGS.concat(CMD_FLAGS[cmd] || []));
    for (const f of Object.keys(flags)) {
      if (!allowed.has(f) && CMD_FLAGS[cmd]) return { error: `error: unknown flag: --${f}\nSee 'kubectl ${cmd} --help' for usage.` };
    }
    return { flags, pos, dash };
  }
  const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const last = v => (Array.isArray(v) ? v[v.length - 1] : v);

  // ------------------------------------------------------------------ helpers
  const refName = o => { const r = KS.BY_KIND[o.kind]; return `${r.singular}${r.group ? '.' + r.group : ''}/${o.metadata.name}`; };
  const resName = r => `${r.plural}${r.group ? '.' + r.group : ''}`;
  const kindRef = r => `${r.singular}${r.group ? '.' + r.group : ''}`;
  const ALL_KINDS = ['Pod', 'Service', 'DaemonSet', 'Deployment', 'ReplicaSet', 'StatefulSet', 'HorizontalPodAutoscaler', 'CronJob', 'Job'];
  const API_VERSIONS = {
    Pod: ['v1'], Service: ['v1'], ConfigMap: ['v1'], Secret: ['v1'], Namespace: ['v1'], Node: ['v1'], ServiceAccount: ['v1'], PersistentVolume: ['v1'], PersistentVolumeClaim: ['v1'], Endpoints: ['v1'], Event: ['v1', 'events.k8s.io/v1'], ResourceQuota: ['v1'], LimitRange: ['v1'],
    Deployment: ['apps/v1'], ReplicaSet: ['apps/v1'], DaemonSet: ['apps/v1'], StatefulSet: ['apps/v1'],
    Job: ['batch/v1'], CronJob: ['batch/v1'], HorizontalPodAutoscaler: ['autoscaling/v2', 'autoscaling/v1'],
    Ingress: ['networking.k8s.io/v1'], IngressClass: ['networking.k8s.io/v1'], NetworkPolicy: ['networking.k8s.io/v1'],
    StorageClass: ['storage.k8s.io/v1'], Role: ['rbac.authorization.k8s.io/v1'], RoleBinding: ['rbac.authorization.k8s.io/v1'], ClusterRole: ['rbac.authorization.k8s.io/v1'], ClusterRoleBinding: ['rbac.authorization.k8s.io/v1'],
    PodDisruptionBudget: ['policy/v1'], PriorityClass: ['scheduling.k8s.io/v1'],
  };
  function containerNameFromImage(image) {
    const p = R.parseRef(image);
    return p.repo.split('/').pop().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'container';
  }
  function podStatus(pod, c) {
    const st = pod.status || {};
    let restarts = 0, ready = 0, lastRestart = 0;
    let reason = st.reason || st.phase;
    let initializing = false;
    const inits = st.initContainerStatuses || [];
    const specInits = pod.spec.initContainers || [];
    const sidecars = specInits.filter(s => s.restartPolicy === 'Always').map(s => s.name);
    let total = pod.spec.containers.length + sidecars.length;
    const noteRestart = cs => { if (cs.lastState && cs.lastState.terminated && cs.lastState.terminated.finishedAt) lastRestart = Math.max(lastRestart, Date.parse(cs.lastState.terminated.finishedAt)); };
    for (let i = 0; i < inits.length; i++) {
      const cs = inits[i];
      restarts += cs.restartCount; noteRestart(cs);
      if (sidecars.includes(cs.name)) { if (cs.started) { if (cs.ready) ready++; continue; } }
      const t = cs.state.terminated, w = cs.state.waiting;
      if (t && t.exitCode === 0) continue;
      if (t) reason = t.reason ? 'Init:' + t.reason : 'Init:ExitCode:' + t.exitCode;
      else if (w && w.reason && w.reason !== 'PodInitializing') reason = 'Init:' + w.reason;
      else reason = `Init:${i}/${specInits.length}`;
      initializing = true;
      break;
    }
    if (!initializing) {
      restarts = inits.filter(cs => sidecars.includes(cs.name)).reduce((s, cs) => s + cs.restartCount, 0);
      let hasRunning = false;
      const cs = st.containerStatuses || [];
      for (let i = cs.length - 1; i >= 0; i--) {
        const x = cs[i];
        restarts += x.restartCount; noteRestart(x);
        if (x.state.waiting && x.state.waiting.reason) reason = x.state.waiting.reason;
        else if (x.state.terminated && x.state.terminated.reason) reason = x.state.terminated.reason;
        else if (x.state.terminated) reason = 'ExitCode:' + x.state.terminated.exitCode;
        else if (x.state.running && x.ready) { hasRunning = true; ready++; }
        else if (x.state.running) hasRunning = true;
      }
      if (reason === 'Completed' && hasRunning) reason = H.isReady(pod) ? 'Running' : 'NotReady';
    }
    if (pod.metadata.deletionTimestamp) reason = st.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
    if (!pod.spec.nodeName && !pod.metadata.deletionTimestamp && st.phase === 'Pending') reason = 'Pending';
    const rs = lastRestart && restarts ? `${restarts} (${U.humanDuration(c.now - lastRestart)} ago)` : String(restarts);
    return { status: reason, ready: `${ready}/${total}`, restarts: rs };
  }
  KS.podStatus = podStatus;

  // ------------------------------------------------------------------ table printers
  function svcPorts(s) {
    if (s.spec.type === 'ExternalName' && !(s.spec.ports || []).length) return '<none>';
    return (s.spec.ports || []).map(p => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol}`).join(',') || '<none>';
  }
  function svcExternal(s) {
    if (s.spec.type === 'ExternalName') return s.spec.externalName;
    if (s.spec.type === 'LoadBalancer') { const ing = (s.status.loadBalancer || {}).ingress || []; return ing.length ? ing.map(i => i.ip).join(',') : '<pending>'; }
    return (s.spec.externalIPs || []).join(',') || '<none>';
  }
  const AM = { ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' };
  function printer(kind, c, wide) {
    const age = o => c.age(o);
    const containers = t => t.spec.containers.map(x => x.name).join(',');
    const images = t => t.spec.containers.map(x => x.image).join(',');
    switch (kind) {
      case 'Pod': return { h: ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'].concat(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : []), row: p => { const s = podStatus(p, c); return [p.metadata.name, s.ready, s.status, s.restarts, age(p)].concat(wide ? [p.status.podIP || '<none>', p.spec.nodeName || '<none>', p.status.nominatedNodeName || '<none>', '<none>'] : []); } };
      case 'Node': return { h: ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'].concat(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : []), row: n => { const rc = H.cond(n, 'Ready'); let s = rc && rc.status === 'True' ? 'Ready' : 'NotReady'; if (n.spec.unschedulable) s += ',SchedulingDisabled'; const roles = Object.keys(n.metadata.labels).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).join(',') || '<none>'; const ni = n.status.nodeInfo; return [n.metadata.name, s, roles, age(n), ni.kubeletVersion].concat(wide ? [c.nodeIP(n.metadata.name), '<none>', ni.osImage, ni.kernelVersion, ni.containerRuntimeVersion] : []); } };
      case 'Deployment': return { h: ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []), row: d => [d.metadata.name, `${d.status.readyReplicas || 0}/${d.spec.replicas}`, d.status.updatedReplicas || 0, d.status.availableReplicas || 0, age(d)].concat(wide ? [containers(d.spec.template), images(d.spec.template), U.selectorToString(d.spec.selector)] : []) };
      case 'ReplicaSet': return { h: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []), row: r => [r.metadata.name, r.spec.replicas, (r.status || {}).replicas || 0, (r.status || {}).readyReplicas || 0, age(r)].concat(wide ? [containers(r.spec.template), images(r.spec.template), U.selectorToString(r.spec.selector)] : []) };
      case 'DaemonSet': return { h: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []), row: d => { const s = d.status || {}; return [d.metadata.name, s.desiredNumberScheduled || 0, s.currentNumberScheduled || 0, s.numberReady || 0, s.updatedNumberScheduled || 0, s.numberAvailable || 0, d.spec.template.spec.nodeSelector ? U.labelsToString(d.spec.template.spec.nodeSelector) : '<none>', age(d)].concat(wide ? [containers(d.spec.template), images(d.spec.template), U.selectorToString(d.spec.selector)] : []); } };
      case 'StatefulSet': return { h: ['NAME', 'READY', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES'] : []), row: s => [s.metadata.name, `${(s.status || {}).readyReplicas || 0}/${s.spec.replicas}`, age(s)].concat(wide ? [containers(s.spec.template), images(s.spec.template)] : []) };
      case 'Service': return { h: ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'].concat(wide ? ['SELECTOR'] : []), row: s => [s.metadata.name, s.spec.type, s.spec.type === 'ExternalName' ? '<none>' : s.spec.clusterIP, svcExternal(s), svcPorts(s), age(s)].concat(wide ? [s.spec.selector ? Object.keys(s.spec.selector).map(k => `${k}=${s.spec.selector[k]}`).join(',') : '<none>'] : []) };
      case 'Endpoints': return { h: ['NAME', 'ENDPOINTS', 'AGE'], row: e => { const list = (e.subsets || []).flatMap(s => (s.addresses || []).flatMap(a => s.ports.map(p => `${a.ip}:${p.port}`))); const shown = list.slice(0, 3).join(',') + (list.length > 3 ? ` + ${list.length - 3} more...` : ''); return [e.metadata.name, shown || '<none>', age(e)]; } };
      case 'ConfigMap': return { h: ['NAME', 'DATA', 'AGE'], row: m => [m.metadata.name, Object.keys(m.data || {}).length + Object.keys(m.binaryData || {}).length, age(m)] };
      case 'Secret': return { h: ['NAME', 'TYPE', 'DATA', 'AGE'], row: s => [s.metadata.name, s.type, Object.keys(s.data || {}).length, age(s)] };
      case 'Namespace': return { h: ['NAME', 'STATUS', 'AGE'], row: n => [n.metadata.name, n.status.phase, age(n)] };
      case 'ServiceAccount': return { h: ['NAME', 'SECRETS', 'AGE'], row: s => [s.metadata.name, (s.secrets || []).length, age(s)] };
      case 'Job': return { h: ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []), row: j => { const st = j.status || {}; const done = (st.conditions || []).find(x => (x.type === 'Complete' || x.type === 'Failed') && x.status === 'True'); const status = done ? done.type : j.spec.suspend ? 'Suspended' : 'Running'; const dur = st.startTime ? U.humanDuration((st.completionTime ? Date.parse(st.completionTime) : c.now) - Date.parse(st.startTime)) : ''; return [j.metadata.name, status, `${st.succeeded || 0}/${j.spec.completions == null ? 1 : j.spec.completions}`, dur, age(j)].concat(wide ? [containers(j.spec.template), images(j.spec.template), U.selectorToString(j.spec.selector)] : []); } };
      case 'CronJob': return { h: ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE'].concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []), row: j => [j.metadata.name, j.spec.schedule, j.spec.timeZone || '<none>', j.spec.suspend ? 'True' : 'False', ((j.status || {}).active || []).length, (j.status || {}).lastScheduleTime ? U.humanDuration(c.now - Date.parse(j.status.lastScheduleTime)) : '<none>', age(j)].concat(wide ? [containers(j.spec.jobTemplate.spec.template), images(j.spec.jobTemplate.spec.template), '<none>'] : []) };
      case 'PersistentVolumeClaim': return { h: ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE'].concat(wide ? ['VOLUMEMODE'] : []), row: p => [p.metadata.name, p.metadata.deletionTimestamp ? 'Terminating' : p.status.phase, p.spec.volumeName || '', (p.status.capacity || {}).storage || '', (p.status.accessModes || []).map(m => AM[m]).join(','), p.spec.storageClassName || '', '<unset>', age(p)].concat(wide ? [p.spec.volumeMode] : []) };
      case 'PersistentVolume': return { h: ['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'REASON', 'AGE'].concat(wide ? ['VOLUMEMODE'] : []), row: p => [p.metadata.name, p.spec.capacity.storage, (p.spec.accessModes || []).map(m => AM[m]).join(','), p.spec.persistentVolumeReclaimPolicy, p.metadata.deletionTimestamp ? 'Terminating' : p.status.phase, p.spec.claimRef ? `${p.spec.claimRef.namespace}/${p.spec.claimRef.name}` : '', p.spec.storageClassName || '', '<unset>', '', age(p)].concat(wide ? [p.spec.volumeMode] : []) };
      case 'StorageClass': return { h: ['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'], row: s => [s.metadata.name + ((s.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true' ? ' (default)' : ''), s.provisioner, s.reclaimPolicy, s.volumeBindingMode, String(!!s.allowVolumeExpansion), age(s)] };
      case 'Ingress': return { h: ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'], row: i => [i.metadata.name, i.spec.ingressClassName || '<none>', (i.spec.rules || []).map(r => r.host || '*').join(',') || '*', ((i.status.loadBalancer || {}).ingress || []).map(x => x.ip).join(','), (i.spec.tls || []).length ? '80, 443' : '80', age(i)] };
      case 'IngressClass': return { h: ['NAME', 'CONTROLLER', 'PARAMETERS', 'AGE'], row: i => [i.metadata.name, i.spec.controller, '<none>', age(i)] };
      case 'HorizontalPodAutoscaler': return { h: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'], row: h => { const st = h.status || {}; const t = (h.spec.metrics || []).map((m, i) => { const cur = ((st.currentMetrics || [])[i] || {}).resource; const tg = m.resource.target; const cv = cur && cur.current ? (tg.type === 'Utilization' ? (cur.current.averageUtilization != null ? cur.current.averageUtilization + '%' : '<unknown>') : (cur.current.averageValue || '<unknown>')) : '<unknown>'; return `${m.resource.name}: ${cv}/${tg.type === 'Utilization' ? tg.averageUtilization + '%' : tg.averageValue}`; }).join(', ') || '<none>'; return [h.metadata.name, `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`, t, h.spec.minReplicas, h.spec.maxReplicas, st.currentReplicas || 0, age(h)]; } };
      case 'NetworkPolicy': return { h: ['NAME', 'POD-SELECTOR', 'AGE'], row: n => [n.metadata.name, (Object.keys((n.spec.podSelector || {}).matchLabels || {}).length || ((n.spec.podSelector || {}).matchExpressions || []).length) ? U.selectorToString(n.spec.podSelector) : '<none>', age(n)] };
      case 'Role': case 'ClusterRole': case 'LimitRange': return { h: ['NAME', 'CREATED AT'], row: r => [r.metadata.name, r.metadata.creationTimestamp] };
      case 'RoleBinding': case 'ClusterRoleBinding': return { h: ['NAME', 'ROLE', 'AGE'].concat(wide ? ['USERS', 'GROUPS', 'SERVICEACCOUNTS'] : []), row: b => [b.metadata.name, `${b.roleRef.kind}/${b.roleRef.name}`, age(b)].concat(wide ? [(b.subjects || []).filter(s => s.kind === 'User').map(s => s.name).join(', '), (b.subjects || []).filter(s => s.kind === 'Group').map(s => s.name).join(', '), (b.subjects || []).filter(s => s.kind === 'ServiceAccount').map(s => `${s.namespace}/${s.name}`).join(', ')] : []) };
      case 'PodDisruptionBudget': return { h: ['NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'], row: p => [p.metadata.name, p.spec.minAvailable != null ? p.spec.minAvailable : 'N/A', p.spec.maxUnavailable != null ? p.spec.maxUnavailable : 'N/A', (p.status || {}).disruptionsAllowed || 0, age(p)] };
      case 'ResourceQuota': return { h: ['NAME', 'AGE', 'REQUEST', 'LIMIT'], row: q => { const hard = q.spec.hard || {}, used = (q.status || {}).used || {}; const req = Object.keys(hard).filter(k => !k.startsWith('limits.')).sort().map(k => `${k}: ${used[k] || 0}/${hard[k]}`).join(', '); const lim = Object.keys(hard).filter(k => k.startsWith('limits.')).sort().map(k => `${k}: ${used[k] || 0}/${hard[k]}`).join(', '); return [q.metadata.name, age(q), req, lim]; } };
      case 'PriorityClass': return { h: ['NAME', 'VALUE', 'GLOBAL-DEFAULT', 'AGE', 'PREEMPTIONPOLICY'], row: p => [p.metadata.name, p.value, String(!!p.globalDefault), age(p), p.preemptionPolicy || 'PreemptLowerPriority'] };
      case 'Event': return { h: ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], row: e => [U.humanDuration(c.now - Date.parse(e.lastTimestamp)), e.type, e.reason, `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`, e.message] };
      default: return { h: ['NAME', 'AGE'], row: o => [o.metadata.name, age(o)] };
    }
  }

  // field selectors
  function fieldValue(o, key) {
    switch (key) {
      case 'metadata.name': return o.metadata.name;
      case 'metadata.namespace': return o.metadata.namespace;
      case 'status.phase': return o.status && o.status.phase;
      case 'spec.nodeName': return o.spec && o.spec.nodeName || '';
      case 'spec.restartPolicy': return o.spec && o.spec.restartPolicy;
      case 'spec.schedulerName': return o.spec && o.spec.schedulerName;
      case 'spec.serviceAccountName': return o.spec && o.spec.serviceAccountName;
      case 'status.podIP': return o.status && o.status.podIP;
      case 'type': return o.type;
      case 'reason': return o.reason;
      case 'involvedObject.name': return o.involvedObject && o.involvedObject.name;
      case 'involvedObject.kind': return o.involvedObject && o.involvedObject.kind;
      case 'spec.unschedulable': return String(!!(o.spec && o.spec.unschedulable));
      case 'status.successful': return String((o.status && o.status.succeeded) || 0);
      default: return undefined;
    }
  }
  function parseFieldSelector(s, kind) {
    const out = [];
    for (const part of String(s).split(',')) {
      const m = part.match(/^([\w.]+)\s*(==|=|!=)\s*(.*)$/);
      if (!m) return { error: `error: invalid selector: '${part}'; can't understand '${part}'` };
      const probe = fieldValue({ metadata: {}, spec: {}, status: {}, involvedObject: {} }, m[1]);
      if (probe === undefined && !['type', 'reason'].includes(m[1])) return { error: `Error from server (BadRequest): Unable to find "${KS.BY_KIND[kind].group ? KS.BY_KIND[kind].group + '/' : ''}${KS.BY_KIND[kind].apiVersion.split('/').pop()}, Resource=${KS.BY_KIND[kind].plural}" that match label selector "", field selector "${s}": "${m[1]}" is not a known field selector: only "metadata.name", "metadata.namespace"` };
      out.push({ key: m[1], neg: m[2] === '!=', val: m[3] });
    }
    return { list: out };
  }

  // ======================================================================== Kubectl
  class Kubectl {
    constructor(cluster, env) {
      this.c = cluster;
      this.env = env || {}; // { fs, cwd, readFile(path), writeFile(path, text), openEditor }
    }
    get ns() { return this.c.context.namespace || 'default'; }

    run(argv, io) {
      const cmd = argv[0];
      if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { io.out(HELP); return { code: 0 }; }
      if (cmd === 'version' && !argv.includes('--client')) { /* handled below */ }
      const handler = this['cmd_' + cmd.replace(/-/g, '_')];
      if (!handler) {
        const cands = Object.keys(CMD_FLAGS);
        const best = cands.map(x => [x, lev(x, cmd)]).sort((a, b) => a[1] - b[1])[0];
        io.err(`error: unknown command "${cmd}" for "kubectl"${best && best[1] <= 2 ? `\n\nDid you mean this?\n\t${best[0]}` : ''}\n`);
        return { code: 1 };
      }
      const p = parseArgs(argv.slice(1), cmd);
      if (p.error) { io.err(p.error + '\n'); return { code: 1 }; }
      if (p.flags.help) { io.out(`(Kubester) Help for "kubectl ${cmd}" — see the Cheat sheet tab, or try "kubectl explain".\n`); return { code: 0 }; }
      const prevUser = this.user;
      this.user = this.c.userInfo(p.flags.as);
      this.nsFlag = p.flags.namespace;
      if (this.nsFlag && this.nsFlag !== true && !U.validName(String(this.nsFlag)) ) { /* fall through, server reports */ }
      try {
        const r = handler.call(this, p.pos, p.flags, io, p.dash, argv) || { code: 0 };
        return r;
      } catch (e) {
        io.err(`error: ${e.message}\n`);
        if (typeof console !== 'undefined' && !/^(validation|kubester)/.test(e.message)) console.error(e);
        return { code: 1 };
      } finally {
        this.user = prevUser;
      }
    }
    getc(kind, ns, name) { const o = this.c.get(kind, ns, name); return o ? U.clone(o) : null; }
    nsOf(flags) { return flags.namespace && flags.namespace !== true ? String(flags.namespace) : this.ns; }
    can(verb, res, ns, name, sub) {
      const a = this.c.authorize(this.user, verb, res, res.namespaced ? ns : null, name, sub);
      return a.allowed ? null : this.c.forbiddenMsg(this.user, verb, res, ns, name, sub);
    }
    emitRead(kind, ns) { this.c.emit('api', { verb: 'get', kind, ns }); }

    // resolve "pods web", "pod/web", "deploy,svc", "all"
    resolveTargets(pos) {
      if (!pos.length) return { error: 'error: You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.' };
      const groups = [];
      if (pos[0].includes('/')) {
        for (const p of pos) {
          const [t, n] = p.split('/');
          if (!n) return { error: `error: arguments in resource/name form must have a single resource and name` };
          const r = KS.lookupResource(t);
          if (!r) return { error: `error: the server doesn't have a resource type "${t}"` };
          let g = groups.find(x => x.res === r);
          if (!g) groups.push((g = { res: r, names: [] }));
          g.names.push(n);
        }
        return { groups, explicit: true };
      }
      const types = pos[0].split(',').filter(Boolean);
      const names = pos.slice(1);
      for (const t of types) {
        if (t === 'all') { ALL_KINDS.forEach(k => groups.push({ res: KS.BY_KIND[k], names: names.slice(), fromAll: true })); continue; }
        const r = KS.lookupResource(t);
        if (!r) return { error: `error: the server doesn't have a resource type "${t}"` };
        groups.push({ res: r, names: names.slice() });
      }
      return { groups, multi: types.length > 1 || types.includes('all') };
    }
    selectObjects(res, ns, all, names, flags) {
      let objs;
      if (names && names.length) {
        objs = [];
        const missing = [];
        for (const n of names) {
          const o = this.c.get(res.kind, ns, n);
          if (o) objs.push(o); else missing.push(n);
        }
        return { objs, missing };
      }
      objs = this.c.list(res.kind, res.namespaced && !all ? ns : undefined);
      if (flags.selector) {
        let sel;
        try { sel = U.parseSelectorString(String(last(flags.selector))); } catch (e) { return { error: 'error: ' + e.message }; }
        objs = objs.filter(o => U.matchSelector(sel, o.metadata.labels || {}) || (!Object.keys(sel.matchLabels).length && !sel.matchExpressions.length));
      }
      if (flags['field-selector']) {
        const fs = parseFieldSelector(flags['field-selector'], res.kind);
        if (fs.error) return { error: fs.error };
        objs = objs.filter(o => fs.list.every(f => (String(fieldValue(o, f.key)) === f.val) !== f.neg));
      }
      return { objs, missing: [] };
    }

    // =================================================================== get
    cmd_get(pos, flags, io) {
      if (flags.filename) return this.withFiles(flags, io, (docs) => { const objs = []; for (const d of docs) { const o = this.c.get(d.kind, d.metadata.namespace || this.nsOf(flags), d.metadata.name); if (o) objs.push(o); else io.err(`Error from server (NotFound): ${resName(KS.BY_KIND[d.kind])} "${d.metadata.name}" not found\n`); } return this.printObjects(objs, flags, io, { mixed: true }); });
      const t = this.resolveTargets(pos);
      if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
      const ns = this.nsOf(flags);
      const all = !!flags['all-namespaces'];
      if (flags.watch || flags['watch-only']) return this.watchGet(t, ns, all, flags, io);
      const output = flags.output ? String(flags.output) : '';
      let code = 0;
      const collected = [];
      let printedAny = false;
      for (const g of t.groups) {
        const verb = g.names.length ? 'get' : 'list';
        const deny = this.can(verb, g.res, ns, g.names[0]);
        if (deny) { io.err(deny + '\n'); code = 1; continue; }
        if (!g.res.namespaced && g.names.length === 0 && false) continue;
        const sel = this.selectObjects(g.res, ns, all, g.names, flags);
        if (sel.error) { io.err(sel.error + '\n'); return { code: 1 }; }
        sel.missing.forEach(n => { if (!flags['ignore-not-found']) { io.err(`Error from server (NotFound): ${resName(g.res)} "${n}" not found\n`); code = 1; } });
        this.emitRead(g.res.kind, ns);
        let objs = sel.objs;
        if (g.fromAll && g.res.kind === 'Service' && false) objs = [];
        if (output || !t.multi) { collected.push(...objs); continue; }
        if (!objs.length) continue;
        if (printedAny) io.out('\n');
        this.printTable(g.res.kind, objs, flags, io, { prefix: true, all });
        printedAny = true;
      }
      if (t.multi && !output) {
        if (!printedAny && code === 0) io.err(all ? 'No resources found\n' : `No resources found in ${ns} namespace.\n`);
        return { code };
      }
      if (!collected.length && code === 0 && !output) {
        const r = t.groups[0].res;
        io.err(r.namespaced && !all ? `No resources found in ${ns} namespace.\n` : 'No resources found\n');
        return { code };
      }
      if (!collected.length && output && /^(yaml|json)$/.test(output) && !t.explicit && !t.groups[0].names.length) {
        io.out(output === 'json' ? toJson({ apiVersion: 'v1', items: [], kind: 'List', metadata: { resourceVersion: '' } }) + '\n' : toYaml({ apiVersion: 'v1', items: [], kind: 'List', metadata: { resourceVersion: '' } }));
        return { code };
      }
      if (!collected.length) return { code };
      const single = (t.explicit && collected.length === 1) || (t.groups.length === 1 && t.groups[0].names.length === 1);
      const r = this.printObjects(collected, flags, io, { single, kind: t.groups.length === 1 ? t.groups[0].res.kind : null, all, prefix: t.explicit && t.groups.length > 1 });
      return { code: r && r.code ? r.code : code };
    }
    printObjects(objs, flags, io, opts) {
      const output = flags.output ? String(flags.output) : '';
      if (flags['sort-by']) {
        const path = String(flags['sort-by']).replace(/^\{|\}$/g, '');
        objs = objs.slice().sort((a, b) => {
          const va = jpEval(path, a)[0], vb = jpEval(path, b)[0];
          if (typeof va === 'number' && typeof vb === 'number') return va - vb;
          const qa = /^\d+(\.\d+)?[mKMG]?i?$/.test(String(va)), qb = /^\d+(\.\d+)?[mKMG]?i?$/.test(String(vb));
          if (qa && qb) return U.parseMem(String(va).replace(/m$/, '')) - U.parseMem(String(vb).replace(/m$/, ''));
          return String(va == null ? '' : va).localeCompare(String(vb == null ? '' : vb));
        });
      }
      if (!output || output === 'wide') {
        const kinds = [...new Set(objs.map(o => o.kind))];
        kinds.forEach((k, i) => { if (i) io.out('\n'); this.printTable(k, objs.filter(o => o.kind === k), flags, io, { prefix: opts.prefix || kinds.length > 1, all: opts.all }); });
        return { code: 0 };
      }
      const clean = o => U.clone(o);
      if (output === 'yaml' || output === 'json') {
        const data = opts.single && objs.length === 1 ? clean(objs[0]) : { apiVersion: 'v1', items: objs.map(clean), kind: 'List', metadata: { resourceVersion: '' } };
        io.out(output === 'json' ? toJson(data) + '\n' : toYaml(data));
        return { code: 0 };
      }
      if (output === 'name') { objs.forEach(o => io.out(refName(o) + '\n')); return { code: 0 }; }
      let m;
      if ((m = output.match(/^jsonpath(-as-json)?=(.*)$/s)) || (m = output.match(/^(jsonpath)()$/))) {
        let tpl = m[2];
        if (!tpl) { io.err('error: template format specified but no template given\n'); return { code: 1 }; }
        tpl = tpl.replace(/^'(.*)'$/s, '$1');
        if (!tpl.includes('{')) tpl = '{' + tpl + '}';
        const data = opts.single && objs.length === 1 ? clean(objs[0]) : { apiVersion: 'v1', items: objs.map(clean), kind: 'List', metadata: { resourceVersion: '' } };
        try { io.out(jsonpathTemplate(tpl, data)); } catch (e) { io.err(`error: error parsing jsonpath ${tpl}, ${e.message}\n`); return { code: 1 }; }
        return { code: 0 };
      }
      if ((m = output.match(/^custom-columns=(.*)$/))) {
        const cols = m[1].split(',').map(x => { const i = x.indexOf(':'); return { h: x.slice(0, i), p: x.slice(i + 1) }; });
        if (cols.some(x => !x.h || !x.p)) { io.err(`error: custom-columns format specified but no custom columns given\n`); return { code: 1 }; }
        const rows = objs.map(o => cols.map(col => { const v = jpEval(col.p.replace(/^\{|\}$/g, ''), o); return v.length ? v.map(jpStr).join(',') : '<none>'; }));
        const lines = U.table(cols.map(x => x.h), rows);
        (flags['no-headers'] ? lines.slice(1) : lines).forEach(l => io.out(l + '\n'));
        return { code: 0 };
      }
      io.err(`error: unable to match a printer suitable for the output format "${output}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml\n`);
      return { code: 1 };
    }
    tableRows(kind, objs, flags, opts) {
      const wide = String(flags.output || '') === 'wide';
      const p = printer(kind, this.c, wide);
      let h = p.h.slice();
      const lc = arr(flags['label-columns']).flatMap(x => String(x).split(','));
      const rows = objs.map(o => {
        let r = p.row(o);
        if (opts.prefix) r[0] = `${kindRef(KS.BY_KIND[kind])}/${r[0]}`;
        lc.forEach(k => r.push((o.metadata.labels || {})[k] || ''));
        if (flags['show-labels']) r.push(U.labelsToString(o.metadata.labels));
        if (opts.all && KS.BY_KIND[kind].namespaced) r = [o.metadata.namespace].concat(r);
        return r;
      });
      lc.forEach(k => h.push(k.split('/').pop().toUpperCase()));
      if (flags['show-labels']) h.push('LABELS');
      if (opts.all && KS.BY_KIND[kind].namespaced) h = ['NAMESPACE'].concat(h);
      return { h, rows };
    }
    printTable(kind, objs, flags, io, opts) {
      const { h, rows } = this.tableRows(kind, objs, flags, opts || {});
      const lines = U.table(h, rows);
      (flags['no-headers'] ? lines.slice(1) : lines).forEach(l => io.out(l + '\n'));
    }
    watchGet(t, ns, all, flags, io) {
      const g = t.groups[0];
      const self = this;
      const last = {};
      const render = initial => {
        const sel = self.selectObjects(g.res, ns, all, g.names, flags);
        if (sel.error) return;
        const { h, rows } = self.tableRows(g.res.kind, sel.objs, flags, { all, prefix: false });
        const widths = h.map((x, i) => Math.max(x.length, ...rows.map(r => String(r[i]).length), (self.watchWidths || [])[i] || 0));
        self.watchWidths = widths;
        const fmt = r => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i] + 3))).join('').replace(/\s+$/, '');
        const seen = new Set();
        if (initial && !flags['watch-only']) {
          if (!rows.length) io.err(`No resources found in ${ns} namespace.\n`);
          else io.out(fmt(h) + '\n');
        }
        sel.objs.forEach((o, i) => {
          const key = o.metadata.uid;
          seen.add(key);
          const line = fmt(rows[i]);
          const cmpLine = rows[i].slice(0, -1).map(x => String(x).replace(/ \(\S+ ago\)$/, '')).join('|');
          if (last[key] !== cmpLine) {
            if (!(initial && flags['watch-only'])) io.out(line + '\n');
            last[key] = cmpLine;
          }
        });
        Object.keys(last).forEach(k => { if (!seen.has(k)) delete last[k]; });
      };
      render(true);
      return { code: 0, task: { tick() { render(false); return false; }, cancel() {} } };
    }

    // =================================================================== describe
    cmd_describe(pos, flags, io) {
      const ns = this.nsOf(flags);
      if (flags.filename) return this.withFiles(flags, io, docs => { docs.forEach((d, i) => { const o = this.c.get(d.kind, d.metadata.namespace || ns, d.metadata.name); if (o) io.out((i ? '\n\n' : '') + KS.describe(this.c, o) + '\n'); }); return { code: 0 }; });
      if (!pos.length) { io.err('error: You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.\n'); return { code: 1 }; }
      const t = this.resolveTargets(pos);
      if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
      let first = true, code = 0;
      for (const g of t.groups) {
        const deny = this.can('get', g.res, ns);
        if (deny) { io.err(deny + '\n'); code = 1; continue; }
        let objs;
        if (g.names.length) {
          objs = [];
          for (const n of g.names) {
            let o = this.c.get(g.res.kind, ns, n);
            if (!o) {
              // describe matches name prefixes
              const pre = this.c.list(g.res.kind, g.res.namespaced ? ns : undefined).filter(x => x.metadata.name.startsWith(n));
              if (pre.length) { objs.push(...pre); continue; }
              io.err(`Error from server (NotFound): ${resName(g.res)} "${n}" not found\n`); code = 1; continue;
            }
            objs.push(o);
          }
        } else {
          const sel = this.selectObjects(g.res, ns, !!flags['all-namespaces'], [], flags);
          if (sel.error) { io.err(sel.error + '\n'); return { code: 1 }; }
          objs = sel.objs;
          if (!objs.length && !t.multi) io.err(`No resources found in ${ns} namespace.\n`);
        }
        this.emitRead(g.res.kind, ns);
        for (const o of objs) { io.out((first ? '' : '\n\n') + KS.describe(this.c, o) + '\n'); first = false; }
      }
      return { code };
    }

    // =================================================================== files
    readSource(f, io) {
      if (f === '-') return { files: [{ name: 'STDIN', text: io.stdin || '' }] };
      if (/^https?:\/\//.test(f)) {
        const t = KS.REMOTE_MANIFESTS && KS.REMOTE_MANIFESTS[f];
        if (t == null) return { error: `error: unable to read URL "${f}", server reported 404 Not Found, status code=404\n(Kubester only knows a few public manifest URLs; download the file content into a local file instead.)` };
        return { files: [{ name: f, text: t, url: true }] };
      }
      const fs = this.env.fs;
      const path = R.normPath(f, this.env.cwd ? this.env.cwd() : '/home/learner');
      const content = fs.read(path);
      if (content != null) return { files: [{ name: f, text: content }] };
      if (fs.isDir(path)) {
        const names = fs.list(path).filter(n => /\.(ya?ml|json)$/.test(n));
        if (!names.length) return { error: `error: error reading [${f}]: recognized file extensions are [.json .yaml .yml]` };
        return { files: names.map(n => ({ name: (f.replace(/\/$/, '')) + '/' + n, text: fs.read(path + '/' + n) })) };
      }
      return { error: `error: the path "${f}" does not exist` };
    }
    loadDocs(flags, io) {
      const files = arr(flags.filename);
      if (!files.length && !flags.kustomize) return { error: 'error: must specify one of -f and -k' };
      const out = [];
      if (flags.kustomize) {
        const r = KS.kustomize ? KS.kustomize(this, String(flags.kustomize)) : { error: 'error: kustomize not available' };
        if (r.error) return { error: r.error };
        r.docs.forEach(d => out.push({ doc: d, source: String(flags.kustomize) }));
      }
      for (const f of files) {
        const src = this.readSource(String(f), io);
        if (src.error) return { error: src.error };
        for (const file of src.files) {
          if (file.url && /ingress-nginx/.test(file.name)) { out.push({ special: 'ingress-nginx', source: file.name }); continue; }
          const p = parseDocs(file.text, file.name);
          if (p.error) return { error: p.error };
          for (const d of p.docs) {
            if (!d || typeof d !== 'object') return { error: `error: error validating "${file.name}": error validating data: invalid object to validate; if you choose to ignore these errors, turn validation off with --validate=false` };
            const missing = [];
            if (!d.apiVersion) missing.push('apiVersion not set');
            if (!d.kind) missing.push('kind not set');
            if (missing.length) return { error: `error: error validating "${file.name}": error validating data: [${missing.join(', ')}]; if you choose to ignore these errors, turn validation off with --validate=false` };
            const r = KS.BY_KIND[d.kind];
            if (!r || !(API_VERSIONS[d.kind] || []).includes(d.apiVersion)) {
              return { error: `error: resource mapping not found for name: "${(d.metadata || {}).name || ''}" namespace: "${(d.metadata || {}).namespace || ''}" from "${file.name}": no matches for kind "${d.kind}" in version "${d.apiVersion}"\nensure CRDs are installed first` };
            }
            if (!d.metadata || !d.metadata.name) { if (!(d.metadata && d.metadata.generateName)) return { error: `error: error when retrieving current configuration of:\nResource: "${resName(r)}", GroupVersionKind: "${d.apiVersion}, Kind=${d.kind}"\nName: "", Namespace: "${this.nsOf(flags)}"\nfrom server for: "${file.name}": resource name may not be empty` }; }
            const uf = KS.unknownField(d);
            if (uf) return { error: `Error from server (BadRequest): error when creating "${file.name}": ${d.kind} in version "${d.apiVersion.split('/').pop()}" cannot be handled as a ${d.kind}: strict decoding error: unknown field "${uf}"` };
            out.push({ doc: d, source: file.name });
          }
        }
      }
      return { items: out };
    }
    withFiles(flags, io, fn) {
      const l = this.loadDocs(flags, io);
      if (l.error) { io.err(l.error + '\n'); return { code: 1 }; }
      return fn(l.items.filter(x => x.doc).map(x => x.doc), l.items);
    }
    docNs(d, flags) {
      const r = KS.BY_KIND[d.kind];
      if (!r.namespaced) return undefined;
      const fileNs = d.metadata.namespace;
      const flagNs = flags.namespace && flags.namespace !== true ? String(flags.namespace) : null;
      if (fileNs && flagNs && fileNs !== flagNs) return { error: `error: the namespace from the provided object "${fileNs}" does not match the namespace "${flagNs}". You must pass '--namespace=${fileNs}' to perform this operation.` };
      return fileNs || flagNs || this.ns;
    }

    // =================================================================== apply / create -f / replace
    cmd_apply(pos, flags, io) {
      if (pos[0] === 'view-last-applied' || pos[0] === 'edit-last-applied' || pos[0] === 'set-last-applied') { io.err('error: (Kubester) apply ' + pos[0] + ' is not simulated\n'); return { code: 1 }; }
      const l = this.loadDocs(flags, io);
      if (l.error) { io.err(l.error + '\n'); return { code: 1 }; }
      const dry = flags['dry-run'] && flags['dry-run'] !== 'none' ? ` (${flags['dry-run']} dry run)` : '';
      let code = 0;
      for (const item of l.items) {
        if (item.special === 'ingress-nginx') {
          if (dry) { io.out(`namespace/ingress-nginx created${dry}\n`); continue; }
          this.c.installIngressNginx().forEach(line => io.out(line + '\n'));
          continue;
        }
        const d = U.clone(item.doc);
        const ns = this.docNs(d, flags);
        if (ns && ns.error) { io.err(ns.error + '\n'); code = 1; continue; }
        const r = KS.BY_KIND[d.kind];
        if (r.namespaced) d.metadata.namespace = ns;
        const cur = this.c.get(d.kind, ns, d.metadata.name);
        const lastApplied = JSON.stringify(sortDeep(Object.assign({}, item.doc, { metadata: Object.assign({}, item.doc.metadata, { namespace: r.namespaced ? ns : undefined }) })));
        if (!cur) {
          const deny = this.can('create', r, ns);
          if (deny) { io.err(deny.replace('(Forbidden): ', `(Forbidden): error when retrieving current configuration of:\n`) + '\n'); code = 1; continue; }
          d.metadata.annotations = Object.assign({}, d.metadata.annotations, { 'kubectl.kubernetes.io/last-applied-configuration': lastApplied + '\n' });
          const res = this.c.create(d, { namespace: ns, dryRun: !!dry, user: this.user, source: item.source });
          (res.warnings || []).forEach(w => io.err(w + '\n'));
          if (!res.ok) { io.err(fmtCreateErr(res.error, item.source) + '\n'); code = 1; continue; }
          io.out(`${refName(res.obj)} created${dry}\n`);
        } else {
          const deny = this.can('patch', r, ns, d.metadata.name);
          if (deny) { io.err(deny + '\n'); code = 1; continue; }
          const next = this.mergeApply(cur, d, lastApplied);
          const res = this.c.update(next, { dryRun: !!dry, user: this.user });
          if (!res.ok) { io.err(fmtApplyErr(res.error, item.source, d) + '\n'); code = 1; continue; }
          io.out(`${refName(cur)} ${res.changed ? 'configured' : 'unchanged'}${dry}\n`);
        }
      }
      return { code };
    }
    mergeApply(cur, desired, lastApplied) {
      const next = U.clone(cur);
      const prevLA = (() => { try { return JSON.parse(((cur.metadata.annotations || {})['kubectl.kubernetes.io/last-applied-configuration']) || '{}'); } catch (e) { return {}; } })();
      // labels/annotations: desired wins; keys present in last-applied but removed from desired are deleted
      for (const field of ['labels', 'annotations']) {
        const want = Object.assign({}, (desired.metadata || {})[field] || {});
        const had = ((prevLA.metadata || {})[field]) || {};
        const m = Object.assign({}, next.metadata[field] || {});
        Object.keys(had).forEach(k => { if (!(k in want)) delete m[k]; });
        Object.assign(m, want);
        if (Object.keys(m).length) next.metadata[field] = m; else delete next.metadata[field];
      }
      next.metadata.annotations = Object.assign({}, next.metadata.annotations, { 'kubectl.kubernetes.io/last-applied-configuration': lastApplied + '\n' });
      if (desired.metadata && desired.metadata.finalizers) next.metadata.finalizers = desired.metadata.finalizers;
      const top = Object.keys(desired).filter(k => !['apiVersion', 'kind', 'metadata', 'status'].includes(k));
      for (const k of top) {
        if (k === 'spec' && cur.kind === 'Service') {
          next.spec = Object.assign({}, desired.spec);
          if (!next.spec.clusterIP) next.spec.clusterIP = cur.spec.clusterIP;
          (next.spec.ports || []).forEach(p => { const old = (cur.spec.ports || []).find(x => x.port === p.port); if (old && old.nodePort && !p.nodePort && (next.spec.type === 'NodePort' || next.spec.type === 'LoadBalancer')) p.nodePort = old.nodePort; });
        } else if (k === 'spec' && cur.kind === 'Pod') {
          next.spec = U.clone(desired.spec);
          // keep server-populated fields of an immutable pod spec
          (next.spec.containers || []).forEach(c2 => { const old = cur.spec.containers.find(x => x.name === c2.name); if (old) { const tok = (old.volumeMounts || []).filter(v => v.name.startsWith('kube-api-access')); if (tok.length) c2.volumeMounts = (c2.volumeMounts || []).concat(tok); ['imagePullPolicy', 'terminationMessagePath', 'terminationMessagePolicy', 'resources'].forEach(f => { if (c2[f] === undefined) c2[f] = old[f]; }); } });
          const tokVols = (cur.spec.volumes || []).filter(v => v.name.startsWith('kube-api-access'));
          if (tokVols.length) next.spec.volumes = (next.spec.volumes || []).concat(tokVols);
          const userTols = next.spec.tolerations || [];
          next.spec.tolerations = cur.spec.tolerations.filter(t2 => !userTols.some(u2 => u2.key === t2.key && u2.effect === t2.effect)).concat(userTols);
        } else if (k === 'spec' && cur.kind === 'Job') {
          next.spec = U.clone(desired.spec);
          next.spec.selector = cur.spec.selector;
          next.spec.template.metadata = Object.assign({}, next.spec.template.metadata, { labels: Object.assign({}, cur.spec.template.metadata.labels, (desired.spec.template.metadata || {}).labels || {}) });
        } else next[k] = U.clone(desired[k]);
      }
      // fields removed from the config entirely
      Object.keys(prevLA).forEach(k => { if (!['apiVersion', 'kind', 'metadata', 'status', 'spec'].includes(k) && !(k in desired)) delete next[k]; });
      return next;
    }
    cmd_replace(pos, flags, io) {
      const l = this.loadDocs(flags, io);
      if (l.error) { io.err(l.error + '\n'); return { code: 1 }; }
      for (const item of l.items) {
        const d = U.clone(item.doc);
        const ns = this.docNs(d, flags);
        if (KS.BY_KIND[d.kind].namespaced) d.metadata.namespace = ns;
        const cur = this.c.get(d.kind, ns, d.metadata.name);
        if (flags.force) {
          if (cur) this.c.delete(d.kind, ns, d.metadata.name, { gracePeriod: 0, force: true });
          io.out(`${refName(d)} deleted\n`);
          const res = this.c.create(d, { namespace: ns, user: this.user });
          if (!res.ok) { io.err(fmtCreateErr(res.error, item.source) + '\n'); return { code: 1 }; }
          io.out(`${refName(res.obj)} replaced\n`);
          continue;
        }
        if (!cur) { io.err(`Error from server (NotFound): error when replacing "${item.source}": ${resName(KS.BY_KIND[d.kind])} "${d.metadata.name}" not found\n`); return { code: 1 }; }
        const next = Object.assign(U.clone(d), { status: cur.status });
        const res = this.c.update(next, { user: this.user });
        if (!res.ok) { io.err(fmtApplyErr(res.error, item.source, d) + '\n'); return { code: 1 }; }
        io.out(`${refName(cur)} replaced\n`);
      }
      return { code: 0 };
    }
    createDoc(d, flags, io, source) {
      const dry = flags['dry-run'] && flags['dry-run'] !== 'none' ? String(flags['dry-run']) : null;
      const ns = this.docNs(d, flags);
      if (ns && ns.error) { io.err(ns.error + '\n'); return { code: 1 }; }
      const r = KS.BY_KIND[d.kind];
      if (r.namespaced) d.metadata.namespace = ns;
      if (dry === 'client') {
        if (flags.output) { const o = U.clone(d); if (r.namespaced && !flags.namespace) delete o.metadata.namespace; return this.printObjects([o], flags, io, { single: true }); }
        io.out(`${refName(d)} created (dry run)\n`);
        return { code: 0 };
      }
      const deny = this.can('create', r, ns);
      if (deny) { io.err(deny + '\n'); return { code: 1 }; }
      if (flags['save-config']) d.metadata.annotations = Object.assign({}, d.metadata.annotations, { 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(sortDeep(d)) + '\n' });
      const res = this.c.create(d, { namespace: ns, dryRun: dry === 'server', user: this.user, source });
      (res.warnings || []).forEach(w => io.err(w + '\n'));
      if (!res.ok) { io.err((source ? fmtCreateErr(res.error, source) : res.error) + '\n'); return { code: 1 }; }
      if (flags.output && !dry) return this.printObjects([res.obj], flags, io, { single: true });
      io.out(`${refName(res.obj)} created${dry ? ' (server dry run)' : ''}\n`);
      return { code: 0, obj: res.obj };
    }

    // =================================================================== create
    cmd_create(pos, flags, io, dash) {
      if (flags.filename || flags.kustomize) {
        const l = this.loadDocs(flags, io);
        if (l.error) { io.err(l.error + '\n'); return { code: 1 }; }
        let code = 0;
        for (const item of l.items) {
          if (item.special === 'ingress-nginx') { this.c.installIngressNginx().forEach(x => io.out(x.replace('unchanged', 'created') + '\n')); continue; }
          const r = this.createDoc(U.clone(item.doc), flags, io, item.source);
          if (r.code) code = r.code;
        }
        return { code };
      }
      const sub = pos[0];
      const name = pos[1];
      const need = what => { io.err(`error: exactly one NAME is required, got 0\nSee 'kubectl create ${what} -h' for help and examples\n`); return { code: 1 }; };
      const nsName = { name };
      switch (sub) {
        case 'namespace': case 'ns': {
          if (!name) return need('namespace');
          return this.createDoc({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } }, flags, io);
        }
        case 'deployment': case 'deploy': {
          if (!name) return need('deployment');
          const imgs = arr(flags.image);
          if (!imgs.length) { io.err('error: required flag(s) "image" not set\n'); return { code: 1 }; }
          const containers = imgs.map((img, i) => { const cn = containerNameFromImage(img); const ct = { image: img, name: imgs.length > 1 ? cn : cn, resources: {} }; if (flags.port && i === 0) ct.ports = [{ containerPort: +flags.port }]; if (dash && dash.length && i === 0) ct.command = dash.slice(); return ct; });
          const d = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { labels: { app: name }, name }, spec: { replicas: flags.replicas != null ? +flags.replicas : 1, selector: { matchLabels: { app: name } }, strategy: {}, template: { metadata: { labels: { app: name } }, spec: { containers } } }, status: {} };
          return this.createDoc(d, flags, io);
        }
        case 'service': case 'svc': {
          const type = pos[1];
          const sname = pos[2];
          const types = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer', externalname: 'ExternalName' };
          if (!types[type]) { io.err(`error: unknown service type "${type || ''}" — use one of: clusterip, nodeport, loadbalancer, externalname\n`); return { code: 1 }; }
          if (!sname) return need('service ' + type);
          const spec = { type: types[type] };
          if (type === 'externalname') {
            if (!flags['external-name']) { io.err('error: required flag(s) "external-name" not set\n'); return { code: 1 }; }
            spec.externalName = String(flags['external-name']);
          } else {
            const tcp = arr(flags.tcp);
            if (!tcp.length && !(type === 'clusterip' && flags.clusterip === 'None')) { io.err('error: at least one tcp port specifier must be provided\n'); return { code: 1 }; }
            spec.ports = tcp.flatMap(x => String(x).split(',')).map(x => { const [p, tp] = x.split(':'); const o = { name: `${p}-${tp || p}`, port: +p, protocol: 'TCP', targetPort: /^\d+$/.test(tp || p) ? +(tp || p) : tp }; if (type === 'nodeport' && flags['node-port']) o.nodePort = +flags['node-port']; return o; });
            spec.selector = { app: sname };
            if (flags.clusterip) spec.clusterIP = String(flags.clusterip);
          }
          return this.createDoc({ apiVersion: 'v1', kind: 'Service', metadata: { labels: { app: sname }, name: sname }, spec, status: { loadBalancer: {} } }, flags, io);
        }
        case 'configmap': case 'cm': {
          if (!name) return need('configmap');
          const data = {};
          const err = this.collectData(flags, data, false);
          if (err) { io.err(err + '\n'); return { code: 1 }; }
          return this.createDoc({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name }, data }, flags, io);
        }
        case 'secret': {
          const type = pos[1];
          const sname = pos[2];
          if (type === 'generic') {
            if (!sname) return need('secret generic');
            const data = {};
            const err = this.collectData(flags, data, true);
            if (err) { io.err(err + '\n'); return { code: 1 }; }
            return this.createDoc({ apiVersion: 'v1', kind: 'Secret', metadata: { name: sname }, type: flags.type ? String(flags.type) : 'Opaque', data }, flags, io);
          }
          if (type === 'docker-registry') {
            if (!sname) return need('secret docker-registry');
            const server = flags['docker-server'] || 'https://index.docker.io/v1/';
            if (!flags['docker-username'] || !flags['docker-password']) { io.err('error: either --from-file or the combination of --docker-username, --docker-password and --docker-server is required\n'); return { code: 1 }; }
            const auth = { auths: { [server]: { username: String(flags['docker-username']), password: String(flags['docker-password']), email: flags['docker-email'] ? String(flags['docker-email']) : undefined, auth: U.b64encode(`${flags['docker-username']}:${flags['docker-password']}`) } } };
            return this.createDoc({ apiVersion: 'v1', kind: 'Secret', metadata: { name: sname }, type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': U.b64encode(JSON.stringify(auth)) } }, flags, io);
          }
          if (type === 'tls') {
            if (!sname) return need('secret tls');
            const cert = flags.cert && this.env.fs.read(R.normPath(String(flags.cert), this.env.cwd()));
            const key = flags.key && this.env.fs.read(R.normPath(String(flags.key), this.env.cwd()));
            if (!cert || !key) { io.err(`error: open ${!cert ? flags.cert || 'tls.crt' : flags.key || 'tls.key'}: no such file or directory\n`); return { code: 1 }; }
            return this.createDoc({ apiVersion: 'v1', kind: 'Secret', metadata: { name: sname }, type: 'kubernetes.io/tls', data: { 'tls.crt': U.b64encode(cert), 'tls.key': U.b64encode(key) } }, flags, io);
          }
          io.err('error: Please specify the secret type: generic, docker-registry or tls\n');
          return { code: 1 };
        }
        case 'job': {
          if (!name) return need('job');
          if (flags.from) {
            const [k, n] = String(flags.from).split('/');
            if (!/^(cronjob|cj|cronjobs)$/.test(k)) { io.err(`error: from must be an existing cronjob: ${flags.from}\n`); return { code: 1 }; }
            const cj = this.c.get('CronJob', this.nsOf(flags), n);
            if (!cj) { io.err(`Error from server (NotFound): cronjobs.batch "${n}" not found\n`); return { code: 1 }; }
            const jt = U.clone(cj.spec.jobTemplate);
            return this.createDoc({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name, annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' }, labels: (jt.metadata || {}).labels, ownerReferences: [this.c.ownerRefFor(cj)] }, spec: jt.spec }, flags, io);
          }
          if (!flags.image) { io.err('error: required flag(s) "image" not set\n'); return { code: 1 }; }
          const ct = { image: String(last(flags.image)), name, resources: {} };
          if (dash && dash.length) ct.command = dash.slice();
          return this.createDoc({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name }, spec: { template: { metadata: {}, spec: { containers: [ct], restartPolicy: 'Never' } } }, status: {} }, flags, io);
        }
        case 'cronjob': case 'cj': {
          if (!name) return need('cronjob');
          if (!flags.image) { io.err('error: required flag(s) "image" not set\n'); return { code: 1 }; }
          if (!flags.schedule) { io.err('error: required flag(s) "schedule" not set\n'); return { code: 1 }; }
          const ct = { image: String(last(flags.image)), name, resources: {} };
          if (dash && dash.length) ct.command = dash.slice();
          return this.createDoc({ apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name }, spec: { jobTemplate: { metadata: { name }, spec: { template: { metadata: {}, spec: { containers: [ct], restartPolicy: flags.restart ? String(flags.restart) : 'OnFailure' } } } }, schedule: String(flags.schedule) }, status: {} }, flags, io);
        }
        case 'serviceaccount': case 'sa': {
          if (!name) return need('serviceaccount');
          return this.createDoc({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name } }, flags, io);
        }
        case 'role': case 'clusterrole': {
          if (!name) return need(sub);
          const verbs = arr(flags.verb).flatMap(v => String(v).split(','));
          const resources = arr(flags.resource).flatMap(v => String(v).split(','));
          if (!verbs.length) { io.err('error: at least one verb must be specified\n'); return { code: 1 }; }
          if (!resources.length) { io.err('error: at least one resource must be specified\n'); return { code: 1 }; }
          const VALID_VERBS = ['*', 'get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'use', 'bind', 'escalate', 'impersonate'];
          const bad = verbs.find(v => !VALID_VERBS.includes(v));
          if (bad) { io.err(`error: invalid verb: '${bad}'\n`); return { code: 1 }; }
          const rules = [];
          for (const rs of resources) {
            const [base, sub2] = rs.split('/');
            const rr = base === '*' ? { plural: '*', group: '*' } : KS.lookupResource(base);
            if (!rr) { io.err(`error: the server doesn't have a resource type "${base}"\n`); return { code: 1 }; }
            const g = rr.group;
            let rule = rules.find(x => x.apiGroups[0] === g);
            if (!rule) { rule = { apiGroups: [g], resources: [], verbs }; rules.push(rule); }
            rule.resources.push(rr.plural + (sub2 ? '/' + sub2 : ''));
            if (flags['resource-name']) rule.resourceNames = arr(flags['resource-name']).flatMap(x => String(x).split(','));
          }
          return this.createDoc({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: sub === 'role' ? 'Role' : 'ClusterRole', metadata: { name }, rules }, flags, io);
        }
        case 'rolebinding': case 'clusterrolebinding': {
          if (!name) return need(sub);
          const roleRef = flags.clusterrole ? { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: String(flags.clusterrole) } : flags.role ? { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: String(flags.role) } : null;
          if (!roleRef) { io.err(sub === 'clusterrolebinding' ? 'error: required flag(s) "clusterrole" not set\n' : 'error: exactly one of clusterrole or role must be specified\n'); return { code: 1 }; }
          const subjects = [];
          arr(flags.user).forEach(u => subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: String(u) }));
          arr(flags.group).forEach(g => subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: String(g) }));
          for (const sa of arr(flags.serviceaccount)) {
            const [sns, sn] = String(sa).split(':');
            if (!sn) { io.err(`error: serviceaccount must be <namespace>:<name>\n`); return { code: 1 }; }
            subjects.push({ kind: 'ServiceAccount', name: sn, namespace: sns });
          }
          return this.createDoc({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: sub === 'rolebinding' ? 'RoleBinding' : 'ClusterRoleBinding', metadata: { name }, roleRef, subjects }, flags, io);
        }
        case 'ingress': case 'ing': {
          if (!name) return need('ingress');
          const rules = [];
          const tls = [];
          for (const ru of arr(flags.rule)) {
            const m = String(ru).match(/^([^/]*)(\/[^=]*)?=([^:,]+):([^,]+)(,tls(=([^,]+))?)?$/);
            if (!m) { io.err(`error: rule ${ru} is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]\n`); return { code: 1 }; }
            const host = m[1] || undefined;
            let path = m[2] || '/';
            let pathType = 'Exact';
            if (path.endsWith('*')) { pathType = 'Prefix'; path = path.slice(0, -1) || '/'; }
            const port = /^\d+$/.test(m[4]) ? { number: +m[4] } : { name: m[4] };
            let rule = rules.find(r => r.host === host);
            if (!rule) { rule = { host, http: { paths: [] } }; rules.push(rule); }
            rule.http.paths.push({ backend: { service: { name: m[3], port } }, path, pathType });
            if (m[5]) tls.push({ hosts: host ? [host] : undefined, secretName: m[7] });
          }
          const spec = { ingressClassName: flags.class ? String(flags.class) : undefined, rules: rules.length ? rules : undefined, tls: tls.length ? tls : undefined };
          if (flags['default-backend']) { const [s, p] = String(flags['default-backend']).split(':'); spec.defaultBackend = { service: { name: s, port: /^\d+$/.test(p) ? { number: +p } : { name: p } } }; }
          Object.keys(spec).forEach(k => spec[k] === undefined && delete spec[k]);
          const ann = {};
          arr(flags.annotation).forEach(a => { const i = String(a).indexOf('='); ann[String(a).slice(0, i)] = String(a).slice(i + 1); });
          return this.createDoc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, annotations: Object.keys(ann).length ? ann : undefined }, spec, status: { loadBalancer: {} } }, flags, io);
        }
        case 'quota': case 'resourcequota': {
          if (!name) return need('quota');
          const hard = {};
          arr(flags.hard).flatMap(x => String(x).split(',')).forEach(kv => { const [k, v] = kv.split('='); if (k) hard[k] = v; });
          return this.createDoc({ apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name }, spec: { hard }, status: {} }, flags, io);
        }
        case 'priorityclass': case 'pc': {
          if (!name) return need('priorityclass');
          return this.createDoc({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name }, value: +(flags.value || 0), globalDefault: !!flags['global-default'], description: flags.description ? String(flags.description) : '', preemptionPolicy: flags['preemption-policy'] ? String(flags['preemption-policy']) : 'PreemptLowerPriority' }, flags, io);
        }
        case 'poddisruptionbudget': case 'pdb': {
          if (!name) return need('poddisruptionbudget');
          if (!flags.selector) { io.err('error: a selector must be specified\n'); return { code: 1 }; }
          if (flags['min-available'] == null && flags['max-unavailable'] == null) { io.err('error: one of min-available or max-unavailable must be specified\n'); return { code: 1 }; }
          const sel = U.parseSelectorString(String(last(flags.selector)));
          const spec = { selector: { matchLabels: sel.matchLabels } };
          const v = x => (/^\d+$/.test(String(x)) ? +x : String(x));
          if (flags['min-available'] != null) spec.minAvailable = v(flags['min-available']); else spec.maxUnavailable = v(flags['max-unavailable']);
          return this.createDoc({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name }, spec, status: {} }, flags, io);
        }
        case 'token': {
          const sa = this.c.get('ServiceAccount', this.nsOf(flags), name);
          if (!sa) { io.err(`Error from server (NotFound): serviceaccounts "${name}" not found\n`); return { code: 1 }; }
          io.out('eyJhbGciOiJSUzI1NiIsImtpZCI6Imt1YmVzdGVyIn0.' + U.b64encode(JSON.stringify({ sub: `system:serviceaccount:${this.nsOf(flags)}:${name}`, exp: Math.floor(this.c.now / 1000) + 3600 })).replace(/=+$/, '') + '.c2ltdWxhdGVkLXNpZ25hdHVyZQ\n');
          return { code: 0 };
        }
        default:
          void nsName;
          io.err(`error: Unexpected args: [${pos.join(' ')}]\nSee 'kubectl create -h' for help and examples\n`);
          if (!sub) io.err('Available Commands: clusterrole, clusterrolebinding, configmap, cronjob, deployment, ingress, job, namespace, poddisruptionbudget, priorityclass, quota, role, rolebinding, secret, service, serviceaccount, token\n');
          return { code: 1 };
      }
    }
    collectData(flags, data, b64) {
      const put = (k, v) => { if (k in data) return `error: cannot add key "${k}", another key by that name already exists in Data for ConfigMap "${k}"`; data[k] = b64 ? U.b64encode(v) : v; return null; };
      for (const lit of arr(flags['from-literal'])) {
        const s = String(lit);
        const i = s.indexOf('=');
        if (i <= 0) return `error: invalid literal source ${s}, expected key=value`;
        const e = put(s.slice(0, i), s.slice(i + 1).replace(/^(["'])(.*)\1$/, '$2'));
        if (e) return e;
      }
      for (const f of arr(flags['from-file'])) {
        const s = String(f);
        const i = s.indexOf('=');
        const key = i > 0 ? s.slice(0, i) : s.split('/').pop();
        const path = R.normPath(i > 0 ? s.slice(i + 1) : s, this.env.cwd());
        const content = this.env.fs.read(path);
        if (content == null) {
          if (this.env.fs.isDir(path)) { this.env.fs.list(path).forEach(n => { const c2 = this.env.fs.read(path + '/' + n); if (c2 != null) put(n, c2); }); continue; }
          return `error: error reading ${i > 0 ? s.slice(i + 1) : s}: no such file or directory`;
        }
        const e = put(key, content);
        if (e) return e;
      }
      if (flags['from-env-file']) {
        const path = R.normPath(String(flags['from-env-file']), this.env.cwd());
        const content = this.env.fs.read(path);
        if (content == null) return `error: open ${flags['from-env-file']}: no such file or directory`;
        content.split('\n').forEach(l => { l = l.trim(); if (!l || l.startsWith('#')) return; const i = l.indexOf('='); if (i > 0) put(l.slice(0, i), l.slice(i + 1)); });
      }
      return null;
    }

    // =================================================================== run
    cmd_run(pos, flags, io, dash) {
      const name = pos[0];
      if (!name) { io.err('error: NAME is required for run\nSee \'kubectl run -h\' for help and examples\n'); return { code: 1 }; }
      if (pos.length > 1) { io.err(`error: Unexpected args: [${pos.slice(1).join(' ')}]\nSee 'kubectl run -h' for help and examples\n(Kubester tip: put the container command after "--", e.g. kubectl run tmp --image=busybox -- sleep 3600)\n`); return { code: 1 }; }
      if (!flags.image) { io.err('error: required flag(s) "image" not set\n'); return { code: 1 }; }
      const labels = {};
      if (flags.labels) arr(flags.labels).flatMap(x => String(x).split(',')).forEach(kv => { const [k, v] = kv.split('='); labels[k] = v; });
      else labels.run = name;
      const ct = { image: String(last(flags.image)), name, resources: {} };
      if (flags.port) ct.ports = [{ containerPort: +flags.port }];
      const env = arr(flags.env).map(e => { const s = String(e); const i = s.indexOf('='); return { name: s.slice(0, i), value: s.slice(i + 1) }; });
      if (env.length) ct.env = env;
      if (flags['image-pull-policy']) ct.imagePullPolicy = String(flags['image-pull-policy']);
      if (dash && dash.length) { if (flags.command) ct.command = dash.slice(); else ct.args = dash.slice(); }
      const interactive = flags.stdin || flags.tty;
      if (interactive) { ct.stdin = true; if (flags.tty) ct.tty = true; ct.stdinOnce = true; }
      const restart = flags.restart ? String(flags.restart) : 'Always';
      if (!['Always', 'OnFailure', 'Never'].includes(restart)) { io.err(`error: invalid restart policy: ${restart}\n`); return { code: 1 }; }
      if (flags.rm && !interactive) { io.err("error: --rm should only be used for attached containers\n"); return { code: 1 }; }
      let pod = { apiVersion: 'v1', kind: 'Pod', metadata: { labels, name }, spec: { containers: [ct], dnsPolicy: 'ClusterFirst', restartPolicy: flags.rm && restart === 'Always' ? 'Never' : restart }, status: {} };
      if (flags.overrides) {
        let ov;
        try { ov = JSON.parse(String(flags.overrides)); } catch (e) { io.err(`error: Invalid JSON Patch: ${e.message}\n`); return { code: 1 }; }
        pod = strategicMerge(pod, ov);
      }
      if (flags['dry-run'] && flags['dry-run'] !== 'none') return this.createDoc(pod, flags, io);
      const r = this.createDoc(pod, Object.assign({}, flags, { output: undefined }), interactive ? { out() {}, err: io.err } : io);
      if (r.code) return r;
      if (flags.expose) {
        if (!flags.port) { io.err('error: --port must be set when exposing a service\n'); return { code: 1 }; }
        const sr = this.createDoc({ apiVersion: 'v1', kind: 'Service', metadata: { name, labels }, spec: { ports: [{ port: +flags.port, protocol: 'TCP', targetPort: +flags.port }], selector: labels } }, flags, io);
        if (sr.code) return sr;
      }
      if (!interactive) return { code: 0 };
      // wait for the pod to run, then attach an interactive shell (or stream output)
      const ns = this.nsOf(flags);
      const self = this;
      let waited = 0;
      return {
        code: 0,
        task: {
          tick(dt) {
            const p = self.c.get('Pod', ns, name);
            waited += dt || 100;
            if (!p) { io.err(`Error from server (NotFound): pods "${name}" not found\n`); return true; }
            const cs = (p.status.containerStatuses || [])[0];
            if (p.status.phase === 'Running' && cs && cs.state.running) {
              const exe = (ct.command || ct.args || R.resolveImage(ct.image).def?.defaultCmd || []);
              const first = String(exe[0] || '').split('/').pop();
              if (['sh', 'bash', 'ash'].includes(first) && exe.length === 1) {
                io.out("If you don't see a command prompt, try pressing enter.\n");
                const sh = self.c.execEnv(p, name);
                return { interactive: self.makeInteractive(sh, p, () => { if (flags.rm) { self.c.delete('Pod', ns, name, { gracePeriod: 0, force: true }); io.out(`pod "${name}" deleted\n`); } }) };
              }
              return false;
            }
            if (p.status.phase === 'Succeeded' || p.status.phase === 'Failed' || (cs && cs.state.terminated) || (cs && cs.state.waiting && cs.state.waiting.reason === 'CrashLoopBackOff')) {
              const rt = self.c.rt.pods[p.metadata.uid];
              const c0 = rt && rt.containers[name];
              const logs = c0 ? (c0.logs.length ? c0.logs : c0.prevLogs) : [];
              logs.forEach(l => io.out(l.line + '\n'));
              if (flags.rm) { self.c.delete('Pod', ns, name, { gracePeriod: 0, force: true }); io.out(`pod "${name}" deleted\n`); }
              if (p.status.phase === 'Failed' || (cs && cs.state.terminated && cs.state.terminated.exitCode)) { io.err(`pod ${ns}/${name} terminated (${cs && cs.state.terminated ? cs.state.terminated.reason : 'Error'})\n`); }
              return true;
            }
            if (cs && cs.state.waiting && /ImagePull|ErrImage|CreateContainerConfigError|InvalidImageName/.test(cs.state.waiting.reason || '')) {
              io.err(`error: timed out waiting for the condition — pod ${name} is ${cs.state.waiting.reason}. Check: kubectl describe pod ${name}\n`);
              return true;
            }
            if (waited > 60000) { io.err('error: timed out waiting for the condition\n'); return true; }
            return false;
          },
          cancel() {},
        },
      };
    }

    makeInteractive(sh, pod, onExit) {
      const self = this;
      const prompt = () => (sh.uid === 0 ? `${sh.cwd === '/' ? '/' : sh.cwd} # ` : `${sh.cwd === '/' ? '~' : sh.cwd} $ `);
      return {
        prompt,
        title: `${pod.metadata.name}`,
        run(line, io) {
          const p = self.c.get('Pod', pod.metadata.namespace, pod.metadata.name);
          if (!p || p.metadata.deletionTimestamp && !self.c.rt.pods[pod.metadata.uid]) { io.err('command terminated with exit code 137\n'); if (onExit) onExit(); return { exit: true }; }
          const trimmed = line.trim();
          if (trimmed === 'exit' || trimmed === 'logout' || /^exit\s+\d+$/.test(trimmed)) { if (onExit) onExit(); return { exit: true, code: +(trimmed.split(/\s+/)[1] || 0) }; }
          if (!trimmed) return {};
          const r = R.runSync(sh, line);
          if (r.stdout) io.out(r.stdout.replace(/\x1bc/g, ''));
          if (r.stderr) io.err(r.stderr);
          return {};
        },
      };
    }

    // =================================================================== delete
    cmd_delete(pos, flags, io) {
      const ns = this.nsOf(flags);
      const opts = { cascade: flags.cascade === 'orphan' ? 'orphan' : undefined };
      if (flags['grace-period'] != null && flags['grace-period'] !== true) opts.gracePeriod = +flags['grace-period'];
      if (flags.now) opts.gracePeriod = 1;
      if (flags.force) { opts.force = true; if (opts.gracePeriod == null) opts.gracePeriod = 0; }
      if (opts.force && opts.gracePeriod === 0) io.err('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.\n');
      const targets = [];
      if (flags.filename || flags.kustomize) {
        const l = this.loadDocs(flags, io);
        if (l.error) { io.err(l.error + '\n'); return { code: 1 }; }
        l.items.forEach(it => { if (it.doc) targets.push({ res: KS.BY_KIND[it.doc.kind], ns: KS.BY_KIND[it.doc.kind].namespaced ? (it.doc.metadata.namespace || ns) : undefined, name: it.doc.metadata.name }); });
      } else {
        if (!pos.length) { io.err('error: You must provide one or more resources by argument or filename.\nExample resource specifications include:\n   \'-f rsrc.yaml\'\n   \'--filename=rsrc.json\'\n   \'<resource> <name>\'\n   \'<resource>\'\n'); return { code: 1 }; }
        const t = this.resolveTargets(pos);
        if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
        for (const g of t.groups) {
          if (!g.names.length) {
            if (!flags.all && !flags.selector && !flags['field-selector']) { io.err('error: resource(s) were provided, but no name was specified\n'); return { code: 1 }; }
            const sel = this.selectObjects(g.res, ns, !!flags['all-namespaces'], [], flags);
            if (sel.error) { io.err(sel.error + '\n'); return { code: 1 }; }
            sel.objs.forEach(o => targets.push({ res: g.res, ns: o.metadata.namespace, name: o.metadata.name }));
            if (!sel.objs.length && !t.multi) io.err(`No resources found\n`);
          } else g.names.forEach(n => targets.push({ res: g.res, ns: g.res.namespaced ? ns : undefined, name: n }));
        }
      }
      let code = 0;
      const pending = [];
      for (const tg of targets) {
        const deny = this.can('delete', tg.res, tg.ns, tg.name);
        if (deny) { io.err(deny + '\n'); code = 1; continue; }
        if (flags['dry-run'] && flags['dry-run'] !== 'none') { io.out(`${kindRef(tg.res)} "${tg.name}" deleted (${flags['dry-run']} dry run)\n`); continue; }
        const r = this.c.delete(tg.res.kind, tg.ns, tg.name, Object.assign({ user: this.user }, opts));
        if (!r.ok) { if (!flags['ignore-not-found']) { io.err(r.error + '\n'); code = 1; } continue; }
        io.out(`${kindRef(tg.res)} "${tg.name}" ${opts.force && opts.gracePeriod === 0 ? 'force deleted' : 'deleted'}${tg.res.namespaced && tg.ns !== this.ns ? ` from ${tg.ns} namespace` : ''}\n`);
        if (flags.wait !== false && this.c.get(tg.res.kind, tg.ns, tg.name)) pending.push(tg);
      }
      if (!pending.length) return { code };
      // like kubectl, wait until the objects are really gone (graceful termination / finalizers)
      const self = this;
      let waited = 0, hinted = false;
      return {
        code,
        task: {
          tick(dt) {
            waited += dt || 100;
            const left = pending.filter(tg => self.c.get(tg.res.kind, tg.ns, tg.name));
            if (!left.length) return true;
            if (!hinted && waited > 3000) {
              hinted = true;
              const o = self.c.get(left[0].res.kind, left[0].ns, left[0].name);
              const fins = (o.metadata.finalizers || []).filter(f => !['kubernetes.io/pvc-protection', 'kubernetes.io/pv-protection'].includes(f));
              if (fins.length) io.err(`(Kubester: waiting — ${left[0].name} has finalizers ${JSON.stringify(fins)} that nothing is processing. Press Ctrl+C to stop waiting; the object stays in Terminating.)\n`);
              else if (left[0].res.kind === 'Namespace') io.err('(Kubester: waiting for everything inside the namespace to be deleted…  Ctrl+C stops waiting.)\n');
              else if (left[0].res.kind === 'PersistentVolumeClaim') io.err('(Kubester: waiting — the PVC is still used by a Pod (kubernetes.io/pvc-protection). It is removed once no Pod uses it. Ctrl+C stops waiting.)\n');
              else io.err(`(Kubester: waiting for graceful termination of ${left.map(x => x.name).join(', ')} — up to terminationGracePeriodSeconds. Ctrl+C stops waiting; deletion continues in the background.)\n`);
            }
            return false;
          },
          cancel() {},
        },
      };
    }

    // =================================================================== edit
    cmd_edit(pos, flags, io) {
      const t = this.resolveTargets(pos);
      if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
      const g = t.groups[0];
      if (!g || !g.names.length) { io.err('error: (Kubester) please name one object to edit, e.g. kubectl edit deployment web\n'); return { code: 1 }; }
      const ns = this.nsOf(flags);
      const o = this.c.get(g.res.kind, ns, g.names[0]);
      if (!o) { io.err(`Error from server (NotFound): ${resName(g.res)} "${g.names[0]}" not found\n`); return { code: 1 }; }
      const deny = this.can('update', g.res, ns, o.metadata.name);
      if (deny) { io.err(deny + '\n'); return { code: 1 }; }
      const header = '# Please edit the object below. Lines beginning with a \'#\' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n';
      const original = toYaml(o);
      const self = this;
      return {
        code: 0,
        editor: {
          filename: `/tmp/kubectl-edit-${self.c.suffix(10)}.yaml`,
          content: header + original,
          save(text) {
            const body = text.split('\n').filter(l => !l.startsWith('#')).join('\n');
            if (!body.trim()) return { message: 'Edit cancelled, no changes made.', close: true };
            const p = parseDocs(body, 'edited file');
            if (p.error || !p.docs.length) return { error: p.error || 'error: empty document' };
            const d = p.docs[0];
            if (U.deepEqual(d, U.clone(o)) || toYaml(d) === original) return { message: 'Edit cancelled, no changes made.', close: true };
            if (d.metadata && d.metadata.name !== o.metadata.name) return { error: `error: At least one of apiVersion, kind and name was changed` };
            const uf = KS.unknownField(d);
            if (uf) return { error: `error: ${resName(g.res)} "${o.metadata.name}" is invalid: strict decoding error: unknown field "${uf}"` };
            const cur = self.c.get(o.kind, ns, o.metadata.name);
            if (!cur) return { error: `Error from server (NotFound): ${resName(g.res)} "${o.metadata.name}" not found` };
            d.metadata.resourceVersion = cur.metadata.resourceVersion;
            const res = self.c.update(d, { user: self.user });
            if (!res.ok) return { error: `error: ${resName(g.res)} "${o.metadata.name}" is invalid\n${res.error}` };
            return { message: `${refName(cur)} edited`, close: true };
          },
        },
      };
    }

    // =================================================================== scale
    cmd_scale(pos, flags, io) {
      if (flags.replicas == null || flags.replicas === true) { io.err('error: required flag(s) "replicas" not set\n'); return { code: 1 }; }
      const n = +flags.replicas;
      if (!Number.isInteger(n) || n < 0) { io.err(`error: invalid argument "${flags.replicas}" for "--replicas" flag: strconv.ParseInt: parsing "${flags.replicas}": invalid syntax\n`); return { code: 1 }; }
      const t = this.resolveTargets(pos);
      if (t.error) { io.err(t.error.replace('get', 'scale') + '\n'); return { code: 1 }; }
      const ns = this.nsOf(flags);
      let code = 0;
      for (const g of t.groups) {
        if (!['Deployment', 'ReplicaSet', 'StatefulSet'].includes(g.res.kind)) { io.err(`error: no objects passed to scale ${resName(g.res)} — only deployments, replicasets and statefulsets can be scaled\n`); return { code: 1 }; }
        const names = g.names.length ? g.names : (flags.all || flags.selector ? this.selectObjects(g.res, ns, false, [], flags).objs.map(o => o.metadata.name) : []);
        if (!names.length) { io.err('error: resource(s) were provided, but no name was specified\n'); return { code: 1 }; }
        for (const name of names) {
          const o = this.getc(g.res.kind, ns, name);
          if (!o) { io.err(`Error from server (NotFound): ${resName(g.res)} "${name}" not found\n`); code = 1; continue; }
          const deny = this.can('patch', g.res, ns, name, 'scale') && this.can('update', g.res, ns, name);
          if (deny) { io.err(deny + '\n'); code = 1; continue; }
          if (flags['current-replicas'] != null && +flags['current-replicas'] !== o.spec.replicas) { io.err(`error: Expected replicas to be ${flags['current-replicas']}, was ${o.spec.replicas}\n`); code = 1; continue; }
          o.spec.replicas = n;
          const r = this.c.update(o, { user: this.user });
          if (!r.ok) { io.err(r.error + '\n'); code = 1; continue; }
          io.out(`${refName(o)} scaled\n`);
          if (g.res.kind === 'Deployment' && this.c.ls('HorizontalPodAutoscaler', ns).some(h => h.spec.scaleTargetRef.name === name)) io.err(`(Kubester: note — an HPA manages ${refName(o)}. It will override this replica count on its next sync.)\n`);
        }
      }
      return { code };
    }

    // =================================================================== set
    cmd_set(pos, flags, io, dash, argv) {
      const sub = pos[0];
      const ns = this.nsOf(flags);
      const targetsFrom = (list) => {
        const t = this.resolveTargets(list);
        if (t.error) return { error: t.error };
        const out = [];
        for (const g of t.groups) for (const n of g.names) {
          const o = this.getc(g.res.kind, ns, n);
          if (!o) return { error: `Error from server (NotFound): ${resName(g.res)} "${n}" not found` };
          out.push(o);
        }
        return { objs: out };
      };
      const podSpecOf = o => (o.kind === 'Pod' ? o.spec : o.kind === 'CronJob' ? o.spec.jobTemplate.spec.template.spec : o.spec.template.spec);
      if (sub === 'image') {
        const rest = pos.slice(1);
        const kv = rest.filter(x => x.includes('='));
        const res = rest.filter(x => !x.includes('='));
        if (!kv.length) { io.err('error: at least one image update is required\n'); return { code: 1 }; }
        const t = targetsFrom(res);
        if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
        for (const o of t.objs) {
          const spec = podSpecOf(o);
          for (const pair of kv) {
            const [cn, img] = pair.split('=');
            const cs = cn === '*' ? spec.containers.concat(spec.initContainers || []) : spec.containers.concat(spec.initContainers || []).filter(c2 => c2.name === cn);
            if (!cs.length) { io.err(`error: unable to find container named "${cn}"\n`); return { code: 1 }; }
            cs.forEach(c2 => (c2.image = img));
          }
          if (flags.record) { o.metadata.annotations = Object.assign({}, o.metadata.annotations, { 'kubernetes.io/change-cause': 'kubectl ' + argv.join(' ') }); io.err('Flag --record has been deprecated, --record will be removed in the future\n'); }
          const r = this.c.update(o, { user: this.user });
          if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
          io.out(`${refName(o)} image updated\n`);
        }
        return { code: 0 };
      }
      if (sub === 'env') {
        const rest = pos.slice(1);
        const kv = rest.filter(x => /^[A-Za-z_][A-Za-z0-9_]*(=|-$)/.test(x));
        const res = rest.filter(x => !kv.includes(x));
        const t = targetsFrom(res);
        if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
        for (const o of t.objs) {
          const spec = podSpecOf(o);
          const cs = flags.container || flags.containers ? spec.containers.filter(c2 => c2.name === String(flags.container || flags.containers)) : spec.containers;
          if (flags.list) {
            cs.forEach(c2 => { io.out(`# ${o.kind.toLowerCase()}s/${o.metadata.name}, container ${c2.name}\n`); (c2.env || []).forEach(e => io.out(e.valueFrom ? `# ${e.name} from ${Object.keys(e.valueFrom)[0]}\n` : `${e.name}=${e.value}\n`)); });
            continue;
          }
          for (const c2 of cs) {
            c2.env = c2.env || [];
            for (const pair of kv) {
              if (pair.endsWith('-') && !pair.includes('=')) { c2.env = c2.env.filter(e => e.name !== pair.slice(0, -1)); continue; }
              const i = pair.indexOf('=');
              const name = pair.slice(0, i), value = pair.slice(i + 1);
              const ex = c2.env.find(e => e.name === name);
              if (ex) { ex.value = value; delete ex.valueFrom; } else c2.env.push({ name, value });
            }
            if (flags.from) {
              const [k, n] = String(flags.from).split('/');
              const src = /^(configmap|cm)$/.test(k) ? this.c.get('ConfigMap', ns, n) : /^secrets?$/.test(k) ? this.c.get('Secret', ns, n) : null;
              if (!src) { io.err(`error: failed to retrieve ${flags.from}\n`); return { code: 1 }; }
              Object.keys(src.data || {}).forEach(key => {
                const envName = String(flags.prefix || '') + key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                c2.env = c2.env.filter(e => e.name !== envName);
                c2.env.push({ name: envName, valueFrom: src.kind === 'ConfigMap' ? { configMapKeyRef: { key, name: n } } : { secretKeyRef: { key, name: n } } });
              });
            }
            if (!c2.env.length) delete c2.env;
          }
          const r = this.c.update(o, { user: this.user });
          if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
          io.out(`${refName(o)} env updated\n`);
        }
        return { code: 0 };
      }
      if (sub === 'resources') {
        const t = targetsFrom(pos.slice(1));
        if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
        const parse = s => { const m = {}; String(s || '').split(',').filter(Boolean).forEach(kv => { const [k, v] = kv.split('='); m[k] = v; }); return m; };
        for (const o of t.objs) {
          const spec = podSpecOf(o);
          const cs = flags.containers || flags.container ? spec.containers.filter(c2 => c2.name === String(flags.containers || flags.container)) : spec.containers;
          cs.forEach(c2 => {
            c2.resources = c2.resources || {};
            if (flags.limits) c2.resources.limits = Object.assign({}, c2.resources.limits, parse(flags.limits));
            if (flags.requests) c2.resources.requests = Object.assign({}, c2.resources.requests, parse(flags.requests));
          });
          const r = this.c.update(o, { user: this.user });
          if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
          io.out(`${refName(o)} resource requirements updated\n`);
        }
        return { code: 0 };
      }
      io.err('error: Unknown set subcommand. Available: env, image, resources\n');
      return { code: 1 };
    }

    // =================================================================== rollout
    cmd_rollout(pos, flags, io) {
      const sub = pos[0];
      const t = this.resolveTargets(pos.slice(1));
      if (!sub || t.error) { io.err((t.error || 'error: required resource not specified') + '\n'); return { code: 1 }; }
      const g = t.groups[0];
      const ns = this.nsOf(flags);
      const name = g.names[0];
      if (!name) { io.err('error: required resource not specified\n'); return { code: 1 }; }
      if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(g.res.kind)) { io.err(`error: no rollout ${sub === 'history' ? 'history ' : ''}support for kind ${JSON.stringify(g.res.kind)}\n`); return { code: 1 }; }
      const o = this.getc(g.res.kind, ns, name);
      if (!o) { io.err(`Error from server (NotFound): ${resName(g.res)} "${name}" not found\n`); return { code: 1 }; }
      const rsOf = () => this.c.list('ReplicaSet', ns).filter(rs => (rs.metadata.ownerReferences || []).some(r => r.uid === o.metadata.uid));
      const revOf = rs => parseInt((rs.metadata.annotations || {})['deployment.kubernetes.io/revision'] || '0', 10);
      switch (sub) {
        case 'status': {
          const self = this;
          let lastMsg = null;
          let waited = 0;
          const timeout = flags.timeout ? U.parseDuration(String(flags.timeout)) : 0;
          const check = () => {
            const cur = self.c.get(g.res.kind, ns, name);
            if (!cur) { io.err(`error: ${refName(o)} was deleted\n`); return 1; }
            let msg = null, done = false, err = null;
            if ((cur.metadata.generation || 0) > ((cur.status || {}).observedGeneration || 0)) {
              msg = `Waiting for ${cur.kind === 'Deployment' ? 'deployment' : cur.kind === 'DaemonSet' ? 'daemon set' : 'statefulset'} spec update to be observed...`;
            } else if (cur.kind === 'Deployment') {
              const st = cur.status || {};
              const prog = H.cond(cur, 'Progressing');
              if (prog && prog.reason === 'ProgressDeadlineExceeded') err = `error: deployment "${name}" exceeded its progress deadline`;
              else if ((st.updatedReplicas || 0) < cur.spec.replicas) msg = `Waiting for deployment "${name}" rollout to finish: ${st.updatedReplicas || 0} out of ${cur.spec.replicas} new replicas have been updated...`;
              else if ((st.replicas || 0) > (st.updatedReplicas || 0)) msg = `Waiting for deployment "${name}" rollout to finish: ${st.replicas - st.updatedReplicas} old replicas are pending termination...`;
              else if ((st.availableReplicas || 0) < (st.updatedReplicas || 0)) msg = `Waiting for deployment "${name}" rollout to finish: ${st.availableReplicas || 0} of ${st.updatedReplicas} updated replicas are available...`;
              else { msg = `deployment "${name}" successfully rolled out`; done = true; }
            } else if (cur.kind === 'StatefulSet') {
              const st = cur.status || {};
              if ((st.readyReplicas || 0) < cur.spec.replicas) msg = `Waiting for ${cur.spec.replicas - (st.readyReplicas || 0)} pods to be ready...`;
              else if ((st.updatedReplicas || 0) < cur.spec.replicas) msg = `Waiting for partitioned roll out to finish: ${st.updatedReplicas || 0} out of ${cur.spec.replicas} new pods have been updated...`;
              else { msg = `statefulset rolling update complete ${cur.spec.replicas} pods at revision ${st.updateRevision}...`; done = true; }
            } else {
              const st = cur.status || {};
              if ((st.updatedNumberScheduled || 0) < (st.desiredNumberScheduled || 0)) msg = `Waiting for daemon set "${name}" rollout to finish: ${st.updatedNumberScheduled || 0} out of ${st.desiredNumberScheduled} new pods have been updated...`;
              else if ((st.numberAvailable || 0) < (st.desiredNumberScheduled || 0)) msg = `Waiting for daemon set "${name}" rollout to finish: ${st.numberAvailable || 0} of ${st.desiredNumberScheduled} updated pods are available...`;
              else { msg = `daemon set "${name}" successfully rolled out`; done = true; }
            }
            if (err) { io.err(err + '\n'); return 1; }
            if (msg !== lastMsg) { io.out(msg + '\n'); lastMsg = msg; }
            return done ? 0 : null;
          };
          const r0 = check();
          if (r0 !== null || flags.watch === false) return { code: r0 || 0 };
          return { code: 0, task: { tick(dt) { waited += dt || 100; if (timeout && waited >= timeout) { io.err('error: timed out waiting for the condition\n'); return { code: 1 }; } const r = check(); return r === null ? false : { code: r }; }, cancel() {} } };
        }
        case 'history': {
          if (g.res.kind !== 'Deployment') { io.out(`${refName(o)}\nREVISION  CHANGE-CAUSE\n1         <none>\n\n`); return { code: 0 }; }
          const rss = rsOf().sort((a, b) => revOf(a) - revOf(b));
          if (flags.revision) {
            const rs = rss.find(r => revOf(r) === +flags.revision);
            if (!rs) { io.err(`error: unable to find the specified revision\n`); return { code: 1 }; }
            io.out(`${refName(o)} with revision #${flags.revision}\n${KS.podTemplateText(rs.spec.template, this.c)}\n\n`);
            return { code: 0 };
          }
          io.out(`${refName(o)} \n`);
          const lines = U.table(['REVISION', 'CHANGE-CAUSE'], rss.map(rs => [revOf(rs), (rs.metadata.annotations || {})['kubernetes.io/change-cause'] || '<none>']));
          lines.forEach(l => io.out(l.replace(/^(\S+)\s+/, (m, a) => a.padEnd(10)) + '\n'));
          io.out('\n');
          return { code: 0 };
        }
        case 'undo': {
          if (g.res.kind !== 'Deployment') { io.err('error: (Kubester) rollout undo is simulated for deployments\n'); return { code: 1 }; }
          const rss = rsOf().sort((a, b) => revOf(b) - revOf(a));
          const curRev = revOf(rss[0] || { metadata: {} });
          let target;
          if (flags['to-revision'] != null && +flags['to-revision'] !== 0) {
            target = rss.find(r => revOf(r) === +flags['to-revision']);
            if (!target) { io.err(`error: unable to find specified revision ${flags['to-revision']} in history\n`); return { code: 1 }; }
          } else {
            target = rss.find(r => revOf(r) < curRev);
            if (!target) { io.err(`error: no rollout history found for deployment "${name}"\n`); return { code: 1 }; }
          }
          const tpl = U.clone(target.spec.template);
          delete tpl.metadata.labels['pod-template-hash'];
          if (U.deepEqual(tpl, o.spec.template)) { io.out(`${refName(o)} skipped rollback (current template already matches revision ${revOf(target)})\n`); return { code: 0 }; }
          o.spec.template = tpl;
          const cc = (target.metadata.annotations || {})['kubernetes.io/change-cause'];
          o.metadata.annotations = Object.assign({}, o.metadata.annotations);
          if (cc) o.metadata.annotations['kubernetes.io/change-cause'] = cc; else delete o.metadata.annotations['kubernetes.io/change-cause'];
          const r = this.c.update(o, { user: this.user });
          if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
          io.out(`${refName(o)} rolled back\n`);
          return { code: 0 };
        }
        case 'restart': {
          const tpl = o.kind === 'Pod' ? null : o.spec.template;
          tpl.metadata.annotations = Object.assign({}, tpl.metadata.annotations, { 'kubectl.kubernetes.io/restartedAt': new Date(this.c.now).toISOString().replace(/\.\d+Z$/, 'Z') });
          const r = this.c.update(o, { user: this.user });
          if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
          io.out(`${refName(o)} restarted\n`);
          return { code: 0 };
        }
        case 'pause': case 'resume': {
          if (o.kind !== 'Deployment') { io.err(`error: ${sub} is only supported for deployments\n`); return { code: 1 }; }
          const want = sub === 'pause';
          if (!!o.spec.paused === want) { io.err(`error: ${refName(o)} is ${want ? 'already paused' : 'not paused'}\n`); return { code: 1 }; }
          o.spec.paused = want || undefined;
          if (!want) delete o.spec.paused;
          this.c.update(o, { user: this.user });
          io.out(`${refName(o)} ${want ? 'paused' : 'resumed'}\n`);
          return { code: 0 };
        }
        default: io.err(`error: unknown command "${sub}" for "kubectl rollout"\nAvailable: history, pause, restart, resume, status, undo\n`); return { code: 1 };
      }
    }

    // =================================================================== expose
    cmd_expose(pos, flags, io) {
      const t = this.resolveTargets(pos);
      if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
      const g = t.groups[0];
      const ns = this.nsOf(flags);
      if (!g || !g.names[0]) { io.err('error: You must provide one or more resources by argument or filename.\n'); return { code: 1 }; }
      const o = this.c.get(g.res.kind, ns, g.names[0]);
      if (!o) { io.err(`Error from server (NotFound): ${resName(g.res)} "${g.names[0]}" not found\n`); return { code: 1 }; }
      let selector;
      if (flags.selector) { selector = U.parseSelectorString(String(last(flags.selector))).matchLabels; }
      else if (o.kind === 'Pod') selector = Object.assign({}, o.metadata.labels || {});
      else if (o.kind === 'Service') selector = o.spec.selector;
      else if (['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(o.kind)) {
        if ((o.spec.selector.matchExpressions || []).length) { io.err('error: couldn\'t retrieve selectors via --selector flag or introspection: the provided selector contains match expressions that cannot be converted to a service selector\n'); return { code: 1 }; }
        selector = Object.assign({}, o.spec.selector.matchLabels);
      } else { io.err(`error: cannot expose a ${o.kind}\n`); return { code: 1 }; }
      if (!selector || !Object.keys(selector).length) { io.err("error: couldn't retrieve selectors via --selector flag or introspection: the pod has no labels and cannot be exposed\n"); return { code: 1 }; }
      const tplSpec = o.kind === 'Pod' ? o.spec : o.kind === 'Service' ? null : o.spec.template.spec;
      let ports = [];
      if (flags.port) ports = String(flags.port).split(',').map(p => +p);
      else if (o.kind === 'Service') ports = o.spec.ports.map(p => p.port);
      else ports = (tplSpec.containers || []).flatMap(c2 => (c2.ports || []).map(p => p.containerPort));
      if (!ports.length) { io.err("error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples\n"); return { code: 1 }; }
      const type = flags.type ? String(flags.type) : 'ClusterIP';
      const typeMap = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer', externalname: 'ExternalName' };
      const normType = typeMap[type.toLowerCase()] || type;
      const tp = flags['target-port'];
      const sp = ports.map((p, i) => { const port = { port: p, protocol: flags.protocol ? String(flags.protocol) : 'TCP', targetPort: tp != null ? (/^\d+$/.test(String(tp)) ? +tp : String(tp)) : (o.kind === 'Service' ? o.spec.ports[i].targetPort : p) }; if (ports.length > 1) port.name = `port-${i + 1}`; return port; });
      const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name: flags.name ? String(flags.name) : o.metadata.name, labels: Object.assign({}, o.kind === 'Pod' ? o.metadata.labels : (o.metadata.labels || selector)) }, spec: { ports: sp, selector, type: normType }, status: { loadBalancer: {} } };
      if (flags['cluster-ip']) svc.spec.clusterIP = String(flags['cluster-ip']);
      if (normType === 'ClusterIP' && !flags['dry-run']) delete svc.spec.type;
      const r = this.createDoc(svc, flags, { out: s => io.out(s.replace(' created', ' exposed')), err: io.err });
      return r;
    }

    // =================================================================== label / annotate
    cmd_label(pos, flags, io) { return this.labelLike('labels', pos, flags, io); }
    cmd_annotate(pos, flags, io) { return this.labelLike('annotations', pos, flags, io); }
    labelLike(field, pos, flags, io) {
      const kv = pos.filter(x => x.includes('=') || x.endsWith('-'));
      const res = pos.filter(x => !kv.includes(x));
      if (!res.length) { io.err('error: one or more resources must be specified as <resource> <name> or <resource>/<name>\n'); return { code: 1 }; }
      const t = this.resolveTargets(res);
      if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
      const ns = this.nsOf(flags);
      const objs = [];
      for (const g of t.groups) {
        if (g.names.length) { for (const n of g.names) { const o = this.getc(g.res.kind, ns, n); if (!o) { io.err(`Error from server (NotFound): ${resName(g.res)} "${n}" not found\n`); return { code: 1 }; } objs.push(o); } }
        else if (flags.all || flags.selector) objs.push(...this.selectObjects(g.res, ns, !!flags['all-namespaces'], [], flags).objs.map(o => U.clone(o)));
        else { io.err('error: resource(s) were provided, but no name was specified\n'); return { code: 1 }; }
      }
      if (flags.list) { objs.forEach(o => { io.out(`Listing ${field} for ${refName(o)}:\n`); Object.entries(o.metadata[field] || {}).forEach(([k, v]) => io.out(` ${k}=${v}\n`)); }); return { code: 0 }; }
      if (!kv.length) { io.err(`error: at least one ${field === 'labels' ? 'label' : 'annotation'} update is required\n`); return { code: 1 }; }
      for (const o of objs) {
        const m = Object.assign({}, o.metadata[field] || {});
        let removedOnly = true;
        for (const pair of kv) {
          if (pair.endsWith('-') && !pair.includes('=')) { delete m[pair.slice(0, -1)]; continue; }
          removedOnly = false;
          const i = pair.indexOf('=');
          const k = pair.slice(0, i), v = pair.slice(i + 1);
          if (field === 'labels' && !U.validLabelValue(v)) { io.err(`error: invalid label value: "${pair}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')\n`); return { code: 1 }; }
          if (k in m && m[k] !== v && !flags.overwrite) { io.err(`error: '${k}' already has a value (${m[k]}), and --overwrite is false\n`); return { code: 1 }; }
          m[k] = v;
        }
        const deny = this.can('patch', KS.BY_KIND[o.kind], ns, o.metadata.name);
        if (deny) { io.err(deny + '\n'); return { code: 1 }; }
        const before = JSON.stringify(o.metadata[field] || {});
        if (Object.keys(m).length) o.metadata[field] = m; else delete o.metadata[field];
        const r = this.c.update(o, { user: this.user });
        if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
        const verb = field === 'labels' ? (removedOnly ? 'unlabeled' : 'labeled') : (removedOnly ? 'annotated' : 'annotated');
        io.out(`${refName(o)} ${before === JSON.stringify(o.metadata[field] || {}) ? 'not ' + verb : verb}\n`);
      }
      return { code: 0 };
    }

    // =================================================================== taint / cordon / drain
    cmd_taint(pos, flags, io) {
      if (!/^(nodes?|no)$/.test(pos[0] || '')) {
        if (pos[0] && pos[0].includes('/') && /^(nodes?|no)\//.test(pos[0])) pos = ['nodes', pos[0].split('/')[1]].concat(pos.slice(1));
        else { io.err('error: (Kubester) usage: kubectl taint nodes <node> key=value:Effect\n'); return { code: 1 }; }
      }
      const node = this.getc('Node', '', pos[1]);
      if (!node) { io.err(`Error from server (NotFound): nodes "${pos[1]}" not found\n`); return { code: 1 }; }
      const specs = pos.slice(2);
      if (!specs.length) { io.err('error: at least one taint update is required\n'); return { code: 1 }; }
      let taints = (node.spec.taints || []).slice();
      let added = false, removed = false;
      for (const s of specs) {
        if (s.endsWith('-')) {
          const body = s.slice(0, -1);
          const [kv, eff] = body.split(':');
          const key = kv.split('=')[0];
          const before = taints.length;
          taints = taints.filter(t2 => !(t2.key === key && (!eff || t2.effect === eff)));
          if (taints.length === before) { io.err(`error: taint "${body}" not found\n`); return { code: 1 }; }
          removed = true;
          continue;
        }
        const m = s.match(/^([\w./-]+)(=([\w.-]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/);
        if (!m) { io.err(`error: invalid taint spec: ${s}, ${/:/.test(s) ? 'invalid taint effect: ' + s.split(':')[1] + ', unsupported taint effect' : 'unknown taint spec'}\n`); return { code: 1 }; }
        const ex = taints.find(t2 => t2.key === m[1] && t2.effect === m[4]);
        if (ex && !flags.overwrite) { io.err(`error: node ${node.metadata.name} already has ${m[1]} taint(s) with same effect(s) and --overwrite is false\n`); return { code: 1 }; }
        if (ex) ex.value = m[3] || undefined;
        else { const t2 = { key: m[1], effect: m[4] }; if (m[3]) t2.value = m[3]; if (m[4] === 'NoExecute') t2.timeAdded = this.c.ts(); taints.push(t2); }
        added = true;
      }
      node.spec.taints = taints.length ? taints : undefined;
      if (!taints.length) delete node.spec.taints;
      this.c.update(node, { user: this.user });
      io.out(`node/${node.metadata.name} ${added && removed ? 'modified' : added ? 'tainted' : 'untainted'}\n`);
      return { code: 0 };
    }
    cmd_cordon(pos, flags, io) { return this.cordon(pos, io, true); }
    cmd_uncordon(pos, flags, io) { return this.cordon(pos, io, false); }
    cordon(pos, io, on) {
      if (!pos.length) { io.err('error: USAGE: cordon NODE [flags]\n'); return { code: 1 }; }
      const node = this.getc('Node', '', pos[0].replace(/^nodes?\//, ''));
      if (!node) { io.err(`Error from server (NotFound): nodes "${pos[0]}" not found\n`); return { code: 1 }; }
      if (!!node.spec.unschedulable === on) { io.out(`node/${node.metadata.name} already ${on ? 'cordoned' : 'uncordoned'}\n`); return { code: 0 }; }
      if (on) node.spec.unschedulable = true; else delete node.spec.unschedulable;
      node.spec.taints = (node.spec.taints || []).filter(t2 => t2.key !== 'node.kubernetes.io/unschedulable');
      if (on) node.spec.taints.push({ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule', timeAdded: this.c.ts() });
      if (!node.spec.taints.length) delete node.spec.taints;
      this.c.update(node, { user: this.user });
      io.out(`node/${node.metadata.name} ${on ? 'cordoned' : 'uncordoned'}\n`);
      if (on) this.c.narrate('🚧', `Node ${node.metadata.name} is cordoned: existing Pods keep running, but the scheduler won't place new Pods there.`, 'warn');
      return { code: 0 };
    }
    cmd_drain(pos, flags, io) {
      const nodeName = (pos[0] || '').replace(/^nodes?\//, '');
      const node = this.c.get('Node', '', nodeName);
      if (!node) { io.err(`Error from server (NotFound): nodes "${nodeName}" not found\n`); return { code: 1 }; }
      if (!node.spec.unschedulable) this.cordon([nodeName], io, true);
      else io.out(`node/${nodeName} already cordoned\n`);
      const pods = this.c.podsOnNode(nodeName).filter(p => !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
      const ds = [], bare = [], local = [], evict = [];
      for (const p of pods) {
        const ref = H.ctrlRef(p);
        if ((p.metadata.annotations || {})['kubernetes.io/config.source'] === 'file' || (ref && ref.kind === 'Node')) continue; // static/mirror pods
        if (ref && ref.kind === 'DaemonSet') { ds.push(p); continue; }
        if (!ref) bare.push(p);
        if ((p.spec.volumes || []).some(v => v.emptyDir)) local.push(p);
        evict.push(p);
      }
      const errs = [];
      const nm = p => `${p.metadata.namespace}/${p.metadata.name}`;
      if (ds.length && !flags['ignore-daemonsets']) errs.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map(nm).join(', ')}`);
      if (bare.length && !flags.force) errs.push(`cannot delete Pods that declare no controller (use --force to override): ${bare.map(nm).join(', ')}`);
      if (local.length && !flags['delete-emptydir-data'] && !flags['delete-local-data']) errs.push(`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${local.map(nm).join(', ')}`);
      if (errs.length) {
        io.err(`error: unable to drain node "${nodeName}" due to error: ${errs.join(', ')}, continuing command...\nThere are pending nodes to be drained:\n ${nodeName}\n${errs.join('\n')}\n`);
        return { code: 1 };
      }
      if (ds.length) io.err(`Warning: ignoring DaemonSet-managed Pods: ${ds.map(nm).join(', ')}\n`);
      if (bare.length) io.err(`Warning: deleting Pods that declare no controller: ${bare.map(nm).join(', ')}\n`);
      const self = this;
      const queue = evict.slice();
      const evicted = [];
      let nextTry = 0, waited = 0;
      const timeout = flags.timeout ? U.parseDuration(String(flags.timeout)) : 0;
      queue.forEach(p => io.out(`evicting pod ${nm(p)}\n`));
      const step = (dt) => {
        waited += dt || 0;
        if (self.c.now >= nextTry) {
          let blocked = false;
          for (const p of queue.slice()) {
            const live = self.c.get('Pod', p.metadata.namespace, p.metadata.name);
            if (!live) { queue.splice(queue.indexOf(p), 1); continue; }
            if (flags['disable-eviction']) { self.c.delete('Pod', p.metadata.namespace, p.metadata.name, { gracePeriod: flags['grace-period'] != null ? +flags['grace-period'] : undefined }); queue.splice(queue.indexOf(p), 1); evicted.push(p); continue; }
            const pdb = self.c.list('PodDisruptionBudget', p.metadata.namespace).find(b => U.matchSelector(b.spec.selector, p.metadata.labels));
            if (pdb && H.isReady(live) && !((pdb.status || {}).disruptionsAllowed > 0)) {
              io.err(`error when evicting pods/"${p.metadata.name}" -n "${p.metadata.namespace}" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.\n`);
              blocked = true;
              continue;
            }
            if (pdb) { pdb.status.disruptionsAllowed = Math.max(0, (pdb.status.disruptionsAllowed || 0) - 1); }
            self.c.event(live, 'Normal', 'Evicted', 'Eviction API: evicting', 'disruption-controller');
            self.c.delete('Pod', p.metadata.namespace, p.metadata.name, { gracePeriod: flags['grace-period'] != null ? +flags['grace-period'] : undefined });
            queue.splice(queue.indexOf(p), 1);
            evicted.push(p);
          }
          nextTry = blocked ? self.c.now + 5000 : self.c.now;
        }
        for (const p of evicted.slice()) {
          if (!self.c.get('Pod', p.metadata.namespace, p.metadata.name) || (self.c.get('Pod', p.metadata.namespace, p.metadata.name).metadata.uid !== p.metadata.uid)) {
            io.out(`pod/${p.metadata.name} evicted\n`);
            evicted.splice(evicted.indexOf(p), 1);
          }
        }
        if (!queue.length && !evicted.length) { io.out(`node/${nodeName} drained\n`); self.c.narrate('🧹', `Node ${nodeName} drained — its Pods were evicted and recreated elsewhere by their controllers.`, 'good'); return { code: 0 }; }
        if (timeout && waited >= timeout) { io.err(`error: unable to drain node "${nodeName}" due to error: global timeout reached: ${flags.timeout}, continuing command...\nThere are pending nodes to be drained:\n ${nodeName}\nerror: global timeout reached: ${flags.timeout}\n`); return { code: 1 }; }
        return false;
      };
      const r0 = step(0);
      if (r0) return r0;
      return { code: 0, task: { tick(dt) { return step(dt); }, cancel() {} } };
    }

    // =================================================================== logs
    pickPod(spec, ns, io, verb) {
      // "pod", "pod/x", "deploy/x", "x"
      let kind = 'Pod', name = spec;
      if (spec.includes('/')) {
        const [t, n] = spec.split('/');
        const r = KS.lookupResource(t);
        if (!r) { io.err(`error: the server doesn't have a resource type "${t}"\n`); return null; }
        kind = r.kind; name = n;
      }
      if (kind === 'Pod') {
        const p = this.c.get('Pod', ns, name);
        if (!p) { io.err(`Error from server (NotFound): pods "${name}" not found\n`); return null; }
        return p;
      }
      const o = this.c.get(kind, ns, name);
      if (!o) { io.err(`Error from server (NotFound): ${resName(KS.BY_KIND[kind])} "${name}" not found\n`); return null; }
      let pods;
      if (kind === 'Service') pods = this.c.list('Pod', ns).filter(p => U.matchMapSelector(o.spec.selector, p.metadata.labels));
      else pods = this.c.list('Pod', ns).filter(p => o.spec.selector && U.matchSelector(o.spec.selector, p.metadata.labels));
      pods = pods.filter(p => !p.metadata.deletionTimestamp).sort((a, b) => (H.isReady(b) ? 1 : 0) - (H.isReady(a) ? 1 : 0) || Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp));
      if (!pods.length) { io.err(`error: timed out waiting for the condition\n`); return null; }
      if (pods.length > 1 && verb !== 'exec') io.err(`Found ${pods.length} pods, using pod/${pods[0].metadata.name}\n`);
      return pods[0];
    }
    pickContainer(pod, flags, io, verb) {
      const all = pod.spec.containers.map(c2 => c2.name);
      const inits = (pod.spec.initContainers || []).map(c2 => c2.name);
      const eph = (pod.spec.ephemeralContainers || []).map(c2 => c2.name);
      if (flags.container) {
        const n = String(flags.container);
        if (!all.includes(n) && !inits.includes(n) && !eph.includes(n)) { io.err(`error: container ${n} is not valid for pod ${pod.metadata.name}\n`); return null; }
        return n;
      }
      if (all.length > 1 || inits.length) {
        const def = (pod.metadata.annotations || {})['kubectl.kubernetes.io/default-container'] || all[0];
        if (all.length > 1 || verb === 'logs') io.err(`Defaulted container "${def}" out of: ${all.join(', ')}${inits.length ? ', ' + inits.map(x => x + ' (init)').join(', ') : ''}\n`);
        return def;
      }
      return all[0];
    }
    cmd_logs(pos, flags, io) {
      const ns = this.nsOf(flags);
      let pods = [];
      if (flags.selector) {
        const sel = U.parseSelectorString(String(last(flags.selector)));
        pods = this.c.list('Pod', ns).filter(p => U.matchSelector(sel, p.metadata.labels));
        if (!pods.length) { io.err(`No resources found in ${ns} namespace.\n`); return { code: 0 }; }
      } else {
        if (!pos.length) { io.err('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee \'kubectl logs -h\' for help and examples\n'); return { code: 1 }; }
        const p = this.pickPod(pos[0], ns, io, 'logs');
        if (!p) return { code: 1 };
        pods = [p];
        if (pos[1] && !flags.container) flags.container = pos[1];
      }
      const deny = this.can('get', KS.BY_KIND.Pod, ns, pods[0].metadata.name, 'log');
      if (deny) { io.err(deny + '\n'); return { code: 1 }; }
      const tail = flags.tail != null ? +flags.tail : (flags.selector ? 10 : -1);
      const since = flags.since ? U.parseDuration(String(flags.since)) : null;
      const prefixOf = (p, cn) => (flags.prefix || pods.length > 1 && flags.prefix !== false && flags.selector ? `[pod/${p.metadata.name}/${cn}] ` : '');
      const streams = [];
      for (const p of pods) {
        const cnames = flags['all-containers'] ? p.spec.containers.map(c2 => c2.name) : [this.pickContainer(p, flags, io, 'logs')];
        if (cnames[0] == null) return { code: 1 };
        for (const cn of cnames) {
          const rt = this.c.rt.pods[p.metadata.uid];
          const cs = rt && (rt.containers[cn] || rt.init[cn] || rt.ephemeral[cn]);
          if (flags.previous) {
            if (!cs || !cs.prevLogs.length && !cs.restartCount) { io.err(`Error from server (BadRequest): previous terminated container "${cn}" in pod "${p.metadata.name}" not found\n`); return { code: 1 }; }
            this.writeLogs(cs.prevLogs, tail, since, prefixOf(p, cn), flags.timestamps, io);
            continue;
          }
          if (!cs || (!cs.everStarted && !cs.logs.length)) {
            const st = (p.status.containerStatuses || []).concat(p.status.initContainerStatuses || []).find(x => x.name === cn);
            const reason = st && st.state.waiting ? st.state.waiting.reason : 'ContainerCreating';
            const extra = /ImagePull|ErrImage/.test(reason) ? 'trying and failing to pull image' : reason;
            io.err(`Error from server (BadRequest): container "${cn}" in pod "${p.metadata.name}" is waiting to start: ${extra}\n`);
            return { code: 1 };
          }
          this.writeLogs(cs.logs, tail, since, prefixOf(p, cn), flags.timestamps, io);
          streams.push({ cs, prefix: prefixOf(p, cn), seen: cs.logs.length, logsRef: cs.logs });
        }
      }
      this.emitRead('Pod', ns);
      if (!flags.follow) return { code: 0 };
      return {
        code: 0,
        task: {
          tick() {
            for (const s of streams) {
              if (s.cs.logs !== s.logsRef) { s.logsRef = s.cs.logs; s.seen = 0; }
              while (s.seen < s.cs.logs.length) { const l = s.cs.logs[s.seen++]; io.out(s.prefix + (flags.timestamps ? new Date(l.t).toISOString().replace('Z', '000000Z') + ' ' : '') + l.line + '\n'); }
            }
            return false;
          },
          cancel() {},
        },
      };
    }
    writeLogs(logs, tail, since, prefix, ts, io) {
      let l = logs;
      if (since) l = l.filter(x => this.c.now - x.t <= since);
      if (tail >= 0) l = l.slice(Math.max(0, l.length - tail));
      l.forEach(x => io.out(prefix + (ts ? new Date(x.t).toISOString().replace('Z', '000000Z') + ' ' : '') + x.line + '\n'));
    }

    // =================================================================== exec
    cmd_exec(pos, flags, io, dash) {
      const ns = this.nsOf(flags);
      if (!pos.length) { io.err('error: expected \'exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]\'.\nPOD or TYPE/NAME is a required argument for the exec command\n'); return { code: 1 }; }
      if (pos.length > 1 && !dash) { io.err(`error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead\nSee 'kubectl exec -h' for help and examples\n`); return { code: 1 }; }
      if (!dash || !dash.length) { io.err('error: you must specify at least one command for the container\n'); return { code: 1 }; }
      const pod = this.pickPod(pos[0], ns, io, 'exec');
      if (!pod) return { code: 1 };
      const deny = this.can('create', KS.BY_KIND.Pod, ns, pod.metadata.name, 'exec');
      if (deny) { io.err(deny + '\n'); return { code: 1 }; }
      const cn = this.pickContainer(pod, flags, io, 'exec');
      if (!cn) return { code: 1 };
      if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') { io.err(`error: cannot exec into a container in a completed pod; current phase is ${pod.status.phase}\n`); return { code: 1 }; }
      const sh = this.c.execEnv(pod, cn);
      if (!sh) { io.err(`error: unable to upgrade connection: container not found ("${cn}")\n`); return { code: 1 }; }
      const img = R.resolveImage((pod.spec.containers.concat(pod.spec.ephemeralContainers || [], pod.spec.initContainers || []).find(c2 => c2.name === cn) || {}).image);
      const def = img.def || {};
      const exe = String(dash[0]).split('/').pop();
      const hasShell = def.kind === 'shell' || def.shell;
      const debianish = ['nginx', 'httpd', 'redis', 'postgres', 'mysql'].includes(def.flavor) || ['ubuntu', 'perl'].includes(img.key);
      const notFound = () => { io.err(`error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${this.c.suffix(12)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${dash[0]}": executable file not found in $PATH: unknown\n`); return { code: 126 }; };
      if (!hasShell) {
        if (def.flavor === 'hello' || def.flavor === 'api') io.err(`(Kubester: ${img.key} is a "distroless" image — no shell or tools inside. Use: kubectl debug -it ${pod.metadata.name} --image=busybox --target=${cn})\n`);
        return notFound();
      }
      if (exe === 'bash' && !debianish) { const r = notFound(); io.err(`(Kubester: this image has no bash — use sh instead)\n`); return r; }
      if (!R.SHELL_CMDS.has(exe) && !['bash', 'sh', 'ash'].includes(exe)) return notFound();
      const interactive = (flags.stdin || flags.tty) && ['sh', 'bash', 'ash'].includes(exe) && dash.length === 1;
      if (interactive) return { code: 0, interactive: this.makeInteractive(sh, pod) };
      const script = ['sh', 'bash', 'ash'].includes(exe) && dash[1] === '-c' ? dash[2] || '' : dash.map(R.shQuote).join(' ');
      const r = R.runSync(sh, script, { stdin: io.stdin });
      if (r.stdout) io.out(r.stdout);
      if (r.stderr) io.err(r.stderr);
      if (r.code !== 0) { io.err(`command terminated with exit code ${r.code}\n`); return { code: r.code }; }
      return { code: 0 };
    }

    // =================================================================== port-forward
    cmd_port_forward(pos, flags, io) {
      const ns = this.nsOf(flags);
      if (pos.length < 2) { io.err("error: TYPE/NAME and list of ports are required for port-forward\nSee 'kubectl port-forward -h' for help and examples\n"); return { code: 1 }; }
      let kind = 'pod', name = pos[0];
      if (name.includes('/')) { const [t, n] = name.split('/'); const r = KS.lookupResource(t); kind = r ? r.kind.toLowerCase() : t; name = n; }
      const fw = [];
      for (const spec of pos.slice(1)) {
        const [a, b] = spec.split(':');
        const local = a === '' ? 30000 + Math.floor(this.c.rng() * 2000) : +a;
        const remote = +(b || a);
        if (kind === 'service') {
          const svc = this.c.get('Service', ns, name);
          if (!svc) { io.err(`Error from server (NotFound): services "${name}" not found\n`); return { code: 1 }; }
          const sp = svc.spec.ports.find(p => p.port === remote);
          if (!sp) { io.err(`error: Service ${name} does not have a service port ${remote}\n`); return { code: 1 }; }
          fw.push({ local, kind: 'svc', ns, name, port: remote });
        } else {
          const p = kind === 'pod' ? this.c.get('Pod', ns, name) : this.pickPod(`${kind}/${name}`, ns, io);
          if (!p) { if (kind === 'pod') io.err(`Error from server (NotFound): pods "${name}" not found\n`); return { code: 1 }; }
          if (p.status.phase !== 'Running') { io.err(`error: unable to forward port because pod is not running. Current status=${p.status.phase}\n`); return { code: 1 }; }
          fw.push({ local, kind: 'pod', ns, name: p.metadata.name, port: remote });
        }
      }
      for (const f of fw) {
        if (this.c.rt.forwards.some(x => x.local === f.local)) { io.err(`Unable to listen on port ${f.local}: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:${f.local}: bind: address already in use]\nerror: unable to listen on any of the requested ports: [{${f.local} ${f.port}}]\n`); return { code: 1 }; }
      }
      fw.forEach(f => { this.c.rt.forwards.push(f); io.out(`Forwarding from 127.0.0.1:${f.local} -> ${f.port}\nForwarding from [::1]:${f.local} -> ${f.port}\n`); });
      io.err(`(Kubester: in a real terminal this keeps running in the foreground. Here it runs in the background so you can continue — try: curl localhost:${fw[0].local}   Stop it with: kill %${this.c.rt.forwards.length})\n`);
      return { code: 0 };
    }

    // =================================================================== debug
    cmd_debug(pos, flags, io, dash) {
      const ns = this.nsOf(flags);
      if (!pos.length) { io.err('error: one of --image or --copy-to is required, and a target pod or node must be given\n'); return { code: 1 }; }
      const image = flags.image ? String(flags.image) : null;
      if (pos[0].startsWith('node/') || pos[0].startsWith('nodes/')) {
        const nodeName = pos[0].split('/')[1];
        if (!this.c.get('Node', '', nodeName)) { io.err(`Error from server (NotFound): nodes "${nodeName}" not found\n`); return { code: 1 }; }
        if (!image) { io.err('error: --image is required for node debugging\n'); return { code: 1 }; }
        const pname = `node-debugger-${nodeName}-${this.c.suffix(5)}`;
        const r = this.c.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name: pname, namespace: ns }, spec: { nodeName, hostNetwork: true, hostPID: true, restartPolicy: 'Never', containers: [{ name: 'debugger', image, stdin: true, tty: true, command: ['sh', '-c', 'sleep 3600'], volumeMounts: [{ name: 'host-root', mountPath: '/host' }] }], volumes: [{ name: 'host-root', hostPath: { path: '/' } }], tolerations: [{ operator: 'Exists' }] } }, { user: this.user });
        if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
        const nrt = this.c.rt.nodes[nodeName];
        nrt.hostPaths = nrt.hostPaths || {};
        const host = nrt.hostPaths['/'] = nrt.hostPaths['/'] || R.makeStore(false);
        ['etc', 'var', 'var/log', 'var/lib', 'var/lib/kubelet', 'var/lib/containerd', 'etc/kubernetes', 'etc/kubernetes/manifests'].forEach(d => host.dirs.add(d));
        host.files.set('var/log/kubelet.log', `I1118 kubelet.go:2367] "Starting kubelet main sync loop"\nI1118 kubelet_node_status.go:75] "Successfully registered node" node="${nodeName}"\n`);
        host.files.set('etc/hostname', nodeName + '\n');
        io.out(`Creating debugging pod ${pname} with container debugger on node ${nodeName}.\n`);
        return this.attachWhenRunning(ns, pname, 'debugger', io, () => io.out(`(Kubester: the node's root filesystem is mounted at /host. Delete the debug pod when done: kubectl delete pod ${pname})\n`));
      }
      const pod = this.c.get('Pod', ns, pos[0].replace(/^pods?\//, ''));
      if (!pod) { io.err(`Error from server (NotFound): pods "${pos[0]}" not found\n`); return { code: 1 }; }
      if (flags['copy-to']) {
        const copy = { apiVersion: 'v1', kind: 'Pod', metadata: { name: String(flags['copy-to']), namespace: ns, labels: flags['keep-labels'] ? pod.metadata.labels : undefined }, spec: U.clone(pod.spec) };
        delete copy.spec.nodeName;
        copy.spec.volumes = (copy.spec.volumes || []).filter(v => !v.name.startsWith('kube-api-access'));
        copy.spec.containers.forEach(c2 => { c2.volumeMounts = (c2.volumeMounts || []).filter(v => !v.name.startsWith('kube-api-access')); if (!c2.volumeMounts.length) delete c2.volumeMounts; });
        if (flags['share-processes']) copy.spec.shareProcessNamespace = true;
        if (image) copy.spec.containers.push({ name: flags.container ? String(flags.container) : `debugger-${this.c.suffix(5)}`, image, stdin: true, tty: true, command: ['sh', '-c', 'sleep 3600'] });
        const r = this.c.create(copy, { user: this.user });
        if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
        io.out(`(Kubester) created debug copy pod/${copy.metadata.name}\n`);
        return { code: 0 };
      }
      if (!image) { io.err('error: --image is required when debugging with an ephemeral container\n'); return { code: 1 }; }
      const cname = flags.container ? String(flags.container) : `debugger-${this.c.suffix(5)}`;
      const ec = { name: cname, image, stdin: !!flags.stdin, tty: !!flags.tty, terminationMessagePolicy: 'File', imagePullPolicy: 'IfNotPresent', resources: {}, terminationMessagePath: '/dev/termination-log' };
      ec.command = dash && dash.length ? dash.slice() : ['sh', '-c', 'sleep 3600'];
      if (flags.target) {
        if (!pod.spec.containers.some(c2 => c2.name === flags.target)) { io.err(`error: target container "${flags.target}" not found in pod ${pod.metadata.name}\n`); return { code: 1 }; }
        ec.targetContainerName = String(flags.target);
        io.out(`Targeting container "${flags.target}". If you don't see processes from this container it may be because the container runtime doesn't support this feature.\n`);
      }
      if (!flags.container) io.out(`Defaulting debug container name to ${cname}.\n`);
      pod.spec.ephemeralContainers = (pod.spec.ephemeralContainers || []).concat([ec]);
      this.c.put(pod);
      this.c.narrate('🩻', `kubectl debug added ephemeral container ${cname} (${image}) to ${pod.metadata.name} — a temporary toolbox that shares the Pod's network${ec.targetContainerName ? ' and process namespace' : ''}.`, 'info');
      if (!(flags.stdin || flags.tty)) return { code: 0 };
      return this.attachWhenRunning(ns, pod.metadata.name, cname, io, () => { if (ec.targetContainerName) io.out(`(Kubester: the target container's filesystem is visible at /proc/1/root)\n`); });
    }
    attachWhenRunning(ns, podName, cname, io, onAttach) {
      const self = this;
      let waited = 0;
      return {
        code: 0,
        task: {
          tick(dt) {
            waited += dt || 100;
            const p = self.c.get('Pod', ns, podName);
            if (!p) { io.err('error: pod disappeared\n'); return true; }
            const sh = self.c.execEnv(p, cname);
            if (sh) {
              io.out("If you don't see a command prompt, try pressing enter.\n");
              if (onAttach) onAttach();
              return { interactive: self.makeInteractive(sh, p) };
            }
            if (waited > 30000) { io.err('error: timed out waiting for the debug container to start\n'); return true; }
            return false;
          },
          cancel() {},
        },
      };
    }

    // =================================================================== top
    cmd_top(pos, flags, io) {
      const what = pos[0];
      if (!this.c.metricsAvailable()) { io.err('error: Metrics API not available\n'); return { code: 1 }; }
      if (/^(nodes?|no)$/.test(what || '')) {
        const nodes = pos[1] ? [this.c.get('Node', '', pos[1])].filter(Boolean) : this.c.list('Node');
        const rows = nodes.map(n => {
          const pods = this.c.podsOnNode(n.metadata.name).filter(p => p.status.phase === 'Running');
          const up = this.c.rt.nodes[n.metadata.name].up;
          if (!up) return [n.metadata.name, '<unknown>', '<unknown>', '<unknown>', '<unknown>'];
          const cpu = 60 + pods.reduce((s, p) => s + this.c.podCpu(p), 0);
          const mem = 480 + pods.reduce((s, p) => s + this.c.podMem(p), 0);
          return [n.metadata.name, Math.round(cpu) + 'm', Math.round(cpu / 2000 * 100) + '%', Math.round(mem) + 'Mi', Math.round(mem / 4096 * 100) + '%'];
        });
        if (flags['sort-by'] === 'cpu') rows.sort((a, b) => parseInt(b[1], 10) - parseInt(a[1], 10));
        if (flags['sort-by'] === 'memory') rows.sort((a, b) => parseInt(b[3], 10) - parseInt(a[3], 10));
        U.table(['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], rows).forEach(l => io.out(l + '\n'));
        return { code: 0 };
      }
      if (!/^(pods?|po)$/.test(what || '')) { io.err('error: (Kubester) usage: kubectl top pods | kubectl top nodes\n'); return { code: 1 }; }
      const ns = this.nsOf(flags);
      const all = !!flags['all-namespaces'];
      let pods = this.c.list('Pod', all ? undefined : ns).filter(p => p.status.phase === 'Running' && !p.metadata.deletionTimestamp);
      if (pos[1]) pods = pods.filter(p => p.metadata.name === pos[1]);
      if (flags.selector) { const sel = U.parseSelectorString(String(last(flags.selector))); pods = pods.filter(p => U.matchSelector(sel, p.metadata.labels)); }
      if (!pods.length) { io.err(pos[1] ? `error: pods "${pos[1]}" not found\n` : `No resources found in ${ns} namespace.\n`); return { code: pos[1] ? 1 : 0 }; }
      let rows;
      if (flags.containers) {
        rows = pods.flatMap(p => p.spec.containers.map(c2 => { const cs = (this.c.rt.pods[p.metadata.uid] || { containers: {} }).containers[c2.name]; return [p.metadata.name, c2.name, Math.max(1, Math.round(cs && cs.proc ? (p.spec.containers.length === 1 ? this.c.podCpu(p) : cs.proc.cpu()) : 0)) + 'm', Math.round(cs && cs.proc ? cs.proc.mem() : 0) + 'Mi']; }));
        if (all) rows = rows.map((r, i) => [pods[0].metadata.namespace].concat(r));
        U.table((all ? ['NAMESPACE'] : []).concat(['POD', 'NAME', 'CPU(cores)', 'MEMORY(bytes)']), rows).forEach(l => io.out(l + '\n'));
        return { code: 0 };
      }
      rows = pods.map(p => (all ? [p.metadata.namespace] : []).concat([p.metadata.name, Math.max(1, this.c.podCpu(p)) + 'm', Math.max(1, Math.round(this.c.podMem(p))) + 'Mi']));
      if (flags['sort-by'] === 'cpu') rows.sort((a, b) => parseInt(b[all ? 2 : 1], 10) - parseInt(a[all ? 2 : 1], 10));
      if (flags['sort-by'] === 'memory') rows.sort((a, b) => parseInt(b[all ? 3 : 2], 10) - parseInt(a[all ? 3 : 2], 10));
      U.table((all ? ['NAMESPACE'] : []).concat(['NAME', 'CPU(cores)', 'MEMORY(bytes)']), rows).forEach(l => io.out(l + '\n'));
      return { code: 0 };
    }

    // =================================================================== explain / diff / autoscale / patch / wait / events
    cmd_explain(pos, flags, io) {
      if (!pos.length) { io.err("error: You must specify the type of resource to explain. Use \"kubectl api-resources\" for a complete list of supported resources.\n"); return { code: 1 }; }
      const [res, ...path] = pos[0].split('.');
      const r = KS.explain(res, path, !!flags.recursive);
      if (r.error) { io.err(r.error + '\n'); return { code: 1 }; }
      io.out(r.out);
      return { code: 0 };
    }
    cmd_diff(pos, flags, io) {
      const l = this.loadDocs(flags, io);
      if (l.error) { io.err(l.error + '\n'); return { code: 1 }; }
      let changed = false;
      for (const item of l.items) {
        if (!item.doc) continue;
        const d = U.clone(item.doc);
        const ns = KS.BY_KIND[d.kind].namespaced ? (d.metadata.namespace || this.nsOf(flags)) : undefined;
        if (ns) d.metadata.namespace = ns;
        const cur = this.c.get(d.kind, ns, d.metadata.name);
        const strip = o => { const x = U.clone(o); if (!x) return x; delete x.status; if (x.metadata) { delete x.metadata.annotations && x.metadata.annotations && delete x.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']; if (x.metadata.annotations && !Object.keys(x.metadata.annotations).length) delete x.metadata.annotations; delete x.metadata.resourceVersion; delete x.metadata.generation; } return x; };
        let merged;
        if (cur) {
          const res = this.c.update(this.mergeApply(cur, d, JSON.stringify(d)), { dryRun: true });
          if (!res.ok) { io.err(res.error + '\n'); return { code: 1 }; }
          merged = res.obj;
        } else {
          const res = this.c.create(d, { namespace: ns, dryRun: true });
          if (!res.ok) { io.err(res.error + '\n'); return { code: 1 }; }
          merged = res.obj;
        }
        const a = cur ? toYaml(strip(cur)).split('\n') : [];
        const b = toYaml(strip(merged)).split('\n');
        if (a[a.length - 1] === '') a.pop();
        if (b[b.length - 1] === '') b.pop();
        if (cur && a.join('\n') === b.join('\n')) continue;
        changed = true;
        const id = `${KS.BY_KIND[d.kind].group ? KS.BY_KIND[d.kind].group + '.' : ''}${KS.BY_KIND[d.kind].apiVersion.split('/').pop()}.${d.kind}.${ns ? ns + '.' : ''}${d.metadata.name}`;
        io.out(`diff -u -N /tmp/LIVE-${this.c.suffix(8)}/${id} /tmp/MERGED-${this.c.suffix(8)}/${id}\n`);
        io.out(`--- /tmp/LIVE/${id}\t${KS.fmtDate(this.c.ts())}\n+++ /tmp/MERGED/${id}\t${KS.fmtDate(this.c.ts())}\n`);
        unifiedDiff(a, b).forEach(line => io.out(line + '\n'));
      }
      return { code: changed ? 1 : 0, quietCode: true };
    }
    cmd_autoscale(pos, flags, io) {
      const t = this.resolveTargets(pos);
      if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
      const g = t.groups[0];
      const ns = this.nsOf(flags);
      if (!g || !g.names[0]) { io.err('error: (Kubester) usage: kubectl autoscale deployment NAME --min=1 --max=5 --cpu-percent=50\n'); return { code: 1 }; }
      if (!['Deployment', 'StatefulSet', 'ReplicaSet'].includes(g.res.kind)) { io.err(`error: cannot autoscale a ${g.res.kind}: deployments, replicasets and statefulsets only\n`); return { code: 1 }; }
      const o = this.c.get(g.res.kind, ns, g.names[0]);
      if (!o) { io.err(`Error from server (NotFound): ${resName(g.res)} "${g.names[0]}" not found\n`); return { code: 1 }; }
      if (flags.max == null) { io.err('error: --max=MAXPODS is required and must be at least 1, max: -1\n'); return { code: 1 }; }
      const cpu = flags['cpu-percent'] != null ? +flags['cpu-percent'] : flags.cpu != null ? parseInt(String(flags.cpu), 10) : 80;
      const metrics = [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: cpu } } }];
      if (flags.memory) metrics.push({ type: 'Resource', resource: { name: 'memory', target: /%$/.test(String(flags.memory)) ? { type: 'Utilization', averageUtilization: parseInt(String(flags.memory), 10) } : { type: 'AverageValue', averageValue: String(flags.memory) } } });
      const hpa = { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name: flags.name ? String(flags.name) : o.metadata.name }, spec: { maxReplicas: +flags.max, minReplicas: flags.min != null ? +flags.min : 1, metrics, scaleTargetRef: { apiVersion: o.apiVersion, kind: o.kind, name: o.metadata.name } }, status: { currentMetrics: null, desiredReplicas: 0 } };
      return this.createDoc(hpa, flags, { out: s => io.out(s.replace(' created', ' autoscaled')), err: io.err });
    }
    cmd_patch(pos, flags, io) {
      const t = this.resolveTargets(pos);
      if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
      const g = t.groups[0];
      const ns = this.nsOf(flags);
      if (!g || !g.names[0]) { io.err('error: (Kubester) usage: kubectl patch TYPE NAME -p \'{"spec":{"replicas":2}}\'\n'); return { code: 1 }; }
      if (!flags.patch) { io.err('error: must specify -p to patch\n'); return { code: 1 }; }
      const o = this.c.get(g.res.kind, ns, g.names[0]);
      if (!o) { io.err(`Error from server (NotFound): ${resName(g.res)} "${g.names[0]}" not found\n`); return { code: 1 }; }
      let patch;
      const raw = String(flags.patch);
      try { patch = JSON.parse(raw); } catch (e) { try { patch = yaml.load(raw); } catch (e2) { io.err(`error: unable to parse "${raw}": yaml: did not find expected node content\n`); return { code: 1 }; } }
      const type = flags.type ? String(flags.type) : 'strategic';
      let next;
      try {
        if (type === 'json') next = U.jsonPatch(o, patch);
        else if (type === 'merge') next = U.mergePatch(o, patch);
        else next = strategicMerge(o, patch);
      } catch (e) { io.err(`The request is invalid: ${e.message}\n`); return { code: 1 }; }
      const deny = this.can('patch', g.res, ns, o.metadata.name);
      if (deny) { io.err(deny + '\n'); return { code: 1 }; }
      const r = this.c.update(next, { user: this.user });
      if (!r.ok) { io.err(r.error + '\n'); return { code: 1 }; }
      io.out(`${refName(o)} ${r.changed === false ? 'patched (no change)' : 'patched'}\n`);
      return { code: 0 };
    }
    cmd_wait(pos, flags, io) {
      if (!flags.for) { io.err('error: --for must be specified, e.g. --for=condition=Ready or --for=delete\n'); return { code: 1 }; }
      const ns = this.nsOf(flags);
      let targets = [];
      if (flags.selector || flags.all) {
        const r = KS.lookupResource(pos[0]);
        if (!r) { io.err(`error: the server doesn't have a resource type "${pos[0]}"\n`); return { code: 1 }; }
        targets = this.selectObjects(r, ns, false, [], flags).objs.map(o => ({ kind: r.kind, name: o.metadata.name }));
      } else {
        const t = this.resolveTargets(pos);
        if (t.error) { io.err(t.error + '\n'); return { code: 1 }; }
        t.groups.forEach(g => g.names.forEach(n => targets.push({ kind: g.res.kind, name: n })));
      }
      if (!targets.length) { io.err('error: no matching resources found\n'); return { code: 1 }; }
      const forS = String(flags.for);
      const timeout = U.parseDuration(String(flags.timeout || '30s')) || 30000;
      const self = this;
      const done = new Set();
      let waited = 0;
      const check = tg => {
        const o = self.c.get(tg.kind, ns, tg.name);
        if (forS === 'delete') return !o;
        if (!o) return null;
        let m;
        if ((m = forS.match(/^condition=([\w.-]+)(=(\w+))?$/i))) {
          const want = (m[3] || 'True').toLowerCase();
          const c2 = ((o.status && o.status.conditions) || []).find(x => x.type.toLowerCase() === m[1].toLowerCase());
          return !!c2 && String(c2.status).toLowerCase() === want;
        }
        if ((m = forS.match(/^jsonpath=(.+?)=(.+)$/))) {
          const path = m[1].replace(/^'|'$/g, '').replace(/^\{|\}$/g, '');
          return jpEval(path, o).map(jpStr).join(' ') === m[2].replace(/^'|'$/g, '');
        }
        return null;
      };
      const step = dt => {
        waited += dt;
        for (const tg of targets) {
          if (done.has(tg)) continue;
          const r = check(tg);
          if (r === null && forS !== 'delete') { io.err(`Error from server (NotFound): ${resName(KS.BY_KIND[tg.kind])} "${tg.name}" not found\n`); return { code: 1 }; }
          if (r) { done.add(tg); io.out(`${kindRef(KS.BY_KIND[tg.kind])}/${tg.name} ${forS === 'delete' ? 'deleted' : 'condition met'}\n`); }
        }
        if (done.size === targets.length) return { code: 0 };
        if (waited >= timeout) { targets.filter(x => !done.has(x)).forEach(x => io.err(`error: timed out waiting for the condition on ${resName(KS.BY_KIND[x.kind])}/${x.name}\n`)); return { code: 1 }; }
        return false;
      };
      const r0 = step(0);
      if (r0) return r0;
      return { code: 0, task: { tick(dt) { return step(dt || 100); }, cancel() {} } };
    }
    cmd_events(pos, flags, io) {
      const ns = this.nsOf(flags);
      const all = !!flags['all-namespaces'];
      let evs = this.c.list('Event', all ? undefined : ns);
      if (flags.for) { const [k, n] = String(flags.for).split('/'); const r = KS.lookupResource(k); evs = evs.filter(e => e.involvedObject.name === n && (!r || e.involvedObject.kind === r.kind)); }
      if (flags.types) { const ts = String(flags.types).split(','); evs = evs.filter(e => ts.includes(e.type)); }
      evs.sort((a, b) => Date.parse(a.lastTimestamp) - Date.parse(b.lastTimestamp));
      if (!evs.length) { io.err(all ? 'No events found.\n' : `No events found in ${ns} namespace.\n`); return { code: 0 }; }
      const rows = evs.map(e => (all ? [e.metadata.namespace] : []).concat([U.humanDuration(this.c.now - Date.parse(e.lastTimestamp)), e.type, e.reason, `${e.involvedObject.kind}/${e.involvedObject.name}`, e.message]));
      U.table((all ? ['NAMESPACE'] : []).concat(['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE']), rows).forEach(l => io.out(l + '\n'));
      return { code: 0 };
    }

    // =================================================================== auth / config / misc
    cmd_auth(pos, flags, io) {
      const sub = pos[0];
      if (sub === 'whoami') {
        const u = this.user;
        U.table(['ATTRIBUTE', 'VALUE'], [['Username', u.name], ['Groups', `[${(u.name === 'kubernetes-admin' ? ['kubeadm:cluster-admins', 'system:authenticated'] : u.groups).join(' ')}]`]]).forEach(l => io.out(l + '\n'));
        return { code: 0 };
      }
      if (sub !== 'can-i') { io.err('error: (Kubester) supported: kubectl auth can-i VERB RESOURCE [--as=...] , kubectl auth whoami\n'); return { code: 1 }; }
      const ns = this.nsOf(flags);
      if (flags.list) {
        const rows = [];
        for (const r of KS.RESOURCES) {
          const verbs = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'].filter(v => this.c.authorize(this.user, v, r, r.namespaced ? ns : null).allowed);
          if (verbs.length) rows.push([resName(r), '[]', '[]', `[${verbs.length === 7 ? '*' : verbs.join(' ')}]`]);
        }
        U.table(['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], rows).forEach(l => io.out(l + '\n'));
        return { code: 0 };
      }
      const verb = pos[1];
      let resWord = pos[2];
      if (!verb || !resWord) { io.err("error: you must specify two arguments: verb resource or verb resource/resourceName.\nSee 'kubectl auth can-i -h' for help and examples\n"); return { code: 1 }; }
      let name = pos[3];
      if (resWord.includes('/')) { const parts = resWord.split('/'); resWord = parts[0]; if (KS.lookupResource(parts[0]) && parts[1] && !['log', 'exec', 'scale', 'status', 'portforward', 'eviction'].includes(parts[1])) name = parts[1]; else flags.subresource = parts[1]; }
      const r = resWord === '*' ? { plural: '*', group: '*', namespaced: true } : KS.lookupResource(resWord);
      if (!r) { io.err(`Warning: the server doesn't have a resource type '${resWord}'\n\nno\n`); return { code: 1 }; }
      const ok = r.plural === '*' ? (this.user.groups || []).includes('system:masters') : this.c.authorize(this.user, verb === '*' ? '*' : verb, r, r.namespaced ? ns : null, name, flags.subresource).allowed;
      if (!flags.quiet) io.out(ok ? 'yes\n' : 'no\n');
      return { code: ok ? 0 : 1, quietCode: true };
    }
    cmd_config(pos, flags, io) {
      const sub = pos[0];
      const ctx = this.c.context;
      switch (sub) {
        case 'current-context': io.out(ctx.name + '\n'); return { code: 0 };
        case 'get-contexts': {
          U.table(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], [['*', ctx.name, ctx.cluster, ctx.user, ctx.namespace === 'default' ? '' : ctx.namespace]]).forEach(l => io.out(l.replace(/<none>/g, '') + '\n'));
          return { code: 0 };
        }
        case 'get-clusters': io.out('NAME\nkubester\n'); return { code: 0 };
        case 'get-users': io.out('NAME\nkubernetes-admin\n'); return { code: 0 };
        case 'set-context': {
          const target = flags.current ? ctx.name : pos[1];
          if (target !== ctx.name) { io.err(`error: (Kubester) only the current context "${ctx.name}" exists — use: kubectl config set-context --current --namespace=NAME\n`); return { code: 1 }; }
          if (flags.namespace) {
            ctx.namespace = String(flags.namespace);
            if (!this.c.get('Namespace', '', ctx.namespace)) io.err(`(Kubester: note — namespace "${ctx.namespace}" doesn't exist yet. kubectl doesn't check; commands will fail until you create it.)\n`);
          }
          io.out(`Context "${ctx.name}" modified.\n`);
          this.c.emit('context', ctx);
          return { code: 0 };
        }
        case 'use-context': {
          if (pos[1] !== ctx.name) { io.err(`error: no context exists with the name: "${pos[1] || ''}"\n`); return { code: 1 }; }
          io.out(`Switched to context "${ctx.name}".\n`); return { code: 0 };
        }
        case 'view': {
          const cfg = { apiVersion: 'v1', clusters: [{ cluster: { 'certificate-authority-data': 'DATA+OMITTED', server: 'https://192.168.49.10:6443' }, name: 'kubester' }], contexts: [{ context: Object.assign({ cluster: 'kubester', user: 'kubernetes-admin' }, ctx.namespace !== 'default' ? { namespace: ctx.namespace } : {}), name: ctx.name }], 'current-context': ctx.name, kind: 'Config', preferences: {}, users: [{ name: 'kubernetes-admin', user: { 'client-certificate-data': 'DATA+OMITTED', 'client-key-data': 'DATA+OMITTED' } }] };
          io.out(String(flags.output) === 'json' ? toJson(cfg) + '\n' : toYaml(cfg));
          return { code: 0 };
        }
        default: io.err('error: (Kubester) supported: config view | current-context | get-contexts | set-context --current --namespace=NS | use-context\n'); return { code: 1 };
      }
    }
    cmd_api_resources(pos, flags, io) {
      let rs = KS.RESOURCES.filter(r => r.kind !== 'Endpoints' || true);
      if (flags.namespaced != null) rs = rs.filter(r => r.namespaced === (flags.namespaced === true || flags.namespaced === 'true'));
      if (flags['api-group'] != null) rs = rs.filter(r => r.group === String(flags['api-group'] === true ? '' : flags['api-group']));
      rs = rs.slice().sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.plural.localeCompare(b.plural));
      if (flags.output === 'name') { rs.forEach(r => io.out(resName(r) + '\n')); return { code: 0 }; }
      U.table(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], rs.map(r => [r.plural, r.short.join(','), r.apiVersion, String(r.namespaced), r.kind])).forEach(l => io.out(l.replace(/<none>/g, '      ') + '\n'));
      return { code: 0 };
    }
    cmd_api_versions(pos, flags, io) {
      [...new Set(KS.RESOURCES.map(r => r.apiVersion).concat(['autoscaling/v1', 'events.k8s.io/v1']))].sort().forEach(v => io.out(v + '\n'));
      return { code: 0 };
    }
    cmd_cluster_info(pos, flags, io) {
      if (pos[0] === 'dump') { io.out('(Kubester: cluster-info dump prints every object and log in the cluster — try kubectl get all -A and kubectl get events -A instead.)\n'); return { code: 0 }; }
      io.out('Kubernetes control plane is running at https://192.168.49.10:6443\nCoreDNS is running at https://192.168.49.10:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use \'kubectl cluster-info dump\'.\n');
      this.emitRead('Service', 'kube-system');
      return { code: 0 };
    }
    cmd_version(pos, flags, io) {
      const v = this.c.version;
      if (String(flags.output) === 'yaml' || String(flags.output) === 'json') {
        const o = { clientVersion: { gitVersion: v, major: '1', minor: v.split('.')[1], platform: 'linux/amd64' }, kustomizeVersion: 'v5.6.0', serverVersion: flags.client ? undefined : { gitVersion: v, major: '1', minor: v.split('.')[1], platform: 'linux/amd64' } };
        io.out(flags.output === 'json' ? toJson(o) + '\n' : toYaml(o));
        return { code: 0 };
      }
      io.out(`Client Version: ${v}\nKustomize Version: v5.6.0\n${flags.client ? '' : `Server Version: ${v}\n`}`);
      return { code: 0 };
    }
    cmd_kustomize(pos, flags, io) {
      if (!KS.kustomize) { io.err('error: kustomize not available\n'); return { code: 1 }; }
      const r = KS.kustomize(this, pos[0] || '.');
      if (r.error) { io.err(r.error + '\n'); return { code: 1 }; }
      io.out(r.docs.map(d => toYaml(d)).join('---\n'));
      return { code: 0 };
    }
    cmd_cp(pos, flags, io) { io.err('error: (Kubester) kubectl cp is not simulated. Use: kubectl exec POD -- cat /path/file > localfile\n'); return { code: 1 }; }
    cmd_attach(pos, flags, io) { io.err('error: (Kubester) kubectl attach is not simulated. Use kubectl logs -f or kubectl exec -it.\n'); return { code: 1 }; }
    cmd_proxy(pos, flags, io) { io.out('Starting to serve on 127.0.0.1:8001\n(Kubester: the API proxy is not simulated beyond this message.)\n'); return { code: 0 }; }
    cmd_certificate(pos, flags, io) { io.err('No resources found (Kubester: CertificateSigningRequests are not simulated; see Handbook Q103.)\n'); return { code: 1 }; }
    cmd_completion(pos, flags, io) { io.out('# (Kubester) Tab completion is already built into this terminal — press Tab!\n'); return { code: 0 }; }
    cmd_options(pos, flags, io) { io.out('The following options can be passed to any command:\n\n  -n, --namespace=\'\': If present, the namespace scope for this CLI request\n      --as=\'\': Username to impersonate for the operation.\n      --context=\'\': The name of the kubeconfig context to use\n'); return { code: 0 }; }
    cmd_plugin(pos, flags, io) { io.out('error: unable to find any kubectl plugins in your PATH\n'); return { code: 1 }; }
    cmd_alpha(pos, flags, io) { io.err('error: (Kubester) alpha commands are not simulated\n'); return { code: 1 }; }
  }

  // ------------------------------------------------------------------ misc helpers
  function fmtCreateErr(err, source) {
    if (/^Error from server \((\w+)\): /.test(err) && !/error when creating/.test(err) && source) {
      return err.replace(/^Error from server \((\w+)\): /, (m, a) => `Error from server (${a}): error when creating "${source}": `);
    }
    if (/^The \w+ "/.test(err) && source) return `Error from server (Invalid): error when creating "${source}": ${err}`;
    return err;
  }
  function fmtApplyErr(err, source, d) {
    if (/^The \w+ "/.test(err)) return `Error from server (Invalid): error when applying patch:\n${toJsonInline(d)}\nto:\nResource: "${resName(KS.BY_KIND[d.kind])}", GroupVersionKind: "${d.apiVersion}, Kind=${d.kind}"\nName: "${d.metadata.name}", Namespace: "${d.metadata.namespace || ''}"\nfor: "${source}": error when patching "${source}": ${err}`;
    return err;
  }
  function toJsonInline(d) { return JSON.stringify({ metadata: { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '...' } }, spec: d.spec ? '...' : undefined }); }
  function strategicMerge(target, patch) {
    if (Array.isArray(patch)) return U.clone(patch);
    if (!U.isObj(patch)) return U.clone(patch);
    const out = U.isObj(target) ? U.clone(target) : {};
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      if (pv === null) { delete out[k]; continue; }
      const tv = out[k];
      if (Array.isArray(pv) && Array.isArray(tv) && pv.every(x => U.isObj(x) && x.name) && tv.every(x => U.isObj(x) && x.name)) {
        const merged = tv.map(x => U.clone(x));
        for (const item of pv) {
          const i = merged.findIndex(x => x.name === item.name);
          if (item.$patch === 'delete') { if (i >= 0) merged.splice(i, 1); continue; }
          if (i >= 0) merged[i] = strategicMerge(merged[i], item); else merged.push(U.clone(item));
        }
        out[k] = merged;
      } else out[k] = strategicMerge(tv, pv);
    }
    return out;
  }
  function unifiedDiff(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { ops.push([' ', a[i], i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i], i, j]); i++; } else { ops.push(['+', b[j], i, j]); j++; } }
    while (i < n) { ops.push(['-', a[i], i, j]); i++; }
    while (j < m) { ops.push(['+', b[j], i, j]); j++; }
    // hunks with 3 lines of context
    const out = [];
    const idx = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter(k => k >= 0);
    if (!idx.length) return out;
    let start = Math.max(0, idx[0] - 3), end = Math.min(ops.length, idx[0] + 4);
    const hunks = [];
    for (const k of idx.slice(1)) { if (k - 3 <= end) end = Math.min(ops.length, k + 4); else { hunks.push([start, end]); start = Math.max(0, k - 3); end = Math.min(ops.length, k + 4); } }
    hunks.push([start, end]);
    for (const [s, e] of hunks) {
      const seg = ops.slice(s, e);
      const aStart = seg[0][2] + 1, bStart = seg[0][3] + 1;
      const aLen = seg.filter(o => o[0] !== '+').length, bLen = seg.filter(o => o[0] !== '-').length;
      out.push(`@@ -${aLen ? aStart : 0},${aLen} +${bLen ? bStart : 0},${bLen} @@`);
      seg.forEach(o => out.push(o[0] + o[1]));
    }
    return out;
  }
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  const jpEvalRef = jpEval;
  void jpEvalRef;

  const HELP = `kubectl controls the Kubernetes cluster manager.

 Find more information at: https://kubernetes.io/docs/reference/kubectl/

Basic Commands (Beginner):
  create          Create a resource from a file or from stdin
  expose          Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service
  run             Run a particular image on the cluster
  set             Set specific features on objects

Basic Commands (Intermediate):
  explain         Get documentation for a resource
  get             Display one or many resources
  edit            Edit a resource on the server
  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector

Deploy Commands:
  rollout         Manage the rollout of a resource
  scale           Set a new size for a deployment, replica set, or stateful set
  autoscale       Auto-scale a deployment, replica set, stateful set, or replication controller

Cluster Management Commands:
  cluster-info    Display cluster information
  top             Display resource (CPU/memory) usage
  cordon          Mark node as unschedulable
  uncordon        Mark node as schedulable
  drain           Drain node in preparation for maintenance
  taint           Update the taints on one or more nodes

Troubleshooting and Debugging Commands:
  describe        Show details of a specific resource or group of resources
  logs            Print the logs for a container in a pod
  exec            Execute a command in a container
  port-forward    Forward one or more local ports to a pod
  debug           Create debugging sessions for troubleshooting workloads and nodes
  events          List events

Advanced Commands:
  diff            Diff the live version against a would-be applied version
  apply           Apply a configuration to a resource by file name or stdin
  patch           Update fields of a resource
  replace         Replace a resource by file name or stdin
  wait            Experimental: Wait for a specific condition on one or many resources
  kustomize       Build a kustomization target from a directory or URL

Settings Commands:
  label           Update the labels on a resource
  annotate        Update the annotations on a resource

Other Commands:
  api-resources   Print the supported API resources on the server
  api-versions    Print the supported API versions on the server, in the form of "group/version"
  auth            Inspect authorization
  config          Modify kubeconfig files
  version         Print the client and server version information

Usage:
  kubectl [flags] [options]

Use "kubectl <command> --help" for more information about a given command.
`;

  KS.Kubectl = Kubectl;
  KS.kubectlParseArgs = parseArgs;
  KS.CMD_FLAGS = CMD_FLAGS;
  KS.refName = refName;
  KS.API_VERSIONS = API_VERSIONS;
})(typeof window !== 'undefined' ? window : globalThis);
