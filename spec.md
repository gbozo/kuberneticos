# spec.md — KuberneticOS project specification

Status: **implemented** · Stack: **TypeScript + React 19 + Vite + Go** · License: GPL-3

This document specifies what KuberneticOS *is*. The modernization it once
described is complete: §2 records what was replaced, §3 onward describes the
code that is actually in the repository. `agents.md` points agents here.

---

## 1. Purpose

KuberneticOS is a **web desktop for Kubernetes**. It renders a real desktop
metaphor in the browser — taskbar, start menu, context menu, resizable
overlapping windows, focus/blur — and the "applications" that run inside those
windows manage Kubernetes clusters.

The Windows-like look is deliberate: users already understand a desktop, and
that familiarity is the product's affordance. MacOS, Gnome, and KDE skins ship
as **themes** (token overrides), not code forks.

## 2. Modernization outcome

| Aspect | Before | Now |
|---|---|---|
| Language | Flow-syntax JS (`import X from "y"`, `const a: T`) | TypeScript strict, ES modules |
| React | 16.7, `extends Component`, `static contextTypes` | React 19, function components + hooks |
| App shell | Create React App 2.1.3 | Vite 6 (`@vitejs/plugin-react`) |
| Theming | `react-uwp` (abandoned ~2018) | Local components + design tokens (`--kos-*`) |
| Window resize | `react-rnd` 9.1 | `react-rnd` 10.x (kept — decision D5) |
| State/event layer | `flux` Dispatcher + EventEmitter store + `WMActions` | Immutable reducer + typed event bus (React context) |
| IDs | `shortid` | `crypto.randomUUID()` |
| Build | gulp 4 + babel-register + flow-bin + styleguidist | `vite build` (`tsc -b && vite build`) |
| Tests | CRA `App.test.js` | vitest units + Playwright e2e |
| Lint/format | implicit CRA eslint | eslint 9 flat config + prettier |
| Go code | ~2,200 vendored files of the deprecated `kubernetes-client/go` | Deleted; `server/` uses `k8s.io/client-go` |
| Docs | CRA-template README with wrong badges, stale `help.md` | Rewritten README; `help.md` removed |

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Desktop shell (React 19 + Vite, TypeScript)              │
│  Taskbar ── Clock · StartMenu · WindowList · ContextMenu │
│  WindowManager ── z-order, focus/blur, minimize/restore  │
│  Window apps ── registry: ClusterExplorer, Terminal,       │
│  XDesktop (keepAlive), TaskManager*(TestWindow=dev-only)   │
└───────────────┬──────────────────────────────────────────┘
                │ typed ClusterClient interface                 │
                │ (no raw fetch outside src/cluster/client.ts) │
                │ Vite dev proxy: /api → http://localhost:8700 │
┌───────────────▼──────────────────────────────────────────┐
│ Go server (server/, stdlib net/http + k8s.io/client-go)  │
│  /api/clusters · /api/namespaces · /api/nodes · /api/pods│
│  live client (kubeconfig / in-cluster) ⇄ offline client  │
└──────────────────────────────────────────────────────────┘
```

### Behaviour contract (enforced by `e2e/desktop.spec.ts`)

1. The taskbar is pinned to the bottom of the viewport (`--kos-taskbar-z`,
   `1100`) — above the window layer.
2. Windows overlap with a z-order; the focused window is raised frontmost and
   visually distinct from blurred windows (`.is-focused` / `.is-blurred`).
3. Windows are draggable and resizable; **minimize/restore and close are
   distinct** operations.
4. The start menu opens from the taskbar **above** it geometrically and below
   the taskbar in z-order (`--kos-startmenu-z`, `1050`).
5. Right-click anywhere opens the context menu; it flips at viewport edges and
   closes on outside click, scroll, or Escape.
6. The clock ticks once a second and shows the full date-time on hover.

Maximized windows derive their geometry from the viewport minus the taskbar
height and restore their stored geometry when un-maximized.

### State model (as implemented)

- **One** immutable `DesktopState` in `src/state/types.ts`: `windows`,
  `focusedWindowId`, `startMenuOpen`, `contextMenu`, `nextZIndex`.
- `src/state/reducer.ts` holds the pure `desktopReducer` plus selectors
  `getVisibleWindows`, `getTaskbarWindows`, `getFocusedWindow`. Action union:
  `ADD_WINDOW`, `REMOVE_WINDOW`, `FOCUS_WINDOW`, `MINIMIZE_WINDOW`,
  `RESTORE_WINDOW`, `TOGGLE_MAXIMIZE`, `MOVE_WINDOW`, `RESIZE_WINDOW`,
  `TOGGLE_START_MENU`, `OPEN_CONTEXT_MENU`, `CLOSE_CONTEXT_MENU`.
- `src/state/events.ts` is a small typed bus (`window-added`, `window-removed`,
  `window-focused`, `window-minimized`, `window-restored`,
  `start-menu-toggled`) used **only** for cross-component observation.
- `src/state/DesktopContext.tsx` wires `useReducer` + the bus and exposes
  `useDesktop()` and `useDesktopEvent(type, handler)`.
- Theming lives in `src/theme/`: `tokens.css` defines every `--kos-*` token for
  the default `windows` theme plus `macos`/`gnome`/`kde` override blocks;
  `theme.ts` applies the theme to `<html>` and persists it.

## 4. Frontend surface

- **UI primitives** (`src/components/ui/`): `AppBarButton`, `AppBarSeparator`,
  `AutoSuggestBox`, `CheckBox`, `Icon`, `ListView`, `Menu`/`MenuItem`,
  `Separator`, `Toggle`, `Tooltip` — all local, all token-driven, no UI kit.
- **Shell** (`src/components/`): `Window`, `WindowApp`, `WindowManager`,
  `TaskBar`, `TaskBarWindows`, `TaskBarClock`, `StartMenu`, `Contextmenu`.
- **Window apps** (`src/window-apps/`): `TestWindow` (dev-only), `ClusterExplorer`,
  `Terminal`, `XDesktop` and `TaskManager`, registered in `registry.ts`. Cluster
  Explorer lists clusters and opens sessions: every pod row offers **Open
  terminal**, and pods annotated `kos.dev/x-app: "<command>"` additionally get
  **Open GUI app**. `Terminal` is an xterm.js shell into the pod (exec
  websocket); `XDesktop` is a remote GUI app rendered over noVNC inside the
  window. Both apps are `keepAlive`: minimizing keeps the session (React tree
  stays mounted, hidden with `display:none`) and closing/unmounting is what
  releases it —-only window close triggers the (best-effort) `DELETE /api/xdisplay` for GUI sessions.
  Task Manager is a Windows 11-style shell: a left icon rail with pages
  Workloads (default), Performance, Services, Pods, Namespaces and Nodes plus a
  Settings page pinned at the rail bottom; a per-page command bar (namespace
  select, Refresh, update-speed select: Paused / Low 5s / Normal 2s / High 1s);
  and a hero panel on Workloads/Performance showing cluster name, version, node
  count and CPU/Memory/Disk gauges. Workloads renders a Deployment → ReplicaSet
  → Pod tree table (Name / Status / CPU / Memory / Disk / Network columns) with
  group-by (Deployment / ReplicaSet / Pod / Namespace / Node), sort and filter;
  Performance charts CPU, memory, disk and network over time. Activating a row
  (double-click or `Enter`) opens a right-hand **detail flyout** — the
  replacement for the dropped breadcrumbs: workloads show a summary with
  children and pod logs, services show ports, selector and backing pods, pods
  show a summary with labels and logs, and nodes show the node detail
  (capacity, allocatable, conditions and addresses). The pod and deployment
  flyouts include an actions bar (End task for pods; Restart and Scale for
  deployments) that calls the API behind a confirmation dialog and surfaces
  RBAC errors inline. A single cluster is auto-selected when one exists. Both
  apps show *"No clusters configured — start the Go server"* when the API returns
  none.

## 5. Kubernetes integration (as implemented)

The cluster connection is **server-side**, per decision D2. The frontend holds
exactly one integration point, `src/cluster/client.ts`:

```ts
interface ClusterClient {
  listClusters(): Promise<readonly ClusterInfo[]>;
  listNamespaces(clusterId: string): Promise<readonly NamespaceInfo[]>;
  listNodes(clusterId: string): Promise<readonly NodeInfo[]>;
  getNode(clusterId: string, name: string): Promise<NodeDetailInfo>;
  listDeployments(clusterId: string, namespace?: string): Promise<readonly DeploymentInfo[]>;
  listReplicaSets(clusterId: string, namespace?: string): Promise<readonly ReplicaSetInfo[]>;
  listReplicationControllers(
    clusterId: string,
    namespace?: string,
  ): Promise<readonly ReplicationControllerInfo[]>;
  listServices(clusterId: string, namespace?: string): Promise<readonly ServiceInfo[]>;
  listPods(
    clusterId: string,
    node?: string,
    namespace?: string,
    selector?: string,
  ): Promise<readonly PodInfo[]>;
  getPodLogs(
    clusterId: string,
    namespace: string,
    pod: string,
    container?: string,
    tailLines?: number,
  ): Promise<string>;
  getNodeMetrics(clusterId: string): Promise<NodeMetricsResult>;
  getPodMetrics(clusterId: string, namespace?: string): Promise<PodMetricsResult>;
  deletePod(clusterId: string, namespace: string, pod: string): Promise<void>;
  restartDeployment(clusterId: string, namespace: string, deployment: string): Promise<void>;
  scaleDeployment(
    clusterId: string,
    namespace: string,
    deployment: string,
    replicas: number,
  ): Promise<void>;
}
```

REST lives in `client.ts` only. **Streams** (`src/cluster/streams.ts`) are the
second and last network module: `openXDisplaySession` / `releaseXDisplaySession`
/ `listXDisplays` (JSON calls to `/api/xdisplay*`), `connectRfbStream` (noVNC
`RFB` wrapper — scaleViewport on, no passwords, xauth does the auth) and
`connectExecStream` (browser websocket bridge: binary frames are terminal data,
text frames are JSON control — `{"type":"resize",…}`, `"error"`, `"closed"`).
Errors surface as `StreamError` with `kind: 'unavailable' | 'timeout' |
'network' | 'failed'` so the window apps can degrade instead of crashing.

- `ClusterInfo { id, name, server }`, `NamespaceInfo { name, status }`,
  `NodeInfo { name, status, roles, version? }`, `NodeDetailInfo { name, status,
  roles, version, capacity, allocatable, conditions, addresses }`,
  `PodInfo { name, namespace, node?, phase, ownerKind?, ownerName?,
  annotations? }`, plus
  `DeploymentInfo`, `ReplicaSetInfo`, `ReplicationControllerInfo` (each with a
  `ReplicaCounts { desired, ready, available, updated }`) and
  `ServiceInfo { name, namespace, type, clusterIP, ports }`. `PodInfo` and
  `ReplicaSetInfo` carry optional `ownerKind` / `ownerName` derived from the
  controller `ownerReferences`.
- Live metrics types: `ContainerMetrics { name, cpuMillis, memoryBytes }`,
  `NodeMetrics { name, cpuMillis, memoryBytes, cpuAllocatableMillis?,
  memoryAllocatableBytes?, diskUsedBytes?, diskCapacityBytes?, networkRxBytes?,
  networkTxBytes?, podCount? }`, `PodMetrics { name, namespace, node?,
  cpuMillis, memoryBytes, containers, diskUsedBytes?, networkRxBytes?,
  networkTxBytes? }`, and the envelopes `NodeMetricsResult { available, nodes }`
  and `PodMetricsResult { available, pods }`.
- `HttpClusterClient` (the default) talks to `/api` and unwraps the server's
  `{ source, … }` envelopes.
- `OfflineClusterClient` returns empty lists, an empty-safe `NodeDetailInfo`,
  empty log text and `{ available: false, nodes: [] }` / `{ available: false,
  pods: [] }` metrics — the fallback that keeps the app usable with no server.

The Go server (`server/main.go`) uses the standard library `net/http`,
`k8s.io/client-go` v0.37.1 and `k8s.io/metrics` v0.37.1:

| Endpoint | Response |
|---|---|
| `GET /api/health` | `{"status":"ok","source":"live"\|"offline"}` |
| `GET /api/clusters` | `{"source":…,"clusters":[{"id","name","server"}]}` |
| `GET /api/namespaces?cluster=<id>` | `{"source":…,"namespaces":[{"name","status"}]}` |
| `GET /api/nodes?cluster=<id>` | `{"source":…,"nodes":[{"name","status","roles","version"}]}` |
| `GET /api/nodes/detail?cluster=<id>&name=<node>` | `{"source":…,"node":{…NodeDetail}}` |
| `GET /api/deployments?cluster=<id>&namespace=<ns>` | `{"source":…,"deployments":[{"name","namespace","replicas","images"}]}` |
| `GET /api/replicasets?cluster=<id>&namespace=<ns>` | `{"source":…,"replicasets":[{"name","namespace","replicas"}]}` |
| `GET /api/replicationcontrollers?cluster=<id>&namespace=<ns>` | `{"source":…,"replicationcontrollers":[{"name","namespace","replicas"}]}` |
| `GET /api/services?cluster=<id>&namespace=<ns>` | `{"source":…,"services":[{"name","namespace","type","clusterIP","ports"}]}` |
| `GET /api/pods?cluster=<id>&node=<name>&namespace=<ns>&selector=<sel>` | `{"source":…,"pods":[{"name","namespace","node","phase"}]}` |
| `GET /api/pods/logs?cluster=<id>&namespace=<ns>&pod=<name>&container=<c>&tailLines=<n>` | `{"source":…,"logs":"…"}` |
| `GET /api/metrics/nodes?cluster=<id>` | `{"source":…,"available":bool,"nodes":[…NodeMetrics]}` |
| `GET /api/metrics/pods?cluster=<id>&namespace=<ns>` | `{"source":…,"available":bool,"pods":[…PodMetrics]}` |
| `DELETE /api/pods?cluster=<id>&namespace=<ns>&pod=<name>` | `{"source":…,"ok":true,"message":…}` (200) |
| `POST /api/deployments/restart?cluster=<id>&namespace=<ns>&deployment=<name>` | `{"source":…,"ok":true,"message":…}` (200) |
| `POST /api/deployments/scale?cluster=<id>&namespace=<ns>&deployment=<name>&replicas=<n>` | `{"source":…,"ok":true,"message":…}` (200) |

The write endpoints (`DELETE`/`POST`) share `writeError`'s status mapping:
`400` for a missing/invalid parameter, `401` unauthorized, `403` when RBAC denies
the operation, `404` for an unknown resource, `409` on scale conflicts, `503`
offline, otherwise `500`; every error body is `{"error":…}`. `withCORS`
restricts CORS to an exact-origin allowlist (defaults to the Vite dev/preview
origins, replaced by the comma-separated `KOS_ALLOWED_ORIGINS` env var), echoes
an allowed `Origin` exactly and otherwise sends no `Access-Control-Allow-Origin`
header, always sets `Vary: Origin`, and allows
`GET, POST, DELETE, OPTIONS`. Requests with no `Origin` (curl, server-to-server)
always proceed; `POST`/`DELETE` and `OPTIONS` from a disallowed origin get `403`
`{"error":"origin not allowed"}` before reaching the handler.

The metrics endpoints read CPU/memory from `metrics.k8s.io/v1beta1` (the
`k8s.io/metrics` client) and join node/pod disk and network from the kubelet
**Summary API** (`nodes/<name>/proxy/stats/summary`, requires `nodes/proxy`)
best-effort. When metrics-server is not installed or the API is unavailable the
endpoints answer `{"available":false,"nodes":[]}` / `{"available":false,
"pods":[]}` with **HTTP 200** — never 500; offline mode also reports
`available:false`.

Every request is bounded so a hung target can't wedge the app or the server:
`HttpClusterClient` routes all calls through a **15s fetch timeout**
(`AbortController` armed through body read) that aborts with a clear timeout
error, and `usePolledMetrics` carries an **in-flight poll guard** keyed to
cluster/namespace so polls never overlap and stale responses are discarded when
the cluster changes. Server-side, a `withRequestTimeout` middleware gives each
request a **15s budget** (504 on deadline), kubelet Summary-API proxy calls run
under a **3s deadline** capped by the remaining budget, and per-node summary
fetches run four-way concurrent — an unresponsive kubelet degrades the metrics
endpoints instead of blocking the process for minutes.

Kubeconfig resolution order is `KUBERNETICOS_KUBECONFIG` → `KUBECONFIG` →
in-cluster → `$HOME/.kube/config`. If none is usable the server must still
start and answer `"source":"offline"` with empty lists — it must never crash.
CORS uses an origin allowlist (never `*`; see `KOS_ALLOWED_ORIGINS` above), and
`OPTIONS` from an allowed origin returns 204. `/api/nodes/detail` requires
`name` (400 without it); a missing node or pod returns 404. Pod logs default to
`tailLines=200`, clamped to 1–5000.

### X-Desktop sessions (as implemented)

The remote-app feature rides a **central shared X server pod** (`kos-xserver`,
deployed from `deploy/` — one `Xvfb :21..:N` + openbox + x11vnc per pool display,
per-display xauth cookies, memory-backed `/dev/shm`). App pods stay stock:
kos-server generates a per-session xauth cookie, `xauth add`s it in the xserver
pod, launches the annotated command in the target pod via exec wrapped in
`setsid env DISPLAY=kos-xserver.<ns>.svc:<N> … </dev/null >/dev/null 2>&1 & echo
$!` (backgrounded stdin/stdout — the exec session must NOT live for the app),
and records the PID. The kOS window claims exactly one virtual display.

Endpoints (`server/xdisplay.go` / `server/exec.go`):

- `POST /api/xdisplay` (`{namespace, pod, container?, command, app?}`) →
  allocate display, auth+launch, return `{display, token, wsPath}`.
- `DELETE /api/xdisplay?token=` → kill the recorded process **group**
  (`kill -TERM -pid` with `kill -0` wait + `kill -KILL` fallback), remove the
  xauth entries, free the display; release idempotent.
- `GET /api/xdisplay/list` → active sessions (`{"available",displays:[…]}`);
  offline → `available:false`, HTTP 200.
- `GET /api/xdisplay/health` → pod + TCP dial; `available:false`, never 5xx.
- `GET /api/xdisplay/ws?token=` → websockify-style upgrade: gorilla websocket ⇄
  `podIP:5900+N` binary proxy, 10s ping/pong, activity-driven idle deadline;
  token validated per upgrade (reconnectable until TTL/DELETE).
- `GET /api/exec/ws?…` → terminal: remotecommand WebSocket v5 executor with
  SPDY fallback; binary = data, text = JSON control (resize via a
  `terminalSizeQueue`); environment-validated names (`isK8sName`).

Long-lived-session rules: streams use `context.WithoutCancel` — the 15s request
budget never applies; deadlines are owned by one place (`installWSHandlers`)
and refreshed by pong handlers and data frames (a terminal must not die at
`start+idle`); a background **sweeper** (interval injectable) kills process
groups, removes xauth entries and frees/purges expired sessions and tokens; the
access log redacts `token=` values.

Deployment (`deploy/`): `kos-xserver` StatefulSet + Service (X ports
`6000+N`, VNC `5921..5930` = default pool `KOS_XDISPLAY_START`/`KOS_XDISPLAY_POOL`
+ headroom, tcp probes on the first VNC port), snapshot RBAC as
`ClusterRole`/`ClusterRoleBinding` for SA `kos-server` (pods get/list/watch,
`pods/exec` create, deployments patch — cookies travel via exec stdin, no
Secrets). X11-over-TCP inside the cluster is plaintext by design (single-user
posture, documented); the browser leg is always TLS via kos-server.

## 6. Testing

- `vitest` (`npm run test`): 158 tests in 9 files — 13 reducer tests (window
  add/remove/focus, z-order, minimize/restore, maximize, immutability, event
  bus), 29 cluster-client tests (URL/query construction for every read and write
  endpoint including the metrics ones, envelope unwrapping, error handling,
  offline fallback, and the 15s fetch-timeout abort), 25 cluster-stream tests
  (`/api/xdisplay` session open/release/list envelopes, the binary/text exec
  websocket protocol, RFB handle lifecycle incl. `rescale`, `StreamError`
  kinds), 6 `XDesktop` lifecycle tests (mount→session→release, retry, unmount,
  no-pod-target empty state), 4 Cluster Explorer session-wiring tests
  (`Open terminal` / annotation-gated `Open GUI app` ADD_WINDOW props), 7
  `appProps` tests (typed `kos.dev/x-app` command parsing), 32 Task Manager
  data tests (workload-tree building, owner resolution, metric roll-ups,
  group-by/sort/filter, series merging), 20 `DataTable` tests (sort, tree
  flatten/expand, heat cells, loading/error/empty states, row activation) and
  22 Task Manager hook tests (poll cadence per speed, pause-on-hidden, the
  no-overlap in-flight poll guard, series dedupe/cap, `localStorage` prefs;
  several via `it.each`).
- `playwright` (`npm run e2e`): 14 specs in 3 files — the 3 desktop-shell
  contract specs (taskbar pinned, start menu launches a window, close control)
  plus 7 Task Manager specs (launch on the Workloads page with the cluster
  hero, page navigation with workload-tree expansion, the offline
  empty-cluster message, the workload detail flyout with pod logs, the
  service/node detail flyouts, and the confirm-gated End task/Restart/Scale
  actions including the RBAC-forbidden dialog staying open with the error
  surfaced inline) and 4 X-Desktop offline-degradation specs (the no-pod-target
  empty states of Remote App and Terminal, the close of a degraded window
  keeping the window manager functional, and a pod GUI session degrading
  gracefully against an offline server and closing cleanly).
- Go tests (`cd server && go test ./...`): handler tests over a stub
  `ClusterClient`, offline `[]`-not-`null` assertions, read-path 400/404/500
  mapping, write-action parameter validation (400 for a missing
  namespace/pod/deployment/replicas and the 0/1000 replicas bounds), the
  `writeError` status map (401/403/404/409/503/500), the request-timeout budget
  (504) and kubelet-summary deadline math, `nodeStatus`/`nodeRoles` units, and
  a `client-go` fake-clientset test, plus the X-Desktop suite: display
  allocator allocate/free/idempotency, launch-script + cookie-stdin contract
  units, the expiry sweeper (kill + xauth-remove + release) over a fake
  executor, token redaction in the access log, `isK8sName` URL validation, and
  real-websocket loopback tests with a fake RFB TCP server (origin
  denial/allow, pong/data deadline refresh, terminal control-frame eviction,
  exec error-frame handshake).
- Gates: `tsc -b`, `eslint .`, `prettier --check .`, `vite build`,
  `go build ./...`, `go vet ./...`, `go test ./...`, `govulncheck ./...` and
  `npm audit` must all stay clean.

## 7. Decision table

| ID | Decision | Outcome |
|---|---|---|
| D1 | Vendored legacy Go tree | **Deleted.** The archived `github.com/kubernetes-client/go` is superseded by the maintained **`k8s.io/client-go`**, which the server depends on. |
| D2 | Cluster integration shape | **Go server + typed client (B).** `server/` serves JSON under `/api` via Vite's dev proxy; the app calls it through `HttpClusterClient`. |
| D3 | Build tooling | **Vite owns build/dev.** gulp, flow, babel-register, styleguidist and source-map-explorer are gone. |
| D4 | react-uwp replacement | **Local components + tokens.** Ten primitives in `src/components/ui/`; themes are `--kos-*` token overrides (windows default plus macos/gnome/kde overrides, switchable from the start menu). |
| D5 | Window resize | **Kept `react-rnd`** (10.x), driving drag/resize with the behaviour contract intact. |
| D6 | Scope | **Full code modernization**, delivered: TS + React 19 + Vite frontend, Go server, rewritten docs, and clean `npm audit` / `govulncheck` baselines. |
