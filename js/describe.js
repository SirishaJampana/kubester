/* Kubester — `kubectl describe` printers (tabwriter-aligned like the real kubectl). */
(function (G) {
  'use strict';
  const KS = G.KS;
  const U = KS.util;

  // Go text/tabwriter (minwidth 0, padding 2): cells are '\t'-terminated; a column block is a run of lines that all have that cell.
  function tabwrite(text, padding) {
    padding = padding == null ? 2 : padding;
    const lines = text.split('\n').map(l => l.split('\t'));
    const widths = lines.map(() => []);
    function format(start, end, col) {
      let i = start;
      while (i < end) {
        if (lines[i].length - 1 <= col) { i++; continue; }
        let j = i, w = 0;
        while (j < end && lines[j].length - 1 > col) { w = Math.max(w, lines[j][col].length); j++; }
        for (let k = i; k < j; k++) widths[k][col] = w + padding;
        format(i, j, col + 1);
        i = j;
      }
    }
    format(0, lines.length, 0);
    return lines.map((cells, li) => cells.map((c, ci) => (ci < cells.length - 1 ? c.padEnd(widths[li][ci] || c.length + padding) : c)).join('').replace(/\s+$/, '')).join('\n');
  }

  const L1 = '  ', L2 = '    ', L3 = '      ';
  function fmtDate(iso) {
    if (!iso) return '<unset>';
    const d = new Date(iso);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = n => String(n).padStart(2, '0');
    return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${mons[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
  }
  function mapLines(out, label, m, indent) {
    indent = indent || '';
    const keys = Object.keys(m || {}).sort();
    if (!keys.length) { out.push(`${indent}${label}\t<none>`); return; }
    keys.forEach((k, i) => out.push(`${i === 0 ? indent + label : ''}\t${k}=${m[k]}`));
  }
  function annLines(out, label, m, indent) {
    indent = indent || '';
    const keys = Object.keys(m || {}).filter(k => k !== 'kubectl.kubernetes.io/last-applied-configuration' || true).sort();
    if (!keys.length) { out.push(`${indent}${label}\t<none>`); return; }
    keys.forEach((k, i) => {
      let v = m[k];
      if (k === 'kubectl.kubernetes.io/last-applied-configuration') v = '\n' + indent + '  ' + v.trim();
      out.push(`${i === 0 ? indent + label : ''}\t${k}: ${v}`);
    });
  }
  function events(c, obj, out) {
    const evs = c.eventsFor(obj);
    if (!evs.length) { out.push('Events:\t<none>'); return; }
    out.push('Events:');
    out.push(`${L1}Type\tReason\tAge\tFrom\tMessage`);
    out.push(`${L1}----\t------\t----\t----\t-------`);
    for (const e of evs) {
      const first = Date.parse(e.firstTimestamp), last = Date.parse(e.lastTimestamp);
      const age = e.count > 1 ? `${U.humanDuration(c.now - last)} (x${e.count} over ${U.humanDuration(c.now - first)})` : U.humanDuration(c.now - first);
      out.push(`${L1}${e.type}\t${e.reason}\t${age}\t${e.source.component}\t${e.message}`);
    }
  }
  function probeStr(p) {
    let s = '';
    if (p.httpGet) s = `http-get ${(p.httpGet.scheme || 'HTTP').toLowerCase()}://${p.httpGet.host || ''}:${p.httpGet.port}${p.httpGet.path || '/'}`;
    else if (p.tcpSocket) s = `tcp-socket :${p.tcpSocket.port}`;
    else if (p.exec) s = `exec [${(p.exec.command || []).join(' ')}]`;
    else if (p.grpc) s = `grpc <pod>:${p.grpc.port}`;
    return `${s} delay=${p.initialDelaySeconds || 0}s timeout=${p.timeoutSeconds || 1}s period=${p.periodSeconds || 10}s #success=${p.successThreshold || 1} #failure=${p.failureThreshold || 3}`;
  }
  function stateLines(out, label, st, indent) {
    if (!st || !Object.keys(st).length) { if (label === 'State') out.push(`${indent}${label}:\tWaiting`); return; }
    if (st.running) { out.push(`${indent}${label}:\tRunning`); out.push(`${indent}  Started:\t${fmtDate(st.running.startedAt)}`); }
    else if (st.waiting) { out.push(`${indent}${label}:\tWaiting`); out.push(`${indent}  Reason:\t${st.waiting.reason}`); if (st.waiting.message && label === 'State' && !/ContainerCreating|PodInitializing/.test(st.waiting.reason)) out.push(`${indent}  Message:\t${st.waiting.message}`); }
    else if (st.terminated) {
      out.push(`${indent}${label}:\tTerminated`);
      out.push(`${indent}  Reason:\t${st.terminated.reason}`);
      if (st.terminated.message) out.push(`${indent}  Message:\t${st.terminated.message}`);
      out.push(`${indent}  Exit Code:\t${st.terminated.exitCode}`);
      out.push(`${indent}  Started:\t${fmtDate(st.terminated.startedAt)}`);
      out.push(`${indent}  Finished:\t${fmtDate(st.terminated.finishedAt)}`);
    }
  }
  function envLines(out, c, indent, pod, cluster) {
    const env = c.env || [];
    const ef = c.envFrom || [];
    if (!env.length && !ef.length) { out.push(`${indent}Environment:\t<none>`); return; }
    if (ef.length) {
      out.push(`${indent}Environment Variables from:`);
      ef.forEach(e => {
        if (e.configMapRef) out.push(`${indent}  ${e.configMapRef.name}\tConfigMap\tOptional: ${!!e.configMapRef.optional}`);
        if (e.secretRef) out.push(`${indent}  ${e.secretRef.name}\tSecret\tOptional: ${!!e.secretRef.optional}`);
      });
    }
    if (!env.length) { out.push(`${indent}Environment:\t<none>`); return; }
    out.push(`${indent}Environment:`);
    env.forEach(e => {
      if (e.valueFrom) {
        const v = e.valueFrom;
        if (v.configMapKeyRef) out.push(`${indent}  ${e.name}:\t<set to the key '${v.configMapKeyRef.key}' of config map '${v.configMapKeyRef.name}'>\tOptional: ${!!v.configMapKeyRef.optional}`);
        else if (v.secretKeyRef) out.push(`${indent}  ${e.name}:\t<set to the key '${v.secretKeyRef.key}' in secret '${v.secretKeyRef.name}'>\tOptional: ${!!v.secretKeyRef.optional}`);
        else if (v.fieldRef) out.push(`${indent}  ${e.name}:\t${pod && cluster ? cluster.fieldRef(pod, v.fieldRef.fieldPath) : ''} (${v.fieldRef.apiVersion || 'v1'}:${v.fieldRef.fieldPath})`);
        else if (v.resourceFieldRef) out.push(`${indent}  ${e.name}:\t${v.resourceFieldRef.resource}`);
      } else out.push(`${indent}  ${e.name}:\t${e.value == null ? '' : e.value}`);
    });
  }
  function resourcesLines(out, c, indent) {
    const r = c.resources || {};
    ['limits', 'requests'].forEach(kind => {
      const m = r[kind];
      if (m && Object.keys(m).length) {
        out.push(`${indent}${kind[0].toUpperCase() + kind.slice(1)}:`);
        Object.keys(m).sort().forEach(k => out.push(`${indent}  ${k}:\t${m[k]}`));
      }
    });
  }
  function containerBlock(out, c, cs, indent, pod, cluster, isTemplate) {
    out.push(`${indent}${c.name}:`);
    const i2 = indent + '  ';
    if (!isTemplate) {
      if (cs && cs.containerID) out.push(`${i2}Container ID:\t${cs.containerID}`);
    }
    out.push(`${i2}Image:\t${c.image}`);
    if (!isTemplate) out.push(`${i2}Image ID:\t${(cs && cs.imageID) || ''}`);
    const ports = c.ports || [];
    if (ports.length <= 1) {
      out.push(`${i2}Port:\t${ports.length ? `${ports[0].containerPort}/${ports[0].protocol || 'TCP'}` : '<none>'}`);
      out.push(`${i2}Host Port:\t${ports.length ? `${ports[0].hostPort || 0}/${ports[0].protocol || 'TCP'}` : '<none>'}`);
    } else {
      out.push(`${i2}Ports:\t${ports.map(p => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', ')}`);
      out.push(`${i2}Host Ports:\t${ports.map(p => `${p.hostPort || 0}/${p.protocol || 'TCP'}`).join(', ')}`);
    }
    if (c.command) { out.push(`${i2}Command:`); c.command.forEach(x => out.push(`${i2}  ${x}`)); }
    if (c.args) { out.push(`${i2}Args:`); c.args.forEach(x => out.push(`${i2}  ${x}`)); }
    if (!isTemplate) {
      stateLines(out, 'State', cs && cs.state, i2);
      if (cs && cs.lastState && Object.keys(cs.lastState).length) stateLines(out, 'Last State', cs.lastState, i2);
      out.push(`${i2}Ready:\t${cs ? (cs.ready ? 'True' : 'False') : 'False'}`);
      out.push(`${i2}Restart Count:\t${cs ? cs.restartCount : 0}`);
    }
    resourcesLines(out, c, i2);
    if (c.livenessProbe) out.push(`${i2}Liveness:\t${probeStr(c.livenessProbe)}`);
    if (c.readinessProbe) out.push(`${i2}Readiness:\t${probeStr(c.readinessProbe)}`);
    if (c.startupProbe) out.push(`${i2}Startup:\t${probeStr(c.startupProbe)}`);
    envLines(out, c, i2, pod, cluster);
    const mounts = c.volumeMounts || [];
    if (!mounts.length) out.push(`${i2}Mounts:\t<none>`);
    else { out.push(`${i2}Mounts:`); mounts.forEach(m => out.push(`${i2}  ${m.mountPath}${m.subPath ? ` from ${m.name} (${m.readOnly ? 'ro' : 'rw'},path="${m.subPath}")` : ` from ${m.name} (${m.readOnly ? 'ro' : 'rw'})`}`)); }
  }
  function volumesLines(out, vols, indent) {
    indent = indent || '';
    if (!vols || !vols.length) { out.push(`${indent}Volumes:\t<none>`); return; }
    out.push(`${indent}Volumes:`);
    const i1 = indent + '  ', i2 = indent + '    ';
    for (const v of vols) {
      out.push(`${i1}${v.name}:`);
      if (v.configMap) { out.push(`${i2}Type:\tConfigMap (a volume populated by a ConfigMap)`); out.push(`${i2}Name:\t${v.configMap.name}`); out.push(`${i2}Optional:\t${!!v.configMap.optional}`); }
      else if (v.secret) { out.push(`${i2}Type:\tSecret (a volume populated by a Secret)`); out.push(`${i2}SecretName:\t${v.secret.secretName}`); out.push(`${i2}Optional:\t${!!v.secret.optional}`); }
      else if (v.persistentVolumeClaim) { out.push(`${i2}Type:\tPersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)`); out.push(`${i2}ClaimName:\t${v.persistentVolumeClaim.claimName}`); out.push(`${i2}ReadOnly:\t${!!v.persistentVolumeClaim.readOnly}`); }
      else if (v.emptyDir) { out.push(`${i2}Type:\tEmptyDir (a temporary directory that shares a pod's lifetime)`); out.push(`${i2}Medium:\t${v.emptyDir.medium || ''}`); out.push(`${i2}SizeLimit:\t${v.emptyDir.sizeLimit || '<unset>'}`); }
      else if (v.hostPath) { out.push(`${i2}Type:\tHostPath (bare host directory volume)`); out.push(`${i2}Path:\t${v.hostPath.path}`); out.push(`${i2}HostPathType:\t${v.hostPath.type || ''}`); }
      else if (v.projected) { out.push(`${i2}Type:\tProjected (a volume that contains injected data from multiple sources)`); out.push(`${i2}TokenExpirationSeconds:\t3607`); out.push(`${i2}ConfigMapName:\tkube-root-ca.crt`); out.push(`${i2}Optional:\tfalse`); out.push(`${i2}DownwardAPI:\ttrue`); }
      else if (v.downwardAPI) out.push(`${i2}Type:\tDownwardAPI (a volume populated by information about the pod)`);
      else out.push(`${i2}Type:\t<unknown>`);
    }
  }
  function tolerationsLines(out, tols, label) {
    label = label || 'Tolerations:';
    if (!tols || !tols.length) { out.push(`${label}\t<none>`); return; }
    tols.forEach((t, i) => {
      let s = t.key || '';
      if (t.value) s += '=' + t.value;
      if (t.effect) s += ':' + t.effect;
      if (t.operator === 'Exists') s += (s ? ' ' : '') + 'op=Exists';
      if (t.tolerationSeconds != null) s += ` for ${t.tolerationSeconds}s`;
      out.push(`${i === 0 ? label : ''}\t${s}`);
    });
  }
  function podTemplate(out, tpl, cluster) {
    out.push('Pod Template:');
    mapLines(out, 'Labels:', tpl.metadata.labels, L1);
    if (tpl.metadata.annotations && Object.keys(tpl.metadata.annotations).length) annLines(out, 'Annotations:', tpl.metadata.annotations, L1);
    if (tpl.spec.serviceAccountName && tpl.spec.serviceAccountName !== 'default') out.push(`${L1}Service Account:\t${tpl.spec.serviceAccountName}`);
    if ((tpl.spec.initContainers || []).length) { out.push(`${L1}Init Containers:`); tpl.spec.initContainers.forEach(c => containerBlock(out, c, null, L2.slice(0, 3), null, cluster, true)); }
    out.push(`${L1}Containers:`);
    tpl.spec.containers.forEach(c => containerBlock(out, c, null, '   ', null, cluster, true));
    volumesLines(out, (tpl.spec.volumes || []).filter(v => !v.name.startsWith('kube-api-access')), L1);
    out.push(`${L1}Node-Selectors:\t${tpl.spec.nodeSelector ? U.labelsToString(tpl.spec.nodeSelector) : '<none>'}`);
    tolerationsLines(out, tpl.spec.tolerations, `${L1}Tolerations:`);
  }

  function describe(c, obj) {
    const out = [];
    const md = obj.metadata;
    const head = (withNs) => { out.push(`Name:\t${md.name}`); if (withNs && md.namespace) out.push(`Namespace:\t${md.namespace}`); };
    switch (obj.kind) {
      case 'Pod': {
        const s = obj.spec, st = obj.status;
        head(true);
        out.push(`Priority:\t${s.priority || 0}`);
        if (s.priorityClassName) out.push(`Priority Class Name:\t${s.priorityClassName}`);
        out.push(`Service Account:\t${s.serviceAccountName || 'default'}`);
        out.push(`Node:\t${s.nodeName ? `${s.nodeName}/${st.hostIP || ''}` : '<none>'}`);
        if (st.startTime) out.push(`Start Time:\t${fmtDate(st.startTime)}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        if (md.deletionTimestamp) { out.push(`Status:\tTerminating (lasts ${U.humanDuration(Date.parse(md.deletionTimestamp) - c.now + 0)})`); out.push(`Termination Grace Period:\t${md.deletionGracePeriodSeconds}s`); }
        else out.push(`Status:\t${st.phase}`);
        if (st.reason) out.push(`Reason:\t${st.reason}`);
        if (st.message) out.push(`Message:\t${st.message}`);
        if (s.securityContext && s.securityContext.seccompProfile) out.push(`SeccompProfile:\t${s.securityContext.seccompProfile.type}`);
        out.push(`IP:\t${st.podIP || ''}`);
        out.push('IPs:');
        if (st.podIP) out.push(`${L1}IP:\t${st.podIP}`); else { out.pop(); out.push('IPs:\t<none>'); }
        const ref = (md.ownerReferences || []).find(r => r.controller);
        if (ref) out.push(`Controlled By:\t${ref.kind}/${ref.name}`);
        if ((s.initContainers || []).length) {
          out.push('Init Containers:');
          s.initContainers.forEach(ct => containerBlock(out, ct, (st.initContainerStatuses || []).find(x => x.name === ct.name), L1, obj, c));
        }
        out.push('Containers:');
        s.containers.forEach(ct => containerBlock(out, ct, (st.containerStatuses || []).find(x => x.name === ct.name), L1, obj, c));
        if ((s.ephemeralContainers || []).length) {
          out.push('Ephemeral Containers:');
          s.ephemeralContainers.forEach(ct => containerBlock(out, ct, (st.ephemeralContainerStatuses || []).find(x => x.name === ct.name), L1, obj, c));
        }
        out.push('Conditions:');
        out.push(`${L1}Type\tStatus`);
        (st.conditions || []).forEach(cd => out.push(`${L1}${cd.type}\t${cd.status}`));
        volumesLines(out, s.volumes);
        out.push(`QoS Class:\t${st.qosClass || KS.qosClass(obj)}`);
        out.push(`Node-Selectors:\t${s.nodeSelector ? U.labelsToString(s.nodeSelector) : '<none>'}`);
        tolerationsLines(out, s.tolerations);
        events(c, obj, out);
        break;
      }
      case 'Node': {
        const s = obj.spec, st = obj.status;
        out.push(`Name:\t${md.name}`);
        const roles = Object.keys(md.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]);
        out.push(`Roles:\t${roles.join(',') || '<none>'}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`CreationTimestamp:\t${fmtDate(md.creationTimestamp)}`);
        const taints = s.taints || [];
        if (!taints.length) out.push('Taints:\t<none>');
        else taints.forEach((t, i) => out.push(`${i === 0 ? 'Taints:' : ''}\t${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`));
        out.push(`Unschedulable:\t${!!s.unschedulable}`);
        out.push('Conditions:');
        out.push(`${L1}Type\tStatus\tLastHeartbeatTime\tLastTransitionTime\tReason\tMessage`);
        out.push(`${L1}----\t------\t-----------------\t------------------\t------\t-------`);
        (st.conditions || []).forEach(cd => out.push(`${L1}${cd.type}\t${cd.status}\t${fmtDate(cd.lastHeartbeatTime)}\t${fmtDate(cd.lastTransitionTime)}\t${cd.reason}\t${cd.message}`));
        out.push('Addresses:');
        st.addresses.forEach(a => out.push(`${L1}${a.type}:\t${a.address}`));
        out.push('Capacity:');
        Object.keys(st.capacity).forEach(k => out.push(`${L1}${k}:\t${st.capacity[k]}`));
        out.push('Allocatable:');
        Object.keys(st.allocatable).forEach(k => out.push(`${L1}${k}:\t${st.allocatable[k]}`));
        out.push('System Info:');
        const ni = st.nodeInfo;
        [['Kernel Version', ni.kernelVersion], ['OS Image', ni.osImage], ['Operating System', ni.operatingSystem], ['Architecture', ni.architecture], ['Container Runtime Version', ni.containerRuntimeVersion], ['Kubelet Version', ni.kubeletVersion]].forEach(([k, v]) => out.push(`${L1}${k}:\t${v}`));
        out.push(`PodCIDR:\t${s.podCIDR}`);
        out.push(`PodCIDRs:\t${(s.podCIDRs || []).join(',')}`);
        const pods = c.list('Pod').filter(p => p.spec.nodeName === md.name && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
        const capCpu = U.parseCpu(st.allocatable.cpu), capMem = U.parseMem(st.allocatable.memory);
        out.push(`Non-terminated Pods:\t(${pods.length} in total)`);
        out.push(`${L1}Namespace\tName\tCPU Requests\tCPU Limits\tMemory Requests\tMemory Limits\tAge`);
        out.push(`${L1}---------\t----\t------------\t----------\t---------------\t-------------\t---`);
        let tot = { rc: 0, lc: 0, rm: 0, lm: 0 };
        for (const p of pods) {
          let rc = 0, lc = 0, rm = 0, lm = 0;
          p.spec.containers.forEach(ct => { const r = ct.resources || {}; rc += U.parseCpu((r.requests || {}).cpu || 0); lc += U.parseCpu((r.limits || {}).cpu || 0); rm += U.parseMem((r.requests || {}).memory || 0); lm += U.parseMem((r.limits || {}).memory || 0); });
          tot.rc += rc; tot.lc += lc; tot.rm += rm; tot.lm += lm;
          const pc = (v, cap) => `${Math.floor((v / cap) * 100)}%`;
          out.push(`${L1}${p.metadata.namespace}\t${p.metadata.name}\t${rc ? U.fmtCpu(rc) : '0'} (${pc(rc, capCpu)})\t${lc ? U.fmtCpu(lc) : '0'} (${pc(lc, capCpu)})\t${rm ? U.fmtMem(rm) : '0'} (${pc(rm, capMem)})\t${lm ? U.fmtMem(lm) : '0'} (${pc(lm, capMem)})\t${c.age(p)}`);
        }
        out.push('Allocated resources:');
        out.push(`${L1}(Total limits may be over 100 percent, i.e., overcommitted.)`);
        out.push(`${L1}Resource\tRequests\tLimits`);
        out.push(`${L1}--------\t--------\t------`);
        out.push(`${L1}cpu\t${tot.rc ? U.fmtCpu(tot.rc) : '0'} (${Math.floor(tot.rc / capCpu * 100)}%)\t${tot.lc ? U.fmtCpu(tot.lc) : '0'} (${Math.floor(tot.lc / capCpu * 100)}%)`);
        out.push(`${L1}memory\t${tot.rm ? U.fmtMem(tot.rm) : '0'} (${Math.floor(tot.rm / capMem * 100)}%)\t${tot.lm ? U.fmtMem(tot.lm) : '0'} (${Math.floor(tot.lm / capMem * 100)}%)`);
        out.push(`${L1}ephemeral-storage\t0 (0%)\t0 (0%)`);
        events(c, obj, out);
        break;
      }
      case 'Deployment': {
        const s = obj.spec, st = obj.status || {};
        head(true);
        out.push(`CreationTimestamp:\t${fmtDate(md.creationTimestamp)}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Selector:\t${U.selectorToString(s.selector)}`);
        out.push(`Replicas:\t${s.replicas} desired | ${st.updatedReplicas || 0} updated | ${st.replicas || 0} total | ${st.availableReplicas || 0} available | ${st.unavailableReplicas || 0} unavailable`);
        out.push(`StrategyType:\t${s.strategy.type}`);
        out.push(`MinReadySeconds:\t${s.minReadySeconds || 0}`);
        if (s.strategy.type === 'RollingUpdate') out.push(`RollingUpdateStrategy:\t${s.strategy.rollingUpdate.maxUnavailable} max unavailable, ${s.strategy.rollingUpdate.maxSurge} max surge`);
        podTemplate(out, s.template, c);
        out.push('Conditions:');
        out.push(`${L1}Type\tStatus\tReason`);
        out.push(`${L1}----\t------\t------`);
        (st.conditions || []).forEach(cd => out.push(`${L1}${cd.type}\t${cd.status}\t${cd.reason}`));
        const rss = c.list('ReplicaSet', md.namespace).filter(rs => (rs.metadata.ownerReferences || []).some(r => r.uid === md.uid));
        const hash = c.templateHash(s.template);
        const newRS = rss.find(rs => (rs.metadata.labels || {})['pod-template-hash'] === hash);
        const olds = rss.filter(rs => rs !== newRS && rs.spec.replicas > 0);
        out.push(`OldReplicaSets:\t${olds.length ? olds.map(rs => `${rs.metadata.name} (${(rs.status || {}).replicas || 0}/${rs.spec.replicas} replicas created)`).join(', ') : '<none>'}`);
        out.push(`NewReplicaSet:\t${newRS ? `${newRS.metadata.name} (${(newRS.status || {}).replicas || 0}/${newRS.spec.replicas} replicas created)` : '<none>'}`);
        events(c, obj, out);
        break;
      }
      case 'ReplicaSet': {
        const s = obj.spec, st = obj.status || {};
        head(true);
        out.push(`Selector:\t${U.selectorToString(s.selector)}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        const ref = (md.ownerReferences || []).find(r => r.controller);
        if (ref) out.push(`Controlled By:\t${ref.kind}/${ref.name}`);
        out.push(`Replicas:\t${st.replicas || 0} current / ${s.replicas} desired`);
        const pods = c.podsOf(obj);
        const cnt = ph => pods.filter(p => p.status.phase === ph).length;
        out.push(`Pods Status:\t${cnt('Running')} Running / ${cnt('Pending')} Waiting / ${cnt('Succeeded')} Succeeded / ${cnt('Failed')} Failed`);
        podTemplate(out, s.template, c);
        events(c, obj, out);
        break;
      }
      case 'Service': {
        const s = obj.spec;
        head(true);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Selector:\t${s.selector ? Object.keys(s.selector).map(k => `${k}=${s.selector[k]}`).join(',') : '<none>'}`);
        out.push(`Type:\t${s.type}`);
        if (s.type === 'ExternalName') out.push(`External Name:\t${s.externalName}`);
        else {
          out.push(`IP Family Policy:\t${s.ipFamilyPolicy || 'SingleStack'}`);
          out.push(`IP Families:\tIPv4`);
          out.push(`IP:\t${s.clusterIP}`);
          out.push(`IPs:\t${s.clusterIP}`);
        }
        const lb = (obj.status && obj.status.loadBalancer && obj.status.loadBalancer.ingress) || [];
        if (lb.length) out.push(`LoadBalancer Ingress:\t${lb.map(i => i.ip).join(', ')} (${lb[0].ipMode || 'VIP'})`);
        const ep = c.get('Endpoints', md.namespace, md.name);
        for (const p of s.ports || []) {
          out.push(`Port:\t${p.name || '<unset>'}\t${p.port}/${p.protocol}`);
          out.push(`TargetPort:\t${p.targetPort}/${p.protocol}`);
          if (p.nodePort) out.push(`NodePort:\t${p.name || '<unset>'}\t${p.nodePort}/${p.protocol}`);
          const addrs = ((ep && ep.subsets) || []).flatMap(sub => (sub.addresses || []).map(a => `${a.ip}:${(sub.ports.find(x => x.name === p.name) || sub.ports[0]).port}`));
          if (s.type !== 'ExternalName') out.push(`Endpoints:\t${addrs.join(',') || ''}`);
        }
        out.push(`Session Affinity:\t${s.sessionAffinity || 'None'}`);
        if (s.externalTrafficPolicy) out.push(`External Traffic Policy:\t${s.externalTrafficPolicy}`);
        out.push(`Internal Traffic Policy:\t${s.internalTrafficPolicy || 'Cluster'}`);
        events(c, obj, out);
        break;
      }
      case 'Endpoints': {
        head(true);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push('Subsets:');
        for (const sub of obj.subsets || []) {
          out.push(`${L1}Addresses:\t${(sub.addresses || []).map(a => a.ip).join(',') || '<none>'}`);
          out.push(`${L1}NotReadyAddresses:\t${(sub.notReadyAddresses || []).map(a => a.ip).join(',') || '<none>'}`);
          out.push(`${L1}Ports:`);
          out.push(`${L2}Name\tPort\tProtocol`);
          out.push(`${L2}----\t----\t--------`);
          sub.ports.forEach(p => out.push(`${L2}${p.name || '<unset>'}\t${p.port}\t${p.protocol}`));
        }
        out.push('');
        events(c, obj, out);
        break;
      }
      case 'ConfigMap': {
        head(true);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push('');
        out.push('Data');
        out.push('====');
        Object.keys(obj.data || {}).sort().forEach(k => { out.push(`${k}:`); out.push('----'); out.push(obj.data[k]); out.push(''); });
        out.push('');
        out.push('BinaryData');
        out.push('====');
        out.push('');
        events(c, obj, out);
        break;
      }
      case 'Secret': {
        head(true);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push('');
        out.push(`Type:\t${obj.type}`);
        out.push('');
        out.push('Data');
        out.push('====');
        Object.keys(obj.data || {}).sort().forEach(k => out.push(`${k}:\t${U.b64decode(obj.data[k]).length} bytes`));
        break;
      }
      case 'Namespace': {
        out.push(`Name:\t${md.name}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Status:\t${obj.status.phase}`);
        if ((obj.status.conditions || []).length) {
          out.push('Conditions:');
          out.push(`${L1}Type\tStatus\tLastTransitionTime\tReason\tMessage`);
          out.push(`${L1}----\t------\t------------------\t------\t-------`);
          obj.status.conditions.forEach(cd => out.push(`${L1}${cd.type}\t${cd.status}\t${fmtDate(cd.lastTransitionTime || c.ts())}\t${cd.reason}\t${cd.message}`));
        }
        out.push('');
        const quotas = c.list('ResourceQuota', md.name);
        if (!quotas.length) out.push('No resource quota.');
        quotas.forEach(q => {
          out.push('Resource Quotas');
          out.push(`${L1}Name:\t${q.metadata.name}`);
          out.push(`${L1}Resource\tUsed\tHard`);
          out.push(`${L1}--------\t---\t---`);
          Object.keys(q.spec.hard || {}).sort().forEach(k => out.push(`${L1}${k}\t${((q.status || {}).used || {})[k] || '0'}\t${q.spec.hard[k]}`));
        });
        out.push('');
        const lrs = c.list('LimitRange', md.name);
        if (!lrs.length) out.push('No LimitRange resource.');
        lrs.forEach(lr => {
          out.push('Resource Limits');
          out.push(`${L1}Type\tResource\tMin\tMax\tDefault Request\tDefault Limit\tMax Limit/Request Ratio`);
          out.push(`${L1}----\t--------\t---\t---\t---------------\t-------------\t-----------------------`);
          (lr.spec.limits || []).forEach(l => ['cpu', 'memory'].forEach(r => out.push(`${L1}${l.type}\t${r}\t${(l.min || {})[r] || '-'}\t${(l.max || {})[r] || '-'}\t${(l.defaultRequest || {})[r] || '-'}\t${(l.default || {})[r] || '-'}\t-`)));
        });
        break;
      }
      case 'PersistentVolumeClaim': {
        const s = obj.spec, st = obj.status || {};
        head(true);
        out.push(`StorageClass:\t${s.storageClassName || ''}`);
        out.push(`Status:\t${md.deletionTimestamp ? 'Terminating (lasts ' + U.humanDuration(c.now - Date.parse(md.deletionTimestamp)) + ')' : st.phase}`);
        out.push(`Volume:\t${s.volumeName || ''}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Finalizers:\t[${(md.finalizers || []).join(' ')}]`);
        out.push(`Capacity:\t${(st.capacity || {}).storage || ''}`);
        out.push(`Access Modes:\t${(st.accessModes || []).map(m => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m])).join(',')}`);
        out.push(`VolumeMode:\t${s.volumeMode}`);
        const users = c.list('Pod', md.namespace).filter(p => (p.spec.volumes || []).some(v => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === md.name)).map(p => p.metadata.name);
        out.push(`Used By:\t${users.join('\n\t') || '<none>'}`);
        events(c, obj, out);
        break;
      }
      case 'PersistentVolume': {
        const s = obj.spec;
        out.push(`Name:\t${md.name}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Finalizers:\t[${(md.finalizers || []).join(' ')}]`);
        out.push(`StorageClass:\t${s.storageClassName || ''}`);
        out.push(`Status:\t${obj.status.phase}`);
        out.push(`Claim:\t${s.claimRef ? `${s.claimRef.namespace}/${s.claimRef.name}` : ''}`);
        out.push(`Reclaim Policy:\t${s.persistentVolumeReclaimPolicy}`);
        out.push(`Access Modes:\t${(s.accessModes || []).map(m => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m])).join(',')}`);
        out.push(`VolumeMode:\t${s.volumeMode}`);
        out.push(`Capacity:\t${s.capacity.storage}`);
        if (s.nodeAffinity) { out.push('Node Affinity:'); out.push(`${L1}Required Terms:`); s.nodeAffinity.required.nodeSelectorTerms.forEach(t => (t.matchExpressions || []).forEach(e => out.push(`${L2}Term 0:\t${e.key} ${e.operator.toLowerCase()} [${(e.values || []).join(', ')}]`))); }
        else out.push('Node Affinity:\t<none>');
        out.push('Message:\t');
        out.push('Source:');
        if (s.hostPath) { out.push(`${L1}Type:\tHostPath (bare host directory volume)`); out.push(`${L1}Path:\t${s.hostPath.path}`); out.push(`${L1}HostPathType:\t${s.hostPath.type || ''}`); }
        else if (s.csi) { out.push(`${L1}Type:\tCSI (a Container Storage Interface (CSI) volume source)`); out.push(`${L1}Driver:\t${s.csi.driver}`); out.push(`${L1}VolumeHandle:\t${s.csi.volumeHandle}`); }
        else if (s.nfs) { out.push(`${L1}Type:\tNFS (an NFS mount that lasts the lifetime of a pod)`); out.push(`${L1}Server:\t${s.nfs.server}`); out.push(`${L1}Path:\t${s.nfs.path}`); }
        events(c, obj, out);
        break;
      }
      case 'StorageClass': {
        out.push(`Name:\t${md.name}`);
        out.push(`IsDefaultClass:\t${(md.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'Yes' : 'No'}`);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Provisioner:\t${obj.provisioner}`);
        out.push(`Parameters:\t${obj.parameters ? U.labelsToString(obj.parameters) : '<none>'}`);
        out.push(`AllowVolumeExpansion:\t${obj.allowVolumeExpansion ? 'True' : '<unset>'}`);
        out.push('MountOptions:\t<none>');
        out.push(`ReclaimPolicy:\t${obj.reclaimPolicy}`);
        out.push(`VolumeBindingMode:\t${obj.volumeBindingMode}`);
        out.push('Events:\t<none>');
        break;
      }
      case 'Ingress': {
        const s = obj.spec;
        out.push(`Name:\t${md.name}`);
        mapLines(out, 'Labels:', md.labels);
        out.push(`Namespace:\t${md.namespace}`);
        out.push(`Address:\t${((obj.status.loadBalancer || {}).ingress || []).map(i => i.ip).join(',')}`);
        out.push(`Ingress Class:\t${s.ingressClassName || '<none>'}`);
        const be = b => {
          const svc = c.get('Service', md.namespace, b.service.name);
          const port = b.service.port.number || b.service.port.name;
          if (!svc) return `${b.service.name}:${port} (<error: services "${b.service.name}" not found>)`;
          const ep = c.get('Endpoints', md.namespace, b.service.name);
          const addrs = ((ep && ep.subsets) || []).flatMap(sub => (sub.addresses || []).map(a => `${a.ip}:${sub.ports[0].port}`));
          return `${b.service.name}:${port} (${addrs.join(',') || '<none>'})`;
        };
        out.push(`Default backend:\t${s.defaultBackend ? be(s.defaultBackend) : '<default>'}`);
        if ((s.tls || []).length) { out.push('TLS:'); s.tls.forEach(t => out.push(`${L1}${t.secretName} terminates ${(t.hosts || []).join(',')}`)); }
        out.push('Rules:');
        out.push(`${L1}Host\tPath\tBackends`);
        out.push(`${L1}----\t----\t--------`);
        (s.rules || []).forEach(r => {
          out.push(`${L1}${r.host || '*'}\t`);
          ((r.http && r.http.paths) || []).forEach(p => out.push(`${L1}\t${p.path || '/'}\t${be(p.backend)}`));
        });
        annLines(out, 'Annotations:', md.annotations);
        events(c, obj, out);
        break;
      }
      case 'HorizontalPodAutoscaler': {
        const s = obj.spec, st = obj.status || {};
        head(true);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`CreationTimestamp:\t${fmtDate(md.creationTimestamp)}`);
        out.push(`Reference:\t${s.scaleTargetRef.kind}/${s.scaleTargetRef.name}`);
        out.push('Metrics:\t( current / target )');
        (s.metrics || []).forEach((m, i) => {
          const cur = ((st.currentMetrics || [])[i] || {}).resource;
          const cv = cur && cur.current && cur.current.averageUtilization != null ? `${cur.current.averageUtilization}% (${cur.current.averageValue})` : '<unknown>';
          if (m.resource.target.type === 'Utilization') out.push(`${L1}resource ${m.resource.name} on pods  (as a percentage of request):\t${cv} / ${m.resource.target.averageUtilization}%`);
          else out.push(`${L1}resource ${m.resource.name} on pods:\t${(cur && cur.current && cur.current.averageValue) || '<unknown>'} / ${m.resource.target.averageValue}`);
        });
        out.push(`Min replicas:\t${s.minReplicas}`);
        out.push(`Max replicas:\t${s.maxReplicas}`);
        if (s.behavior) {
          out.push('Behavior:');
          out.push(`${L1}Scale Down:`);
          out.push(`${L2}Stabilization Window: ${(s.behavior.scaleDown || {}).stabilizationWindowSeconds != null ? s.behavior.scaleDown.stabilizationWindowSeconds : 300} seconds`);
        }
        out.push(`${s.scaleTargetRef.kind} pods:\t${st.currentReplicas || 0} current / ${st.desiredReplicas || 0} desired`);
        out.push('Conditions:');
        out.push(`${L1}Type\tStatus\tReason\tMessage`);
        out.push(`${L1}----\t------\t------\t-------`);
        (st.conditions || []).forEach(cd => out.push(`${L1}${cd.type}\t${cd.status}\t${cd.reason}\t${cd.message}`));
        events(c, obj, out);
        break;
      }
      case 'Job': {
        const s = obj.spec, st = obj.status || {};
        head(true);
        out.push(`Selector:\t${U.selectorToString(s.selector)}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        const ref = (md.ownerReferences || []).find(r => r.controller);
        if (ref) out.push(`Controlled By:\t${ref.kind}/${ref.name}`);
        out.push(`Parallelism:\t${s.parallelism}`);
        out.push(`Completions:\t${s.completions == null ? '<unset>' : s.completions}`);
        out.push(`Completion Mode:\t${s.completionMode}`);
        out.push('Suspend:\tfalse');
        out.push(`Backoff Limit:\t${s.backoffLimit}`);
        if (s.ttlSecondsAfterFinished != null) out.push(`TTL Seconds After Finished:\t${s.ttlSecondsAfterFinished}`);
        if (st.startTime) out.push(`Start Time:\t${fmtDate(st.startTime)}`);
        if (st.completionTime) { out.push(`Completed At:\t${fmtDate(st.completionTime)}`); out.push(`Duration:\t${U.humanDuration(Date.parse(st.completionTime) - Date.parse(st.startTime))}`); }
        out.push(`Pods Statuses:\t${st.active || 0} Active (${st.ready || 0} Ready) / ${st.succeeded || 0} Succeeded / ${st.failed || 0} Failed`);
        podTemplate(out, s.template, c);
        events(c, obj, out);
        break;
      }
      case 'CronJob': {
        const s = obj.spec, st = obj.status || {};
        head(true);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Schedule:\t${s.schedule}`);
        out.push(`Concurrency Policy:\t${s.concurrencyPolicy}`);
        out.push(`Suspend:\t${s.suspend ? 'True' : 'False'}`);
        out.push(`Successful Job History Limit:\t${s.successfulJobsHistoryLimit}`);
        out.push(`Failed Job History Limit:\t${s.failedJobsHistoryLimit}`);
        out.push(`Starting Deadline Seconds:\t${s.startingDeadlineSeconds == null ? '<unset>' : s.startingDeadlineSeconds + 's'}`);
        out.push('Selector:\t<unset>');
        out.push(`Parallelism:\t${s.jobTemplate.spec.parallelism == null ? '<unset>' : s.jobTemplate.spec.parallelism}`);
        out.push(`Completions:\t${s.jobTemplate.spec.completions == null ? '<unset>' : s.jobTemplate.spec.completions}`);
        podTemplate(out, s.jobTemplate.spec.template, c);
        out.push(`Last Schedule Time:\t${st.lastScheduleTime ? fmtDate(st.lastScheduleTime) : '<unset>'}`);
        out.push(`Active Jobs:\t${(st.active || []).map(a => a.name).join(', ') || '<none>'}`);
        events(c, obj, out);
        break;
      }
      case 'StatefulSet': case 'DaemonSet': {
        const s = obj.spec, st = obj.status || {};
        head(true);
        out.push(`Selector:\t${U.selectorToString(s.selector)}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        if (obj.kind === 'StatefulSet') {
          out.push(`CreationTimestamp:\t${fmtDate(md.creationTimestamp)}`);
          out.push(`Replicas:\t${s.replicas} desired | ${st.replicas || 0} total`);
          out.push(`Update Strategy:\t${s.updateStrategy.type}`);
          if (s.updateStrategy.rollingUpdate) out.push(`${L1}Partition:\t${s.updateStrategy.rollingUpdate.partition || 0}`);
        } else {
          out.push(`Desired Number of Nodes Scheduled: ${st.desiredNumberScheduled || 0}`);
          out.push(`Current Number of Nodes Scheduled: ${st.currentNumberScheduled || 0}`);
          out.push(`Number of Nodes Scheduled with Up-to-date Pods: ${st.updatedNumberScheduled || 0}`);
          out.push(`Number of Nodes Scheduled with Available Pods: ${st.numberAvailable || 0}`);
          out.push(`Number of Nodes Misscheduled: ${st.numberMisscheduled || 0}`);
        }
        const pods = c.podsOf(obj);
        const cnt = ph => pods.filter(p => p.status.phase === ph).length;
        out.push(`Pods Status:\t${cnt('Running')} Running / ${cnt('Pending')} Waiting / ${cnt('Succeeded')} Succeeded / ${cnt('Failed')} Failed`);
        podTemplate(out, s.template, c);
        if (obj.kind === 'StatefulSet') {
          const vct = s.volumeClaimTemplates || [];
          if (!vct.length) out.push('Volume Claims:\t<none>');
          else {
            out.push('Volume Claims:');
            vct.forEach(t => {
              out.push(`${L1}Name:\t${t.metadata.name}`);
              out.push(`${L1}StorageClass:\t${t.spec.storageClassName || ''}`);
              mapLines(out, 'Labels:', t.metadata.labels, L1);
              out.push(`${L1}Annotations:\t<none>`);
              out.push(`${L1}Capacity:\t${t.spec.resources.requests.storage}`);
              out.push(`${L1}Access Modes:\t[${(t.spec.accessModes || []).join(' ')}]`);
            });
          }
        }
        events(c, obj, out);
        break;
      }
      case 'NetworkPolicy': {
        const s = obj.spec;
        head(true);
        out.push(`Created on:\t${new Date(md.creationTimestamp).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000 UTC')}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push('Spec:');
        const sel = s.podSelector && (Object.keys(s.podSelector.matchLabels || {}).length || (s.podSelector.matchExpressions || []).length) ? U.selectorToString(s.podSelector) : '<none> (Allowing the specific traffic to all pods in this namespace)';
        out.push(`${L1}PodSelector:\t${sel}`);
        const peer = p => {
          const lines = [];
          if (p.ipBlock) lines.push(`IPBlock:\n${L3}  CIDR: ${p.ipBlock.cidr}\n${L3}  Except: ${(p.ipBlock.except || []).join(', ')}`);
          if (p.namespaceSelector) lines.push(`NamespaceSelector: ${Object.keys(p.namespaceSelector).length && (Object.keys(p.namespaceSelector.matchLabels || {}).length || (p.namespaceSelector.matchExpressions || []).length) ? U.selectorToString(p.namespaceSelector) : '<none>'}`);
          if (p.podSelector) lines.push(`PodSelector: ${Object.keys(p.podSelector.matchLabels || {}).length || (p.podSelector.matchExpressions || []).length ? U.selectorToString(p.podSelector) : '<none>'}`);
          return lines.join(`\n${L3}`);
        };
        const types = s.policyTypes || ['Ingress'];
        if (types.includes('Ingress')) {
          out.push(`${L1}Allowing ingress traffic:`);
          if (!(s.ingress || []).length) out.push(`${L2}<none> (Selected pods are isolated for ingress connectivity)`);
          (s.ingress || []).forEach((r, i) => {
            if (i) out.push(`${L2}----------`);
            out.push(`${L2}To Port: ${(r.ports || []).length ? r.ports.map(p => `${p.port || '<any>'}/${p.protocol || 'TCP'}`).join(', ') : '<any> (traffic allowed to all ports)'}`);
            if (!(r.from || []).length) out.push(`${L2}From: <any> (traffic not restricted by source)`);
            else { out.push(`${L2}From:`); r.from.forEach(p => out.push(`${L3}${peer(p)}`)); }
          });
        } else out.push(`${L1}Not affecting ingress traffic`);
        if (types.includes('Egress')) {
          out.push(`${L1}Allowing egress traffic:`);
          if (!(s.egress || []).length) out.push(`${L2}<none> (Selected pods are isolated for egress connectivity)`);
          (s.egress || []).forEach((r, i) => {
            if (i) out.push(`${L2}----------`);
            out.push(`${L2}To Port: ${(r.ports || []).length ? r.ports.map(p => `${p.port || '<any>'}/${p.protocol || 'TCP'}`).join(', ') : '<any> (traffic allowed to all ports)'}`);
            if (!(r.to || []).length) out.push(`${L2}To: <any> (traffic not restricted by destination)`);
            else { out.push(`${L2}To:`); r.to.forEach(p => out.push(`${L3}${peer(p)}`)); }
          });
        } else out.push(`${L1}Not affecting egress traffic`);
        out.push(`${L1}Policy Types: ${types.join(', ')}`);
        break;
      }
      case 'PodDisruptionBudget': {
        const s = obj.spec, st = obj.status || {};
        head(true);
        if (s.minAvailable != null) out.push(`Min available:\t${s.minAvailable}`);
        if (s.maxUnavailable != null) out.push(`Max unavailable:\t${s.maxUnavailable}`);
        out.push(`Selector:\t${U.selectorToString(s.selector)}`);
        out.push('Status:');
        out.push(`${L2}Allowed disruptions:\t${st.disruptionsAllowed || 0}`);
        out.push(`${L2}Current:\t${st.currentHealthy || 0}`);
        out.push(`${L2}Desired:\t${st.desiredHealthy || 0}`);
        out.push(`${L2}Total:\t${st.expectedPods || 0}`);
        events(c, obj, out);
        break;
      }
      case 'ServiceAccount': {
        head(true);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Image pull secrets:\t${(obj.imagePullSecrets || []).map(s => s.name).join(', ') || '<none>'}`);
        out.push('Mountable secrets:\t<none>');
        out.push('Tokens:\t<none>');
        events(c, obj, out);
        break;
      }
      case 'Role': case 'ClusterRole': {
        out.push(`Name:\t${md.name}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push('PolicyRule:');
        out.push(`${L1}Resources\tNon-Resource URLs\tResource Names\tVerbs`);
        out.push(`${L1}---------\t-----------------\t--------------\t-----`);
        const rows = [];
        (obj.rules || []).forEach(r => {
          if (r.nonResourceURLs) { rows.push(`${L1}\t[${r.nonResourceURLs.join(' ')}]\t[]\t[${r.verbs.join(' ')}]`); return; }
          (r.resources || []).forEach(res => (r.apiGroups || ['']).forEach(g => rows.push(`${L1}${res}${g && g !== '' ? '.' + g : ''}\t[]\t[${(r.resourceNames || []).join(' ')}]\t[${r.verbs.join(' ')}]`)));
        });
        rows.sort().forEach(r => out.push(r));
        break;
      }
      case 'RoleBinding': case 'ClusterRoleBinding': {
        out.push(`Name:\t${md.name}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push('Role:');
        out.push(`${L1}Kind:\t${obj.roleRef.kind}`);
        out.push(`${L1}Name:\t${obj.roleRef.name}`);
        out.push('Subjects:');
        out.push(`${L1}Kind\tName\tNamespace`);
        out.push(`${L1}----\t----\t---------`);
        (obj.subjects || []).forEach(s => out.push(`${L1}${s.kind}\t${s.name}\t${s.namespace || ''}`));
        break;
      }
      case 'ResourceQuota': {
        head(true);
        out.push(`Resource\tUsed\tHard`);
        out.push(`--------\t----\t----`);
        Object.keys(obj.spec.hard || {}).sort().forEach(k => out.push(`${k}\t${((obj.status || {}).used || {})[k] || '0'}\t${obj.spec.hard[k]}`));
        break;
      }
      case 'LimitRange': {
        head(true);
        out.push(`Type\tResource\tMin\tMax\tDefault Request\tDefault Limit\tMax Limit/Request Ratio`);
        out.push(`----\t--------\t---\t---\t---------------\t-------------\t-----------------------`);
        (obj.spec.limits || []).forEach(l => {
          const res = new Set(Object.keys(Object.assign({}, l.min, l.max, l.default, l.defaultRequest)));
          [...res].sort().forEach(r => out.push(`${l.type}\t${r}\t${(l.min || {})[r] || '-'}\t${(l.max || {})[r] || '-'}\t${(l.defaultRequest || {})[r] || '-'}\t${(l.default || {})[r] || '-'}\t-`));
        });
        break;
      }
      case 'PriorityClass': {
        out.push(`Name:\t${md.name}`);
        out.push(`Value:\t${obj.value}`);
        out.push(`GlobalDefault:\t${!!obj.globalDefault}`);
        out.push(`PreemptionPolicy:\t${obj.preemptionPolicy || 'PreemptLowerPriority'}`);
        out.push(`Description:\t${obj.description || ''}`);
        annLines(out, 'Annotations:', md.annotations);
        out.push('Events:\t<none>');
        break;
      }
      case 'IngressClass': {
        out.push(`Name:\t${md.name}`);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        out.push(`Controller:\t${obj.spec.controller}`);
        out.push('Events:\t<none>');
        break;
      }
      default: {
        head(true);
        mapLines(out, 'Labels:', md.labels);
        annLines(out, 'Annotations:', md.annotations);
        const y = KS.toYaml({ spec: obj.spec, status: obj.status, data: obj.data, type: obj.type, reason: obj.reason, message: obj.message, involvedObject: obj.involvedObject });
        out.push(y.trimEnd());
        break;
      }
    }
    return tabwrite(out.filter(l => l !== undefined).join('\n'));
  }

  KS.describe = describe;
  KS.tabwrite = tabwrite;
  KS.fmtDate = fmtDate;
  KS.podTemplateText = (tpl, c) => { const out = []; podTemplate(out, tpl, c); return tabwrite(out.join('\n')); };
})(typeof window !== 'undefined' ? window : globalThis);
