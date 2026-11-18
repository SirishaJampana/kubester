/* Kubester — example files placed in the learner's home directory (~/manifests, ~/kustomize). */
(function (G) {
  'use strict';
  const KS = (G.KS = G.KS || {});
  KS.LESSON_FILES = {
    '~/manifests/pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: hello-pod
  labels:
    app: hello
spec:
  containers:
  - name: web
    image: nginx:1.27
    ports:
    - containerPort: 80
`,
    '~/manifests/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  selector:
    matchLabels:
      app: web
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1          # at most 1 extra Pod during the update
      maxUnavailable: 1    # at most 1 Pod below the desired count
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.26
        ports:
        - containerPort: 80
`,
    '~/manifests/limitrange.yaml': `apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: team-a
spec:
  limits:
  - type: Container
    defaultRequest:      # used when a container sets no requests
      cpu: 100m
      memory: 64Mi
    default:             # used when a container sets no limits
      cpu: 250m
      memory: 128Mi
    max:
      cpu: "1"
      memory: 512Mi
`,
    '~/manifests/config-demo.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: config-demo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: config-demo
  template:
    metadata:
      labels:
        app: config-demo
    spec:
      containers:
      - name: hello
        image: kubester/hello:v1
        ports:
        - containerPort: 8080
        envFrom:
        - configMapRef:
            name: app-config          # every key becomes an env var
        volumeMounts:
        - name: config-files
          mountPath: /etc/config      # every key becomes a file
        - name: db-creds
          mountPath: /etc/secret
          readOnly: true
      - name: toolbox               # the app image is distroless (no shell), so
        image: busybox:1.36         # we add a tiny toolbox to inspect the files
        command: ["sh", "-c", "sleep 3600"]
        volumeMounts:
        - name: config-files
          mountPath: /etc/config
        - name: db-creds
          mountPath: /etc/secret
          readOnly: true
      volumes:
      - name: config-files
        configMap:
          name: app-config
      - name: db-creds
        secret:
          secretName: db-creds
---
apiVersion: v1
kind: Service
metadata:
  name: config-demo
spec:
  selector:
    app: config-demo
  ports:
  - port: 80
    targetPort: 8080
`,
    '~/manifests/liveness.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: liveness-exec
spec:
  containers:
  - name: liveness
    image: busybox:1.36
    args:
    - /bin/sh
    - -c
    - touch /tmp/healthy; sleep 30; rm -f /tmp/healthy; sleep 600
    livenessProbe:
      exec:
        command: ["cat", "/tmp/healthy"]
      initialDelaySeconds: 5
      periodSeconds: 5
`,
    '~/manifests/readiness.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ready-web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: ready-web
  template:
    metadata:
      labels:
        app: ready-web
    spec:
      containers:
      - name: nginx
        image: nginx:1.27
        readinessProbe:
          exec:
            command: ["cat", "/usr/share/nginx/html/index.html"]
          periodSeconds: 2
          failureThreshold: 1
---
apiVersion: v1
kind: Service
metadata:
  name: ready-web
spec:
  selector:
    app: ready-web
  ports:
  - port: 80
`,
    '~/manifests/greedy-pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: greedy
spec:
  containers:
  - name: app
    image: nginx:1.27
    resources:
      requests:
        cpu: "3"          # 3 whole CPUs — but each worker only has 2!
        memory: 128Mi
`,
    '~/manifests/memhog.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: memhog
spec:
  containers:
  - name: stress
    image: polinux/stress
    command: ["stress"]
    args: ["--vm", "1", "--vm-bytes", "250M", "--vm-hang", "1"]
    resources:
      requests:
        memory: 50Mi
      limits:
        memory: 100Mi     # the process wants 250M — it will be OOM-killed
`,
    '~/manifests/init-demo.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: myapp
  labels:
    app: myapp
spec:
  initContainers:
  - name: wait-for-db
    image: busybox:1.36
    command: ["sh", "-c", "until nslookup mydb; do echo waiting for mydb; sleep 2; done"]
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "echo The app is running! && sleep 3600"]
`,
    '~/manifests/sidecar-demo.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: web-with-sidecar
spec:
  volumes:
  - name: html
    emptyDir: {}               # shared scratch space, lives as long as the Pod
  containers:
  - name: nginx                # main container: serves the files
    image: nginx:1.27
    volumeMounts:
    - name: html
      mountPath: /usr/share/nginx/html
  - name: content-writer       # sidecar: keeps updating the page
    image: busybox:1.36
    command: ["sh", "-c", "while true; do echo \\"<h1>Updated at $(date)</h1>\\" > /html/index.html; sleep 5; done"]
    volumeMounts:
    - name: html
      mountPath: /html
`,
    '~/manifests/node-agent.yaml': `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-agent
spec:
  selector:
    matchLabels:
      app: node-agent
  template:
    metadata:
      labels:
        app: node-agent
    spec:
      tolerations:                       # also run on the control-plane node
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      containers:
      - name: fluent-bit
        image: fluent/fluent-bit:3.1
        resources:
          requests:
            cpu: 10m
            memory: 20Mi
        volumeMounts:
        - name: varlog
          mountPath: /var/log
          readOnly: true
      volumes:
      - name: varlog
        hostPath:
          path: /var/log
`,
    '~/manifests/pi-job.yaml': `apiVersion: batch/v1
kind: Job
metadata:
  name: pi
spec:
  backoffLimit: 4
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: pi
        image: perl:5.34.0
        command: ["perl", "-Mbignum=bpi", "-wle", "print bpi(100)"]
`,
    '~/manifests/cronjob.yaml': `apiVersion: batch/v1
kind: CronJob
metadata:
  name: report
spec:
  schedule: "*/1 * * * *"          # every minute
  successfulJobsHistoryLimit: 3      # keep only the last 3 finished Jobs
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      ttlSecondsAfterFinished: 600
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: report
            image: busybox:1.36
            command: ["sh", "-c", "date; echo generating report"]
`,
    '~/manifests/pvc.yaml': `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: standard
  resources:
    requests:
      storage: 1Gi
`,
    '~/manifests/pvc-pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: writer
spec:
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "sleep 3600"]
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: data
`,
    '~/manifests/statefulset.yaml': `apiVersion: v1
kind: Service
metadata:
  name: db
spec:
  clusterIP: None            # headless: DNS returns the Pod IPs directly
  selector:
    app: db
  ports:
  - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  serviceName: db
  replicas: 3
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
      - name: postgres
        image: postgres:17
        env:
        - name: POSTGRES_PASSWORD
          value: example
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:      # one PVC per Pod: data-db-0, data-db-1, ...
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 1Gi
`,
    '~/manifests/ingress.yaml': `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sites
spec:
  ingressClassName: nginx
  rules:
  - host: shop.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: shop
            port:
              number: 80
  - host: blog.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: blog
            port:
              number: 80
`,
    '~/manifests/ssd-pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: fast-app
spec:
  nodeSelector:
    disktype: ssd              # only nodes with this label
  containers:
  - name: app
    image: nginx:1.27
`,
    '~/manifests/gpu-pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: trainer
spec:
  tolerations:                 # allowed onto nodes tainted gpu=true:NoSchedule
  - key: gpu
    operator: Equal
    value: "true"
    effect: NoSchedule
  nodeSelector:
    kubernetes.io/hostname: worker-3
  containers:
  - name: train
    image: busybox:1.36
    command: ["sh", "-c", "echo training...; sleep 3600"]
`,
    '~/manifests/spread.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: spread
spec:
  replicas: 3
  selector:
    matchLabels:
      app: spread
  template:
    metadata:
      labels:
        app: spread
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: spread
            topologyKey: kubernetes.io/hostname   # never two on the same node
      containers:
      - name: web
        image: nginx:1.27
`,
    '~/manifests/restricted-pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: hardened
  namespace: secure
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 101
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: web
    image: nginxinc/nginx-unprivileged:1.27   # listens on 8080, runs as uid 101
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: false
      capabilities:
        drop: ["ALL"]
`,
    '~/manifests/netpol-deny.yaml': `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: shop
spec:
  podSelector: {}          # selects EVERY Pod in the namespace
  policyTypes:
  - Ingress                # ...and allows no incoming traffic
`,
    '~/manifests/netpol-allow.yaml': `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: api              # protect the api Pods
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend     # only frontend Pods may connect
    ports:
    - port: 8080
`,
    '~/manifests/blue-green.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-blue
spec:
  replicas: 2
  selector:
    matchLabels: {app: myapp, version: blue}
  template:
    metadata:
      labels: {app: myapp, version: blue}
    spec:
      containers:
      - name: app
        image: kubester/hello:v1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-green
spec:
  replicas: 2
  selector:
    matchLabels: {app: myapp, version: green}
  template:
    metadata:
      labels: {app: myapp, version: green}
    spec:
      containers:
      - name: app
        image: kubester/hello:v2
---
apiVersion: v1
kind: Service
metadata:
  name: myapp
spec:
  selector:
    app: myapp
    version: blue           # traffic goes to blue... for now
  ports:
  - port: 80
    targetPort: 8080
`,
    '~/kustomize/base/kustomization.yaml': `resources:
- deployment.yaml
- service.yaml
configMapGenerator:
- name: site-config
  literals:
  - MESSAGE=hello from the base
`,
    '~/kustomize/base/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: site
spec:
  replicas: 1
  selector:
    matchLabels:
      app: site
  template:
    metadata:
      labels:
        app: site
    spec:
      containers:
      - name: site
        image: kubester/hello:v1
        envFrom:
        - configMapRef:
            name: site-config
`,
    '~/kustomize/base/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: site
spec:
  selector:
    app: site
  ports:
  - port: 80
    targetPort: 8080
`,
    '~/kustomize/overlays/prod/kustomization.yaml': `resources:
- ../../base
namePrefix: prod-
labels:
- pairs:
    env: prod
  includeSelectors: true
replicas:
- name: site
  count: 3
images:
- name: kubester/hello
  newTag: v2
`,
    '~/kustomize/overlays/dev/kustomization.yaml': `resources:
- ../../base
namePrefix: dev-
labels:
- pairs:
    env: dev
  includeSelectors: true
`,
  };
})(typeof window !== 'undefined' ? window : globalThis);
