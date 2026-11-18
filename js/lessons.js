/* Kubester — curriculum. Each step's check() runs against the simulated cluster (see tests/run-tests.js). */
(function (G) {
  'use strict';
  const KS = (G.KS = G.KS || {});
  const U = KS.util;

  // ------------------------------------------------------------------ helpers for checks
  const act = p => !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed';
  const ready = p => ((p.status.conditions || []).find(c => c.type === 'Ready') || {}).status === 'True';
  function pods(c, sel, ns) {
    const s = U.parseSelectorString(sel || '');
    return c.list('Pod', ns || 'default').filter(p => act(p) && (!sel || U.matchSelector(s, p.metadata.labels || {})));
  }
  const readyN = (c, sel, ns) => pods(c, sel, ns).filter(ready).length;
  function deployDone(c, name, ns, replicas) {
    const d = c.get('Deployment', ns || 'default', name);
    if (!d) return false;
    const st = d.status || {};
    const want = replicas != null ? replicas : d.spec.replicas;
    return d.spec.replicas === want && (st.availableReplicas || 0) === want && (st.updatedReplicas || 0) === want && (st.replicas || 0) === want;
  }
  const image = (c, name, ns) => { const d = c.get('Deployment', ns || 'default', name); return d ? d.spec.template.spec.containers[0].image : null; };
  const H = { pods, readyN, deployDone, ready, act, image };

  // "{pod:app=web}" style placeholders in runnable commands
  function fill(cmd, c, ns) {
    return cmd.replace(/\{(\w[\w-]*):([^}]*)\}/g, (m, kind, arg) => {
      if (kind === 'pod') {
        const [sel, nsx] = arg.split('@');
        const p = pods(c, sel, nsx || ns).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
        return p.length ? p[0].metadata.name : '<pod-name>';
      }
      if (kind === 'pod2') {
        const p = pods(c, arg, ns).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
        return p.length > 1 ? p[1].metadata.name : p.length ? p[0].metadata.name : '<pod-name>';
      }
      if (kind === 'nodeport') { const s = c.get('Service', ns || 'default', arg); return s && s.spec.ports[0].nodePort ? String(s.spec.ports[0].nodePort) : '<node-port>'; }
      if (kind === 'nodeof') { const p = pods(c, arg, ns)[0]; return p && p.spec.nodeName ? p.spec.nodeName : '<node>'; }
      if (kind === 'newpod') {
        const d = c.get('Deployment', ns || 'default', arg);
        const p = c.list('Pod', ns || 'default').filter(x => act(x) && d && U.matchSelector(d.spec.selector, x.metadata.labels) && !ready(x));
        return p.length ? p[0].metadata.name : '<new-pod>';
      }
      if (kind === 'finalized') {
        const o = c.list('ConfigMap', arg).find(x => (x.metadata.finalizers || []).length);
        return o ? o.metadata.name : '<configmap>';
      }
      return m;
    });
  }
  KS.lessonFill = fill;
  KS.lessonHelpers = H;

  const QUIZ = (q, options, answer, why) => ({ q, options, answer, why });

  // ================================================================== curriculum
  const MODULES = [
    { id: 'start', title: 'Start here', icon: '🚀' },
    { id: 'foundations', title: 'Foundations', icon: '🧱' },
    { id: 'workloads', title: 'Workloads', icon: '📦' },
    { id: 'networking', title: 'Networking', icon: '🌐' },
    { id: 'config', title: 'Configuration & Storage', icon: '🗄️' },
    { id: 'operations', title: 'Scheduling & Operations', icon: '🛠️' },
    { id: 'security', title: 'Security', icon: '🔐' },
    { id: 'shipping', title: 'Shipping Software', icon: '🚢' },
    { id: 'incidents', title: 'Incident Lab (break/fix)', icon: '🚨' },
  ];

  const L = [];

  // ------------------------------------------------------------------ START
  L.push({
    id: 'welcome', module: 'start', title: 'Welcome to your cluster', minutes: 5, refs: [1, 2],
    intro: `You have a **real-feeling Kubernetes cluster** in your browser: one control-plane node and three worker nodes. Nothing is installed on your machine — everything is simulated, so you can break things without fear.

- **Right-top:** the live cluster map. Every box is a node; every small tile is a Pod. Click anything to inspect it.
- **Right-bottom:** your terminal. It behaves like your laptop with \`kubectl\` installed (\`k\` is an alias).
- **This panel:** the lesson. Click a command chip to paste it into the terminal, or ▶ to run it.

> **Analogy:** Kubernetes is a port authority for containers. You don't carry the cargo yourself — you tell the authority what you want shipped, and it figures out the ships, docks and routes.

Watch the **narrator** under the map: it explains in plain English what the cluster is doing after every command.`,
    steps: [
      { text: 'Ask kubectl which versions you are using. The **client** is your kubectl, the **server** is the cluster\'s API server.', cmd: 'kubectl version', check: x => x.ran(/^(kubectl|k) version/) },
      { text: 'List the machines in the cluster. Notice the `control-plane` role — that node runs the "brain", the workers run your apps.', cmd: 'kubectl get nodes', check: x => x.ran(/^(kubectl|k) get (nodes?|no)\b/) },
      { text: 'Where is the control plane listening? `cluster-info` prints the API server address — every kubectl command talks to it.', cmd: 'kubectl cluster-info', check: x => x.ran(/cluster-info/) },
      { text: 'Kubernetes runs its own components as Pods too. List Pods in **all namespaces** with `-A`. You will see etcd, the API server, the scheduler, CoreDNS and kube-proxy.', cmd: 'kubectl get pods -A', check: x => x.ran(/get (pods?|po) .*(-A|--all-namespaces)/) },
      { text: 'Try the playground helper. `sim` is not part of Kubernetes — it lets you fast-forward time, crash nodes, or add traffic.', cmd: 'sim help', check: x => x.ran(/^sim( help)?$/) },
    ],
    quiz: [
      QUIZ('What does the terminal on the right talk to when you type kubectl?', ['Directly to the containers on each node', 'The Kubernetes API server, the front door of the control plane', 'etcd, the database'], 1, 'Every kubectl command is an HTTPS request to kube-apiserver. Only the API server talks to etcd.'),
      QUIZ('Why do the system Pods (CoreDNS, kube-proxy…) live in their own namespace?', ['They are in kube-system to keep them separate from your apps', 'Namespaces are required for Pods to run', 'They run outside the cluster'], 0, 'kube-system holds cluster add-ons so they don\'t clutter (or get deleted with) your application namespaces.'),
    ],
  });

  // ------------------------------------------------------------------ FOUNDATIONS
  L.push({
    id: 'desired-state', module: 'foundations', title: 'Desired state & self-healing', minutes: 6, refs: [1, 25],
    intro: `The single most important idea in Kubernetes: **you declare the desired state, controllers make reality match it — forever.**

You never say "start 3 containers". You say "there should be 3 replicas", and a controller loop constantly compares *desired* vs *actual* and fixes any difference: a crashed container, a deleted Pod, a dead node.

> **Analogy:** a thermostat. You set 21°C. You don't turn the heater on and off yourself — the thermostat keeps checking and correcting.

This is why Kubernetes "self-heals" (Q1) and why it wins at scale over simpler tools (Q25).`,
    steps: [
      { text: 'Declare: "I want 3 copies of nginx". Watch the map — the API server stores it, the controllers create Pods, the scheduler places them, kubelets start them.', cmd: 'kubectl create deployment hello --image=nginx:1.27 --replicas=3', check: x => !!x.c.get('Deployment', 'default', 'hello'), wait: 1000 },
      { text: 'Check the actual state. Wait until all three are `Running` and `1/1` ready.', cmd: 'kubectl get pods', check: x => x.ran(/get (pods?|po)/) && readyN(x.c, 'app=hello') >= 3, wait: 6000 },
      { text: 'Now play the villain: **delete one Pod**. In a traditional setup, that app instance would just be gone.', cmd: 'kubectl delete pod {pod:app=hello}', check: x => x.ran(/delete (pods?|po) hello-/) },
      { text: 'Look again. A **new** Pod (younger AGE, new name) has already replaced it — the ReplicaSet controller saw 2 ≠ 3 and fixed it.', cmd: 'kubectl get pods', check: x => x.ran(/delete (pods?|po) hello-/) && readyN(x.c, 'app=hello') >= 3 && x.ranAfter(/delete (pods?|po) hello-/, /get (pods?|po)/), wait: 6000 },
    ],
    quiz: [
      QUIZ('A controller notices only 2 of 3 desired Pods exist. What does it do?', ['Logs an error and waits for an admin', 'Creates one more Pod', 'Restarts the node'], 1, 'Controllers reconcile: they act to make the actual state match the desired state.'),
      QUIZ('Compared to Docker Swarm, why does Kubernetes win at scale? (Q25)', ['It is simpler to install', 'Massive ecosystem (Helm, operators, autoscalers) and multi-cloud portability', 'It only works on AWS'], 1, 'The guide\'s comparison: steep learning curve, but the largest ecosystem, multi-cloud, and rich autoscaling.'),
    ],
  });

  L.push({
    id: 'architecture', module: 'foundations', title: 'Architecture: who does what', minutes: 8, refs: [2, 56, 57, 59, 60],
    intro: `A cluster has two kinds of machines (Q2):

**Control plane — the brain**
- **kube-apiserver** – the front door. Every request (yours, and every component's) goes through it: authentication → authorization → admission → validation → etcd (Q57).
- **etcd** – the key-value database holding *all* cluster state. Lose it without a backup and the cluster is gone (Q56).
- **kube-scheduler** – picks a node for every new Pod: *filter* nodes that can't fit, then *score* the rest (Q59).
- **kube-controller-manager** – runs the reconcile loops (ReplicaSet, Deployment, Node, Job…).

**Worker nodes — the hands**
- **kubelet** – the node agent; makes the containers described in Pod specs actually run.
- **kube-proxy** – programs the network rules that make Services work.
- **container runtime** – containerd here; Docker was removed as a runtime in 1.24 (Q60).

> **Analogy (from the guide):** the API server is the receptionist, etcd is the filing cabinet, the scheduler is HR assigning people to projects, the controller manager is operations, and the kubelet is each employee's manager.`,
    steps: [
      { text: 'Find the control-plane components. They run as **static Pods** on the `controlplane` node.', cmd: 'kubectl get pods -n kube-system -o wide', check: x => x.ran(/get (pods?|po) .*-n kube-system|get (pods?|po) .*--namespace[= ]kube-system/) },
      { text: 'kube-proxy must run on **every** node, so it is a DaemonSet. Count its Pods — one per node.', cmd: 'kubectl get daemonsets -n kube-system', check: x => x.ran(/get (daemonsets?|ds)\b.*kube-system/) },
      { text: 'Inspect a worker. Scroll to **System Info** (kubelet version, `containerd` runtime) and **Allocatable** (what the scheduler can hand out).', cmd: 'kubectl describe node worker-1', check: x => x.ran(/describe (nodes?|no) worker-1/) },
      { text: 'Create one Pod and **watch the map**: a request flies kubectl → API server → etcd, the scheduler picks a node, then the kubelet pulls the image and starts it.', cmd: 'kubectl run flow --image=nginx:1.27', check: x => readyN(x.c, 'run=flow') >= 1, wait: 5000 },
      { text: 'The same story, written down: events are the cluster\'s journal. You\'ll see `Scheduled` (scheduler) → `Pulling`/`Pulled`/`Created`/`Started` (kubelet).', cmd: 'kubectl get events --sort-by=.lastTimestamp', check: x => x.ran(/get (events?|ev)\b/) || x.ran(/^(kubectl|k) events/) },
    ],
    quiz: [
      QUIZ('Which component is the ONLY one that talks to etcd directly?', ['kube-scheduler', 'kubelet', 'kube-apiserver'], 2, 'All reads and writes go through the API server (Q56).'),
      QUIZ('The scheduler decides where a Pod runs in two phases. What are they?', ['Filtering, then scoring', 'Pulling, then starting', 'Authentication, then admission'], 0, 'Filter out nodes that can\'t run the Pod, then score the feasible ones and pick the best (Q59).'),
      QUIZ('Why did "removing Docker" in v1.24 not break anyone\'s images?', ['Images follow the OCI standard; only the node runtime changed to containerd/CRI-O', 'Kubernetes converts images automatically', 'It did break them'], 0, 'Docker images are OCI images; the CRI runtime just runs them (Q60).'),
    ],
  });

  // ------------------------------------------------------------------ WORKLOADS
  L.push({
    id: 'pods', module: 'workloads', title: 'Pods: the smallest unit', minutes: 8, refs: [3, 22, 23, 8],
    intro: `A **Pod** wraps one (sometimes a few) containers that share a network identity (one IP, \`localhost\`) and volumes (Q3). Kubernetes never runs a bare container — always a Pod.

Pods are **ephemeral**: they can be killed and recreated anytime, with a new IP. Never store important data inside one.

**Pod phases** (Q22): \`Pending\` (accepted, not running yet) → \`Running\` (at least one container started — not necessarily *healthy*) → \`Succeeded\` / \`Failed\`. \`Unknown\` means the node stopped reporting.

**restartPolicy** (Q23): \`Always\` (default, for services), \`OnFailure\` (Jobs), \`Never\`.

The four debugging verbs you'll use every day (Q8): **get · describe · logs · exec**.`,
    steps: [
      { text: 'Create a single Pod running nginx.', cmd: 'kubectl run nginx --image=nginx:1.27', check: x => !!x.c.get('Pod', 'default', 'nginx'), wait: 500 },
      { text: 'Get it with `-o wide` to see its **IP** and the **node** the scheduler chose.', cmd: 'kubectl get pod nginx -o wide', check: x => x.ran(/get (pods?|po) nginx.*-o wide|get (pods?|po) -o wide/) && readyN(x.c, 'run=nginx') === 1, wait: 4000 },
      { text: '`describe` is your best friend: labels, container state, conditions and — at the bottom — **Events**.', cmd: 'kubectl describe pod nginx', check: x => x.ran(/describe (pods?|po) nginx/) },
      { text: 'Read the container\'s output (stdout/stderr).', cmd: 'kubectl logs nginx', check: x => x.ran(/logs nginx/) },
      { text: 'Open a shell **inside** the container. Try `ls /usr/share/nginx/html`, `hostname`, `cat /etc/resolv.conf`, then `exit`.', cmd: 'kubectl exec -it nginx -- sh', interactive: ['ls /usr/share/nginx/html', 'hostname', 'exit'], check: x => x.ran(/exec -it nginx -- (sh|bash)|exec nginx -it -- (sh|bash)|exec -ti nginx -- (sh|bash)/) },
      { text: 'A one-shot Pod: with `--restart=Never` the container runs once. Watch it go to **Completed** (phase `Succeeded`).', cmd: 'kubectl run once --image=busybox:1.36 --restart=Never -- echo hello from a one-shot pod', check: x => { const p = x.c.get('Pod', 'default', 'once'); return !!p && p.status.phase === 'Succeeded'; }, wait: 4000 },
      { text: 'Delete the nginx Pod. Unlike the Deployment in the last lesson, **nothing** recreates a bare Pod.', cmd: 'kubectl delete pod nginx', check: x => !x.c.get('Pod', 'default', 'nginx') && x.ran(/delete (pods?|po) nginx/), wait: 3000 },
    ],
    quiz: [
      QUIZ('A Pod shows STATUS Running. Does that mean the app is healthy?', ['Yes, always', 'No — Running only means a container process started (Q22)', 'Only if RESTARTS is 0'], 1, 'Health is what readiness/liveness probes are for.'),
      QUIZ('Which restartPolicy fits a batch Job that should retry only when it fails?', ['Always', 'OnFailure', 'Never'], 1, 'OnFailure restarts on non-zero exit codes only (Q23).'),
      QUIZ('Two containers in the same Pod can talk to each other via…', ['localhost — they share the network namespace', 'Only through a Service', 'They cannot talk'], 0, 'Containers in a Pod share one IP and volumes (Q3).'),
    ],
  });

  L.push({
    id: 'kubectl-workflow', module: 'workloads', title: 'Declarative YAML workflow', minutes: 9, refs: [8, 21],
    intro: `Typing \`kubectl create\` is handy, but real teams store **YAML manifests** in Git and \`kubectl apply\` them — *declarative* configuration.

A safe workflow (Q21):
1. **Generate** a skeleton: \`--dry-run=client -o yaml > file.yaml\` (nothing is sent to the cluster).
2. **Look up fields** with \`kubectl explain\` instead of searching the web.
3. **Preview** changes with \`kubectl diff\` — "terraform plan for Kubernetes".
4. **Apply**. Re-applying the same file is safe: unchanged objects stay unchanged.

Every manifest has the same four top-level keys: \`apiVersion\`, \`kind\`, \`metadata\`, \`spec\`.`,
    steps: [
      { text: 'Generate a Pod manifest without creating anything, and save it to a file.', cmd: 'kubectl run web --image=nginx:1.27 --port=80 --dry-run=client -o yaml > web-pod.yaml', check: x => (x.file('~/web-pod.yaml') || '').includes('kind: Pod') },
      { text: 'Read it. Notice `apiVersion`, `kind`, `metadata` and `spec`.', cmd: 'cat web-pod.yaml', check: x => x.ran(/cat web-pod.yaml/) },
      { text: 'Open it in the editor and add a second label under `labels:` — `tier: frontend` (same indentation as `run: web`). Save with **Ctrl+S**.', cmd: 'nano web-pod.yaml', editor: t => t.replace('    run: web\n', '    run: web\n    tier: frontend\n'), check: x => /\n\s+tier: frontend/.test(x.file('~/web-pod.yaml') || ''), hint: 'Under metadata.labels add the line "    tier: frontend" right below "    run: web".' },
      { text: 'Apply the file. kubectl reports `created` the first time.', cmd: 'kubectl apply -f web-pod.yaml', check: x => { const p = x.c.get('Pod', 'default', 'web'); return !!p && (p.metadata.labels || {}).tier === 'frontend'; } },
      { text: 'Apply it again: `unchanged`. That idempotency is why apply is the standard.', cmd: 'kubectl apply -f web-pod.yaml', check: x => x.count(/apply -f web-pod.yaml/) >= 2 },
      { text: 'Look up what a field means — straight from the API schema.', cmd: 'kubectl explain pod.spec.containers.ports', check: x => x.ran(/explain /) },
      { text: 'Extract one value with **jsonpath** — great for scripts.', cmd: "kubectl get pod web -o jsonpath='{.status.podIP}'", check: x => x.ran(/-o jsonpath/) },
    ],
    quiz: [
      QUIZ('What does --dry-run=client do?', ['Sends the object to the server but does not save it', 'Builds the object locally without contacting the cluster', 'Deletes the object after 1 minute'], 1, '--dry-run=server would validate on the server (including admission webhooks) without persisting.'),
      QUIZ('Before applying a change in production you should run…', ['kubectl diff -f file.yaml', 'kubectl delete -f file.yaml', 'kubectl explain'], 0, 'diff shows exactly what would change (Q21).'),
    ],
  });

  L.push({
    id: 'labels', module: 'workloads', title: 'Labels, selectors & annotations', minutes: 7, refs: [9],
    intro: `**Labels** are key/value tags on objects; **selectors** query them (Q9). They are the glue of Kubernetes:

- a Deployment finds *its* Pods by label,
- a Service sends traffic to Pods by label,
- NetworkPolicies, PDBs and HPAs all target Pods by label.

> If labels don't match, the connection is silently broken — the #1 cause of "my Service has no endpoints".

**Annotations** hold non-identifying metadata (owner, git commit, tool settings). You can't select by annotation.`,
    steps: [
      { text: 'Create three Pods with different labels.', cmd: 'kubectl run shop-web --image=nginx:1.27 -l app=shop,tier=web && kubectl run shop-db --image=redis:7 -l app=shop,tier=db && kubectl run blog-web --image=nginx:1.27 -l app=blog,tier=web', check: x => ['shop-web', 'shop-db', 'blog-web'].every(n => x.c.get('Pod', 'default', n)), wait: 1000 },
      { text: 'Show labels as a column.', cmd: 'kubectl get pods --show-labels', check: x => x.ran(/--show-labels/) },
      { text: 'Select only the web tier — equality selector.', cmd: 'kubectl get pods -l tier=web', check: x => x.ran(/-l tier=web|--selector[= ]tier=web/) },
      { text: 'Set-based selector: everything that belongs to shop **and** is not the db.', cmd: "kubectl get pods -l 'app=shop,tier!=db'", check: x => x.ran(/app=shop,tier!=db/) },
      { text: 'Add a label to a running Pod.', cmd: 'kubectl label pod shop-web env=prod', check: x => ((x.c.get('Pod', 'default', 'shop-web') || { metadata: {} }).metadata.labels || {}).env === 'prod' },
      { text: 'Show chosen labels as columns with `-L`.', cmd: 'kubectl get pods -L app,env', check: x => x.ran(/-L /) },
      { text: 'Annotate — metadata for humans and tools, not for selection.', cmd: 'kubectl annotate pod shop-web owner=team-blue', check: x => ((x.c.get('Pod', 'default', 'shop-web') || { metadata: {} }).metadata.annotations || {}).owner === 'team-blue' },
    ],
    quiz: [
      QUIZ('A Service selects app=catalog but the Pods are labelled app=catalogue. What happens?', ['Kubernetes fixes the typo', 'The Service has no endpoints and traffic goes nowhere', 'The Pods crash'], 1, 'The most common misconfiguration in Kubernetes (Q9, Q86).'),
      QUIZ('You want to record which git commit deployed a Pod. Label or annotation?', ['Label', 'Annotation'], 1, 'Non-identifying metadata belongs in annotations.'),
    ],
  });

  L.push({
    id: 'deployments', module: 'workloads', title: 'Deployments & ReplicaSets', minutes: 8, refs: [4, 80],
    intro: `You almost never create Pods directly. You create a **Deployment** (Q4):

\`Deployment\` → manages → \`ReplicaSet\` → manages → \`Pods\`

- The **ReplicaSet** keeps N identical Pods alive.
- The **Deployment** adds rolling updates and rollbacks by managing *several* ReplicaSets (one per version of the Pod template).

These links are **ownerReferences** (Q80). Delete the Deployment and the garbage collector removes its ReplicaSets and Pods — a *cascading delete*.`,
    steps: [
      { text: 'Create a Deployment with 2 replicas.', cmd: 'kubectl create deployment api --image=kubester/hello:v1 --replicas=2', check: x => deployDone(x.c, 'api'), wait: 6000 },
      { text: 'See the whole chain at once. The ReplicaSet name is the Deployment name + a **pod-template-hash**; Pod names add a random suffix.', cmd: 'kubectl get deploy,rs,pods -l app=api', check: x => x.ran(/get (deploy|deployments?),(rs|replicasets?)/) },
      { text: 'Who owns a Pod? Read its ownerReferences.', cmd: "kubectl get pod {pod:app=api} -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}'", check: x => x.ran(/ownerReferences/) },
      { text: 'Scale up to 5. The Deployment updates the ReplicaSet, which creates Pods; the scheduler spreads them across workers.', cmd: 'kubectl scale deployment api --replicas=5', check: x => deployDone(x.c, 'api', null, 5), wait: 6000 },
      { text: 'Scale down to 2. Notice which Pods are removed first (newest / not-ready ones).', cmd: 'kubectl scale deployment api --replicas=2', check: x => deployDone(x.c, 'api', null, 2) && x.ran(/scale .*--replicas=2/), wait: 4000 },
      { text: 'Cascading delete: removing the Deployment removes its ReplicaSet and Pods.', cmd: 'kubectl delete deployment api', check: x => !x.c.get('Deployment', 'default', 'api') && !x.c.list('ReplicaSet', 'default').some(r => r.metadata.name.startsWith('api-')) && pods(x.c, 'app=api').length === 0, wait: 5000 },
    ],
    quiz: [
      QUIZ('Why should you create Deployments instead of bare ReplicaSets?', ['ReplicaSets are deprecated', 'Deployments add rolling updates and rollbacks by managing ReplicaSets', 'Deployments use less memory'], 1, 'Q4: "Always create Deployments, never bare ReplicaSets."'),
      QUIZ('kubectl delete deployment web --cascade=orphan …', ['deletes everything', 'deletes the Deployment but leaves its ReplicaSet and Pods running', 'is not a real flag'], 1, 'Orphan policy (Q80) — useful when re-parenting resources.'),
    ],
  });

  L.push({
    id: 'rolling-updates', module: 'workloads', title: 'Rolling updates & rollbacks', minutes: 10, refs: [16, 87],
    intro: `Change the Pod template (e.g. the image) and the Deployment performs a **rolling update** (Q16): it creates a *new* ReplicaSet and shifts Pods over gradually.

Two knobs control the pace:
- **maxSurge** – how many *extra* Pods may exist during the update,
- **maxUnavailable** – how many Pods may be *missing*.

The old ReplicaSet is kept at 0 replicas, so **rollback is instant**.

A rollout can get **stuck** (Q87): if new Pods never become Ready, Kubernetes won't kill the remaining old ones — your app keeps serving on the old version. That safety net is why a bad image doesn't take you down.`,
    steps: [
      { text: 'Look at the manifest: 4 replicas, maxSurge 1, maxUnavailable 1, image nginx:1.26.', cmd: 'cat manifests/deployment.yaml', check: x => x.ran(/cat .*deployment.yaml/) },
      { text: 'Deploy version 1.26.', cmd: 'kubectl apply -f manifests/deployment.yaml', check: x => deployDone(x.c, 'web', null, 4), wait: 7000 },
      { text: 'Record why we are changing it (shown in history), then upgrade to 1.27. **Watch the map**: new Pods appear before old ones disappear.', cmd: 'kubectl annotate deployment web kubernetes.io/change-cause="upgrade to nginx 1.27" && kubectl set image deployment/web nginx=nginx:1.27', check: x => image(x.c, 'web') === 'nginx:1.27' },
      { text: 'Follow the rollout until it finishes.', cmd: 'kubectl rollout status deployment/web', check: x => deployDone(x.c, 'web') && image(x.c, 'web') === 'nginx:1.27' && x.ran(/rollout status/), wait: 10000 },
      { text: 'Two ReplicaSets now exist: the new one with 4 Pods, the old one at 0 (kept for rollback).', cmd: 'kubectl get rs -l app=web', check: x => x.ran(/get (rs|replicasets?)/) },
      { text: 'Ship a broken version on purpose — the tag `1.99` does not exist.', cmd: 'kubectl annotate deployment web kubernetes.io/change-cause="bad release" --overwrite && kubectl set image deployment/web nginx=nginx:1.99', check: x => image(x.c, 'web') === 'nginx:1.99' },
      { text: 'The rollout is **stuck**: new Pods are in ImagePullBackOff, but 3 old Pods still serve traffic. Check with a timeout so it doesn\'t wait forever.', cmd: 'kubectl get pods -l app=web && kubectl rollout status deployment/web --timeout=10s', check: x => x.tried(/rollout status.*--timeout/) && image(x.c, 'web') === 'nginx:1.99', wait: 3000 },
      { text: 'Roll back to the previous good version.', cmd: 'kubectl rollout undo deployment/web', check: x => image(x.c, 'web') === 'nginx:1.27' && deployDone(x.c, 'web'), wait: 8000 },
      { text: 'Review the history. Rolling back re-used the old ReplicaSet and gave it a **new revision number**.', cmd: 'kubectl rollout history deployment/web', check: x => x.ran(/rollout history/) && x.ranAfter(/rollout undo/, /rollout history/) },
    ],
    quiz: [
      QUIZ('With 4 replicas, maxSurge=1 and maxUnavailable=1, what is the most Pods that can exist mid-rollout?', ['4', '5', '8'], 1, 'replicas + maxSurge = 5.'),
      QUIZ('New Pods fail their readiness probe during a rollout. What happens to the old Pods?', ['They are all killed immediately', 'They keep running — maxUnavailable stops the rollout from removing them', 'They are restarted'], 1, 'Q87: the rollout waits forever (until progressDeadlineSeconds marks it failed).'),
      QUIZ('Fastest fix for a bad image rollout?', ['kubectl rollout undo deployment/<name>', 'Delete the cluster', 'kubectl scale --replicas=0'], 0, 'Undo switches back to the previous ReplicaSet.'),
    ],
  });

  // ------------------------------------------------------------------ NETWORKING
  L.push({
    id: 'services', module: 'networking', title: 'Services & DNS', minutes: 12, refs: [5, 18, 46, 55],
    intro: `Pods come and go with new IPs. A **Service** gives a set of Pods one **stable name and virtual IP**, and load-balances across them (Q5). It finds its Pods via a **label selector**; the matching, *ready* Pod IPs are its **Endpoints** (Q55 — at scale stored as EndpointSlices).

| Type | Reachable from | Use |
|---|---|---|
| ClusterIP (default) | inside the cluster | service-to-service |
| NodePort | \`<nodeIP>:30000-32767\` | dev / simple external access |
| LoadBalancer | a cloud load balancer IP | production on cloud |
| ExternalName | DNS alias | point at an external DB |

**DNS** (Q18): CoreDNS creates \`<service>.<namespace>.svc.cluster.local\`. In the same namespace, just use \`<service>\`. A **headless** Service (\`clusterIP: None\`, Q46) returns the Pod IPs themselves.

> Your terminal is your **laptop** — outside the cluster. ClusterIPs and Pod IPs aren't reachable from it; that's exactly how real clusters behave.`,
    steps: [
      { text: 'Run 3 replicas of a tiny web app that answers with its own Pod name.', cmd: 'kubectl create deployment hello --image=kubester/hello:v1 --replicas=3 --port=8080', check: x => deployDone(x.c, 'hello', null, 3), wait: 7000 },
      { text: 'Expose it: Service port 80 → container port 8080.', cmd: 'kubectl expose deployment hello --port=80 --target-port=8080', check: x => !!x.c.get('Service', 'default', 'hello') },
      { text: 'The Service got a ClusterIP, and its Endpoints list the three Pod IPs.', cmd: 'kubectl get svc,endpoints hello', check: x => x.ran(/get (svc|services?),(ep|endpoints)|get (ep|endpoints)/), wait: 500 },
      { text: 'Start a throw-away Pod to act as a client inside the cluster.', cmd: 'kubectl run client --image=curlimages/curl -- sleep 3600', check: x => readyN(x.c, 'run=client') === 1, wait: 4000 },
      { text: 'Call the Service by name several times. Different Pods answer — that\'s load balancing by kube-proxy. (Watch the packets on the map!)', cmd: "kubectl exec client -- sh -c 'for i in 1 2 3 4; do curl -s hello; done'", check: x => x.ran(/exec client -- .*curl/) },
      { text: 'Resolve the full DNS name from inside the cluster.', cmd: 'kubectl exec client -- nslookup hello.default.svc.cluster.local', check: x => x.ran(/nslookup hello/) },
      { text: 'Now expose it **outside** the cluster with a NodePort Service.', cmd: 'kubectl expose deployment hello --name=hello-np --type=NodePort --port=80 --target-port=8080', check: x => { const s = x.c.get('Service', 'default', 'hello-np'); return !!s && s.spec.type === 'NodePort'; } },
      { text: 'From your laptop, hit any node IP on the NodePort (here worker-1 = 192.168.49.11).', cmd: 'curl 192.168.49.11:{nodeport:hello-np}', check: x => x.ran(/^curl .*192\.168\.49\.\d+:3\d{4}/) },
    ],
    quiz: [
      QUIZ('Which Pods does a Service send traffic to?', ['All Pods in the namespace', 'Ready Pods whose labels match its selector', 'The Pods it created'], 1, 'Services don\'t create Pods; they select them. Unready Pods are left out of Endpoints.'),
      QUIZ('From a Pod in namespace "web", how do you reach Service "api" in namespace "prod"?', ['api', 'api.prod', 'prod/api'], 1, '<service>.<namespace> (or the full api.prod.svc.cluster.local).'),
      QUIZ('When do you need a headless Service?', ['When Pods need individual DNS records — e.g. StatefulSets like postgres-0.postgres', 'For public websites', 'Never'], 0, 'Q46: StatefulSets, client-side load balancing, peer discovery.'),
    ],
  });

  L.push({
    id: 'ingress', module: 'networking', title: 'Ingress: one front door', minutes: 10, refs: [19, 67, 97],
    intro: `One LoadBalancer per service gets expensive. An **Ingress** routes external HTTP(S) traffic to many Services by **host** or **path** through one entry point (Q19).

The catch: an Ingress object is just configuration. **Nothing happens until an Ingress Controller** (nginx, Traefik, a cloud ALB…) is running to read it. You'll see that for yourself.

Error codes from the controller tell you where to look (Q97): **404** – no rule matched; **503** – the backend Service has no ready endpoints; **502** – a Pod was picked but nothing answered on that port.

The future is the **Gateway API** (Q67): GatewayClass → Gateway → HTTPRoute, with roles split between platform and app teams.`,
    steps: [
      { text: 'Deploy two sites and give each a Service.', cmd: 'kubectl create deployment shop --image=kubester/hello:v1 --port=8080 && kubectl create deployment blog --image=kubester/hello:v2 --port=8080 && kubectl expose deployment shop --port=80 --target-port=8080 && kubectl expose deployment blog --port=80 --target-port=8080', check: x => deployDone(x.c, 'shop') && deployDone(x.c, 'blog') && x.c.get('Service', 'default', 'shop') && x.c.get('Service', 'default', 'blog'), wait: 6000 },
      { text: 'Create an Ingress with two host rules.', cmd: 'kubectl apply -f manifests/ingress.yaml', check: x => !!x.c.get('Ingress', 'default', 'sites') },
      { text: 'Look at the ADDRESS column: **empty**. No controller is running yet, so nobody acts on the rules.', cmd: 'kubectl get ingress', check: x => x.ran(/get (ingress|ing)/) },
      { text: 'Install the ingress-nginx controller with its official manifest.', cmd: 'kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml', check: x => x.c.list('Pod', 'ingress-nginx').some(ready), wait: 8000 },
      { text: 'Now the Ingress has an address (the controller\'s load balancer).', cmd: 'kubectl get ingress sites', check: x => { const i = x.c.get('Ingress', 'default', 'sites'); return !!(i && i.status.loadBalancer.ingress) && x.ranAfter(/apply -f https:/, /get (ingress|ing)/); }, wait: 4000 },
      { text: 'Browse both hosts from your laptop (this playground maps *.local Ingress hosts to the controller\'s IP, like an /etc/hosts entry).', cmd: 'curl http://shop.local && curl http://blog.local', check: x => x.ran(/curl .*shop\.local/) && x.ran(/curl .*blog\.local/) },
      { text: 'Break it: scale shop to 0 and request it again — the controller answers **503**: no ready endpoints.', cmd: 'kubectl scale deployment shop --replicas=0 && curl -I http://shop.local', check: x => x.ran(/curl -I .*shop\.local/) && x.c.get('Deployment', 'default', 'shop').spec.replicas === 0, wait: 2000 },
    ],
    quiz: [
      QUIZ('You created an Ingress but nothing routes. Most likely cause?', ['Wrong YAML indentation', 'No Ingress Controller is running in the cluster', 'Ingress needs a LoadBalancer per host'], 1, 'Q19: an Ingress is just config; a controller must implement it.'),
      QUIZ('After a deploy, the Ingress returns 502 Bad Gateway. What does that indicate?', ['No rule matched the host', 'A backend Pod was chosen but did not respond (not listening / wrong targetPort / shutting down)', 'TLS certificate expired'], 1, 'Q97: check readiness, port chain (servicePort → targetPort → app port) and the SIGTERM race.'),
    ],
  });

  // ------------------------------------------------------------------ CONFIG & STORAGE
  L.push({
    id: 'namespaces', module: 'config', title: 'Namespaces, quotas & limits', minutes: 9, refs: [6, 44],
    intro: `**Namespaces** are virtual clusters inside one cluster (Q6): separate name scopes, an RBAC boundary, and a place to attach **quotas**. Two teams can both have a Service called \`api\`.

They are **not** a security wall: by default Pods in different namespaces can talk to each other, and they share nodes and the control plane.

Guardrails (Q44):
- **ResourceQuota** caps the *total* a namespace may use (CPU, memory, number of Pods…).
- **LimitRange** sets *per-container* defaults and maximums — so a Pod without requests still gets sane values.`,
    steps: [
      { text: 'Create a namespace for team A.', cmd: 'kubectl create namespace team-a', check: x => !!x.c.get('Namespace', '', 'team-a') },
      { text: 'Run a Pod **in** that namespace with `-n`.', cmd: 'kubectl run app1 --image=nginx:1.27 -n team-a', check: x => !!x.c.get('Pod', 'team-a', 'app1') },
      { text: 'The default namespace doesn\'t see it; `-n` or `-A` does.', cmd: 'kubectl get pods && kubectl get pods -n team-a', check: x => x.ran(/get (pods?|po) (-n team-a|--namespace[= ]team-a)/) },
      { text: 'Make team-a your default namespace for this context (saves typing -n).', cmd: 'kubectl config set-context --current --namespace=team-a', check: x => x.c.context.namespace === 'team-a' },
      { text: 'Cap the namespace: at most 3 Pods and 1 CPU of requests in total.', cmd: 'kubectl create quota team-quota --hard=pods=3,requests.cpu=1', check: x => !!x.c.get('ResourceQuota', 'team-a', 'team-quota') },
      { text: 'With a CPU quota, every Pod must declare requests — this one doesn\'t, so it\'s **rejected**. Read the error!', cmd: 'kubectl run app2 --image=nginx:1.27', check: x => x.tried(/run app2/) },
      { text: 'Add a LimitRange that fills in default requests and limits.', cmd: 'kubectl apply -f manifests/limitrange.yaml', check: x => !!x.c.get('LimitRange', 'team-a', 'defaults') },
      { text: 'Try again — now the defaults are injected and the Pod is admitted. Check the quota usage.', cmd: 'kubectl run app2 --image=nginx:1.27 && kubectl describe quota team-quota', check: x => !!x.c.get('Pod', 'team-a', 'app2') && x.ran(/describe (quota|resourcequota)/) },
      { text: 'Switch back to the default namespace (important for the next lessons!).', cmd: 'kubectl config set-context --current --namespace=default', check: x => x.c.context.namespace === 'default' && x.ran(/set-context --current --namespace[= ]default/) },
    ],
    quiz: [
      QUIZ('Do namespaces stop Pods in different namespaces from talking to each other?', ['Yes, always', 'No — by default they can; you need NetworkPolicies', 'Only in production'], 1, 'Q6: namespaces are not a security boundary.'),
      QUIZ('Why use LimitRange together with ResourceQuota?', ['Quota caps the total; LimitRange stops one Pod from grabbing it all and supplies defaults', 'They do the same thing', 'LimitRange is deprecated'], 0, 'Q44: together they give per-Pod and total guardrails.'),
    ],
  });

  L.push({
    id: 'config-secrets', module: 'config', title: 'ConfigMaps & Secrets', minutes: 12, refs: [7, 13, 36, 52, 93],
    intro: `Keep configuration **out of the image** so the same image runs in dev and prod (Q7).

- **ConfigMap** – non-sensitive key/values or whole config files.
- **Secret** – sensitive values. ⚠️ Stored **base64-encoded, not encrypted** — anyone who can read the Secret can decode it. Protect it with RBAC and encryption at rest; consider Vault + External Secrets Operator (Q52, Q77).

Two ways to consume them (Q13):
- **Environment variables** – simple, but read once at startup. Changing the ConfigMap does **not** change a running container's env.
- **Volume files** – the kubelet refreshes them (~1 minute). Apps can re-read files without restarting (Q36). Prefer volumes for Secrets: env vars leak into crash dumps and child processes (Q93).`,
    steps: [
      { text: 'Create a ConfigMap from literals.', cmd: 'kubectl create configmap app-config --from-literal=MESSAGE="Hello from a ConfigMap" --from-literal=COLOR=blue', check: x => !!x.c.get('ConfigMap', 'default', 'app-config') },
      { text: 'Create a Secret.', cmd: 'kubectl create secret generic db-creds --from-literal=password=S3cret!', check: x => !!x.c.get('Secret', 'default', 'db-creds') },
      { text: 'Deploy an app that uses both: ConfigMap as env vars **and** files, Secret as files.', cmd: 'kubectl apply -f manifests/config-demo.yaml', check: x => deployDone(x.c, 'config-demo'), wait: 6000 },
      { text: 'Ask the app — it prints MESSAGE and COLOR from its environment.', cmd: 'kubectl run curl --image=curlimages/curl --rm -it --restart=Never -- curl -s config-demo', check: x => x.ran(/curl -s config-demo/), wait: 1000 },
      { text: 'Prove the "secret" is only base64: decode it.', cmd: "kubectl get secret db-creds -o jsonpath='{.data.password}' | base64 -d", check: x => x.ran(/get secrets? db-creds .*jsonpath.*\| *base64 (-d|--decode)/) },
      { text: 'Change the ConfigMap.', cmd: 'kubectl create configmap app-config --from-literal=MESSAGE="Updated message" --from-literal=COLOR=green --dry-run=client -o yaml | kubectl apply -f -', check: x => ((x.c.get('ConfigMap', 'default', 'app-config') || {}).data || {}).MESSAGE === 'Updated message' },
      { text: 'Fast-forward a minute. The **mounted file** has been refreshed (read it via the toolbox container, since the app image is distroless)…', cmd: "sim fast-forward 1m && kubectl exec deploy/config-demo -c toolbox -- cat /etc/config/MESSAGE", check: x => x.ran(/cat \/etc\/config\/MESSAGE/) },
      { text: '…but the app still prints the **old** message: its environment was fixed when the container started.', cmd: 'kubectl run curl --image=curlimages/curl --rm -it --restart=Never -- curl -s config-demo', check: x => x.count(/curl -s config-demo/) >= 2, wait: 1000 },
      { text: 'Env vars only change when Pods restart. Roll the Deployment, then ask once more — "Updated message".', cmd: 'kubectl rollout restart deployment/config-demo && kubectl rollout status deployment/config-demo && kubectl run curl --image=curlimages/curl --rm -it --restart=Never -- curl -s config-demo', check: x => x.ran(/rollout restart (deployment|deploy)\/config-demo/) && deployDone(x.c, 'config-demo') && x.count(/curl -s config-demo/) >= 3, wait: 10000 },
    ],
    quiz: [
      QUIZ('Is a Kubernetes Secret encrypted?', ['Yes, with AES by default', 'No — base64-encoded; enable encryption at rest and restrict RBAC', 'Only in kube-system'], 1, 'Q7/Q77.'),
      QUIZ('You update a ConfigMap consumed via envFrom. When does the app see it?', ['Immediately', 'After about a minute', 'Only after the Pod restarts'], 2, 'Env vars are fixed at container start (Q13, Q36). Tools like Reloader automate the restart.'),
      QUIZ('A file mounted with subPath from a ConfigMap…', ['updates normally', 'never receives updates', 'is read-write'], 1, 'Q36: subPath mounts are a snapshot.'),
    ],
  });

  L.push({
    id: 'storage', module: 'config', title: 'Volumes, PVCs & StatefulSets', minutes: 14, refs: [20, 33, 17, 88],
    intro: `Container filesystems die with the container. For data that must survive, use **PersistentVolumes** (Q20):

- **PersistentVolume (PV)** – a piece of storage (an "apartment").
- **PersistentVolumeClaim (PVC)** – a request for storage (an "application").
- **StorageClass** – a recipe for creating PVs on demand: *dynamic provisioning* (Q33). Key settings: \`reclaimPolicy\` (Delete vs Retain), \`volumeBindingMode\` (Immediate vs **WaitForFirstConsumer**), \`allowVolumeExpansion\`.

**StatefulSets** (Q17) are for databases & queues: stable names (\`db-0, db-1…\`), ordered start-up, and **one PVC per Pod** that follows it across restarts.`,
    steps: [
      { text: 'List the StorageClasses. `standard` is the default and uses **WaitForFirstConsumer**.', cmd: 'kubectl get storageclass', check: x => x.ran(/get (sc|storageclass(es)?)/) },
      { text: 'Create a PVC. It stays **Pending** — not an error! It waits for a Pod to use it, so the volume is created in the right zone (Q88).', cmd: 'kubectl apply -f manifests/pvc.yaml && kubectl get pvc data', check: x => !!x.c.get('PersistentVolumeClaim', 'default', 'data') && x.ran(/get pvc/) },
      { text: 'Start a Pod that mounts it. Now the PVC binds and a PV is provisioned.', cmd: 'kubectl apply -f manifests/pvc-pod.yaml', check: x => { const c = x.c.get('PersistentVolumeClaim', 'default', 'data'); return !!c && c.status.phase === 'Bound' && readyN(x.c, '', 'default') >= 1 && !!x.c.get('Pod', 'default', 'writer') && ready(x.c.get('Pod', 'default', 'writer')); }, wait: 5000 },
      { text: 'Write a file to the volume.', cmd: 'kubectl exec writer -- sh -c "echo my precious data > /data/notes.txt"', check: x => x.ran(/exec writer -- sh -c ["']echo .*> \/data\//) },
      { text: 'Delete the Pod and recreate it. The **data survives**, because it lives on the PV, not in the container.', cmd: 'kubectl delete pod writer --now && kubectl apply -f manifests/pvc-pod.yaml', check: x => x.ran(/delete (pods?|po) writer/) && !!x.c.get('Pod', 'default', 'writer') && ready(x.c.get('Pod', 'default', 'writer')), wait: 5000 },
      { text: 'Read it back.', cmd: 'kubectl exec writer -- cat /data/notes.txt', check: x => x.ranAfter(/delete (pods?|po) writer/, /exec writer -- cat \/data\/notes.txt/) },
      { text: 'Now a StatefulSet of 3 postgres Pods. **Watch the map**: db-0 starts, and only when it is Ready does db-1 start.', cmd: 'kubectl apply -f manifests/statefulset.yaml', check: x => { const s = x.c.get('StatefulSet', 'default', 'db'); return !!s && (s.status.readyReplicas || 0) === 3; }, wait: 20000 },
      { text: 'Each Pod has its **own** PVC named after it.', cmd: 'kubectl get pods,pvc -l app=db', check: x => x.ran(/get (pods?|po),pvc|get pvc/) },
      { text: 'Stable DNS per Pod via the headless Service: `db-1.db`.', cmd: 'kubectl run dns --image=busybox:1.36 --rm -it --restart=Never -- nslookup db-1.db', check: x => x.ran(/nslookup db-1\.db/), wait: 1000 },
    ],
    quiz: [
      QUIZ('A PVC is Pending with "waiting for first consumer". What should you do?', ['Delete it — it is broken', 'Nothing; create a Pod that uses it (WaitForFirstConsumer)', 'Restart the API server'], 1, 'Q88 step 2: this is normal for zone-aware storage.'),
      QUIZ('For a production database volume, which reclaimPolicy?', ['Delete', 'Retain', 'Recycle'], 1, 'Q33: Delete destroys the data when the PVC is deleted.'),
      QUIZ('What does a StatefulSet give that a Deployment doesn\'t?', ['More replicas', 'Stable identity (db-0), ordered start/stop, and a PVC per Pod', 'Faster startup'], 1, 'Q17.'),
    ],
  });

  // ------------------------------------------------------------------ OPERATIONS
  L.push({
    id: 'probes', module: 'operations', title: 'Health probes', minutes: 10, refs: [12, 90],
    intro: `The kubelet can check your containers three ways (Q12):

| Probe | Question | On failure |
|---|---|---|
| **liveness** | Is it alive (not deadlocked)? | **restart** the container |
| **readiness** | Can it take traffic right now? | **remove from Service endpoints** (no restart) |
| **startup** | Has it finished starting? | delay the other two; restart if it never starts |

Probes can run a command (\`exec\`), call HTTP (\`httpGet\`) or open a TCP socket.

> The classic mistake: an over-eager liveness probe on a slow app → restart → slower → more restarts. A **restart cascade**. Be generous with \`initialDelaySeconds\` and \`timeoutSeconds\`, or use a startup probe.`,
    steps: [
      { text: 'This is the official Kubernetes example: the container deletes `/tmp/healthy` after 30 seconds, and the liveness probe `cat /tmp/healthy` starts failing.', cmd: 'cat manifests/liveness.yaml && kubectl apply -f manifests/liveness.yaml', check: x => !!x.c.get('Pod', 'default', 'liveness-exec') },
      { text: 'Wait about a minute (or fast-forward) and look: RESTARTS went up. The events tell the story: *Unhealthy* → *Killing*.', cmd: 'sim fast-forward 60s && kubectl describe pod liveness-exec | tail -n 6', check: x => { const p = x.c.get('Pod', 'default', 'liveness-exec'); return !!p && ((p.status.containerStatuses || [])[0] || {}).restartCount >= 1 && x.ran(/describe (pods?|po) liveness-exec/); } },
      { text: 'Readiness: 3 nginx Pods are ready only while their `index.html` exists.', cmd: 'kubectl apply -f manifests/readiness.yaml', check: x => readyN(x.c, 'app=ready-web') === 3, wait: 6000 },
      { text: 'All three are in the Service endpoints.', cmd: 'kubectl get endpoints ready-web', check: x => x.ran(/get (ep|endpoints) ready-web/) },
      { text: 'Simulate a temporary problem in one Pod: remove its file.', cmd: 'kubectl exec {pod:app=ready-web} -- rm /usr/share/nginx/html/index.html', check: x => x.ran(/exec ready-web-\S+ -- rm /) },
      { text: 'That Pod is now `0/1` and **left the endpoints** — but it was **not restarted**.', cmd: 'kubectl get pods -l app=ready-web && kubectl get endpoints ready-web', check: x => readyN(x.c, 'app=ready-web') === 2 && x.ranAfter(/-- rm /, /get (ep|endpoints) ready-web/), wait: 3000 },
      { text: 'Fix it: put a file back. It becomes Ready and rejoins.', cmd: "kubectl exec {pod:app=ready-web} -- sh -c 'echo back > /usr/share/nginx/html/index.html'", check: x => readyN(x.c, 'app=ready-web') === 3 && x.ran(/echo .*> \/usr\/share\/nginx\/html\/index.html/), wait: 3000 },
    ],
    quiz: [
      QUIZ('Your app loses its DB connection for a minute and should stop receiving traffic, not restart. Which probe?', ['liveness', 'readiness', 'startup'], 1, 'Readiness removes it from endpoints until it recovers.'),
      QUIZ('A JVM app takes 90s to start and keeps getting killed. Best fix?', ['Remove all probes', 'Add a startup probe (or a generous initialDelaySeconds)', 'Raise replicas'], 1, 'Startup probes disable liveness until the app has started.'),
      QUIZ('Rolling updates cause brief 503s. Which combination fixes it? (Q90)', ['preStop sleep + graceful SIGTERM handling + readiness failing on shutdown', 'More replicas only', 'A liveness probe'], 0, 'The endpoint-removal race needs the preStop delay.'),
    ],
  });

  L.push({
    id: 'resources', module: 'operations', title: 'Requests, limits & OOMKilled', minutes: 10, refs: [15, 89, 29, 66],
    intro: `Every container can declare (Q15):

- **requests** – what it needs. The **scheduler** only places a Pod on a node with that much *unrequested* capacity. (It schedules by requests, not by actual usage!)
- **limits** – the ceiling. **Memory** limit exceeded → the kernel **OOM-kills** it (exit code **137**). **CPU** limit exceeded → it is **throttled**, not killed.

Requests and limits also decide the **QoS class**: Guaranteed (requests = limits), Burstable, or BestEffort (nothing set — first to be evicted).

> Golden rule: requests ≈ normal usage, memory limit = peak + margin. VPA can recommend values (Q29); right-sizing is the #1 cost saver (Q66).`,
    steps: [
      { text: 'Each worker has 2 CPUs. This Pod requests **3**.', cmd: 'cat manifests/greedy-pod.yaml && kubectl apply -f manifests/greedy-pod.yaml', check: x => !!x.c.get('Pod', 'default', 'greedy') },
      { text: 'It is stuck **Pending**. The Events say exactly why: `Insufficient cpu`.', cmd: 'kubectl describe pod greedy | grep -A3 Events', check: x => x.ran(/describe (pods?|po) greedy/), wait: 2000 },
      { text: 'A Pod\'s resources can\'t be edited in place, so delete it and run one that asks for a reasonable 250m.', cmd: `kubectl delete pod greedy && kubectl run modest --image=nginx:1.27 --overrides='{"spec":{"containers":[{"name":"modest","image":"nginx:1.27","resources":{"requests":{"cpu":"250m"}}}]}}' && kubectl get pod modest`, check: x => !x.c.get('Pod', 'default', 'greedy') && !!x.c.get('Pod', 'default', 'modest'), wait: 3000 },
      { text: 'Memory is different: this process wants 250M but its limit is 100Mi.', cmd: 'cat manifests/memhog.yaml && kubectl apply -f manifests/memhog.yaml', check: x => !!x.c.get('Pod', 'default', 'memhog'), wait: 3000 },
      { text: 'It gets **OOMKilled** and goes into CrashLoopBackOff. Find the reason and exit code 137 in Last State.', cmd: 'kubectl get pod memhog && kubectl describe pod memhog | grep -A4 "Last State"', check: x => { const p = x.c.get('Pod', 'default', 'memhog'); const cs = p && (p.status.containerStatuses || [])[0]; return !!cs && ((cs.lastState.terminated || {}).reason === 'OOMKilled' || ((cs.state.terminated || {}).reason === 'OOMKilled')) && x.ran(/describe (pods?|po) memhog|get (pods?|po) memhog/); }, wait: 2000 },
      { text: 'See real usage (metrics-server). Remember: the scheduler doesn\'t look at this — it looks at requests.', cmd: 'kubectl top pods && kubectl top nodes', check: x => x.ran(/top (pods?|po)/) || x.ran(/top (nodes?|no)/) },
      { text: 'Check how much each node has **allocated** (sum of requests).', cmd: 'kubectl describe node worker-1 | grep -A6 "Allocated resources"', check: x => x.ran(/describe (nodes?|no) worker/) },
    ],
    quiz: [
      QUIZ('A container exceeds its CPU limit. What happens?', ['It is OOM-killed', 'It is throttled', 'The node reboots'], 1, 'CPU is compressible; memory is not (Q15).'),
      QUIZ('Exit code 137 usually means…', ['Command not found', 'Killed by SIGKILL — typically OOMKilled', 'Permission denied'], 1, '137 = 128 + 9 (Q82, Q89).'),
      QUIZ('A Java app with -Xmx512m and memory limit 512Mi keeps getting OOMKilled. Why? (Q89)', ['Heap + non-heap (threads, metaspace, buffers) exceed the limit', 'Java ignores limits', 'The limit is too high'], 0, 'Set -Xmx to ~75% of the container limit.'),
    ],
  });

  L.push({
    id: 'multi-container', module: 'workloads', title: 'Init containers & sidecars', minutes: 9, refs: [14, 24, 39, 73],
    intro: `**Init containers** (Q14) run **before** the app, one after another, and must succeed: wait for a dependency, run a migration, fetch config.

**Multi-container Pods** (Q24) share network and volumes:
- **sidecar** – helps the main container (log shipper, proxy, file refresher),
- **ambassador** – proxies outbound traffic,
- **adapter** – converts output formats.

Since 1.28 a *native sidecar* is an init container with \`restartPolicy: Always\` — it starts first and stops last (Q73).

**Lifecycle hooks** (Q39): \`postStart\` (runs alongside the entrypoint, no guarantees) and \`preStop\` — the hook that prevents 503s by letting load balancers catch up before shutdown.`,
    steps: [
      { text: 'This Pod\'s init container waits until the name `mydb` resolves in DNS.', cmd: 'cat manifests/init-demo.yaml && kubectl apply -f manifests/init-demo.yaml', check: x => !!x.c.get('Pod', 'default', 'myapp'), wait: 3000 },
      { text: 'It is stuck at `Init:0/1`. The init container\'s logs say why.', cmd: 'kubectl get pod myapp && kubectl logs myapp -c wait-for-db --tail=3', check: x => x.ran(/logs myapp -c wait-for-db/) },
      { text: 'Give it what it waits for: a Service named mydb.', cmd: 'kubectl create service clusterip mydb --tcp=5432:5432', check: x => !!x.c.get('Service', 'default', 'mydb') },
      { text: 'Init completes (its loop sleeps 2s between tries), then the app starts. `kubectl wait` blocks until a condition is true — handy in scripts.', cmd: 'kubectl wait --for=condition=Ready pod/myapp --timeout=30s && kubectl logs myapp', check: x => { const p = x.c.get('Pod', 'default', 'myapp'); return !!p && ready(p) && x.ranAfter(/create service/, /logs myapp/); }, wait: 5000 },
      { text: 'A sidecar Pod: busybox rewrites index.html every 5s into a shared `emptyDir`; nginx serves it.', cmd: 'kubectl apply -f manifests/sidecar-demo.yaml', check: x => { const p = x.c.get('Pod', 'default', 'web-with-sidecar'); return !!p && ready(p); }, wait: 6000 },
      { text: 'Two containers, so READY shows `2/2`. Fetch the page twice — the content changes.', cmd: "kubectl get pod web-with-sidecar && kubectl exec web-with-sidecar -c nginx -- curl -s localhost && sleep 6 && kubectl exec web-with-sidecar -c nginx -- curl -s localhost", check: x => x.count(/exec web-with-sidecar -c nginx -- curl/) >= 1 },
    ],
    quiz: [
      QUIZ('Init containers run…', ['in parallel with the app', 'sequentially, each must succeed before the next/app starts', 'only on failure'], 1, 'Q14.'),
      QUIZ('Why is postStart a bad place for "must finish before the app starts" work?', ['It runs in parallel with the ENTRYPOINT — no ordering guarantee', 'It never runs', 'It needs root'], 0, 'Use init containers instead (Q39).'),
    ],
  });

  L.push({
    id: 'daemonsets-jobs', module: 'workloads', title: 'DaemonSets, Jobs & CronJobs', minutes: 10, refs: [10, 11, 109],
    intro: `Not every workload is a long-running web server.

- **DaemonSet** (Q10) – exactly one Pod **per node** (log collectors, monitoring agents, CNI plugins). New node → new Pod automatically.
- **Job** (Q11) – run to **completion**, retrying on failure up to \`backoffLimit\`.
- **CronJob** – creates Jobs on a schedule.

> Always set \`successfulJobsHistoryLimit\`, \`failedJobsHistoryLimit\` and \`ttlSecondsAfterFinished\` — a CronJob every minute is 43,200 Jobs a month; without cleanup it fills etcd (Q109).`,
    steps: [
      { text: 'Deploy a log-collector DaemonSet. It tolerates the control-plane taint, so it lands on all 4 nodes.', cmd: 'kubectl apply -f manifests/node-agent.yaml', check: x => { const d = x.c.get('DaemonSet', 'default', 'node-agent'); return !!d && (d.status.numberReady || 0) === 4; }, wait: 6000 },
      { text: 'One Pod per node — check the NODE column.', cmd: 'kubectl get pods -l app=node-agent -o wide', check: x => x.ran(/get (pods?|po) -l app=node-agent -o wide|get (pods?|po) -o wide -l app=node-agent/) },
      { text: 'Run a Job that computes π to 100 digits.', cmd: 'kubectl apply -f manifests/pi-job.yaml', check: x => { const j = x.c.get('Job', 'default', 'pi'); return !!j && (j.status.succeeded || 0) === 1; }, wait: 8000 },
      { text: 'It completed. Read the result from its logs.', cmd: 'kubectl get jobs && kubectl logs job/pi', check: x => x.ran(/logs (job\/pi|pi-)/) },
      { text: 'A CronJob that runs every minute, with history limits.', cmd: 'kubectl apply -f manifests/cronjob.yaml', check: x => !!x.c.get('CronJob', 'default', 'report') },
      { text: 'Fast-forward 5 minutes. 5 Jobs ran, but only the last **3** finished ones are kept.', cmd: 'sim fast-forward 5m && kubectl get cronjob,jobs', check: x => { const js = x.c.list('Job', 'default').filter(j => j.metadata.name.startsWith('report-')); return js.length >= 3 && js.length <= 4 && x.ran(/sim (fast-forward|ff) 5m/) && x.ran(/get (cronjobs?|cj)/); } },
      { text: 'Trigger the CronJob right now (handy for testing).', cmd: 'kubectl create job report-manual --from=cronjob/report', check: x => !!x.c.get('Job', 'default', 'report-manual') },
    ],
    quiz: [
      QUIZ('A new node joins the cluster. What does a DaemonSet do?', ['Nothing', 'Schedules its Pod onto the new node automatically', 'Moves a Pod from another node'], 1, 'Q10.'),
      QUIZ('A CronJob every minute without history limits for months… what breaks? (Q109)', ['Nothing', 'Thousands of completed Jobs/Pods slow the API and fill etcd', 'The node runs out of CPU'], 1, 'Set history limits and ttlSecondsAfterFinished.'),
    ],
  });

  L.push({
    id: 'scheduling', module: 'operations', title: 'Scheduling: selectors, taints & affinity', minutes: 12, refs: [26, 27, 48, 49, 59],
    intro: `You can steer where Pods land (Q26, Q27):

- **nodeSelector / node affinity** – *attract* Pods to nodes with certain labels ("I want SSD").
- **Taints** on nodes *repel* Pods; a matching **toleration** lets a Pod in anyway ("GPU nodes only for ML jobs"). Effects: \`NoSchedule\`, \`PreferNoSchedule\`, \`NoExecute\` (also evicts running Pods).
- **Pod anti-affinity** – keep replicas apart so one node failure can't take them all.
- **Topology spread** – spread evenly across zones (\`maxSkew\`, Q48).
- **PriorityClass** – when full, high-priority Pods can preempt low-priority ones (Q49).

> The guide's analogy: a hotel. Affinity = "I want an ocean view". Taint = "no pets on this floor". Toleration = the service-animal certificate.`,
    steps: [
      { text: 'Label worker-2 as having SSDs.', cmd: 'kubectl label node worker-2 disktype=ssd', check: x => ((x.c.get('Node', '', 'worker-2') || { metadata: {} }).metadata.labels || {}).disktype === 'ssd' },
      { text: 'A Pod with `nodeSelector: disktype=ssd` can only go there.', cmd: 'kubectl apply -f manifests/ssd-pod.yaml && kubectl get pod fast-app -o wide', check: x => { const p = x.c.get('Pod', 'default', 'fast-app'); return !!p && p.spec.nodeName === 'worker-2'; }, wait: 2000 },
      { text: 'Reserve worker-3 for GPU work with a taint.', cmd: 'kubectl taint nodes worker-3 gpu=true:NoSchedule', check: x => ((x.c.get('Node', '', 'worker-3') || { spec: {} }).spec.taints || []).some(t => t.key === 'gpu') },
      { text: 'This Pod tolerates the taint (and asks for worker-3), so it is allowed in.', cmd: 'kubectl apply -f manifests/gpu-pod.yaml && kubectl get pod trainer -o wide', check: x => { const p = x.c.get('Pod', 'default', 'trainer'); return !!p && p.spec.nodeName === 'worker-3'; }, wait: 2000 },
      { text: 'A required anti-affinity Deployment of 3: never two on the same node. With worker-3 tainted, only 2 nodes qualify…', cmd: 'kubectl apply -f manifests/spread.yaml && sleep 3 && kubectl get pods -l app=spread -o wide', check: x => !!x.c.get('Deployment', 'default', 'spread') && x.ran(/get (pods?|po) -l app=spread/), wait: 3000 },
      { text: '…so one replica is **Pending**. Read the scheduler\'s reasoning.', cmd: 'kubectl describe pods -l app=spread | grep FailedScheduling', check: x => x.ran(/describe (pods?|po) -l app=spread|describe (pods?|po) spread-/) },
      { text: 'Remove the taint (the trailing `-` removes it). The Pending replica is scheduled on worker-3.', cmd: 'kubectl taint nodes worker-3 gpu=true:NoSchedule-', check: x => readyN(x.c, 'app=spread') === 3, wait: 5000 },
    ],
    quiz: [
      QUIZ('Which taint effect also evicts already-running Pods without a toleration?', ['NoSchedule', 'PreferNoSchedule', 'NoExecute'], 2, 'Q26.'),
      QUIZ('Why prefer "preferred" anti-affinity over "required" for most Deployments? (Q27)', ['It is faster', 'Required can deadlock scheduling when you have fewer nodes than replicas', 'Required is deprecated'], 1, 'You just saw a Pending replica.'),
      QUIZ('Required node affinity on a label no node has → the Pod…', ['runs anywhere', 'stays Pending forever', 'crashes'], 1, 'Always check kubectl get nodes --show-labels (Q26).'),
    ],
  });

  L.push({
    id: 'autoscaling', module: 'operations', title: 'Autoscaling with HPA', minutes: 10, refs: [28, 29, 74, 95],
    intro: `The **HorizontalPodAutoscaler** adds/removes replicas based on metrics (Q28):

\`desiredReplicas = ceil(currentReplicas × currentMetric / target)\`

e.g. 3 replicas at 80% CPU with a 50% target → ceil(4.8) = **5**.

It needs **metrics-server** and — the #1 gotcha — **CPU requests**, because utilization is *usage ÷ request*.

Scale-up is fast; scale-down waits a **5-minute stabilization window** to avoid flapping (Q95). The full toolbox (Q29, Q74): HPA (more Pods), VPA (right-size requests), Cluster Autoscaler/Karpenter (more nodes), KEDA (event-driven, scale to zero).`,
    steps: [
      { text: 'Deploy nginx **without** resource requests and attach an HPA targeting 50% CPU.', cmd: 'kubectl create deployment web --image=nginx:1.27 && kubectl autoscale deployment web --cpu-percent=50 --min=1 --max=6', check: x => !!x.c.get('HorizontalPodAutoscaler', 'default', 'web'), wait: 4000 },
      { text: 'After a sync (15s), TARGETS shows `<unknown>`. Describe it: "missing request for cpu".', cmd: 'sim fast-forward 20s && kubectl get hpa web && kubectl describe hpa web | tail -n 3', check: x => x.ran(/describe (hpa|horizontalpodautoscalers?) web/) },
      { text: 'Fix it: give the container a CPU request.', cmd: 'kubectl set resources deployment web --requests=cpu=100m', check: x => { const d = x.c.get('Deployment', 'default', 'web'); return !!d && ((d.spec.template.spec.containers[0].resources || {}).requests || {}).cpu === '100m'; }, wait: 5000 },
      { text: 'Simulate traffic: 450m of CPU demand shared by the Pods (one Pod would be at 450%!).', cmd: 'sim load web 450m', check: x => !!x.c.rt.loads['default/web'] },
      { text: 'Watch the HPA scale up within a few syncs.', cmd: 'sim fast-forward 45s && kubectl get hpa web && kubectl get deploy web', check: x => { const d = x.c.get('Deployment', 'default', 'web'); return !!d && d.spec.replicas >= 5; } },
      { text: 'Traffic stops. Note the replicas do **not** drop immediately — the stabilization window.', cmd: 'sim load web off && sim fast-forward 1m && kubectl get hpa web', check: x => !x.c.rt.loads['default/web'] && x.ran(/sim load web off/) },
      { text: 'After 5 minutes of low usage it scales back down to the minimum.', cmd: 'sim fast-forward 5m && kubectl get hpa web', check: x => { const d = x.c.get('Deployment', 'default', 'web'); return !!d && d.spec.replicas === 1 && x.ran(/sim (fast-forward|ff) 5m/); } },
    ],
    quiz: [
      QUIZ('Target CPU 50%, current 80%, 3 replicas. Desired replicas?', ['4', '5', '6'], 1, 'ceil(3 × 80/50) = ceil(4.8) = 5.'),
      QUIZ('HPA shows <unknown> for CPU. Most likely cause?', ['Pods have no CPU requests', 'Too many replicas', 'The Deployment is paused'], 0, 'Q28.'),
      QUIZ('Can you run VPA in auto mode and HPA on CPU for the same Deployment?', ['Yes, recommended', 'No — they fight; use VPA in recommendation mode', 'Only on weekends'], 1, 'Q29.'),
    ],
  });

  L.push({
    id: 'maintenance', module: 'operations', title: 'Node maintenance & PDBs', minutes: 12, refs: [34, 64, 85, 104],
    intro: `Nodes need upgrades. The safe dance (Q64): **cordon** (no new Pods) → **drain** (evict Pods so controllers recreate them elsewhere) → upgrade → **uncordon**. One node at a time.

A **PodDisruptionBudget** (Q34) protects you during *voluntary* disruptions: \`kubectl drain\` uses the eviction API and **waits** rather than violate \`minAvailable\` / \`maxUnavailable\`. PDBs do **not** help when a node crashes (involuntary) — that's what spreading replicas is for.

When a node dies (Q85): after ~40s it goes \`NotReady\`, after 300s its Pods are evicted — and they hang in \`Terminating\` because nobody on that node can confirm they stopped.`,
    steps: [
      { text: 'Run 3 replicas and protect them with a PDB: at least 2 must stay available.', cmd: 'kubectl create deployment pay --image=kubester/hello:v1 --replicas=3 && kubectl create pdb pay-pdb --selector=app=pay --min-available=2', check: x => deployDone(x.c, 'pay', null, 3) && !!x.c.get('PodDisruptionBudget', 'default', 'pay-pdb'), wait: 6000 },
      { text: 'ALLOWED DISRUPTIONS = 1 (3 healthy − 2 required).', cmd: 'kubectl get pdb pay-pdb', check: x => x.ran(/get (pdb|poddisruptionbudgets?)/) },
      { text: 'Drain the node running one of them. DaemonSet Pods (kube-proxy, kindnet) must be ignored explicitly.', cmd: 'kubectl drain {nodeof:app=pay} --ignore-daemonsets', check: x => x.ran(/drain worker-\d .*--ignore-daemonsets|drain worker-\d$/) && x.c.list('Node').some(n => n.spec.unschedulable), wait: 2000 },
      { text: 'The node is `SchedulingDisabled`, and the evicted Pod was recreated on another node.', cmd: 'kubectl get nodes && kubectl get pods -l app=pay -o wide', check: x => readyN(x.c, 'app=pay') === 3 && x.ranAfter(/drain /, /get (nodes?|no)/), wait: 5000 },
      { text: 'Maintenance done — uncordon every node.', cmd: 'kubectl uncordon worker-1 && kubectl uncordon worker-2 && kubectl uncordon worker-3', check: x => !x.c.list('Node').some(n => n.spec.unschedulable) },
      { text: 'Now an *involuntary* failure: crash worker-2\'s kubelet and fast-forward 1 minute.', cmd: 'sim node down worker-2 && sim fast-forward 1m && kubectl get nodes', check: x => { const n = x.c.get('Node', '', 'worker-2'); return ((n.status.conditions || []).find(c => c.type === 'Ready') || {}).status === 'Unknown'; } },
      { text: 'The node is **NotReady** — "Kubelet stopped posting node status".', cmd: 'kubectl describe node worker-2 | grep -A6 Conditions', check: x => x.ran(/describe (nodes?|no) worker-2/) },
      { text: 'Bring it back.', cmd: 'sim node up worker-2 && sleep 2 && kubectl get nodes', check: x => { const n = x.c.get('Node', '', 'worker-2'); return ((n.status.conditions || []).find(c => c.type === 'Ready') || {}).status === 'True' && x.ran(/sim node up worker-2/); }, wait: 2000 },
    ],
    quiz: [
      QUIZ('Does a PDB protect against a node hardware crash?', ['Yes', 'No — only voluntary disruptions like drains', 'Only with minAvailable'], 1, 'Q34.'),
      QUIZ('Which drain flag bypasses PDBs and should be avoided in production? (Q104)', ['--ignore-daemonsets', '--disable-eviction (and --force for bare Pods)', '--timeout'], 1, 'Only the eviction API respects PDBs.'),
      QUIZ('Correct order for node maintenance?', ['drain → cordon → uncordon', 'cordon → drain → upgrade → uncordon', 'delete node → recreate'], 1, 'Q64.'),
    ],
  });

  // ------------------------------------------------------------------ SECURITY
  L.push({
    id: 'rbac', module: 'security', title: 'RBAC & ServiceAccounts', minutes: 10, refs: [31, 76],
    intro: `**RBAC** answers: *can user X do verb Y on resource Z?* (Q31)

- **Role** – permissions inside one namespace ("get, list pods in dev").
- **ClusterRole** – cluster-wide or for cluster-scoped things (nodes, PVs).
- **RoleBinding / ClusterRoleBinding** – grant a role to users, groups or **ServiceAccounts**.

Every Pod runs as a **ServiceAccount**. Give apps their *own* SA with the *least* privilege — never cluster-admin for automation.

\`--as\` lets you **impersonate** someone to test permissions safely.`,
    steps: [
      { text: 'Create a namespace and a ServiceAccount for a read-only dashboard.', cmd: 'kubectl create namespace dev && kubectl create serviceaccount dashboard -n dev', check: x => !!x.c.get('ServiceAccount', 'dev', 'dashboard') },
      { text: 'A Role that can only read Pods (and their logs).', cmd: 'kubectl create role pod-reader --verb=get,list,watch --resource=pods,pods/log -n dev', check: x => !!x.c.get('Role', 'dev', 'pod-reader') },
      { text: 'Bind the Role to the ServiceAccount.', cmd: 'kubectl create rolebinding dashboard-read --role=pod-reader --serviceaccount=dev:dashboard -n dev', check: x => !!x.c.get('RoleBinding', 'dev', 'dashboard-read') },
      { text: 'Test with impersonation: can it list Pods? Delete them?', cmd: 'kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:dashboard; kubectl auth can-i delete pods -n dev --as=system:serviceaccount:dev:dashboard', check: x => x.tried(/auth can-i list pods.*--as=system:serviceaccount:dev:dashboard/) && x.tried(/auth can-i delete pods.*--as=system:serviceaccount:dev:dashboard/) },
      { text: 'Act as it for real — reading Secrets is **Forbidden**.', cmd: 'kubectl get secrets -n dev --as=system:serviceaccount:dev:dashboard', check: x => x.tried(/get secrets? -n dev --as=system:serviceaccount:dev:dashboard/) },
      { text: 'Everything it may do, at a glance.', cmd: 'kubectl auth can-i --list -n dev --as=system:serviceaccount:dev:dashboard', check: x => x.ran(/auth can-i --list/) },
    ],
    quiz: [
      QUIZ('You need read access to Nodes. Role or ClusterRole?', ['Role', 'ClusterRole — nodes are cluster-scoped'], 1, 'Q31.'),
      QUIZ('A CI pipeline needs to deploy into one namespace. Best practice?', ['Give it cluster-admin', 'A dedicated ServiceAccount with a namespaced Role limited to what it needs', 'Use the default ServiceAccount'], 1, 'Least privilege (Q31).'),
    ],
  });

  L.push({
    id: 'pod-security', module: 'security', title: 'Security contexts & Pod Security', minutes: 10, refs: [37, 38, 110, 62],
    intro: `**securityContext** hardens a container (Q37). The production baseline:

\`runAsNonRoot: true\` · \`allowPrivilegeEscalation: false\` · \`capabilities.drop: ["ALL"]\` · \`readOnlyRootFilesystem: true\` · \`seccompProfile: RuntimeDefault\`

**Pod Security Admission** (Q38) enforces standard profiles per namespace via labels: **privileged**, **baseline**, **restricted**, in modes **enforce** (reject), **audit** (log), **warn** (tell the user).

Roll out with warn/audit first, then enforce — and remember PSA only checks Pods **at creation** (Q110).`,
    steps: [
      { text: 'Create a namespace that **enforces** the restricted profile.', cmd: 'kubectl create namespace secure && kubectl label namespace secure pod-security.kubernetes.io/enforce=restricted', check: x => (((x.c.get('Namespace', '', 'secure') || { metadata: {} }).metadata.labels) || {})['pod-security.kubernetes.io/enforce'] === 'restricted' },
      { text: 'A plain nginx Pod is **rejected** — read the list of violations.', cmd: 'kubectl run plain --image=nginx:1.27 -n secure', check: x => x.tried(/run plain .*-n secure|run plain -n secure/) && !x.c.get('Pod', 'secure', 'plain') },
      { text: 'This manifest satisfies every rule (and uses an image that runs as a non-root user).', cmd: 'cat manifests/restricted-pod.yaml && kubectl apply -f manifests/restricted-pod.yaml', check: x => { const p = x.c.get('Pod', 'secure', 'hardened'); return !!p && ready(p); }, wait: 4000 },
      { text: 'Verify the user inside the container.', cmd: 'kubectl exec hardened -n secure -- id', check: x => x.ran(/exec hardened -n secure -- id|exec -n secure hardened -- id/) },
      { text: 'Another trap: `runAsNonRoot: true` with an image that runs as **root** is allowed in, but the kubelet refuses to start it.', cmd: 'kubectl run rooty --image=nginx:1.27 --dry-run=client -o yaml > rooty.yaml && kubectl apply -f rooty.yaml', check: x => !!x.c.get('Pod', 'default', 'rooty') },
      { text: 'Recreate it with `runAsNonRoot: true` and look at the status: **CreateContainerConfigError** — "image will run as root".', cmd: `kubectl delete pod rooty --now && kubectl run rooty --image=nginx:1.27 --overrides='{"spec":{"securityContext":{"runAsNonRoot":true}}}' && sleep 3 && kubectl get pod rooty`, check: x => { const p = x.c.get('Pod', 'default', 'rooty'); const cs = p && (p.status.containerStatuses || [])[0]; return !!cs && !!cs.state.waiting && cs.state.waiting.reason === 'CreateContainerConfigError'; }, wait: 4000 },
    ],
    quiz: [
      QUIZ('A namespace uses pod-security.kubernetes.io/warn=restricted. A violating Pod is…', ['rejected', 'admitted, with a warning shown to the user', 'deleted later'], 1, 'Only enforce rejects (Q38).'),
      QUIZ('Containers run as root even though PSA restricted is enforced. Possible cause? (Q110)', ['The Pods existed before the label was applied', 'PSA is broken', 'Root is allowed by restricted'], 0, 'PSA only evaluates Pods at creation.'),
    ],
  });

  L.push({
    id: 'network-policies', module: 'security', title: 'NetworkPolicies', minutes: 11, refs: [30, 45, 98, 75],
    intro: `By default **every Pod can reach every Pod** (Q45: every Pod gets an IP, no NAT). **NetworkPolicies** add firewall rules (Q30):

- Once **any** policy selects a Pod for Ingress, all *other* inbound traffic to that Pod is **denied**.
- Start with **default-deny**, then allow only documented flows — zero trust (Q75).
- Cross-namespace traffic needs a \`namespaceSelector\` (Q98). Don't forget monitoring, ingress controllers and **DNS on port 53** when you also restrict egress (Q106).

> The guide's analogy: a building with no locked doors. A policy is a key-card reader — but only on the door you install it on.

(NetworkPolicies need a CNI that enforces them — Calico, Cilium… Q45.)`,
    steps: [
      { text: 'Set up a namespace with an api, a frontend, and an unrelated "intruder" Pod.', cmd: 'kubectl create namespace shop && kubectl create deployment api --image=kubester/hello:v1 --port=8080 -n shop && kubectl expose deployment api --port=80 --target-port=8080 -n shop && kubectl run frontend --image=busybox:1.36 -l app=frontend -n shop -- sleep 3600 && kubectl run intruder --image=busybox:1.36 -n shop -- sleep 3600', check: x => readyN(x.c, 'app=api', 'shop') === 1 && readyN(x.c, 'app=frontend', 'shop') === 1 && readyN(x.c, 'run=intruder', 'shop') === 1, wait: 6000 },
      { text: 'Without policies, both can reach the api.', cmd: 'kubectl exec frontend -n shop -- wget -qO- -T 2 api && kubectl exec intruder -n shop -- wget -qO- -T 2 api', check: x => x.ran(/exec intruder -n shop -- wget/) || x.ran(/exec -n shop intruder -- wget/) },
      { text: 'Apply **default-deny** for the namespace.', cmd: 'kubectl apply -f manifests/netpol-deny.yaml', check: x => !!x.c.get('NetworkPolicy', 'shop', 'default-deny') },
      { text: 'Now even the frontend times out (watch the ✕ on the map).', cmd: 'kubectl exec frontend -n shop -- wget -qO- -T 2 api', check: x => x.tried(/exec frontend -n shop -- wget/) && x.ranAfterTried(/apply -f manifests\/netpol-deny/, /exec frontend -n shop -- wget/) },
      { text: 'Allow only frontend → api on port 8080.', cmd: 'kubectl apply -f manifests/netpol-allow.yaml', check: x => !!x.c.get('NetworkPolicy', 'shop', 'allow-frontend') },
      { text: 'The frontend works again; the intruder is still blocked.', cmd: 'kubectl exec frontend -n shop -- wget -qO- -T 2 api; kubectl exec intruder -n shop -- wget -qO- -T 2 api', check: x => x.ranAfter(/apply -f manifests\/netpol-allow/, /exec frontend -n shop -- wget/) },
      { text: 'Read how Kubernetes summarises the policy.', cmd: 'kubectl describe networkpolicy allow-frontend -n shop', check: x => x.ran(/describe (networkpolic(y|ies)|netpol) allow-frontend/) },
    ],
    quiz: [
      QUIZ('You add a policy allowing ingress from app=frontend to the api. What happens to traffic from Prometheus in "monitoring"?', ['Still allowed', 'Blocked — the policy implicitly denies everything not listed', 'Allowed on port 9090'], 1, 'Q30/Q98 — map all flows first.'),
      QUIZ('After adding an egress default-deny, internal names stop resolving. Why? (Q106)', ['CoreDNS crashed', 'Egress to kube-dns on UDP/TCP 53 is now blocked', 'Pods lost their IPs'], 1, 'Always allow DNS egress.'),
    ],
  });

  // ------------------------------------------------------------------ SHIPPING
  L.push({
    id: 'helm-kustomize', module: 'shipping', title: 'Helm & Kustomize', minutes: 12, refs: [32, 35, 107],
    intro: `Two ways to manage many YAML files (Q35):

**Helm** (Q32) – the package manager. A **chart** is templated YAML; **values** customise it; each install is a **release** with **revisions** you can upgrade and roll back. Best for third-party software and complex apps. Release state is stored as Secrets in the namespace.

**Kustomize** – plain YAML **base** + per-environment **overlays** that patch it (prefixes, replicas, image tags, labels). Built into kubectl: \`kubectl apply -k\`.

Many teams use both: Helm for vendor charts, Kustomize for their own apps.`,
    steps: [
      { text: 'See what charts are available in the pre-configured repo.', cmd: 'helm search repo kubester', check: x => x.ran(/helm search repo/) },
      { text: 'Install the webapp chart as release **demo** with 2 replicas.', cmd: 'helm install demo kubester/webapp --set replicaCount=2', check: x => deployDone(x.c, 'demo-webapp', null, 2), wait: 15000 },
      { text: 'Helm created normal Kubernetes objects.', cmd: 'helm list && kubectl get deploy,svc,configmap -l app.kubernetes.io/instance=demo', check: x => x.ran(/helm (list|ls)/) },
      { text: 'Upgrade: new image tag and message — this becomes revision 2.', cmd: 'helm upgrade demo kubester/webapp --reuse-values --set image.tag=v2 --set message="Shipped with Helm"', check: x => image(x.c, 'demo-webapp') === 'kubester/hello:v2', wait: 2000 },
      { text: 'Release history, then roll back to revision 1 (creating revision 3).', cmd: 'helm history demo && helm rollback demo 1', check: x => image(x.c, 'demo-webapp') === 'kubester/hello:v1' && x.ran(/helm rollback demo/), wait: 2000 },
      { text: 'Where does Helm keep this? In Secrets owned by helm.', cmd: 'kubectl get secrets -l owner=helm', check: x => x.ran(/get secrets? -l owner=helm/) },
      { text: 'Kustomize: preview the **prod** overlay (prefix, labels, 3 replicas, image v2) without applying.', cmd: 'kubectl kustomize kustomize/overlays/prod', check: x => x.ran(/kustomize kustomize\/overlays\/prod/) },
      { text: 'Apply it with `-k`.', cmd: 'kubectl apply -k kustomize/overlays/prod', check: x => deployDone(x.c, 'prod-site', null, 3) && image(x.c, 'prod-site') === 'kubester/hello:v2', wait: 6000 },
    ],
    quiz: [
      QUIZ('In CI/CD, which Helm command handles both first install and later upgrades?', ['helm install', 'helm upgrade --install', 'helm template'], 1, 'Q32 common mistakes.'),
      QUIZ('A Helm release is stuck in pending-upgrade after a CI timeout. First fix? (Q107)', ['helm rollback <release> <last good revision>', 'Delete the namespace', 'kubectl apply the chart by hand'], 0, 'Use --atomic and --timeout to prevent it.'),
      QUIZ('Your in-house app needs small dev/prod differences in plain readable YAML. Best fit?', ['Kustomize overlays', 'A Helm chart with 200 values', 'Copy-paste the YAML'], 0, 'Q35.'),
    ],
  });

  L.push({
    id: 'delivery', module: 'shipping', title: 'Blue-green, canary & GitOps', minutes: 9, refs: [43, 51, 79, 63],
    intro: `Release strategies (Q43):
- **Blue-green** – run old (blue) and new (green) side by side, switch traffic at once, switch back instantly if needed. Costs double capacity during the switch.
- **Canary** – send a small slice of traffic to the new version, watch metrics, then increase. Natively you split by replica ratio; a service mesh (Istio/Linkerd, Q63) gives exact percentages; **Argo Rollouts / Flagger** automate promotion and rollback (Q79).

**GitOps** (Q51): Git is the source of truth; ArgoCD or Flux continuously apply it. No more \`kubectl apply\` from laptops in production.

You'll do a blue-green switch by hand — it's just a **Service selector**.`,
    steps: [
      { text: 'Deploy blue (v1) and green (v2). The Service selects `version: blue`.', cmd: 'kubectl apply -f manifests/blue-green.yaml', check: x => readyN(x.c, 'app=myapp') === 4, wait: 7000 },
      { text: 'Traffic goes to v1.', cmd: "kubectl run c --image=curlimages/curl --rm -it --restart=Never -- sh -c 'for i in 1 2 3; do curl -s myapp; done'", check: x => x.ran(/curl -s myapp/), wait: 1000 },
      { text: 'Flip the switch: patch the selector to green.', cmd: `kubectl patch service myapp -p '{"spec":{"selector":{"app":"myapp","version":"green"}}}'`, check: x => (((x.c.get('Service', 'default', 'myapp') || {}).spec || {}).selector || {}).version === 'green' },
      { text: 'Every request now hits v2 — instantly, no rollout.', cmd: "kubectl run c2 --image=curlimages/curl --rm -it --restart=Never -- sh -c 'for i in 1 2 3; do curl -s myapp; done'", check: x => x.ranAfter(/patch (service|svc) myapp/, /curl -s myapp/), wait: 1000 },
      { text: 'Canary by replicas: select both versions (remove the version key) and make green 1 of 5 Pods ≈ 20%.', cmd: `kubectl patch service myapp --type=json -p '[{"op":"remove","path":"/spec/selector/version"}]' && kubectl scale deployment app-blue --replicas=4 && kubectl scale deployment app-green --replicas=1`, check: x => { const s = x.c.get('Service', 'default', 'myapp'); return !!s && !('version' in s.spec.selector) && x.c.get('Deployment', 'default', 'app-green').spec.replicas === 1; }, wait: 3000 },
    ],
    quiz: [
      QUIZ('Native replica-based canary with 3 blue and 1 green Pod sends green about…', ['5%', '25%', '50%'], 1, 'Replica ratio = 1/4. For exact 5% you need a mesh or Argo Rollouts (Q43).'),
      QUIZ('Core GitOps principle?', ['Developers kubectl apply from laptops', 'Git is the source of truth and a controller reconciles the cluster to it', 'CI pipelines hold cluster-admin'], 1, 'Q51.'),
    ],
  });

  L.push({
    id: 'internals', module: 'shipping', title: 'Under the hood: API, etcd & controllers', minutes: 8, refs: [56, 57, 58, 80, 59, 68],
    intro: `What happens on \`kubectl apply\` (Q57):

**Authentication** (who are you?) → **Authorization** (RBAC) → **Mutating admission** (defaults, injected sidecars) → **Schema validation** → **Validating admission** (policies, quotas, Pod Security) → **etcd write**.

Then the **watch** fires: controllers and the scheduler react to the change; nothing calls them directly. Every object carries:
- \`metadata.uid\` – unique forever,
- \`metadata.resourceVersion\` – etcd revision used for optimistic concurrency,
- \`ownerReferences\` – for garbage collection (Q80).

**CRDs + Operators** (Q58) extend this same machinery to your own resource types (e.g. a \`PostgresCluster\`).`,
    steps: [
      { text: 'Mutating admission at work: you sent 5 lines; look how many fields the server filled in (dnsPolicy, tolerations, serviceAccount, a token volume…).', cmd: 'kubectl run tiny --image=nginx:1.27 && kubectl get pod tiny -o yaml', check: x => x.ran(/get (pods?|po) tiny -o yaml/) },
      { text: 'Validating admission + quota: rejected **before** reaching etcd.', cmd: 'kubectl create quota one-pod --hard=pods=1 && kubectl run tiny2 --image=nginx:1.27', check: x => x.tried(/run tiny2/) && !x.c.get('Pod', 'default', 'tiny2') },
      { text: 'resourceVersion changes on every write — label the Pod and compare.', cmd: "kubectl get pod tiny -o jsonpath='{.metadata.resourceVersion}{\"\\n\"}' && kubectl label pod tiny touched=yes && kubectl get pod tiny -o jsonpath='{.metadata.resourceVersion}{\"\\n\"}'", check: x => x.ran(/label (pods?|po) tiny touched=yes/) },
      { text: 'Garbage collection & ownership: delete a Deployment with `--cascade=orphan` — its ReplicaSet and Pods survive.', cmd: 'kubectl delete quota one-pod && kubectl create deployment orphanage --image=nginx:1.27 --replicas=2 && sleep 4 && kubectl delete deployment orphanage --cascade=orphan && kubectl get rs,pods -l app=orphanage', check: x => !x.c.get('Deployment', 'default', 'orphanage') && x.c.list('ReplicaSet', 'default').some(r => r.metadata.name.startsWith('orphanage-')) },
    ],
    quiz: [
      QUIZ('In which order does a write request pass the API server? (Q57)', ['Admission → AuthN → AuthZ', 'AuthN → AuthZ → mutating admission → validation → validating admission → etcd', 'etcd → AuthZ → AuthN'], 1, ''),
      QUIZ('Why must etcd clusters have 3 or 5 members, never 2 or 4? (Q56)', ['Licensing', 'Raft needs a majority; even sizes add no extra fault tolerance', 'Disk alignment'], 1, ''),
      QUIZ('A broken validating webhook with failurePolicy: Fail matches all resources. Effect? (Q102)', ['Nothing', 'Every create/update in the cluster is rejected', 'Only Pods restart'], 1, 'Set failurePolicy: Ignore for non-critical webhooks, short timeouts, exclude kube-system.'),
    ],
  });

  // ------------------------------------------------------------------ INCIDENTS
  const incident = o => Object.assign({ module: 'incidents', incident: true, minutes: 8 }, o);

  L.push(incident({
    id: 'inc-pending', title: 'Pods stuck in Pending', refs: [81, 15],
    ticket: '#INC-1042 · The "reports" service was deployed 10 minutes ago and has never started.',
    intro: `**Pending** = accepted by the API server but **not scheduled** to a node (Q81).

Systematic debugging: \`kubectl describe pod\` → Events → check requests vs node capacity, taints/tolerations, node affinity, PVC binding, topology constraints, cluster autoscaler. In ~80% of cases: **requests exceed capacity**.`,
    setup(c) {
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'reports', namespace: 'default', labels: { app: 'reports' } }, spec: { replicas: 2, selector: { matchLabels: { app: 'reports' } }, template: { metadata: { labels: { app: 'reports' } }, spec: { containers: [{ name: 'reports', image: 'kubester/hello:v1', resources: { requests: { cpu: '2500m', memory: '256Mi' } } }] } } } });
      c.advance(8000);
    },
    steps: [
      { text: 'Confirm the symptom.', cmd: 'kubectl get pods -l app=reports', check: x => x.ran(/get (pods?|po)/) },
      { text: 'Read the scheduler\'s explanation in the Events.', cmd: 'kubectl describe pod {pod:app=reports} | tail -n 4', check: x => x.ran(/describe (pods?|po) (reports-|-l app=reports)/) },
      { text: 'Compare with what a node can offer (Allocatable, Allocated resources).', cmd: 'kubectl describe node worker-1 | grep -A8 Allocatable', check: x => x.ran(/describe (nodes?|no) /) },
      { text: '**Fix it** so both replicas run. (Hint: each worker has 2 CPUs; the app really needs 250m.)', cmd: 'kubectl set resources deployment reports --requests=cpu=250m', check: x => deployDone(x.c, 'reports', null, 2), wait: 8000, hint: 'kubectl set resources deployment reports --requests=cpu=250m' },
    ],
    quiz: [QUIZ('Kubernetes schedules based on…', ['actual CPU usage', 'resource requests', 'limits'], 1, 'Q81 step 2 — "even if the node has free resources in reality".')],
  }));

  L.push(incident({
    id: 'inc-crashloop', title: 'CrashLoopBackOff', refs: [82],
    ticket: '#INC-1043 · "orders-api" keeps restarting. Restart count is climbing.',
    intro: `**CrashLoopBackOff** = the container starts, crashes, and the kubelet restarts it with growing delays: 10s, 20s, 40s… up to 5 minutes (Q82).

Playbook: \`kubectl logs\` (and \`--previous\`), the **exit code** in \`describe\` (1 = app error, 137 = OOM, 127 = command not found), then config: env vars, ConfigMaps/Secrets, dependencies. The #1 cause (40%): a missing or wrong environment variable.`,
    setup(c) {
      c.createInternal({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'orders-db', namespace: 'default' }, spec: { selector: { app: 'orders-db' }, ports: [{ port: 5432 }] } });
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'orders-db', namespace: 'default', labels: { app: 'orders-db' } }, spec: { replicas: 1, selector: { matchLabels: { app: 'orders-db' } }, template: { metadata: { labels: { app: 'orders-db' } }, spec: { containers: [{ name: 'postgres', image: 'postgres:17', env: [{ name: 'POSTGRES_PASSWORD', value: 'orders' }], ports: [{ containerPort: 5432 }] }] } } } });
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'orders-api', namespace: 'default', labels: { app: 'orders-api' } }, spec: { replicas: 1, selector: { matchLabels: { app: 'orders-api' } }, template: { metadata: { labels: { app: 'orders-api' } }, spec: { containers: [{ name: 'api', image: 'kubester/api:1.0', ports: [{ containerPort: 8080 }] }] } } } });
      c.advance(45000);
    },
    steps: [
      { text: 'Look at the restart count and status.', cmd: 'kubectl get pods', check: x => x.ran(/get (pods?|po)/) },
      { text: 'Read the logs. If the container just restarted, add `--previous`.', cmd: 'kubectl logs deploy/orders-api --previous', check: x => x.ran(/logs .*orders-api/) },
      { text: 'Check the exit code in Last State.', cmd: 'kubectl describe pod {pod:app=orders-api} | grep -A5 "Last State"', check: x => x.ran(/describe (pods?|po) (orders-api-|-l app=orders-api)/) },
      { text: '**Fix it**: the app needs `DATABASE_URL`. The database Service is `orders-db` (port 5432). Format: `postgres://user:pass@host:5432/db`.', cmd: 'kubectl set env deployment/orders-api DATABASE_URL=postgres://orders:orders@orders-db:5432/orders', check: x => deployDone(x.c, 'orders-api'), wait: 10000, hint: 'kubectl set env deployment/orders-api DATABASE_URL=postgres://orders:orders@orders-db:5432/orders' },
      { text: 'Confirm it is healthy and read the new logs.', cmd: 'kubectl get pods -l app=orders-api && kubectl logs deploy/orders-api', check: x => deployDone(x.c, 'orders-api') && x.ranAfter(/set env/, /logs .*orders-api/) },
    ],
    quiz: [QUIZ('Exit code 127 points to…', ['out of memory', 'command not found in the image', 'a successful exit'], 1, 'Q82 step 4.')],
  }));

  L.push(incident({
    id: 'inc-imagepull', title: 'ImagePullBackOff', refs: [83, 53],
    ticket: '#INC-1044 · Two deployments — "frontend" and "payments" — never became ready after release.',
    intro: `**ImagePullBackOff** = the kubelet can't pull the image and retries with back-off (Q83). Read the exact error in Events:
- *repository does not exist / not found* → typo in the image name or tag,
- *authentication required / 401* → private registry: needs an **imagePullSecret** (Q53),
- *timeout* → network/DNS/firewall to the registry.`,
    setup(c) {
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'frontend', namespace: 'default', labels: { app: 'frontend' } }, spec: { replicas: 2, selector: { matchLabels: { app: 'frontend' } }, template: { metadata: { labels: { app: 'frontend' } }, spec: { containers: [{ name: 'web', image: 'ngnix:1.27' }] } } } });
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'payments', namespace: 'default', labels: { app: 'payments' } }, spec: { replicas: 1, selector: { matchLabels: { app: 'payments' } }, template: { metadata: { labels: { app: 'payments' } }, spec: { containers: [{ name: 'payments', image: 'registry.kubester.io/team/payments:1.0' }] } } } });
      c.advance(15000);
    },
    steps: [
      { text: 'Find the failing Pods.', cmd: 'kubectl get pods', check: x => x.ran(/get (pods?|po)/) },
      { text: 'Read the frontend error closely. Spot the typo?', cmd: 'kubectl describe pod {pod:app=frontend} | grep -i failed', check: x => x.ran(/describe (pods?|po) (frontend-|-l app=frontend)/) },
      { text: '**Fix the frontend image.**', cmd: 'kubectl set image deployment/frontend web=nginx:1.27', check: x => deployDone(x.c, 'frontend', null, 2), wait: 8000, hint: 'The image is "ngnix" — it should be nginx:1.27.' },
      { text: 'Now payments: a different error — 401 Unauthorized from a private registry.', cmd: 'kubectl describe pod {pod:app=payments} | grep -i failed', check: x => x.ran(/describe (pods?|po) (payments-|-l app=payments)/) },
      { text: 'Create registry credentials as a docker-registry Secret.', cmd: 'kubectl create secret docker-registry regcred --docker-server=registry.kubester.io --docker-username=ci-bot --docker-password=t0ken', check: x => !!x.c.get('Secret', 'default', 'regcred') },
      { text: '**Reference it** from the Pod template via imagePullSecrets.', cmd: `kubectl patch deployment payments -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"regcred"}]}}}}'`, check: x => deployDone(x.c, 'payments'), wait: 10000, hint: 'kubectl patch deployment payments -p \'{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"regcred"}]}}}}\'' },
    ],
    quiz: [QUIZ('Best prevention for "it worked yesterday, the tag changed today"?', ['Use :latest', 'Immutable tags (git SHA/semver) with IfNotPresent', 'imagePullPolicy: Never'], 1, 'Q83 prevention.')],
  }));

  L.push(incident({
    id: 'inc-containercreating', title: 'Stuck in ContainerCreating', refs: [84, 7],
    ticket: '#INC-1045 · "billing" was scheduled but its containers never start.',
    intro: `**ContainerCreating** ≠ Pending (Q84). The Pod *is* on a node; the **kubelet** can't set it up: a missing ConfigMap/Secret volume, an unbound PVC, a CNI/sandbox error.

(A missing ConfigMap used as **env** shows a different status: \`CreateContainerConfigError\`.)`,
    setup(c) {
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'billing', namespace: 'default', labels: { app: 'billing' } }, spec: { replicas: 1, selector: { matchLabels: { app: 'billing' } }, template: { metadata: { labels: { app: 'billing' } }, spec: { containers: [{ name: 'web', image: 'nginx:1.27', volumeMounts: [{ name: 'settings', mountPath: '/etc/billing' }] }], volumes: [{ name: 'settings', configMap: { name: 'billing-settings' } }] } } } });
      c.advance(10000);
    },
    steps: [
      { text: 'Check the status.', cmd: 'kubectl get pods -l app=billing', check: x => x.ran(/get (pods?|po)/) },
      { text: 'The kubelet reports a **FailedMount**. What is missing?', cmd: 'kubectl describe pod {pod:app=billing} | tail -n 3', check: x => x.ran(/describe (pods?|po) (billing-|-l app=billing)/) },
      { text: '**Fix it** by creating the missing ConfigMap (any content, e.g. currency=EUR).', cmd: 'kubectl create configmap billing-settings --from-literal=currency=EUR', check: x => deployDone(x.c, 'billing'), wait: 20000, hint: 'kubectl create configmap billing-settings --from-literal=currency=EUR' },
    ],
    quiz: [QUIZ('Pending vs ContainerCreating?', ['Same thing', 'Pending: not scheduled yet; ContainerCreating: scheduled, kubelet can\'t start it', 'ContainerCreating means image pull only'], 1, 'Q84.')],
  }));

  L.push(incident({
    id: 'inc-no-endpoints', title: 'Service not routing traffic', refs: [86, 9, 97],
    ticket: '#INC-1046 · "catalog" returns connection refused. The Pods look healthy.',
    intro: `When a Service doesn't route (Q86):
1. \`kubectl get endpoints <svc>\` — empty? → **labels don't match the selector** (the #1 cause, ~70%).
2. Endpoints exist? → Pods ready? Is the app listening on the **targetPort**?
3. Then kube-proxy / CNI.`,
    setup(c) {
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'catalog', namespace: 'default', labels: { app: 'catalog' } }, spec: { replicas: 2, selector: { matchLabels: { app: 'catalog' } }, template: { metadata: { labels: { app: 'catalog' } }, spec: { containers: [{ name: 'catalog', image: 'kubester/hello:v1', ports: [{ containerPort: 8080 }] }] } } } });
      c.createInternal({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'catalog', namespace: 'default' }, spec: { selector: { app: 'catalogue' }, ports: [{ port: 80, targetPort: 80 }] } });
      c.createInternal({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'debug', namespace: 'default', labels: { run: 'debug' } }, spec: { containers: [{ name: 'debug', image: 'curlimages/curl', command: ['sleep', '3600'] }] } });
      c.advance(8000);
    },
    steps: [
      { text: 'Reproduce from inside the cluster.', cmd: 'kubectl exec debug -- curl -s -m 2 catalog', check: x => x.tried(/exec debug -- curl/) },
      { text: 'Check the endpoints.', cmd: 'kubectl get endpoints catalog', check: x => x.ran(/get (ep|endpoints) catalog/) },
      { text: 'Compare the Service selector with the Pod labels.', cmd: 'kubectl get svc catalog -o wide && kubectl get pods --show-labels', check: x => x.ran(/get (svc|service) catalog -o (wide|yaml)|describe (svc|service) catalog/) },
      { text: '**Fix the selector.**', cmd: `kubectl patch service catalog -p '{"spec":{"selector":{"app":"catalog"}}}'`, check: x => (((x.c.get('Service', 'default', 'catalog') || {}).spec || {}).selector || {}).app === 'catalog', hint: 'kubectl patch service catalog -p \'{"spec":{"selector":{"app":"catalog"}}}\'' },
      { text: 'Endpoints exist now… but curl still fails. Check the port chain: Service targetPort vs container port.', cmd: 'kubectl get endpoints catalog && kubectl exec debug -- curl -s -m 2 catalog', check: x => x.ranAfterTried(/patch (service|svc) catalog/, /exec debug -- curl/) },
      { text: '**Fix the targetPort** (the app listens on 8080).', cmd: `kubectl patch service catalog --type=json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":8080}]'`, check: x => { const s = x.c.get('Service', 'default', 'catalog'); return !!s && s.spec.ports[0].targetPort === 8080 && s.spec.selector.app === 'catalog'; }, hint: 'kubectl patch service catalog --type=json -p \'[{"op":"replace","path":"/spec/ports/0/targetPort","value":8080}]\'' },
      { text: 'Verify.', cmd: 'kubectl exec debug -- curl -s catalog', check: x => x.ranAfter(/targetPort/, /exec debug -- curl/) },
    ],
    quiz: [QUIZ('First command when a Service "doesn\'t work"?', ['kubectl get endpoints <svc>', 'kubectl delete svc', 'restart kube-proxy'], 0, 'Q86.')],
  }));

  L.push(incident({
    id: 'inc-rollout', title: 'Bad rollout in production', refs: [87, 16, 90],
    ticket: '#INC-1047 · Release v3 of "checkout" went out 5 minutes ago. Some pods are failing.',
    intro: `A rollout that never completes (Q87) usually means the **new Pods aren't becoming Ready** — the rollout safely refuses to remove more old Pods. Diagnose with \`rollout status\`, \`get rs\`, the new Pods' logs. Recover fast with \`rollout undo\`, then investigate.`,
    setup(c) {
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'checkout', namespace: 'default', labels: { app: 'checkout' }, annotations: { 'kubernetes.io/change-cause': 'release v2' } }, spec: { replicas: 4, selector: { matchLabels: { app: 'checkout' } }, template: { metadata: { labels: { app: 'checkout' } }, spec: { containers: [{ name: 'checkout', image: 'kubester/hello:v2', ports: [{ containerPort: 8080 }] }] } } } });
      c.advance(8000);
      const d = U.clone(c.get('Deployment', 'default', 'checkout'));
      d.spec.template.spec.containers[0].image = 'kubester/hello:v3';
      d.metadata.annotations['kubernetes.io/change-cause'] = 'release v3';
      c.update(d, { internal: true });
      c.advance(40000);
    },
    steps: [
      { text: 'What state is the rollout in?', cmd: 'kubectl rollout status deployment/checkout --timeout=5s', check: x => x.tried(/rollout status/) },
      { text: 'Old and new ReplicaSets side by side.', cmd: 'kubectl get rs -l app=checkout && kubectl get pods -l app=checkout', check: x => x.ran(/get (rs|replicasets?)/) },
      { text: 'Why do the new Pods crash? Read their logs.', cmd: 'kubectl logs {newpod:checkout} --previous', check: x => x.tried(/logs checkout-/) },
      { text: '**Recover**: roll back to the last good release.', cmd: 'kubectl rollout undo deployment/checkout', check: x => image(x.c, 'checkout') === 'kubester/hello:v2' && deployDone(x.c, 'checkout', null, 4), wait: 10000 },
      { text: 'Confirm the history shows what happened.', cmd: 'kubectl rollout history deployment/checkout', check: x => x.ranAfter(/rollout undo/, /rollout history/) },
    ],
    quiz: [QUIZ('While new Pods fail readiness, users…', ['get errors from every request', 'keep being served by the remaining old Pods', 'see a maintenance page'], 1, 'maxUnavailable protects availability.')],
  }));

  L.push(incident({
    id: 'inc-dns', title: 'DNS is down', refs: [91, 106, 18],
    ticket: '#INC-1048 · Apps report "could not resolve host" for every internal service. Someone was "saving resources" in kube-system yesterday.',
    intro: `DNS failures look like random app errors (Q91). Inside a Pod: \`nslookup kubernetes.default\`. If it times out, check **CoreDNS** in kube-system: is it running? Scaled? Overloaded? Blocked by a NetworkPolicy (Q106)?`,
    setup(c) {
      const d = U.clone(c.get('Deployment', 'kube-system', 'coredns'));
      d.spec.replicas = 0;
      c.update(d, { internal: true });
      c.createInternal({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'toolbox', namespace: 'default' }, spec: { containers: [{ name: 'toolbox', image: 'busybox:1.36', command: ['sleep', '3600'] }] } });
      c.advance(8000);
    },
    steps: [
      { text: 'Reproduce: resolve a cluster name from a Pod.', cmd: 'kubectl exec toolbox -- nslookup kubernetes.default', check: x => x.tried(/exec toolbox -- nslookup/) },
      { text: 'Look at the DNS Service and its endpoints.', cmd: 'kubectl get svc,endpoints kube-dns -n kube-system', check: x => x.ran(/kube-dns.*-n kube-system|-n kube-system.*kube-dns/) },
      { text: 'Who provides those endpoints? Check the CoreDNS Deployment.', cmd: 'kubectl get deployment coredns -n kube-system', check: x => x.ran(/get (deploy|deployments?|deployment\.apps) coredns/) },
      { text: '**Fix it.**', cmd: 'kubectl scale deployment coredns -n kube-system --replicas=2', check: x => deployDone(x.c, 'coredns', 'kube-system', 2), wait: 6000, hint: 'kubectl scale deployment coredns -n kube-system --replicas=2' },
      { text: 'Verify resolution works again.', cmd: 'kubectl exec toolbox -- nslookup kubernetes.default', check: x => x.ranAfter(/scale .*coredns/, /exec toolbox -- nslookup/) },
    ],
    quiz: [QUIZ('ndots:5 means a lookup of api.example.com…', ['goes straight to the internet', 'first tries the cluster search domains, multiplying queries', 'fails'], 1, 'Q91 cause 1.')],
  }));

  L.push(incident({
    id: 'inc-namespace', title: 'Namespace stuck Terminating', refs: [101, 80],
    ticket: '#INC-1049 · "legacy" was deleted an hour ago and is still Terminating. The operator that owned it was removed last week.',
    intro: `A namespace only disappears when everything inside is gone. Objects with **finalizers** wait for a controller to clean up and remove the finalizer. If that controller (an operator) no longer exists, they wait forever (Q101).

Safe approach: find the objects with finalizers, confirm the external cleanup isn't needed, then remove the finalizer.`,
    setup(c) {
      c.createInternal({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'legacy' } });
      c.createInternal({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'old-operator-state', namespace: 'legacy', finalizers: ['legacy.example.com/cleanup'] }, data: { owner: 'legacy-operator' } });
      c.createInternal({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'legacy' }, data: { a: 'b' } });
      c.delete('Namespace', '', 'legacy', {});
      c.advance(5000);
    },
    steps: [
      { text: 'Confirm the namespace is stuck.', cmd: 'kubectl get namespace legacy', check: x => x.ran(/get (ns|namespaces?) legacy/) },
      { text: 'The namespace conditions say what remains.', cmd: 'kubectl describe namespace legacy', check: x => x.ran(/describe (ns|namespaces?) legacy/) },
      { text: 'Find the leftover object and its finalizer.', cmd: 'kubectl get configmaps -n legacy -o custom-columns=NAME:.metadata.name,FINALIZERS:.metadata.finalizers', check: x => x.ran(/get (cm|configmaps?) -n legacy/) },
      { text: '**Remove the finalizer** (the operator that would process it is gone).', cmd: `kubectl patch configmap {finalized:legacy} -n legacy --type=json -p '[{"op":"remove","path":"/metadata/finalizers"}]'`, check: x => !x.c.get('Namespace', '', 'legacy'), wait: 3000, hint: 'kubectl patch configmap old-operator-state -n legacy --type=json -p \'[{"op":"remove","path":"/metadata/finalizers"}]\'' },
    ],
    quiz: [QUIZ('How to prevent this?', ['Delete operators first', 'Delete custom resources before deleting the operator that manages them', 'Never use namespaces'], 1, 'Q101 prevention.')],
  }));

  L.push(incident({
    id: 'inc-helm', title: 'Helm release stuck', refs: [107, 32],
    ticket: '#INC-1050 · CI timed out mid-upgrade of "storefront". Every retry fails with "another operation is in progress".',
    intro: `An interrupted \`helm upgrade\` leaves the release in **pending-upgrade** (Q107). Check \`helm history\`, then \`helm rollback\` to the last **deployed** revision. Prevent it with \`--atomic --timeout\` in CI.`,
    setup(c, sh) {
      const io = { out() {}, err() {} };
      sh.helm.run(['install', 'storefront', 'kubester/webapp', '--set', 'replicaCount=2'], io);
      c.advance(6000);
      const sec = c.list('Secret', 'default').filter(s => (s.metadata.labels || {}).name === 'storefront')[0];
      const rel = JSON.parse(U.b64decode(sec.data.release));
      const r2 = U.clone(rel);
      r2.version = 2; r2.info.status = 'pending-upgrade'; r2.info.description = 'Preparing upgrade';
      r2.config.image = Object.assign({}, r2.config.image, { tag: 'v2' });
      sh.helm.saveRelease(r2);
      c.advance(1000);
    },
    steps: [
      { text: 'Reproduce the CI error.', cmd: 'helm upgrade storefront kubester/webapp --set image.tag=v2', check: x => x.tried(/helm upgrade storefront/) },
      { text: 'Inspect the release history.', cmd: 'helm history storefront', check: x => x.ran(/helm (history|hist) storefront/) },
      { text: '**Roll back** to the last deployed revision.', cmd: 'helm rollback storefront 1', check: x => { const h = x.sh.helm.releases('default').storefront || []; const last = h[h.length - 1]; return !!last && last.info.status === 'deployed' && x.ran(/helm rollback storefront/); } },
      { text: 'Now the upgrade goes through. Use the safe flags.', cmd: 'helm upgrade storefront kubester/webapp --reuse-values --set image.tag=v2 --atomic --timeout 5m', check: x => image(x.c, 'storefront-webapp') === 'kubester/hello:v2' && x.ranAfter(/helm rollback/, /helm upgrade storefront/), wait: 2000 },
    ],
    quiz: [QUIZ('Which flag automatically rolls back a failed upgrade?', ['--force', '--atomic', '--wait'], 1, 'Q107 prevention.')],
  }));

  L.push(incident({
    id: 'inc-node', title: 'Node NotReady', refs: [85, 103, 99],
    ticket: '#INC-1051 · worker-3 shows NotReady. Some pods there look stuck.',
    intro: `A node goes **NotReady** when its kubelet stops reporting (crash, disk/memory pressure, network, expired certificates — Q85, Q103). Check \`describe node\` conditions. If it can't be recovered quickly: **cordon** and **drain** so workloads move, then repair or replace the node.

Pods evicted from an unreachable node can hang in **Terminating** (Q99) — nobody on the node can confirm they stopped.`,
    setup(c) {
      c.createInternal({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'default', labels: { app: 'web' } }, spec: { replicas: 3, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'nginx:1.27' }] } } } });
      c.advance(6000);
      c.rt.nodes['worker-3'].up = false;
      c.advance(60000);
    },
    steps: [
      { text: 'Confirm.', cmd: 'kubectl get nodes', check: x => x.ran(/get (nodes?|no)/) },
      { text: 'Why? Look at the node conditions and taints.', cmd: 'kubectl describe node worker-3 | grep -A8 -E "Taints|Conditions"', check: x => x.ran(/describe (nodes?|no) worker-3/) },
      { text: 'Stop new Pods from landing there and move workloads off.', cmd: 'kubectl drain worker-3 --ignore-daemonsets --delete-emptydir-data --force --timeout=30s', check: x => !!(x.c.get('Node', '', 'worker-3').spec.unschedulable) && readyN(x.c, 'app=web') >= 3, wait: 10000 },
      { text: 'The "repair": restart the node\'s kubelet (in real life: SSH in, fix disk/certificates, or replace the VM).', cmd: 'sim node up worker-3', check: x => x.c.rt.nodes['worker-3'].up },
      { text: 'Healthy again — allow scheduling.', cmd: 'kubectl uncordon worker-3 && kubectl get nodes', check: x => { const n = x.c.get('Node', '', 'worker-3'); return !n.spec.unschedulable && ((n.status.conditions || []).find(c => c.type === 'Ready') || {}).status === 'True'; }, wait: 3000 },
    ],
    quiz: [QUIZ('Force-deleting a StatefulSet Pod stuck on an unreachable node risks…', ['nothing', 'two copies writing the same volume (split brain) if the node returns', 'losing the PVC'], 1, 'Q99.')],
  }));

  // ------------------------------------------------------------------ assemble
  L.forEach((l, i) => { l.index = i; l.steps.forEach((s, j) => (s.index = j)); });
  // ------------------------------------------------------------------ lesson context (shared by UI and tests)
  const norm = s => String(s).trim().replace(/^k\s/, 'kubectl ').replace(/(&&|;|\|)\s*k\s/g, '$1 kubectl ').replace(/\s+/g, ' ');
  class LessonCtx {
    constructor(getCluster, shell) { this.getCluster = getCluster; this.sh = shell; this.records = []; }
    get c() { return this.getCluster(); }
    reset() { this.records = []; }
    record(kind, text, code) { this.records.push({ kind, text: norm(text), code }); if (this.records.length > 400) this.records.shift(); }
    find(re, okOnly) { return this.records.findIndex(r => (!okOnly || r.code === 0) && re.test(r.text)); }
    ran(re) { return this.records.some(r => r.code === 0 && re.test(r.text)); }
    tried(re) { return this.records.some(r => re.test(r.text)); }
    count(re) { return this.records.filter(r => r.kind === 'line' && r.code === 0 && re.test(r.text)).length; }
    ranAfter(a, b) { let seen = false; for (const r of this.records) { if (seen && r.code === 0 && b.test(r.text) && !a.test(r.text)) return true; if (r.code === 0 && a.test(r.text)) seen = true; } return false; }
    ranAfterTried(a, b) { let seen = false; for (const r of this.records) { if (seen && b.test(r.text) && !a.test(r.text)) return true; if (r.code === 0 && a.test(r.text)) seen = true; } return false; }
    file(p) { return this.sh.fs.read(KS.runtime.normPath(String(p).replace(/^~/, KS.HOME || '/home/learner'), '/home/learner')); }
  }
  KS.LessonCtx = LessonCtx;

  KS.MODULES = MODULES;
  KS.LESSONS = L;
})(typeof window !== 'undefined' ? window : globalThis);
