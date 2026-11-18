/* Kubester — simulated Kubernetes cluster: object store, admission, RBAC, networking, bootstrap. No DOM. */
(function (G) {
  'use strict';
  const KS = (G.KS = G.KS || {});
  const U = KS.util;
  const R = KS.runtime;

  // ------------------------------------------------------------------ resource registry
  const RESOURCES = [
    // kind, plural, singular, short names, namespaced, apiVersion
    ['Pod', 'pods', 'pod', ['po'], true, 'v1'],
    ['Node', 'nodes', 'node', ['no'], false, 'v1'],
    ['Namespace', 'namespaces', 'namespace', ['ns'], false, 'v1'],
    ['Service', 'services', 'service', ['svc'], true, 'v1'],
    ['Endpoints', 'endpoints', 'endpoints', ['ep'], true, 'v1'],
    ['ConfigMap', 'configmaps', 'configmap', ['cm'], true, 'v1'],
    ['Secret', 'secrets', 'secret', [], true, 'v1'],
    ['ServiceAccount', 'serviceaccounts', 'serviceaccount', ['sa'], true, 'v1'],
    ['PersistentVolume', 'persistentvolumes', 'persistentvolume', ['pv'], false, 'v1'],
    ['PersistentVolumeClaim', 'persistentvolumeclaims', 'persistentvolumeclaim', ['pvc'], true, 'v1'],
    ['Event', 'events', 'event', ['ev'], true, 'v1'],
    ['ResourceQuota', 'resourcequotas', 'resourcequota', ['quota'], true, 'v1'],
    ['LimitRange', 'limitranges', 'limitrange', ['limits'], true, 'v1'],
    ['Deployment', 'deployments', 'deployment', ['deploy'], true, 'apps/v1'],
    ['ReplicaSet', 'replicasets', 'replicaset', ['rs'], true, 'apps/v1'],
    ['DaemonSet', 'daemonsets', 'daemonset', ['ds'], true, 'apps/v1'],
    ['StatefulSet', 'statefulsets', 'statefulset', ['sts'], true, 'apps/v1'],
    ['Job', 'jobs', 'job', [], true, 'batch/v1'],
    ['CronJob', 'cronjobs', 'cronjob', ['cj'], true, 'batch/v1'],
    ['HorizontalPodAutoscaler', 'horizontalpodautoscalers', 'horizontalpodautoscaler', ['hpa'], true, 'autoscaling/v2'],
    ['Ingress', 'ingresses', 'ingress', ['ing'], true, 'networking.k8s.io/v1'],
    ['IngressClass', 'ingressclasses', 'ingressclass', [], false, 'networking.k8s.io/v1'],
    ['NetworkPolicy', 'networkpolicies', 'networkpolicy', ['netpol'], true, 'networking.k8s.io/v1'],
    ['StorageClass', 'storageclasses', 'storageclass', ['sc'], false, 'storage.k8s.io/v1'],
    ['Role', 'roles', 'role', [], true, 'rbac.authorization.k8s.io/v1'],
    ['RoleBinding', 'rolebindings', 'rolebinding', [], true, 'rbac.authorization.k8s.io/v1'],
    ['ClusterRole', 'clusterroles', 'clusterrole', [], false, 'rbac.authorization.k8s.io/v1'],
    ['ClusterRoleBinding', 'clusterrolebindings', 'clusterrolebinding', [], false, 'rbac.authorization.k8s.io/v1'],
    ['PodDisruptionBudget', 'poddisruptionbudgets', 'poddisruptionbudget', ['pdb'], true, 'policy/v1'],
    ['PriorityClass', 'priorityclasses', 'priorityclass', ['pc'], false, 'scheduling.k8s.io/v1'],
  ].map(([kind, plural, singular, short, namespaced, apiVersion]) => ({
    kind, plural, singular, short, namespaced, apiVersion,
    group: apiVersion.includes('/') ? apiVersion.split('/')[0] : '',
  }));
  const BY_KIND = {};
  RESOURCES.forEach(r => (BY_KIND[r.kind] = r));
  function lookupResource(word) {
    if (!word) return null;
    const w = String(word).toLowerCase();
    const base = w.split('.')[0];
    return RESOURCES.find(r => r.plural === w || r.singular === w || r.short.includes(w) || r.kind.toLowerCase() === w ||
      r.plural + '.' + r.group === w || r.singular + '.' + r.group === w) ||
      RESOURCES.find(r => r.plural === base || r.singular === base) || null;
  }

  const DAY = 86400000;
  const CLUSTER_DOMAIN = 'cluster.local';
  const K8S_VERSION = 'v1.33.1';
  const EXTERNAL_HOSTS = {
    'example.com': { ip: '93.184.215.14', body: '<!doctype html>\n<html>\n<head>\n    <title>Example Domain</title>\n</head>\n<body>\n<div>\n    <h1>Example Domain</h1>\n    <p>This domain is for use in illustrative examples in documents.</p>\n</div>\n</body>\n</html>\n' },
    'kubernetes.io': { ip: '147.75.40.148', body: '<!doctype html><title>Kubernetes</title><h1>Production-Grade Container Orchestration</h1>\n' },
    'google.com': { ip: '142.250.72.14', body: '<HTML><HEAD><meta http-equiv="content-type" content="text/html;charset=utf-8">\n<TITLE>301 Moved</TITLE></HEAD><BODY>\n<H1>301 Moved</H1>\nThe document has moved\n<A HREF="http://www.google.com/">here</A>.\n</BODY></HTML>\n' },
    'www.google.com': { ip: '142.250.72.4', body: '<!doctype html><title>Google</title>\n' },
    'api.github.com': { ip: '140.82.112.6', body: '{\n  "current_user_url": "https://api.github.com/user"\n}\n' },
    'registry-1.docker.io': { ip: '54.236.113.205', body: '{}\n' },
  };

  // ======================================================================== Cluster
  class Cluster {
    constructor(opts) {
      opts = opts || {};
      this.seed = opts.seed || 7;
      this.rng = U.makeRng(this.seed);
      this.startTime = opts.startTime || Date.now();
      this.now = this.startTime - 2 * DAY;
      this.objs = {};
      RESOURCES.forEach(r => (this.objs[r.kind] = new Map()));
      this.rv = 1000;
      this.listeners = {};
      this.rt = { pods: {}, pvData: {}, nodes: {}, imageCache: {}, ipNext: {}, lbNext: 11, loads: {}, hpaHistory: {}, forwards: [], rr: {}, schedRetry: {}, failedCreate: {}, cronLast: {} };
      this.users = { current: { name: 'kubernetes-admin', groups: ['system:masters', 'system:authenticated'] } };
      this.context = { name: 'kubernetes-admin@kubester', cluster: 'kubester', user: 'kubernetes-admin', namespace: 'default' };
      this.version = K8S_VERSION;
      this.paused = false;
      this.quiet = true; // no narration / animation during bootstrap
      this.bootstrap();
      this.advance(90000, 500);
      this.now = this.startTime;
      // drop bootstrap events (real events expire after 1h)
      this.objs.Event.clear();
      this.quiet = false;
    }

    // ------------------------------------------------------------ events bus
    on(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); return () => this.off(type, fn); }
    off(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
    emit(type, data) {
      if (this.quiet && type !== 'change') return;
      (this.listeners[type] || []).forEach(fn => { try { fn(data); } catch (e) { if (typeof console !== 'undefined') console.error(e); } });
    }
    narrate(icon, text, level) { this.emit('narrate', { icon, text, level: level || 'info', at: this.now }); }

    // ------------------------------------------------------------ store
    key(ns, name) { return (ns || '') + '/' + name; }
    res(kind) { return BY_KIND[kind]; }
    get(kind, ns, name) {
      const r = BY_KIND[kind];
      if (!r) return null;
      return this.objs[kind].get(this.key(r.namespaced ? ns : '', name)) || null;
    }
    list(kind, ns) {
      const r = BY_KIND[kind];
      const all = [...this.objs[kind].values()];
      const out = r.namespaced && ns ? all.filter(o => o.metadata.namespace === ns) : all;
      return out.sort((a, b) => (a.metadata.namespace || '').localeCompare(b.metadata.namespace || '') || a.metadata.name.localeCompare(b.metadata.name));
    }
    // unsorted listing for controllers (hot path)
    ls(kind, ns) {
      const all = [...this.objs[kind].values()];
      return ns && BY_KIND[kind].namespaced ? all.filter(o => o.metadata.namespace === ns) : all;
    }
    put(obj) {
      const r = BY_KIND[obj.kind];
      if (obj.kind === 'Pod') this._podIdx = null;
      obj.metadata.resourceVersion = String(++this.rv);
      this.objs[obj.kind].set(this.key(r.namespaced ? obj.metadata.namespace : '', obj.metadata.name), obj);
      this.dirty = true;
      return obj;
    }
    remove(obj) {
      const r = BY_KIND[obj.kind];
      if (obj.kind === 'Pod') this._podIdx = null;
      this.objs[obj.kind].delete(this.key(r.namespaced ? obj.metadata.namespace : '', obj.metadata.name));
      if (obj.kind === 'Pod') this.podGone(obj);
      this.dirty = true;
    }
    byUid(uid) {
      for (const kind of Object.keys(this.objs)) for (const o of this.objs[kind].values()) if (o.metadata.uid === uid) return o;
      return null;
    }
    newUid() { return U.uuid(this.rng); }
    suffix(n) { return U.randSuffix(this.rng, n || 5); }
    ts(ms) { return U.iso(ms == null ? this.now : ms); }
    age(o) { return U.humanDuration(this.now - Date.parse(o.metadata.creationTimestamp)); }

    // ------------------------------------------------------------ events (k8s Event objects)
    event(obj, type, reason, message, source) {
      if (!obj || !obj.metadata) return;
      const ns = obj.metadata.namespace || 'default';
      const involved = { kind: obj.kind, namespace: obj.metadata.namespace, name: obj.metadata.name, uid: obj.metadata.uid };
      // de-duplicate like the real event recorder
      for (const e of this.objs.Event.values()) {
        if (e.involvedObject.uid === involved.uid && e.reason === reason && e.message === message) {
          e.count = (e.count || 1) + 1;
          e.lastTimestamp = this.ts();
          e.metadata.resourceVersion = String(++this.rv);
          this.dirty = true;
          return e;
        }
      }
      const name = `${obj.metadata.name}.${(this.now * 1000 + Math.floor(this.rng() * 1000)).toString(16).slice(-16)}`;
      const ev = {
        apiVersion: 'v1', kind: 'Event',
        metadata: { name, namespace: ns, uid: this.newUid(), creationTimestamp: this.ts() },
        involvedObject: involved, type, reason, message,
        source: { component: source || 'kubelet' }, count: 1,
        firstTimestamp: this.ts(), lastTimestamp: this.ts(), reportingComponent: source || 'kubelet',
      };
      this.put(ev);
      this.emit('k8sevent', ev);
      return ev;
    }
    eventsFor(obj) {
      return [...this.objs.Event.values()].filter(e => e.involvedObject.uid === obj.metadata.uid)
        .sort((a, b) => Date.parse(a.lastTimestamp) - Date.parse(b.lastTimestamp));
    }

    // ------------------------------------------------------------ time
    tick(dt) {
      if (dt <= 0) return;
      this.now += dt;
      this.runControllers(dt);
      if (this.dirty) { this.dirty = false; this.emit('change', {}); }
    }
    advance(ms, step) {
      step = step || 100;
      let left = ms;
      while (left > 0) {
        const d = Math.min(step, left);
        this.tick(d);
        left -= d;
      }
    }
    fastForward(ms) {
      // bigger steps for long skips, but small enough for probe/backoff precision
      const step = ms > 600000 ? 1000 : 250;
      this.advance(ms, step);
    }

    // ------------------------------------------------------------ bootstrap
    bootstrap() {
      const mkNs = name => this.createInternal({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: { 'kubernetes.io/metadata.name': name } }, spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } });
      ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx'].forEach(mkNs);

      const nodes = [
        { name: 'controlplane', ip: '192.168.49.10', zone: 'zone-a', cp: true },
        { name: 'worker-1', ip: '192.168.49.11', zone: 'zone-a' },
        { name: 'worker-2', ip: '192.168.49.12', zone: 'zone-b' },
        { name: 'worker-3', ip: '192.168.49.13', zone: 'zone-c' },
      ];
      nodes.forEach((n, i) => {
        const labels = {
          'beta.kubernetes.io/arch': 'amd64', 'beta.kubernetes.io/os': 'linux',
          'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': n.name, 'kubernetes.io/os': 'linux',
          'topology.kubernetes.io/region': 'region-1', 'topology.kubernetes.io/zone': n.zone,
        };
        if (n.cp) { labels['node-role.kubernetes.io/control-plane'] = ''; labels['node.kubernetes.io/exclude-from-external-load-balancers'] = ''; }
        this.createInternal({
          apiVersion: 'v1', kind: 'Node',
          metadata: { name: n.name, labels, annotations: { 'kubeadm.alpha.kubernetes.io/cri-socket': 'unix:///run/containerd/containerd.sock', 'node.alpha.kubernetes.io/ttl': '0' } },
          spec: { podCIDR: `10.244.${i}.0/24`, podCIDRs: [`10.244.${i}.0/24`], taints: n.cp ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] : undefined },
          status: {
            capacity: { cpu: '2', memory: '4Gi', pods: '110', 'ephemeral-storage': '61202244Ki' },
            allocatable: { cpu: '2', memory: '4Gi', pods: '110', 'ephemeral-storage': '56403987978' },
            addresses: [{ type: 'InternalIP', address: n.ip }, { type: 'Hostname', address: n.name }],
            nodeInfo: { kubeletVersion: K8S_VERSION, kubeProxyVersion: K8S_VERSION, containerRuntimeVersion: 'containerd://1.7.24', osImage: 'Ubuntu 24.04.1 LTS', kernelVersion: '6.8.0-49-generic', operatingSystem: 'linux', architecture: 'amd64' },
            conditions: [],
          },
        });
        this.rt.nodes[n.name] = { up: true, lastHeartbeat: this.now, index: i, diskPressure: false };
        this.rt.ipNext[n.name] = 2;
        this.rt.imageCache[n.name] = new Set();
      });

      // RBAC defaults
      const crs = {
        'cluster-admin': [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['*'] }],
        'admin': [
          { apiGroups: ['', 'apps', 'batch', 'autoscaling', 'networking.k8s.io', 'policy'], resources: ['pods', 'pods/log', 'pods/exec', 'pods/portforward', 'services', 'endpoints', 'configmaps', 'secrets', 'serviceaccounts', 'persistentvolumeclaims', 'events', 'deployments', 'deployments/scale', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'horizontalpodautoscalers', 'ingresses', 'networkpolicies', 'poddisruptionbudgets', 'resourcequotas', 'limitranges'], verbs: ['*'] },
          { apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'rolebindings'], verbs: ['*'] },
        ],
        'edit': [
          { apiGroups: ['', 'apps', 'batch', 'autoscaling', 'networking.k8s.io', 'policy'], resources: ['pods', 'pods/log', 'pods/exec', 'pods/portforward', 'services', 'endpoints', 'configmaps', 'secrets', 'serviceaccounts', 'persistentvolumeclaims', 'events', 'deployments', 'deployments/scale', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'horizontalpodautoscalers', 'ingresses', 'networkpolicies', 'poddisruptionbudgets'], verbs: ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'] },
          { apiGroups: [''], resources: ['resourcequotas', 'limitranges', 'namespaces'], verbs: ['get', 'list', 'watch'] },
        ],
        'view': [
          { apiGroups: ['', 'apps', 'batch', 'autoscaling', 'networking.k8s.io', 'policy'], resources: ['pods', 'pods/log', 'services', 'endpoints', 'configmaps', 'serviceaccounts', 'persistentvolumeclaims', 'events', 'deployments', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'horizontalpodautoscalers', 'ingresses', 'networkpolicies', 'poddisruptionbudgets', 'resourcequotas', 'limitranges', 'namespaces'], verbs: ['get', 'list', 'watch'] },
        ],
      };
      Object.keys(crs).forEach(name => this.createInternal({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name, labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' } }, rules: crs[name] }));
      this.createInternal({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'cluster-admin', labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' } }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:masters' }] });

      // Priority classes
      this.createInternal({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-cluster-critical' }, value: 2000000000, description: 'Used for system critical pods that must run in the cluster, but can be moved to another node if necessary.', preemptionPolicy: 'PreemptLowerPriority' });
      this.createInternal({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-node-critical' }, value: 2000001000, description: 'Used for system critical pods that must not be moved from their current node.', preemptionPolicy: 'PreemptLowerPriority' });

      // Storage
      this.createInternal({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: false });
      this.createInternal({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'fast-ssd' }, provisioner: 'ssd.csi.kubester.io', reclaimPolicy: 'Retain', volumeBindingMode: 'Immediate', allowVolumeExpansion: true, parameters: { type: 'ssd' } });

      // Services
      this.createInternal({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'kubernetes', namespace: 'default', labels: { component: 'apiserver', provider: 'kubernetes' } }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.1', clusterIPs: ['10.96.0.1'], ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 6443 }] } });
      this.createInternal({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'kube-dns', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns', 'kubernetes.io/name': 'CoreDNS' } }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.10', clusterIPs: ['10.96.0.10'], selector: { 'k8s-app': 'kube-dns' }, ports: [{ name: 'dns', port: 53, protocol: 'UDP', targetPort: 53 }, { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 53 }, { name: 'metrics', port: 9153, protocol: 'TCP', targetPort: 9153 }] } });
      this.createInternal({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'metrics-server', namespace: 'kube-system', labels: { 'k8s-app': 'metrics-server' } }, spec: { type: 'ClusterIP', selector: { 'k8s-app': 'metrics-server' }, ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 10250 }] } });

      // Static control-plane pods
      const cpPods = [
        ['etcd', 'registry.k8s.io/etcd:3.5.16-0', '100m', '100Mi'],
        ['kube-apiserver', `registry.k8s.io/kube-apiserver:${K8S_VERSION}`, '250m', null],
        ['kube-controller-manager', `registry.k8s.io/kube-controller-manager:${K8S_VERSION}`, '200m', null],
        ['kube-scheduler', `registry.k8s.io/kube-scheduler:${K8S_VERSION}`, '100m', null],
      ];
      const cpNode = this.get('Node', '', 'controlplane');
      cpPods.forEach(([name, image, cpu, mem]) => {
        const req = { cpu };
        if (mem) req.memory = mem;
        this.createInternal({
          apiVersion: 'v1', kind: 'Pod',
          metadata: { name: `${name}-controlplane`, namespace: 'kube-system', labels: { component: name, tier: 'control-plane' }, annotations: { 'kubernetes.io/config.source': 'file' }, ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: 'controlplane', uid: cpNode.metadata.uid, controller: true }] },
          spec: { nodeName: 'controlplane', hostNetwork: true, priorityClassName: 'system-node-critical', priority: 2000001000, containers: [{ name, image, resources: { requests: req } }], tolerations: [{ operator: 'Exists', effect: 'NoExecute' }] },
        });
      });

      const sysTol = [{ key: 'CriticalAddonsOnly', operator: 'Exists' }, { key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }];
      this.createInternal({
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'coredns', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } },
        spec: {
          replicas: 2, selector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          template: {
            metadata: { labels: { 'k8s-app': 'kube-dns' } },
            spec: {
              priorityClassName: 'system-cluster-critical', tolerations: sysTol, nodeSelector: { 'kubernetes.io/os': 'linux' },
              containers: [{ name: 'coredns', image: 'registry.k8s.io/coredns/coredns:v1.12.0', args: ['-conf', '/etc/coredns/Corefile'], ports: [{ containerPort: 53, name: 'dns', protocol: 'UDP' }, { containerPort: 53, name: 'dns-tcp', protocol: 'TCP' }, { containerPort: 9153, name: 'metrics', protocol: 'TCP' }], resources: { limits: { memory: '170Mi' }, requests: { cpu: '100m', memory: '70Mi' } } }],
            },
          },
        },
      });
      this.createInternal({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'coredns', namespace: 'kube-system' },
        data: { Corefile: '.:53 {\n    errors\n    health {\n       lameduck 5s\n    }\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n       ttl 30\n    }\n    prometheus :9153\n    forward . /etc/resolv.conf {\n       max_concurrent 1000\n    }\n    cache 30\n    loop\n    reload\n    loadbalance\n}\n' },
      });
      this.createInternal({
        apiVersion: 'apps/v1', kind: 'DaemonSet',
        metadata: { name: 'kube-proxy', namespace: 'kube-system', labels: { 'k8s-app': 'kube-proxy' } },
        spec: { selector: { matchLabels: { 'k8s-app': 'kube-proxy' } }, template: { metadata: { labels: { 'k8s-app': 'kube-proxy' } }, spec: { hostNetwork: true, priorityClassName: 'system-node-critical', tolerations: [{ operator: 'Exists' }], containers: [{ name: 'kube-proxy', image: `registry.k8s.io/kube-proxy:${K8S_VERSION}`, command: ['/usr/local/bin/kube-proxy', '--config=/var/lib/kube-proxy/config.conf'] }] } } },
      });
      this.createInternal({
        apiVersion: 'apps/v1', kind: 'DaemonSet',
        metadata: { name: 'kindnet', namespace: 'kube-system', labels: { app: 'kindnet', 'k8s-app': 'kindnet', tier: 'node' } },
        spec: { selector: { matchLabels: { app: 'kindnet' } }, template: { metadata: { labels: { app: 'kindnet', 'k8s-app': 'kindnet', tier: 'node' } }, spec: { hostNetwork: true, tolerations: [{ operator: 'Exists' }], containers: [{ name: 'kindnet-cni', image: 'docker.io/kindest/kindnetd:v20241108-5c6d2daf', resources: { limits: { cpu: '100m', memory: '50Mi' }, requests: { cpu: '100m', memory: '50Mi' } } }] } } },
      });
      this.createInternal({
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'metrics-server', namespace: 'kube-system', labels: { 'k8s-app': 'metrics-server' } },
        spec: { replicas: 1, selector: { matchLabels: { 'k8s-app': 'metrics-server' } }, template: { metadata: { labels: { 'k8s-app': 'metrics-server' } }, spec: { priorityClassName: 'system-cluster-critical', tolerations: sysTol, containers: [{ name: 'metrics-server', image: 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', args: ['--kubelet-insecure-tls'], resources: { requests: { cpu: '100m', memory: '200Mi' } } }] } } },
      });
    }

    // Install ingress-nginx (via `kubectl apply -f <official url>` or `helm install`)
    installIngressNginx(ns) {
      ns = ns || 'ingress-nginx';
      if (!this.get('Namespace', '', ns)) this.createInternal({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: { 'kubernetes.io/metadata.name': ns } }, spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } });
      const made = [];
      const add = o => { const ex = this.get(o.kind, o.metadata.namespace, o.metadata.name); if (!ex) { this.createInternal(o); made.push(`${BY_KIND[o.kind].singular}${BY_KIND[o.kind].group ? '.' + BY_KIND[o.kind].group : ''}/${o.metadata.name} created`); } else made.push(`${BY_KIND[o.kind].singular}${BY_KIND[o.kind].group ? '.' + BY_KIND[o.kind].group : ''}/${o.metadata.name} unchanged`); };
      const labels = { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' };
      add({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'ingress-nginx', namespace: ns } });
      add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'ingress-nginx-controller', namespace: ns }, data: { 'allow-snippet-annotations': 'false' } });
      add({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'ingress-nginx-controller', namespace: ns, labels }, spec: { type: 'LoadBalancer', externalTrafficPolicy: 'Local', selector: labels, ports: [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP', appProtocol: 'http' }, { name: 'https', port: 443, targetPort: 443, protocol: 'TCP', appProtocol: 'https' }] } });
      add({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ingress-nginx-controller', namespace: ns, labels }, spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { serviceAccountName: 'ingress-nginx', containers: [{ name: 'controller', image: 'registry.k8s.io/ingress-nginx/controller:v1.11.2', args: ['/nginx-ingress-controller', '--publish-service=$(POD_NAMESPACE)/ingress-nginx-controller', '--controller-class=k8s.io/ingress-nginx'], ports: [{ containerPort: 80, name: 'http' }, { containerPort: 443, name: 'https' }], resources: { requests: { cpu: '100m', memory: '90Mi' } } }] } } } });
      add({ apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name: 'nginx', labels, annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' } }, spec: { controller: 'k8s.io/ingress-nginx' } });
      return made;
    }

    // ------------------------------------------------------------ create / update / delete
    // Internal create: defaults only, no RBAC / quota (used by bootstrap and controllers).
    createInternal(obj) {
      const r = this.create(obj, { internal: true });
      if (!r.ok) throw new Error(r.error);
      return r.obj;
    }

    // Full API create with admission. Returns {ok, obj, error, warnings}
    create(input, opts) {
      opts = opts || {};
      const obj = U.clone(input);
      const r = BY_KIND[obj.kind];
      if (!r) return { ok: false, error: `error: resource mapping not found for name: "${obj.metadata && obj.metadata.name}" namespace: "" from "${opts.source || 'STDIN'}": no matches for kind "${obj.kind}" in version "${obj.apiVersion}"\nensure CRDs are installed first` };
      obj.metadata = obj.metadata || {};
      if (!obj.apiVersion) obj.apiVersion = r.apiVersion;
      if (r.namespaced) obj.metadata.namespace = obj.metadata.namespace || opts.namespace || 'default';
      else delete obj.metadata.namespace;
      const md = obj.metadata;
      const resName = r.plural + (r.group ? '.' + r.group : '');
      if (!md.name && md.generateName) md.name = md.generateName + this.suffix(5);
      if (!md.name) return { ok: false, error: `The ${obj.kind} "" is invalid: metadata.name: Required value: name or generateName is required` };
      if (!U.validName(md.name) && obj.kind !== 'Event') {
        return { ok: false, error: `The ${obj.kind} "${md.name}" is invalid: metadata.name: Invalid value: "${md.name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')` };
      }
      for (const [k, v] of Object.entries(md.labels || {})) {
        if (!U.validLabelValue(String(v))) return { ok: false, error: `The ${obj.kind} "${md.name}" is invalid: metadata.labels: Invalid value: "${v}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character` };
        md.labels[k] = String(v);
      }
      if (r.namespaced) {
        const ns = this.get('Namespace', '', md.namespace);
        if (!ns) return { ok: false, error: `Error from server (NotFound): namespaces "${md.namespace}" not found` };
        if (ns.metadata.deletionTimestamp && !opts.internal) return { ok: false, error: `Error from server (Forbidden): ${resName} "${md.name}" is forbidden: unable to create new content in namespace ${md.namespace} because it is being terminated` };
      }
      if (this.get(obj.kind, md.namespace, md.name)) return { ok: false, error: `Error from server (AlreadyExists): ${resName} "${md.name}" already exists`, exists: true };

      const warnings = [];
      const d = this.applyDefaults(obj, opts);
      if (d) return { ok: false, error: d };
      const v = this.validate(obj, null);
      if (v) return { ok: false, error: v };
      if (!opts.internal) {
        const adm = this.admit(obj, warnings, opts);
        if (adm) return { ok: false, error: adm, warnings };
      }
      md.uid = this.newUid();
      md.creationTimestamp = this.ts();
      if (['Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet', 'Job', 'CronJob', 'HorizontalPodAutoscaler', 'Ingress', 'NetworkPolicy', 'PodDisruptionBudget', 'Service', 'Namespace', 'PersistentVolumeClaim'].includes(obj.kind)) md.generation = 1;
      if (opts.dryRun) return { ok: true, obj, warnings, dryRun: true };
      this.put(obj);
      this.onCreated(obj, opts);
      this.emit('api', { verb: 'create', kind: obj.kind, ns: md.namespace, name: md.name, user: opts.user && opts.user.name, internal: !!opts.internal, controller: opts.controller });
      return { ok: true, obj, warnings };
    }

    update(obj, opts) {
      opts = opts || {};
      const r = BY_KIND[obj.kind];
      const cur = this.get(obj.kind, obj.metadata.namespace, obj.metadata.name);
      if (!cur) return { ok: false, error: `Error from server (NotFound): ${r.plural}${r.group ? '.' + r.group : ''} "${obj.metadata.name}" not found` };
      // callers that mutated the stored object in place can't be diffed — treat it as a real change
      const sameRef = obj === cur;
      const next = U.clone(obj);
      next.metadata.uid = cur.metadata.uid;
      next.metadata.creationTimestamp = cur.metadata.creationTimestamp;
      if (cur.metadata.deletionTimestamp) next.metadata.deletionTimestamp = cur.metadata.deletionTimestamp;
      if (cur.metadata.deletionGracePeriodSeconds != null) next.metadata.deletionGracePeriodSeconds = cur.metadata.deletionGracePeriodSeconds;
      if (!next.status && cur.status) next.status = cur.status;
      for (const [k, v] of Object.entries(next.metadata.labels || {})) {
        if (!U.validLabelValue(String(v))) return { ok: false, error: `The ${obj.kind} "${obj.metadata.name}" is invalid: metadata.labels: Invalid value: "${v}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character` };
        next.metadata.labels[k] = String(v);
      }
      const d = this.applyDefaults(next, Object.assign({ update: true, current: cur }, opts));
      if (d) return { ok: false, error: d };
      const v = this.validate(next, cur);
      if (v) return { ok: false, error: v };
      if (!opts.internal && obj.kind === 'Pod') {
        const warnings = [];
        const adm = this.admitPodSecurity(next, warnings, true);
        if (adm) return { ok: false, error: adm };
      }
      const specChanged = sameRef || !U.deepEqual(cur.spec, next.spec) || !U.deepEqual(cur.template, next.template);
      if (specChanged && cur.metadata.generation != null) next.metadata.generation = (cur.metadata.generation || 1) + 1;
      else if (cur.metadata.generation != null) next.metadata.generation = cur.metadata.generation;
      const changed = sameRef || !U.deepEqual(stripVolatile(cur), stripVolatile(next));
      if (opts.dryRun) return { ok: true, obj: next, changed };
      if (!changed) return { ok: true, obj: cur, changed: false };
      this.put(next);
      this.onUpdated(next, cur, opts);
      this.emit('api', { verb: 'update', kind: obj.kind, ns: obj.metadata.namespace, name: obj.metadata.name, internal: !!opts.internal });
      // finalizers removed on an object that is being deleted -> finish the delete
      if (next.metadata.deletionTimestamp && !(next.metadata.finalizers || []).length && next.kind !== 'Pod') this.finalizeDelete(next);
      return { ok: true, obj: next, changed: true };
    }

    // status-only / controller updates without admission
    touch(obj) { this.put(obj); return obj; }

    delete(kind, ns, name, opts) {
      opts = opts || {};
      const r = BY_KIND[kind];
      const obj = this.get(kind, ns, name);
      if (!obj) return { ok: false, error: `Error from server (NotFound): ${r.plural}${r.group ? '.' + r.group : ''} "${name}" not found` };
      if (kind === 'Namespace' && ['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(name)) {
        return { ok: false, error: `Error from server (Forbidden): namespaces "${name}" is forbidden: this namespace may not be deleted` };
      }
      this.emit('api', { verb: 'delete', kind, ns, name, internal: !!opts.internal });
      if (opts.cascade === 'orphan') {
        for (const k of Object.keys(this.objs)) for (const o of this.objs[k].values()) {
          if ((o.metadata.ownerReferences || []).some(ref => ref.uid === obj.metadata.uid)) {
            o.metadata.ownerReferences = o.metadata.ownerReferences.filter(ref => ref.uid !== obj.metadata.uid);
            if (!o.metadata.ownerReferences.length) delete o.metadata.ownerReferences;
            this.put(o);
          }
        }
      }
      if (kind === 'Pod') return this.deletePod(obj, opts);
      if (kind === 'Namespace') {
        if (!obj.metadata.deletionTimestamp) {
          obj.metadata.deletionTimestamp = this.ts();
          obj.status = { phase: 'Terminating' };
          this.put(obj);
        }
        return { ok: true, obj, pending: true };
      }
      // finalizers keep the object around until a controller (or a human) removes them
      const autoFinalizers = ['kubernetes.io/pvc-protection', 'kubernetes.io/pv-protection', 'foregroundDeletion', 'orphan'];
      if ((obj.metadata.finalizers || []).length) {
        if (!obj.metadata.deletionTimestamp) { obj.metadata.deletionTimestamp = this.ts(); this.put(obj); }
        const blocking = obj.metadata.finalizers.filter(f => !autoFinalizers.includes(f));
        return { ok: true, obj, pending: true, blocking };
      }
      this.finalizeDelete(obj);
      return { ok: true, obj };
    }
    finalizeDelete(obj) {
      this.remove(obj);
      this.onDeleted(obj);
    }

    deletePod(pod, opts) {
      const force = opts.force && opts.gracePeriod === 0;
      if (force) {
        this.remove(pod);
        this.onDeleted(pod);
        return { ok: true, obj: pod, forced: true };
      }
      if (!pod.metadata.deletionTimestamp) {
        const grace = opts.gracePeriod != null ? opts.gracePeriod : pod.spec.terminationGracePeriodSeconds != null ? pod.spec.terminationGracePeriodSeconds : 30;
        pod.metadata.deletionTimestamp = this.ts(this.now + grace * 1000);
        pod.metadata.deletionGracePeriodSeconds = grace;
        this.put(pod);
        if (!pod.spec.nodeName || pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') {
          // never ran (or already finished): nothing to stop
          this.remove(pod);
          this.onDeleted(pod);
        }
      } else if (opts.gracePeriod != null) {
        pod.metadata.deletionGracePeriodSeconds = Math.min(pod.metadata.deletionGracePeriodSeconds, opts.gracePeriod);
        this.put(pod);
      }
      return { ok: true, obj: pod };
    }

    onCreated(obj) {
      if (obj.kind === 'Namespace') {
        this.ensureDefaultSA(obj.metadata.name);
        if (!this.get('ConfigMap', obj.metadata.name, 'kube-root-ca.crt')) {
          this.createInternal({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt', namespace: obj.metadata.name, annotations: { 'kubernetes.io/description': 'Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters.' } }, data: { 'ca.crt': '-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIKubesterCA0wDQYJKoZIhvcNAQELBQAwFTETMBEGA1UE\nAxMKa3ViZXJuZXRlczAeFw0yNjExMTYwOTAwMDBaFw0zNjExMTQwOTA1MDBaMBUx\n-----END CERTIFICATE-----\n' } });
        }
      }
      if (obj.kind === 'Pod') this.emit('pod-created', obj);
      if (obj.kind === 'Service' && this.endpointsController) this.endpointsController();
    }
    onUpdated(obj, prev) {
      if (obj.kind === 'Service' && this.endpointsController) this.endpointsController();
      if (obj.kind === 'Pod' && this.rt.pods[obj.metadata.uid]) {
        // image updates on a running pod restart that container (real behaviour)
        const rt = this.rt.pods[obj.metadata.uid];
        (obj.spec.containers || []).forEach(c => {
          const old = (prev.spec.containers || []).find(x => x.name === c.name);
          if (old && old.image !== c.image && rt.containers[c.name]) rt.containers[c.name].imageChanged = true;
        });
      }
    }
    onDeleted(obj) {
      // owner-reference garbage collection runs in the gc controller; Services drop their Endpoints right away.
      if (obj.kind === 'Service') {
        const ep = this.get('Endpoints', obj.metadata.namespace, obj.metadata.name);
        if (ep) this.remove(ep);
      }
      if (obj.kind === 'PersistentVolume') delete this.rt.pvData[obj.metadata.name];
    }
    ensureDefaultSA(ns) {
      if (!this.get('ServiceAccount', ns, 'default')) this.createInternal({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: ns } });
    }

    // ------------------------------------------------------------ defaults (mutating admission)
    applyDefaults(obj, opts) {
      opts = opts || {};
      const md = obj.metadata;
      switch (obj.kind) {
        case 'Pod': return this.defaultPod(obj, opts);
        case 'Deployment': case 'ReplicaSet': case 'DaemonSet': case 'StatefulSet': {
          obj.spec = obj.spec || {};
          if (obj.kind !== 'DaemonSet' && obj.spec.replicas == null) obj.spec.replicas = 1;
          if (obj.spec.revisionHistoryLimit == null && obj.kind !== 'ReplicaSet') obj.spec.revisionHistoryLimit = 10;
          if (obj.kind === 'Deployment') {
            obj.spec.strategy = obj.spec.strategy || { type: 'RollingUpdate' };
            if (!obj.spec.strategy.type) obj.spec.strategy.type = 'RollingUpdate';
            if (obj.spec.strategy.type === 'RollingUpdate') obj.spec.strategy.rollingUpdate = Object.assign({ maxSurge: '25%', maxUnavailable: '25%' }, obj.spec.strategy.rollingUpdate || {});
            if (obj.spec.progressDeadlineSeconds == null) obj.spec.progressDeadlineSeconds = 600;
          }
          if (obj.kind === 'StatefulSet') {
            obj.spec.podManagementPolicy = obj.spec.podManagementPolicy || 'OrderedReady';
            obj.spec.updateStrategy = obj.spec.updateStrategy || { type: 'RollingUpdate', rollingUpdate: { partition: 0 } };
            obj.spec.persistentVolumeClaimRetentionPolicy = obj.spec.persistentVolumeClaimRetentionPolicy || { whenDeleted: 'Retain', whenScaled: 'Retain' };
          }
          if (obj.kind === 'DaemonSet') obj.spec.updateStrategy = obj.spec.updateStrategy || { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } };
          if (obj.spec.template) {
            const t = obj.spec.template;
            t.metadata = t.metadata || {};
            t.spec = t.spec || {};
            const err = this.defaultPodSpec(t.spec, true);
            if (err) return err;
          }
          if (!obj.status) obj.status = {};
          return null;
        }
        case 'Job': {
          obj.spec = obj.spec || {};
          const s = obj.spec;
          if (s.completions === undefined) s.completions = 1;
          if (s.parallelism == null) s.parallelism = 1;
          if (s.backoffLimit == null) s.backoffLimit = 6;
          if (!s.completionMode) s.completionMode = 'NonIndexed';
          s.template = s.template || {};
          s.template.metadata = s.template.metadata || {};
          s.template.spec = s.template.spec || {};
          if (!opts.update) {
            const uid = 'job-uid-' + this.suffix(8);
            s.selector = s.selector || { matchLabels: { 'batch.kubernetes.io/controller-uid': uid } };
            const lbl = s.template.metadata.labels = s.template.metadata.labels || {};
            const cu = s.selector.matchLabels && s.selector.matchLabels['batch.kubernetes.io/controller-uid'];
            if (cu) { lbl['batch.kubernetes.io/controller-uid'] = cu; lbl['controller-uid'] = cu; }
            lbl['batch.kubernetes.io/job-name'] = md.name;
            lbl['job-name'] = md.name;
          } else if (opts.current) {
            s.selector = opts.current.spec.selector;
          }
          if (!md.labels || !Object.keys(md.labels).length) md.labels = Object.assign({}, s.template.metadata.labels || {});
          const err = this.defaultPodSpec(s.template.spec, true, true);
          if (err) return err;
          obj.status = obj.status || {};
          return null;
        }
        case 'CronJob': {
          obj.spec = obj.spec || {};
          const s = obj.spec;
          if (!s.concurrencyPolicy) s.concurrencyPolicy = 'Allow';
          if (s.suspend == null) s.suspend = false;
          if (s.successfulJobsHistoryLimit == null) s.successfulJobsHistoryLimit = 3;
          if (s.failedJobsHistoryLimit == null) s.failedJobsHistoryLimit = 1;
          s.jobTemplate = s.jobTemplate || { spec: {} };
          s.jobTemplate.spec = s.jobTemplate.spec || {};
          const t = s.jobTemplate.spec.template = s.jobTemplate.spec.template || { spec: {} };
          t.spec = t.spec || {};
          const err = this.defaultPodSpec(t.spec, true, true);
          if (err) return err;
          obj.status = obj.status || {};
          return null;
        }
        case 'Service': {
          obj.spec = obj.spec || {};
          const s = obj.spec;
          if (!s.type) s.type = 'ClusterIP';
          if (s.type === 'ExternalName') { delete s.clusterIP; return null; }
          s.sessionAffinity = s.sessionAffinity || 'None';
          s.ports = s.ports || [];
          s.ports.forEach(p => {
            p.protocol = p.protocol || 'TCP';
            if (p.targetPort == null) p.targetPort = p.port;
          });
          const cur = opts.current;
          if (cur && cur.spec.clusterIP && !s.clusterIP) s.clusterIP = cur.spec.clusterIP;
          if (!s.clusterIP) s.clusterIP = this.allocClusterIP();
          if (s.clusterIP !== 'None') s.clusterIPs = [s.clusterIP];
          s.ipFamilies = ['IPv4']; s.ipFamilyPolicy = 'SingleStack';
          s.internalTrafficPolicy = s.internalTrafficPolicy || 'Cluster';
          if (s.type === 'NodePort' || s.type === 'LoadBalancer') {
            s.externalTrafficPolicy = s.externalTrafficPolicy || 'Cluster';
            for (const p of s.ports) {
              const prev = cur && (cur.spec.ports || []).find(x => x.port === p.port);
              if (!p.nodePort) p.nodePort = prev && prev.nodePort ? prev.nodePort : this.allocNodePort();
              else if (p.nodePort < 30000 || p.nodePort > 32767) return `The Service "${md.name}" is invalid: spec.ports[0].nodePort: Invalid value: ${p.nodePort}: provided port is not in the valid range. The range of valid ports is 30000-32767`;
              else {
                const clash = this.list('Service').find(o => o.metadata.uid !== md.uid && (!cur || o.metadata.uid !== cur.metadata.uid) && (o.spec.ports || []).some(x => x.nodePort === p.nodePort));
                if (clash) return `The Service "${md.name}" is invalid: spec.ports[0].nodePort: Invalid value: ${p.nodePort}: provided port is already allocated`;
              }
            }
          }
          if (s.type === 'ClusterIP') s.ports.forEach(p => delete p.nodePort);
          if (s.type === 'LoadBalancer') {
            s.allocateLoadBalancerNodePorts = true;
            if (cur && cur.status && cur.status.loadBalancer) obj.status = cur.status;
          }
          obj.status = obj.status || { loadBalancer: {} };
          return null;
        }
        case 'PersistentVolumeClaim': {
          obj.spec = obj.spec || {};
          if (obj.spec.storageClassName === undefined && !opts.update) {
            const def = this.list('StorageClass').find(sc => (sc.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true');
            if (def) obj.spec.storageClassName = def.metadata.name;
          }
          obj.spec.volumeMode = obj.spec.volumeMode || 'Filesystem';
          if (!opts.update) { md.finalizers = md.finalizers || ['kubernetes.io/pvc-protection']; obj.status = { phase: 'Pending' }; }
          return null;
        }
        case 'PersistentVolume': {
          obj.spec = obj.spec || {};
          obj.spec.persistentVolumeReclaimPolicy = obj.spec.persistentVolumeReclaimPolicy || 'Retain';
          obj.spec.volumeMode = obj.spec.volumeMode || 'Filesystem';
          if (!opts.update) { md.finalizers = md.finalizers || ['kubernetes.io/pv-protection']; obj.status = obj.status || { phase: obj.spec.claimRef ? 'Bound' : 'Available' }; }
          return null;
        }
        case 'Secret': {
          obj.type = obj.type || 'Opaque';
          if (obj.stringData) {
            obj.data = obj.data || {};
            for (const [k, v] of Object.entries(obj.stringData)) obj.data[k] = U.b64encode(String(v));
            delete obj.stringData;
          }
          for (const [k, v] of Object.entries(obj.data || {})) {
            try { U.b64decode(String(v)); } catch (e) { return `Error from server (BadRequest): error when creating "STDIN": Secret in version "v1" cannot be handled as a Secret: illegal base64 data at input byte 0 (key "${k}")`; }
          }
          return null;
        }
        case 'ConfigMap': {
          for (const [k, v] of Object.entries(obj.data || {})) obj.data[k] = v == null ? '' : String(v);
          return null;
        }
        case 'HorizontalPodAutoscaler': {
          obj.spec = obj.spec || {};
          if (obj.spec.minReplicas == null) obj.spec.minReplicas = 1;
          if (obj.apiVersion === 'autoscaling/v1' && obj.spec.targetCPUUtilizationPercentage != null) {
            obj.spec.metrics = [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: obj.spec.targetCPUUtilizationPercentage } } }];
            delete obj.spec.targetCPUUtilizationPercentage;
            obj.apiVersion = 'autoscaling/v2';
          }
          obj.status = obj.status || { currentReplicas: 0, desiredReplicas: 0 };
          return null;
        }
        case 'Ingress': obj.spec = obj.spec || {}; obj.status = obj.status || { loadBalancer: {} }; return null;
        case 'Namespace':
          obj.spec = obj.spec || { finalizers: ['kubernetes'] };
          obj.status = obj.status || { phase: 'Active' };
          md.labels = Object.assign({}, md.labels || {}, { 'kubernetes.io/metadata.name': md.name });
          return null;
        case 'NetworkPolicy': {
          obj.spec = obj.spec || {};
          if (!obj.spec.podSelector) obj.spec.podSelector = {};
          if (!obj.spec.policyTypes) {
            obj.spec.policyTypes = ['Ingress'];
            if (obj.spec.egress) obj.spec.policyTypes.push('Egress');
          }
          return null;
        }
        case 'PodDisruptionBudget': obj.spec = obj.spec || {}; obj.status = obj.status || {}; return null;
        case 'ResourceQuota': obj.spec = obj.spec || { hard: {} }; obj.status = obj.status || {}; return null;
        case 'ServiceAccount': return null;
        case 'Node': return null;
        default: return null;
      }
    }

    defaultPodSpec(spec, template, isJob) {
      spec.containers = spec.containers || [];
      if (!spec.restartPolicy) spec.restartPolicy = isJob ? undefined : 'Always';
      if (!spec.restartPolicy) delete spec.restartPolicy;
      spec.dnsPolicy = spec.dnsPolicy || 'ClusterFirst';
      if (spec.terminationGracePeriodSeconds == null) spec.terminationGracePeriodSeconds = 30;
      spec.schedulerName = spec.schedulerName || 'default-scheduler';
      spec.securityContext = spec.securityContext || {};
      const defC = c => {
        if (!c.imagePullPolicy && c.image) {
          const p = R.parseRef(c.image);
          c.imagePullPolicy = p.tag === 'latest' && !p.digest ? 'Always' : 'IfNotPresent';
        }
        c.resources = c.resources || {};
        c.terminationMessagePath = c.terminationMessagePath || '/dev/termination-log';
        c.terminationMessagePolicy = c.terminationMessagePolicy || 'File';
        (c.ports || []).forEach(p => (p.protocol = p.protocol || 'TCP'));
        // requests default to limits when only limits are set
        const lim = c.resources.limits || {};
        if (Object.keys(lim).length) {
          c.resources.requests = Object.assign({}, lim, c.resources.requests || {});
        }
        ['livenessProbe', 'readinessProbe', 'startupProbe'].forEach(k => {
          const p = c[k];
          if (!p) return;
          p.periodSeconds = p.periodSeconds || 10;
          p.timeoutSeconds = p.timeoutSeconds || 1;
          p.successThreshold = p.successThreshold || 1;
          p.failureThreshold = p.failureThreshold || 3;
          if (p.httpGet) { p.httpGet.path = p.httpGet.path || '/'; p.httpGet.scheme = p.httpGet.scheme || 'HTTP'; }
        });
      };
      spec.containers.forEach(defC);
      (spec.initContainers || []).forEach(defC);
      void template;
      return null;
    }

    defaultPod(pod, opts) {
      const md = pod.metadata;
      pod.spec = pod.spec || {};
      const s = pod.spec;
      if (opts.update) {
        const cur = opts.current;
        // keep server-populated fields if the client omitted them
        ['nodeName', 'serviceAccountName', 'serviceAccount', 'priority', 'priorityClassName', 'imagePullSecrets', 'hostname', 'subdomain', 'tolerations', 'volumes', 'schedulerName', 'dnsPolicy', 'enableServiceLinks', 'preemptionPolicy', 'securityContext', 'terminationGracePeriodSeconds', 'restartPolicy'].forEach(k => {
          if (s[k] === undefined && cur.spec[k] !== undefined) s[k] = U.clone(cur.spec[k]);
        });
        this.defaultPodSpec(s);
        (s.containers || []).forEach(c => {
          const old = (cur.spec.containers || []).find(x => x.name === c.name);
          if (old && !c.volumeMounts && old.volumeMounts) c.volumeMounts = U.clone(old.volumeMounts);
        });
        pod.status = cur.status;
        return null;
      }
      this.defaultPodSpec(s);
      s.serviceAccountName = s.serviceAccountName || s.serviceAccount || 'default';
      s.serviceAccount = s.serviceAccountName;
      if (s.enableServiceLinks == null) s.enableServiceLinks = true;
      s.preemptionPolicy = s.preemptionPolicy || 'PreemptLowerPriority';
      if (s.priorityClassName) {
        const pc = this.get('PriorityClass', '', s.priorityClassName);
        if (!pc) return `Error from server (Forbidden): pods "${md.name}" is forbidden: no PriorityClass with name ${s.priorityClassName} was found`;
        s.priority = pc.value;
        if (pc.preemptionPolicy) s.preemptionPolicy = pc.preemptionPolicy;
      } else {
        const def = this.list('PriorityClass').find(p => p.globalDefault);
        s.priority = def ? def.value : 0;
      }
      s.tolerations = s.tolerations || [];
      const hasTol = k => s.tolerations.some(t => t.key === k && t.effect === 'NoExecute');
      if (!hasTol('node.kubernetes.io/not-ready') && !s.tolerations.some(t => t.operator === 'Exists' && !t.key)) s.tolerations.push({ key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 });
      if (!hasTol('node.kubernetes.io/unreachable') && !s.tolerations.some(t => t.operator === 'Exists' && !t.key)) s.tolerations.push({ key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 });
      // service account token volume (ServiceAccount admission plugin)
      if (!opts.internal || md.namespace !== 'kube-system' || !s.hostNetwork) {
        const sa = this.get('ServiceAccount', md.namespace, s.serviceAccountName);
        if (!sa && !opts.internal) return `Error from server (Forbidden): error when creating "STDIN": pods "${md.name}" is forbidden: error looking up service account ${md.namespace}/${s.serviceAccountName}: serviceaccount "${s.serviceAccountName}" not found`;
        const automount = s.automountServiceAccountToken !== undefined ? s.automountServiceAccountToken : !(sa && sa.automountServiceAccountToken === false);
        if (automount && !(s.volumes || []).some(v => v.name && v.name.startsWith('kube-api-access-'))) {
          const vname = 'kube-api-access-' + this.suffix(5);
          s.volumes = s.volumes || [];
          s.volumes.push({ name: vname, projected: { defaultMode: 420, sources: [{ serviceAccountToken: { expirationSeconds: 3607, path: 'token' } }, { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } }, { downwardAPI: { items: [{ fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.namespace' }, path: 'namespace' }] } }] } });
          (s.containers || []).concat(s.initContainers || []).forEach(c => {
            c.volumeMounts = c.volumeMounts || [];
            c.volumeMounts.push({ name: vname, mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true });
          });
        }
        if (sa && sa.imagePullSecrets && !s.imagePullSecrets) s.imagePullSecrets = U.clone(sa.imagePullSecrets);
      }
      // LimitRange defaults
      if (!opts.internal) this.applyLimitRange(pod);
      pod.status = { phase: 'Pending', qosClass: qosClass(pod) };
      if (s.nodeName) pod.status.conditions = [{ type: 'PodScheduled', status: 'True', lastTransitionTime: this.ts() }];
      return null;
    }

    applyLimitRange(pod) {
      const lrs = this.list('LimitRange', pod.metadata.namespace);
      for (const lr of lrs) {
        for (const lim of (lr.spec && lr.spec.limits) || []) {
          if (lim.type !== 'Container') continue;
          for (const c of pod.spec.containers.concat(pod.spec.initContainers || [])) {
            c.resources = c.resources || {};
            if (lim.default) {
              c.resources.limits = c.resources.limits || {};
              for (const [k, v] of Object.entries(lim.default)) if (c.resources.limits[k] == null) c.resources.limits[k] = v;
            }
            if (lim.defaultRequest || lim.default) {
              c.resources.requests = c.resources.requests || {};
              const dr = Object.assign({}, lim.default || {}, lim.defaultRequest || {});
              for (const [k, v] of Object.entries(dr)) if (c.resources.requests[k] == null) c.resources.requests[k] = (c.resources.limits && c.resources.limits[k] && !lim.defaultRequest) ? c.resources.limits[k] : v;
            }
          }
        }
        pod.metadata.annotations = pod.metadata.annotations || {};
        pod.metadata.annotations['kubernetes.io/limit-ranger'] = 'LimitRanger plugin set: defaults for container resources';
      }
    }

    // ------------------------------------------------------------ validation
    validate(obj, cur) {
      const md = obj.metadata;
      const name = md.name;
      const inv = (field, msg) => `The ${obj.kind} "${name}" is invalid: ${field}: ${msg}`;
      if (obj.kind === 'Pod') {
        const e = validatePodSpec(obj.spec, 'spec', inv);
        if (e) return e;
        if (cur) {
          // pod spec is immutable except a few fields
          const strip = s => { const c = U.clone(s); (c.containers || []).forEach(x => delete x.image); (c.initContainers || []).forEach(x => delete x.image); delete c.activeDeadlineSeconds; delete c.tolerations; delete c.terminationGracePeriodSeconds; delete c.ephemeralContainers; return c; };
          if (!U.deepEqual(strip(obj.spec), strip(cur.spec))) {
            return `The Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`,\`spec.initContainers[*].image\`,\`spec.activeDeadlineSeconds\`,\`spec.tolerations\` (only additions to existing tolerations),\`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)`;
          }
        }
      }
      if (['Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet'].includes(obj.kind)) {
        const s = obj.spec;
        if (!s.selector) return inv('spec.selector', 'Required value');
        if (!s.template || !s.template.metadata) return inv('spec.template.metadata.labels', 'Required value');
        if (!U.matchSelector(s.selector, s.template.metadata.labels || {})) {
          return inv('spec.template.metadata.labels', `Invalid value: map[string]string{${Object.entries(s.template.metadata.labels || {}).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}: \`selector\` does not match template \`labels\``);
        }
        if (s.template.spec.restartPolicy && s.template.spec.restartPolicy !== 'Always') return inv('spec.template.spec.restartPolicy', `Unsupported value: "${s.template.spec.restartPolicy}": supported values: "Always"`);
        if (s.replicas != null && (s.replicas < 0 || !Number.isInteger(+s.replicas))) return inv('spec.replicas', `Invalid value: ${s.replicas}: must be greater than or equal to 0`);
        const e = validatePodSpec(s.template.spec, 'spec.template.spec', inv, (s.volumeClaimTemplates || []).map(t => t.metadata && t.metadata.name));
        if (e) return e;
        if (cur && !U.deepEqual(cur.spec.selector, s.selector)) return inv('spec.selector', `Invalid value: v1.LabelSelector{MatchLabels:map[string]string{${Object.entries((s.selector.matchLabels) || {}).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}, MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: field is immutable`);
        if (obj.kind === 'StatefulSet' && cur) {
          const strip = sp => { const c = U.clone(sp); delete c.replicas; delete c.template; delete c.updateStrategy; delete c.persistentVolumeClaimRetentionPolicy; delete c.minReadySeconds; delete c.ordinals; return c; };
          if (!U.deepEqual(strip(cur.spec), strip(s))) return `The StatefulSet "${name}" is invalid: spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden`;
        }
      }
      if (obj.kind === 'Job') {
        const rp = obj.spec.template.spec.restartPolicy;
        if (rp !== 'Never' && rp !== 'OnFailure') return inv('spec.template.spec.restartPolicy', rp ? `Unsupported value: "${rp}": supported values: "OnFailure", "Never"` : 'Required value: valid values: "OnFailure", "Never"');
        const e = validatePodSpec(obj.spec.template.spec, 'spec.template.spec', inv);
        if (e) return e;
        if (cur && !U.deepEqual(cur.spec.template, obj.spec.template)) return inv('spec.template', 'Invalid value: core.PodTemplateSpec{...}: field is immutable');
      }
      if (obj.kind === 'CronJob') {
        if (!obj.spec.schedule) return inv('spec.schedule', 'Required value');
        if (!KS.cron.parse(obj.spec.schedule)) return inv('spec.schedule', `Invalid value: "${obj.spec.schedule}": unparseable schedule`);
        const rp = obj.spec.jobTemplate.spec.template.spec.restartPolicy;
        if (rp !== 'Never' && rp !== 'OnFailure') return inv('spec.jobTemplate.spec.template.spec.restartPolicy', rp ? `Unsupported value: "${rp}": supported values: "OnFailure", "Never"` : 'Required value: valid values: "OnFailure", "Never"');
        const e = validatePodSpec(obj.spec.jobTemplate.spec.template.spec, 'spec.jobTemplate.spec.template.spec', inv);
        if (e) return e;
      }
      if (obj.kind === 'Service') {
        const s = obj.spec;
        if (!['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(s.type)) return inv('spec.type', `Unsupported value: "${s.type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
        if (s.type !== 'ExternalName' && !(s.ports || []).length) return inv('spec.ports', 'Required value');
        if (s.type === 'ExternalName' && !s.externalName) return inv('spec.externalName', 'Required value');
        for (let i = 0; i < (s.ports || []).length; i++) {
          const p = s.ports[i];
          if (!(p.port >= 1 && p.port <= 65535)) return inv(`spec.ports[${i}].port`, `Invalid value: ${p.port}: must be between 1 and 65535, inclusive`);
          if (s.ports.length > 1 && !p.name) return inv(`spec.ports[${i}].name`, 'Required value');
        }
        if (cur && cur.spec.clusterIP && s.clusterIP && cur.spec.clusterIP !== s.clusterIP) return inv('spec.clusterIPs[0]', 'Invalid value: []string{"' + s.clusterIP + '"}: may not change once set');
      }
      if (obj.kind === 'PersistentVolumeClaim') {
        const s = obj.spec;
        if (!s.accessModes || !s.accessModes.length) return inv('spec.accessModes', 'Required value: at least 1 access mode is required');
        const st = s.resources && s.resources.requests && s.resources.requests.storage;
        if (!st) return inv('spec.resources[storage]', 'Required value');
        if (cur) {
          const curSt = cur.spec.resources.requests.storage;
          const strip = sp => { const c = U.clone(sp); delete c.resources; delete c.volumeName; return c; };
          if (!U.deepEqual(strip(cur.spec), strip(s))) return `The PersistentVolumeClaim "${name}" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`;
          if (U.parseStorage(st) < U.parseStorage(curSt)) return `The PersistentVolumeClaim "${name}" is invalid: spec.resources.requests.storage: Forbidden: field can not be less than status.capacity`;
          if (U.parseStorage(st) > U.parseStorage(curSt)) {
            const sc = this.get('StorageClass', '', s.storageClassName);
            if (!sc || !sc.allowVolumeExpansion) return `Error from server (Forbidden): persistentvolumeclaims "${name}" is forbidden: only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize`;
          }
        }
      }
      if (obj.kind === 'Ingress') {
        for (const rule of obj.spec.rules || []) for (const p of (rule.http && rule.http.paths) || []) {
          if (!p.pathType) return inv('spec.rules[0].http.paths[0].pathType', 'Required value: pathType must be specified');
          if (!p.backend || !p.backend.service) return inv('spec.rules[0].http.paths[0].backend', 'Invalid value: "": resource or service backend is required');
        }
      }
      if (obj.kind === 'HorizontalPodAutoscaler') {
        if (!obj.spec.scaleTargetRef) return inv('spec.scaleTargetRef', 'Required value');
        if (!obj.spec.maxReplicas) return inv('spec.maxReplicas', 'Invalid value: 0: must be greater than or equal to 1');
        if (obj.spec.minReplicas > obj.spec.maxReplicas) return inv('spec.maxReplicas', `Invalid value: ${obj.spec.maxReplicas}: must be greater than or equal to \`minReplicas\``);
      }
      if (obj.kind === 'PodDisruptionBudget') {
        const s = obj.spec;
        if (s.minAvailable != null && s.maxUnavailable != null) return inv('spec', 'Invalid value: policy.PodDisruptionBudgetSpec{...}: minAvailable and maxUnavailable cannot be both set');
      }
      if (obj.kind === 'RoleBinding' || obj.kind === 'ClusterRoleBinding') {
        if (!obj.roleRef || !obj.roleRef.name) return inv('roleRef.name', 'Required value');
        if (cur && !U.deepEqual(cur.roleRef, obj.roleRef)) return inv('roleRef', `Invalid value: rbac.RoleRef{APIGroup:"rbac.authorization.k8s.io", Kind:"${obj.roleRef.kind}", Name:"${obj.roleRef.name}"}: cannot change roleRef`);
      }
      if (obj.kind === 'ConfigMap' || obj.kind === 'Secret') {
        for (const k of Object.keys(obj.data || {})) {
          if (!/^[-._a-zA-Z0-9]+$/.test(k)) return inv(`data[${k}]`, `Invalid value: "${k}": a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')`);
        }
        if (cur && cur.immutable && (!U.deepEqual(cur.data, obj.data))) return inv('data', 'Forbidden: field is immutable when `immutable` is set');
      }
      return null;
    }

    // ------------------------------------------------------------ admission (quota, PSA, LimitRange max)
    admit(obj, warnings, opts) {
      if (obj.kind === 'Pod') {
        const e = this.admitPodSecurity(obj, warnings, false) || this.admitLimitRangeMax(obj) || this.admitQuota(obj);
        if (e) return e;
      } else if (['Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet', 'Job', 'CronJob'].includes(obj.kind)) {
        // PSA only warns for workload templates
        const tplSpec = obj.kind === 'CronJob' ? obj.spec.jobTemplate.spec.template.spec : obj.spec.template.spec;
        const level = this.psaLevel(obj.metadata.namespace);
        if (level.enforce || level.warn) {
          const lv = level.enforce || level.warn;
          const v = psaViolations(tplSpec, lv);
          if (v.length) warnings.push(`Warning: would violate PodSecurity "${lv}:latest": ${v.join(', ')}`);
        }
      }
      const countKinds = { Service: 'services', ConfigMap: 'configmaps', Secret: 'secrets', PersistentVolumeClaim: 'persistentvolumeclaims', Deployment: 'count/deployments.apps', Job: 'count/jobs.batch' };
      if (countKinds[obj.kind]) {
        for (const q of this.list('ResourceQuota', obj.metadata.namespace)) {
          const hard = (q.spec && q.spec.hard) || {};
          const key = countKinds[obj.kind];
          if (hard[key] != null) {
            const used = this.list(obj.kind, obj.metadata.namespace).length;
            if (used + 1 > +hard[key]) return `Error from server (Forbidden): ${BY_KIND[obj.kind].plural} "${obj.metadata.name}" is forbidden: exceeded quota: ${q.metadata.name}, requested: ${key}=1, used: ${key}=${used}, limited: ${key}=${hard[key]}`;
          }
        }
      }
      void opts;
      return null;
    }
    psaLevel(ns) {
      const n = this.get('Namespace', '', ns);
      const l = (n && n.metadata.labels) || {};
      return { enforce: l['pod-security.kubernetes.io/enforce'], warn: l['pod-security.kubernetes.io/warn'], audit: l['pod-security.kubernetes.io/audit'] };
    }
    admitPodSecurity(pod, warnings, isUpdate) {
      const level = this.psaLevel(pod.metadata.namespace);
      if (level.warn && level.warn !== 'privileged') {
        const v = psaViolations(pod.spec, level.warn);
        if (v.length) warnings.push(`Warning: would violate PodSecurity "${level.warn}:latest": ${v.join(', ')}`);
      }
      if (level.audit && level.audit !== 'privileged') {
        const v = psaViolations(pod.spec, level.audit);
        if (v.length) this.auditLog = (this.auditLog || []).concat([{ at: this.now, pod: pod.metadata.namespace + '/' + pod.metadata.name, level: level.audit, violations: v }]);
      }
      if (level.enforce && level.enforce !== 'privileged' && !isUpdate) {
        const v = psaViolations(pod.spec, level.enforce);
        if (v.length) return `Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: violates PodSecurity "${level.enforce}:latest": ${v.join(', ')}`;
      }
      return null;
    }
    admitLimitRangeMax(pod) {
      for (const lr of this.list('LimitRange', pod.metadata.namespace)) {
        for (const lim of (lr.spec && lr.spec.limits) || []) {
          if (lim.type !== 'Container' || !lim.max) continue;
          for (const c of pod.spec.containers) {
            for (const [res, max] of Object.entries(lim.max)) {
              const l = c.resources && c.resources.limits && c.resources.limits[res];
              const parse = res === 'cpu' ? U.parseCpu : U.parseMem;
              if (l != null && parse(l) > parse(max)) return `Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: maximum ${res} usage per Container is ${max}, but limit is ${l}`;
            }
          }
        }
      }
      return null;
    }
    podResourceTotals(pod) {
      const t = { 'requests.cpu': 0, 'requests.memory': 0, 'limits.cpu': 0, 'limits.memory': 0 };
      for (const c of pod.spec.containers) {
        const rq = (c.resources && c.resources.requests) || {};
        const lm = (c.resources && c.resources.limits) || {};
        t['requests.cpu'] += U.parseCpu(rq.cpu || 0); t['requests.memory'] += U.parseMem(rq.memory || 0);
        t['limits.cpu'] += U.parseCpu(lm.cpu || 0); t['limits.memory'] += U.parseMem(lm.memory || 0);
      }
      return t;
    }
    quotaUsage(ns) {
      const used = { pods: 0, 'requests.cpu': 0, 'requests.memory': 0, 'limits.cpu': 0, 'limits.memory': 0 };
      for (const p of this.list('Pod', ns)) {
        if (p.status.phase === 'Succeeded' || p.status.phase === 'Failed') continue;
        used.pods++;
        const t = this.podResourceTotals(p);
        Object.keys(t).forEach(k => (used[k] += t[k]));
      }
      used.services = this.list('Service', ns).length;
      used.configmaps = this.list('ConfigMap', ns).length;
      used.secrets = this.list('Secret', ns).length;
      used.persistentvolumeclaims = this.list('PersistentVolumeClaim', ns).length;
      used['count/deployments.apps'] = this.list('Deployment', ns).length;
      used['count/jobs.batch'] = this.list('Job', ns).length;
      let storage = 0;
      this.list('PersistentVolumeClaim', ns).forEach(c => (storage += U.parseStorage(c.spec.resources.requests.storage)));
      used['requests.storage'] = storage;
      return used;
    }
    admitQuota(pod) {
      const quotas = this.list('ResourceQuota', pod.metadata.namespace);
      if (!quotas.length) return null;
      const used = this.quotaUsage(pod.metadata.namespace);
      const req = this.podResourceTotals(pod);
      req.pods = 1;
      const fmt = (k, v) => (k === 'pods' ? String(v) : k.endsWith('cpu') ? U.fmtCpu(v) : U.fmtMem(v));
      for (const q of quotas) {
        const hard = (q.spec && q.spec.hard) || {};
        // every container must specify a value for each tracked compute resource
        const missing = [];
        for (const k of ['requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory', 'cpu', 'memory']) {
          if (hard[k] == null) continue;
          const key = k === 'cpu' ? 'requests.cpu' : k === 'memory' ? 'requests.memory' : k;
          const [kind, res] = key.split('.');
          const lacking = pod.spec.containers.filter(c => !(c.resources && c.resources[kind] && c.resources[kind][res] != null)).map(c => c.name);
          if (lacking.length) missing.push(`${key} for: ${lacking.join(',')}`);
        }
        if (missing.length) return `Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: failed quota: ${q.metadata.name}: must specify ${missing.join('; ')}`;
        const exceeded = [];
        for (const [k0, hv] of Object.entries(hard)) {
          const k = k0 === 'cpu' ? 'requests.cpu' : k0 === 'memory' ? 'requests.memory' : k0;
          if (!(k in req)) continue;
          const limit = k === 'pods' ? +hv : k.endsWith('cpu') ? U.parseCpu(hv) : U.parseMem(hv);
          if (used[k] + req[k] > limit + 1e-9) exceeded.push({ k: k0, req: fmt(k, req[k]), used: fmt(k, used[k]), hard: hv });
        }
        if (exceeded.length) {
          return `Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: exceeded quota: ${q.metadata.name}, requested: ${exceeded.map(x => `${x.k}=${x.req}`).join(',')}, used: ${exceeded.map(x => `${x.k}=${x.used}`).join(',')}, limited: ${exceeded.map(x => `${x.k}=${x.hard}`).join(',')}`;
        }
      }
      return null;
    }

    // ------------------------------------------------------------ RBAC
    userInfo(as) {
      if (!as) return this.users.current;
      const m = as.match(/^system:serviceaccount:([^:]+):([^:]+)$/);
      if (m) return { name: as, sa: { ns: m[1], name: m[2] }, groups: ['system:serviceaccounts', 'system:serviceaccounts:' + m[1], 'system:authenticated'] };
      return { name: as, groups: ['system:authenticated'] };
    }
    authorize(user, verb, res, ns, name, sub) {
      if ((user.groups || []).includes('system:masters')) return { allowed: true, reason: 'system:masters' };
      const resource = res.plural + (sub ? '/' + sub : '');
      const subjMatch = s => {
        if (s.kind === 'User') return s.name === user.name;
        if (s.kind === 'Group') return (user.groups || []).includes(s.name);
        if (s.kind === 'ServiceAccount') return user.sa && s.name === user.sa.name && (s.namespace || '') === user.sa.ns;
        return false;
      };
      const ruleMatch = rules => (rules || []).some(r =>
        (r.apiGroups || []).some(g => g === '*' || g === res.group) &&
        (r.resources || []).some(x => x === '*' || x === resource) &&
        (r.verbs || []).some(v => v === '*' || v === verb) &&
        (!r.resourceNames || !r.resourceNames.length || (name && r.resourceNames.includes(name))));
      for (const b of this.list('ClusterRoleBinding')) {
        if (!(b.subjects || []).some(subjMatch)) continue;
        const cr = this.get('ClusterRole', '', b.roleRef.name);
        if (cr && ruleMatch(cr.rules)) return { allowed: true, reason: `ClusterRoleBinding "${b.metadata.name}" of ClusterRole "${cr.metadata.name}"` };
      }
      if (ns) {
        for (const b of this.list('RoleBinding', ns)) {
          if (!(b.subjects || []).some(subjMatch)) continue;
          const role = b.roleRef.kind === 'ClusterRole' ? this.get('ClusterRole', '', b.roleRef.name) : this.get('Role', ns, b.roleRef.name);
          if (role && ruleMatch(role.rules)) return { allowed: true, reason: `RoleBinding "${b.metadata.name}" of ${b.roleRef.kind} "${role.metadata.name}"` };
        }
      }
      return { allowed: false };
    }
    forbiddenMsg(user, verb, res, ns, name, sub) {
      const r = res.plural + (sub ? '/' + sub : '');
      const grp = res.group ? `"${res.group}"` : '""';
      const what = name ? `${res.plural}${res.group ? '.' + res.group : ''} "${name}"` : `${res.plural}${res.group ? '.' + res.group : ''}`;
      return `Error from server (Forbidden): ${what} is forbidden: User "${user.name}" cannot ${verb} resource "${r}" in API group ${grp}${res.namespaced && ns ? ` in the namespace "${ns}"` : ' at the cluster scope'}`;
    }

    // ------------------------------------------------------------ IP allocation
    allocClusterIP() {
      const used = new Set(this.list('Service').map(s => s.spec.clusterIP));
      for (let i = 0; i < 5000; i++) {
        const ip = `10.96.${Math.floor(this.rng() * 250) + 1}.${Math.floor(this.rng() * 250) + 2}`;
        if (!used.has(ip)) return ip;
      }
      return '10.96.255.254';
    }
    allocNodePort() {
      const used = new Set();
      this.list('Service').forEach(s => (s.spec.ports || []).forEach(p => p.nodePort && used.add(p.nodePort)));
      for (let i = 0; i < 5000; i++) {
        const p = 30000 + Math.floor(this.rng() * 2768);
        if (!used.has(p)) return p;
      }
      return 32767;
    }
    allocPodIP(nodeName) {
      const idx = this.rt.nodes[nodeName].index;
      const n = this.rt.ipNext[nodeName]++;
      if (this.rt.ipNext[nodeName] > 254) this.rt.ipNext[nodeName] = 2;
      return `10.244.${idx}.${n}`;
    }
    nodeIP(name) {
      const n = this.get('Node', '', name);
      return n ? n.status.addresses.find(a => a.type === 'InternalIP').address : null;
    }
  }

  function stripVolatile(o) {
    const c = U.clone(o);
    if (c.metadata) { delete c.metadata.resourceVersion; delete c.metadata.generation; delete c.metadata.managedFields; }
    delete c.status;
    return c;
  }

  function validatePodSpec(spec, path, inv, extraVolumes) {
    if (!spec) return inv(path, 'Required value');
    if (!spec.containers || !spec.containers.length) return inv(`${path}.containers`, 'Required value');
    const names = new Set();
    const all = (spec.initContainers || []).map((c, i) => [c, `${path}.initContainers[${i}]`]).concat(spec.containers.map((c, i) => [c, `${path}.containers[${i}]`]));
    for (const [c, p] of all) {
      if (!c.name) return inv(`${p}.name`, 'Required value');
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(c.name) || c.name.length > 63) return inv(`${p}.name`, `Invalid value: "${c.name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character`);
      if (names.has(c.name)) return inv(`${p}.name`, `Duplicate value: "${c.name}"`);
      names.add(c.name);
      if (!c.image) return inv(`${p}.image`, 'Required value');
      const rq = (c.resources && c.resources.requests) || {};
      const lm = (c.resources && c.resources.limits) || {};
      for (const res of ['cpu', 'memory']) {
        const parse = res === 'cpu' ? U.parseCpu : U.parseMem;
        if (rq[res] != null && isNaN(parse(rq[res]))) return inv(`${p}.resources.requests[${res}]`, `Invalid value: "${rq[res]}": must be a valid quantity`);
        if (lm[res] != null && isNaN(parse(lm[res]))) return inv(`${p}.resources.limits[${res}]`, `Invalid value: "${lm[res]}": must be a valid quantity`);
        if (rq[res] != null && lm[res] != null && parse(rq[res]) > parse(lm[res])) return inv(`${p}.resources.requests`, `Invalid value: "${rq[res]}": must be less than or equal to ${res} limit of ${lm[res]}`);
      }
      for (const vm of c.volumeMounts || []) {
        if (!(spec.volumes || []).some(v => v.name === vm.name) && !(extraVolumes || []).includes(vm.name)) return inv(`${p}.volumeMounts[0].name`, `Not found: "${vm.name}"`);
      }
      for (const pr of c.ports || []) {
        if (!(pr.containerPort >= 1 && pr.containerPort <= 65535)) return inv(`${p}.ports[0].containerPort`, `Invalid value: ${pr.containerPort}: must be between 1 and 65535, inclusive`);
      }
    }
    for (const v of spec.volumes || []) if (!v.name) return inv(`${path}.volumes[0].name`, 'Required value');
    if (spec.restartPolicy && !['Always', 'OnFailure', 'Never'].includes(spec.restartPolicy)) return inv(`${path}.restartPolicy`, `Unsupported value: "${spec.restartPolicy}": supported values: "Always", "OnFailure", "Never"`);
    return null;
  }

  function qosClass(pod) {
    let anyReq = false, guaranteed = true;
    for (const c of pod.spec.containers) {
      const rq = (c.resources && c.resources.requests) || {};
      const lm = (c.resources && c.resources.limits) || {};
      if (rq.cpu || rq.memory || lm.cpu || lm.memory) anyReq = true;
      for (const r of ['cpu', 'memory']) {
        if (!lm[r]) guaranteed = false;
        else if (rq[r] && (r === 'cpu' ? U.parseCpu(rq[r]) !== U.parseCpu(lm[r]) : U.parseMem(rq[r]) !== U.parseMem(lm[r]))) guaranteed = false;
      }
    }
    if (!anyReq) return 'BestEffort';
    return guaranteed ? 'Guaranteed' : 'Burstable';
  }

  // Pod Security Standards (subset of the real checks, same wording)
  function psaViolations(spec, level) {
    const v = [];
    const containers = (spec.initContainers || []).concat(spec.containers || []);
    const psc = spec.securityContext || {};
    if (spec.hostNetwork) v.push('host namespaces (hostNetwork=true)');
    if (spec.hostPID) v.push('host namespaces (hostPID=true)');
    if (spec.hostIPC) v.push('host namespaces (hostIPC=true)');
    const priv = containers.filter(c => c.securityContext && c.securityContext.privileged).map(c => `"${c.name}"`);
    if (priv.length) v.push(`privileged (container${priv.length > 1 ? 's' : ''} ${priv.join(', ')} must not set securityContext.privileged=true)`);
    const hostPath = (spec.volumes || []).filter(x => x.hostPath).map(x => `"${x.name}"`);
    if (hostPath.length) v.push(`hostPath volumes (volume${hostPath.length > 1 ? 's' : ''} ${hostPath.join(', ')})`);
    const addCaps = containers.filter(c => c.securityContext && c.securityContext.capabilities && (c.securityContext.capabilities.add || []).some(x => !['AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT'].includes(x)));
    if (addCaps.length) v.push(`non-default capabilities (container ${addCaps.map(c => `"${c.name}"`).join(', ')} must not include ${(addCaps[0].securityContext.capabilities.add || []).map(x => `"${x}"`).join(', ')} in securityContext.capabilities.add)`);
    if (level !== 'restricted') return v;
    const ape = containers.filter(c => !(c.securityContext && c.securityContext.allowPrivilegeEscalation === false)).map(c => `"${c.name}"`);
    if (ape.length) v.push(`allowPrivilegeEscalation != false (container${ape.length > 1 ? 's' : ''} ${ape.join(', ')} must set securityContext.allowPrivilegeEscalation=false)`);
    const caps = containers.filter(c => !(c.securityContext && c.securityContext.capabilities && (c.securityContext.capabilities.drop || []).includes('ALL'))).map(c => `"${c.name}"`);
    if (caps.length) v.push(`unrestricted capabilities (container${caps.length > 1 ? 's' : ''} ${caps.join(', ')} must set securityContext.capabilities.drop=["ALL"])`);
    const nonRoot = containers.filter(c => !((c.securityContext && c.securityContext.runAsNonRoot === true) || (psc.runAsNonRoot === true && !(c.securityContext && c.securityContext.runAsNonRoot === false)))).map(c => `"${c.name}"`);
    if (nonRoot.length) v.push(`runAsNonRoot != true (pod or container${nonRoot.length > 1 ? 's' : ''} ${nonRoot.join(', ')} must set securityContext.runAsNonRoot=true)`);
    const rootUid = containers.filter(c => (c.securityContext && c.securityContext.runAsUser === 0) || (psc.runAsUser === 0 && !(c.securityContext && c.securityContext.runAsUser != null))).map(c => `"${c.name}"`);
    if (rootUid.length) v.push(`runAsUser=0 (container${rootUid.length > 1 ? 's' : ''} ${rootUid.join(', ')} must not set runAsUser=0)`);
    const seccomp = (psc.seccompProfile && ['RuntimeDefault', 'Localhost'].includes(psc.seccompProfile.type)) ? [] : containers.filter(c => !(c.securityContext && c.securityContext.seccompProfile && ['RuntimeDefault', 'Localhost'].includes(c.securityContext.seccompProfile.type))).map(c => `"${c.name}"`);
    if (seccomp.length) v.push(`seccompProfile (pod or container${seccomp.length > 1 ? 's' : ''} ${seccomp.join(', ')} must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")`);
    return v;
  }

  // ------------------------------------------------------------------ cron
  KS.cron = {
    parse(expr) {
      const macros = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
      const e = macros[String(expr).trim()] || String(expr).trim();
      const parts = e.split(/\s+/);
      if (parts.length !== 5) return null;
      const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
      const sets = [];
      for (let i = 0; i < 5; i++) {
        const set = new Set();
        for (const item of parts[i].split(',')) {
          const m = item.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
          if (!m) return null;
          let [lo, hi] = ranges[i];
          if (m[1] !== '*') {
            const ab = m[1].split('-').map(Number);
            lo = ab[0]; hi = ab.length > 1 ? ab[1] : (m[2] ? ranges[i][1] : ab[0]);
          }
          const step = m[2] ? +m[2] : 1;
          if (lo < ranges[i][0] || hi > ranges[i][1] || lo > hi || step < 1) return null;
          for (let v = lo; v <= hi; v += step) set.add(i === 4 && v === 7 ? 0 : v);
        }
        sets.push(set);
      }
      return { sets, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
    },
    matches(c, ms) {
      const d = new Date(ms);
      const [mi, h, dom, mon, dow] = c.sets;
      if (!mi.has(d.getUTCMinutes()) || !h.has(d.getUTCHours()) || !mon.has(d.getUTCMonth() + 1)) return false;
      const domOk = dom.has(d.getUTCDate()), dowOk = dow.has(d.getUTCDay());
      if (c.domStar || c.dowStar) return domOk && dowOk;
      return domOk || dowOk;
    },
    // latest schedule time t with after < t <= now (minute resolution), or null
    lastBetween(c, after, now) {
      let t = Math.floor(now / 60000) * 60000;
      const stop = Math.max(after, now - 400 * DAY);
      for (; t > stop; t -= 60000) if (this.matches(c, t)) return t;
      return null;
    },
    next(c, from) {
      let t = Math.floor(from / 60000) * 60000 + 60000;
      for (let i = 0; i < 527040; i++, t += 60000) if (this.matches(c, t)) return t;
      return null;
    },
  };

  KS.Cluster = Cluster;
  KS.RESOURCES = RESOURCES;
  KS.BY_KIND = BY_KIND;
  KS.lookupResource = lookupResource;
  KS.qosClass = qosClass;
  KS.psaViolations = psaViolations;
  KS.EXTERNAL_HOSTS = EXTERNAL_HOSTS;
  KS.CLUSTER_DOMAIN = CLUSTER_DOMAIN;
  KS.K8S_VERSION = K8S_VERSION;
})(typeof window !== 'undefined' ? window : globalThis);
