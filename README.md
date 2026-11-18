# Kubester — learn Kubernetes by doing

A browser-only Kubernetes lab for complete beginners: a **live, animated cluster map**, a **real-feeling `kubectl` terminal**, and **36 guided lessons** that check your work against the cluster as you type. Nothing to install, no real cluster needed.

![sections](https://img.shields.io/badge/lessons-36-326ce5) ![steps](https://img.shields.io/badge/hands--on%20steps-224-2bd576) ![handbook](https://img.shields.io/badge/handbook%20topics-110-8b6cff)

## Run it

Just open `index.html` in a browser (Chrome, Edge, Firefox, Safari). It works straight from the file system.

Optional, if you prefer a local server:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## What's inside

| | |
|---|---|
| **Learn** | 36 lessons in 9 modules, from "what is a Pod" to RBAC, NetworkPolicies, HPA, Helm and Kustomize. Each has a concept + analogy, auto-checked steps (▶ runs a command for you), hints and a quiz. |
| **Incident Lab** | 10 break/fix labs that start with a broken cluster: Pending, CrashLoopBackOff, ImagePullBackOff (typo *and* private registry), ContainerCreating, Service with no endpoints, a bad rollout, DNS down, a namespace stuck Terminating, a stuck Helm release, a NotReady node. |
| **Cluster map** | Control plane (API server, etcd, scheduler, controllers), nodes with CPU/memory bars, taints and zones, Pods colored by status, Services wired to their endpoints, Ingress, PersistentVolumes. Every request animates: kubectl → API server → etcd, scheduler → node, curl packets through Services, ✕ when a NetworkPolicy drops traffic. Click anything to inspect it; a narrator explains each event in plain English. |
| **Terminal** | Your "laptop": `kubectl` (alias `k`) with ~40 subcommands and realistic output and errors, `helm`, pipes and redirects (`\| grep`, `\| base64 -d`, `\| jq`, `> file.yaml`), heredocs, `nano`/`kubectl edit` editor, `exec -it` into containers, `-w` watches, Tab completion, history, Ctrl+C. |
| **Handbook** | All 110 topics of the interview guide, searchable, with links to the lessons that practise each one. |
| **Flashcards / Cheat sheet** | Spaced review of all 110 questions; a clickable command cheat sheet. |

Playground-only helpers: `sim fast-forward 5m`, `sim load web 600m`, `sim node down worker-2`, `sim speed 4`, `sim reset`.

## How it works

Everything runs in the browser. `js/` contains a small Kubernetes simulator:

| File | Role |
|---|---|
| `cluster.js` | API server: object store, defaulting, validation, admission (ResourceQuota, LimitRange, Pod Security), RBAC, bootstrap of a 4-node cluster |
| `controllers.js` | Scheduler (filter/score, taints, affinity, spread, preemption), Deployment rolling updates, ReplicaSet, DaemonSet, StatefulSet, Job, CronJob, HPA, garbage collector, PV/PVC binding, node lifecycle and eviction, PDBs |
| `kubelet.js` | Image pulls with node caches, init/sidecar containers, probes, restart back-off, OOM, graceful termination; DNS, Services, NetworkPolicy, Ingress routing |
| `runtime.js` | Image catalog with behaviour (nginx serves files, postgres needs a password…), virtual filesystems, a small POSIX shell |
| `kubectl.js`, `describe.js`, `explain.js` | kubectl commands, printers (tabwriter-aligned `describe`), jsonpath, strict field validation |
| `helm.js` | Helm releases/revisions/rollback, Kustomize, well-known manifest URLs |
| `shell.js`, `terminal.js` | The laptop shell and the terminal UI |
| `canvas.js` | The animated cluster map |
| `lessons.js`, `lesson-files.js` | Curriculum and example manifests in `~/manifests` |
| `guide-data.js` | Generated from `mdfiles/` by `node tools/build-guide.js` |

The only dependency is [js-yaml](https://github.com/nodeca/js-yaml) (vendored, MIT).

## Tests

```bash
node tests/run-tests.js            # unit checks + replays every lesson's solution on a fresh simulated cluster
node tests/run-tests.js services   # only lessons whose id contains "services"
```

Each lesson step has a `check()` that inspects the simulated cluster; the test suite runs every step's command and asserts that its check passes (235 checks).

## Editing content

- **Lessons:** `js/lessons.js` — each step is `{ text, cmd, check: x => …, hint }`. `x.ran(/regex/)`, `x.c.get(kind, ns, name)` and the helpers at the top make checks easy. Run the tests after changes.
- **Handbook:** edit `mdfiles/Kubernetes_Interview_Preparation_Guide.md`, then `node tools/build-guide.js`.

## Honest limits

It's a simulator, not Kubernetes. Timings are realistic but compressed where waiting would be tedious (use `sim fast-forward`). Some advanced features (CRDs/operators, CSRs, service meshes, real Go templates in Helm charts) are covered conceptually in the Handbook and quizzes rather than simulated.
