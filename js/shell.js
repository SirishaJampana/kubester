/* Kubester — the learner's laptop shell: kubectl/helm/sim tools, files, pipes, completion. No DOM. */
(function (G) {
  'use strict';
  const KS = G.KS;
  const U = KS.util;
  const R = KS.runtime;

  const HOME = '/home/learner';

  // ------------------------------------------------------------------ mini jq
  function jq(filter, input, raw) {
    let data;
    try { data = JSON.parse(input); } catch (e) { return { error: 'jq: error (at <stdin>:0): Cannot parse input as JSON' }; }
    const stages = filter.split('|').map(s => s.trim()).filter(Boolean);
    let cur = [data];
    for (const st of stages) {
      if (st === '.') continue;
      if (st === 'length') { cur = cur.map(v => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : String(v || '').length)); continue; }
      if (st === 'keys') { cur = cur.map(v => Object.keys(v || {}).sort()); continue; }
      let m;
      if ((m = st.match(/^select\((.+)\)$/))) {
        const cond = m[1].match(/^(\.[\w.[\]"-]*)\s*(==|!=)\s*(.+)$/);
        const ne = m[1].match(/^(\.[\w.[\]"-]*)\s*!=\s*null$/);
        cur = cur.filter(v => {
          if (ne) { const r = KS.jsonpath.eval(ne[1], v); return r.length && r[0] != null; }
          if (!cond) return false;
          const r = KS.jsonpath.eval(cond[1], v)[0];
          const want = JSON.parse(cond[3].replace(/'/g, '"'));
          return cond[2] === '==' ? JSON.stringify(r) === JSON.stringify(want) : JSON.stringify(r) !== JSON.stringify(want);
        });
        continue;
      }
      if (!st.startsWith('.')) return { error: `jq: error: ${st} is not supported by Kubester's mini jq (supported: paths like .items[].metadata.name, select(...), length, keys)` };
      const path = st.replace(/\[\]/g, '[*]').replace(/\["([^"]+)"\]/g, "['$1']");
      const next = [];
      for (const v of cur) next.push(...(path === '.' ? [v] : KS.jsonpath.eval(path, v)));
      if (!next.length && !/\[\*\]/.test(path)) next.push(null);
      cur = next;
    }
    return { out: cur.map(v => (raw && typeof v === 'string' ? v : JSON.stringify(v, null, 2))).join('\n') + '\n' };
  }

  // ------------------------------------------------------------------ the shell
  class HostShell {
    constructor(cluster, opts) {
      opts = opts || {};
      this.c = cluster;
      this.hooks = opts.hooks || {};
      this.fs = new R.Fs();
      ['home', 'home/learner', 'home/learner/manifests', 'tmp'].forEach(d => this.fs.root.dirs.add(d));
      this.fs.root.files.set('home/learner/README.txt', 'Welcome to Kubester!\n\nThis is your laptop. It has kubectl (alias k) configured for the "kubester" cluster.\nExample manifests for the lessons live in ~/manifests.\n\nUseful: kubectl get nodes | ls manifests | cat manifests/pod.yaml | nano file.yaml | sim help\n');
      this.history = [];
      this.kubectl = new KS.Kubectl(cluster, { fs: this.fs, cwd: () => this.env.cwd });
      this.helm = KS.Helm ? new KS.Helm(cluster, this.kubectl) : null;
      this.env = new R.ShellEnv({ fs: this.fs, uid: 1000, hostname: 'laptop', ip: '192.168.49.1', net: cluster.netFor(null), now: () => this.c.now, env: { HOME, USER: 'learner', SHELL: '/bin/bash', KUBECONFIG: HOME + '/.kube/config', EDITOR: 'nano', TERM: 'xterm-256color', PS1: '\\u@kubester:\\w$ ' } });
      this.env.cwd = HOME;
      this.env.tools = this.makeTools();
      (opts.files || KS.LESSON_FILES ? Object.entries(opts.files || KS.LESSON_FILES || {}) : []).forEach(([path, content]) => this.writeFile(path, content));
    }
    attach(cluster) {
      // swap the underlying cluster (lesson reset) but keep files and history
      this.c = cluster;
      this.kubectl = new KS.Kubectl(cluster, { fs: this.fs, cwd: () => this.env.cwd });
      this.helm = KS.Helm ? new KS.Helm(cluster, this.kubectl) : null;
      this.env.net = cluster.netFor(null);
      this.env.now = () => this.c.now;
    }
    writeFile(path, content) {
      const abs = R.normPath(path.replace(/^~/, HOME), HOME);
      const dir = abs.slice(0, abs.lastIndexOf('/'));
      this.fs.mkdir(dir, true);
      this.fs.write(abs, content, false);
    }
    prompt() {
      const cwd = this.env.cwd === HOME ? '~' : this.env.cwd.startsWith(HOME + '/') ? '~' + this.env.cwd.slice(HOME.length) : this.env.cwd;
      return { user: 'learner@kubester', cwd, sym: '$' };
    }

    // Run one command line. Generator: yields {sleep}|{task}|{interactive}|{editor}|{clear}|{fastForward}; returns exit code.
    *run(line, io, stdin, internal) {
      const trimmed = line.trim();
      if (!trimmed) return 0;
      if (!internal) {
        this.history.push(line);
        if (this.history.length > 500) this.history.shift();
        this.hooks.onCommand && this.hooks.onCommand(trimmed);
      }
      let ast;
      try { ast = R.parseShell(line); } catch (e) { io.err(`bash: ${e.message}\n`); return 2; }
      const env = this.env;
      const sub = { stdin: stdin || '', out: io.out, err: io.err };
      let code;
      try {
        const gen = (function* () { return yield* execTop(env, ast, sub); })();
        let v = gen.next();
        while (!v.done) { const res = yield v.value; v = gen.next(res); }
        code = v.value || 0;
      } catch (e) {
        if (e instanceof R.ExitSignal) { io.err('(Kubester: this is your laptop terminal — "exit" only leaves container shells.)\n'); code = 0; }
        else { io.err(`bash: ${e.message}\n`); code = 1; if (typeof console !== 'undefined') console.error(e); }
      }
      env.lastStatus = code;
      if (!internal) this.hooks.afterCommand && this.hooks.afterCommand(trimmed, code);
      return code;
    }

    makeTools() {
      const self = this;
      const runKubectl = function* (args, io) {
        const r = self.kubectl.run(args, io);
        let code = r.code || 0;
        if (r.task) { const res = yield { task: r.task, label: 'kubectl ' + args.join(' ') }; code = res && res.code != null ? res.code : code; }
        if (r.interactive) { const res = yield { interactive: r.interactive }; code = res && res.code != null ? res.code : 0; }
        if (r.editor) { const res = yield { editor: r.editor }; code = res && res.code != null ? res.code : 0; }
        self.hooks.onKubectl && self.hooks.onKubectl(args, code, r);
        return code;
      };
      const tools = {
        kubectl: runKubectl,
        k: runKubectl,
        helm: function* (args, io) {
          if (!self.helm) { io.err('helm: not installed\n'); return 127; }
          const r = self.helm.run(args, io);
          if (r.task) { const res = yield { task: r.task }; return res && res.code != null ? res.code : 0; }
          self.hooks.onKubectl && self.hooks.onKubectl(['helm'].concat(args), r.code || 0, r);
          return r.code || 0;
        },
        sim: function* (args, io) { return yield* self.sim(args, io); },
        clear: function* () { yield { clear: true }; return 0; },
        reset: function* () { yield { clear: true }; return 0; },
        history: function* (args, io) { self.history.slice(-50).forEach((h, i) => io.out(`${String(self.history.length - Math.min(50, self.history.length) + i + 1).padStart(5)}  ${h}\n`)); return 0; },
        help: function* (args, io) { io.out(HELP); return 0; },
        hint: function* (args, io) { const h = self.hooks.hint ? self.hooks.hint() : null; io.out((h || 'No hint for the current step. Open a lesson from the left panel.') + '\n'); return 0; },
        whoami: function* (args, io) { io.out('learner\n'); return 0; },
        hostname: function* (args, io) { io.out('laptop\n'); return 0; },
        alias: function* (args, io) { io.out("alias k='kubectl'\n"); return 0; },
        unalias: function* () { return 0; },
        source: function* (args, io) { io.out('(Kubester: completion is already enabled — press Tab.)\n'); return 0; },
        exit: function* (args, io) { io.err('(Kubester: this is your laptop terminal — "exit" only leaves container shells.)\n'); return 0; },
        logout: function* (args, io) { io.err('(Kubester: nothing to log out of.)\n'); return 0; },
        sudo: function* (args, io) { io.err('(Kubester: no sudo needed — kubectl talks to the cluster API over the network.)\n'); return 1; },
        ssh: function* (args, io) { io.err(`(Kubester: you can't SSH to cluster nodes here. To get a shell on a node use: kubectl debug node/${(args[0] || 'worker-1').replace(/^.*@/, '')} -it --image=busybox)\n`); return 1; },
        docker: function* (args, io) { io.err('(Kubester: Docker isn\'t installed on this laptop — the cluster uses containerd. Use kubectl instead!)\n'); return 127; },
        minikube: function* (args, io) { io.err('(Kubester: no minikube needed — a 4-node cluster is already running.)\n'); return 127; },
        kind: function* (args, io) { io.err('(Kubester: no kind needed — a 4-node cluster is already running.)\n'); return 127; },
        systemctl: function* (args, io) { io.err('(Kubester: services run on nodes, not on your laptop. Try: kubectl get nodes / kubectl describe node <name>)\n'); return 1; },
        journalctl: function* (args, io) { io.err('(Kubester: kubelet logs live on the node. Try: kubectl debug node/worker-1 -it --image=busybox, then cat /host/var/log/kubelet.log)\n'); return 1; },
        etcdctl: function* (args, io) { io.err('(Kubester: etcd is only reachable from the control plane. The API server is the only component that talks to etcd — see Handbook Q56.)\n'); return 1; },
        crictl: function* (args, io) { io.err('(Kubester: crictl runs on nodes. Use kubectl get/describe/logs instead.)\n'); return 1; },
        nano: function* (args, io) { return yield* self.editFile(args, io); },
        vi: function* (args, io) { return yield* self.editFile(args, io); },
        vim: function* (args, io) { return yield* self.editFile(args, io); },
        edit: function* (args, io) { return yield* self.editFile(args, io); },
        code: function* (args, io) { return yield* self.editFile(args, io); },
        jq: function* (args, io) {
          const raw = args.includes('-r');
          const f = args.filter(a => !a.startsWith('-'))[0] || '.';
          const r = jq(f, io.stdin || '', raw);
          if (r.error) { io.err(r.error + '\n'); return 5; }
          io.out(r.out);
          return 0;
        },
        watch: function* (args, io) {
          let interval = 2000;
          const a = args.slice();
          while (a[0] && a[0].startsWith('-')) { const f = a.shift(); if (f === '-n') interval = (parseFloat(a.shift()) || 2) * 1000; }
          const cmd = a.join(' ');
          if (!cmd) { io.err('Usage: watch [-n seconds] command\n'); return 1; }
          let next = 0;
          const res = yield {
            task: {
              tick(dt) {
                next -= dt || 100;
                if (next > 0) return false;
                next = interval;
                let buf = '';
                const tio = { out: s => (buf += s), err: s => (buf += s) };
                const g = self.run(cmd, tio, '', true);
                let v = g.next();
                let guard = 0;
                while (!v.done && guard++ < 100) v = g.next({ code: 0 });
                io.out(`\x1b[watch]Every ${(interval / 1000).toFixed(1)}s: ${cmd}    ${KS.runtime.dateStr(self.c.now)}\n\n${buf}`);
                return false;
              },
              cancel() {},
            },
          };
          return res && res.code != null ? res.code : 0;
        },
        jobs: function* (args, io) { self.c.rt.forwards.forEach((f, i) => io.out(`[${i + 1}]  Running    kubectl port-forward ${f.kind}/${f.name} ${f.local}:${f.port} &\n`)); return 0; },
        kill: function* (args, io) {
          const m = (args[0] || '').match(/^%(\d+)$/);
          if (!m) { io.err('(Kubester) usage: kill %N   (see "jobs")\n'); return 1; }
          const i = +m[1] - 1;
          const f = self.c.rt.forwards[i];
          if (!f) { io.err(`bash: kill: %${m[1]}: no such job\n`); return 1; }
          self.c.rt.forwards.splice(i, 1);
          io.out(`[${i + 1}]+  Terminated    kubectl port-forward ${f.kind}/${f.name} ${f.local}:${f.port}\n`);
          return 0;
        },
        git: function* (args, io) { io.err('(Kubester: git isn\'t set up here — see Handbook Q51 to learn how GitOps tools like ArgoCD apply manifests from Git.)\n'); return 1; },
        open: function* (args, io) { io.err('(Kubester: use curl to fetch pages in this terminal.)\n'); return 1; },
      };
      return tools;
    }

    *editFile(args, io) {
      const f = args.filter(a => !a.startsWith('-') && !a.startsWith('+'))[0];
      if (!f) { io.err('(Kubester) usage: nano <file>\n'); return 1; }
      const self = this;
      const path = R.normPath(f.replace(/^~/, HOME), this.env.cwd);
      if (this.fs.isDir(path) && this.fs.read(path) == null) { io.err(`"${f}" is a directory\n`); return 1; }
      const content = this.fs.read(path);
      const res = yield {
        editor: {
          filename: f, content: content == null ? '' : content, isNew: content == null,
          save(text) {
            const dir = path.slice(0, path.lastIndexOf('/')) || '/';
            if (!self.fs.isDir(dir)) return { error: `[ Error writing ${f}: No such file or directory ]` };
            self.fs.write(path, text, false);
            return { message: `[ Wrote ${text.split('\n').length - (text.endsWith('\n') ? 1 : 0)} lines ]`, close: true };
          },
        },
      };
      return res && res.code != null ? res.code : 0;
    }

    *sim(args, io) {
      const sub = args[0];
      const c = this.c;
      switch (sub) {
        case undefined: case 'help':
          io.out(SIM_HELP);
          return 0;
        case 'ff': case 'fast-forward': case 'wait': {
          const ms = U.parseDuration(args[1] || '');
          if (ms == null || ms <= 0) { io.err('usage: sim fast-forward <duration>   e.g. sim fast-forward 5m\n'); return 1; }
          if (ms > 86400000 * 2) { io.err('sim: you can skip at most 48h at once\n'); return 1; }
          yield { fastForward: ms };
          io.out(`⏩ Skipped ahead ${U.humanDuration(ms)} of cluster time. (Controllers, probes, CronJobs and back-offs all ran in fast motion.)\n`);
          return 0;
        }
        case 'load': {
          const target = args[1];
          const amount = args[2];
          if (!target || !amount) { io.err('usage: sim load <deployment> <total CPU demand, e.g. 600m | off>\n'); return 1; }
          const name = target.replace(/^(deploy|deployment|deployments)\//, '');
          const ns = this.kubectl.ns;
          const d = c.get('Deployment', ns, name) || c.get('StatefulSet', ns, name);
          if (!d) { io.err(`sim: deployment "${name}" not found in namespace ${ns}\n`); return 1; }
          if (amount === 'off' || amount === '0') { delete c.rt.loads[`${ns}/${name}`]; io.out(`📉 Traffic to ${name} stopped. CPU usage falls back to idle.\n`); return 0; }
          const m = U.parseCpu(amount);
          if (isNaN(m)) { io.err('sim: amount must be CPU like 600m or 1.5\n'); return 1; }
          c.rt.loads[`${ns}/${name}`] = m;
          c.narrate('🔥', `Simulated traffic: ${name} now needs ${U.fmtCpu(m)} of CPU in total, shared across its ready Pods.`, 'warn');
          io.out(`🔥 Simulating load on ${name}: ${U.fmtCpu(m)} total CPU demand, spread over its ready Pods. Watch it with: kubectl top pods\n`);
          return 0;
        }
        case 'node': {
          const action = args[1], nodeName = args[2];
          const nrt = c.rt.nodes[nodeName];
          if (!nrt || !['down', 'up', 'disk-pressure'].includes(action)) { io.err('usage: sim node down|up <node>   |   sim node disk-pressure <node> on|off\n'); return 1; }
          if (action === 'down') { nrt.up = false; c.narrate('🔌', `${nodeName}'s kubelet stopped (simulated crash). The control plane will notice after ~40s of missing heartbeats.`, 'bad'); io.out(`🔌 ${nodeName}: kubelet stopped. Watch: kubectl get nodes -w   (tip: sim fast-forward 1m)\n`); c.dirty = true; }
          else if (action === 'up') { nrt.up = true; nrt.lastHeartbeat = c.now; c.narrate('🔋', `${nodeName}'s kubelet is back.`, 'good'); io.out(`🔋 ${nodeName}: kubelet started again.\n`); c.dirty = true; }
          else { nrt.diskPressure = args[3] !== 'off'; io.out(`💽 ${nodeName}: DiskPressure ${nrt.diskPressure ? 'ON' : 'OFF'}\n`); c.dirty = true; }
          return 0;
        }
        case 'speed': {
          const x = parseFloat(args[1]);
          if (!(x >= 0.25 && x <= 20)) { io.err('usage: sim speed <0.25-20>\n'); return 1; }
          this.hooks.setSpeed && this.hooks.setSpeed(x);
          io.out(`⏱️  Cluster clock runs at ${x}× real time.\n`);
          return 0;
        }
        case 'reset': {
          if (this.hooks.resetCluster) { this.hooks.resetCluster(); io.out('♻️  Cluster reset to a fresh state.\n'); return 0; }
          io.err('sim: reset is not available here\n');
          return 1;
        }
        case 'status': case 'time':
          io.out(`Cluster clock: ${KS.runtime.dateStr(c.now)}\n`);
          return 0;
        default:
          io.err(`sim: unknown command "${sub}". Try: sim help\n`);
          return 1;
      }
    }

    // ------------------------------------------------------------------ tab completion
    complete(line) {
      const words = line.split(/\s+/);
      const cur = words[words.length - 1];
      const prev = words.slice(0, -1);
      const isK = prev[0] === 'kubectl' || prev[0] === 'k';
      const pick = list => [...new Set(list)].filter(x => x.startsWith(cur)).sort();
      if (prev.length === 0) return pick(Object.keys(this.env.tools).concat(['ls', 'cat', 'cd', 'echo', 'curl', 'mkdir', 'rm', 'grep', 'base64', 'touch', 'pwd', 'cp', 'mv']));
      if (!isK) {
        if (prev[0] === 'sim') return prev.length === 1 ? pick(['help', 'fast-forward', 'load', 'node', 'speed', 'reset', 'status']) : prev[1] === 'node' && prev.length === 2 ? pick(['down', 'up', 'disk-pressure']) : prev[1] === 'node' ? pick(this.c.list('Node').map(n => n.metadata.name)) : prev[1] === 'load' ? pick(this.c.list('Deployment', this.kubectl.ns).map(d => d.metadata.name)) : [];
        if (prev[0] === 'helm' && prev.length === 1) return pick(['install', 'upgrade', 'rollback', 'uninstall', 'list', 'history', 'status', 'repo', 'search', 'template', 'show', 'get', 'create']);
        return this.completeFile(cur);
      }
      const args = prev.slice(1).filter(w => !w.startsWith('-'));
      if (cur.startsWith('-')) {
        const cmd = args[0];
        const flags = ['--namespace', '--all-namespaces', '--output', '--selector', '--help'].concat((KS.CMD_FLAGS[cmd] || []).map(f => '--' + f));
        return pick(flags.map(f => (KS.kubectlParseArgs && ['--namespace', '--output', '--selector', '--replicas', '--image', '--port', '--type', '--target-port', '--to-revision', '--from-literal', '--grace-period', '--for', '--timeout', '--tail', '--container', '--min', '--max', '--cpu-percent'].includes(f) ? f + '=' : f)));
      }
      const pv = prev[prev.length - 1];
      if (pv === '-n' || pv === '--namespace') return pick(this.c.list('Namespace').map(n => n.metadata.name));
      if (pv === '-f' || pv === '--filename' || pv === '-k') return this.completeFile(cur);
      if (pv === '-o' || pv === '--output') return pick(['yaml', 'json', 'wide', 'name', 'jsonpath=', 'custom-columns=']);
      if (args.length === 0) return pick(Object.keys(KS.CMD_FLAGS).filter(x => !['options', 'plugin', 'alpha', 'help', 'completion'].includes(x)));
      const cmd = args[0];
      const subs = { rollout: ['status', 'history', 'undo', 'restart', 'pause', 'resume'], create: ['deployment', 'namespace', 'configmap', 'secret', 'service', 'job', 'cronjob', 'serviceaccount', 'role', 'rolebinding', 'clusterrole', 'clusterrolebinding', 'ingress', 'quota', 'priorityclass', 'poddisruptionbudget', 'token'], set: ['image', 'env', 'resources'], config: ['view', 'current-context', 'get-contexts', 'set-context', 'use-context'], auth: ['can-i', 'whoami'], top: ['pods', 'nodes'] };
      if (args.length === 1 && subs[cmd]) return pick(subs[cmd]);
      if (cmd === 'create' && args[1] === 'secret' && args.length === 2) return pick(['generic', 'docker-registry', 'tls']);
      if (cmd === 'create' && args[1] === 'service' && args.length === 2) return pick(['clusterip', 'nodeport', 'loadbalancer', 'externalname']);
      if (['apply', 'diff', 'kustomize'].includes(cmd)) return this.completeFile(cur);
      const typeIdx = subs[cmd] && cmd !== 'top' ? 2 : 1;
      if (['cordon', 'uncordon', 'drain'].includes(cmd)) return pick(this.c.list('Node').map(n => n.metadata.name));
      if (cmd === 'taint' && args.length === 1) return pick(['nodes']);
      if (cmd === 'taint' && args.length === 2) return pick(this.c.list('Node').map(n => n.metadata.name));
      if (['logs', 'exec', 'port-forward', 'debug', 'attach'].includes(cmd) && args.length === 1) return pick(this.c.list('Pod', this.ns()).map(p => p.metadata.name).concat(['deploy/', 'svc/']));
      const resWords = ['pods', 'deployments', 'services', 'replicasets', 'nodes', 'namespaces', 'configmaps', 'secrets', 'events', 'ingress', 'pvc', 'pv', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'hpa', 'networkpolicies', 'serviceaccounts', 'roles', 'rolebindings', 'storageclasses', 'endpoints', 'all', 'pdb', 'resourcequota', 'limitrange', 'priorityclasses', 'clusterroles', 'clusterrolebindings', 'po', 'deploy', 'svc', 'rs', 'no', 'ns', 'cm', 'sts', 'ds', 'cj', 'ep', 'sa', 'sc', 'ing', 'netpol'];
      if (args.length === typeIdx) {
        if (cur.includes('/')) { const [t, part] = cur.split('/'); const r = KS.lookupResource(t); if (!r) return []; return this.c.list(r.kind, r.namespaced ? this.ns() : undefined).map(o => `${t}/${o.metadata.name}`).filter(x => x.startsWith(t + '/' + part)); }
        return pick(resWords);
      }
      const r = KS.lookupResource((args[typeIdx] || '').split(',')[0]);
      if (r) return pick(this.c.list(r.kind, r.namespaced ? this.ns() : undefined).map(o => o.metadata.name));
      return [];
    }
    ns() {
      const h = this.history[this.history.length - 1] || '';
      void h;
      return this.kubectl.ns;
    }
    completeFile(cur) {
      const raw = cur.replace(/^~/, HOME);
      const dir = raw.includes('/') ? raw.slice(0, raw.lastIndexOf('/') + 1) : '';
      const base = raw.slice(dir.length);
      const abs = R.normPath(dir || '.', this.env.cwd);
      if (!this.fs.isDir(abs)) return [];
      return this.fs.list(abs).filter(n => n.startsWith(base)).map(n => {
        const full = (cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/') + 1) : '') + n;
        return this.fs.isDir(R.normPath(n, abs)) && this.fs.read(R.normPath(n, abs)) == null ? full + '/' : full;
      }).sort();
    }
  }

  // run the top-level AST, passing interpreter yields through
  function* execTop(env, ast, io) {
    return yield* KS.runtime.__execNode(env, ast, io);
  }

  const SIM_HELP = `sim — playground controls (not part of Kubernetes)

  sim fast-forward <dur>         skip cluster time, e.g. sim fast-forward 5m
  sim load <deployment> <cpu>    simulate traffic, e.g. sim load web 900m  (or "off")
  sim node down <node>           crash a node's kubelet (watch it go NotReady)
  sim node up <node>             bring it back
  sim node disk-pressure <node> on|off
  sim speed <x>                  run the cluster clock faster (0.25–20×)
  sim reset                      throw everything away and start a fresh cluster
  sim status                     show the cluster clock
`;
  const HELP = `Kubester terminal — this is your laptop, talking to a simulated Kubernetes cluster.

  kubectl …  (alias k)     the real kubectl commands (get, describe, apply, logs, exec, rollout, …)
  helm …                   install/upgrade/rollback charts
  sim help                 playground controls (fast-forward time, crash nodes, add load)
  hint                     a hint for the current lesson step
  nano <file>              edit a file (Ctrl+S save, Esc close) — also: kubectl edit
  ls, cat, cd, echo, curl, grep, base64, jq, watch, history, clear

  Keys: ↑/↓ history · Tab completion · Ctrl+C stop a running command · Ctrl+L clear
  Pipes and redirects work:  kubectl get pods -o name | wc -l      kubectl run x --image=nginx --dry-run=client -o yaml > pod.yaml
`;

  KS.HostShell = HostShell;
  KS.jq = jq;
  KS.HOME = HOME;
})(typeof window !== 'undefined' ? window : globalThis);
