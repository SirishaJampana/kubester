/* Kubester — kubelet (container lifecycle, probes, volumes) and cluster networking (DNS, Services, NetworkPolicy, Ingress). */
(function (G) {
  'use strict';
  const KS = G.KS;
  const U = KS.util;
  const R = KS.runtime;
  const C = KS.Cluster.prototype;
  const { isActive, isReady, cond, setCond } = KS.podHelpers;
  const userNs = ns => !['kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx'].includes(ns);
  const SHELLS = ['sh', 'bash', 'ash'];

  function hex(rng, n) { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rng() * 16).toString(16); return s; }
  function nginxTime(ms) {
    const d = new Date(ms);
    const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${mons[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
  }
  function logTime(ms) {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }
  const errPage = (code, text, server) => `<html>\r\n<head><title>${code} ${text}</title></head>\r\n<body>\r\n<center><h1>${code} ${text}</h1></center>\r\n<hr><center>${server}</center>\r\n</body>\r\n</html>\r\n`;

  // =================================================================== container processes
  class ServerProc {
    constructor(k, pod, spec, cs, sh, def, res) {
      this.k = k; this.pod = pod; this.spec = spec; this.cs = cs; this.sh = sh; this.def = def; this.res = res;
      this.kind = 'server';
      this.startedAt = k.now;
      this.readyAt = k.now + (def.start || 300);
      this.exited = null;
      this.fail = null;
      this.logged = false;
      this.extraMem = 0; this.extraCpu = 0;
      const env = sh.vars;
      if (def.requireEnv) {
        for (const group of def.requireEnv) {
          if (!group.some(v => env[v] != null && env[v] !== '')) {
            this.fail = { at: k.now + 600, code: 1, logs: def.flavor === 'postgres'
              ? ['Error: Database is uninitialized and superuser password is not specified.', '       You must specify POSTGRES_PASSWORD to a non-empty value for the', '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".', '', '       You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all', '       connections without a password. This is *not* recommended.', '', '       See PostgreSQL documentation about "trust":', '       https://www.postgresql.org/docs/current/auth-trust.html']
              : [`${U.iso(k.now).replace('T', ' ').replace('Z', '+00:00')} [Note] [Entrypoint]: Entrypoint script for MySQL Server 8.4.3-1.el9 started.`, `${U.iso(k.now).replace('T', ' ').replace('Z', '+00:00')} [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified`, '    You need to specify one of the following as an environment variable:', '    - MYSQL_ROOT_PASSWORD', '    - MYSQL_ALLOW_EMPTY_PASSWORD', '    - MYSQL_RANDOM_ROOT_PASSWORD'] };
          }
        }
      }
      if (def.flavor === 'hello' && res.tag === 'v3') {
        this.fail = { at: k.now + 700, code: 2, logs: [`${logTime(k.now)} kubester/hello v3 starting`, 'panic: open /etc/hello/config.yaml: no such file or directory', '', 'goroutine 1 [running]:', 'main.mustLoadConfig(...)', '\t/src/config.go:31 +0x1a4', 'main.main()', '\t/src/main.go:18 +0x2c'] };
      }
      if (def.flavor === 'api') {
        const url = env.DATABASE_URL;
        if (!url) this.fail = { at: k.now + 500, code: 1, logs: [`${logTime(k.now)} starting api 1.0`, `${logTime(k.now)} FATAL: required environment variable DATABASE_URL is not set`] };
        else {
          let host = '', port = 5432;
          const m = String(url).match(/^[a-z]+:\/\/(?:[^@/]*@)?([^:/?]+)(?::(\d+))?/i);
          if (m) { host = m[1]; port = m[2] ? +m[2] : 5432; }
          const r = k.netFor(pod).request({ url: `tcp://${host}:${port}`, tcp: true, quiet: true });
          if (!r.ok) {
            const why = r.error === 'resolve' ? `dial tcp: lookup ${host} on 10.96.0.10:53: no such host` : r.error === 'timeout' ? `dial tcp ${r.ip}:${port}: i/o timeout` : `dial tcp ${r.ip}:${port}: connect: connection refused`;
            this.fail = { at: k.now + 1500, code: 1, logs: [`${logTime(k.now)} starting api 1.0`, `${logTime(k.now)} connecting to database at ${host}:${port}`, `${logTime(k.now + 1400)} FATAL: cannot connect to database: ${why}`] };
          }
        }
      }
    }
    log(line) { this.k.podLog(this.cs, line); }
    step(now) {
      if (this.exited) return;
      if (this.fail && now >= this.fail.at) {
        this.fail.logs.forEach(l => this.log(l));
        this.exited = { code: this.fail.code };
        return;
      }
      if (!this.fail && !this.logged && now >= this.readyAt) {
        this.logged = true;
        this.startupLogs(now).forEach(l => this.log(l));
      }
    }
    startupLogs(now) {
      const t = logTime(now);
      const tag = this.res.tag;
      switch (this.def.flavor) {
        case 'nginx': return ['/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration', '/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/', '/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh', '10-listen-on-ipv6-by-default.sh: info: Getting the checksum of /etc/nginx/conf.d/default.conf', '10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf', '/docker-entrypoint.sh: Launching /docker-entrypoint.d/20-envsubst-on-templates.sh', '/docker-entrypoint.sh: Launching /docker-entrypoint.d/30-tune-worker-processes.sh', '/docker-entrypoint.sh: Configuration complete; ready for start up', `${t} [notice] 1#1: using the "epoll" event method`, `${t} [notice] 1#1: nginx/1.27.3`, `${t} [notice] 1#1: built by gcc 12.2.0 (Debian 12.2.0-14)`, `${t} [notice] 1#1: OS: Linux 6.8.0-49-generic`, `${t} [notice] 1#1: start worker processes`, `${t} [notice] 1#1: start worker process 29`];
        case 'httpd': return ['AH00558: httpd: Could not reliably determine the server\'s fully qualified domain name, using ' + this.sh.ip + '. Set the \'ServerName\' directive globally to suppress this message', `[${new Date(now).toUTCString()}] [mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations`];
        case 'redis': return [`1:C ${new Date(now).toUTCString().slice(5, 25)}.000 * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo`, `1:M ${new Date(now).toUTCString().slice(5, 25)}.002 * Running mode=standalone, port=6379.`, `1:M ${new Date(now).toUTCString().slice(5, 25)}.003 * Server initialized`, `1:M ${new Date(now).toUTCString().slice(5, 25)}.003 * Ready to accept connections tcp`];
        case 'postgres': return ['The files belonging to this database system will be owned by user "postgres".', 'PostgreSQL init process complete; ready for start up.', '', `${U.iso(now).replace('T', ' ').replace('Z', '')}.000 UTC [1] LOG:  starting PostgreSQL 17.2 on x86_64-pc-linux-gnu`, `${U.iso(now).replace('T', ' ').replace('Z', '')}.012 UTC [1] LOG:  listening on IPv4 address "0.0.0.0", port 5432`, `${U.iso(now).replace('T', ' ').replace('Z', '')}.031 UTC [1] LOG:  database system is ready to accept connections`];
        case 'mysql': return [`${U.iso(now)} 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.3'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306  MySQL Community Server - GPL.`];
        case 'hello': return [`${t} kubester/hello ${tag} starting`, `${t} listening on :8080 (pod ${this.sh.hostname})`];
        case 'api': return [`${t} starting api 1.0`, `${t} connected to database`, `${t} listening on :8080`];
        case 'fluentbit': return [`Fluent Bit v3.1.9`, `[${t}] [ info] [fluent bit] version=3.1.9, commit=431fa79ae2, pid=1`, `[${t}] [ info] [input:tail:tail.0] initializing`, `[${t}] [ info] [output:stdout:stdout.0] worker #0 started`, `[${t}] [ info] [sp] stream processor started`];
        case 'nodeexporter': return [`ts=${U.iso(now)} caller=node_exporter.go:193 level=info msg="Starting node_exporter" version="(version=1.8.2)"`, `ts=${U.iso(now)} caller=tls_config.go:313 level=info msg="Listening on" address=[::]:9100`];
        default: return [];
      }
    }
    listens(port) { return !this.exited && !(this.fail && !this.def.ports.includes(port)) && this.def.ports.includes(+port) && this.k.now >= this.readyAt && !this.fail; }
    http(req) {
      const path = (req.path || '/').split('?')[0];
      const now = this.k.now;
      const access = code => {
        if (this.def.flavor === 'nginx') this.log(`${req.srcIp || '10.244.0.1'} - - [${nginxTime(now)}] "${req.method || 'GET'} ${req.path || '/'} HTTP/1.1" ${code} ${code === 200 ? 615 : 153} "-" "${req.agent || 'curl/8.11.0'}" "-"`);
        else if (this.def.flavor === 'hello' || this.def.flavor === 'api') this.log(`${logTime(now)} ${req.method || 'GET'} ${req.path || '/'} ${code} (from ${req.srcIp || 'unknown'})`);
      };
      switch (this.def.flavor) {
        case 'nginx': case 'httpd': {
          const root = this.def.flavor === 'nginx' ? '/usr/share/nginx/html' : '/usr/local/apache2/htdocs';
          const server = this.def.flavor === 'nginx' ? 'nginx/1.27.3' : 'Apache/2.4.62 (Unix)';
          let fp = R.normPath(root + path);
          if (path.endsWith('/') || this.sh.fs.isDir(fp) && this.sh.fs.read(fp) === null) fp = R.normPath(fp + '/index.html');
          const body = this.sh.fs.read(fp);
          if (body != null) { access(200); return { code: 200, body, server }; }
          if (fp.endsWith('/index.html') && this.sh.fs.isDir(fp.slice(0, -11) || '/')) { access(403); return { code: 403, body: errPage(403, 'Forbidden', server), server }; }
          access(404);
          return { code: 404, body: errPage(404, 'Not Found', server), server };
        }
        case 'hello': {
          const v = this.res.tag;
          if (path === '/' || path === '') {
            access(200);
            const msg = this.sh.vars.MESSAGE ? `\nmessage: ${this.sh.vars.MESSAGE}` : '';
            const color = this.sh.vars.COLOR ? `\ncolor: ${this.sh.vars.COLOR}` : '';
            return { code: 200, body: `Hello from ${this.sh.hostname} (kubester/hello ${v})${msg}${color}\n`, server: 'kubester-hello' };
          }
          if (path === '/healthz') { access(200); return { code: 200, body: 'ok\n', server: 'kubester-hello' }; }
          if (path === '/ready' || path === '/readyz') { access(200); return { code: 200, body: 'ready\n', server: 'kubester-hello' }; }
          if (path === '/version') { access(200); return { code: 200, body: v + '\n', server: 'kubester-hello' }; }
          access(404);
          return { code: 404, body: '404 page not found\n', server: 'kubester-hello' };
        }
        case 'api': {
          if (path === '/healthz') { access(200); return { code: 200, body: 'ok\n', server: 'kubester-api' }; }
          access(200);
          return { code: 200, body: '{"service":"api","version":"1.0","database":"connected"}\n', server: 'kubester-api' };
        }
        case 'fluentbit': return { code: 200, body: '{"fluent-bit":{"version":"3.1.9","edition":"Community"}}\n', server: 'fluent-bit' };
        case 'nodeexporter': return path === '/metrics' ? { code: 200, body: '# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.\n# TYPE node_cpu_seconds_total counter\nnode_cpu_seconds_total{cpu="0",mode="idle"} 18324.5\nnode_memory_MemAvailable_bytes 2.54e+09\n', server: 'node-exporter' } : { code: 200, body: '<html><head><title>Node Exporter</title></head><body><h1>Node Exporter</h1><p><a href="/metrics">Metrics</a></p></body></html>\n', server: 'node-exporter' };
        default: return null; // TCP-only service (redis, postgres...) → empty reply to HTTP
      }
    }
    mem() { return (this.def.mem || 1) + this.extraMem; }
    cpu() { return (this.def.cpu || 0) + this.extraCpu; }
    termDelay() { return this.def.flavor === 'postgres' || this.def.flavor === 'mysql' ? 1500 : 300; }
  }

  class ScriptProcess {
    constructor(k, pod, spec, cs, sh, def, script, pid1) {
      this.k = k; this.cs = cs; this.sh = sh; this.def = def;
      this.kind = 'script';
      this.exited = null;
      this.extraMem = 0; this.extraCpu = 0;
      sh.proc = this;
      sh.vars.__PID1 = pid1;
      this.proc = new R.ScriptProc(sh, script, s => this.out(s));
      this.buf = '';
      this.step(k.now);
    }
    out(s) {
      this.buf += s;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { this.k.podLog(this.cs, this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1); }
    }
    step(now) {
      if (this.exited) return;
      this.proc.step(now);
      if (this.proc.done) {
        if (this.buf) { this.k.podLog(this.cs, this.buf); this.buf = ''; }
        this.exited = { code: this.proc.code };
      }
    }
    listens() { return false; }
    http() { return null; }
    mem() { return (this.def.mem || 0.5) + this.extraMem; }
    cpu() { return (this.def.cpu || 0) + this.extraCpu; }
    termDelay() { return Infinity; } // a shell as PID 1 ignores SIGTERM → waits for the grace period
  }

  // =================================================================== kubelet
  C.podLog = function (cs, line) {
    cs.logs.push({ t: this.now, line });
    if (cs.logs.length > 1000) cs.logs.splice(0, cs.logs.length - 1000);
  };
  C.podGone = function (pod) {
    delete this.rt.pods[pod.metadata.uid];
    delete this.rt.schedRetry[pod.metadata.uid];
    this.emit('pod-gone', { uid: pod.metadata.uid, name: pod.metadata.name, ns: pod.metadata.namespace });
  };
  C.kubelets = function () {
    for (const pod of [...this.objs.Pod.values()]) {
      if (!pod.spec.nodeName) continue;
      const nrt = this.rt.nodes[pod.spec.nodeName];
      if (!nrt || !nrt.up) continue;
      if (!this.get('Pod', pod.metadata.namespace, pod.metadata.name)) continue;
      this.syncPod(pod);
    }
  };

  C.newContainerState = function (spec, isInit) {
    return { name: spec.name, isInit, phase: 'new', restartCount: 0, logs: [], prevLogs: [], probes: {}, backoff: 0, pullFailures: 0, ready: false, started: false };
  };
  C.podRuntime = function (pod) {
    let rt = this.rt.pods[pod.metadata.uid];
    if (!rt) {
      rt = this.rt.pods[pod.metadata.uid] = { uid: pod.metadata.uid, node: pod.spec.nodeName, volumesReady: false, ip: null, sandboxAt: null, containers: {}, init: {}, ephemeral: {}, volumes: {}, mountEvAt: 0 };
      (pod.spec.initContainers || []).forEach(c => (rt.init[c.name] = this.newContainerState(c, true)));
      pod.spec.containers.forEach(c => (rt.containers[c.name] = this.newContainerState(c, false)));
    }
    return rt;
  };

  // ------------------------------------------------------------------ volumes
  C.setupVolumes = function (pod, rt) {
    const ns = pod.metadata.namespace;
    const problems = [];
    for (const v of pod.spec.volumes || []) {
      if (rt.volumes[v.name]) continue;
      if (v.configMap) {
        const cm = this.get('ConfigMap', ns, v.configMap.name);
        if (!cm && !v.configMap.optional) { problems.push(`MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found`); continue; }
        rt.volumes[v.name] = this.liveKeyStore(() => { const o = this.get('ConfigMap', ns, v.configMap.name); return o ? Object.assign({}, o.data || {}) : {}; }, v.configMap.items);
      } else if (v.secret) {
        const s = this.get('Secret', ns, v.secret.secretName);
        if (!s && !v.secret.optional) { problems.push(`MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found`); continue; }
        rt.volumes[v.name] = this.liveKeyStore(() => { const o = this.get('Secret', ns, v.secret.secretName); const d = {}; Object.entries((o && o.data) || {}).forEach(([k, val]) => { try { d[k] = U.b64decode(val); } catch (e) { d[k] = ''; } }); return d; }, v.secret.items);
      } else if (v.persistentVolumeClaim) {
        const pvc = this.get('PersistentVolumeClaim', ns, v.persistentVolumeClaim.claimName);
        if (!pvc || pvc.status.phase !== 'Bound') { problems.push(`MountVolume.SetUp failed for volume "${v.name}" : persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" is not bound`); continue; }
        const pvName = pvc.spec.volumeName;
        if (!this.rt.pvData[pvName]) this.rt.pvData[pvName] = R.makeStore(false);
        rt.volumes[v.name] = v.persistentVolumeClaim.readOnly ? Object.assign({}, this.rt.pvData[pvName], { readOnly: true }) : this.rt.pvData[pvName];
      } else if (v.emptyDir) {
        rt.volumes[v.name] = R.makeStore(false);
      } else if (v.hostPath) {
        const nrt = this.rt.nodes[pod.spec.nodeName];
        nrt.hostPaths = nrt.hostPaths || {};
        rt.volumes[v.name] = nrt.hostPaths[v.hostPath.path] = nrt.hostPaths[v.hostPath.path] || R.makeStore(false);
        if (v.hostPath.path === '/var/log') ['pods', 'containers'].forEach(d => rt.volumes[v.name].dirs.add(d));
      } else if (v.projected) {
        const files = {};
        for (const src of v.projected.sources || []) {
          if (src.serviceAccountToken) files[src.serviceAccountToken.path || 'token'] = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Imt1YmVzdGVyIn0.' + U.b64encode(JSON.stringify({ aud: ['https://kubernetes.default.svc.cluster.local'], iss: 'https://kubernetes.default.svc.cluster.local', sub: `system:serviceaccount:${ns}:${pod.spec.serviceAccountName}`, 'kubernetes.io': { namespace: ns, pod: { name: pod.metadata.name }, serviceaccount: { name: pod.spec.serviceAccountName } } })).replace(/=+$/, '') + '.c2lnbmF0dXJl';
          if (src.configMap) {
            const cm = this.get('ConfigMap', ns, src.configMap.name);
            if (cm) (src.configMap.items || Object.keys(cm.data || {}).map(k => ({ key: k, path: k }))).forEach(it => (files[it.path] = (cm.data || {})[it.key] || ''));
          }
          if (src.secret) {
            const s = this.get('Secret', ns, src.secret.name);
            if (s) Object.entries(s.data || {}).forEach(([k, val]) => (files[k] = U.b64decode(val)));
          }
          if (src.downwardAPI) (src.downwardAPI.items || []).forEach(it => (files[it.path] = this.fieldRef(pod, it.fieldRef && it.fieldRef.fieldPath)));
        }
        const store = R.makeStore(true);
        Object.entries(files).forEach(([k, val]) => store.files.set(k, val));
        rt.volumes[v.name] = store;
      } else if (v.downwardAPI) {
        rt.volumes[v.name] = this.liveKeyStore(() => { const f = {}; (v.downwardAPI.items || []).forEach(it => (f[it.path] = it.fieldRef ? this.fieldRef(pod, it.fieldRef.fieldPath) : '')); return f; });
      } else {
        rt.volumes[v.name] = R.makeStore(false);
      }
    }
    return problems;
  };
  // configMap/secret volumes refresh like the kubelet's periodic sync (~60s), not instantly
  C.liveKeyStore = function (getData, items) {
    const k = this;
    const store = { readOnly: true, dirs: new Set(['']), files: new Map(), syncedAt: -Infinity };
    const refresh = () => {
      const data = getData();
      const m = new Map();
      if (items && items.length) items.forEach(it => { if (it.key in data) m.set(it.path, data[it.key]); });
      else Object.entries(data).forEach(([key, val]) => m.set(key, val));
      store.files = m;
      store.syncedAt = k.now;
    };
    store.getFiles = () => { if (k.now - store.syncedAt >= 60000) refresh(); return store.files; };
    store.snapshot = () => { refresh(); return store; };
    refresh();
    return store;
  };
  C.fieldRef = function (pod, path) {
    switch (path) {
      case 'metadata.name': return pod.metadata.name;
      case 'metadata.namespace': return pod.metadata.namespace;
      case 'metadata.uid': return pod.metadata.uid;
      case 'spec.nodeName': return pod.spec.nodeName || '';
      case 'spec.serviceAccountName': return pod.spec.serviceAccountName || '';
      case 'status.podIP': return pod.status.podIP || '';
      case 'status.hostIP': return pod.status.hostIP || '';
      case 'metadata.labels': return Object.entries(pod.metadata.labels || {}).map(([a, b]) => `${a}="${b}"`).join('\n');
      case 'metadata.annotations': return Object.entries(pod.metadata.annotations || {}).map(([a, b]) => `${a}="${b}"`).join('\n');
      default: {
        const m = String(path || '').match(/^metadata\.(labels|annotations)\['(.+)'\]$/);
        if (m) return (pod.metadata[m[1]] || {})[m[2]] || '';
        return '';
      }
    }
  };
  C.buildFs = function (pod, rt, spec, res, uid) {
    const fs = new R.Fs();
    const root = fs.root;
    const hostname = pod.spec.hostname || pod.metadata.name;
    const sub = pod.spec.subdomain ? `${hostname}.${pod.spec.subdomain}.${pod.metadata.namespace}.svc.${KS.CLUSTER_DOMAIN}\t${hostname}` : hostname;
    root.files.set('etc/hostname', hostname + '\n');
    root.files.set('etc/hosts', `# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n${rt.ip || ''}\t${sub}\n`);
    root.files.set('etc/resolv.conf', `search ${pod.metadata.namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`);
    const flavor = res.def && res.def.flavor;
    const base = res.key;
    if (['nginx', 'httpd', 'redis', 'postgres', 'mysql'].includes(flavor) || base === 'ubuntu' || base === 'perl') root.files.set('etc/os-release', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n');
    if (base === 'alpine' || base === 'curlimages/curl' || (res.tag || '').includes('alpine')) root.files.set('etc/os-release', 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.21.0\nPRETTY_NAME="Alpine Linux v3.21"\n');
    if (flavor === 'nginx') {
      ['usr/share/nginx', 'usr/share/nginx/html', 'etc/nginx', 'etc/nginx/conf.d', 'var/log/nginx', 'docker-entrypoint.d'].forEach(d => root.dirs.add(d));
      root.files.set('usr/share/nginx/html/index.html', R.NGINX_INDEX);
      root.files.set('usr/share/nginx/html/50x.html', '<!DOCTYPE html>\n<html>\n<head>\n<title>Error</title>\n</head>\n<body>\n<h1>An error occurred.</h1>\n</body>\n</html>\n');
      root.files.set('etc/nginx/nginx.conf', '\nuser  nginx;\nworker_processes  auto;\n\nerror_log  /var/log/nginx/error.log notice;\npid        /var/run/nginx.pid;\n\nevents {\n    worker_connections  1024;\n}\n\nhttp {\n    include       /etc/nginx/mime.types;\n    default_type  application/octet-stream;\n    sendfile        on;\n    keepalive_timeout  65;\n    include /etc/nginx/conf.d/*.conf;\n}\n');
      root.files.set('etc/nginx/conf.d/default.conf', `server {\n    listen       ${res.def.ports[0]};\n    listen  [::]:${res.def.ports[0]};\n    server_name  localhost;\n\n    location / {\n        root   /usr/share/nginx/html;\n        index  index.html index.htm;\n    }\n\n    error_page   500 502 503 504  /50x.html;\n    location = /50x.html {\n        root   /usr/share/nginx/html;\n    }\n}\n`);
    }
    if (flavor === 'httpd') { ['usr/local/apache2', 'usr/local/apache2/htdocs'].forEach(d => root.dirs.add(d)); root.files.set('usr/local/apache2/htdocs/index.html', '<html><body><h1>It works!</h1></body></html>\n'); }
    if (flavor === 'hello' || flavor === 'api') { root.dirs.add('app'); root.files.set('app/' + flavor, '\x7fELF (binary)'); }
    if (flavor === 'redis') root.dirs.add('data');
    if (flavor === 'postgres') ['var/lib/postgresql', 'var/lib/postgresql/data'].forEach(d => root.dirs.add(d));
    for (const vm of spec.volumeMounts || []) {
      let store = rt.volumes[vm.name];
      if (!store) continue;
      if (vm.subPath) {
        if (store.getFiles) {
          // subPath of a configMap/secret: a frozen copy of one key (never updated — real behaviour)
          const content = store.getFiles().get(vm.subPath);
          const single = R.makeStore(true);
          if (content != null) single.files.set('', content);
          store = single;
        } else {
          const prefix = vm.subPath.replace(/^\/+|\/+$/g, '');
          store.dirs.add(prefix);
          store = prefixStore(store, prefix);
        }
      }
      fs.mount(vm.mountPath, store, { readOnly: !!vm.readOnly, name: vm.name });
    }
    void uid;
    return fs;
  };
  function prefixStore(base, prefix) {
    const full = k => (k === '' ? prefix : prefix + '/' + k);
    const files = {
      get: k => base.files.get(full(k)), has: k => base.files.has(full(k)), set: (k, v) => base.files.set(full(k), v), delete: k => base.files.delete(full(k)),
      keys: () => [...base.files.keys()].filter(k => k.startsWith(prefix + '/')).map(k => k.slice(prefix.length + 1))[Symbol.iterator](),
    };
    const dirs = {
      has: k => base.dirs.has(full(k)) || k === '', add: k => base.dirs.add(full(k)), delete: k => base.dirs.delete(full(k)),
      [Symbol.iterator]: () => [...base.dirs].filter(d => d.startsWith(prefix + '/')).map(d => d.slice(prefix.length + 1))[Symbol.iterator](),
    };
    return { files, dirs, readOnly: base.readOnly };
  }

  // ------------------------------------------------------------------ env
  C.resolveEnv = function (pod, spec, rt) {
    const ns = pod.metadata.namespace;
    const env = {};
    // service links (enableServiceLinks) — like real pods, every Service in the namespace shows up as env vars
    const linkSvcs = this.ls('Service', ns).filter(s => s.spec.clusterIP && s.spec.clusterIP !== 'None').concat(ns !== 'default' ? [this.get('Service', 'default', 'kubernetes')] : []);
    for (const s of linkSvcs) {
      if (!s) continue;
      if (s.metadata.name !== 'kubernetes' && pod.spec.enableServiceLinks === false) continue;
      const n = s.metadata.name.toUpperCase().replace(/-/g, '_');
      const p = (s.spec.ports || [])[0];
      if (!p) continue;
      env[`${n}_SERVICE_HOST`] = s.spec.clusterIP;
      env[`${n}_SERVICE_PORT`] = String(p.port);
      if (p.name) env[`${n}_SERVICE_PORT_${p.name.toUpperCase().replace(/-/g, '_')}`] = String(p.port);
      env[`${n}_PORT`] = `${(p.protocol || 'TCP').toLowerCase()}://${s.spec.clusterIP}:${p.port}`;
    }
    for (const ef of spec.envFrom || []) {
      if (ef.configMapRef) {
        const cm = this.get('ConfigMap', ns, ef.configMapRef.name);
        if (!cm) { if (ef.configMapRef.optional) continue; return { error: `configmap "${ef.configMapRef.name}" not found` }; }
        Object.entries(cm.data || {}).forEach(([k, v]) => (env[(ef.prefix || '') + k] = v));
      }
      if (ef.secretRef) {
        const s = this.get('Secret', ns, ef.secretRef.name);
        if (!s) { if (ef.secretRef.optional) continue; return { error: `secret "${ef.secretRef.name}" not found` }; }
        Object.entries(s.data || {}).forEach(([k, v]) => (env[(ef.prefix || '') + k] = U.b64decode(v)));
      }
    }
    for (const e of spec.env || []) {
      if (e.valueFrom) {
        const vf = e.valueFrom;
        if (vf.configMapKeyRef) {
          const cm = this.get('ConfigMap', ns, vf.configMapKeyRef.name);
          if (!cm) { if (vf.configMapKeyRef.optional) continue; return { error: `configmap "${vf.configMapKeyRef.name}" not found` }; }
          if (!(cm.data || {}).hasOwnProperty(vf.configMapKeyRef.key)) { if (vf.configMapKeyRef.optional) continue; return { error: `couldn't find key ${vf.configMapKeyRef.key} in ConfigMap ${ns}/${vf.configMapKeyRef.name}` }; }
          env[e.name] = cm.data[vf.configMapKeyRef.key];
        } else if (vf.secretKeyRef) {
          const s = this.get('Secret', ns, vf.secretKeyRef.name);
          if (!s) { if (vf.secretKeyRef.optional) continue; return { error: `secret "${vf.secretKeyRef.name}" not found` }; }
          if (!(s.data || {}).hasOwnProperty(vf.secretKeyRef.key)) { if (vf.secretKeyRef.optional) continue; return { error: `couldn't find key ${vf.secretKeyRef.key} in Secret ${ns}/${vf.secretKeyRef.name}` }; }
          env[e.name] = U.b64decode(s.data[vf.secretKeyRef.key]);
        } else if (vf.fieldRef) {
          env[e.name] = vf.fieldRef.fieldPath === 'status.podIP' ? (rt.ip || '') : this.fieldRef(pod, vf.fieldRef.fieldPath);
        } else if (vf.resourceFieldRef) {
          const rr = vf.resourceFieldRef.resource || '';
          const [kind, res] = rr.split('.');
          const val = spec.resources && spec.resources[kind] && spec.resources[kind][res];
          if (res === 'cpu') env[e.name] = String(val ? Math.ceil(U.parseCpu(val) / 1000) : 2);
          else env[e.name] = String(val ? Math.round(U.parseMem(val) * 1048576) : 4294967296);
        }
      } else {
        env[e.name] = String(e.value == null ? '' : e.value).replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (m, n) => (n in env ? env[n] : m));
      }
    }
    env.HOSTNAME = pod.spec.hostname || pod.metadata.name;
    return { env };
  };

  C.pullSecretOk = function (pod, registry) {
    for (const ref of pod.spec.imagePullSecrets || []) {
      const s = this.get('Secret', pod.metadata.namespace, ref.name);
      if (!s || s.type !== 'kubernetes.io/dockerconfigjson') continue;
      try { const cfg = JSON.parse(U.b64decode(s.data['.dockerconfigjson'])); if (Object.keys(cfg.auths || {}).some(k => k.includes(registry))) return true; } catch (e) { /* ignore */ }
    }
    return false;
  };

  // ------------------------------------------------------------------ container step
  C.startContainer = function (pod, rt, spec, cs) {
    const res = R.resolveImage(spec.image);
    const env = this.resolveEnv(pod, spec, rt);
    if (env.error) return { configError: env.error };
    const def = res.def;
    const sc = Object.assign({}, pod.spec.securityContext || {}, spec.securityContext || {});
    const uid = sc.runAsUser != null ? sc.runAsUser : def.user || 0;
    if (sc.runAsNonRoot && uid === 0) {
      return { configError: sc.runAsUser === 0 ? `container's runAsUser breaks non-root policy (pod: "${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})", container: ${spec.name})` : `container has runAsNonRoot and image will run as root (pod: "${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})", container: ${spec.name})` };
    }
    const fs = this.buildFs(pod, rt, spec, res);
    if (sc.readOnlyRootFilesystem) { fs.root.readOnly = true; }
    const sh = new R.ShellEnv({ fs, env: env.env, uid, hostname: pod.spec.hostname || pod.metadata.name, ip: rt.ip, net: this.netFor(pod), now: () => this.now, image: def });
    if (sc.runAsGroup != null) sh.vars.__GID = sc.runAsGroup;
    cs.fs = fs; cs.sh = sh;
    // what does the container run?
    let argv = null;
    if (spec.command && spec.command.length) argv = spec.command.concat(spec.args || []);
    else if (def.kind === 'shell') argv = spec.args && spec.args.length ? spec.args.slice() : def.defaultCmd.slice();
    if (!argv || def.flavor === 'system') return { proc: new ServerProc(this, pod, spec, cs, sh, def, res) };
    const exe = String(argv[0]).split('/').pop();
    const hasShell = def.kind === 'shell' || def.shell;
    if (!hasShell || (!R.SHELL_CMDS.has(exe) && !SHELLS.includes(exe))) {
      return { startError: `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${argv[0]}": executable file not found in $PATH: unknown` };
    }
    let script;
    if (SHELLS.includes(exe) && argv[1] === '-c') script = argv[2] || '';
    else script = argv.map(R.shQuote).join(' ');
    return { proc: new ScriptProcess(this, pod, spec, cs, sh, def, script, argv.join(' ')) };
  };

  C.stepContainer = function (pod, rt, spec, cs, restartPolicy) {
    const now = this.now;
    const node = pod.spec.nodeName;
    const name = spec.name;
    const ns = pod.metadata.namespace;
    const say = userNs(ns);
    const policyRestarts = code => restartPolicy === 'Always' || (restartPolicy === 'OnFailure' && code !== 0);
    switch (cs.phase) {
      case 'new': {
        cs.image = spec.image;
        const res = R.resolveImage(spec.image);
        if (res.ok && res.def.private && !this.pullSecretOk(pod, res.registry)) { res.ok = false; res.error = 'auth'; }
        cs.res = res;
        const cache = this.rt.imageCache[node];
        const policy = spec.imagePullPolicy || 'IfNotPresent';
        if (res.error === 'invalid') {
          cs.phase = 'pullbackoff'; cs.waitingReason = 'InvalidImageName'; cs.waitingMessage = `Failed to apply default image tag "${spec.image}": couldn't parse image name "${spec.image}": invalid reference format`;
          this.event(pod, 'Warning', 'InspectFailed', cs.waitingMessage, 'kubelet');
          this.event(pod, 'Warning', 'Failed', 'Error: InvalidImageName', 'kubelet');
          cs.until = Infinity;
          return;
        }
        if (policy === 'Never' && !cache.has(res.full)) {
          cs.phase = 'pullbackoff'; cs.waitingReason = 'ErrImageNeverPull'; cs.waitingMessage = `Container image "${spec.image}" is not present with pull policy of Never`;
          this.event(pod, 'Warning', 'ErrImageNeverPull', cs.waitingMessage, 'kubelet');
          cs.until = now + 10000;
          return;
        }
        if (policy === 'Always' || !cache.has(res.full)) {
          cs.phase = 'pulling';
          cs.waitingReason = 'ContainerCreating';
          cs.pullStart = now;
          cs.until = now + (res.ok ? 400 + (res.def.size || 20) * 9 : 900);
          this.event(pod, 'Normal', 'Pulling', `Pulling image "${spec.image}"`, 'kubelet');
          this.emit('kubelet', { node, pod: pod.metadata.uid, action: 'pull' });
          if (say && cs.pullFailures === 0) this.narrate('⬇️', `kubelet on ${node} is pulling image ${spec.image} for ${pod.metadata.name}.`, 'info');
        } else {
          this.event(pod, 'Normal', 'Pulled', `Container image "${spec.image}" already present on machine`, 'kubelet');
          cs.phase = 'creating';
        }
        return;
      }
      case 'pulling': {
        if (spec.image !== cs.image) { cs.phase = 'new'; return; }
        if (now < cs.until) return;
        const res = cs.res;
        if (res.ok) {
          this.rt.imageCache[node].add(res.full);
          const secs = ((now - cs.pullStart) / 1000).toFixed(3);
          this.event(pod, 'Normal', 'Pulled', `Successfully pulled image "${spec.image}" in ${secs}s (${secs}s including waiting). Image size: ${Math.round((res.def.size || 20) * 1048576 * 1.02)} bytes.`, 'kubelet');
          cs.pullFailures = 0;
          cs.phase = 'creating';
        } else {
          cs.pullFailures++;
          this.event(pod, 'Warning', 'Failed', R.pullError(res, spec.image), 'kubelet');
          this.event(pod, 'Warning', 'Failed', 'Error: ErrImagePull', 'kubelet');
          cs.waitingReason = 'ErrImagePull';
          cs.waitingMessage = R.pullError(res, spec.image).replace(/^Failed to pull image "[^"]*": /, '');
          cs.phase = 'pullbackoff';
          cs.failedAt = now;
          cs.until = now + Math.min(300000, 10000 * Math.pow(2, cs.pullFailures - 1));
          cs.backoffShown = false;
          this.emit('kubelet', { node, pod: pod.metadata.uid, action: 'fail' });
          if (say && cs.pullFailures === 1) this.narrate('🛑', `Image pull failed for ${pod.metadata.name}: ${res.error === 'notag' ? `tag "${res.tag}" does not exist` : res.error === 'auth' ? 'the private registry needs credentials (imagePullSecrets)' : `repository "${res.repo}" does not exist`}. kubelet will retry with back-off (ImagePullBackOff).`, 'bad');
        }
        return;
      }
      case 'pullbackoff': {
        if (spec.image !== cs.image) { cs.phase = 'new'; cs.pullFailures = 0; return; }
        if (!cs.backoffShown && cs.waitingReason === 'ErrImagePull' && now - cs.failedAt >= 2500) {
          cs.backoffShown = true;
          cs.waitingReason = 'ImagePullBackOff';
          cs.waitingMessage = `Back-off pulling image "${spec.image}"`;
          this.event(pod, 'Normal', 'BackOff', `Back-off pulling image "${spec.image}"`, 'kubelet');
          this.event(pod, 'Warning', 'Failed', 'Error: ImagePullBackOff', 'kubelet');
        }
        if (now >= cs.until) { cs.phase = 'new'; }
        return;
      }
      case 'creating': {
        if (cs.nextTry && now < cs.nextTry) return;
        const r = this.startContainer(pod, rt, spec, cs);
        if (r.configError) {
          cs.waitingReason = 'CreateContainerConfigError';
          cs.waitingMessage = r.configError;
          cs.nextTry = now + 5000;
          this.event(pod, 'Warning', 'Failed', `Error: ${r.configError}`, 'kubelet');
          if (say && !cs.configErrSaid) { cs.configErrSaid = true; this.narrate('🧾', `Can't start ${name} in ${pod.metadata.name}: ${r.configError}. kubelet keeps retrying until it's fixed.`, 'bad'); }
          return;
        }
        cs.configErrSaid = false;
        cs.nextTry = 0;
        cs.containerID = 'containerd://' + hex(this.rng, 64);
        cs.imageID = (cs.res && cs.res.full ? cs.res.full.replace(/:[^:/]+$/, '') : spec.image) + '@sha256:' + U.hashString(spec.image).repeat(7).slice(0, 64).replace(/[^a-f0-9]/g, c => (c.charCodeAt(0) % 16).toString(16));
        if (r.startError) {
          this.event(pod, 'Normal', 'Created', `Created container ${name}`, 'kubelet');
          this.event(pod, 'Warning', 'Failed', `Error: ${r.startError}`, 'kubelet');
          cs.startedAt = now; cs.everStarted = true;
          this.terminateContainer(pod, cs, 128, 'StartError', r.startError);
          if (say) this.narrate('💥', `${name} in ${pod.metadata.name} could not start: the command does not exist in image ${spec.image}.`, 'bad');
          return;
        }
        cs.proc = r.proc;
        cs.phase = 'running';
        cs.startedAt = now;
        cs.everStarted = true;
        cs.waitingReason = null; cs.waitingMessage = null;
        cs.probes = {};
        cs.started = !spec.startupProbe;
        cs.ready = false;
        this.event(pod, 'Normal', 'Created', `Created container ${name}`, 'kubelet');
        this.event(pod, 'Normal', 'Started', `Started container ${name}`, 'kubelet');
        this.emit('kubelet', { node, pod: pod.metadata.uid, action: 'start' });
        if (say && cs.restartCount === 0) this.narrate('▶️', `kubelet on ${node} started container ${name} in ${pod.metadata.name}.`, 'info');
        if (spec.lifecycle && spec.lifecycle.postStart && spec.lifecycle.postStart.exec) {
          const out = R.runSync(cs.sh, (spec.lifecycle.postStart.exec.command || []).map(R.shQuote).join(' ').replace(/^'?(\/bin\/)?sh'? '-c' /, ''));
          if (out.code !== 0) {
            this.event(pod, 'Warning', 'FailedPostStartHook', `PostStartHook failed`, 'kubelet');
            this.terminateContainer(pod, cs, 137, 'Error', 'PostStartHook failed');
          }
        }
        return;
      }
      case 'running': {
        const p = cs.proc;
        p.step(now);
        // memory limit -> OOM kill
        const lim = spec.resources && spec.resources.limits && spec.resources.limits.memory;
        if (!p.exited && lim && p.mem() > U.parseMem(lim)) {
          this.terminateContainer(pod, cs, 137, 'OOMKilled');
          this.emit('kubelet', { node, pod: pod.metadata.uid, action: 'oom' });
          if (say) this.narrate('🧨', `${name} in ${pod.metadata.name} used ${U.fmtMem(p.mem())} but its memory limit is ${lim} → the kernel OOM-killed it (exit code 137).`, 'bad');
          return;
        }
        if (p.exited) {
          const code = p.exited.code;
          this.terminateContainer(pod, cs, code, code === 0 ? 'Completed' : 'Error');
          if (code !== 0) {
            this.emit('kubelet', { node, pod: pod.metadata.uid, action: 'crash' });
            if (say) this.narrate('💥', `Container ${name} in ${pod.metadata.name} exited with code ${code}${code === 1 ? ' (application error — check the logs)' : code === 127 ? ' (command not found)' : ''}.`, 'bad');
          } else if (say && !policyRestarts(0)) this.narrate('✅', `Container ${name} in ${pod.metadata.name} finished successfully (exit 0).`, 'good');
          else if (say) this.narrate('🔁', `Container ${name} in ${pod.metadata.name} exited 0, but restartPolicy=Always restarts it anyway — a main process must keep running.`, 'warn');
          return;
        }
        if (!cs.isInit || spec.restartPolicy === 'Always') this.runProbes(pod, spec, cs);
        return;
      }
      case 'terminated': {
        if (cs.isInit && cs.exitCode === 0 && spec.restartPolicy !== 'Always') return;
        const restart = cs.isInit ? (spec.restartPolicy === 'Always' || (restartPolicy !== 'Never' && cs.exitCode !== 0)) : policyRestarts(cs.exitCode);
        if (!restart) return;
        if (cs.restartAt == null) {
          // reset back-off after a long healthy run
          if (cs.finishedAt - cs.startedAt > 600000) cs.backoff = 0;
          const delay = cs.backoff;
          cs.restartAt = now + delay;
          cs.backoff = delay === 0 ? 10000 : Math.min(300000, delay * 2);
          if (delay > 0) {
            cs.waitingReason = 'CrashLoopBackOff';
            cs.waitingMessage = `back-off ${U.humanDuration(delay)} restarting failed container=${name} pod=${pod.metadata.name}_${ns}(${pod.metadata.uid})`;
            this.event(pod, 'Warning', 'BackOff', `Back-off restarting failed container ${name} in pod ${pod.metadata.name}_${ns}(${pod.metadata.uid})`, 'kubelet');
            if (say) this.narrate('⏳', `CrashLoopBackOff: kubelet waits ${U.humanDuration(delay)} before restarting ${name} in ${pod.metadata.name} again (the wait doubles each time, up to 5m).`, 'warn');
          }
        }
        if (now >= cs.restartAt) {
          cs.restartAt = null;
          cs.prevLogs = cs.logs; cs.logs = [];
          cs.restartCount++;
          cs.lastTerm = { exitCode: cs.exitCode, reason: cs.termReason, startedAt: cs.startedAt, finishedAt: cs.finishedAt, containerID: cs.containerID, message: cs.termMessage };
          cs.phase = 'new';
          cs.waitingReason = cs.waitingReason === 'CrashLoopBackOff' ? 'CrashLoopBackOff' : null;
        }
        return;
      }
    }
  };
  C.terminateContainer = function (pod, cs, code, reason, message) {
    cs.phase = 'terminated';
    cs.exitCode = code;
    cs.termReason = reason;
    cs.termMessage = message;
    cs.finishedAt = this.now;
    cs.ready = false;
    cs.started = false;
    cs.proc = null;
    cs.restartAt = null;
  };

  // ------------------------------------------------------------------ probes
  C.probeResult = function (pod, spec, cs, probe) {
    const ip = pod.status.podIP || '';
    if (probe.exec) {
      const r = R.runSync(cs.sh, (probe.exec.command || []).map(R.shQuote).join(' '));
      return { ok: r.code === 0, msg: (r.stdout + r.stderr).trim() };
    }
    const portOf = p => (typeof p === 'number' || /^\d+$/.test(String(p)) ? +p : ((spec.ports || []).find(x => x.name === p) || {}).containerPort);
    if (probe.httpGet) {
      const port = portOf(probe.httpGet.port);
      const url = `${(probe.httpGet.scheme || 'HTTP').toLowerCase()}://${ip}:${port}${probe.httpGet.path || '/'}`;
      if (!cs.proc || !cs.proc.listens(port)) return { ok: false, msg: `Get "${url}": dial tcp ${ip}:${port}: connect: connection refused` };
      const resp = cs.proc.http({ path: probe.httpGet.path || '/', method: 'GET', srcIp: pod.status.hostIP, agent: 'kube-probe/1.33' });
      if (!resp) return { ok: false, msg: `Get "${url}": EOF` };
      if (resp.code >= 200 && resp.code < 400) return { ok: true };
      return { ok: false, msg: `HTTP probe failed with statuscode: ${resp.code}` };
    }
    if (probe.tcpSocket || probe.grpc) {
      const port = portOf((probe.tcpSocket || probe.grpc).port);
      if (cs.proc && cs.proc.listens(port)) return { ok: true };
      return { ok: false, msg: `dial tcp ${ip}:${port}: connect: connection refused` };
    }
    return { ok: true };
  };
  C.runProbes = function (pod, spec, cs) {
    const now = this.now;
    const say = userNs(pod.metadata.namespace);
    const run = (kind, probe, onPass, onFail) => {
      const st = cs.probes[kind] = cs.probes[kind] || { nextAt: cs.startedAt + (probe.initialDelaySeconds || 0) * 1000, fails: 0, succ: 0 };
      if (now < st.nextAt) return;
      st.nextAt = now + (probe.periodSeconds || 10) * 1000;
      const r = this.probeResult(pod, spec, cs, probe);
      if (r.ok) { st.fails = 0; st.succ++; if (st.succ >= (probe.successThreshold || 1)) onPass(); }
      else {
        st.succ = 0; st.fails++;
        const label = kind[0].toUpperCase() + kind.slice(1);
        this.event(pod, 'Warning', 'Unhealthy', `${label} probe failed: ${r.msg}`, 'kubelet');
        if (st.fails >= (probe.failureThreshold || 3)) onFail(r.msg);
      }
    };
    if (spec.startupProbe && !cs.started) {
      run('startup', spec.startupProbe, () => { cs.started = true; }, () => {
        this.event(pod, 'Normal', 'Killing', `Container ${spec.name} failed startup probe, will be restarted`, 'kubelet');
        if (say) this.narrate('🩺', `Startup probe for ${spec.name} in ${pod.metadata.name} failed ${spec.startupProbe.failureThreshold || 3} times → container restarted.`, 'bad');
        this.killForProbe(pod, cs);
      });
      if (!cs.started) { cs.ready = false; return; }
    }
    if (spec.livenessProbe) {
      run('liveness', spec.livenessProbe, () => {}, () => {
        this.event(pod, 'Normal', 'Killing', `Container ${spec.name} failed liveness probe, will be restarted`, 'kubelet');
        if (say) this.narrate('🩺', `Liveness probe failed ${spec.livenessProbe.failureThreshold || 3}× for ${spec.name} in ${pod.metadata.name} → kubelet kills and restarts the container.`, 'bad');
        this.killForProbe(pod, cs);
      });
      if (cs.phase !== 'running') return;
    }
    if (spec.readinessProbe) {
      run('readiness', spec.readinessProbe, () => {
        if (!cs.ready && say) this.narrate('🟢', `Readiness probe passed for ${pod.metadata.name} → it can receive Service traffic.`, 'good');
        cs.ready = true;
      }, () => {
        if (cs.ready && say) this.narrate('🟡', `Readiness probe failing for ${pod.metadata.name} → removed from Service endpoints (NOT restarted).`, 'warn');
        cs.ready = false;
      });
    } else cs.ready = cs.started;
  };
  C.killForProbe = function (pod, cs) {
    const isServer = cs.proc && cs.proc.kind === 'server';
    this.terminateContainer(pod, cs, isServer ? 0 : 137, isServer ? 'Completed' : 'Error');
    this.emit('kubelet', { node: pod.spec.nodeName, pod: pod.metadata.uid, action: 'crash' });
    cs.forceRestart = true;
  };

  // ------------------------------------------------------------------ pod sync
  C.syncPod = function (pod) {
    const rt = this.podRuntime(pod);
    const now = this.now;
    if (pod.metadata.deletionTimestamp) return this.terminatePod(pod, rt);
    if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') return;
    const ns = pod.metadata.namespace;
    if (!rt.volumesReady) {
      const problems = this.setupVolumes(pod, rt);
      if (problems.length) {
        if (now >= rt.mountEvAt) {
          problems.forEach(m => this.event(pod, 'Warning', 'FailedMount', m, 'kubelet'));
          if (rt.mountEvAt === 0 && userNs(ns)) this.narrate('📂', `${pod.metadata.name} is stuck in ContainerCreating: ${problems[0].replace(/^MountVolume.SetUp failed for volume "[^"]+" : /, '')}.`, 'bad');
          rt.mountEvAt = now + 15000;
        }
        this.updatePodStatus(pod, rt);
        return;
      }
      rt.volumesReady = true;
      rt.sandboxAt = now + 250;
    }
    if (!rt.ip) {
      if (now < rt.sandboxAt) { this.updatePodStatus(pod, rt); return; }
      rt.ip = pod.spec.hostNetwork ? this.nodeIP(pod.spec.nodeName) : this.allocPodIP(pod.spec.nodeName);
      rt.startTime = this.ts();
    }
    const rp = pod.spec.restartPolicy || 'Always';
    // init containers (sequential); native sidecars (restartPolicy: Always) keep running
    let initDone = true;
    for (const spec of pod.spec.initContainers || []) {
      const cs = rt.init[spec.name];
      const sidecar = spec.restartPolicy === 'Always';
      if (!sidecar && cs.phase === 'terminated' && cs.exitCode === 0) continue;
      this.stepContainer(pod, rt, spec, cs, sidecar ? 'Always' : (rp === 'Never' ? 'Never' : 'OnFailure'));
      if (sidecar && cs.phase === 'running' && cs.started) continue;
      if (!sidecar && cs.phase === 'terminated' && cs.exitCode === 0) {
        if (userNs(ns)) this.narrate('🧰', `Init container ${spec.name} in ${pod.metadata.name} completed.`, 'good');
        continue;
      }
      if (!sidecar && cs.phase === 'terminated' && cs.exitCode !== 0 && rp === 'Never') { rt.failed = true; }
      initDone = false;
      break;
    }
    if (initDone && !rt.failed) {
      for (const spec of pod.spec.containers) this.stepContainer(pod, rt, spec, rt.containers[spec.name], rp);
    }
    for (const spec of pod.spec.ephemeralContainers || []) {
      const cs = rt.ephemeral[spec.name] = rt.ephemeral[spec.name] || this.newContainerState(spec, false);
      if (cs.phase !== 'terminated') this.stepContainer(pod, rt, spec, cs, 'Never');
      if (cs.phase === 'running' && spec.targetContainerName && rt.containers[spec.targetContainerName] && rt.containers[spec.targetContainerName].fs && !cs.linkedTarget) {
        cs.linkedTarget = true;
        cs.fs.mount('/proc/1/root', rt.containers[spec.targetContainerName].fs.root, { name: 'target-root' });
      }
    }
    this.updatePodStatus(pod, rt);
  };

  C.terminatePod = function (pod, rt) {
    const now = this.now;
    if (!rt.termStart) {
      rt.termStart = now;
      const grace = pod.metadata.deletionGracePeriodSeconds != null ? pod.metadata.deletionGracePeriodSeconds : 30;
      rt.graceEnd = now + grace * 1000;
      const all = pod.spec.containers.map(s => [s, rt.containers[s.name]]).concat((pod.spec.initContainers || []).filter(s => s.restartPolicy === 'Always').map(s => [s, rt.init[s.name]]));
      for (const [spec, cs] of all) {
        if (!cs) continue;
        cs.ready = false;
        if (cs.phase !== 'running') { cs.stopAt = now; continue; }
        this.event(pod, 'Normal', 'Killing', `Stopping container ${spec.name}`, 'kubelet');
        let preStop = 0;
        const ps = spec.lifecycle && spec.lifecycle.preStop;
        if (ps && ps.exec) {
          const cmd = ps.exec.command || [];
          const script = (cmd[1] === '-c' && /sh$/.test(cmd[0])) ? cmd[2] : cmd.map(R.shQuote).join(' ');
          const m = String(script).match(/sleep\s+(\d+(?:\.\d+)?)/);
          preStop = m ? parseFloat(m[1]) * 1000 : 0;
          R.runSync(cs.sh, script);
        } else if (ps && ps.sleep) preStop = (ps.sleep.seconds || 0) * 1000;
        cs.stopAt = Math.min(rt.graceEnd, now + preStop + cs.proc.termDelay());
        cs.sigkill = now + preStop + cs.proc.termDelay() > rt.graceEnd;
        if (userNs(pod.metadata.namespace) && cs.proc.termDelay() === Infinity && grace > 2) {
          this.narrate('⌛', `${pod.metadata.name}: ${spec.name} runs a shell as PID 1, which ignores SIGTERM — kubelet waits the full grace period (${grace}s) before SIGKILL. Tip: --grace-period=0 --force or handle signals in your app.`, 'warn');
        } else if (userNs(pod.metadata.namespace) && preStop) {
          this.narrate('🧘', `${pod.metadata.name}: preStop hook running (${preStop / 1000}s) before SIGTERM — lets load balancers stop sending traffic first.`, 'info');
        }
      }
      this.updatePodStatus(pod, rt);
    }
    let allStopped = true;
    for (const s of pod.spec.containers.concat(pod.spec.initContainers || [])) {
      const cs = rt.containers[s.name] || rt.init[s.name];
      if (!cs || cs.phase !== 'running') continue;
      cs.proc.step(now);
      if (now >= (cs.stopAt != null ? cs.stopAt : now) || cs.proc.exited) {
        this.terminateContainer(pod, cs, cs.sigkill ? 137 : (cs.proc && cs.proc.exited ? cs.proc.exited.code : 0), cs.sigkill ? 'Error' : 'Completed');
      } else allStopped = false;
    }
    if (allStopped) {
      this.remove(pod);
      this.onDeleted(pod);
      if (userNs(pod.metadata.namespace)) this.narrate('🗑️', `Pod ${pod.metadata.name} terminated and was removed.`, 'info');
    }
  };

  // ------------------------------------------------------------------ status
  C.containerStatus = function (spec, cs) {
    const st = { name: spec.name, image: spec.image, imageID: cs.imageID || '', ready: !!cs.ready, restartCount: cs.restartCount, started: cs.phase === 'running' && !!cs.started };
    if (cs.containerID) st.containerID = cs.containerID;
    if (cs.phase === 'running') st.state = { running: { startedAt: U.iso(cs.startedAt) } };
    else if (cs.phase === 'terminated' && !(cs.restartAt != null && cs.waitingReason === 'CrashLoopBackOff' && cs.restartAt > this.now && cs.backoff > 10000)) {
      st.state = { terminated: { exitCode: cs.exitCode, reason: cs.termReason, startedAt: U.iso(cs.startedAt), finishedAt: U.iso(cs.finishedAt), containerID: cs.containerID } };
      if (cs.termMessage) st.state.terminated.message = cs.termMessage;
    } else {
      const reason = cs.phase === 'terminated' ? 'CrashLoopBackOff' : (cs.waitingReason || (cs.isInit ? 'PodInitializing' : 'ContainerCreating'));
      st.state = { waiting: { reason } };
      if (cs.phase === 'terminated') st.state.waiting.message = cs.waitingMessage;
      else if (cs.waitingMessage && reason !== 'ContainerCreating' && reason !== 'PodInitializing') st.state.waiting.message = cs.waitingMessage;
    }
    if (cs.phase === 'terminated' && st.state.waiting) {
      st.lastState = { terminated: { exitCode: cs.exitCode, reason: cs.termReason, startedAt: U.iso(cs.startedAt), finishedAt: U.iso(cs.finishedAt), containerID: cs.containerID } };
    } else if (cs.lastTerm) {
      st.lastState = { terminated: { exitCode: cs.lastTerm.exitCode, reason: cs.lastTerm.reason, startedAt: U.iso(cs.lastTerm.startedAt), finishedAt: U.iso(cs.lastTerm.finishedAt), containerID: cs.lastTerm.containerID } };
    } else st.lastState = {};
    if (!st.imageID) delete st.imageID;
    return st;
  };
  C.updatePodStatus = function (pod, rt) {
    // cheap change detection: rebuilding status JSON every tick is the hot path
    const cs2 = c => (c ? `${c.phase}${c.ready ? 1 : 0}${c.started ? 1 : 0}${c.restartCount}${c.waitingReason || ''}${c.exitCode}${c.restartAt != null && c.restartAt > this.now ? 1 : 0}${c.backoffShown ? 1 : 0}` : '-');
    const nodeUp = this.rt.nodes[pod.spec.nodeName] && this.rt.nodes[pod.spec.nodeName].up;
    const sigOf = rvPart => `${rt.ip}|${rt.failed ? 1 : 0}|${nodeUp ? 1 : 0}|${pod.metadata.deletionTimestamp ? 1 : 0}|${rvPart}|` + Object.values(rt.init).map(cs2).join(',') + '|' + Object.values(rt.containers).map(cs2).join(',') + '|' + Object.values(rt.ephemeral).map(cs2).join(',');
    // someone else (e.g. the node controller) changed the Pod object → recompute too
    const sig = sigOf(pod.metadata.resourceVersion === rt.lastRv ? '' : pod.metadata.resourceVersion);
    if (sig === rt.statusSig) return;
    this.updatePodStatusFull(pod, rt);
    rt.lastRv = pod.metadata.resourceVersion;
    rt.statusSig = sigOf('');
  };
  C.updatePodStatusFull = function (pod, rt) {
    const now = this.ts();
    const before = JSON.stringify(pod.status);
    const st = pod.status;
    st.hostIP = this.nodeIP(pod.spec.nodeName);
    st.hostIPs = [{ ip: st.hostIP }];
    if (rt.ip) { st.podIP = rt.ip; st.podIPs = [{ ip: rt.ip }]; }
    if (rt.startTime) st.startTime = rt.startTime;
    const inits = pod.spec.initContainers || [];
    st.initContainerStatuses = inits.map(s => this.containerStatus(s, rt.init[s.name]));
    if (!st.initContainerStatuses.length) delete st.initContainerStatuses;
    st.containerStatuses = pod.spec.containers.map(s => this.containerStatus(s, rt.containers[s.name]));
    if ((pod.spec.ephemeralContainers || []).length) st.ephemeralContainerStatuses = pod.spec.ephemeralContainers.map(s => this.containerStatus(s, rt.ephemeral[s.name] || this.newContainerState(s)));
    const initDone = inits.every(s => { const cs = rt.init[s.name]; return s.restartPolicy === 'Always' ? cs.phase === 'running' && cs.started : cs.phase === 'terminated' && cs.exitCode === 0; });
    const mains = pod.spec.containers.map(s => rt.containers[s.name]);
    const rp = pod.spec.restartPolicy || 'Always';
    const willRestart = cs => rp === 'Always' || (rp === 'OnFailure' && cs.exitCode !== 0);
    let phase = 'Pending';
    if (rt.failed) phase = 'Failed';
    else if (initDone) {
      const allTerm = mains.every(cs => cs.phase === 'terminated' && !willRestart(cs));
      if (allTerm) phase = mains.some(cs => cs.exitCode !== 0) ? 'Failed' : 'Succeeded';
      else if (mains.some(cs => cs.phase === 'running' || (cs.everStarted && cs.phase !== 'new' && cs.phase !== 'pulling' && cs.phase !== 'creating') || (cs.everStarted))) phase = 'Running';
    }
    st.phase = phase;
    const cReady = initDone && mains.every(cs => cs.ready && cs.phase === 'running') && !pod.metadata.deletionTimestamp;
    const unready = pod.spec.containers.filter(s => !(rt.containers[s.name].ready && rt.containers[s.name].phase === 'running')).map(s => s.name);
    const nodeOk = this.rt.nodes[pod.spec.nodeName] && this.rt.nodes[pod.spec.nodeName].up;
    const ready = cReady && nodeOk;
    const terminal = phase === 'Succeeded' || phase === 'Failed';
    setCond(pod, 'PodReadyToStartContainers', rt.ip && !terminal ? 'True' : 'False', undefined, undefined, now);
    setCond(pod, 'Initialized', initDone ? 'True' : 'False', initDone ? undefined : 'ContainersNotInitialized', initDone ? undefined : `containers with incomplete status: [${inits.filter(s => !(rt.init[s.name].phase === 'terminated' && rt.init[s.name].exitCode === 0)).map(s => s.name).join(' ')}]`, now);
    setCond(pod, 'Ready', ready ? 'True' : 'False', ready ? undefined : (terminal ? 'PodCompleted' : 'ContainersNotReady'), ready || terminal ? undefined : `containers with unready status: [${unready.join(' ')}]`, now);
    setCond(pod, 'ContainersReady', cReady ? 'True' : 'False', cReady ? undefined : (terminal ? 'PodCompleted' : 'ContainersNotReady'), cReady || terminal ? undefined : `containers with unready status: [${unready.join(' ')}]`, now);
    const order = ['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady', 'PodScheduled'];
    st.conditions.forEach(c => { delete c.lastUpdateTime; if (c.lastProbeTime === undefined) c.lastProbeTime = null; });
    st.conditions.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    st.qosClass = KS.qosClass(pod);
    if (JSON.stringify(st) !== before) {
      const wasReady = before.includes('"type":"Ready","status":"True"');
      this.put(pod);
      if (ready && !wasReady) this.emit('kubelet', { node: pod.spec.nodeName, pod: pod.metadata.uid, action: 'ready' });
    }
  };

  // =================================================================== metrics
  C.workloadKeyOf = function (pod) {
    const ref = (pod.metadata.ownerReferences || []).find(r => r.controller);
    if (!ref) return null;
    if (ref.kind === 'ReplicaSet') {
      const rs = this.get('ReplicaSet', pod.metadata.namespace, ref.name);
      const dref = rs && (rs.metadata.ownerReferences || []).find(r => r.controller && r.kind === 'Deployment');
      return dref ? `${pod.metadata.namespace}/${dref.name}` : `${pod.metadata.namespace}/${ref.name}`;
    }
    return `${pod.metadata.namespace}/${ref.name}`;
  };
  C.podCpu = function (pod) {
    const rt = this.rt.pods[pod.metadata.uid];
    if (!rt) return 0;
    let cpu = 0;
    for (const s of pod.spec.containers) { const cs = rt.containers[s.name]; if (cs && cs.proc) cpu += cs.proc.cpu(); }
    const key = this.workloadKeyOf(pod);
    const load = key && this.rt.loads[key];
    if (load) {
      const peers = this.ls('Pod', pod.metadata.namespace).filter(p => isActive(p) && isReady(p) && this.workloadKeyOf(p) === key).length || 1;
      let share = load / peers;
      const lim = pod.spec.containers[0].resources && pod.spec.containers[0].resources.limits && pod.spec.containers[0].resources.limits.cpu;
      if (lim) share = Math.min(share, U.parseCpu(lim));
      cpu += share;
    }
    return Math.round(cpu);
  };
  C.podMem = function (pod) {
    const rt = this.rt.pods[pod.metadata.uid];
    if (!rt) return 0;
    let m = 0;
    for (const s of pod.spec.containers) { const cs = rt.containers[s.name]; if (cs && cs.proc) m += cs.proc.mem(); }
    const key = this.workloadKeyOf(pod);
    if (key && this.rt.loads[key]) m += 4;
    return m;
  };

  // =================================================================== networking
  function ipInCidr(ip, cidr) {
    const [base, bits] = cidr.split('/');
    const toN = s => s.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
    const mask = bits === '0' ? 0 : (~0 << (32 - +bits)) >>> 0;
    return (toN(ip) & mask) === (toN(base) & mask);
  }
  const isIP = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

  C.podByIP = function (ip) {
    for (const p of this.objs.Pod.values()) if (p.status.podIP === ip && !p.spec.hostNetwork && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed') return p;
    return null;
  };
  C.nsLabels = function (ns) { const n = this.get('Namespace', '', ns); return (n && n.metadata.labels) || {}; };
  C.srcFromPod = function (pod) { return { pod, ip: pod.status.podIP, ns: pod.metadata.namespace, labels: pod.metadata.labels || {} }; };

  C.peerMatches = function (peer, policyNs, src) {
    if (peer.ipBlock) {
      if (!src.ip || !ipInCidr(src.ip, peer.ipBlock.cidr)) return false;
      return !(peer.ipBlock.except || []).some(c => ipInCidr(src.ip, c));
    }
    if (!src.pod) return false;
    const srcNs = src.ns;
    if (peer.namespaceSelector) {
      if (!this.selectorMatchesAll(peer.namespaceSelector, this.nsLabels(srcNs))) return false;
    } else if (srcNs !== policyNs) return false;
    if (peer.podSelector) return this.selectorMatchesAll(peer.podSelector, src.labels);
    return true;
  };
  C.selectorMatchesAll = function (sel, labels) {
    const empty = !(sel.matchLabels && Object.keys(sel.matchLabels).length) && !(sel.matchExpressions && sel.matchExpressions.length);
    return empty || U.matchSelector(sel, labels);
  };
  C.portMatches = function (ports, port, proto, pod) {
    if (!ports || !ports.length) return true;
    return ports.some(p => {
      if ((p.protocol || 'TCP') !== (proto || 'TCP')) return false;
      if (p.port == null) return true;
      const pp = typeof p.port === 'string' && !/^\d+$/.test(p.port) ? (pod ? this.resolveTargetPort(pod, p.port) : null) : +p.port;
      if (p.endPort) return port >= pp && port <= p.endPort;
      return pp === port;
    });
  };
  C.policiesFor = function (pod, type) {
    return this.ls('NetworkPolicy', pod.metadata.namespace).filter(np => (np.spec.policyTypes || ['Ingress']).includes(type) && this.selectorMatchesAll(np.spec.podSelector || {}, pod.metadata.labels || {}));
  };
  C.ingressAllowed = function (dst, src, port, proto) {
    if (src.pod && src.pod.metadata.uid === dst.metadata.uid) return { ok: true };
    const pols = this.policiesFor(dst, 'Ingress');
    if (!pols.length) return { ok: true };
    for (const np of pols) for (const rule of np.spec.ingress || []) {
      const fromOk = !rule.from || !rule.from.length || rule.from.some(peer => this.peerMatches(peer, np.metadata.namespace, src));
      if (fromOk && this.portMatches(rule.ports, port, proto, dst)) return { ok: true };
    }
    return { ok: false, by: pols.map(p => p.metadata.name) };
  };
  C.egressAllowed = function (srcPod, dst, port, proto) {
    if (!srcPod || srcPod.spec.hostNetwork) return { ok: true };
    const pols = this.policiesFor(srcPod, 'Egress');
    if (!pols.length) return { ok: true };
    const dsrc = dst.pod ? { pod: dst.pod, ip: dst.ip, ns: dst.pod.metadata.namespace, labels: dst.pod.metadata.labels || {} } : { ip: dst.ip };
    for (const np of pols) for (const rule of np.spec.egress || []) {
      const toOk = !rule.to || !rule.to.length || rule.to.some(peer => this.peerMatches(peer, np.metadata.namespace, dsrc));
      if (toOk && this.portMatches(rule.ports, port, proto, dst.pod)) return { ok: true };
    }
    return { ok: false, by: pols.map(p => p.metadata.name) };
  };

  // DNS
  C.dnsServing = function (srcPod) {
    const ep = this.get('Endpoints', 'kube-system', 'kube-dns');
    const addrs = ((ep && ep.subsets) || []).flatMap(s => s.addresses || []);
    if (!addrs.length) return false;
    if (srcPod) {
      const dnsPod = this.get('Pod', 'kube-system', addrs[0].targetRef.name);
      const eg = this.egressAllowed(srcPod, { pod: dnsPod, ip: addrs[0].ip }, 53, 'UDP');
      if (!eg.ok) return false;
    }
    return true;
  };
  C.dnsLookupFqdn = function (fqdn) {
    let m = fqdn.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.svc\.cluster\.local$/);
    if (m) {
      const svc = this.get('Service', m[2], m[1]);
      if (!svc) return null;
      if (svc.spec.type === 'ExternalName') {
        const ext = KS.EXTERNAL_HOSTS[svc.spec.externalName];
        return ext ? { ips: [ext.ip], cname: svc.spec.externalName } : { ips: [], cname: svc.spec.externalName };
      }
      if (svc.spec.clusterIP === 'None') {
        const ep = this.get('Endpoints', m[2], m[1]);
        const ips = ((ep && ep.subsets) || []).flatMap(s => (s.addresses || []).map(a => a.ip));
        return ips.length ? { ips } : null;
      }
      return { ips: [svc.spec.clusterIP] };
    }
    m = fqdn.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.([a-z0-9-]+)\.svc\.cluster\.local$/);
    if (m) {
      const svc = this.get('Service', m[3], m[2]);
      if (!svc || svc.spec.clusterIP !== 'None') return null;
      const pod = this.ls('Pod', m[3]).find(p => (p.spec.hostname === m[1]) && p.spec.subdomain === m[2] && isReady(p) && !p.metadata.deletionTimestamp);
      return pod ? { ips: [pod.status.podIP] } : null;
    }
    m = fqdn.match(/^(\d+)-(\d+)-(\d+)-(\d+)\.([a-z0-9-]+)\.pod\.cluster\.local$/);
    if (m) return { ips: [`${m[1]}.${m[2]}.${m[3]}.${m[4]}`] };
    if (KS.EXTERNAL_HOSTS[fqdn]) return { ips: [KS.EXTERNAL_HOSTS[fqdn].ip], external: true };
    return null;
  };
  C.resolveFrom = function (srcPod, name) {
    name = String(name).replace(/\.$/, '').toLowerCase();
    if (isIP(name)) return { records: [{ name, ip: name }], fqdn: name };
    if (name === 'localhost') return { records: [{ name, ip: '127.0.0.1' }], fqdn: name };
    if (!srcPod) {
      // your laptop: no cluster DNS. Public names resolve, and Ingress hosts are in /etc/hosts for this playground.
      if (KS.EXTERNAL_HOSTS[name]) return { records: [{ name, ip: KS.EXTERNAL_HOSTS[name].ip }], fqdn: name };
      const ing = this.ls('Ingress').find(i => (i.spec.rules || []).some(r => r.host && hostMatch(r.host, name)) && i.status.loadBalancer.ingress);
      if (ing) return { records: [{ name, ip: ing.status.loadBalancer.ingress[0].ip }], fqdn: name, viaHosts: true };
      return { error: 'NXDOMAIN', fqdn: name };
    }
    if (!this.dnsServing(srcPod)) return { timeout: true, fqdn: name };
    const ns = srcPod.metadata.namespace;
    const dots = (name.match(/\./g) || []).length;
    const cands = dots < 5 ? [`${name}.${ns}.svc.cluster.local`, `${name}.svc.cluster.local`, `${name}.cluster.local`, name] : [name];
    for (const fq of cands) {
      const r = this.dnsLookupFqdn(fq);
      if (r && r.ips.length) return { records: r.ips.map(ip => ({ name: r.cname || fq, ip })), fqdn: fq, cname: r.cname };
    }
    return { error: 'NXDOMAIN', fqdn: cands[0] };
  };
  function hostMatch(pattern, host) {
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.split('.').length === pattern.split('.').length;
    return pattern === host;
  }

  // HTTP/TCP request from a pod (src = pod) or from your laptop (src = null)
  C.netFor = function (pod) {
    const k = this;
    const src = () => (pod ? this.get('Pod', pod.metadata.namespace, pod.metadata.name) || pod : null);
    return {
      resolve: name => k.resolveFrom(src(), name),
      request: opts => k.request(src(), opts),
      ping: host => k.ping(src(), host),
    };
  };
  C.ping = function (srcPod, host) {
    const r = this.resolveFrom(srcPod, host);
    if (r.error || r.timeout) return { error: 'bad address' };
    const ip = r.records[0].ip;
    if (this.ls('Service').some(s => s.spec.clusterIP === ip)) return { ip, reply: false, note: `(Kubester tip: ${ip} is a Service ClusterIP — a virtual IP implemented by kube-proxy rules for TCP/UDP ports. It does not answer ping. Use curl or nc instead.)` };
    if (!srcPod && ip.startsWith('10.244.')) return { ip, reply: false };
    return { ip, reply: true };
  };

  C.request = function (srcPod, opts) {
    let url = String(opts.url || '');
    if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
    let u;
    try { u = new URL(url); } catch (e) { return { ok: false, error: 'resolve', host: url }; }
    const https = u.protocol === 'https:';
    const host = u.hostname.toLowerCase();
    const port = u.port ? +u.port : https ? 443 : 80;
    const path = (u.pathname || '/') + (u.search || '');
    const headers = opts.headers || {};
    const hops = [srcPod ? { t: 'pod', id: srcPod.metadata.uid } : { t: 'host' }];
    const finish = (r, extra) => {
      if (!opts.quiet) this.emit('traffic', Object.assign({ hops, ok: !!r.ok, code: r.code, error: r.error, blocked: !!r.blocked }, extra || {}));
      return Object.assign({ host, port }, r);
    };
    const res = this.resolveFrom(srcPod, host);
    if (res.timeout) return finish({ ok: false, error: 'timeout', note: '(Kubester: DNS lookup timed out — is CoreDNS running and is DNS (UDP 53) allowed by NetworkPolicy?)' });
    if (res.error) {
      const note = !srcPod && /svc|cluster\.local|^[a-z0-9-]+$/.test(host) && !KS.EXTERNAL_HOSTS[host]
        ? `(Kubester tip: this terminal is your laptop, outside the cluster. Cluster DNS names like "${host}" only resolve inside Pods. Try: kubectl exec -it <pod> -- curl ${host}  or  kubectl port-forward)`
        : undefined;
      return finish({ ok: false, error: 'resolve', note });
    }
    const ip = res.records[0].ip;
    const srcDesc = srcPod ? this.srcFromPod(srcPod) : { ip: '192.168.49.1', external: true };
    const req = { method: opts.method || 'GET', path, headers, srcIp: srcDesc.ip, agent: 'curl/8.11.0' };

    // localhost → port-forward (host) or the pod itself
    if (ip === '127.0.0.1') {
      if (srcPod) return finish(this.deliverToPod(srcDesc, srcPod, port, req, hops, opts, true));
      const fw = this.rt.forwards.find(f => f.local === port);
      if (!fw) return finish({ ok: false, error: 'refused', ip, note: '(Kubester tip: nothing is listening on localhost:' + port + '. Start one with: kubectl port-forward svc/<name> ' + port + ':<port>)' });
      let pod = null, tport = fw.port;
      if (fw.kind === 'pod') pod = this.get('Pod', fw.ns, fw.name);
      else {
        const svc = this.get('Service', fw.ns, fw.name);
        if (svc) {
          const sp = (svc.spec.ports || []).find(p => p.port === fw.port) || svc.spec.ports[0];
          const ep = this.pickEndpoint(svc, sp);
          if (ep) { pod = ep.pod; tport = ep.port; }
        }
      }
      if (!pod) return finish({ ok: false, error: 'refused', ip, note: '(port-forward target is gone)' });
      hops.push({ t: 'pod', id: pod.metadata.uid });
      return finish(this.deliverToPod({ ip: '127.0.0.1', portForward: true }, pod, tport, req, hops, opts, true));
    }
    // Service ClusterIP
    const svcByIP = this.ls('Service').find(s => s.spec.clusterIP === ip && ip !== 'None');
    if (svcByIP) {
      if (!srcPod) return finish({ ok: false, error: 'timeout', ip, note: `(Kubester tip: ${ip} is a ClusterIP — it only exists inside the cluster. From your laptop use a NodePort/LoadBalancer Service, an Ingress, or kubectl port-forward.)` });
      if (svcByIP.metadata.name === 'kubernetes' && svcByIP.metadata.namespace === 'default') {
        return finish({ ok: true, ip, code: 403, body: '{\n  "kind": "Status",\n  "apiVersion": "v1",\n  "metadata": {},\n  "status": "Failure",\n  "message": "forbidden: User \\"system:anonymous\\" cannot get path \\"/\\"",\n  "reason": "Forbidden",\n  "details": {},\n  "code": 403\n}', server: 'kube-apiserver' });
      }
      hops.push({ t: 'svc', id: svcByIP.metadata.uid });
      return finish(this.viaService(srcDesc, svcByIP, port, req, hops, opts));
    }
    // LoadBalancer IPs
    const lbSvc = this.ls('Service').find(s => s.spec.type === 'LoadBalancer' && ((s.status.loadBalancer || {}).ingress || []).some(i => i.ip === ip));
    if (lbSvc) {
      if (lbSvc.metadata.name === 'ingress-nginx-controller' && lbSvc.metadata.namespace === 'ingress-nginx') {
        hops.push({ t: 'ingress' });
        return finish(this.viaIngress(srcDesc, headers.host || host, path, req, hops, opts, https));
      }
      hops.push({ t: 'lb', id: lbSvc.metadata.uid }, { t: 'svc', id: lbSvc.metadata.uid });
      return finish(this.viaService(Object.assign({}, srcDesc, { ip: '192.168.49.11', external: !srcPod }), lbSvc, port, req, hops, opts));
    }
    // Node IP → NodePort
    const node = this.ls('Node').find(n => this.nodeIP(n.metadata.name) === ip);
    if (node) {
      if (!this.rt.nodes[node.metadata.name].up) return finish({ ok: false, error: 'timeout', ip });
      const svc = this.ls('Service').find(s => (s.spec.type === 'NodePort' || s.spec.type === 'LoadBalancer') && (s.spec.ports || []).some(p => p.nodePort === port));
      if (!svc) return finish({ ok: false, error: 'refused', ip });
      const sp = svc.spec.ports.find(p => p.nodePort === port);
      hops.push({ t: 'node', id: node.metadata.name }, { t: 'svc', id: svc.metadata.uid });
      if (svc.metadata.name === 'ingress-nginx-controller') { hops.splice(1, 2, { t: 'ingress' }); return finish(this.viaIngress(srcDesc, headers.host || host, path, req, hops, opts, sp.port === 443)); }
      return finish(this.viaService(Object.assign({}, srcDesc, { ip }), svc, sp.port, req, hops, opts));
    }
    // Pod IP
    const pod = this.podByIP(ip);
    if (pod) {
      if (!srcPod) return finish({ ok: false, error: 'timeout', ip, note: `(Kubester tip: Pod IPs (10.244.x.x) are only routable inside the cluster network.)` });
      hops.push({ t: 'pod', id: pod.metadata.uid });
      return finish(this.deliverToPod(srcDesc, pod, port, req, hops, opts));
    }
    // External
    const ext = Object.keys(KS.EXTERNAL_HOSTS).find(h => KS.EXTERNAL_HOSTS[h].ip === ip);
    if (ext) {
      if (srcPod) {
        const eg = this.egressAllowed(srcPod, { ip }, port, 'TCP');
        if (!eg.ok) { hops.push({ t: 'internet' }); return finish({ ok: false, error: 'timeout', ip, blocked: true, note: `(blocked by egress NetworkPolicy: ${eg.by.join(', ')})` }); }
      }
      hops.push({ t: 'internet' });
      return finish({ ok: true, ip, code: 200, body: KS.EXTERNAL_HOSTS[ext].body, server: 'ECS' });
    }
    return finish({ ok: false, error: 'timeout', ip });
  };
  C.pickEndpoint = function (svc, sp) {
    const ep = this.get('Endpoints', svc.metadata.namespace, svc.metadata.name);
    const cands = [];
    for (const s of (ep && ep.subsets) || []) {
      const p = (s.ports || []).find(x => (sp.name ? x.name === sp.name : true) && x.protocol === (sp.protocol || 'TCP'));
      if (!p) continue;
      for (const a of s.addresses || []) {
        const pod = this.get('Pod', svc.metadata.namespace, a.targetRef.name);
        if (pod) cands.push({ pod, port: p.port });
      }
    }
    if (!cands.length) return null;
    const key = svc.metadata.uid;
    const i = (this.rt.rr[key] = ((this.rt.rr[key] || 0) + 1) % cands.length);
    return cands[i];
  };
  C.viaService = function (src, svc, port, req, hops, opts) {
    const sp = (svc.spec.ports || []).find(p => p.port === port);
    if (!sp) return { ok: false, error: 'refused', ip: svc.spec.clusterIP };
    const pick = this.pickEndpoint(svc, sp);
    if (!pick) return { ok: false, error: 'refused', ip: svc.spec.clusterIP, note: `(Kubester: Service "${svc.metadata.name}" has no ready endpoints. Check: kubectl get endpoints ${svc.metadata.name}  — do the selector labels match your Pods, and are they Ready?)` };
    hops.push({ t: 'pod', id: pick.pod.metadata.uid });
    const r = this.deliverToPod(src, pick.pod, pick.port, req, hops, opts);
    r.ip = svc.spec.clusterIP;
    return r;
  };
  C.deliverToPod = function (src, pod, port, req, hops, opts, skipPolicy) {
    const ip = pod.status.podIP;
    if (!skipPolicy) {
      if (src.pod) {
        const eg = this.egressAllowed(src.pod, { pod, ip }, port, 'TCP');
        if (!eg.ok) return { ok: false, error: 'timeout', ip, blocked: true, note: `(dropped by egress NetworkPolicy ${eg.by.join(', ')} on the client Pod)` };
      }
      const ing = this.ingressAllowed(pod, src, port, 'TCP');
      if (!ing.ok) return { ok: false, error: 'timeout', ip, blocked: true, note: `(dropped by NetworkPolicy ${ing.by.join(', ')} protecting ${pod.metadata.name})` };
    }
    const rt = this.rt.pods[pod.metadata.uid];
    if (!rt || !this.rt.nodes[pod.spec.nodeName] || !this.rt.nodes[pod.spec.nodeName].up) return { ok: false, error: 'timeout', ip };
    const all = Object.values(rt.containers).concat(Object.values(rt.init));
    const cs = all.find(c => c.phase === 'running' && c.proc && c.proc.listens(port));
    if (!cs) return { ok: false, error: 'refused', ip, port };
    if (opts.tcp) return { ok: true, ip, code: 0 };
    const resp = cs.proc.http(req);
    if (!resp) return { ok: false, error: 'empty', ip };
    this.emit('pod-hit', { uid: pod.metadata.uid });
    return { ok: true, ip, code: resp.code, body: resp.body, server: resp.server, pod: pod.metadata.name };
  };
  C.viaIngress = function (src, hostHeader, path, req, hops, opts, https) {
    const ctrl = this.ingressController()[0];
    if (!ctrl) return { ok: false, error: 'refused', ip: '203.0.113.10' };
    const host = String(hostHeader || '').split(':')[0];
    const pathOnly = path.split('?')[0];
    let best = null;
    for (const ing of this.ls('Ingress')) {
      if (!ing.status.loadBalancer.ingress) continue;
      for (const rule of ing.spec.rules || []) {
        if (rule.host && !hostMatch(rule.host, host)) continue;
        for (const p of (rule.http && rule.http.paths) || []) {
          const pp = p.path || '/';
          const match = p.pathType === 'Exact' ? pathOnly === pp : (pp === '/' || pathOnly === pp || pathOnly.startsWith(pp.replace(/\/$/, '') + '/'));
          if (!match) continue;
          const score = (rule.host ? 1000 : 0) + pp.length + (p.pathType === 'Exact' ? 500 : 0);
          if (!best || score > best.score) best = { ing, p, score };
        }
      }
    }
    if (!best) {
      const def = this.ls('Ingress').find(i => i.status.loadBalancer.ingress && i.spec.defaultBackend);
      if (def) best = { ing: def, p: { backend: def.spec.defaultBackend, path: '/' } };
    }
    const ctrlLog = (code, upstream) => this.ctrlLog && this.ctrlLog(ctrl, code, req, upstream);
    void ctrlLog;
    const server = 'nginx';
    if (!best) return { ok: true, code: 404, body: errPage(404, 'Not Found', server), server };
    const ing = best.ing;
    if (https && !(ing.spec.tls || []).some(t => (t.hosts || []).includes(host) && this.get('Secret', ing.metadata.namespace, t.secretName))) {
      if (!(req.headers && req.headers['x-insecure'])) return { ok: false, error: 'SSL certificate problem: self-signed certificate', note: '(ingress-nginx served its "Kubernetes Ingress Controller Fake Certificate" — add a tls: section with a real certificate Secret, or use curl -k)' };
    }
    const be = best.p.backend.service;
    const svc = this.get('Service', ing.metadata.namespace, be.name);
    if (!svc) return { ok: true, code: 503, body: errPage(503, 'Service Temporarily Unavailable', server), server };
    const sp = (svc.spec.ports || []).find(p => (be.port.number ? p.port === be.port.number : p.name === be.port.name));
    hops.push({ t: 'svc', id: svc.metadata.uid });
    if (!sp) return { ok: true, code: 503, body: errPage(503, 'Service Temporarily Unavailable', server), server };
    const pick = this.pickEndpoint(svc, sp);
    if (!pick) return { ok: true, code: 503, body: errPage(503, 'Service Temporarily Unavailable', server), server, note: `(Kubester: backend Service ${svc.metadata.name} has no ready endpoints)` };
    hops.push({ t: 'pod', id: pick.pod.metadata.uid });
    let fwdPath = req.path;
    const rewrite = (ing.metadata.annotations || {})['nginx.ingress.kubernetes.io/rewrite-target'];
    if (rewrite) fwdPath = rewrite.replace(/\$\d/g, '') || '/';
    const r = this.deliverToPod(this.srcFromPod(ctrl), pick.pod, pick.port, Object.assign({}, req, { path: fwdPath, srcIp: ctrl.status.podIP }), hops, opts);
    if (r.ok) return r;
    if (r.blocked) return { ok: true, code: 504, body: errPage(504, 'Gateway Time-out', server), server, blocked: true, note: r.note };
    return { ok: true, code: 502, body: errPage(502, 'Bad Gateway', server), server, note: `(Kubester: ingress-nginx reached Pod ${pick.pod.metadata.name} but nothing answered on port ${pick.port} — check targetPort vs. the container port)` };
  };

  // shell environment for `kubectl exec`
  C.execEnv = function (pod, containerName) {
    const rt = this.rt.pods[pod.metadata.uid];
    if (!rt) return null;
    const cs = rt.containers[containerName] || rt.init[containerName] || rt.ephemeral[containerName];
    if (!cs || cs.phase !== 'running' || !cs.sh) return null;
    const sh = new R.ShellEnv({ fs: cs.fs, env: Object.assign({}, cs.sh.vars), uid: cs.sh.uid, hostname: cs.sh.hostname, ip: rt.ip, net: this.netFor(pod), now: () => this.now, image: cs.sh.image });
    sh.cwd = cs.sh.uid === 0 ? '/' : '/';
    sh.proc = cs.proc;
    return sh;
  };
})(typeof window !== 'undefined' ? window : globalThis);
