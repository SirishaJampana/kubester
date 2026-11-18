/* Kubester — Helm (charts as JS renderers), Kustomize, and a few well-known manifest URLs. No DOM. */
(function (G) {
  'use strict';
  const KS = G.KS;
  const U = KS.util;
  const R = KS.runtime;

  // ------------------------------------------------------------------ charts
  function setPath(obj, path, val) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (!U.isObj(cur[parts[i]])) cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = val;
  }
  function parseSetValue(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null') return null;
    if (/^-?\d+$/.test(v)) return +v;
    return v;
  }
  const commonLabels = (rel, chart, appName, appVersion) => ({
    'app.kubernetes.io/instance': rel.name, 'app.kubernetes.io/managed-by': 'Helm', 'app.kubernetes.io/name': appName,
    'app.kubernetes.io/version': appVersion, 'helm.sh/chart': `${chart.name}-${chart.version}`,
  });
  const fullname = (rel, chartName) => (rel.name.includes(chartName) ? rel.name : `${rel.name}-${chartName}`).slice(0, 63).replace(/-$/, '');
  const relAnn = rel => ({ 'meta.helm.sh/release-name': rel.name, 'meta.helm.sh/release-namespace': rel.namespace });

  const CHARTS = {
    'kubester/webapp': {
      name: 'webapp', version: '1.2.0', appVersion: 'v1', description: 'A tiny web app chart used in Kubester lessons',
      values: { replicaCount: 2, image: { repository: 'kubester/hello', tag: 'v1', pullPolicy: 'IfNotPresent' }, message: 'Hello from Helm', service: { type: 'ClusterIP', port: 80 }, resources: { requests: { cpu: '50m', memory: '32Mi' } } },
      render(rel, v, chart) {
        const fn = fullname(rel, 'webapp');
        const sel = { 'app.kubernetes.io/instance': rel.name, 'app.kubernetes.io/name': 'webapp' };
        const labels = commonLabels(rel, chart, 'webapp', String(v.image.tag));
        return [
          { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: fn, labels, annotations: relAnn(rel) }, data: { MESSAGE: String(v.message) } },
          { apiVersion: 'v1', kind: 'Service', metadata: { name: fn, labels, annotations: relAnn(rel) }, spec: { type: v.service.type, ports: [{ port: +v.service.port, targetPort: 'http', protocol: 'TCP', name: 'http' }], selector: sel } },
          { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: fn, labels, annotations: relAnn(rel) }, spec: { replicas: +v.replicaCount, selector: { matchLabels: sel }, template: { metadata: { labels: Object.assign({}, labels, sel) }, spec: { containers: [{ name: 'webapp', image: `${v.image.repository}:${v.image.tag}`, imagePullPolicy: v.image.pullPolicy, ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }], envFrom: [{ configMapRef: { name: fn } }], readinessProbe: { httpGet: { path: '/ready', port: 'http' } }, resources: v.resources }] } } } },
        ];
      },
      notes: (rel, v) => `1. Get the application URL by running these commands:\n  kubectl port-forward svc/${fullname(rel, 'webapp')} 8080:${v.service.port}\n  curl localhost:8080`,
    },
    'bitnami/nginx': {
      name: 'nginx', version: '18.2.4', appVersion: '1.27.2', description: 'NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache.',
      values: { replicaCount: 1, image: { registry: 'docker.io', repository: 'nginx', tag: '1.27' }, service: { type: 'LoadBalancer', ports: { http: 80 } } },
      render(rel, v, chart) {
        const fn = fullname(rel, 'nginx');
        const sel = { 'app.kubernetes.io/instance': rel.name, 'app.kubernetes.io/name': 'nginx' };
        const labels = commonLabels(rel, chart, 'nginx', chart.appVersion);
        return [
          { apiVersion: 'v1', kind: 'Service', metadata: { name: fn, labels, annotations: relAnn(rel) }, spec: { type: v.service.type, ports: [{ name: 'http', port: +v.service.ports.http, targetPort: 'http', protocol: 'TCP' }], selector: sel } },
          { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: fn, labels, annotations: relAnn(rel) }, spec: { replicas: +v.replicaCount, selector: { matchLabels: sel }, template: { metadata: { labels: Object.assign({}, labels) }, spec: { containers: [{ name: 'nginx', image: `${v.image.repository}:${v.image.tag}`, ports: [{ name: 'http', containerPort: 80 }], readinessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 2, periodSeconds: 5 } }] } } } },
        ];
      },
      notes: (rel) => `CHART NAME: nginx\nCHART VERSION: 18.2.4\nAPP VERSION: 1.27.2\n\n** Please be patient while the chart is being deployed **\nNGINX can be accessed through the following DNS name from within your cluster:\n\n    ${fullname(rel, 'nginx')}.${rel.namespace}.svc.cluster.local (port 80)\n\nTo access NGINX from outside the cluster, follow the steps below:\n\n1. Get the NGINX URL by running these commands:\n\n  NOTE: It may take a few minutes for the LoadBalancer IP to be available.\n        Watch the status with: 'kubectl get svc --namespace ${rel.namespace} -w ${fullname(rel, 'nginx')}'`,
    },
    'bitnami/redis': {
      name: 'redis', version: '20.3.0', appVersion: '7.4.1', description: 'Redis(R) is an open source, advanced key-value store.',
      values: { architecture: 'standalone', auth: { enabled: true, password: 'changeme' }, master: { persistence: { enabled: true, size: '1Gi' } } },
      render(rel, v, chart) {
        const fn = fullname(rel, 'redis');
        const sel = { 'app.kubernetes.io/instance': rel.name, 'app.kubernetes.io/name': 'redis', 'app.kubernetes.io/component': 'master' };
        const labels = commonLabels(rel, chart, 'redis', chart.appVersion);
        const out = [];
        if (v.auth.enabled) out.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name: fn, labels, annotations: relAnn(rel) }, type: 'Opaque', data: { 'redis-password': U.b64encode(String(v.auth.password)) } });
        out.push({ apiVersion: 'v1', kind: 'Service', metadata: { name: `${fn}-headless`, labels, annotations: relAnn(rel) }, spec: { clusterIP: 'None', ports: [{ name: 'tcp-redis', port: 6379, targetPort: 6379 }], selector: sel } });
        out.push({ apiVersion: 'v1', kind: 'Service', metadata: { name: `${fn}-master`, labels, annotations: relAnn(rel) }, spec: { type: 'ClusterIP', ports: [{ name: 'tcp-redis', port: 6379, targetPort: 6379 }], selector: sel } });
        const ct = { name: 'redis', image: 'redis:7.4', ports: [{ name: 'redis', containerPort: 6379 }] };
        if (v.auth.enabled) ct.env = [{ name: 'REDIS_PASSWORD', valueFrom: { secretKeyRef: { name: fn, key: 'redis-password' } } }];
        const sts = { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: `${fn}-master`, labels, annotations: relAnn(rel) }, spec: { replicas: 1, serviceName: `${fn}-headless`, selector: { matchLabels: sel }, template: { metadata: { labels: Object.assign({}, labels, sel) }, spec: { containers: [ct] } } } };
        if (v.master.persistence.enabled) { ct.volumeMounts = [{ name: 'redis-data', mountPath: '/data' }]; sts.spec.volumeClaimTemplates = [{ metadata: { name: 'redis-data' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: v.master.persistence.size } } } }]; }
        out.push(sts);
        return out;
      },
      notes: (rel) => `CHART NAME: redis\nCHART VERSION: 20.3.0\nAPP VERSION: 7.4.1\n\n** Please be patient while the chart is being deployed **\n\nRedis&reg; can be accessed via port 6379 on the following DNS name from within your cluster:\n\n    ${fullname(rel, 'redis')}-master.${rel.namespace}.svc.cluster.local\n\nTo get your password run:\n\n    export REDIS_PASSWORD=$(kubectl get secret --namespace ${rel.namespace} ${fullname(rel, 'redis')} -o jsonpath="{.data.redis-password}" | base64 -d)`,
    },
    'ingress-nginx/ingress-nginx': {
      name: 'ingress-nginx', version: '4.11.3', appVersion: '1.11.3', description: 'Ingress controller for Kubernetes using NGINX as a reverse proxy and load balancer',
      values: { controller: { replicaCount: 1 } },
      special: 'ingress-nginx',
      render() { return []; },
      notes: () => 'The ingress-nginx controller has been installed.\nIt may take a few minutes for the load balancer IP to be available.\nYou can watch the status by running \'kubectl get service --namespace ingress-nginx ingress-nginx-controller --output wide --watch\'',
    },
  };
  const REPOS = {
    bitnami: 'https://charts.bitnami.com/bitnami',
    'ingress-nginx': 'https://kubernetes.github.io/ingress-nginx',
    kubester: 'https://charts.kubester.io',
  };

  class Helm {
    constructor(cluster, kubectl) { this.c = cluster; this.k = kubectl; this.c.rt.helmRepos = this.c.rt.helmRepos || { kubester: REPOS.kubester }; }
    run(argv, io) {
      const flags = {};
      const pos = [];
      const multi = ['set', 'values', 'set-string'];
      const valueFlags = ['namespace', 'set', 'values', 'set-string', 'version', 'timeout', 'output', 'max', 'revision'];
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        let m;
        if ((m = a.match(/^--?([\w-]+)(=(.*))?$/)) && !/^-\d/.test(a)) {
          let name = m[1];
          if (name === 'n') name = 'namespace';
          if (name === 'f') name = 'values';
          if (name === 'A') name = 'all-namespaces';
          if (name === 'a') name = 'all';
          let val = m[3];
          if (val === undefined && valueFlags.includes(name)) val = argv[++i];
          if (val === undefined) val = true;
          if (multi.includes(name)) (flags[name] = flags[name] || []).push(val); else flags[name] = val;
        } else pos.push(a);
      }
      const sub = pos[0];
      const ns = flags.namespace ? String(flags.namespace) : this.c.context.namespace || 'default';
      try {
        switch (sub) {
          case undefined: case 'help': io.out(HELM_HELP); return { code: 0 };
          case 'version': io.out('version.BuildInfo{Version:"v3.16.3", GitCommit:"cfd07493f46efc9debd9cc1b02a0961186df7fdf", GitTreeState:"clean", GoVersion:"go1.22.7"}\n'); return { code: 0 };
          case 'repo': return this.repo(pos.slice(1), flags, io);
          case 'search': return this.search(pos.slice(1), flags, io);
          case 'install': return this.install(pos[1], pos[2], flags, io, ns, false);
          case 'upgrade': return this.install(pos[1], pos[2], flags, io, ns, true);
          case 'template': return this.template(pos[1], pos[2], flags, io, ns);
          case 'list': case 'ls': return this.list(flags, io, ns);
          case 'history': case 'hist': return this.history(pos[1], flags, io, ns);
          case 'status': return this.status(pos[1], flags, io, ns);
          case 'rollback': return this.rollback(pos[1], pos[2], flags, io, ns);
          case 'uninstall': case 'delete': case 'un': case 'del': return this.uninstall(pos[1], flags, io, ns);
          case 'get': return this.get(pos[1], pos[2], flags, io, ns);
          case 'show': case 'inspect': return this.show(pos[1], pos[2], io);
          case 'create': {
            const name = pos[1];
            if (!name) { io.err('Error: "helm create" requires 1 argument\n'); return { code: 1 }; }
            const sh = this.k.env;
            const base = R.normPath(name, sh.cwd());
            sh.fs.mkdir(base + '/templates', true);
            sh.fs.write(base + '/Chart.yaml', `apiVersion: v2\nname: ${name}\ndescription: A Helm chart for Kubernetes\ntype: application\nversion: 0.1.0\nappVersion: "1.16.0"\n`);
            sh.fs.write(base + '/values.yaml', 'replicaCount: 1\nimage:\n  repository: nginx\n  tag: "1.27"\nservice:\n  type: ClusterIP\n  port: 80\n');
            sh.fs.write(base + '/templates/deployment.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include "chart.fullname" . }}\nspec:\n  replicas: {{ .Values.replicaCount }}\n  # ... (Go template)\n');
            sh.fs.write(base + '/templates/service.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ include "chart.fullname" . }}\nspec:\n  type: {{ .Values.service.type }}\n  ports:\n    - port: {{ .Values.service.port }}\n');
            io.out(`Creating ${name}\n`);
            io.err(`(Kubester: chart templates use Go templating, which isn't simulated — but you can install this chart: "helm install demo ./${name}" renders it as nginx using values.yaml.)\n`);
            return { code: 0 };
          }
          case 'lint': io.out('==> Linting ' + (pos[1] || '.') + '\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed\n'); return { code: 0 };
          case 'dependency': case 'dep': io.out('Hang tight while we grab the latest from your chart repositories...\nUpdate Complete. ⎈Happy Helming!⎈\nSaving 0 charts\nDeleting outdated charts\n'); return { code: 0 };
          case 'test': io.out(`NAME: ${pos[1]}\nPhase: Succeeded\n(Kubester: helm test hooks are not simulated)\n`); return { code: 0 };
          default: io.err(`Error: unknown command "${sub}" for "helm"\nRun 'helm --help' for usage.\n`); return { code: 1 };
        }
      } catch (e) {
        io.err('Error: ' + e.message + '\n');
        return { code: 1 };
      }
    }
    repo(args, flags, io) {
      const repos = this.c.rt.helmRepos;
      if (args[0] === 'add') {
        const [_, name, url] = args;
        if (!name || !url) { io.err('Error: "helm repo add" requires 2 arguments\n'); return { code: 1 }; }
        if (repos[name] && repos[name] === url) { io.out(`"${name}" already exists with the same configuration, skipping\n`); return { code: 0 }; }
        const known = Object.keys(REPOS).find(k => REPOS[k].replace(/\/$/, '') === url.replace(/\/$/, ''));
        if (!known) { io.err(`Error: looks like "${url}" is not a valid chart repository or cannot be reached: failed to fetch ${url}/index.yaml : 404 Not Found\n(Kubester knows: ${Object.values(REPOS).join(', ')})\n`); return { code: 1 }; }
        repos[name] = url;
        io.out(`"${name}" has been added to your repositories\n`);
        return { code: 0 };
      }
      if (args[0] === 'list' || args[0] === 'ls') { U.table(['NAME', 'URL'], Object.entries(repos)).forEach(l => io.out(l + '\n')); return { code: 0 }; }
      if (args[0] === 'update' || args[0] === 'up') { io.out('Hang tight while we grab the latest from your chart repositories...\n'); Object.keys(repos).forEach(r => io.out(`...Successfully got an update from the "${r}" chart repository\n`)); io.out('Update Complete. ⎈Happy Helming!⎈\n'); return { code: 0 }; }
      if (args[0] === 'remove' || args[0] === 'rm') { delete repos[args[1]]; io.out(`"${args[1]}" has been removed from your repositories\n`); return { code: 0 }; }
      io.err('Error: unknown repo command. Try: helm repo add|list|update|remove\n'); return { code: 1 };
    }
    resolveChart(ref) {
      if (!ref) return { error: 'Error: must either provide a name or specify --generate-name' };
      if (ref.startsWith('./') || ref.startsWith('/') || ref.startsWith('~') || !ref.includes('/')) {
        const path = R.normPath(ref.replace(/^~/, KS.HOME), this.k.env.cwd());
        const fs = this.k.env.fs;
        if (fs.read(path + '/Chart.yaml') == null) return { error: `Error: INSTALLATION FAILED: repo ${ref.split('/')[0]} not found` };
        let vals = {};
        try { vals = G.jsyaml.load(fs.read(path + '/values.yaml') || '') || {}; } catch (e) { return { error: 'Error: failed to parse values.yaml: ' + e.message }; }
        const name = ref.replace(/\/$/, '').split('/').pop();
        const base = CHARTS['bitnami/nginx'];
        return { chart: Object.assign({}, base, { name, version: '0.1.0', appVersion: '1.16.0', values: vals, render: (rel, v) => base.render(rel, { replicaCount: v.replicaCount || 1, image: { repository: (v.image || {}).repository || 'nginx', tag: (v.image || {}).tag || '1.27' }, service: { type: (v.service || {}).type || 'ClusterIP', ports: { http: (v.service || {}).port || 80 } } }, { name, version: '0.1.0' }).map(d => { d.metadata.name = rel.name.includes(name) ? rel.name : `${rel.name}-${name}`; return d; }), notes: () => '1. Get the application URL by running these commands:\n  kubectl port-forward svc/' + (rel => rel)(name) + ' 8080:80' }), key: ref };
      }
      const [repo] = ref.split('/');
      if (!this.c.rt.helmRepos[repo]) return { error: `Error: INSTALLATION FAILED: repo ${repo} not found` };
      const repoUrl = this.c.rt.helmRepos[repo];
      const canonical = Object.keys(REPOS).find(k => REPOS[k] === repoUrl);
      const key = canonical + '/' + ref.split('/')[1];
      if (!CHARTS[key]) return { error: `Error: INSTALLATION FAILED: chart "${ref.split('/')[1]}" matching  not found in ${repo} index. (try 'helm repo update'): no chart name found` };
      return { chart: CHARTS[key], key: ref };
    }
    values(chart, flags, prev) {
      const v = U.clone(prev || chart.values);
      for (const f of flags.values || []) {
        const content = this.k.env.fs.read(R.normPath(String(f).replace(/^~/, KS.HOME), this.k.env.cwd()));
        if (content == null) throw new Error(`open ${f}: no such file or directory`);
        const parsed = G.jsyaml.load(content) || {};
        Object.assign(v, U.mergePatch(v, parsed));
      }
      for (const s of (flags.set || []).concat(flags['set-string'] || [])) {
        String(s).split(',').forEach(kv => { const i = kv.indexOf('='); if (i > 0) setPath(v, kv.slice(0, i), parseSetValue(kv.slice(i + 1))); });
      }
      return v;
    }
    releases(ns) {
      const all = this.c.list('Secret', ns).filter(s => (s.metadata.labels || {}).owner === 'helm');
      const by = {};
      for (const s of all) {
        let rel;
        try { rel = JSON.parse(U.b64decode(s.data.release)); } catch (e) { continue; }
        (by[rel.name] = by[rel.name] || []).push(Object.assign(rel, { secret: s.metadata.name }));
      }
      Object.values(by).forEach(l => l.sort((a, b) => a.version - b.version));
      return by;
    }
    saveRelease(rel) {
      const name = `sh.helm.release.v1.${rel.name}.v${rel.version}`;
      const obj = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: rel.namespace, labels: { name: rel.name, owner: 'helm', status: rel.info.status, version: String(rel.version) } }, type: 'helm.sh/release.v1', data: { release: U.b64encode(JSON.stringify(rel)) } };
      const ex = this.c.get('Secret', rel.namespace, name);
      if (ex) { ex.metadata.labels.status = rel.info.status; ex.data = obj.data; this.c.put(ex); } else this.c.createInternal(obj);
    }
    applyManifests(rel, docs, prevDocs) {
      const made = [];
      for (const d0 of docs) {
        const d = U.clone(d0);
        const r = KS.BY_KIND[d.kind];
        if (r.namespaced) d.metadata.namespace = rel.namespace;
        const cur = this.c.get(d.kind, d.metadata.namespace, d.metadata.name);
        if (cur) {
          const owner = (cur.metadata.annotations || {})['meta.helm.sh/release-name'];
          if (owner !== rel.name) throw new Error(`INSTALLATION FAILED: Unable to continue with install: ${d.kind} "${d.metadata.name}" in namespace "${rel.namespace}" exists and cannot be imported into the current release: invalid ownership metadata; annotation validation error: missing key "meta.helm.sh/release-name": must be set to "${rel.name}"`);
          const next = this.k.mergeApply(cur, d, JSON.stringify(d));
          const res = this.c.update(next, {});
          if (!res.ok) throw new Error('UPGRADE FAILED: ' + res.error);
        } else {
          const res = this.c.create(d, { namespace: rel.namespace });
          if (!res.ok) throw new Error('INSTALLATION FAILED: ' + res.error);
        }
        made.push(d);
      }
      for (const old of prevDocs || []) {
        if (!docs.some(d => d.kind === old.kind && d.metadata.name === old.metadata.name)) this.c.delete(old.kind, rel.namespace, old.metadata.name, {});
      }
      return made;
    }
    printRelease(rel, io, chart) {
      io.out(`NAME: ${rel.name}\nLAST DEPLOYED: ${KS.runtime.dateStr(this.c.now).replace(' UTC', '')}\nNAMESPACE: ${rel.namespace}\nSTATUS: ${rel.info.status}\nREVISION: ${rel.version}\nTEST SUITE: None\n`);
      if (chart && chart.notes) io.out(`NOTES:\n${chart.notes(rel, rel.config)}\n`);
    }
    install(name, chartRef, flags, io, ns, upgrade) {
      if (flags['generate-name'] && !upgrade) { chartRef = name; name = `${(chartRef || '').split('/').pop()}-${Math.floor(this.c.now / 1000)}`; }
      if (!name || !chartRef) { io.err(`Error: "helm ${upgrade ? 'upgrade' : 'install'}" requires 2 arguments\n\nUsage:  helm ${upgrade ? 'upgrade [RELEASE] [CHART]' : 'install [NAME] [CHART]'} [flags]\n`); return { code: 1 }; }
      if (!U.validName(name)) { io.err(`Error: INSTALLATION FAILED: release name "${name}": invalid release name, must match regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$ and the length must not be longer than 53\n`); return { code: 1 }; }
      const rc = this.resolveChart(chartRef);
      if (rc.error) { io.err((upgrade ? rc.error.replace('INSTALLATION', 'UPGRADE') : rc.error) + '\n'); return { code: 1 }; }
      const chart = rc.chart;
      if (!this.c.get('Namespace', '', ns)) {
        if (flags['create-namespace']) this.c.createInternal({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
        else { io.err(`Error: INSTALLATION FAILED: create: failed to create: namespaces "${ns}" not found\n`); return { code: 1 }; }
      }
      const hist = this.releases(ns)[name] || [];
      const lastRel = hist[hist.length - 1];
      if (upgrade && !lastRel && !flags.install) { io.err(`Error: UPGRADE FAILED: "${name}" has no deployed releases\n`); return { code: 1 }; }
      if (!upgrade && lastRel && lastRel.info.status !== 'uninstalled') { io.err('Error: INSTALLATION FAILED: cannot re-use a name that is still in use\n'); return { code: 1 }; }
      if (lastRel && /^pending-/.test(lastRel.info.status)) { io.err('Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress\n'); return { code: 1 }; }
      let v;
      try { v = this.values(chart, flags, flags['reuse-values'] && lastRel ? lastRel.config : null); } catch (e) { io.err('Error: ' + e.message + '\n'); return { code: 1 }; }
      const isUpgrade = upgrade && lastRel && lastRel.info.status !== 'uninstalled';
      const rel = { name, namespace: ns, version: isUpgrade ? lastRel.version + 1 : (lastRel ? lastRel.version + 1 : 1), chart: { name: chart.name, version: chart.version, appVersion: chart.appVersion }, config: v, info: { status: 'deployed', first_deployed: lastRel ? lastRel.info.first_deployed : this.c.ts(), last_deployed: this.c.ts(), description: isUpgrade ? 'Upgrade complete' : 'Install complete' } };
      if (flags['dry-run']) { io.out(`NAME: ${name}\nSTATUS: pending-install\nREVISION: ${rel.version}\nHOOKS:\nMANIFEST:\n`); chart.render(rel, v, chart).forEach(d => io.out('---\n' + KS.toYaml(d))); return { code: 0 }; }
      try {
        let docs = chart.render(rel, v, chart);
        if (chart.special === 'ingress-nginx') this.c.installIngressNginx(ns);
        rel.manifest = docs;
        this.applyManifests(rel, docs, isUpgrade ? lastRel.manifest : null);
      } catch (e) {
        rel.info.status = 'failed';
        rel.info.description = e.message;
        this.saveRelease(rel);
        if (flags.atomic && isUpgrade) { io.err(`Error: ${e.message}\n... rolling back (--atomic)\n`); this.rollback(name, String(lastRel.version), {}, { out() {}, err() {} }, ns); return { code: 1 }; }
        io.err('Error: ' + e.message + '\n');
        return { code: 1 };
      }
      if (isUpgrade) { lastRel.info.status = 'superseded'; this.saveRelease(lastRel); }
      this.saveRelease(rel);
      this.c.narrate('⎈', `Helm ${isUpgrade ? 'upgraded' : 'installed'} release ${name} (chart ${chart.name}-${chart.version}, revision ${rel.version}): it rendered the chart's templates with your values and applied ${rel.manifest.length} objects.`, 'good');
      if (isUpgrade) io.out(`Release "${name}" has been upgraded. Happy Helming!\n`);
      this.printRelease(rel, io, chart);
      return { code: 0 };
    }
    template(name, chartRef, flags, io, ns) {
      const rc = this.resolveChart(chartRef);
      if (rc.error) { io.err(rc.error.replace('INSTALLATION FAILED: ', '') + '\n'); return { code: 1 }; }
      let v;
      try { v = this.values(rc.chart, flags); } catch (e) { io.err('Error: ' + e.message + '\n'); return { code: 1 }; }
      const rel = { name, namespace: ns };
      rc.chart.render(rel, v, rc.chart).forEach(d => io.out(`---\n# Source: ${rc.chart.name}/templates/${d.kind.toLowerCase()}.yaml\n${KS.toYaml(d)}`));
      return { code: 0 };
    }
    list(flags, io, ns) {
      const all = flags['all-namespaces'];
      const nss = all ? this.c.list('Namespace').map(n => n.metadata.name) : [ns];
      const rows = [];
      nss.forEach(n => Object.values(this.releases(n)).forEach(h => {
        const r = h[h.length - 1];
        if (r.info.status === 'uninstalled' && !flags.all) return;
        if (r.info.status === 'superseded') return;
        rows.push([r.name, r.namespace, r.version, KS.runtime.dateStr(Date.parse(r.info.last_deployed)).replace(' UTC', ' +0000 UTC'), r.info.status, `${r.chart.name}-${r.chart.version}`, r.chart.appVersion]);
      }));
      U.table(['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'], rows).forEach(l => io.out(l + '\n'));
      return { code: 0 };
    }
    history(name, flags, io, ns) {
      const h = this.releases(ns)[name];
      if (!h) { io.err('Error: release: not found\n'); return { code: 1 }; }
      U.table(['REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], h.map(r => [r.version, KS.runtime.dateStr(Date.parse(r.info.last_deployed)), r.info.status, `${r.chart.name}-${r.chart.version}`, r.chart.appVersion, r.info.description])).forEach(l => io.out(l + '\n'));
      return { code: 0 };
    }
    status(name, flags, io, ns) {
      const h = this.releases(ns)[name];
      if (!h) { io.err('Error: release: not found\n'); return { code: 1 }; }
      const r = h[h.length - 1];
      this.printRelease(r, io, null);
      return { code: 0 };
    }
    rollback(name, revArg, flags, io, ns) {
      const h = this.releases(ns)[name];
      if (!h) { io.err('Error: release: not found\n'); return { code: 1 }; }
      const cur = h[h.length - 1];
      let target;
      if (revArg) target = h.find(r => r.version === +revArg);
      else target = h.slice(0, -1).reverse().find(r => ['deployed', 'superseded'].includes(r.info.status));
      if (!target) { io.err(`Error: release has no ${revArg || 'previous'} version\n`); return { code: 1 }; }
      const rel = { name, namespace: ns, version: cur.version + 1, chart: target.chart, config: target.config, manifest: target.manifest, info: { status: 'deployed', first_deployed: cur.info.first_deployed, last_deployed: this.c.ts(), description: `Rollback to ${target.version}` } };
      try { this.applyManifests(rel, target.manifest || [], cur.manifest); } catch (e) { io.err('Error: ' + e.message + '\n'); return { code: 1 }; }
      h.forEach(r => { if (r.info.status === 'deployed' || /^pending-/.test(r.info.status)) { r.info.status = /^pending-/.test(r.info.status) ? 'failed' : 'superseded'; this.saveRelease(r); } });
      this.saveRelease(rel);
      io.out('Rollback was a success! Happy Helming!\n');
      this.c.narrate('⎈', `Helm rolled ${name} back to revision ${target.version} by creating a NEW revision ${rel.version} with the old manifests.`, 'good');
      return { code: 0 };
    }
    uninstall(name, flags, io, ns) {
      const h = this.releases(ns)[name];
      if (!h || h[h.length - 1].info.status === 'uninstalled') { io.err(`Error: uninstall: Release not loaded: ${name}: release: not found\n`); return { code: 1 }; }
      const cur = h[h.length - 1];
      (cur.manifest || []).forEach(d => this.c.delete(d.kind, ns, d.metadata.name, {}));
      if (flags['keep-history']) { cur.info.status = 'uninstalled'; cur.info.description = 'Deletion complete'; this.saveRelease(cur); }
      else h.forEach(r => { const s = this.c.get('Secret', ns, r.secret); if (s) this.c.remove(s); });
      io.out(`release "${name}" uninstalled\n`);
      return { code: 0 };
    }
    get(what, name, flags, io, ns) {
      const h = this.releases(ns)[name];
      if (!h) { io.err('Error: release: not found\n'); return { code: 1 }; }
      const r = h[h.length - 1];
      if (what === 'values') { io.out('USER-SUPPLIED VALUES:\n'); const d = diffValues(this.resolveChart(r.chart.name === 'webapp' ? 'kubester/webapp' : r.chart.name === 'nginx' ? 'bitnami/nginx' : r.chart.name === 'redis' ? 'bitnami/redis' : 'ingress-nginx/ingress-nginx').chart, r.config, flags.all); io.out(Object.keys(d).length ? KS.toYaml(d) : 'null\n'); return { code: 0 }; }
      if (what === 'manifest') { (r.manifest || []).forEach(d => io.out('---\n' + KS.toYaml(Object.assign({}, d, { metadata: Object.assign({}, d.metadata, { namespace: undefined }) })))); return { code: 0 }; }
      if (what === 'notes') { io.out('NOTES:\n(see helm status)\n'); return { code: 0 }; }
      io.err('Error: helm get supports: values, manifest, notes\n');
      return { code: 1 };
    }
    show(what, ref, io) {
      const rc = this.resolveChart(ref);
      if (rc.error) { io.err(rc.error.replace('INSTALLATION FAILED: ', '') + '\n'); return { code: 1 }; }
      if (what === 'values') { io.out(KS.toYaml(rc.chart.values)); return { code: 0 }; }
      if (what === 'chart') { io.out(`apiVersion: v2\nappVersion: ${rc.chart.appVersion}\ndescription: ${rc.chart.description}\nname: ${rc.chart.name}\nversion: ${rc.chart.version}\n`); return { code: 0 }; }
      io.err('Error: helm show supports: values, chart\n');
      return { code: 1 };
    }
    search(args, flags, io) {
      if (args[0] !== 'repo') { io.err('(Kubester) usage: helm search repo <keyword>\n'); return { code: 1 }; }
      const kw = (args[1] || '').toLowerCase();
      const rows = [];
      for (const [repo, url] of Object.entries(this.c.rt.helmRepos)) {
        const canonical = Object.keys(REPOS).find(k => REPOS[k] === url);
        Object.keys(CHARTS).filter(k => k.startsWith(canonical + '/')).forEach(k => {
          const ch = CHARTS[k];
          const nm = `${repo}/${k.split('/')[1]}`;
          if (!kw || nm.includes(kw) || ch.description.toLowerCase().includes(kw)) rows.push([nm, ch.version, ch.appVersion, ch.description.slice(0, 60)]);
        });
      }
      if (!rows.length) { io.out('No results found\n'); return { code: 0 }; }
      U.table(['NAME', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], rows).forEach(l => io.out(l + '\n'));
      return { code: 0 };
    }
  }
  function diffValues(chart, v, all) {
    if (all || !chart) return v;
    const out = {};
    const walk = (a, b, o) => { Object.keys(b || {}).forEach(k => { if (U.isObj(b[k]) && U.isObj(a && a[k])) { const sub = {}; walk(a[k], b[k], sub); if (Object.keys(sub).length) o[k] = sub; } else if (JSON.stringify(a && a[k]) !== JSON.stringify(b[k])) o[k] = b[k]; }); };
    walk(chart.values, v, out);
    return out;
  }
  const HELM_HELP = `The Kubernetes package manager

Common actions for Helm:
- helm search:    search for charts
- helm install:   install a chart
- helm upgrade:   upgrade a release
- helm rollback:  roll back a release to a previous revision
- helm uninstall: uninstall a release
- helm list:      list releases
- helm history:   fetch release history
- helm template:  render chart templates locally and display the output
- helm repo:      add, list, remove, update chart repositories

Kubester repos you can add: bitnami ${REPOS.bitnami} , ingress-nginx ${REPOS['ingress-nginx']} (kubester is pre-added)
`;

  // ------------------------------------------------------------------ Kustomize
  function kustomize(kubectl, dir, depth) {
    depth = depth || 0;
    if (depth > 5) return { error: 'error: kustomization nesting too deep' };
    const fs = kubectl.env.fs;
    const base = R.normPath(dir.replace(/^~/, KS.HOME), kubectl.env.cwd());
    const kfName = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'].find(n => fs.read(base + '/' + n) != null);
    if (!kfName) return { error: `error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${base}'` };
    let k;
    try { k = G.jsyaml.load(fs.read(base + '/' + kfName)) || {}; } catch (e) { return { error: `error: invalid Kustomization: ${e.message}` }; }
    let docs = [];
    for (const r of (k.resources || []).concat(k.bases || [])) {
      const p = R.normPath(r, base);
      if (fs.read(p) != null) {
        const pd = KS.parseDocs(fs.read(p), r);
        if (pd.error) return pd;
        docs.push(...pd.docs);
      } else if (fs.isDir(p)) {
        const sub = kustomize(kubectl, p, depth + 1);
        if (sub.error) return sub;
        docs.push(...sub.docs);
      } else return { error: `error: accumulating resources: accumulation err='accumulating resources from '${r}': open ${p}: no such file or directory'` };
    }
    docs = docs.map(d => U.clone(d));
    const renames = {};
    const gen = (list, kind) => (list || []).forEach(g => {
      const data = {};
      (g.literals || []).forEach(l => { const i = l.indexOf('='); data[l.slice(0, i)] = l.slice(i + 1); });
      (g.files || []).forEach(f => { const i = f.indexOf('='); const key = i > 0 ? f.slice(0, i) : f.split('/').pop(); const c = fs.read(R.normPath(i > 0 ? f.slice(i + 1) : f, base)); data[key] = c == null ? '' : c; });
      const hash = U.hashString(JSON.stringify(data) + kind);
      const name = g.name + ((g.options && g.options.disableNameSuffixHash) || (k.generatorOptions && k.generatorOptions.disableNameSuffixHash) ? '' : '-' + hash);
      renames[kind + '/' + g.name] = name;
      const o = { apiVersion: 'v1', kind, metadata: { name } };
      if (kind === 'Secret') { o.type = 'Opaque'; o.data = {}; Object.entries(data).forEach(([a, b]) => (o.data[a] = U.b64encode(b))); } else o.data = data;
      docs.push(o);
    });
    gen(k.configMapGenerator, 'ConfigMap');
    gen(k.secretGenerator, 'Secret');
    // patches
    const patches = (k.patches || []).concat((k.patchesStrategicMerge || []).map(p => ({ path: p })));
    for (const p of patches) {
      let patchDocs;
      if (p.path) { const c = fs.read(R.normPath(p.path, base)); if (c == null) return { error: `error: open ${p.path}: no such file or directory` }; patchDocs = KS.parseDocs(c, p.path).docs || []; }
      else if (p.patch) { try { const y = G.jsyaml.load(p.patch); patchDocs = Array.isArray(y) ? [{ __json: y }] : [y]; } catch (e) { return { error: 'error: invalid patch: ' + e.message }; } }
      for (const pd of patchDocs) {
        const t = p.target || { kind: pd.kind, name: pd.metadata && pd.metadata.name };
        const hits = docs.filter(d => (!t.kind || d.kind === t.kind) && (!t.name || d.metadata.name === t.name));
        if (!hits.length) return { error: `error: no matches for Id ${t.kind}.${t.name}; failed to find unique target for patch` };
        hits.forEach(d => {
          const merged = pd.__json ? U.jsonPatch(d, pd.__json) : strategic(d, pd);
          Object.keys(d).forEach(x => delete d[x]);
          Object.assign(d, merged);
        });
      }
    }
    // images / replicas
    for (const im of k.images || []) {
      docs.forEach(d => {
        const spec = d.kind === 'Pod' ? d.spec : d.spec && d.spec.template && d.spec.template.spec;
        if (!spec) return;
        (spec.containers || []).concat(spec.initContainers || []).forEach(c => {
          const p = R.parseRef(c.image);
          if (p.repo === im.name || c.image.split(':')[0] === im.name) c.image = `${im.newName || c.image.split(':')[0]}:${im.newTag || p.tag}`;
        });
      });
    }
    for (const rp of k.replicas || []) docs.filter(d => d.metadata.name === rp.name && d.spec && 'replicas' in Object.assign({ replicas: 1 }, d.spec)).forEach(d => (d.spec.replicas = rp.count));
    // names, namespace, labels
    const pre = k.namePrefix || '', suf = k.nameSuffix || '';
    const labels = Object.assign({}, k.commonLabels || {});
    (k.labels || []).forEach(l => Object.assign(labels, l.pairs || {}));
    const selLabels = Object.assign({}, k.commonLabels || {});
    (k.labels || []).filter(l => l.includeSelectors).forEach(l => Object.assign(selLabels, l.pairs || {}));
    const nameMap = {};
    docs.forEach(d => {
      const old = d.metadata.name;
      if (d.kind !== 'Namespace') d.metadata.name = pre + d.metadata.name + suf;
      nameMap[d.kind + '/' + old] = d.metadata.name;
      if (k.namespace && KS.BY_KIND[d.kind] && KS.BY_KIND[d.kind].namespaced) d.metadata.namespace = k.namespace;
      if (Object.keys(labels).length) d.metadata.labels = Object.assign({}, d.metadata.labels, labels);
      if (k.commonAnnotations) d.metadata.annotations = Object.assign({}, d.metadata.annotations, k.commonAnnotations);
      if (Object.keys(selLabels).length && d.spec) {
        if (d.spec.selector && d.spec.selector.matchLabels) d.spec.selector.matchLabels = Object.assign({}, d.spec.selector.matchLabels, selLabels);
        else if (d.kind === 'Service' && d.spec.selector) d.spec.selector = Object.assign({}, d.spec.selector, selLabels);
        if (d.spec.template && d.spec.template.metadata) d.spec.template.metadata.labels = Object.assign({}, d.spec.template.metadata.labels, selLabels);
      }
    });
    Object.entries(renames).forEach(([key, val]) => (nameMap[key] = pre + val + suf));
    // fix references to renamed ConfigMaps/Secrets
    const ref = (kind, n) => nameMap[kind + '/' + n] || n;
    docs.forEach(d => {
      const spec = d.kind === 'Pod' ? d.spec : d.spec && d.spec.template && d.spec.template.spec;
      if (!spec) return;
      (spec.volumes || []).forEach(v => { if (v.configMap) v.configMap.name = ref('ConfigMap', v.configMap.name); if (v.secret) v.secret.secretName = ref('Secret', v.secret.secretName); if (v.persistentVolumeClaim) v.persistentVolumeClaim.claimName = ref('PersistentVolumeClaim', v.persistentVolumeClaim.claimName); });
      (spec.containers || []).concat(spec.initContainers || []).forEach(c => {
        (c.envFrom || []).forEach(e => { if (e.configMapRef) e.configMapRef.name = ref('ConfigMap', e.configMapRef.name); if (e.secretRef) e.secretRef.name = ref('Secret', e.secretRef.name); });
        (c.env || []).forEach(e => { const vf = e.valueFrom || {}; if (vf.configMapKeyRef) vf.configMapKeyRef.name = ref('ConfigMap', vf.configMapKeyRef.name); if (vf.secretKeyRef) vf.secretKeyRef.name = ref('Secret', vf.secretKeyRef.name); });
      });
    });
    const order = ['Namespace', 'ResourceQuota', 'LimitRange', 'ServiceAccount', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'ConfigMap', 'Secret', 'Service', 'PersistentVolumeClaim', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Ingress'];
    docs.sort((a, b) => (order.indexOf(a.kind) + 100) % 100 - (order.indexOf(b.kind) + 100) % 100 || a.metadata.name.localeCompare(b.metadata.name));
    return { docs };
  }
  function strategic(t, p) {
    if (Array.isArray(p) || !U.isObj(p)) return U.clone(p);
    const out = U.isObj(t) ? U.clone(t) : {};
    for (const k of Object.keys(p)) {
      if (p[k] === null) { delete out[k]; continue; }
      if (Array.isArray(p[k]) && Array.isArray(out[k]) && p[k].every(x => U.isObj(x) && x.name)) {
        const arr = out[k].map(x => U.clone(x));
        p[k].forEach(item => { const i = arr.findIndex(x => x.name === item.name); if (i >= 0) arr[i] = strategic(arr[i], item); else arr.push(U.clone(item)); });
        out[k] = arr;
      } else out[k] = strategic(out[k], p[k]);
    }
    return out;
  }

  // ------------------------------------------------------------------ well-known URLs
  KS.REMOTE_MANIFESTS = {
    'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml': '# ingress-nginx',
    'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/cloud/deploy.yaml': '# ingress-nginx',
    'https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml': '# ingress-nginx',
    'https://k8s.io/examples/pods/simple-pod.yaml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: nginx\nspec:\n  containers:\n  - name: nginx\n    image: nginx:1.14.2\n    ports:\n    - containerPort: 80\n',
    'https://k8s.io/examples/application/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: nginx-deployment\nspec:\n  selector:\n    matchLabels:\n      app: nginx\n  replicas: 2 # tells deployment to run 2 pods matching the template\n  template:\n    metadata:\n      labels:\n        app: nginx\n    spec:\n      containers:\n      - name: nginx\n        image: nginx:1.14.2\n        ports:\n        - containerPort: 80\n',
    'https://k8s.io/examples/pods/probe/exec-liveness.yaml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  labels:\n    test: liveness\n  name: liveness-exec\nspec:\n  containers:\n  - name: liveness\n    image: registry.k8s.io/busybox:1.27.2\n    args:\n    - /bin/sh\n    - -c\n    - touch /tmp/healthy; sleep 30; rm -f /tmp/healthy; sleep 600\n    livenessProbe:\n      exec:\n        command:\n        - cat\n        - /tmp/healthy\n      initialDelaySeconds: 5\n      periodSeconds: 5\n',
    'https://k8s.io/examples/controllers/job.yaml': 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: pi\nspec:\n  template:\n    spec:\n      containers:\n      - name: pi\n        image: perl:5.34.0\n        command: ["perl",  "-Mbignum=bpi", "-wle", "print bpi(2000)"]\n      restartPolicy: Never\n  backoffLimit: 4\n',
  };
  KS.REMOTE_MANIFESTS['https://kubernetes.io/examples/pods/simple-pod.yaml'] = KS.REMOTE_MANIFESTS['https://k8s.io/examples/pods/simple-pod.yaml'];
  KS.REMOTE_MANIFESTS['https://kubernetes.io/examples/application/deployment.yaml'] = KS.REMOTE_MANIFESTS['https://k8s.io/examples/application/deployment.yaml'];

  KS.Helm = Helm;
  KS.kustomize = kustomize;
  KS.HELM_CHARTS = CHARTS;
})(typeof window !== 'undefined' ? window : globalThis);
