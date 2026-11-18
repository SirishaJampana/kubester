# Kubester — Plan

A browser-only Kubernetes learning lab. No install, no real cluster: open `index.html` and learn.
Source material: `mdfiles/Kubernetes_Interview_Preparation_Guide.md` (110 topics, 4 levels).

## Product shape

```
┌ Header: Kubester · progress · [Learn] [Handbook] [Flashcards] [Cheat sheet] ───────────┐
│ Curriculum │ Lesson (concept, analogy, steps ✓, quiz)  │  Cluster canvas (live, animated)  │
│  modules   │  clickable commands ▶                     │  ─────────────────────────────── │
│  lessons ✓ │  "Deep dive" → full guide section         │  Terminal (kubectl, sh, helm)     │
└────────────┴───────────────────────────────────────────┴───────────────────────────────────┘
```

* **Terminal** – a simulated shell: `kubectl` (alias `k`) with ~45 subcommands and real-looking output, pipes (`| grep`, `| base64 -d`, `| wc -l`),
  redirection (`> pod.yaml`), history, tab completion of commands, resources and object names, `kubectl exec -it … -- sh` into
  containers, `-w` watch streams, Ctrl+C, a file editor (`nano file.yaml`, `kubectl edit`), plus `helm` basics and `sim` chaos helpers.
* **Canvas** – the cluster drawn live: control plane (API server, etcd, scheduler, controller manager), worker nodes with pods,
  services wired to their endpoints, ingress, volumes. Animations show the *mechanism*: every command travels
  kubectl → API server → etcd → scheduler → kubelet; curl packets flow through Services; crashes shake; NetworkPolicy blocks show ✕.
  Click anything to inspect it. A "narrator" explains each cluster event in plain English.
* **Lessons** – each has an analogy, guided steps auto-checked against the *simulated cluster state*, hints, a solution, and a quiz.
* **Handbook / Flashcards / Cheat sheet** – all 110 guide topics rendered and searchable, so every concept is covered even where no lab exists.

## Simulation engine (the hard part)

One `Cluster` object with a K8s-shaped object store and controllers that run on a clock:
scheduler (resources, taints/tolerations, nodeSelector/affinity, anti-affinity, topology spread, cordon),
Deployment (rolling update with maxSurge/maxUnavailable, revisions, undo), ReplicaSet, DaemonSet, StatefulSet (ordered, per-pod PVCs),
Job/CronJob, Endpoints, Services (ClusterIP/NodePort/LoadBalancer/Headless), kubelet (image pull + node cache, init containers,
probes, restart policies with back-off, OOM, CreateContainerConfigError, FailedMount), HPA, PDB-aware drain, node failure/eviction,
ResourceQuota/LimitRange, RBAC (`auth can-i`, `--as`), NetworkPolicy, Pod Security Admission, PV/PVC/StorageClass with data that survives pods.
Container images have behaviour (nginx serves pages, postgres needs a password, busybox runs real-ish shell scripts).
Timings are realistic; `sim fast-forward 5m` skips waits.

## Curriculum (guide question numbers in brackets)

| # | Module | Covers |
|---|--------|--------|
| 0 | Welcome & first commands | how to use the lab |
| 1 | What & why, architecture | Q1, Q2, Q25, Q60 |
| 2 | Pods & lifecycle | Q3, Q22, Q23 |
| 3 | kubectl workflow | Q8, Q21 |
| 4 | Labels, selectors, annotations | Q9 |
| 5 | ReplicaSets & Deployments, self-healing | Q4, Q80 |
| 6 | Rolling updates & rollbacks | Q16, Q87 |
| 7 | Services & DNS | Q5, Q18, Q46, Q55 |
| 8 | Namespaces, quotas, limits | Q6, Q44 |
| 9 | ConfigMaps & Secrets | Q7, Q13, Q36, Q52 |
| 10 | Probes | Q12 |
| 11 | Requests, limits, OOM | Q15, Q89 |
| 12 | Init & multi-container pods, lifecycle hooks | Q14, Q24, Q39, Q73 |
| 13 | DaemonSets, Jobs, CronJobs | Q10, Q11, Q109 |
| 14 | Storage & StatefulSets | Q17, Q20, Q33, Q88 |
| 15 | Ingress | Q19, Q67, Q97 |
| 16 | Scheduling | Q26, Q27, Q48, Q49, Q59 |
| 17 | Autoscaling | Q28, Q29, Q74, Q95 |
| 18 | Node maintenance | Q34, Q64, Q85, Q104 |
| 19 | Security: RBAC, securityContext, PSA, NetworkPolicy | Q30, Q31, Q37, Q38, Q98, Q110 |
| 20 | Packaging: Helm & Kustomize | Q32, Q35, Q107 |
| 21 | Troubleshooting incidents (broken clusters to fix) | Q81–Q86, Q90, Q97 |
| 22 | Production & internals tour (concept + quiz) | Q40–Q43, Q50–Q54, Q56–Q79, Q91–Q110 |

## Tech choices

* Plain HTML/CSS/JS, no build step, works from `file://` (double-click `index.html`). Only vendored dependency: js-yaml.
* `tools/build-guide.js` turns the markdown into `js/guide-data.js`.
* `tests/run-tests.js` runs the engine headless in Node and **replays every lesson's solution**, asserting all checks pass.
* Browser smoke test with headless Chrome: no console errors, commands work, screenshots reviewed.
