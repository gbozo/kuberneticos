# KuberneticOS API server

A small, stdlib-only Go HTTP server that exposes a JSON API for the
KuberneticOS web desktop (clusters, nodes, pods, namespaces, workloads,
services and live metrics). It replaces the deleted
vendored `kubernetes-client/go` library with the modern, maintained
[`k8s.io/client-go`](https://github.com/kubernetes/client-go) and uses
[`k8s.io/metrics`](https://github.com/kubernetes/metrics) for the
`metrics.k8s.io/v1beta1` data behind `/api/metrics/*`.

Cluster access follows the standard client-go loading order:

1. `KUBERNETICOS_KUBECONFIG` (falling back to `KUBECONFIG`)
2. in-cluster configuration (service account)
3. `$HOME/.kube/config`

If none of these can be loaded, the server **still starts** and serves explicit
offline responses with `"source":"offline"` and empty lists (`[]`), rather than
crashing.

## Run

```sh
cd server
go run .
```

With a rebuild-on-save loop instead, run `[air](https://github.com/air-verse/air)`
from the repo root — `npm run dev-server` (config `server/.air.toml`; it builds
the whole package into `server/tmp/` and restarts on every non-test source
change). Without air installed, `npm run dev-server:plain` matches the command
above.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8700` | HTTP listen port |
| `KUBERNETICOS_KUBECONFIG` | — | Explicit kubeconfig path (takes precedence over `KUBECONFIG`) |
| `KUBECONFIG` | — | Standard kubeconfig path, used if `KUBERNETICOS_KUBECONFIG` is unset |
| `KOS_ALLOWED_ORIGINS` | Vite dev + preview origins | Comma-separated exact CORS origins; set it to **replace** the defaults |
| `KOS_XDISPLAY_START` | `21` | First Xvfb display number handed out by the display allocator |
| `KOS_XDISPLAY_POOL` | `5` | Number of displays in the static pool (`:START` … `:START+N-1`) |
| `KOS_XDISPLAY_TTL` | `12h` | Lifetime of an xdisplay session token (modifiable reconnects/`DELETE` semantics unchanged) |
| `KOS_XSERVER_NAMESPACE` | `kos` | Namespace of the central shared X server pod |
| `KOS_XSERVER_POD` | `kos-xserver-0` | X server pod name (xauth exec target, pod IP for VNC dials) |
| `KOS_XSERVER_SERVICE` | `kos-xserver` | X server service name (DISPLAY FQDN `<svc>.<ns>.svc`) |
| `KOS_STREAM_IDLE_TIMEOUT` | `5m` | Idle budget for the websocket streams (xdisplay ws, exec ws) |

## Endpoints

All responses are JSON. CORS is **origin-restricted**: an allowlist (defaults to
`http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173` and
`http://127.0.0.1:4173`; override with the comma-separated
`KOS_ALLOWED_ORIGINS`) is echoed exactly as
`Access-Control-Allow-Origin: <origin>` — never `*` — and every response carries
`Vary: Origin`.

| Method | Path | Response |
|---|---|---|
| `GET` | `/api/health` | `{"status":"ok","source":"live"\|"offline"}` |
| `GET` | `/api/clusters` | `{"source":...,"clusters":[ClusterRef...]}` |
| `GET` | `/api/nodes?cluster=<id>` | `{"source":...,"nodes":[Node...]}` |
| `GET` | `/api/nodes/detail?cluster=<id>&name=<node>` | `{"source":...,"node":{NodeDetail}}` |
| `GET` | `/api/namespaces?cluster=<id>` | `{"source":...,"namespaces":[Namespace...]}` |
| `GET` | `/api/pods?cluster=<id>&node=<name>&namespace=<ns>&selector=<labelSelector>` | `{"source":...,"pods":[Pod...]}` |
| `GET` | `/api/pods/logs?cluster=<id>&namespace=<ns>&pod=<name>&container=<c>&tailLines=<n>` | `{"source":...,"logs":"<raw log text>"}` |
| `DELETE` | `/api/pods?cluster=<id>&namespace=<ns>&pod=<name>` | `{"source":...,"ok":true,"message":...}` (200) |
| `GET` | `/api/deployments?cluster=<id>&namespace=<ns>` | `{"source":...,"deployments":[Deployment...]}` |
| `GET` | `/api/replicasets?cluster=<id>&namespace=<ns>` | `{"source":...,"replicasets":[ReplicaSet...]}` |
| `POST` | `/api/deployments/restart?cluster=<id>&namespace=<ns>&deployment=<name>` | `{"source":...,"ok":true,"message":...}` (200) |
| `GET` | `/api/replicationcontrollers?cluster=<id>&namespace=<ns>` | `{"source":...,"replicationcontrollers":[ReplicationController...]}` |
| `POST` | `/api/deployments/scale?cluster=<id>&namespace=<ns>&deployment=<name>&replicas=<n>` | `{"source":...,"ok":true,"message":...}` (200) |
| `GET` | `/api/services?cluster=<id>&namespace=<ns>` | `{"source":...,"services":[Service...]}` |
| `GET` | `/api/metrics/nodes?cluster=<id>` | `{"source":...,"available":<bool>,"nodes":[NodeMetrics...]}` |
| `GET` | `/api/metrics/pods?cluster=<id>&namespace=<ns>` | `{"source":...,"available":<bool>,"pods":[PodMetrics...]}` |
| `POST` | `/api/xdisplay` | Allocate an X display + launch a GUI app: body `{namespace, pod, container?, app?, command[:]}` → `{"source":...,"display":<n>,"token":"...","wsPath":"/api/xdisplay/ws?token=..."}` |
| `DELETE` | `/api/xdisplay?token=<t>` or `?display=<n>` | Kill the launched app process, clean the cookie and free the display → `{"source":...,"ok":true,"message":...}` |
| `GET` | `/api/xdisplay/list` | `{"source":...,"available":<bool>,"displays":[{display,app,pod,namespace,container,createdAt,sessionAge}]}` |
| `GET` | `/api/xdisplay/health` | `{"source":...,"available":<bool>}` — xserver pod reachable and its first VNC port answers TCP |
| `GET` | `/api/xdisplay/ws?token=<t>` | **WebSocket** — binary RFB frames proxied to the display's `5900+N` x11vnc listener (websockify clone) |
| `GET` | `/api/exec/ws?namespace=<ns>&pod=<p>&container=<c>` | **WebSocket** — terminal exec bridge: binary = data, text `{"type":"resize","cols":N,"rows":N}` = resize, text `{"type":"error"\|"closed"}` = lifecycle |

Every response includes a `source` field (`"live"` or `"offline"`). All query
parameters are optional unless noted; empty lists render as `[]`, never `null`.

| Parameter | Used by | Meaning |
|---|---|---|
| `cluster` | all list/detail endpoints | Cluster identifier (echoed by the single configured client) |
| `namespace` | pods, deployments, replicasets, replicationcontrollers, services, pods/logs, metrics/pods, `DELETE /api/pods`, `POST /api/deployments/restart`, `POST /api/deployments/scale` | Namespace filter (list endpoints) or **required** target namespace (write endpoints); missing → `400` |
| `node` | pods | Node name, forwarded as the `spec.nodeName` field selector |
| `selector` | pods | Kubernetes label selector string (e.g. `app=web,tier=frontend`), forwarded as `ListOptions.LabelSelector` |
| `name` | nodes/detail | **Required** node name; missing → `400` |
| `pod` | pods/logs, `DELETE /api/pods` | Pod name (**required** for delete); missing → `400` |
| `container` | pods/logs | Container name; omitted → the pod's default container |
| `tailLines` | pods/logs | Lines to tail; integer, default `200`, clamped to `[1,5000]`; non-integer → `400` |
| `deployment` | `POST /api/deployments/restart`, `POST /api/deployments/scale` | Deployment name; **required** → `400` when missing |
| `replicas` | `POST /api/deployments/scale` | Desired replica count; integer in `[0,1000]`; missing/non-integer/out-of-range → `400` |

Errors are returned as `{"error":"..."}`. Missing/invalid parameters return
`400`; a Kubernetes `NotFound` error returns `404`; `Forbidden` (RBAC) return
`403`, `Unauthorized` `401`, `Conflict` `409`, `BadRequest`/`Invalid` `400`, and
offline mode `503`; all other errors return `500`. Every request is wrapped by
the `withRequestTimeout` middleware: unless the caller already set a deadline,
the server gives it a shared **15s context budget** and a deadline-exceeded
error (e.g. from the cluster client or a stuck kubelet) is answered with
`504` `{"error":"context deadline exceeded"}`. The two websocket routes are the
deliberate exception to that budget (bipartite timeout strategy): they derive a
cancel-detached context for the long-lived cluster leg and enforce liveness
themselves — 10s ping/pong keepalive, an idle timeout (`KOS_STREAM_IDLE_TIMEOUT`,
default `5m`, reset by pong traffic), and the request middleware never sees
their lifetime. WebSocket origin handling mirrors the HTTP allowlist at the
upgrade (`withCORS` passes GETs through, so the upgrader's `CheckOrigin`
enforces it): no `Origin` header (curl/server-to-server) is allowed, browser
origins must be allowlisted, everything else gets a non-2xx handshake. Unknown
methods on a known path return `405`; `OPTIONS` preflight from an allowed
origin is answered by the CORS middleware with `204`. `withCORS` allows `GET,
POST, DELETE, OPTIONS` and sets `Vary: Origin` on every response. Requests may
carry an `Origin` in the allowlist (echoed exactly), no `Origin` (curl,
server-to-server — always allowed), or a disallowed `Origin`: the latter get no
ACAO header, so `GET` still runs but the browser blocks reading it, while
`POST`/`DELETE` and `OPTIONS` are rejected with `403`
`{"error":"origin not allowed"}` before the handler runs.

The three write endpoints mutate the cluster:

| Method | Path | Success |
|---|---|---|
| `DELETE` | `/api/pods?cluster=<id>&namespace=<ns>&pod=<name>` | `200` `{"source":…,"ok":true,"message":"Deleted pod <ns>/<pod>"}` |
| `POST` | `/api/deployments/restart?cluster=<id>&namespace=<ns>&deployment=<name>` | `200` `{"source":…,"ok":true,"message":"Restarted deployment <ns>/<name>"}` |
| `POST` | `/api/deployments/scale?cluster=<id>&namespace=<ns>&deployment=<name>&replicas=<n>` | `200` `{"source":…,"ok":true,"message":"Scaled deployment <ns>/<name> to <n> replicas"}` |

Offline mode rejects them with `503` (`errOffline`) instead of mutating anything.

### X-display sessions (xdesktop, M2)

`POST /api/xdisplay` allocates a display from the static pool (`:21`–`:25` by
default, `KOS_XDISPLAY_START`/`KOS_XDISPLAY_POOL`), generates a 16-byte xauth
cookie, registers it in the xserver pod via `POST .../pods/exec` (`xauth add`),
then launches the requested command inside the **user-supplied target pod**:
the cookie travels on the exec's **stdin** (base64), a wrapper script decodes
it into `/tmp/.kos-xauth-<N>` via `xauth -f`, prints the launcher shell PID and
`exec`s the command with `DISPLAY=kos-xserver.<ns>.svc:<N>` and
`XAUTHORITY=/tmp/.kos-xauth-<N>` set. The session is looked up afterwards via
its random **token** (32 hex chars): it survives browser refreshes until
`DELETE` or the TTL (`KOS_XDISPLAY_TTL`, default `12h`) and may open multiple
websocket streams — `GET /api/xdisplay/ws?token=...` proxies binary frames
between the browser and `podIP:5900+N` (x11vnc). `DELETE` (by `token=` or
`display=`) execs `kill -TERM <pid>` in the app pod, best-effort removes the
cookie file and xauth entries and frees the display; unknown/expired tokens
answer `404`. `list`/`health` follow the metrics philosophy: HTTP 200 with
`available:false` when offline or the xserver is unreachable — never a 5xx.
`POST /api/xdisplay` on an exhausted pool answers `503`.

The two metrics endpoints are the exception to the error mapping: they read
CPU/memory from `metrics.k8s.io/v1beta1` (via the
[`k8s.io/metrics`](https://github.com/kubernetes/metrics) v0.37.1 client) and
join node/pod disk and network figures best-effort from the kubelet **Summary
API** (`nodes/<name>/proxy/stats/summary` through the `nodes/proxy`
subresource, so the service account needs `nodes/proxy`). Per-node summaries
are fetched in parallel (max 4 nodes in flight) and each call's deadline is
capped at 3s but never above the request's remaining 15s budget (the request
context stays the parent), so slow nodes are skipped and large clusters fail
fast instead of all metrics being lost to a request-level 504. When metrics-server is not installed or the metrics API is
unreachable they return
`{"source":...,"available":false,"nodes":[]}` /
`{"source":...,"available":false,"pods":[]}` with **HTTP 200** — never a 500.
Offline mode also reports `available:false`.

### Types

```jsonc
// ClusterRef
{ "id": "...", "name": "...", "server": "https://..." }

// Node
{ "name": "...", "status": "Ready", "roles": ["control-plane"], "version": "v1.30.0" }

// Pod (ownerKind/ownerName come from the controller ownerReferences and are
// omitted when the pod has no controller owner; labels is omitted when empty)
{ "name": "...", "namespace": "...", "node": "...", "phase": "Running",
  "ownerKind": "ReplicaSet", "ownerName": "web-abc", "labels": { "app": "web" } }

// Replicas
{ "desired": 3, "ready": 3, "available": 3, "updated": 3 }

// Namespace
{ "name": "default", "status": "Active" }

// Deployment
{ "name": "web", "namespace": "default", "replicas": { ...Replicas }, "images": ["nginx:1.27"] }

// ReplicaSet (same minus images; ownerKind/ownerName omitted when unowned)
{ "name": "web-abc", "namespace": "default", "replicas": { ...Replicas },
  "ownerKind": "Deployment", "ownerName": "web" }

// ReplicationController (same minus images)
{ "name": "legacy", "namespace": "default", "replicas": { ...Replicas } }

// ServicePort
{ "name": "http", "port": 80, "protocol": "TCP", "targetPort": "8080" }

// Service (selector is omitted when the service has none)
{ "name": "web", "namespace": "default", "type": "ClusterIP", "clusterIP": "10.0.0.10",
  "ports": [ ...ServicePort ], "selector": { "app": "web" } }

// NodeCondition / NodeAddress
{ "type": "Ready", "status": "True" }
{ "type": "InternalIP", "address": "10.0.0.1" }

// NodeDetail
{
  "name": "n1",
  "status": "Ready",
  "roles": ["control-plane"],
  "version": "v1.30.0",
  "capacity": { "cpu": "4", "memory": "16Gi" },
  "allocatable": { "cpu": "4", "memory": "16Gi" },
  "conditions": [ { "type": "Ready", "status": "True" } ],
  "addresses": [ { "type": "InternalIP", "address": "10.0.0.1" } ]
}

// ContainerMetrics
{ "name": "web", "cpuMillis": 12, "memoryBytes": 67108864 }

// NodeMetrics — cpuAllocatableMillis, memoryAllocatableBytes, diskUsedBytes,
// diskCapacityBytes, networkRxBytes, networkTxBytes and podCount are omitted
// when unknown (e.g. no Summary API access)
{
  "name": "n1",
  "cpuMillis": 250,
  "memoryBytes": 1073741824,
  "cpuAllocatableMillis": 4000,
  "memoryAllocatableBytes": 8589934592,
  "diskUsedBytes": 12884901888,
  "diskCapacityBytes": 53687091200,
  "networkRxBytes": 1048576,
  "networkTxBytes": 2097152,
  "podCount": 12
}

// PodMetrics — node, diskUsedBytes, networkRxBytes and networkTxBytes are
// omitted when unknown
{
  "name": "web-0",
  "namespace": "default",
  "node": "n1",
  "cpuMillis": 12,
  "memoryBytes": 67108864,
  "containers": [ { "name": "web", "cpuMillis": 12, "memoryBytes": 67108864 } ],
  "diskUsedBytes": 20971520,
  "networkRxBytes": 4096,
  "networkTxBytes": 8192
}

// NodeMetricsResult / PodMetricsResult — the metrics endpoints' payload
// (minus the `source` field the handlers add)
{ "available": true, "nodes": [ ...NodeMetrics ] }
{ "available": false, "pods": [] }
```

> Note: `ReplicaSet` and `ReplicationController` have no "updated replicas"
> status field, so their `replicas.updated` is always `0`. `Deployment` reports
> `status.updatedReplicas`. A service's backing pods are resolved client-side by
> matching its `selector` against pod `labels` (there is no server endpoint for
> this).

### Sample responses

```jsonc
// GET /api/namespaces?cluster=default
{ "source": "live", "namespaces": [ { "name": "default", "status": "Active" } ] }

// GET /api/deployments?cluster=default&namespace=default
{ "source": "live", "deployments": [
  { "name": "web", "namespace": "default",
    "replicas": { "desired": 3, "ready": 3, "available": 3, "updated": 3 },
    "images": ["nginx:1.27"] }
] }

// GET /api/replicasets?cluster=default&namespace=default
{ "source": "live", "replicasets": [
  { "name": "web-abc", "namespace": "default",
    "replicas": { "desired": 3, "ready": 3, "available": 3, "updated": 0 } }
] }

// GET /api/replicationcontrollers?cluster=default&namespace=default
{ "source": "live", "replicationcontrollers": [
  { "name": "legacy", "namespace": "default",
    "replicas": { "desired": 2, "ready": 2, "available": 2, "updated": 0 } }
] }

// GET /api/services?cluster=default&namespace=default
{ "source": "live", "services": [
  { "name": "web", "namespace": "default", "type": "ClusterIP", "clusterIP": "10.0.0.10",
    "ports": [ { "name": "http", "port": 80, "protocol": "TCP", "targetPort": "8080" } ] }
] }

// GET /api/nodes/detail?cluster=default&name=n1
{ "source": "live", "node": {
  "name": "n1", "status": "Ready", "roles": ["control-plane"], "version": "v1.30.0",
  "capacity": { "cpu": "4", "memory": "16Gi" },
  "allocatable": { "cpu": "4", "memory": "16Gi" },
  "conditions": [ { "type": "Ready", "status": "True" } ],
  "addresses": [ { "type": "InternalIP", "address": "10.0.0.1" } ] } }

// GET /api/pods?cluster=default&namespace=default&selector=app%3Dweb
{ "source": "live", "pods": [ { "name": "web-0", "namespace": "default", "node": "n1", "phase": "Running" } ] }

// GET /api/pods/logs?cluster=default&namespace=default&pod=web-0&container=web&tailLines=200
{ "source": "live", "logs": "2026-01-01T00:00:00Z serving on :8080\n" }
```

## Frontend integration

The repo's `vite.config.ts` proxies `/api` to `http://localhost:8700`, so the
web desktop can call these endpoints during `vite dev` without any extra CORS
setup (the dev origin is in the default allowlist).
