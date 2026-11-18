/* Kubester — control-plane controllers + scheduler. Extends KS.Cluster.prototype. No DOM. */
(function (G) {
  'use strict';
  const KS = G.KS;
  const U = KS.util;
  const C = KS.Cluster.prototype;

  const isActive = p => !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed';
  const cond = (o, type) => ((o.status && o.status.conditions) || []).find(c => c.type === type);
  const isReady = p => { const c = cond(p, 'Ready'); return !!c && c.status === 'True'; };
  const ctrlRef = o => (o.metadata.ownerReferences || []).find(r => r.controller);
  const ownedBy = (o, owner) => (o.metadata.ownerReferences || []).some(r => r.uid === owner.metadata.uid);
  const userNs = ns => !['kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx'].includes(ns);
  function intOrPct(v, total, roundUp) {
    if (v == null) return 0;
    if (typeof v === 'string' && v.endsWith('%')) {
      const x = (parseFloat(v) / 100) * total;
      return roundUp ? Math.ceil(x) : Math.floor(x);
    }
    return parseInt(v, 10) || 0;
  }
  function setCond(obj, type, status, reason, message, now) {
    obj.status = obj.status || {};
    const list = (obj.status.conditions = obj.status.conditions || []);
    let c = list.find(x => x.type === type);
    if (!c) { c = { type }; list.push(c); }
    const changed = c.status !== status || c.reason !== reason || c.message !== message;
    if (c.status !== status) c.lastTransitionTime = now;
    c.status = status;
    if (reason !== undefined) c.reason = reason; else delete c.reason;
    if (message !== undefined) c.message = message; else delete c.message;
    if (changed || !c.lastUpdateTime) c.lastUpdateTime = now;
    if (!c.lastTransitionTime) c.lastTransitionTime = now;
  }
  KS.podHelpers = { isActive, isReady, cond, ctrlRef, ownedBy, setCond, intOrPct };

  C.runControllers = function (dt) {
    this.nodeLifecycle(dt);
    this.namespaceController();
    this.deploymentController();
    this.replicaSetController();
    this.daemonSetController();
    this.statefulSetController();
    this.cronJobController();
    this.jobController();
    this.hpaController();
    this.gcController();
    this.pvController();
    this.scheduler();
    this.kubelets(dt);
    this.endpointsController();
    this.serviceLBController();
    this.ingressStatusController();
    this.pdbController();
    this.quotaStatusController();
    this.eventTTL();
  };

  // ======================================================================= helpers
  C.templateHash = function (tpl, owner) {
    // cached per owner generation (spec changes always bump generation)
    if (owner && owner.metadata.generation != null) {
      const cache = (this._hashCache = this._hashCache || {});
      const key = owner.metadata.uid + ':' + owner.metadata.generation;
      return cache[key] || (cache[key] = U.hashString(JSON.stringify(stripHash(tpl))));
    }
    return U.hashString(JSON.stringify(stripHash(tpl)));
  };
  function stripHash(tpl) {
    const t = U.clone(tpl);
    if (t.metadata && t.metadata.labels) { delete t.metadata.labels['pod-template-hash']; delete t.metadata.labels['controller-revision-hash']; }
    return sortDeep(t);
  }
  function sortDeep(o) {
    if (Array.isArray(o)) return o.map(sortDeep);
    if (o && typeof o === 'object') { const r = {}; Object.keys(o).sort().forEach(k => (r[k] = sortDeep(o[k]))); return r; }
    return o;
  }
  C.ownerRefFor = function (owner) {
    return { apiVersion: owner.apiVersion, kind: owner.kind, name: owner.metadata.name, uid: owner.metadata.uid, controller: true, blockOwnerDeletion: true };
  };
  // pods indexed by namespace; the index is dropped whenever any Pod is written or removed
  C.podsInNs = function (ns) {
    if (!this._podIdx) {
      this._podIdx = {};
      for (const p of this.objs.Pod.values()) (this._podIdx[p.metadata.namespace] = this._podIdx[p.metadata.namespace] || []).push(p);
    }
    return this._podIdx[ns] || [];
  };
  C.podsOf = function (owner) {
    return this.podsInNs(owner.metadata.namespace).filter(p => ownedBy(p, owner));
  };
  C.podAvailable = function (p, minReady) {
    const c = cond(p, 'Ready');
    if (!c || c.status !== 'True') return false;
    return this.now - Date.parse(c.lastTransitionTime) >= (minReady || 0) * 1000;
  };
  C.createPodFromTemplate = function (tpl, owner, name, extra) {
    const pod = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: Object.assign({ name, namespace: owner.metadata.namespace, labels: Object.assign({}, (tpl.metadata && tpl.metadata.labels) || {}), annotations: tpl.metadata && tpl.metadata.annotations ? U.clone(tpl.metadata.annotations) : undefined, ownerReferences: [this.ownerRefFor(owner)] }, (extra && extra.metadata) || {}),
      spec: U.clone(tpl.spec),
    };
    if (!pod.metadata.annotations) delete pod.metadata.annotations;
    if (extra && extra.spec) Object.assign(pod.spec, extra.spec);
    const res = this.create(pod, { controller: owner.kind });
    return res;
  };
  C.failCreate = function (owner, res) {
    const msg = 'Error creating: ' + String(res.error).replace(/^Error from server \(\w+\): (error when creating "[^"]*": )?/, '');
    this.event(owner, 'Warning', 'FailedCreate', msg, owner.kind === 'Job' ? 'job-controller' : owner.kind.toLowerCase() + '-controller');
    this.rt.failedCreate[owner.metadata.uid] = this.now + 5000;
    if (userNs(owner.metadata.namespace)) this.narrate('⛔', `${owner.kind} ${owner.metadata.name} could not create a Pod: ${msg.replace(/^Error creating: /, '').slice(0, 160)}`, 'bad');
  };
  C.canCreate = function (owner) { return !(this.rt.failedCreate[owner.metadata.uid] > this.now); };

  // ======================================================================= Deployment
  C.deploymentController = function () {
    for (const d of this.ls('Deployment')) {
      if (d.metadata.deletionTimestamp) continue;
      const ns = d.metadata.namespace;
      const rsList = this.ls('ReplicaSet', ns).filter(rs => ownedBy(rs, d) && !rs.metadata.deletionTimestamp);
      const hash = this.templateHash(d.spec.template, d);
      let newRS = rsList.find(rs => (rs.metadata.labels || {})['pod-template-hash'] === hash);
      const revOf = rs => parseInt(((rs.metadata.annotations || {})['deployment.kubernetes.io/revision']) || '0', 10);
      const maxRev = rsList.reduce((m, rs) => Math.max(m, revOf(rs)), 0);
      const replicas = d.spec.replicas;
      const strat = d.spec.strategy || { type: 'RollingUpdate' };
      const maxSurge = strat.type === 'RollingUpdate' ? intOrPct(strat.rollingUpdate.maxSurge, replicas, true) : 0;
      let maxUnavail = strat.type === 'RollingUpdate' ? intOrPct(strat.rollingUpdate.maxUnavailable, replicas, false) : 0;
      if (strat.type === 'RollingUpdate' && maxSurge === 0 && maxUnavail === 0) maxUnavail = 1;
      const changeCause = (d.metadata.annotations || {})['kubernetes.io/change-cause'];
      const rsAnn = rev => {
        const a = { 'deployment.kubernetes.io/desired-replicas': String(replicas), 'deployment.kubernetes.io/max-replicas': String(replicas + maxSurge), 'deployment.kubernetes.io/revision': String(rev) };
        if (changeCause) a['kubernetes.io/change-cause'] = changeCause;
        return a;
      };
      const rt = (this.rt.deploy = this.rt.deploy || {})[d.metadata.uid] = (this.rt.deploy || {})[d.metadata.uid] || { lastProgress: this.now, lastSig: '' };

      if (!newRS && !d.spec.paused) {
        const tpl = U.clone(d.spec.template);
        tpl.metadata.labels = Object.assign({}, tpl.metadata.labels, { 'pod-template-hash': hash });
        const sel = U.clone(d.spec.selector);
        sel.matchLabels = Object.assign({}, sel.matchLabels || {}, { 'pod-template-hash': hash });
        const isFirst = rsList.length === 0;
        const init = strat.type === 'Recreate' ? 0 : isFirst ? replicas : 0;
        const res = this.create({
          apiVersion: 'apps/v1', kind: 'ReplicaSet',
          metadata: { name: `${d.metadata.name}-${hash}`, namespace: ns, labels: U.clone(tpl.metadata.labels), annotations: rsAnn(maxRev + 1), ownerReferences: [this.ownerRefFor(d)] },
          spec: { replicas: init, selector: sel, template: tpl, minReadySeconds: d.spec.minReadySeconds },
        }, { internal: true, controller: 'deployment' });
        if (!res.ok) continue;
        newRS = res.obj;
        if (!newRS.spec.minReadySeconds) delete newRS.spec.minReadySeconds;
        rt.lastProgress = this.now;
        if (init > 0) this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled up replica set ${newRS.metadata.name} from 0 to ${init}`, 'deployment-controller');
        if (userNs(ns)) this.narrate('🧩', isFirst ? `Deployment controller created ReplicaSet ${newRS.metadata.name} to run ${replicas} Pod${replicas === 1 ? '' : 's'}.` : `Pod template changed → Deployment controller created a new ReplicaSet ${newRS.metadata.name} (revision ${maxRev + 1}) and starts a ${strat.type === 'Recreate' ? 'Recreate' : 'rolling'} update.`, 'info');
        this.emit('controller', { name: 'deployment', obj: d });
      } else if (newRS && revOf(newRS) < maxRev && !d.spec.paused) {
        // rolling back to an older template: that ReplicaSet becomes the newest revision
        newRS.metadata.annotations = Object.assign({}, newRS.metadata.annotations, rsAnn(maxRev + 1));
        if (!changeCause) delete newRS.metadata.annotations['kubernetes.io/change-cause'];
        this.put(newRS);
        this.event(d, 'Normal', 'DeploymentRollback', `Rolled back deployment "${d.metadata.name}" to revision ${revOf(newRS)}`, 'deployment-controller');
        if (userNs(ns)) this.narrate('⏪', `Deployment ${d.metadata.name} is switching back to ReplicaSet ${newRS.metadata.name} (now revision ${maxRev + 1}).`, 'warn');
      }
      const all = this.ls('ReplicaSet', ns).filter(rs => ownedBy(rs, d) && !rs.metadata.deletionTimestamp);
      const olds = all.filter(rs => rs !== newRS).sort((a, b) => Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp));
      const availOf = rs => this.podsOf(rs).filter(p => isActive(p) && this.podAvailable(p, d.spec.minReadySeconds)).length;
      const scale = (rs, n, why) => {
        n = Math.max(0, n);
        if (rs.spec.replicas === n) return;
        const from = rs.spec.replicas;
        rs.spec.replicas = n;
        rs.metadata.annotations = Object.assign({}, rs.metadata.annotations, { 'deployment.kubernetes.io/desired-replicas': String(replicas), 'deployment.kubernetes.io/max-replicas': String(replicas + maxSurge) });
        this.put(rs);
        this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled ${n > from ? 'up' : 'down'} replica set ${rs.metadata.name} from ${from} to ${n}`, 'deployment-controller');
        if (userNs(ns) && why) this.narrate(n > from ? '⬆️' : '⬇️', `Deployment controller scaled ReplicaSet ${rs.metadata.name} ${from} → ${n}${why ? ' (' + why + ')' : ''}.`, 'info');
        rt.lastProgress = this.now;
      };

      if (!d.spec.paused && newRS) {
        if (strat.type === 'Recreate') {
          olds.forEach(rs => scale(rs, 0, 'Recreate: stop old Pods first'));
          const oldPodsLeft = olds.some(rs => this.podsOf(rs).length > 0);
          if (!oldPodsLeft) scale(newRS, replicas, 'Recreate: start new Pods');
        } else {
          // ---- scale up new RS
          const sumSpec = () => all.reduce((s, rs) => s + rs.spec.replicas, 0);
          if (newRS.spec.replicas > replicas) scale(newRS, replicas, 'scaled to match replicas');
          else if (!olds.some(rs => rs.spec.replicas > 0)) { if (newRS.spec.replicas !== replicas) scale(newRS, replicas, 'replicas changed'); }
          else {
            const room = replicas + maxSurge - sumSpec();
            if (room > 0) scale(newRS, Math.min(replicas, newRS.spec.replicas + room), 'rolling update: start new Pods');
            // ---- scale down old RSs
            const minAvailable = replicas - maxUnavail;
            const newUnavailable = newRS.spec.replicas - availOf(newRS);
            let maxScaledDown = sumSpec() - minAvailable - newUnavailable;
            if (maxScaledDown > 0) {
              // first remove unhealthy old replicas
              for (const rs of olds) {
                if (maxScaledDown <= 0) break;
                const unhealthy = rs.spec.replicas - availOf(rs);
                if (unhealthy <= 0) continue;
                const n = Math.min(maxScaledDown, unhealthy);
                scale(rs, rs.spec.replicas - n, 'rolling update: remove unhealthy old Pods');
                maxScaledDown -= n;
              }
              const totalAvail = all.reduce((s, rs) => s + availOf(rs), 0);
              let canDown = totalAvail - minAvailable;
              for (const rs of olds) {
                if (canDown <= 0) break;
                if (rs.spec.replicas === 0) continue;
                const n = Math.min(rs.spec.replicas, canDown);
                scale(rs, rs.spec.replicas - n, 'rolling update: retire old Pods');
                canDown -= n;
              }
            }
          }
        }
      }
      // revision history cleanup
      const limit = d.spec.revisionHistoryLimit != null ? d.spec.revisionHistoryLimit : 10;
      const idle = olds.filter(rs => rs.spec.replicas === 0 && this.podsOf(rs).length === 0).sort((a, b) => revOf(a) - revOf(b));
      while (idle.length > limit) { const rs = idle.shift(); this.delete('ReplicaSet', ns, rs.metadata.name, { internal: true }); }

      // ---- status
      const pods = all.flatMap(rs => this.podsOf(rs)).filter(p => !p.metadata.deletionTimestamp);
      const newPods = newRS ? this.podsOf(newRS).filter(p => !p.metadata.deletionTimestamp) : [];
      const ready = pods.filter(p => isActive(p) && isReady(p)).length;
      const available = pods.filter(p => isActive(p) && this.podAvailable(p, d.spec.minReadySeconds)).length;
      const st = d.status = d.status || {};
      const before = JSON.stringify(st);
      st.observedGeneration = d.metadata.generation;
      st.replicas = pods.filter(isActive).length;
      st.updatedReplicas = newPods.filter(isActive).length;
      st.readyReplicas = ready;
      st.availableReplicas = available;
      st.unavailableReplicas = Math.max(0, st.replicas - available);
      if (!st.readyReplicas) delete st.readyReplicas;
      if (!st.availableReplicas) delete st.availableReplicas;
      if (!st.unavailableReplicas) delete st.unavailableReplicas;
      if (!st.replicas) delete st.replicas;
      if (!st.updatedReplicas) delete st.updatedReplicas;
      const now = this.ts();
      setCond(d, 'Available', available >= replicas - maxUnavail ? 'True' : 'False', available >= replicas - maxUnavail ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', available >= replicas - maxUnavail ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.', now);
      const sig = `${st.updatedReplicas}|${available}|${ready}|${newRS && newRS.spec.replicas}`;
      if (sig !== rt.lastSig) { rt.lastSig = sig; rt.lastProgress = this.now; }
      const complete = newRS && (st.updatedReplicas || 0) === replicas && available === replicas && (st.replicas || 0) === replicas && !olds.some(rs => rs.spec.replicas > 0);
      if (d.spec.paused) setCond(d, 'Progressing', 'Unknown', 'DeploymentPaused', 'Deployment is paused', now);
      else if (complete) setCond(d, 'Progressing', 'True', 'NewReplicaSetAvailable', `ReplicaSet "${newRS.metadata.name}" has successfully progressed.`, now);
      else if (this.now - rt.lastProgress > d.spec.progressDeadlineSeconds * 1000) {
        const c = cond(d, 'Progressing');
        if (!c || c.reason !== 'ProgressDeadlineExceeded') this.event(d, 'Warning', 'ProgressDeadlineExceeded', `Deployment "${d.metadata.name}" has timed out progressing.`, 'deployment-controller');
        setCond(d, 'Progressing', 'False', 'ProgressDeadlineExceeded', `ReplicaSet "${newRS ? newRS.metadata.name : ''}" has timed out progressing.`, now);
      } else if (newRS) setCond(d, 'Progressing', 'True', 'ReplicaSetUpdated', `ReplicaSet "${newRS.metadata.name}" is progressing.`, now);
      // keep conditions in canonical order
      d.status.conditions.sort((a, b) => (a.type === 'Available' ? -1 : 1) - (b.type === 'Available' ? -1 : 1));
      if (JSON.stringify(st) !== before) this.put(d);
    }
  };

  // ======================================================================= ReplicaSet
  C.replicaSetController = function () {
    for (const rs of this.ls('ReplicaSet')) {
      if (rs.metadata.deletionTimestamp) continue;
      const ns = rs.metadata.namespace;
      const allPods = this.ls('Pod', ns);
      // adopt orphans / release pods whose labels no longer match
      for (const p of allPods) {
        const ref = ctrlRef(p);
        const matches = U.matchSelector(rs.spec.selector, p.metadata.labels);
        if (!ref && matches && isActive(p)) {
          p.metadata.ownerReferences = (p.metadata.ownerReferences || []).concat([this.ownerRefFor(rs)]);
          this.put(p);
          if (userNs(ns)) this.narrate('🤝', `ReplicaSet ${rs.metadata.name} adopted existing Pod ${p.metadata.name} because its labels match the selector.`, 'info');
        } else if (ref && ref.uid === rs.metadata.uid && !matches) {
          p.metadata.ownerReferences = p.metadata.ownerReferences.filter(r => r.uid !== rs.metadata.uid);
          if (!p.metadata.ownerReferences.length) delete p.metadata.ownerReferences;
          this.put(p);
          if (userNs(ns)) this.narrate('✂️', `Pod ${p.metadata.name} no longer matches ReplicaSet ${rs.metadata.name}'s selector, so it was released (it keeps running on its own).`, 'warn');
        }
      }
      const owned = this.podsOf(rs);
      const active = owned.filter(isActive);
      const want = rs.spec.replicas;
      if (active.length < want && this.canCreate(rs)) {
        for (let i = active.length; i < want; i++) {
          const name = `${rs.metadata.name}-${this.suffix(5)}`;
          const res = this.createPodFromTemplate(rs.spec.template, rs, name);
          if (!res.ok) { this.failCreate(rs, res); break; }
          this.event(rs, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 'replicaset-controller');
          if (userNs(ns)) this.narrate('🆕', `ReplicaSet ${rs.metadata.name} wants ${want}, sees ${i} → created Pod ${name}.`, 'info');
          this.emit('controller', { name: 'replicaset', obj: rs });
        }
      } else if (active.length > want) {
        const rank = p => {
          const phaseRank = !p.spec.nodeName ? 0 : p.status.phase === 'Pending' ? 1 : p.status.phase === 'Unknown' ? 2 : 3;
          const rc = (p.status.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
          return [phaseRank, isReady(p) ? 1 : 0, -rc, -Date.parse(p.metadata.creationTimestamp)];
        };
        const victims = active.slice().sort((a, b) => {
          const ra = rank(a), rb = rank(b);
          for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
          return 0;
        }).slice(0, active.length - want);
        for (const v of victims) {
          this.delete('Pod', ns, v.metadata.name, { internal: true });
          this.event(rs, 'Normal', 'SuccessfulDelete', `Deleted pod: ${v.metadata.name}`, 'replicaset-controller');
          if (userNs(ns)) this.narrate('🗑️', `ReplicaSet ${rs.metadata.name} has too many Pods → deleting ${v.metadata.name}.`, 'info');
        }
      }
      const fresh = this.podsOf(rs).filter(isActive);
      const st = { replicas: fresh.length, fullyLabeledReplicas: fresh.length, readyReplicas: fresh.filter(isReady).length, availableReplicas: fresh.filter(p => this.podAvailable(p, rs.spec.minReadySeconds)).length, observedGeneration: rs.metadata.generation };
      if (!st.readyReplicas) delete st.readyReplicas;
      if (!st.availableReplicas) delete st.availableReplicas;
      if (JSON.stringify(st) !== JSON.stringify(rs.status)) { rs.status = st; this.put(rs); }
    }
  };

  // ======================================================================= DaemonSet
  C.tolerates = function (tolerations, taint) {
    return (tolerations || []).some(t => {
      if (t.effect && t.effect !== taint.effect) return false;
      if (t.operator === 'Exists') return !t.key || t.key === taint.key;
      return t.key === taint.key && (t.value || '') === (taint.value || '');
    });
  };
  C.nodeAffinityMatches = function (spec, node) {
    const labels = node.metadata.labels || {};
    if (spec.nodeSelector && !Object.keys(spec.nodeSelector).every(k => labels[k] === String(spec.nodeSelector[k]))) return false;
    const na = spec.affinity && spec.affinity.nodeAffinity;
    const req = na && na.requiredDuringSchedulingIgnoredDuringExecution;
    if (req && (req.nodeSelectorTerms || []).length) {
      const ok = req.nodeSelectorTerms.some(term => {
        const exprOk = U.matchSelector({ matchExpressions: term.matchExpressions || [] }, labels);
        const fieldOk = (term.matchFields || []).every(f => {
          const v = f.key === 'metadata.name' ? node.metadata.name : undefined;
          if (f.operator === 'In') return (f.values || []).includes(v);
          if (f.operator === 'NotIn') return !(f.values || []).includes(v);
          return true;
        });
        return exprOk && fieldOk;
      });
      if (!ok) return false;
    }
    return true;
  };
  C.daemonSetController = function () {
    const nodes = this.ls('Node');
    for (const ds of this.ls('DaemonSet')) {
      if (ds.metadata.deletionTimestamp) continue;
      const ns = ds.metadata.namespace;
      const hash = this.templateHash(ds.spec.template, ds);
      const tplSpec = ds.spec.template.spec;
      const extraTol = [
        { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute' },
        { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute' },
        { key: 'node.kubernetes.io/disk-pressure', operator: 'Exists', effect: 'NoSchedule' },
        { key: 'node.kubernetes.io/memory-pressure', operator: 'Exists', effect: 'NoSchedule' },
        { key: 'node.kubernetes.io/pid-pressure', operator: 'Exists', effect: 'NoSchedule' },
        { key: 'node.kubernetes.io/unschedulable', operator: 'Exists', effect: 'NoSchedule' },
      ];
      const tols = (tplSpec.tolerations || []).concat(extraTol);
      const pods = this.podsOf(ds).filter(p => !p.metadata.deletionTimestamp);
      const podNode = p => p.spec.nodeName || ((((p.spec.affinity || {}).nodeAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || {}).nodeSelectorTerms || [{}])[0].matchFields?.[0]?.values?.[0];
      let desired = 0, updated = 0, readyN = 0, available = 0, current = 0;
      for (const node of nodes) {
        const should = (node.spec.taints || []).filter(t => t.effect !== 'PreferNoSchedule').every(t => this.tolerates(tols, t)) && this.nodeAffinityMatches(tplSpec, node);
        const mine = pods.filter(p => podNode(p) === node.metadata.name);
        if (should) {
          desired++;
          if (!mine.length) {
            if (!this.canCreate(ds)) continue;
            const spec = U.clone(tplSpec);
            spec.tolerations = tols.map(t => U.clone(t));
            spec.affinity = Object.assign({}, spec.affinity || {}, { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [node.metadata.name] }] }] } } });
            const tpl = { metadata: { labels: Object.assign({}, ds.spec.template.metadata.labels, { 'controller-revision-hash': hash, 'pod-template-generation': String(ds.metadata.generation || 1) }) }, spec };
            const name = `${ds.metadata.name}-${this.suffix(5)}`;
            const res = this.createPodFromTemplate(tpl, ds, name);
            if (!res.ok) { this.failCreate(ds, res); continue; }
            this.event(ds, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 'daemonset-controller');
            if (userNs(ns)) this.narrate('🧷', `DaemonSet ${ds.metadata.name} needs one Pod on ${node.metadata.name} → created ${name}.`, 'info');
          } else {
            current++;
            const p = mine[0];
            if ((p.metadata.labels || {})['controller-revision-hash'] === hash) updated++;
            if (isReady(p)) { readyN++; available++; }
            mine.slice(1).forEach(x => this.delete('Pod', ns, x.metadata.name, { internal: true }));
          }
        } else if (mine.length) {
          mine.forEach(x => { this.delete('Pod', ns, x.metadata.name, { internal: true }); this.event(ds, 'Normal', 'SuccessfulDelete', `Deleted pod: ${x.metadata.name}`, 'daemonset-controller'); });
        }
      }
      // rolling update: replace one outdated pod at a time when everything is ready
      const outdated = pods.filter(p => (p.metadata.labels || {})['controller-revision-hash'] !== hash);
      const terminating = this.podsOf(ds).some(p => p.metadata.deletionTimestamp);
      if (outdated.length && !terminating && pods.length >= desired && pods.every(isReady)) {
        const victim = outdated[0];
        this.delete('Pod', ns, victim.metadata.name, { internal: true });
        if (userNs(ns)) this.narrate('🔁', `DaemonSet ${ds.metadata.name} rolling update: replacing ${victim.metadata.name}.`, 'info');
      }
      const st = { currentNumberScheduled: current, desiredNumberScheduled: desired, numberMisscheduled: 0, numberReady: readyN, updatedNumberScheduled: updated, numberAvailable: available, observedGeneration: ds.metadata.generation };
      if (desired - available > 0) st.numberUnavailable = desired - available;
      if (JSON.stringify(st) !== JSON.stringify(ds.status)) { ds.status = st; this.put(ds); }
    }
  };

  // ======================================================================= StatefulSet
  C.statefulSetController = function () {
    for (const sts of this.ls('StatefulSet')) {
      if (sts.metadata.deletionTimestamp) continue;
      const ns = sts.metadata.namespace;
      const name = sts.metadata.name;
      const updateRev = `${name}-${this.templateHash(sts.spec.template, sts).slice(0, 10)}`;
      const pods = this.podsOf(sts);
      const byOrd = {};
      pods.forEach(p => { const m = p.metadata.name.match(/-(\d+)$/); if (m) byOrd[+m[1]] = p; });
      const parallel = sts.spec.podManagementPolicy === 'Parallel';
      const replicas = sts.spec.replicas;
      let blocked = false;
      for (let i = 0; i < replicas; i++) {
        const p = byOrd[i];
        if (!p) {
          if (blocked || !this.canCreate(sts)) break;
          // make sure the PVCs exist first
          for (const t of sts.spec.volumeClaimTemplates || []) {
            const cname = `${t.metadata.name}-${name}-${i}`;
            if (!this.get('PersistentVolumeClaim', ns, cname)) {
              const r = this.create({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: cname, namespace: ns, labels: Object.assign({}, sts.spec.selector.matchLabels || {}) }, spec: U.clone(t.spec) }, { controller: 'statefulset' });
              if (r.ok) this.event(sts, 'Normal', 'SuccessfulCreate', `create Claim ${cname} Pod ${name}-${i} in StatefulSet ${name} success`, 'statefulset-controller');
              else { this.failCreate(sts, r); blocked = true; }
            }
          }
          if (blocked) break;
          const tpl = U.clone(sts.spec.template);
          tpl.metadata.labels = Object.assign({}, tpl.metadata.labels, { 'apps.kubernetes.io/pod-index': String(i), 'controller-revision-hash': updateRev, 'statefulset.kubernetes.io/pod-name': `${name}-${i}` });
          tpl.spec.hostname = `${name}-${i}`;
          if (sts.spec.serviceName) tpl.spec.subdomain = sts.spec.serviceName;
          tpl.spec.volumes = (tpl.spec.volumes || []).concat((sts.spec.volumeClaimTemplates || []).map(t => ({ name: t.metadata.name, persistentVolumeClaim: { claimName: `${t.metadata.name}-${name}-${i}` } })));
          const res = this.createPodFromTemplate(tpl, sts, `${name}-${i}`);
          if (!res.ok) { this.failCreate(sts, res); break; }
          this.event(sts, 'Normal', 'SuccessfulCreate', `create Pod ${name}-${i} in StatefulSet ${name} successful`, 'statefulset-controller');
          if (userNs(ns)) this.narrate('🔢', `StatefulSet ${name} created ${name}-${i}${parallel || i === 0 ? '' : ` (only after ${name}-${i - 1} was Ready — ordered start)`}.`, 'info');
          if (!parallel) blocked = true;
        } else if (p.status.phase === 'Failed' || p.status.phase === 'Succeeded') {
          if (!p.metadata.deletionTimestamp) this.delete('Pod', ns, p.metadata.name, { internal: true });
          blocked = true;
        } else if (!parallel && (!isReady(p) || p.metadata.deletionTimestamp)) blocked = true;
      }
      // scale down: highest ordinal first, one at a time
      const extra = Object.keys(byOrd).map(Number).filter(i => i >= replicas).sort((a, b) => b - a);
      if (extra.length) {
        const anyTerminating = pods.some(p => p.metadata.deletionTimestamp);
        if (parallel) extra.forEach(i => !byOrd[i].metadata.deletionTimestamp && this.delete('Pod', ns, byOrd[i].metadata.name, { internal: true }));
        else if (!anyTerminating) {
          const v = byOrd[extra[0]];
          this.delete('Pod', ns, v.metadata.name, { internal: true });
          this.event(sts, 'Normal', 'SuccessfulDelete', `delete Pod ${v.metadata.name} in StatefulSet ${name} successful`, 'statefulset-controller');
          if (userNs(ns)) this.narrate('🔢', `StatefulSet ${name} scaling down: removing the highest ordinal first (${v.metadata.name}). Its PVC is kept.`, 'info');
        }
      }
      // rolling update (highest ordinal first)
      const strat = sts.spec.updateStrategy || {};
      if (strat.type !== 'OnDelete' && !extra.length) {
        const live = Object.keys(byOrd).map(Number).filter(i => i < replicas);
        const allReady = live.length === replicas && live.every(i => isReady(byOrd[i]) && !byOrd[i].metadata.deletionTimestamp);
        const partition = (strat.rollingUpdate && strat.rollingUpdate.partition) || 0;
        if (allReady) {
          const outdated = live.filter(i => i >= partition && byOrd[i].metadata.labels['controller-revision-hash'] !== updateRev).sort((a, b) => b - a);
          if (outdated.length) {
            this.delete('Pod', ns, byOrd[outdated[0]].metadata.name, { internal: true });
            if (userNs(ns)) this.narrate('🔁', `StatefulSet ${name} rolling update: replacing ${byOrd[outdated[0]].metadata.name} (highest ordinal first).`, 'info');
          }
        }
      }
      const live = this.podsOf(sts).filter(p => !p.metadata.deletionTimestamp);
      const st = {
        observedGeneration: sts.metadata.generation, replicas: live.length,
        readyReplicas: live.filter(isReady).length, currentReplicas: live.length,
        updatedReplicas: live.filter(p => p.metadata.labels['controller-revision-hash'] === updateRev).length,
        availableReplicas: live.filter(isReady).length, currentRevision: updateRev, updateRevision: updateRev, collisionCount: 0,
      };
      if (JSON.stringify(st) !== JSON.stringify(sts.status)) { sts.status = st; this.put(sts); }
    }
  };

  // ======================================================================= Job
  C.jobController = function () {
    for (const job of this.ls('Job')) {
      if (job.metadata.deletionTimestamp) continue;
      const ns = job.metadata.namespace;
      const st = job.status = job.status || {};
      const rt = (this.rt.jobs = this.rt.jobs || {})[job.metadata.uid] = (this.rt.jobs || {})[job.metadata.uid] || { succeeded: new Set(), failed: new Set(), lastFail: 0 };
      const finished = (job.status.conditions || []).some(c => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True');
      if (finished) {
        const ttl = job.spec.ttlSecondsAfterFinished;
        if (ttl != null && st.completionTime && this.now >= Date.parse(st.completionTime) + ttl * 1000) {
          this.delete('Job', ns, job.metadata.name, { internal: true });
          if (userNs(ns)) this.narrate('🧹', `TTL controller deleted finished Job ${job.metadata.name} (ttlSecondsAfterFinished=${ttl}).`, 'info');
        }
        continue;
      }
      const before = JSON.stringify(st);
      if (!st.startTime && !job.spec.suspend) st.startTime = this.ts();
      const pods = this.podsOf(job);
      pods.forEach(p => {
        if (p.status.phase === 'Succeeded') rt.succeeded.add(p.metadata.uid);
        if (p.status.phase === 'Failed' && !rt.failed.has(p.metadata.uid)) { rt.failed.add(p.metadata.uid); rt.lastFail = this.now; }
      });
      const restarts = pods.filter(p => job.spec.template.spec.restartPolicy === 'OnFailure').reduce((s, p) => s + (p.status.containerStatuses || []).reduce((a, c) => a + (c.restartCount || 0), 0), 0);
      const succeeded = rt.succeeded.size;
      const failed = rt.failed.size + restarts;
      const active = pods.filter(isActive);
      const completions = job.spec.completions;
      const fail = (reason, message) => {
        setCond(job, 'FailureTarget', 'True', reason, message, this.ts());
        setCond(job, 'Failed', 'True', reason, message, this.ts());
        active.forEach(p => this.delete('Pod', ns, p.metadata.name, { internal: true }));
        this.event(job, 'Warning', reason, message, 'job-controller');
        if (userNs(ns)) this.narrate('❌', `Job ${job.metadata.name} failed: ${message}`, 'bad');
      };
      if (failed > job.spec.backoffLimit) fail('BackoffLimitExceeded', 'Job has reached the specified backoff limit');
      else if (job.spec.activeDeadlineSeconds && st.startTime && this.now - Date.parse(st.startTime) > job.spec.activeDeadlineSeconds * 1000) fail('DeadlineExceeded', 'Job was active longer than specified deadline');
      else if ((completions != null && succeeded >= completions) || (completions == null && succeeded > 0 && active.length === 0)) {
        st.completionTime = this.ts();
        setCond(job, 'SuccessCriteriaMet', 'True', 'CompletionsReached', 'Reached expected number of succeeded pods', this.ts());
        setCond(job, 'Complete', 'True', 'CompletionsReached', 'Reached expected number of succeeded pods', this.ts());
        this.event(job, 'Normal', 'Completed', 'Job completed', 'job-controller');
        if (userNs(ns)) this.narrate('🏁', `Job ${job.metadata.name} completed (${succeeded}/${completions == null ? 1 : completions} succeeded).`, 'good');
      } else if (!job.spec.suspend) {
        const want = Math.min(job.spec.parallelism, completions == null ? job.spec.parallelism : completions - succeeded);
        const backoffUntil = rt.failed.size ? rt.lastFail + Math.min(360000, 10000 * Math.pow(2, rt.failed.size - 1)) : 0;
        if (active.length < want && this.now >= backoffUntil && this.canCreate(job)) {
          for (let i = active.length; i < want; i++) {
            const name = `${job.metadata.name}-${this.suffix(5)}`;
            const res = this.createPodFromTemplate(job.spec.template, job, name);
            if (!res.ok) { this.failCreate(job, res); break; }
            this.event(job, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 'job-controller');
            if (userNs(ns)) this.narrate('⚙️', `Job ${job.metadata.name} created Pod ${name}.`, 'info');
          }
        }
      }
      const fresh = this.podsOf(job);
      st.active = fresh.filter(isActive).length || undefined;
      st.ready = fresh.filter(p => isActive(p) && isReady(p)).length;
      st.succeeded = succeeded || undefined;
      st.failed = failed || undefined;
      st.terminating = fresh.filter(p => p.metadata.deletionTimestamp).length;
      Object.keys(st).forEach(k => st[k] === undefined && delete st[k]);
      if (JSON.stringify(st) !== before) this.put(job);
    }
  };

  // ======================================================================= CronJob
  C.cronJobController = function () {
    for (const cj of this.ls('CronJob')) {
      if (cj.metadata.deletionTimestamp) continue;
      const ns = cj.metadata.namespace;
      const st = cj.status = cj.status || {};
      const before = JSON.stringify(st);
      const jobs = this.ls('Job', ns).filter(j => ownedBy(j, cj));
      const isDone = j => (j.status.conditions || []).some(c => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True');
      const active = jobs.filter(j => !isDone(j) && !j.metadata.deletionTimestamp);
      const parsed = KS.cron.parse(cj.spec.schedule);
      if (parsed && !cj.spec.suspend) {
        const since = st.lastScheduleTime ? Date.parse(st.lastScheduleTime) : Date.parse(cj.metadata.creationTimestamp);
        const t = KS.cron.lastBetween(parsed, since, this.now);
        if (t != null && t > since) {
          if (cj.spec.concurrencyPolicy === 'Forbid' && active.length) {
            if (this.rt.cronLast[cj.metadata.uid] !== t) { this.rt.cronLast[cj.metadata.uid] = t; this.event(cj, 'Normal', 'JobAlreadyActive', 'Not starting job because prior execution is running and concurrency policy is Forbid', 'cronjob-controller'); }
          } else {
            if (cj.spec.concurrencyPolicy === 'Replace') active.forEach(j => { this.delete('Job', ns, j.metadata.name, { internal: true }); this.event(cj, 'Normal', 'SuccessfulDelete', `Deleted job ${j.metadata.name}`, 'cronjob-controller'); });
            const jname = `${cj.metadata.name}-${Math.floor(t / 60000)}`;
            if (!this.get('Job', ns, jname)) {
              const jt = U.clone(cj.spec.jobTemplate);
              const res = this.create({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: jname, namespace: ns, labels: (jt.metadata && jt.metadata.labels) || undefined, annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': U.iso(t) }, ownerReferences: [this.ownerRefFor(cj)] }, spec: jt.spec }, { controller: 'cronjob' });
              if (res.ok) {
                this.event(cj, 'Normal', 'SuccessfulCreate', `Created job ${jname}`, 'cronjob-controller');
                if (userNs(ns)) this.narrate('⏰', `CronJob ${cj.metadata.name} fired (schedule "${cj.spec.schedule}") → created Job ${jname}.`, 'info');
              } else this.failCreate(cj, res);
            }
            st.lastScheduleTime = U.iso(t);
          }
        }
      }
      // history limits
      const done = jobs.filter(isDone).sort((a, b) => Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp));
      const ok = done.filter(j => (j.status.conditions || []).some(c => c.type === 'Complete' && c.status === 'True'));
      const bad = done.filter(j => (j.status.conditions || []).some(c => c.type === 'Failed' && c.status === 'True'));
      const prune = (arr, keep) => { while (arr.length > keep) { const j = arr.shift(); this.delete('Job', ns, j.metadata.name, { internal: true }); this.event(cj, 'Normal', 'SuccessfulDelete', `Deleted job ${j.metadata.name}`, 'cronjob-controller'); } };
      prune(ok.slice(), cj.spec.successfulJobsHistoryLimit);
      prune(bad.slice(), cj.spec.failedJobsHistoryLimit);
      if (ok.length) st.lastSuccessfulTime = ok[ok.length - 1].status.completionTime;
      const act = this.ls('Job', ns).filter(j => ownedBy(j, cj) && !isDone(j));
      if (act.length) st.active = act.map(j => ({ apiVersion: 'batch/v1', kind: 'Job', name: j.metadata.name, namespace: ns, uid: j.metadata.uid })); else delete st.active;
      if (JSON.stringify(st) !== before) this.put(cj);
    }
  };

  // ======================================================================= HPA
  C.metricsAvailable = function () {
    return this.ls('Pod', 'kube-system').some(p => (p.metadata.labels || {})['k8s-app'] === 'metrics-server' && isReady(p));
  };
  C.targetOf = function (ref, ns) {
    const kind = ref && ref.kind;
    if (!['Deployment', 'StatefulSet', 'ReplicaSet'].includes(kind)) return null;
    return this.get(kind, ns, ref.name);
  };
  C.podsForWorkload = function (w) {
    return this.ls('Pod', w.metadata.namespace).filter(p => isActive(p) && U.matchSelector(w.spec.selector, p.metadata.labels));
  };
  C.hpaController = function () {
    this.rt.hpaNext = this.rt.hpaNext || 0;
    if (this.now < this.rt.hpaNext) return;
    this.rt.hpaNext = this.now + 15000;
    for (const hpa of this.ls('HorizontalPodAutoscaler')) {
      const ns = hpa.metadata.namespace;
      const st = hpa.status = hpa.status || {};
      const before = JSON.stringify(st);
      const ref = hpa.spec.scaleTargetRef;
      const target = this.targetOf(ref, ns);
      const now = this.ts();
      if (!target) {
        setCond(hpa, 'AbleToScale', 'False', 'FailedGetScale', `the HPA controller was unable to get the target's current scale: ${(ref.kind || '').toLowerCase()}s.apps "${ref.name}" not found`, now);
        this.event(hpa, 'Warning', 'FailedGetScale', `${(ref.kind || '').toLowerCase()}s.apps "${ref.name}" not found`, 'horizontal-pod-autoscaler');
        if (JSON.stringify(st) !== before) this.put(hpa);
        continue;
      }
      const current = target.spec.replicas;
      st.currentReplicas = current;
      setCond(hpa, 'AbleToScale', 'True', 'ReadyForNewScale', 'recommended size matches current size', now);
      const pods = this.podsForWorkload(target).filter(p => p.status.phase === 'Running');
      const metrics = hpa.spec.metrics || [];
      let desired = current;
      const currentMetrics = [];
      let failed = null;
      if (!this.metricsAvailable()) failed = 'failed to get cpu utilization: unable to get metrics for resource cpu: unable to fetch metrics from resource metrics API: the server is currently unable to handle the request (get pods.metrics.k8s.io)';
      for (const m of metrics) {
        if (failed) break;
        if (m.type !== 'Resource') continue;
        const res = m.resource.name;
        const missing = [];
        let sumPct = 0, sumVal = 0, n = 0;
        for (const p of pods) {
          let req = 0, use = 0;
          for (const c of p.spec.containers) {
            const r = c.resources && c.resources.requests && c.resources.requests[res];
            if (r == null) missing.push(`${c.name} of Pod ${p.metadata.name}`);
            req += res === 'cpu' ? U.parseCpu(r || 0) : U.parseMem(r || 0);
          }
          use = res === 'cpu' ? this.podCpu(p) : this.podMem(p);
          if (req > 0) sumPct += (use / req) * 100;
          sumVal += use; n++;
        }
        if (missing.length) { failed = `failed to get ${res} utilization: missing request for ${res} in container ${missing[0]}`; break; }
        if (!n) { failed = `failed to get ${res} utilization: did not receive metrics for targeted pods (pods might be unready)`; break; }
        const tgt = m.resource.target || {};
        if (tgt.type === 'Utilization') {
          const util = Math.round(sumPct / n);
          currentMetrics.push({ type: 'Resource', resource: { name: res, current: { averageUtilization: util, averageValue: res === 'cpu' ? U.fmtCpu(Math.round(sumVal / n)) : U.fmtMem(sumVal / n) } } });
          const ratio = util / tgt.averageUtilization;
          if (Math.abs(ratio - 1) > 0.1) desired = Math.max(desired === current ? 0 : desired, Math.ceil(n * ratio));
        } else if (tgt.type === 'AverageValue') {
          const avg = sumVal / n;
          const tv = res === 'cpu' ? U.parseCpu(tgt.averageValue) : U.parseMem(tgt.averageValue);
          currentMetrics.push({ type: 'Resource', resource: { name: res, current: { averageValue: res === 'cpu' ? U.fmtCpu(Math.round(avg)) : U.fmtMem(avg) } } });
          const ratio = avg / tv;
          if (Math.abs(ratio - 1) > 0.1) desired = Math.max(desired === current ? 0 : desired, Math.ceil(n * ratio));
        }
      }
      if (failed) {
        setCond(hpa, 'ScalingActive', 'False', 'FailedGetResourceMetric', `the HPA was unable to compute the replica count: ${failed}`, now);
        this.event(hpa, 'Warning', 'FailedGetResourceMetric', failed, 'horizontal-pod-autoscaler');
        st.currentMetrics = metrics.filter(m => m.type === 'Resource').map(m => ({ type: 'Resource', resource: { name: m.resource.name, current: {} } }));
        st.desiredReplicas = current;
        if (JSON.stringify(st) !== before) this.put(hpa);
        continue;
      }
      setCond(hpa, 'ScalingActive', 'True', 'ValidMetricFound', 'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)', now);
      st.currentMetrics = currentMetrics;
      if (desired === 0) desired = current;
      // stabilization (scale down uses the max recommendation within the window)
      const hist = (this.rt.hpaHistory[hpa.metadata.uid] = (this.rt.hpaHistory[hpa.metadata.uid] || []).filter(h => this.now - h.t <= 3600000));
      hist.push({ t: this.now, v: desired });
      const beh = hpa.spec.behavior || {};
      const downWin = ((beh.scaleDown || {}).stabilizationWindowSeconds != null ? beh.scaleDown.stabilizationWindowSeconds : 300) * 1000;
      const upWin = ((beh.scaleUp || {}).stabilizationWindowSeconds != null ? beh.scaleUp.stabilizationWindowSeconds : 0) * 1000;
      let rec = desired;
      if (desired < current) rec = Math.max.apply(null, hist.filter(h => this.now - h.t <= downWin).map(h => h.v).concat([desired]));
      if (desired > current && upWin) rec = Math.min.apply(null, hist.filter(h => this.now - h.t <= upWin).map(h => h.v).concat([desired]));
      if (rec > current) rec = Math.min(rec, Math.max(current + 4, current * 2));
      // scale-down rate policies
      const sdp = (beh.scaleDown || {}).policies;
      if (rec < current && sdp && sdp.length) {
        const allowed = Math.max.apply(null, sdp.map(p => p.type === 'Pods' ? p.value : Math.ceil(current * p.value / 100)));
        rec = Math.max(rec, current - allowed);
      }
      rec = Math.min(hpa.spec.maxReplicas, Math.max(hpa.spec.minReplicas || 1, rec));
      st.desiredReplicas = rec;
      const limited = rec === hpa.spec.maxReplicas && desired > hpa.spec.maxReplicas;
      setCond(hpa, 'ScalingLimited', limited ? 'True' : 'False', limited ? 'TooManyReplicas' : 'DesiredWithinRange', limited ? 'the desired replica count is more than the maximum replica count' : 'the desired count is within the acceptable range', now);
      if (rec !== current) {
        const res0 = (metrics[0] && metrics[0].resource && metrics[0].resource.name) || 'cpu';
        const reason = `${res0} resource utilization (percentage of request) ${rec > current ? 'above' : 'below'} target`;
        const scaled = U.clone(target);
        scaled.spec.replicas = rec;
        this.update(scaled, { internal: true });
        st.lastScaleTime = now;
        this.event(hpa, 'Normal', 'SuccessfulRescale', `New size: ${rec}; reason: ${reason}`, 'horizontal-pod-autoscaler');
        if (userNs(ns)) this.narrate('📈', `HPA ${hpa.metadata.name}: ${reason} → ${ref.kind} ${ref.name} ${current} → ${rec} replicas.`, rec > current ? 'warn' : 'info');
      }
      if (JSON.stringify(st) !== before) this.put(hpa);
    }
  };

  // ======================================================================= Garbage collector & namespaces
  C.gcController = function () {
    this.rt.gcNext = this.rt.gcNext || 0;
    if (this.now < this.rt.gcNext) return;
    this.rt.gcNext = this.now + 400;
    const uids = new Set();
    for (const k of Object.keys(this.objs)) for (const o of this.objs[k].values()) if (!o.metadata.deletionTimestamp || k === 'Pod') uids.add(o.metadata.uid);
    for (const k of Object.keys(this.objs)) {
      if (k === 'Event') continue;
      for (const o of [...this.objs[k].values()]) {
        const refs = o.metadata.ownerReferences;
        if (!refs || !refs.length || o.metadata.deletionTimestamp) continue;
        if (refs.every(r => !uids.has(r.uid))) {
          this.delete(k, o.metadata.namespace, o.metadata.name, { internal: true });
          if (k !== 'Endpoints' && userNs(o.metadata.namespace)) this.narrate('🧹', `Garbage collector deleted ${k} ${o.metadata.name} because its owner ${refs[0].kind} ${refs[0].name} is gone.`, 'info');
        }
      }
    }
  };
  C.namespaceController = function () {
    for (const ns of this.ls('Namespace')) {
      if (!ns.metadata.deletionTimestamp) continue;
      const name = ns.metadata.name;
      let remaining = 0;
      const finalizers = {};
      for (const r of KS.RESOURCES) {
        if (!r.namespaced || r.kind === 'Event') continue;
        for (const o of this.ls(r.kind, name)) {
          remaining++;
          if (!o.metadata.deletionTimestamp) this.delete(r.kind, name, o.metadata.name, { internal: true });
          (o.metadata.finalizers || []).forEach(f => (finalizers[f] = (finalizers[f] || 0) + 1));
        }
      }
      if (!remaining) {
        this.ls('Event', name).forEach(e => this.remove(e));
        this.remove(ns);
        if (userNs(name)) this.narrate('🗂️', `Namespace ${name} and everything in it are gone.`, 'info');
      } else {
        const fs = Object.keys(finalizers);
        const prev = JSON.stringify(ns.status.conditions || []);
        ns.status.conditions = [{ type: 'NamespaceContentRemaining', status: 'True', reason: 'SomeResourcesRemain', message: `Some resources are remaining: ${remaining} resource instances` }];
        if (fs.length) ns.status.conditions.push({ type: 'NamespaceFinalizersRemaining', status: 'True', reason: 'SomeFinalizersRemain', message: `Some content in the namespace has finalizers remaining: ${fs.map(f => `${f} in ${finalizers[f]} resource instances`).join(', ')}` });
        if (JSON.stringify(ns.status.conditions) !== prev) this.put(ns);
      }
    }
  };

  // ======================================================================= Storage
  C.pvController = function () {
    // PVC protection: a deleting PVC waits until no running pod uses it
    for (const pvc of this.ls('PersistentVolumeClaim')) {
      if (pvc.metadata.deletionTimestamp) {
        const inUse = this.ls('Pod', pvc.metadata.namespace).some(p => !(p.status.phase === 'Succeeded' || p.status.phase === 'Failed') && (p.spec.volumes || []).some(v => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === pvc.metadata.name));
        if (!inUse && (pvc.metadata.finalizers || []).includes('kubernetes.io/pvc-protection')) {
          pvc.metadata.finalizers = pvc.metadata.finalizers.filter(f => f !== 'kubernetes.io/pvc-protection');
          if (!pvc.metadata.finalizers.length) { this.finalizeDelete(pvc); this.releasePV(pvc); }
          else this.put(pvc);
        }
      }
    }
    for (const pv of this.ls('PersistentVolume')) {
      if (pv.metadata.deletionTimestamp && pv.status.phase !== 'Bound' && (pv.metadata.finalizers || []).includes('kubernetes.io/pv-protection')) {
        pv.metadata.finalizers = pv.metadata.finalizers.filter(f => f !== 'kubernetes.io/pv-protection');
        if (!pv.metadata.finalizers.length) this.finalizeDelete(pv); else this.put(pv);
      }
      // a PV whose claim vanished
      if (pv.status.phase === 'Bound' && pv.spec.claimRef && !this.get('PersistentVolumeClaim', pv.spec.claimRef.namespace, pv.spec.claimRef.name)) this.releasePV({ metadata: { namespace: pv.spec.claimRef.namespace, name: pv.spec.claimRef.name, uid: pv.spec.claimRef.uid } });
    }
    for (const pvc of this.ls('PersistentVolumeClaim')) {
      if (pvc.metadata.deletionTimestamp) continue;
      if (pvc.status.phase === 'Bound') {
        // expansion
        const pv = this.get('PersistentVolume', '', pvc.spec.volumeName);
        const want = pvc.spec.resources.requests.storage;
        if (pv && U.parseStorage(want) > U.parseStorage(pv.spec.capacity.storage)) {
          pv.spec.capacity.storage = want; this.put(pv);
          pvc.status.capacity = { storage: want }; this.put(pvc);
          this.event(pvc, 'Normal', 'VolumeResizeSuccessful', 'MountVolume.NodeExpandVolume succeeded for volume "' + pv.metadata.name + '"', 'kubelet');
        }
        continue;
      }
      const scName = pvc.spec.storageClassName;
      const rt = (this.rt.pvc = this.rt.pvc || {})[pvc.metadata.uid] = (this.rt.pvc || {})[pvc.metadata.uid] || {};
      // static binding first
      const want = U.parseStorage(pvc.spec.resources.requests.storage);
      const candidates = this.ls('PersistentVolume').filter(pv => pv.status.phase === 'Available' && !pv.metadata.deletionTimestamp &&
        (pv.spec.storageClassName || '') === (scName || '') && U.parseStorage(pv.spec.capacity.storage) >= want &&
        (pvc.spec.accessModes || []).every(m => (pv.spec.accessModes || []).includes(m)) &&
        (!pv.spec.claimRef || (pv.spec.claimRef.name === pvc.metadata.name && pv.spec.claimRef.namespace === pvc.metadata.namespace)) &&
        (!pvc.spec.selector || U.matchSelector(pvc.spec.selector, pv.metadata.labels)) &&
        (!pvc.spec.volumeName || pvc.spec.volumeName === pv.metadata.name))
        .sort((a, b) => U.parseStorage(a.spec.capacity.storage) - U.parseStorage(b.spec.capacity.storage));
      if (candidates.length) { this.bindPVC(pvc, candidates[0]); continue; }
      if (!scName) {
        if (!rt.noClass) { rt.noClass = true; this.event(pvc, 'Normal', 'FailedBinding', 'no persistent volumes available for this claim and no storage class is set', 'persistentvolume-controller'); }
        continue;
      }
      const sc = this.get('StorageClass', '', scName);
      if (!sc) {
        if (!rt.noSc || this.now - rt.noSc > 15000) { rt.noSc = this.now; this.event(pvc, 'Warning', 'ProvisioningFailed', `storageclass.storage.k8s.io "${scName}" not found`, 'persistentvolume-controller'); }
        continue;
      }
      let node = null;
      if (sc.volumeBindingMode === 'WaitForFirstConsumer') {
        node = (pvc.metadata.annotations || {})['volume.kubernetes.io/selected-node'];
        if (!node) {
          if (!rt.wffc) { rt.wffc = true; this.event(pvc, 'Normal', 'WaitForFirstConsumer', 'waiting for first consumer to be created before binding', 'persistentvolume-controller'); }
          continue;
        }
      }
      if (!rt.provisionAt) {
        rt.provisionAt = this.now + 1200;
        pvc.metadata.annotations = Object.assign({}, pvc.metadata.annotations, { 'volume.beta.kubernetes.io/storage-provisioner': sc.provisioner, 'volume.kubernetes.io/storage-provisioner': sc.provisioner });
        this.put(pvc);
        this.event(pvc, 'Normal', 'ExternalProvisioning', `Waiting for a volume to be created either by the external provisioner '${sc.provisioner}' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.`, 'persistentvolume-controller');
        this.event(pvc, 'Normal', 'Provisioning', `External provisioner is provisioning volume for claim "${pvc.metadata.namespace}/${pvc.metadata.name}"`, sc.provisioner);
      }
      if (this.now >= rt.provisionAt) {
        const pvName = 'pvc-' + pvc.metadata.uid;
        const zone = node ? (this.get('Node', '', node).metadata.labels['topology.kubernetes.io/zone']) : ['zone-a', 'zone-b', 'zone-c'][Math.floor(this.rng() * 3)];
        const pv = this.createInternal({
          apiVersion: 'v1', kind: 'PersistentVolume',
          metadata: { name: pvName, annotations: { 'pv.kubernetes.io/provisioned-by': sc.provisioner }, labels: sc.provisioner === 'ssd.csi.kubester.io' ? { 'topology.kubernetes.io/zone': zone } : undefined },
          spec: {
            capacity: { storage: pvc.spec.resources.requests.storage }, accessModes: U.clone(pvc.spec.accessModes), persistentVolumeReclaimPolicy: sc.reclaimPolicy || 'Delete', storageClassName: scName, volumeMode: 'Filesystem',
            claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: pvc.metadata.namespace, uid: pvc.metadata.uid },
            hostPath: sc.provisioner === 'rancher.io/local-path' ? { path: `/var/local-path-provisioner/${pvName}_${pvc.metadata.namespace}_${pvc.metadata.name}`, type: 'DirectoryOrCreate' } : undefined,
            csi: sc.provisioner === 'ssd.csi.kubester.io' ? { driver: sc.provisioner, volumeHandle: 'vol-' + pvc.metadata.uid.slice(0, 17).replace(/-/g, '') } : undefined,
            nodeAffinity: sc.provisioner === 'ssd.csi.kubester.io' ? { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'topology.kubernetes.io/zone', operator: 'In', values: [zone] }] }] } } : undefined,
          },
          status: { phase: 'Bound' },
        });
        Object.keys(pv.spec).forEach(k => pv.spec[k] === undefined && delete pv.spec[k]);
        if (!pv.metadata.labels) delete pv.metadata.labels;
        this.event(pvc, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${pvName}`, sc.provisioner);
        this.bindPVC(pvc, pv);
        if (userNs(pvc.metadata.namespace)) this.narrate('💾', `StorageClass ${scName} dynamically provisioned PersistentVolume ${pvName} (${pvc.spec.resources.requests.storage}) for claim ${pvc.metadata.name}.`, 'good');
      }
    }
  };
  C.bindPVC = function (pvc, pv) {
    pv.spec.claimRef = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: pvc.metadata.namespace, uid: pvc.metadata.uid };
    pv.status = { phase: 'Bound' };
    this.put(pv);
    pvc.spec.volumeName = pv.metadata.name;
    pvc.status = { phase: 'Bound', accessModes: U.clone(pv.spec.accessModes), capacity: { storage: pv.spec.capacity.storage } };
    pvc.metadata.annotations = Object.assign({}, pvc.metadata.annotations, { 'pv.kubernetes.io/bind-completed': 'yes', 'pv.kubernetes.io/bound-by-controller': 'yes' });
    this.put(pvc);
    if (!this.rt.pvData[pv.metadata.name]) this.rt.pvData[pv.metadata.name] = KS.runtime.makeStore(false);
  };
  C.releasePV = function (pvc) {
    for (const pv of this.ls('PersistentVolume')) {
      if (!pv.spec.claimRef || pv.spec.claimRef.name !== pvc.metadata.name || pv.spec.claimRef.namespace !== pvc.metadata.namespace) continue;
      if (pv.spec.persistentVolumeReclaimPolicy === 'Delete') {
        pv.status = { phase: 'Released' };
        pv.metadata.finalizers = (pv.metadata.finalizers || []).filter(f => f !== 'kubernetes.io/pv-protection');
        this.remove(pv);
        this.onDeleted(pv);
        if (userNs(pvc.metadata.namespace)) this.narrate('🗑️', `PersistentVolume ${pv.metadata.name} was deleted with its claim (reclaimPolicy: Delete) — its data is gone.`, 'warn');
      } else {
        pv.status = { phase: 'Released' };
        this.put(pv);
        if (userNs(pvc.metadata.namespace)) this.narrate('📦', `PersistentVolume ${pv.metadata.name} is now Released (reclaimPolicy: Retain) — the data is kept for manual recovery.`, 'info');
      }
    }
  };

  // ======================================================================= Scheduler
  C.podRequests = function (pod) {
    let cpu = 0, mem = 0;
    for (const c of pod.spec.containers) {
      const r = (c.resources && c.resources.requests) || {};
      cpu += U.parseCpu(r.cpu || 0); mem += U.parseMem(r.memory || 0);
    }
    for (const c of pod.spec.initContainers || []) {
      const r = (c.resources && c.resources.requests) || {};
      cpu = Math.max(cpu, U.parseCpu(r.cpu || 0)); mem = Math.max(mem, U.parseMem(r.memory || 0));
    }
    return { cpu, mem };
  };
  C.nodeAllocated = function (nodeName, exceptUid) {
    let cpu = 0, mem = 0, pods = 0;
    for (const p of this.objs.Pod.values()) {
      if (p.spec.nodeName !== nodeName || p.metadata.uid === exceptUid) continue;
      if (p.status.phase === 'Succeeded' || p.status.phase === 'Failed') continue;
      const r = this.podRequests(p);
      cpu += r.cpu; mem += r.mem; pods++;
    }
    return { cpu, mem, pods };
  };
  C.podsOnNode = function (nodeName) { return [...this.objs.Pod.values()].filter(p => p.spec.nodeName === nodeName); };

  C.filterNode = function (pod, node, reqs, ctx) {
    const nm = node.metadata.name;
    if ((node.spec.taints || []).some(t => (t.effect === 'NoSchedule' || t.effect === 'NoExecute') && !this.tolerates(pod.spec.tolerations, t))) {
      const t = node.spec.taints.find(x => (x.effect === 'NoSchedule' || x.effect === 'NoExecute') && !this.tolerates(pod.spec.tolerations, x));
      return `node(s) had untolerated taint {${t.key}: ${t.value || ''}}`;
    }
    if (node.spec.unschedulable && !this.tolerates(pod.spec.tolerations, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' })) return 'node(s) were unschedulable';
    if (!this.nodeAffinityMatches(pod.spec, node)) return "node(s) didn't match Pod's node affinity/selector";
    const alloc = this.nodeAllocated(nm);
    const capCpu = U.parseCpu(node.status.allocatable.cpu), capMem = U.parseMem(node.status.allocatable.memory);
    const insuf = [];
    if (alloc.pods + 1 > +node.status.allocatable.pods) return 'Too many pods';
    if (reqs.cpu > 0 && alloc.cpu + reqs.cpu > capCpu) insuf.push('Insufficient cpu');
    if (reqs.mem > 0 && alloc.mem + reqs.mem > capMem) insuf.push('Insufficient memory');
    if (insuf.length) return insuf;
    // volumes
    for (const v of pod.spec.volumes || []) {
      if (!v.persistentVolumeClaim) continue;
      const pvc = this.get('PersistentVolumeClaim', pod.metadata.namespace, v.persistentVolumeClaim.claimName);
      if (!pvc) return `persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" not found`;
      if (pvc.status.phase === 'Bound') {
        const pv = this.get('PersistentVolume', '', pvc.spec.volumeName);
        if (pv && pv.spec.nodeAffinity && !this.nodeAffinityMatches({ affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: pv.spec.nodeAffinity.required } } }, node)) return 'node(s) had volume node affinity conflict';
        if (pv && (pv.spec.accessModes || []).includes('ReadWriteOncePod')) {
          const other = [...this.objs.Pod.values()].some(p => p.metadata.uid !== pod.metadata.uid && p.spec.nodeName && isActive(p) && (p.spec.volumes || []).some(x => x.persistentVolumeClaim && x.persistentVolumeClaim.claimName === pvc.metadata.name));
          if (other) return 'node has pod using PersistentVolumeClaim with the same name and ReadWriteOncePod access mode';
        }
      } else {
        const sc = this.get('StorageClass', '', pvc.spec.storageClassName);
        if (!sc || sc.volumeBindingMode !== 'WaitForFirstConsumer') return 'pod has unbound immediate PersistentVolumeClaims';
      }
    }
    // inter-pod (anti-)affinity — required terms
    const aff = pod.spec.affinity || {};
    const topoVal = (n, key) => (n.metadata.labels || {})[key];
    for (const term of ((aff.podAntiAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || [])) {
      const v = topoVal(node, term.topologyKey);
      if (v == null) continue;
      const clash = ctx.placed.some(x => x.ns === (term.namespaces ? x.ns : pod.metadata.namespace) && (term.namespaces ? term.namespaces.includes(x.ns) : x.ns === pod.metadata.namespace) && U.matchSelector(term.labelSelector, x.labels) && topoVal(x.node, term.topologyKey) === v);
      if (clash) return "node(s) didn't match pod anti-affinity rules";
    }
    for (const term of ((aff.podAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || [])) {
      const v = topoVal(node, term.topologyKey);
      const ok = ctx.placed.some(x => x.ns === pod.metadata.namespace && U.matchSelector(term.labelSelector, x.labels) && topoVal(x.node, term.topologyKey) === v);
      const anyMatch = ctx.placed.some(x => x.ns === pod.metadata.namespace && U.matchSelector(term.labelSelector, x.labels));
      if (!ok && !(anyMatch === false && U.matchSelector(term.labelSelector, pod.metadata.labels))) return "node(s) didn't match pod affinity rules";
    }
    // topology spread (DoNotSchedule)
    for (const c of pod.spec.topologySpreadConstraints || []) {
      if (c.whenUnsatisfiable === 'ScheduleAnyway') continue;
      const v = topoVal(node, c.topologyKey);
      if (v == null) return "node(s) didn't match pod topology spread constraints (missing required label)";
      const domains = {};
      ctx.eligible.forEach(n => { const dv = topoVal(n, c.topologyKey); if (dv != null) domains[dv] = 0; });
      ctx.placed.forEach(x => { if (x.ns === pod.metadata.namespace && U.matchSelector(c.labelSelector, x.labels)) { const dv = topoVal(x.node, c.topologyKey); if (dv in domains) domains[dv]++; } });
      const min = Math.min.apply(null, Object.values(domains));
      if ((domains[v] || 0) + 1 - min > c.maxSkew) return "node(s) didn't match pod topology spread constraints";
    }
    return null;
  };

  C.scoreNode = function (pod, node, reqs, ctx) {
    const alloc = this.nodeAllocated(node.metadata.name);
    const capCpu = U.parseCpu(node.status.allocatable.cpu), capMem = U.parseMem(node.status.allocatable.memory);
    // least-allocated (requests, with a small default for pods that set none — like the real scheduler)
    const cpuFrac = (alloc.cpu + Math.max(reqs.cpu, 100)) / capCpu;
    const memFrac = (alloc.mem + Math.max(reqs.mem, 200)) / capMem;
    let score = (1 - (cpuFrac + memFrac) / 2) * 100;
    // spread pods of the same owner across nodes / zones
    const ref = ctrlRef(pod);
    const sameOwner = ctx.placed.filter(x => x.owner && ref && x.owner === ref.uid);
    score -= sameOwner.filter(x => x.node.metadata.name === node.metadata.name).length * 18;
    const zone = (node.metadata.labels || {})['topology.kubernetes.io/zone'];
    score -= sameOwner.filter(x => (x.node.metadata.labels || {})['topology.kubernetes.io/zone'] === zone).length * 6;
    const aff = pod.spec.affinity || {};
    for (const p of ((aff.nodeAffinity || {}).preferredDuringSchedulingIgnoredDuringExecution || [])) {
      if (U.matchSelector({ matchExpressions: p.preference.matchExpressions || [] }, node.metadata.labels)) score += p.weight;
    }
    for (const p of ((aff.podAntiAffinity || {}).preferredDuringSchedulingIgnoredDuringExecution || [])) {
      const t = p.podAffinityTerm; const v = (node.metadata.labels || {})[t.topologyKey];
      const n = ctx.placed.filter(x => x.ns === pod.metadata.namespace && U.matchSelector(t.labelSelector, x.labels) && (x.node.metadata.labels || {})[t.topologyKey] === v).length;
      score -= p.weight * n;
    }
    for (const p of ((aff.podAffinity || {}).preferredDuringSchedulingIgnoredDuringExecution || [])) {
      const t = p.podAffinityTerm; const v = (node.metadata.labels || {})[t.topologyKey];
      const n = ctx.placed.filter(x => x.ns === pod.metadata.namespace && U.matchSelector(t.labelSelector, x.labels) && (x.node.metadata.labels || {})[t.topologyKey] === v).length;
      score += p.weight * Math.min(n, 1);
    }
    for (const c of pod.spec.topologySpreadConstraints || []) {
      if (c.whenUnsatisfiable !== 'ScheduleAnyway') continue;
      const v = (node.metadata.labels || {})[c.topologyKey];
      score -= 10 * ctx.placed.filter(x => x.ns === pod.metadata.namespace && U.matchSelector(c.labelSelector, x.labels) && (x.node.metadata.labels || {})[c.topologyKey] === v).length;
    }
    if ((node.spec.taints || []).some(t => t.effect === 'PreferNoSchedule' && !this.tolerates(pod.spec.tolerations, t))) score -= 50;
    // image locality
    const imgs = this.rt.imageCache[node.metadata.name];
    if (imgs && pod.spec.containers.some(c => imgs.has(KS.runtime.parseRef(c.image).full))) score += 2;
    return score;
  };

  C.scheduler = function () {
    const pending = [...this.objs.Pod.values()].filter(p => !p.spec.nodeName && !p.metadata.deletionTimestamp && (p.spec.schedulerName || 'default-scheduler') === 'default-scheduler')
      .sort((a, b) => (b.spec.priority || 0) - (a.spec.priority || 0) || Date.parse(a.metadata.creationTimestamp) - Date.parse(b.metadata.creationTimestamp));
    if (!pending.length) return;
    const nodes = this.ls('Node');
    for (const pod of pending) {
      const retry = this.rt.schedRetry[pod.metadata.uid];
      if (retry && this.now < retry.at && retry.sig === this.rv) continue;
      if (retry && this.now < retry.at && this.now - retry.last < 1000) continue;
      const placed = [...this.objs.Pod.values()].filter(p => p.spec.nodeName && isActive(p)).map(p => ({ ns: p.metadata.namespace, labels: p.metadata.labels || {}, node: this.get('Node', '', p.spec.nodeName), owner: (ctrlRef(p) || {}).uid })).filter(x => x.node);
      const ctx = { placed, eligible: nodes.filter(n => this.nodeAffinityMatches(pod.spec, n)) };
      const reqs = this.podRequests(pod);
      const reasons = {};
      const feasible = [];
      for (const n of nodes) {
        const r = this.filterNode(pod, n, reqs, ctx);
        if (!r) feasible.push(n);
        else [].concat(r).forEach(x => (reasons[x] = (reasons[x] || 0) + 1));
      }
      if (!feasible.length) {
        // preemption
        const victim = this.tryPreempt(pod, nodes, reqs, ctx);
        const parts = Object.keys(reasons).map(k => `${reasons[k]} ${k}`).sort();
        const resNodes = Object.keys(reasons).filter(k => /^Insufficient/.test(k)).reduce((s, k) => Math.max(s, reasons[k]), 0);
        const preNote = victim ? '' : ` preemption: 0/${nodes.length} nodes are available: ${resNodes ? `${resNodes} No preemption victims found for incoming pod${nodes.length - resNodes ? ', ' : ''}` : ''}${nodes.length - resNodes ? `${nodes.length - resNodes} Preemption is not helpful for scheduling` : ''}.`;
        const msg = `0/${nodes.length} nodes are available: ${parts.join(', ')}.${preNote}`;
        const prevMsg = retry && retry.msg;
        this.rt.schedRetry[pod.metadata.uid] = { at: this.now + 5000, last: this.now, sig: this.rv, msg };
        if (prevMsg !== msg || !retry || this.now - (retry.evAt || 0) > 30000) {
          this.event(pod, 'Warning', 'FailedScheduling', msg, 'default-scheduler');
          this.rt.schedRetry[pod.metadata.uid].evAt = this.now;
          if (userNs(pod.metadata.namespace) && prevMsg !== msg) this.narrate('🚫', `Scheduler can't place ${pod.metadata.name}: ${parts.join(', ')}.`, 'bad');
        } else this.rt.schedRetry[pod.metadata.uid].evAt = retry.evAt;
        const c = cond(pod, 'PodScheduled');
        if (!c || c.status !== 'False' || c.message !== msg) { setCond(pod, 'PodScheduled', 'False', 'Unschedulable', msg, this.ts()); delete pod.status.conditions.find(x => x.type === 'PodScheduled').lastUpdateTime; this.put(pod); }
        continue;
      }
      let best = null, bestScore = -Infinity;
      for (const n of feasible) {
        const s = this.scoreNode(pod, n, reqs, ctx);
        if (s > bestScore + 1e-9) { best = n; bestScore = s; }
      }
      this.bind(pod, best, feasible.length);
    }
  };
  C.tryPreempt = function (pod, nodes, reqs, ctx) {
    if (pod.spec.preemptionPolicy === 'Never' || !(pod.spec.priority > 0)) return null;
    if (pod.status.nominatedNodeName) return pod.status.nominatedNodeName;
    for (const n of nodes) {
      const lower = this.podsOnNode(n.metadata.name).filter(p => isActive(p) && (p.spec.priority || 0) < pod.spec.priority).sort((a, b) => (a.spec.priority || 0) - (b.spec.priority || 0));
      if (!lower.length) continue;
      const alloc = this.nodeAllocated(n.metadata.name);
      const capCpu = U.parseCpu(n.status.allocatable.cpu), capMem = U.parseMem(n.status.allocatable.memory);
      let cpu = alloc.cpu, mem = alloc.mem;
      const victims = [];
      for (const v of lower) {
        if (cpu + reqs.cpu <= capCpu && mem + reqs.mem <= capMem) break;
        const r = this.podRequests(v);
        cpu -= r.cpu; mem -= r.mem; victims.push(v);
      }
      if (cpu + reqs.cpu > capCpu || mem + reqs.mem > capMem) continue;
      // other filters must pass if victims are gone
      const t = (n.spec.taints || []).some(tt => (tt.effect === 'NoSchedule' || tt.effect === 'NoExecute') && !this.tolerates(pod.spec.tolerations, tt));
      if (t || n.spec.unschedulable || !this.nodeAffinityMatches(pod.spec, n)) continue;
      victims.forEach(v => {
        this.event(v, 'Normal', 'Preempted', `Preempted by pod ${pod.metadata.uid} on node ${n.metadata.name}`, 'default-scheduler');
        this.delete('Pod', v.metadata.namespace, v.metadata.name, { internal: true });
      });
      pod.status.nominatedNodeName = n.metadata.name;
      this.put(pod);
      this.narrate('🥊', `Preemption: ${pod.metadata.name} (priority ${pod.spec.priority}) evicted ${victims.map(v => v.metadata.name).join(', ')} on ${n.metadata.name} to make room.`, 'warn');
      void ctx;
      return n.metadata.name;
    }
    return null;
  };
  C.bind = function (pod, node, feasibleCount) {
    pod.spec.nodeName = node.metadata.name;
    delete pod.status.nominatedNodeName;
    pod.status.conditions = (pod.status.conditions || []).filter(c => c.type !== 'PodScheduled');
    pod.status.conditions.push({ type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: this.ts() });
    delete this.rt.schedRetry[pod.metadata.uid];
    // WaitForFirstConsumer volumes get their node now
    for (const v of pod.spec.volumes || []) {
      if (!v.persistentVolumeClaim) continue;
      const pvc = this.get('PersistentVolumeClaim', pod.metadata.namespace, v.persistentVolumeClaim.claimName);
      if (pvc && pvc.status.phase !== 'Bound') { pvc.metadata.annotations = Object.assign({}, pvc.metadata.annotations, { 'volume.kubernetes.io/selected-node': node.metadata.name }); this.put(pvc); }
    }
    this.put(pod);
    this.event(pod, 'Normal', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`, 'default-scheduler');
    this.emit('schedule', { pod: pod.metadata.uid, node: node.metadata.name, name: pod.metadata.name, ns: pod.metadata.namespace });
    if (userNs(pod.metadata.namespace)) this.narrate('📍', `Scheduler placed ${pod.metadata.name} on ${node.metadata.name}${feasibleCount > 1 ? ` (best score of ${feasibleCount} suitable nodes)` : ' (the only node that fits)'}.`, 'info');
  };

  // ======================================================================= Node lifecycle & taint eviction
  C.nodeLifecycle = function () {
    for (const node of this.ls('Node')) {
      const rt = this.rt.nodes[node.metadata.name];
      if (!rt) continue;
      const now = this.ts();
      const before = JSON.stringify([node.status.conditions, node.spec.taints]);
      const taints = (node.spec.taints || []).slice();
      const hasT = k => taints.some(t => t.key === k);
      if (rt.up) {
        rt.lastHeartbeat = this.now;
        const conds = [
          ['MemoryPressure', 'False', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'],
          ['DiskPressure', rt.diskPressure ? 'True' : 'False', rt.diskPressure ? 'KubeletHasDiskPressure' : 'KubeletHasNoDiskPressure', rt.diskPressure ? 'kubelet has disk pressure' : 'kubelet has no disk pressure'],
          ['PIDPressure', 'False', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'],
          ['Ready', 'True', 'KubeletReady', 'kubelet is posting ready status'],
        ];
        const wasNotReady = (node.status.conditions || []).some(c => c.type === 'Ready' && c.status !== 'True');
        conds.forEach(([t, s, r, m]) => setCond(node, t, s, r, m, now));
        node.status.conditions.forEach(c => { c.lastHeartbeatTime = c.lastHeartbeatTime && this.now - Date.parse(c.lastHeartbeatTime) < 10000 ? c.lastHeartbeatTime : now; delete c.lastUpdateTime; });
        let t2 = taints.filter(t => t.key !== 'node.kubernetes.io/unreachable' && t.key !== 'node.kubernetes.io/not-ready');
        if (rt.diskPressure && !t2.some(t => t.key === 'node.kubernetes.io/disk-pressure')) t2.push({ key: 'node.kubernetes.io/disk-pressure', effect: 'NoSchedule', timeAdded: now });
        if (!rt.diskPressure) t2 = t2.filter(t => t.key !== 'node.kubernetes.io/disk-pressure');
        node.spec.taints = t2.length ? t2 : undefined;
        if (!node.spec.taints) delete node.spec.taints;
        if (wasNotReady && node.status.conditions.length) {
          this.event(node, 'Normal', 'NodeReady', `Node ${node.metadata.name} status is now: NodeReady`, 'kubelet');
          this.narrate('💚', `Node ${node.metadata.name} is Ready again — its kubelet is reporting in.`, 'good');
        }
      } else if (this.now - rt.lastHeartbeat > 40000) {
        const c = cond(node, 'Ready');
        if (c && c.status !== 'Unknown') {
          ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'Ready'].forEach(t => setCond(node, t, 'Unknown', 'NodeStatusUnknown', 'Kubelet stopped posting node status.', now));
          node.status.conditions.forEach(x => delete x.lastUpdateTime);
          this.event(node, 'Normal', 'NodeNotReady', `Node ${node.metadata.name} status is now: NodeNotReady`, 'node-controller');
          this.narrate('💔', `Node ${node.metadata.name} stopped sending heartbeats for 40s → marked NotReady and tainted unreachable. Pods there get ${'tolerationSeconds'} (default 300s) before eviction.`, 'bad');
          // pods on the node are no longer ready
          this.podsOnNode(node.metadata.name).forEach(p => { setCond(p, 'Ready', 'False', undefined, undefined, now); setCond(p, 'ContainersReady', 'False', undefined, undefined, now); this.put(p); });
        }
        if (!hasT('node.kubernetes.io/unreachable')) {
          taints.push({ key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule', timeAdded: now });
          taints.push({ key: 'node.kubernetes.io/unreachable', effect: 'NoExecute', timeAdded: now });
          node.spec.taints = taints;
        }
      }
      if (JSON.stringify([node.status.conditions, node.spec.taints]) !== before) this.put(node);
      // NoExecute taint manager
      const noExec = (node.spec.taints || []).filter(t => t.effect === 'NoExecute');
      if (noExec.length) {
        for (const p of this.podsOnNode(node.metadata.name)) {
          if (p.metadata.deletionTimestamp) continue;
          for (const t of noExec) {
            const tol = (p.spec.tolerations || []).find(x => this.tolerates([x], t));
            const added = Date.parse(t.timeAdded || node.metadata.creationTimestamp);
            if (!tol || (tol.tolerationSeconds != null && this.now >= added + tol.tolerationSeconds * 1000)) {
              this.event(p, 'Normal', 'TaintManagerEviction', `Marking for deletion Pod ${p.metadata.namespace}/${p.metadata.name}`, 'taint-eviction-controller');
              this.delete('Pod', p.metadata.namespace, p.metadata.name, { internal: true });
              if (userNs(p.metadata.namespace)) this.narrate('🚪', `Taint ${t.key}:NoExecute on ${node.metadata.name} evicted Pod ${p.metadata.name}${tol ? ` after its ${tol.tolerationSeconds}s toleration ran out` : ' (it has no toleration)'}.`, 'warn');
              break;
            }
          }
        }
      }
    }
  };

  // ======================================================================= Endpoints / LB / Ingress status
  C.resolveTargetPort = function (pod, tp) {
    if (typeof tp === 'number' || /^\d+$/.test(String(tp))) return +tp;
    for (const c of pod.spec.containers) for (const p of c.ports || []) if (p.name === tp) return p.containerPort;
    return null;
  };
  C.endpointsController = function () {
    for (const svc of this.ls('Service')) {
      if (!svc.spec.selector || svc.spec.type === 'ExternalName') continue;
      const ns = svc.metadata.namespace;
      const pods = this.ls('Pod', ns).filter(p => U.matchMapSelector(svc.spec.selector, p.metadata.labels) && p.status.podIP && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
      const subsetsMap = {};
      for (const p of pods) {
        const ports = (svc.spec.ports || []).map(sp => ({ name: sp.name, port: this.resolveTargetPort(p, sp.targetPort), protocol: sp.protocol || 'TCP' }));
        if (ports.some(x => x.port == null)) continue;
        const key = JSON.stringify(ports);
        const s = subsetsMap[key] = subsetsMap[key] || { addresses: [], notReadyAddresses: [], ports: ports.map(x => { const o = { port: x.port, protocol: x.protocol }; if (x.name) o.name = x.name; return o; }) };
        const addr = { ip: p.status.podIP, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: ns, uid: p.metadata.uid } };
        if (p.spec.hostname) addr.hostname = p.spec.hostname;
        if (isReady(p) && !p.metadata.deletionTimestamp) s.addresses.push(addr); else s.notReadyAddresses.push(addr);
      }
      const subsets = Object.values(subsetsMap).map(s => { if (!s.addresses.length) delete s.addresses; if (!s.notReadyAddresses.length) delete s.notReadyAddresses; return s; }).filter(s => s.addresses || s.notReadyAddresses);
      subsets.forEach(s => { (s.addresses || []).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })); });
      let ep = this.get('Endpoints', ns, svc.metadata.name);
      const readyCount = subsets.reduce((n, s) => n + (s.addresses || []).length, 0);
      if (!ep) {
        this.createInternal({ apiVersion: 'v1', kind: 'Endpoints', metadata: { name: svc.metadata.name, namespace: ns, labels: svc.metadata.labels && Object.keys(svc.metadata.labels).length ? Object.assign({}, svc.metadata.labels) : undefined, annotations: { 'endpoints.kubernetes.io/last-change-trigger-time': this.ts() } }, subsets: subsets.length ? subsets : undefined });
        ep = this.get('Endpoints', ns, svc.metadata.name);
        if (!ep.subsets) delete ep.subsets;
        this.rt.epCount = this.rt.epCount || {};
        this.rt.epCount[svc.metadata.uid] = readyCount;
        continue;
      }
      if (JSON.stringify(ep.subsets || []) !== JSON.stringify(subsets)) {
        if (subsets.length) ep.subsets = subsets; else delete ep.subsets;
        ep.metadata.annotations = Object.assign({}, ep.metadata.annotations, { 'endpoints.kubernetes.io/last-change-trigger-time': this.ts() });
        this.put(ep);
        this.rt.epCount = this.rt.epCount || {};
        const prev = this.rt.epCount[svc.metadata.uid];
        if (prev !== readyCount && userNs(ns)) {
          this.narrate('🔗', readyCount ? `Service ${svc.metadata.name} now routes to ${readyCount} ready Pod${readyCount === 1 ? '' : 's'}.` : `Service ${svc.metadata.name} has NO ready endpoints — traffic to it will fail.`, readyCount ? 'info' : 'warn');
        }
        this.rt.epCount[svc.metadata.uid] = readyCount;
      }
    }
  };
  C.serviceLBController = function () {
    for (const svc of this.ls('Service')) {
      if (svc.spec.type !== 'LoadBalancer') {
        if (svc.status && svc.status.loadBalancer && svc.status.loadBalancer.ingress) { svc.status.loadBalancer = {}; this.put(svc); }
        continue;
      }
      const lb = (svc.status = svc.status || {}).loadBalancer = svc.status.loadBalancer || {};
      if (lb.ingress && lb.ingress.length) continue;
      const rt = (this.rt.lb = this.rt.lb || {})[svc.metadata.uid] = (this.rt.lb || {})[svc.metadata.uid] || { at: this.now + 2500 };
      if (!rt.evented) { rt.evented = true; this.event(svc, 'Normal', 'EnsuringLoadBalancer', 'Ensuring load balancer', 'service-controller'); }
      if (this.now >= rt.at) {
        const ip = svc.metadata.name === 'ingress-nginx-controller' ? '203.0.113.10' : `203.0.113.${this.rt.lbNext++}`;
        lb.ingress = [{ ip, ipMode: 'VIP' }];
        this.put(svc);
        this.event(svc, 'Normal', 'EnsuredLoadBalancer', 'Ensured load balancer', 'service-controller');
        if (userNs(svc.metadata.namespace)) this.narrate('☁️', `Cloud load balancer for Service ${svc.metadata.name} is ready at ${ip} (simulated cloud).`, 'good');
      }
    }
  };
  C.ingressController = function () {
    // the ingress-nginx controller exists if its pods are running
    return this.ls('Pod').filter(p => (p.metadata.labels || {})['app.kubernetes.io/name'] === 'ingress-nginx' && (p.metadata.labels || {})['app.kubernetes.io/component'] === 'controller' && isReady(p));
  };
  C.ingressClassFor = function (ing) {
    const cls = ing.spec.ingressClassName || (ing.metadata.annotations || {})['kubernetes.io/ingress.class'];
    if (cls) return this.get('IngressClass', '', cls);
    return this.ls('IngressClass').find(c => (c.metadata.annotations || {})['ingressclass.kubernetes.io/is-default-class'] === 'true') || null;
  };
  C.ingressStatusController = function () {
    const ctrlPods = this.ingressController();
    const svc = this.get('Service', 'ingress-nginx', 'ingress-nginx-controller');
    const ip = svc && svc.status && svc.status.loadBalancer && svc.status.loadBalancer.ingress && svc.status.loadBalancer.ingress[0].ip;
    for (const ing of this.ls('Ingress')) {
      const cls = this.ingressClassFor(ing);
      const handled = ctrlPods.length && ip && cls && cls.spec.controller === 'k8s.io/ingress-nginx';
      const want = handled ? [{ ip }] : undefined;
      const cur = ing.status.loadBalancer.ingress;
      if (JSON.stringify(cur) !== JSON.stringify(want)) {
        if (want) ing.status.loadBalancer.ingress = want; else delete ing.status.loadBalancer.ingress;
        this.put(ing);
        if (want) {
          this.event(ing, 'Normal', 'Sync', 'Scheduled for sync', 'nginx-ingress-controller');
          if (userNs(ing.metadata.namespace)) this.narrate('🚪', `Ingress controller picked up Ingress ${ing.metadata.name} and serves it at ${ip}.`, 'good');
        }
      }
    }
  };

  // ======================================================================= PDB / quota status / events TTL
  C.pdbController = function () {
    for (const pdb of this.ls('PodDisruptionBudget')) {
      const pods = this.ls('Pod', pdb.metadata.namespace).filter(p => !p.metadata.deletionTimestamp && isActive(p) && U.matchSelector(pdb.spec.selector, p.metadata.labels));
      const expected = pods.length;
      const healthy = pods.filter(isReady).length;
      let desired;
      if (pdb.spec.minAvailable != null) desired = intOrPct(pdb.spec.minAvailable, expected, true);
      else if (pdb.spec.maxUnavailable != null) desired = expected - intOrPct(pdb.spec.maxUnavailable, expected, true);
      else desired = expected;
      const st = { currentHealthy: healthy, desiredHealthy: desired, disruptionsAllowed: Math.max(0, healthy - desired), expectedPods: expected, observedGeneration: pdb.metadata.generation };
      const prev = pdb.status || {};
      const now = this.ts();
      st.conditions = prev.conditions || [];
      const tmp = { status: st };
      setCond(tmp, 'DisruptionAllowed', st.disruptionsAllowed > 0 ? 'True' : 'False', st.disruptionsAllowed > 0 ? 'SufficientPods' : 'InsufficientPods', '', now);
      tmp.status.conditions.forEach(c => delete c.lastUpdateTime);
      const cmp = o => JSON.stringify(Object.assign({}, o, { conditions: (o.conditions || []).map(c => c.status) }));
      if (cmp(st) !== cmp(prev)) { pdb.status = st; this.put(pdb); }
    }
  };
  C.quotaStatusController = function () {
    for (const q of this.ls('ResourceQuota')) {
      const used = this.quotaUsage(q.metadata.namespace);
      const st = { hard: Object.assign({}, q.spec.hard || {}), used: {} };
      for (const k of Object.keys(st.hard)) {
        const key = k === 'cpu' ? 'requests.cpu' : k === 'memory' ? 'requests.memory' : k;
        const v = used[key] || 0;
        st.used[k] = key.endsWith('cpu') ? U.fmtCpu(v) : (key.endsWith('memory') || key.endsWith('storage')) ? (v ? U.fmtMem(v) : '0') : String(v);
      }
      if (JSON.stringify(st) !== JSON.stringify(q.status)) { q.status = st; this.put(q); }
    }
  };
  C.eventTTL = function () {
    this.rt.evNext = this.rt.evNext || 0;
    if (this.now < this.rt.evNext) return;
    this.rt.evNext = this.now + 10000;
    for (const e of [...this.objs.Event.values()]) if (this.now - Date.parse(e.lastTimestamp) > 3600000) this.remove(e);
  };
})(typeof window !== 'undefined' ? window : globalThis);
