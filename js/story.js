/* Kubester — the "story" view of a lesson's concept.
   Turns each lesson intro into a short, swipeable story: a hook question, bite-sized idea cards
   (term cards, flow diagrams, code), an everyday analogy, and a "go try it" finale. */
(function (G) {
  'use strict';
  const KS = (G.KS = G.KS || {});

  // ------------------------------------------------------------------ per-lesson hooks + analogies
  // hook: the curiosity question · why: real-world stakes · emoji + analogy: everyday picture
  const S = {
    'welcome': { emoji: '🚢', hook: 'What if you could run a whole data centre… inside a browser tab?', why: 'Kubernetes runs a huge share of the world\'s cloud apps: streaming, banking, games. Here you get your own cluster, and nothing you break here matters.' },
    'desired-state': { emoji: '🌡️', hook: 'You delete a running app. Seconds later it\'s back. Who brought it back?', why: 'This is why Kubernetes apps survive a crashed server at 3 a.m. without anyone waking up.' },
    'architecture': { emoji: '🏢', hook: 'You type one command. At least five programs team up to run your app. Can you name them?', why: 'Every outage you\'ll ever debug is one of these parts misbehaving. Know the parts and you\'ll find the bug.' },
    'pods': { emoji: '🥜', hook: 'Kubernetes never runs a container on its own. So what does it run?', why: 'Pods are what you get, describe, log and exec into every single day.', analogy: 'A Pod is a **peanut shell**: the nuts inside (containers) share one shell (one IP, the same volumes) and are thrown away together. You never buy a single nut floating on its own.' },
    'kubectl-workflow': { emoji: '📜', hook: 'Someone fixed production by typing a command. Nobody knows what they typed. Now what?', why: 'Real teams keep YAML in Git, so every change is reviewed, repeatable and undoable.', analogy: 'YAML is a **recipe card**. `kubectl create` is cooking from memory; `kubectl apply -f` is following the card, so anyone can make the exact same dish again.' },
    'labels': { emoji: '🏷️', hook: 'How does a Service find its Pods when it never knows their names?', why: 'Labels are the glue: Services, Deployments, NetworkPolicies and scheduling rules all pick Pods by label.', analogy: 'Labels are **hashtags**. You don\'t follow posts by name; you follow #web and see everything tagged with it, even posts made tomorrow.' },
    'deployments': { emoji: '🧑‍🏫', hook: 'You want 3 copies of your app, forever, even when servers die. Who keeps count?', why: 'Almost every stateless app in production is a Deployment.', analogy: 'A Deployment is a **teacher with a class list**: "I need 3 students." If one leaves, the teaching assistant (the ReplicaSet) enrols a new one right away.' },
    'rolling-updates': { emoji: '✈️', hook: 'How do you ship a new version to millions of users without a single second of downtime?', why: 'Rollouts and one-command rollbacks are how teams ship many times a day without fear.', analogy: 'Swapping a plane\'s engines **mid-flight, one at a time**, so the plane never stops flying. Bad engine? Swap the old one back (rollback).' },
    'services': { emoji: '☎️', hook: 'Pods get a brand-new IP every time they restart. So how does anything ever find them?', why: 'Every app that talks to another app goes through a Service.', analogy: 'A Service is a **company phone number**. Staff (Pods) come and go, but customers always dial the same number and reach whoever is at a desk.' },
    'ingress': { emoji: '🏨', hook: 'You run 10 websites in one cluster. Do you really need 10 cloud load balancers?', why: 'Ingress saves money and gives you one place for HTTPS, hostnames and URL paths.', analogy: 'Ingress is a **hotel receptionist**: one front door, and each guest is sent to the right room based on their booking (host and path).' },
    'namespaces': { emoji: '🏬', hook: 'Two teams both deploy an app called "api". Whose wins?', why: 'Namespaces let many teams share one cluster safely, with fair limits on CPU and memory.', analogy: 'Namespaces are **floors in an office building**: same building, separate rooms and keys, and each floor has its own power budget (quota).' },
    'config-secrets': { emoji: '🎮', hook: 'Should your database password be baked into your container image?', why: 'Keeping config outside the image lets one image run unchanged in dev, staging and prod.', analogy: 'The image is a **game console**; ConfigMaps and Secrets are the settings and the saved login. Same console, different players.' },
    'storage': { emoji: '🎒', hook: 'Your database Pod restarts. Is all your data gone?', why: 'Anything stateful (databases, queues, uploads) needs storage that outlives the Pod.', analogy: 'A container\'s disk is a **hotel room**: cleaned out when you check out. A PersistentVolume is **your own locker**, still there when you come back.' },
    'probes': { emoji: '🩺', hook: 'Your app says "Running", but every request fails. How would Kubernetes ever know?', why: 'Probes keep traffic away from broken Pods and restart frozen ones automatically.', analogy: 'Probes are a **nurse on rounds**: "Are you awake?" (liveness), "Ready for visitors?" (readiness), "Still waking up from surgery?" (startup).' },
    'resources': { emoji: '🍕', hook: 'One greedy app eats all the memory on a server. What happens to its neighbours?', why: 'Requests and limits decide where Pods fit, and who gets killed (OOMKilled) when memory runs out.', analogy: '**Requests** are the pizza slices you reserve; **limits** are the most you may eat. Grab more memory than your limit and you\'re thrown out of the party (OOMKilled).' },
    'multi-container': { emoji: '🏎️', hook: 'Your app needs the database up before it starts. Who does the waiting?', why: 'Init containers and sidecars add setup, logging and proxies without touching your app\'s code.', analogy: 'Init containers are the **pit crew** who must finish before the race starts; sidecars are the **co-driver** riding along the whole way.' },
    'daemonsets-jobs': { emoji: '🧹', hook: 'Not every program runs forever. What about a nightly backup, or one agent on every server?', why: 'Log collectors, monitoring agents, batch work and scheduled tasks each have their own workload type.', analogy: 'A DaemonSet is **a guard on every floor**; a Job is **a cleaner who finishes and leaves**; a CronJob is **the cleaner who comes back every night**.' },
    'scheduling': { emoji: '💺', hook: 'Your GPU app lands on a server with no GPU. How do you stop that from happening?', why: 'Placement rules keep Pods on the right hardware, spread across zones, and apart when they need to be.', analogy: 'Scheduling is **airline seating**: some seats are reserved (taints), some passengers ask for a window (affinity), families want to sit together.' },
    'autoscaling': { emoji: '🛒', hook: 'Traffic jumps 10× at lunchtime. Who adds capacity, and who removes it afterwards?', why: 'Autoscaling keeps apps fast at peak and cheap when it\'s quiet.', analogy: 'The HPA is a **supermarket manager** opening more checkouts when the queues grow, and closing them when the shop is quiet.' },
    'maintenance': { emoji: '🚧', hook: 'You must reboot a server that is running live apps. Can you do it with zero downtime?', why: 'Every cluster upgrade is this dance: cordon, drain, upgrade, uncordon.', analogy: 'Closing **one motorway lane** for repairs: cones first (cordon), move the cars over (drain), fix, reopen. A PDB is the rule "never close more than one lane".' },
    'rbac': { emoji: '🔑', hook: 'Should the intern be able to delete the production database?', why: 'RBAC gives everyone exactly the access they need, and nothing more.', analogy: 'RBAC is **hotel key cards**: a Role says which doors a card opens; a RoleBinding hands that card to a person or an app.' },
    'pod-security': { emoji: '🦺', hook: 'If an attacker breaks into your container, are they root on the whole server?', why: 'A few lines of securityContext turn a container breakout into a dead end.', analogy: 'securityContext is **safety gear**: no root (no master key), a read-only filesystem (nothing to tamper with), dropped capabilities (no power tools).' },
    'network-policies': { emoji: '🛂', hook: 'By default every Pod can talk to every other Pod, including your database. Scary?', why: 'NetworkPolicies stop one hacked Pod from reaching everything else.', analogy: 'NetworkPolicies are **guest lists at a club door**: if you\'re not on the list for that door, you don\'t get in.' },
    'helm-kustomize': { emoji: '📦', hook: 'You have 40 YAML files and 3 environments. Are you really going to copy-paste them all?', why: 'Helm and Kustomize are how real teams package, version and customise apps.', analogy: 'Helm is an **app store with fill-in-the-blank installers**; Kustomize is **tracing paper** laid over a base design to tweak it per environment.' },
    'delivery': { emoji: '🐤', hook: 'How do you try a new version on 5% of real users before everyone gets it?', why: 'Canary and blue-green releases catch bad versions before they hurt everybody.', analogy: 'The **canary in a coal mine**: send a small bird in first. If it\'s fine, everyone follows.' },
    'internals': { emoji: '📮', hook: 'What really happens in the second after you press Enter on kubectl apply?', why: 'Knowing the request path (authn, authz, admission, etcd, watch) is how senior engineers debug.', analogy: 'The API server is a **post office**: check your ID, check you\'re allowed, inspect the parcel, file it in the archive (etcd), then notify everyone subscribed to that address.' },
    'inc-pending': { emoji: '🅿️', hook: 'Your Pods have been "Pending" for 10 minutes. The scheduler is trying to tell you something.', analogy: 'A car **circling a full car park**: nothing is broken, there\'s just no space that fits it.' },
    'inc-crashloop': { emoji: '🔁', hook: 'Your app starts, dies, starts, dies… and the waits keep getting longer.', analogy: 'A car that **stalls every time you turn the key**. Turning it again won\'t help: open the bonnet (`logs --previous`).' },
    'inc-imagepull': { emoji: '📭', hook: 'The node can\'t download your app. A typo, a missing tag, or a locked registry?', analogy: 'A delivery sent to **the wrong address**, or to a building that needs a key code you never gave the courier.' },
    'inc-containercreating': { emoji: '🧳', hook: 'The Pod has a node, but it\'s stuck before it ever starts. What\'s missing?', analogy: 'You\'re **at the gate but can\'t board**: a missing document (ConfigMap / Secret) or luggage (a volume) that never arrived.' },
    'inc-no-endpoints': { emoji: '📞', hook: 'The Service exists, the Pods are running… and every request still fails.', analogy: 'The phone number works, but it **forwards to nobody**: the Service\'s selector matches no Pod.' },
    'inc-rollout': { emoji: '↩️', hook: 'A deploy has said "in progress" for 15 minutes, and users are starting to notice.', analogy: 'The **new chef can\'t cook**. Kubernetes kept the old chef working; your job is to notice and roll back.' },
    'inc-dns': { emoji: '📒', hook: 'Suddenly apps everywhere can\'t find each other by name.', analogy: 'The whole company **lost its phone book**. Everyone is still at their desk, but nobody can look up a number.' },
    'inc-namespace': { emoji: '🔒', hook: 'You deleted a namespace an hour ago. It still says "Terminating".', analogy: 'You can\'t lock up the office while **someone is still inside holding the only key** (a finalizer).' },
    'inc-helm': { emoji: '🔄', hook: 'A helm upgrade was interrupted, and now every upgrade refuses to run.', analogy: 'A **half-installed software update**. Roll back to the last good version before you try again.' },
    'inc-node': { emoji: '📻', hook: 'A server went NotReady and its Pods are disappearing. Is it dead, or just silent?', analogy: 'A teammate who **stopped answering the radio**: maybe asleep, maybe out of battery. Check before you replace them.' },
    'sandbox': { emoji: '🧪', hook: 'No instructions, no rules. What will you build, or break, first?', why: 'The fastest way to learn is to poke things and watch what happens on the map.' },
  };
  const INCIDENT_WHY = 'This is a real on-call ticket. Read the clues like a detective, find the cause, then fix it.';

  // icons for term cards, matched against the bold term
  const ICONS = [
    [/right-top|map/i, '🗺️'], [/right-bottom|terminal/i, '⌨️'], [/this panel|lesson/i, '📘'],
    [/api-?server|apiserver/i, '🚪'], [/etcd/i, '🗄️'], [/scheduler/i, '🧭'], [/controller/i, '🔁'], [/kubelet/i, '🤖'],
    [/kube-proxy|proxy/i, '🔀'], [/runtime|containerd/i, '⚙️'], [/control plane/i, '🧠'], [/worker/i, '💪'],
    [/liveness/i, '💓'], [/readiness/i, '🚦'], [/startup/i, '🌅'], [/request/i, '📏'], [/limit/i, '🚧'],
    [/clusterip/i, '🏠'], [/nodeport/i, '🔌'], [/loadbalancer/i, '🌍'], [/headless/i, '👤'], [/externalname/i, '↗️'],
    [/configmap/i, '📝'], [/secret/i, '🔐'], [/pvc|claim/i, '🎟️'], [/persistentvolume|\bpv\b/i, '💾'], [/storageclass/i, '🏭'], [/statefulset/i, '🎫'],
    [/daemonset/i, '🛡️'], [/cronjob/i, '⏰'], [/\bjob\b/i, '✅'], [/deployment/i, '🚀'], [/replicaset/i, '🧬'], [/\bpod/i, '🥜'],
    [/service/i, '☎️'], [/ingress/i, '🚪'], [/namespace/i, '🏬'], [/quota/i, '📊'], [/label/i, '🏷️'], [/annotation/i, '🗒️'], [/selector/i, '🔎'],
    [/taint|toleration/i, '🧪'], [/affinity/i, '🧲'], [/nodeselector/i, '🎯'], [/hpa|autoscal/i, '📈'], [/cordon/i, '🚧'], [/drain/i, '🚰'], [/pdb|disruption/i, '⛑️'],
    [/role/i, '🔑'], [/serviceaccount/i, '🤖'], [/binding/i, '🔗'], [/root|privilege/i, '👑'], [/capabilit/i, '🧰'], [/read-?only/i, '🔏'],
    [/helm/i, '⎈'], [/kustomize/i, '🧩'], [/canary/i, '🐤'], [/blue/i, '🔵'], [/gitops|argo|flux/i, '🔃'], [/rolling/i, '🔄'],
    [/authent/i, '🆔'], [/authori/i, '✅'], [/admission/i, '🛂'], [/watch/i, '👀'], [/get\b/i, '📋'], [/describe/i, '🔬'], [/logs?/i, '📜'], [/exec/i, '💻'],
  ];
  const iconFor = t => { for (const [re, ic] of ICONS) if (re.test(t)) return ic; const c = String(t).replace(/[^A-Za-z0-9]/g, '')[0]; return `<i class="cs-letter">${c ? c.toUpperCase() : '•'}</i>`; };

  // ------------------------------------------------------------------ split an intro into slides
  function blocks(md) {
    const out = [];
    let cur = [];
    const flush = () => { if (cur.length) out.push(cur.join('\n')); cur = []; };
    let inCode = false;
    for (const line of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
      if (/^```/.test(line)) inCode = !inCode;
      if (!inCode && /^\s*$/.test(line)) { flush(); continue; }
      cur.push(line);
    }
    flush();
    return out;
  }
  const isList = b => /^\s*[-*]\s+/.test(b) || /^\s*\d+[.)]\s+/.test(b);
  const isQuote = b => /^>/.test(b);
  const isCode = b => /^```/.test(b);
  const isTitleOnly = b => /^\*\*[^*]+\*\*\s*$/.test(b.trim());
  const textLen = b => b.replace(/[`*>]/g, '').length;

  function slidesFor(lesson) {
    const raw = blocks(lesson.intro);
    let analogy = null;
    const parts = [];
    for (const b of raw) {
      if (isQuote(b) && /analogy/i.test(b)) { analogy = b.replace(/^>\s?/gm, '').replace(/^(\*\*)?[^:\n]*analogy[^:\n]*:(\*\*)?\s*/i, '').replace(/^\*\*Analogy\*\*:?\s*/i, ''); continue; }
      parts.push(b);
    }
    // glue: "intro sentence:" + list/code, a bold title + its list, and short paragraphs together
    const glued = [];
    for (const b of parts) {
      const prev = glued[glued.length - 1];
      if (prev && ((/:\s*$/.test(prev.trim()) && !isQuote(b)) || (isTitleOnly(prev) && (isList(b) || isCode(b))))) { glued[glued.length - 1] = prev + '\n\n' + b; continue; }
      if (prev && !isList(b) && !isCode(b) && !isQuote(b) && !/\n\n/.test(prev) && !isList(prev) && !isCode(prev) && !isQuote(prev) && textLen(prev) + textLen(b) < 280) { glued[glued.length - 1] = prev + '\n\n' + b; continue; }
      glued.push(b);
    }
    // never more than 6 idea cards: merge the two shortest neighbours
    while (glued.length > 6) {
      let best = 0, bl = Infinity;
      for (let i = 0; i < glued.length - 1; i++) { const l = textLen(glued[i]) + textLen(glued[i + 1]); if (l < bl) { bl = l; best = i; } }
      glued.splice(best, 2, glued[best] + '\n\n' + glued[best + 1]);
    }
    return { ideas: glued, analogy };
  }

  // ------------------------------------------------------------------ render one idea card
  // a list where every item starts with a bold term becomes a grid of term cards
  function termCards(listMd) {
    const items = listMd.split('\n').filter(l => /^\s*[-*]\s+/.test(l)).map(l => l.replace(/^\s*[-*]\s+/, ''));
    if (items.length < 2) return null;
    const parsed = items.map(it => {
      const m = it.match(/^\*\*([^*]+)\*\*\s*(\([^)]*\))?\s*[–—:-]?\s*(.*)$/) || it.match(/^`([^`]+)`\s*(\([^)]*\))?\s*[–—:-]\s*(.*)$/);
      return m ? { term: m[1].replace(/:$/, ''), extra: m[2] || '', desc: m[3] } : null;
    });
    if (parsed.some(p => !p)) return null;
    const inl = KS.md.inline;
    return `<div class="cs-terms">${parsed.map((p, i) => `<div class="cs-term" style="--i:${i}"><span class="cs-ic" aria-hidden="true">${iconFor(p.term)}</span><div><b>${inl(p.term)}</b>${p.extra ? ` <span class="cs-q">${inl(p.extra)}</span>` : ''}<div class="cs-d">${inl(p.desc)}</div></div></div>`).join('')}</div>`;
  }
  // a small table becomes term cards: first column is the term, the other columns become "Header: value" lines
  function tableCards(t) {
    const rows = t.split('\n').filter(l => /^\s*\|/.test(l) && !/^[\s|:-]+$/.test(l));
    const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (rows.length < 3 || rows.length > 9) return null;
    const head = cells(rows[0]), inl = KS.md.inline;
    return `<div class="cs-terms">${rows.slice(1).map((r, i) => { const c = cells(r); return `<div class="cs-term" style="--i:${i}"><span class="cs-ic" aria-hidden="true">${iconFor(c[0])}</span><div><b>${inl(c[0])}</b>${c.slice(1).map((v, k) => v ? `<div class="cs-d"><span class="cs-h">${inl(head[k + 1] || '')}</span> ${inl(v)}</div>` : '').join('')}</div></div>`; }).join('')}</div>`;
  }
  // a sentence with 2+ arrows becomes a flow diagram
  function flow(par) {
    if ((par.match(/→/g) || []).length < 2 || /\n/.test(par.trim())) return null;
    const inl = KS.md.inline;
    let head = '', tail = '';
    let segs = par.split('→').map(s => s.trim());
    const first = segs[0], ci = first.lastIndexOf(': ');
    if (ci > 0) { head = first.slice(0, ci + 1); segs[0] = first.slice(ci + 2); }
    const last = segs[segs.length - 1], di = last.search(/\.\s+[A-Z`*]/);
    if (di > 0) { tail = last.slice(di + 1).trim(); segs[segs.length - 1] = last.slice(0, di + 1); }
    if (segs.some(s => !s || s.length > 140)) return null;
    return `${head ? `<p>${inl(head)}</p>` : ''}<div class="cs-flow">${segs.map((s, i) => `${i ? '<span class="cs-arrow" aria-hidden="true">→</span>' : ''}<span class="cs-node" style="--i:${i}">${inl(s.replace(/\.$/, ''))}</span>`).join('')}</div>${tail ? `<p>${inl(tail)}</p>` : ''}`;
  }
  function renderIdea(b, label) {
    const md = KS.md.render;
    const subs = [];
    for (const s of b.split(/\n\n/)) {               // "**Title**\n- list" → title + list
      const lines = s.split('\n');
      if (lines.length > 1 && isTitleOnly(lines[0]) && isList(lines.slice(1).join('\n'))) subs.push(lines[0], lines.slice(1).join('\n'));
      else subs.push(s);
    }
    const clean = t => t.trim().replace(/^\*\*|\*\*$/g, '').replace(/[:.]$/, '');
    return subs.map(s => {
      if (isTitleOnly(s) && clean(s) === label) return '';
      if (isList(s)) { const t = termCards(s); if (t) return t; }
      if (/^\s*\|/.test(s)) { const t = tableCards(s); if (t) return t; }
      if (!isList(s) && !isCode(s) && !isQuote(s)) { const f = flow(s); if (f) return f; }
      if (isTitleOnly(s)) return `<h4 class="cs-sub">${KS.md.inline(s.trim().replace(/^\*\*|\*\*$/g, ''))}</h4>`;
      return `<div class="md">${md(s)}</div>`;
    }).join('');
  }
  // a short title for a card: its first bold phrase, else its first few words
  function ideaTitle(b, i) {
    if (/^\s*\|/.test(b)) return 'At a glance';
    const cap = t => { t = t.trim().replace(/[:.,;]$/, ''); return t[0].toUpperCase() + t.slice(1); };
    const ok = t => /^[A-Za-z]/.test(t) && t.length >= 3 && t.length <= 44;
    const def = b.trim().match(/^(?:An?|The)\s+\*\*([^*]{2,30})\*\*\s+(?:is|are|wraps|gives|adds|runs|keeps)\b/);
    if (def) return `What is ${/^[AEIOU]/i.test(def[1]) ? 'an' : 'a'} ${def[1]}?`;
    if (/^\s*[-*]\s+\*\*/.test(b)) return 'At a glance';               // a list of terms
    const lead = b.trim().match(/^(?:[-*]\s+)?\*\*([^*]+)\*\*/);            // bold right at the start
    if (lead && ok(lead[1])) return cap(lead[1]);
    for (const m of b.matchAll(/\*\*([^*]+)\*\*/g)) if (ok(m[1]) && /\s/.test(m[1].trim())) return cap(m[1]);
    const plain = b.split('\n')[0].replace(/`([^`]*)`/g, '$1').replace(/[*>#]/g, '').replace(/\s*\(Q[^)]*\)/g, '').replace(/^\s*[-\d.)]+\s+/, '').replace(/^\(/, '').trim();
    let first = plain.split(/[:.!?](\s|$)/)[0].trim();
    const words = first.split(/\s+/);
    if (words.length > 7) first = words.slice(0, 6).join(' ').replace(/[,(]+$/, '') + '…';
    if (first.length > 46) first = first.slice(0, 44).replace(/\s+\S*$/, '') + '…';
    return first.length > 3 ? cap(first) : `Idea ${i + 1}`;
  }


  // ------------------------------------------------------------------ the whole story
  function render(lesson, opts) {
    opts = opts || {};
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const inl = KS.md.inline;
    const meta = S[lesson.id] || { emoji: lesson.incident ? '🚨' : '💡', hook: lesson.title };
    const { ideas, analogy } = slidesFor(lesson);
    const an = analogy || meta.analogy;
    const why = meta.why || (lesson.incident ? INCIDENT_WHY : '');
    const slides = [];
    slides.push({ kind: 'hook', label: lesson.incident ? 'The ticket' : 'The question', html:
      `<div class="cs-hook"><div class="cs-emoji" aria-hidden="true">${meta.emoji}</div><h3>${inl(meta.hook)}</h3>${why ? `<p class="cs-why"><span>${lesson.incident ? '🕵️' : '🔥'} Why it matters</span>${inl(why)}</p>` : ''}</div>` });
    ideas.forEach((b, i) => { const label = ideaTitle(b, i); slides.push({ kind: 'idea', label, html: renderIdea(b, label) }); });
    if (an) slides.push({ kind: 'analogy', label: 'Think of it like…', html:
      `<div class="cs-analogy"><div class="cs-big" aria-hidden="true">${meta.emoji}</div><div><span class="cs-tag">🧠 Think of it like…</span><p>${inl(an)}</p></div></div>` });
    const nSteps = (lesson.steps || []).length;
    slides.push({ kind: 'go', label: 'Your turn', html:
      `<div class="cs-go"><div class="cs-emoji" aria-hidden="true">${nSteps ? '🧑‍💻' : '🧪'}</div><h3>${nSteps ? 'Now see it happen on a real cluster' : 'Now go play'}</h3><p>${nSteps ? `${nSteps} hands-on step${nSteps > 1 ? 's' : ''} are waiting below. Press <b>▶ Run</b> on each one and watch the cluster map react.` : 'Type any kubectl command in the terminal and watch the cluster map react.'}</p></div>` });

    const n = slides.length;
    const at = Math.max(0, Math.min(n - 1, opts.at || 0));
    const all = !!opts.all;
    return `<section class="cstory${all ? ' all' : ''}${lesson.incident ? ' incident' : ''}" data-n="${n}" data-at="${at}" aria-label="Concept story">
      <header class="cs-top"><span class="cs-kind">${lesson.incident ? '🧭 Playbook' : '💡 Concept'}</span>
        <span class="cs-count" aria-live="polite">${at + 1} / ${n}</span>
        <button class="cs-mode" data-cs="mode" title="${all ? 'Show one idea at a time' : 'Show every idea on one page'}">${all ? 'One at a time' : 'Read all'}</button></header>
      <div class="cs-bar" aria-hidden="true">${slides.map((s, i) => `<button data-cs="go" data-to="${i}" class="${i < at ? 'seen' : i === at ? 'on' : ''}" title="${esc(s.label)}"></button>`).join('')}</div>
      <div class="cs-slides">${slides.map((s, i) => `<article class="cs-slide k-${s.kind}${i === at ? ' on' : ''}" data-i="${i}">${s.kind === 'idea' ? `<div class="cs-label"><span>${i}</span>${inl(s.label)}</div>` : ''}${s.html}</article>`).join('')}</div>
      <footer class="cs-nav"><button class="btn ghost cs-prev" data-cs="prev"${at === 0 ? ' disabled' : ''}>← Back</button>
        <button class="btn cs-next" data-cs="next">${at === 0 ? 'Show me →' : at >= n - 2 ? (at === n - 1 ? 'Start hands-on ▶' : 'Last one →') : 'Next idea →'}</button></footer>
    </section>`;
  }

  // move to slide i inside a rendered story element (no re-render, so animations replay)
  function go(el, i) {
    const n = +el.dataset.n;
    i = Math.max(0, Math.min(n - 1, i));
    const from = +el.dataset.at;
    el.dataset.at = i;
    el.querySelectorAll('.cs-slide').forEach(s => { s.classList.toggle('on', +s.dataset.i === i); s.classList.toggle('back', +s.dataset.i === i && i < from); });
    el.querySelectorAll('.cs-bar button').forEach((b, k) => { b.className = k < i ? 'seen' : k === i ? 'on' : ''; });
    el.querySelector('.cs-count').textContent = `${i + 1} / ${n}`;
    el.querySelector('.cs-prev').disabled = i === 0;
    el.querySelector('.cs-next').textContent = i === 0 ? 'Show me →' : i === n - 1 ? 'Start hands-on ▶' : i === n - 2 ? 'Last one →' : 'Next idea →';
    return i;
  }

  KS.story = { render, go, data: S };
})(typeof window !== 'undefined' ? window : globalThis);
