# tasks.md — Task Manager 2.0 (Windows 11-style, Kubernetes-native)

> **Status:** COMPLETE (2026-10-16). Phases 0–5 shipped and Phase 6 (destructive
> actions) was approved and completed; see the per-phase status notes below.
> **Goal owner:** the build orchestrator. Each task below is scoped so a single
> subagent can complete it end-to-end, in parallel with the others, touching an
> agreed set of files.
>
> **Approved decisions (do not re-ask):** breadcrumbs are **dropped** (capability
> moves to detail flyouts); single cluster is **auto-selected**; default page is
> **Workloads**; update speed default is **Normal (2s poll / 15s data)**; Phase 6
> destructive actions were **approved during the milestone** and shipped; adding
> **`k8s.io/metrics`** to the server is approved; **new tests were originally
> deferred** (see §8), but the C2/D2 acceptance suites, the Phase 6 client/action
> tests and the metrics/action server tests all landed (**114** vitest /
> **10** Playwright).

---

## 1. Product goal

Rebuild the KuberneticOS **Task Manager** window app so it looks and feels like
the **Windows 11 Task Manager** (Fluent / WinUI, Mica-ish surfaces, rounded
corners, left navigation rail, per-page command bar, hero header, heat-mapped
resource columns, real-time performance graphs) while doing **Kubernetes**
things:

| Windows 11 page | KuberneticOS page | What it shows |
|---|---|---|
| Processes | **Workloads** | Expandable tree **Deployment → ReplicaSet → Pod** (+ ReplicationControllers + standalone pods), with live **CPU / Memory / Disk / Network** per row (children roll up into parents). |
| Performance | **Performance** | Cluster-combined **real-time charts** (CPU, Memory, Disk, Network) + per-node mini-graphs and detail tables. |
| Services | **Services** | Kubernetes **Services** (type, ClusterIP, ports, backing pods) + aggregated CPU/Mem. |
| Details | **Pods** | Flat, sortable table of every pod (namespace, node, phase, live CPU/Mem/Disk/Net). |
| Users | **Namespaces** | Namespace inventory with workload counts + aggregated resource usage. |
| App history / Startup apps | **Nodes** | Node inventory (status, roles, version, pods) + live node stats. |
| Settings | **Settings** | Default start page, update speed, namespace filter, density. |

The Windows-11 resemblance is intentional and must be preserved (per `agents.md`
rule 2: the desktop metaphor is the product).

---

## 2. Ground rules (must hold for every task)

1. **`fetch` lives only in `src/cluster/client.ts`** (agents.md rule 1). All
   window apps talk to the typed `ClusterClient`.
2. **No new runtime dependencies.** No chart library, no UI kit, no icon
   package. Charts are hand-built SVG. Icons are inline SVG in `Icon.tsx`.
   (`react-rnd` stays; vitest `include` narrowing in `vite.config.ts` stays.)
3. **TypeScript strict, no `any` at public boundaries**, function components and
   hooks only, relative typed imports (`import type { … }`).
4. **Styling uses the design tokens** (`--kos-*`). New semantic colours are
   derived from existing tokens with `color-mix(in srgb, var(--kos-accent) …)`
   so **no new tokens are needed** and all four themes (windows default,
   `theme-macos`, `theme-gnome`, `theme-kde`) stay coherent. If a genuinely new
   token is unavoidable it MUST be added to **all four** theme blocks.
5. **Degrade, never crash.** Missing metrics-server, missing kubelet permissions,
   or offline mode must render an explanatory empty-state, not an error wall.
6. **No `console.log`** for tracing (use a `DEBUG`-gated log if needed).
7. Run `npx prettier --write .` before finishing. Style: single quotes,
   semicolons, printWidth 100, trailing commas.
8. **Do not commit/push.** Leave changes in the working tree.

---

## 3. Visual / UX spec (the "design language")

This section is the single source of truth for the look. View tasks must match it.

### 3.1 Shell layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│  [☰]  Task Manager                                    ← window titlebar  │
├───────────────┬───────────────────────────────────────────────────────────┤
│  ▸ Workloads  │  ⟨command bar: ⟳ Refresh  ▤ Group by  ⇅ Speed  🔍 Search ⟩ │
│  ▸ Performance│ ┌───────────────────────────────────────────────────────┐ │
│  ▸ Services   │ │  HERO: kind-kind · v1.37.0 · 1 node      ◔ CPU 7%     │ │
│  ▸ Pods       │ │  ◔ Mem 62%   ◔ Disk 12%                               │ │
│  ▸ Namespaces │ └───────────────────────────────────────────────────────┘ │
│  ▸ Nodes      │ ┌───────────────────────────────────────────────────────┐ │
│               │ │  ▸ web            Running  ▓ 3%   ▓ 120 MB  ▓ ·  ▓ ·  │ │
│               │ │    ▸ web-7d9f…    Running  ▓ 3%   ▓ 120 MB  ▓ ·  ▓ ·  │ │
│               │ │        web-7d9…-2  Running ▓ 1%   ▓  40 MB  ▓ ·  ▓ ·  │ │
│  ─────────    │ └───────────────────────────────────────────────────────┘ │
│  ⚙ Settings   │                                                           │
└───────────────┴───────────────────────────────────────────────────────────┘
```

* **Left navigation rail** (mirrors Win11): icon + label rows, `⚙ Settings`
  pinned to the bottom, a `☰ hamburger` at the top to **collapse/expand** the
  rail (collapsed = icons only, ~48px; expanded ~200px). Active row uses the
  accent left-bar + subtle `--kos-hover` background. Keyboard: `↑/↓` move,
  `Enter` activate, `Ctrl+Tab` cycles pages.
* **Command bar** at the top of the content area, changes per page. Right-aligned
  actions; the search box is a Win11-style pill input.
* **Hero panel** on Workloads / Performance: cluster name, k8s version, node
  count, and three small radial gauges (CPU, Memory, Disk) using accent colours.
* **Fluent surface**: `--kos-window-bg` base, `--kos-window-radius` corners, 1px
  `--kos-border` hairlines, no harsh shadows inside the app.
* **Typography**: `--kos-font-family`; section labels 12px/600 uppercase with
  `letter-spacing:.4px` (existing `.kos-taskmanager__section-title` pattern);
  body 13px; big numbers 20–28px/600.

### 3.2 The workload tree table (Win11 "Processes" fidelity)

* Sticky header row; each **resource column header shows the live aggregate**
  (e.g. `CPU 12%`, `Memory 1.2 GB`, `Disk 4 MB/s`, `Network 220 KB/s`) — exactly
  like Win11 shows total utilisation above each column.
* Tree rows with `▸/▾` chevron, indent per depth (Deployment 0, ReplicaSet 1,
  Pod 2), and a leading type icon (deployment/rs/pod).
* **Heat-map tint**: the CPU/Memory/Disk/Network cells get a translucent
  background whose opacity scales with the value
  (`color-mix(in srgb, var(--kos-accent) N%, transparent)`), Win11-style.
* Columns: **Name · Status · CPU · Memory · Disk · Network**. Sortable by
  clicking a header; sort arrow icon. Row hover = `--kos-hover`; row selected =
  accent-tinted. Double-click / `Enter` opens the detail flyout.
* `Group by` menu switches the tree root: **Deployment** (default) · ReplicaSet ·
  Pod · Namespace · Node.
* Aggregate semantics: a parent's value = Σ of its descendant pods. Pods that
  have no matching ReplicaSet (orphans) appear under a synthetic
  **"Standalone pods"** root; ReplicaSets with no matching Deployment appear
  under **"Unowned ReplicaSets"**.

### 3.3 Range bar / status semantics

Map k8s state → Win11-ish status pill colours (all via accent/danger tokens):
`Running`/`Ready` = green-ish (derive from accent), `Pending` = amber,
`Failed`/`CrashLoopBackOff`/`NotReady` = red (`color-mix` with `#d13438`),
`Succeeded`/`Unknown` = muted grey. (Define a `--kos-tm-ok/warn/danger` set of
`color-mix` constants in `taskmanager.css`, not in `tokens.css`.)

### 3.4 Performance page

* Left mini-list of resources: **CPU · Memory · Disk · Network** (+ a **Nodes**
  section). Selecting one drives the big chart.
* Big chart: 60-sample rolling area chart, ~200px tall, with horizontal
  gridlines, a Y-axis (auto-scaled, with unit), an X-axis of relative time
  (`-5m … now`), a gradient fill, accent stroke, and a **hover crosshair +
  tooltip** showing the value and timestamp. Current value rendered large above
  the chart with its capacity/denominator.
* **CPU** also renders a responsive grid of **per-node mini sparklines**.
* **Memory** adds a **composition bar** (used vs total) and a "top consumers"
  list.
* **Disk** adds a per-node table (used / capacity / %), **Network** renders two
  series (↓ rx / ↑ tx) and a per-node table of rates.
* When metrics are unavailable → centred empty-state: *"Metrics unavailable —
  install metrics-server to see live data"* plus the one-line install hint.

---

## 4. Data model & metric sources

### 4.1 Where the numbers come from

| Metric | Source | Notes |
|---|---|---|
| Pod/Node **CPU**, **Memory** | `metrics.k8s.io/v1beta1` (metrics-server) | v0.9.0 is installed on the kind cluster and returning 200. 15s resolution. |
| Node **Disk**, **Network** | kubelet **Summary API** via apiserver proxy: `GET /api/v1/nodes/{node}/proxy/stats/summary` | Node `fs` + `network`. Best-effort (may be RBAC-denied). |
| Pod **Disk**, **Network** | same Summary API (`pods[].ephemeral-storage`, `pods[].network`) | Joined to pods by namespace/name/node. |
| Capacities | `Node.Status.Allocatable` (already fetched by `/api/nodes/detail`; also returned inline by the new metrics endpoint) | Used for % gauges. |

> **Metrics resolution reality:** metrics-server downsamples to **15s**. The UI
> must therefore **dedupe samples** — only append a new point to a series when
> the metrics payload actually changes (deep-compare of the last payload), so the
> chart shows genuine steps, not a staircase of repeated polls. Polling cadence
> is independent and configurable.

### 4.2 Frozen frontend contract (Phase 0 writes this; nobody else edits it)

Added to `src/cluster/client.ts`:

```ts
export interface ContainerMetrics {
  readonly name: string;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
}

export interface NodeMetrics {
  readonly name: string;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly cpuAllocatableMillis?: number;
  readonly memoryAllocatableBytes?: number;
  readonly diskUsedBytes?: number;
  readonly diskCapacityBytes?: number;
  readonly networkRxBytes?: number;
  readonly networkTxBytes?: number;
  readonly podCount?: number;
}

export interface PodMetrics {
  readonly name: string;
  readonly namespace: string;
  readonly node?: string;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly containers: readonly ContainerMetrics[];
  readonly diskUsedBytes?: number;
  readonly networkRxBytes?: number;
  readonly networkTxBytes?: number;
}

export interface NodeMetricsResult {
  readonly available: boolean;
  readonly nodes: readonly NodeMetrics[];
}

export interface PodMetricsResult {
  readonly available: boolean;
  readonly pods: readonly PodMetrics[];
}
```

`ClusterClient` gains:

```ts
getNodeMetrics(clusterId: string): Promise<NodeMetricsResult>;
getPodMetrics(clusterId: string, namespace?: string): Promise<PodMetricsResult>;
// Phase 6 write operations (added mid-milestone):
deletePod(clusterId: string, namespace: string, pod: string): Promise<void>;
restartDeployment(clusterId: string, namespace: string, deployment: string): Promise<void>;
scaleDeployment(
  clusterId: string,
  namespace: string,
  deployment: string,
  replicas: number,
): Promise<void>;
```

Also extend existing types (backward-compatible optional fields, needed for the
tree):

```ts
export interface PodInfo {
  name: string; namespace: string; node?: string; phase: string;
  ownerKind?: string;   // 'ReplicaSet' | 'ReplicationController' | 'StatefulSet' | …
  ownerName?: string;
}
export interface ReplicaSetInfo {
  name: string; namespace: string; replicas: ReplicaCounts;
  ownerKind?: string;   // 'Deployment' | …
  ownerName?: string;
}
```

* `OfflineClusterClient` returns `{ available: false, nodes: [] }` /
  `{ available: false, pods: [] }`.
* `HttpClusterClient` calls `GET /api/metrics/nodes` and
  `GET /api/metrics/pods?namespace=…` (namespace omitted when empty), via the
  existing `requestJson` helper. **No other file gains a `fetch`.**

### 4.3 Frozen server contract (Phase 0 writes this)

`server/main.go` additions (JSON tags exact):

```go
type NodeMetrics struct {
  Name                  string `json:"name"`
  CPUMillis             int64  `json:"cpuMillis"`
  MemoryBytes           int64  `json:"memoryBytes"`
  CPUAllocatableMillis  int64  `json:"cpuAllocatableMillis,omitempty"`
  MemoryAllocatableBytes int64 `json:"memoryAllocatableBytes,omitempty"`
  DiskUsedBytes         int64  `json:"diskUsedBytes,omitempty"`
  DiskCapacityBytes     int64  `json:"diskCapacityBytes,omitempty"`
  NetworkRxBytes        int64  `json:"networkRxBytes,omitempty"`
  NetworkTxBytes        int64  `json:"networkTxBytes,omitempty"`
  PodCount              int32  `json:"podCount,omitempty"`
}

type ContainerMetrics struct {
  Name        string `json:"name"`
  CPUMillis   int64  `json:"cpuMillis"`
  MemoryBytes int64  `json:"memoryBytes"`
}

type PodMetrics struct {
  Name          string             `json:"name"`
  Namespace     string             `json:"namespace"`
  Node          string             `json:"node,omitempty"`
  CPUMillis     int64              `json:"cpuMillis"`
  MemoryBytes   int64              `json:"memoryBytes"`
  Containers    []ContainerMetrics `json:"containers"`
  DiskUsedBytes int64              `json:"diskUsedBytes,omitempty"`
  NetworkRxBytes int64             `json:"networkRxBytes,omitempty"`
  NetworkTxBytes int64             `json:"networkTxBytes,omitempty"`
}

type NodeMetricsResult struct { Available bool; Nodes []NodeMetrics }
type PodMetricsResult  struct { Available bool; Pods  []PodMetrics }
```

* `ClusterClient` (Go) gains
  `GetNodeMetrics(ctx, clusterID) (NodeMetricsResult, error)` and
  `GetPodMetrics(ctx, clusterID, namespace string) (PodMetricsResult, error)`.
* `offlineClient` returns `Available:false` + non-nil empty slices.
* Responses: `nodeMetricsResponse{source,available,nodes}`,
  `podMetricsResponse{source,available,pods}`.
* Routes (Go 1.22 patterns): `GET /api/metrics/nodes`, `GET /api/metrics/pods`
  (`namespace` query optional).
* `Pod` and `ReplicaSet` structs gain `OwnerKind`/`OwnerName`
  (`json:"ownerKind,omitempty"` / `json:"ownerName,omitempty"`) sourced from
  `ObjectMeta.OwnerReferences[0]`.
* `go.mod` gains `k8s.io/metrics v0.37.1` (matches the other k8s libs).
* **Phase 6 additions:** `ClusterClient` (Go) also gains
  `DeletePod(ctx, clusterID, namespace, pod)`,
  `RestartDeployment(ctx, clusterID, namespace, deployment)` and
  `ScaleDeployment(ctx, clusterID, namespace, deployment, replicas int32)`;
  routes `DELETE /api/pods`, `POST /api/deployments/restart`,
  `POST /api/deployments/scale`; `actionResponse{source,ok,message}`;
  `writeError` maps `errOffline→503`, `NotFound→404`, `Forbidden→403`,
  `Unauthorized→401`, `Conflict→409`, `Invalid/BadRequest→400`, else `500`;
  `withCORS` allows `GET, POST, DELETE, OPTIONS`; scale `replicas` is bounded to
  `[0,1000]`.

---

## 5. File map (ownership — one writer per file)

| File | Purpose | Owner task |
|---|---|---|
| `src/cluster/client.ts` | +metrics types, methods, PodInfo/ReplicaSetInfo owner fields, write actions | **P0-A** / **OPT-1** |
| `src/cluster/client.test.ts` | +tests for new methods | P0-A / OPT-1 |
| `src/components/ui/Icon.tsx` | +new icons (union + `ICONS`) | **P0-B** |
| `server/main.go` | +metrics structs/iface/routes/handlers + owner fields | **P0-C** / **S1** |
| `server/main_test.go` | +metrics handler tests | **S1** |
| `server/go.mod`, `server/go.sum` | +`k8s.io/metrics` | **S1** |
| `src/window-apps/taskmanagerTypes.ts` | shared types: nav pages, tree nodes, series | **P0-D** |
| `src/window-apps/taskmanagerFormat.ts` | pure formatters (cpu/bytes/rate/percent) | **P0-D** |
| `src/window-apps/taskmanagerData.ts` | pure tree-building / metric-join / group-by | **D1** |
| `src/window-apps/taskmanagerData.test.ts` | unit tests for the above | **D1** |
| `src/window-apps/taskmanagerHooks.ts` | `usePolledMetrics`, `useSeriesBuffer`, `useLocalPref` | **D2** |
| `src/window-apps/taskmanagerHooks.test.ts` | unit tests: poll cadence, pause-on-hidden, dedupe/cap, prefs | **D2** |
| `src/window-apps/taskmanagerCharts.tsx` | `Sparkline`, `PerformanceChart`, `CompositionBar`, `Gauge` | **C1** |
| `src/window-apps/taskmanagerTable.tsx` | `DataTable` (sortable, sticky, heat cells, tree support) | **C2** |
| `src/window-apps/taskmanagerTable.test.tsx` | unit tests: sort, tree flatten/expand, heat, states | **C2** |
| `src/window-apps/taskmanagerCommandBar.tsx` | command bar + menus + search + speed/group-by | **C2** |
| `src/window-apps/taskmanagerViews.tsx` | re-export barrel for the 6 page views | **P0-E** |
| `src/window-apps/taskmanagerProcesses.tsx` | Workloads page | **V1** |
| `src/window-apps/taskmanagerPerformance.tsx` | Performance page | **V2** |
| `src/window-apps/taskmanagerServices.tsx` | Services page | **V3** |
| `src/window-apps/taskmanagerInventory.tsx` | Pods / Namespaces / Nodes / Settings pages | **V4** |
| `src/window-apps/taskmanagerFlyout.tsx` | `DetailFlyout` / `FlyoutSection` / `KeyValueList` / `PodLogsPanel` | **V1–V4** |
| `src/window-apps/taskmanagerActions.tsx`, `taskmanagerActions.css` | confirm-gated End task / Restart / Scale actions + `ConfirmDialog` | **OPT-1** |
| `src/window-apps/TaskManager.tsx` | rewritten shell: rail + router + hero | **G1** |
| `src/window-apps/taskmanager.css` | shell/nav/hero/command-bar/layout | **G1** |
| `src/window-apps/taskmanagerTable.css` | table + tree + heat + pills | **C2** |
| `src/window-apps/taskmanagerCharts.css` | charts + gauges + legible axis | **C1** |
| `src/window-apps/taskmanagerViews.css` | page-specific bits + flyouts | **V1–V4** |
| `e2e/taskmanager.spec.ts` | rewrite for the new UI (+ new endpoints in the mock) | **T1** |
| `README.md`, `spec.md` | document the new Task Manager | **DOC** |

> To keep "one writer per file" while splitting the views across four tasks,
> `taskmanagerViews.tsx` is created in **Phase 0 as a stub module** exporting all
> view components, and each view task owns **one named export block** inside it.
> Practical alternative that avoids same-file edits across parallel agents: each
> view ships its own file (`taskmanagerProcesses.tsx`, `taskmanagerPerformance.tsx`,
> `taskmanagerServices.tsx`, `taskmanagerInventory.tsx`) and the stub
> `taskmanagerViews.tsx` becomes a re-export barrel that P0 creates and no one
> edits again. **Preferred: separate files + barrel.** The table above therefore
> resolves to: `taskmanagerProcesses.tsx` (**V1**), `taskmanagerPerformance.tsx`
> (**V2**), `taskmanagerServices.tsx` (**V3**), `taskmanagerInventory.tsx`
> (**V4** — Pods/Namespaces/Nodes/Settings), plus the P0 barrel.

---

## 6. Phases & tasks

### Phase 0 — Contracts (SEQUENTIAL, blocks everything)

These tasks define the frozen interfaces and create compiling stubs so the app
builds after every merge. **No other task may start before Phase 0 lands.**

> **STATUS: COMPLETE** (2026-10-15). P0-A..P0-E landed; `tsc -b`, `npm run build`
> and `go build`/`go vet` green; prettier/eslint clean. The frozen §4.2/§4.3
> contracts are now authoritative for every later phase.

#### P0-A · Frontend contract — `src/cluster/client.ts`
* Add the §4.2 types, `ClusterClient` methods, `OfflineClusterClient` and
  `HttpClusterClient` implementations, and the `PodInfo`/`ReplicaSetInfo` owner
  fields.
* Extend `src/cluster/client.test.ts` with: offline returns `available:false`;
  HTTP builds `/api/metrics/nodes` and `/api/metrics/pods?namespace=x`.
* **Acceptance:** `npx tsc -b` clean; `npm run test` green.

#### P0-B · Icons — `src/components/ui/Icon.tsx`
Add to **both** the `KosIconName` union and the `ICONS` record (24×24,
`fill: currentColor`, matching existing style):
`menu`, `chevron-down`, `chevron-up`, `graph`, `memory`, `disk`, `network`,
`plug`, `layers`, `list`, `refresh`, `pause`, `play`, `sort-asc`, `sort-desc`,
`cpu`, `gauge`, `container`, `deployment`, `replicaset`, `pod`, `x-circle`.
* **Acceptance:** `npx tsc -b` clean; icons render (spot-check in TestWindow).

#### P0-C · Server contract stub — `server/main.go`
* Add §4.3 structs, interface methods, `offlineClient` impl, routes, handlers
  returning `available:false`/empty, and the `OwnerKind`/`OwnerName` fields on
  `Pod`/`ReplicaSet`.
* **Acceptance:** `cd server && go build ./... && go vet ./... && go test ./...`
  green (existing tests still pass).

#### P0-D · Shared types & formatters
* `taskmanagerTypes.ts`: `TaskManagerPage` union
  (`'workloads'|'performance'|'services'|'pods'|'namespaces'|'nodes'|'settings'`),
  `WorkloadNode`/`WorkloadKind`, `SeriesSample`, `MetricSeries`,
  `UpdateSpeed`, `GroupBy`, `NamespaceFilter`.
* `taskmanagerFormat.ts`: `formatCpu(millis)`, `formatBytes(bytes)`,
  `formatRate(bytesPerSec)`, `formatPercent(v)`, `formatCapacity`.
* **Acceptance:** `npx tsc -b` clean; unit tests for formatters.

#### P0-E · Stub modules (compiling skeletons)
Create each file from §5 with a **minimal but valid** placeholder (e.g. a
component returning `<div class="kos-tm-view">…</div>`), exporting the exact
names that later tasks implement, plus the `taskmanagerViews.tsx` re-export
barrel. This is what lets G1 wire the whole app before the views exist.
* **Acceptance:** `npx tsc -b && npm run build` clean; opening Task Manager
  shows the new shell with placeholder pages.

---

### Phase 1 — Server metrics implementation (parallel with Phase 2+)

> **STATUS: COMPLETE** (2026-10-16). S1 landed: `k8s.io/metrics v0.37.1` added
> (direct); `GetNodeMetrics`/`GetPodMetrics` implemented on `liveClient` with the
> availability fallback (`available:false`, HTTP 200, never 500) and best-effort
> Summary API disk/network; `gofmt`/`go build`/`go vet` green. The **live kind
> smoke test passed**: `go run .` + `GET /api/health` →
> `{"source":"live"}`, `/api/metrics/nodes` → `available:true` with
> `kind-control-plane` cpu≈76m / mem≈936 MiB (capacity 4000m / 31 GiB, disk
> 502 GiB ≈ 12 %, podCount 10), and `/api/metrics/pods` → 10 pods with CPU/mem
> plus per-container and Summary-API disk/network figures. The `DELETE`/`POST`
> error paths were also exercised live (`400` missing param, `404` unknown pod,
> `400` invalid/missing replicas, `204` CORS preflight).

#### S1 · Implement metrics in the Go server — owner of `server/main.go` + tests
* Add `k8s.io/metrics v0.37.1` (`go get`), build a
  `metricsv1beta1.NewForConfig` client inside `buildClient`/`liveClient`.
* `GetNodeMetrics`: list `NodeMetricses()` → cpu `MilliValue()`, memory
  `Value()`; join `Node.Status.Allocatable` for capacity; iterate nodes and call
  the **Summary API** for disk/network (best-effort, ignore errors); set
  `PodCount` from the pod lister.
* `GetPodMetrics(namespace)`: list `PodMetricses(ns)` → per-pod + per-container
  cpu/mem; join Summary API `pods[]` for disk/network by ns/name/node; set
  `Node`.
* Populate `OwnerKind`/`OwnerName` on pods & replicasets from `OwnerReferences`.
* **Availability rule:** if the metrics API is not registered / errors with
  NotFound/ServiceUnavailable → `available:false`, empty slice, HTTP 200 (never
  500). Offline → `available:false`.
* Extend `server/main_test.go` with a `stubClient` covering the two new methods
  and handler tests (200 shape, offline availability).
* **Acceptance:** `go build/vet/test ./...` green; against the live kind cluster
  `curl localhost:8700/api/metrics/nodes` returns `available:true` with
  `kind-control-plane` cpu≈74m/mem≈1.0GiB; `/api/metrics/pods` returns ~10 pods.
* **Notes:** CPU `MilliValue()` on `73583878n` → `73`. Memory `Value()` on
  `1054204Ki` → bytes. Summary API needs `nodes/proxy` — the admin kubeconfig has
  it; call it via `clientset.CoreV1().RESTClient()`.

---

### Phase 2 — Frontend primitives (parallel with Phase 1 & each other)

> **STATUS: COMPLETE** (2026-10-16). C1, C2, D1, D2 landed; `tsc -b` and
> `npm run build` green; D1 ships 32 vitest cases covering tree building,
> roll-up, grouping, sort, filter and dedupe. The `DataTable` CSS follow-up
> landed in commit `1b808cd` (sticky sortable header, hover/active rows, heat
> cells, tree toggles, loading/error/empty states, all on existing `--kos-*`
> tokens). The previously deferred C2 and D2 acceptance tests are now written
> (`taskmanagerTable.test.tsx`, `taskmanagerHooks.test.ts`).

#### C1 · Charts — `taskmanagerCharts.tsx` + `taskmanagerCharts.css`
* `<Sparkline values height stroke />` — tiny SVG polyline for table cells and
  node grids.
* `<PerformanceChart series capacity unit height onHover />` — area chart:
  responsive via `ResizeObserver`, gridlines, Y labels, relative-time X labels,
  gradient fill, accent stroke, hover crosshair + tooltip, multi-series support
  (network ↓/↑). Pure SVG, no deps.
* `<CompositionBar used total />`, `<Gauge value max label />` (radial).
* **Acceptance:** renders with mock data in TestWindow; no layout thrash; axis
  text legible in all four themes; `tsc` clean.

#### C2 · Table + command bar — `taskmanagerTable.tsx`, `taskmanagerCommandBar.tsx`, `taskmanagerTable.css`
* `<DataTable columns rows sort onSort tree heat />` — sticky header with
  aggregate per column, sortable headers (`sort-asc/-desc` icons), tree indentation
  + expand/collapse, heat-map cell tint via `color-mix`, status pill, row hover/
  select, keyboard nav (↑/↓/Enter/Space/←/→ to collapse/expand), empty/loading/
  error states.
* `<CommandBar>{left}{right}</CommandBar>` + `<SearchBox/>`, `<SpeedMenu/>`
  (Paused/Low 5s/Normal 2s/High 1s), `<GroupByMenu/>`.
* **Acceptance:** DataTable unit-tested for sort + tree flatten; `tsc` clean.

#### D1 · Pure data logic — `taskmanagerData.ts` + tests
* `buildWorkloadTree(deployments, replicaSets, controllers, pods)` →
  `WorkloadNode[]` with `children`, using `ownerName` when present and the
  `name-minus-last-dash-hash` convention as fallback for Deployment→RS.
* `groupBy(nodes, mode)` for Deployment/ReplicaSet/Pod/Namespace/Node.
* `indexPodMetrics(podMetrics)` and `rollupMetrics(node)` (Σ descendants).
* `sortNodes(nodes, key, dir)`; `filterNodes(nodes, query)`.
* `mergeSeries(prev, payload)` — append a point only when the payload changed
  (the 15s-dedupe rule).
* **Acceptance:** comprehensive unit tests (vitest) for tree building incl.
  orphans, roll-up, grouping, sort, filter, dedupe.

#### D2 · Hooks — `taskmanagerHooks.ts`
* `usePolledMetrics(intervalMs, namespace)` → `{ nodes, pods, available, error,
  lastUpdated, refresh }` polling `getNodeMetrics` + `getPodMetrics`
  (`Promise.all`), pausing when the window is blurred (`document.hidden`).
* `useSeriesBuffer(sample, capacity=60)` → `number[]` with the dedupe rule.
* `useLocalPref<T>(key, initial)` — `localStorage`-backed preference
  (`crypto.randomUUID()` not needed here).
* **Acceptance:** unit tests with fake timers for poll cadence + pause-on-hidden.

---

### Phase 3 — Views (parallel; all depend on Phase 0 + C1/C2/D1/D2 interfaces)

> **STATUS: COMPLETE** (2026-10-15). V1–V4 compile and render their pages under
> strict TS (`tsc -b`/`npm run build` green). The detail flyouts are now
> implemented: workload children + pod logs, service ports/selector/backing
> pods, pod labels + logs, and node detail reuse.

#### V1 · Workloads page — `taskmanagerProcesses.tsx` (+ `taskmanagerViews.css` section)
* Hero (cluster identity + CPU/Mem/Disk gauges), DataTable tree from
  `buildWorkloadTree` + `groupBy`, live columns with aggregates in the header and
  heat-mapped cells, expand/collapse-all, namespace filter, search.
* Row activation opens the **Workload detail flyout** (right panel): summary,
  children list, and (for pods) reuse of the existing **Logs** view.
* **Acceptance:** e2e-visible selectors; matches §3.2/§3.3; keyboard accessible.

#### V2 · Performance page — `taskmanagerPerformance.tsx`
* Resource mini-list (CPU/Memory/Disk/Network/Nodes) driving the big
  `PerformanceChart` fed by `useSeriesBuffer`; CPU per-node sparkline grid;
  Memory composition bar + top consumers; Disk/Network per-node tables;
  unavailable empty-state.
* **Acceptance:** chart advances as samples change; tooltip works; degrades.

#### V3 · Services page — `taskmanagerServices.tsx`
* Services DataTable (name/ns/type/ClusterIP/ports/backing-pods count) + aggregated
  CPU/Mem from backing pods; row → **Service detail flyout** (ports table,
  selector, backing pods list).
* **Acceptance:** renders live kind data; sorting/filtering.

#### V4 · Inventory pages — `taskmanagerInventory.tsx`
* **Pods** (flat Details-style sortable table incl. owner, node, phase, live
  metrics), **Namespaces** (counts + aggregates), **Nodes** (status/roles/version
  + live stats + sparklines; row → existing `NodeDetailView` reuse), and
  **Settings** (default start page, update speed, namespace filter, row density).
* **Acceptance:** all four pages render; settings persist via `useLocalPref`.

---

### Phase 4 — Shell & integration

> **STATUS: COMPLETE** (2026-10-15). G1 landed: collapsible rail (Settings pinned
> bottom, ArrowUp/Down + Ctrl+Tab nav), page router over `TaskManagerPage`,
> per-page command-bar host, hero host, cluster auto-select, and the offline
> empty-state message. `tsc -b`/`npm run build`/prettier/eslint green. The
> `usePolledMetrics` decision is documented in the file (each page polls its own
> data; the shell polls only inside `<Hero>`).

#### G1 · Rewrite the shell — `TaskManager.tsx` + `taskmanager.css`
* Left rail (collapsible, keyboard nav, Settings pinned bottom), page router over
  `TaskManagerPage`, per-page command bar host, hero host, cluster auto-select
  (preserve the existing "auto-select the single cluster" behaviour), and the
  offline/empty-cluster message ("No clusters configured — start the Go server").
* Keep `export default TaskManager` and the named `TaskManager` export so
  `registry.ts` is untouched (`id:'TaskManager'`, `title:'Task Manager'`,
  `icon:'activity'`).
* `usePolledMetrics` lives here and is passed to pages (single poll loop), unless
  a page needs its own — decide once, document in code.
* **Acceptance:** whole app runs; `npm run build` clean; no console errors; rail
  collapse persists (optional).

---

### Phase 5 — Tests & docs

> **STATUS: COMPLETE** (2026-10-15). T1 rewrote `e2e/taskmanager.spec.ts` for the
> new shell (extended `mockClusterApi` with `/api/metrics/nodes` +
> `/api/metrics/pods`, owner fields and an offline mode; now 5 specs) and DOC updated
> `README.md`, `spec.md` and `server/README.md` (pages, metrics endpoints,
> metrics-server dependency, 15s resolution caveat, detail flyouts). `npx
> playwright test` → 8 passed (3 desktop + 5 Task Manager); vitest 64 passed;
> `tsc -b`, `npm run build`, prettier and eslint clean.
> **Deviations:** the detail flyouts landed, so the spec now asserts pod logs
> (workload and inventory), service detail and node detail; T1 also required a
> small DataTable fix (`taskmanagerTable.tsx` never recursed into `children`, so
> the workload tree could not expand).

#### T1 · e2e — `e2e/taskmanager.spec.ts`
* Extend `mockClusterApi` to also stub `/api/metrics/nodes` and
  `/api/metrics/pods` (with a couple of samples) and the owner fields on
  pods/replicasets.
* Rewrite the 3 specs for the new UI: (1) launch shows `Task Manager` + the
  Workloads page + hero; (2) navigation across pages (Workloads/Performance/
  Services/Pods) + expand a workload tree node + open a pod's logs; (3) offline
  shows the empty-state.
* Keep the desktop behaviour untouched (`e2e/desktop.spec.ts`).
* **Acceptance:** `npx playwright test` green (needs `npx playwright install
  chromium` once).

#### DOC · Update `README.md` + `spec.md`
* Document the new Task Manager pages, the metrics endpoints, the
  metrics-server dependency, and the 15s resolution caveat.

---

### Phase 6 — Destructive actions (APPROVED mid-milestone)

> **STATUS: COMPLETE** (2026-10-16). The user signed off on Phase 6, so OPT-1
> shipped: `DELETE /api/pods`, `POST /api/deployments/restart` and
> `POST /api/deployments/scale` on the server with a `writeError` status mapping
> (`400/401/403/404/409/503/500`), `withCORS` extended to
> `GET, POST, DELETE, OPTIONS`, and the matching `deletePod`/`restartDeployment`/
> `scaleDeployment` methods on `ClusterClient`. The UI adds a confirm-gated
> actions bar (`taskmanagerActions.tsx`) to the workload and pod detail flyouts,
> surfaces RBAC errors inline, and refreshes the row on success. Covered by
> `client.test.ts`, `server/main_test.go` and two extra Playwright specs. All
> gates green (tsc, build, eslint, prettier, vitest 114, go build/vet/test/gofmt,
> playwright 10).

#### OPT-1 · Destructive/k8s actions
* "End task" → delete pod; "Restart" → rollout-restart deployment; "Scale".
* Requires: new server routes (`DELETE /api/pods`, `POST /api/deployments/…`),
  **extending `withCORS` to allow `DELETE,POST`**, a confirmation dialog, and
  RBAC awareness. Ship behind an explicit confirm and clear warnings.

---

## 7. Parallelisation matrix

```
Phase 0 (P0-A..P0-E)  ──►  everything below may run in parallel
      │
      ├── S1  (Go server + tests)
      ├── C1  (charts)
      ├── C2  (table + command bar)
      ├── D1  (data logic + tests)
      ├── D2  (hooks + tests)
      │
      └──► after Phase 0 and the C1/C2/D1/D2 interfaces exist:
             ├── V1  Workloads      ┐
             ├── V2  Performance    │  parallel, disjoint files
             ├── V3  Services       │
             ├── V4  Inventory      ┘
             └──► then G1 (shell) can be developed in parallel using P0-E stubs
                   and integrated once views land.
                   Then T1 + DOC.
```

Rules to keep parallelism safe:
* **Own exactly one file per task.** Never edit another task's file. If a shared
  change is needed, land it in Phase 0 or raise it as a new P0 task.
* Every task must keep `npx tsc -b` (and `go build ./...` for Go) green on its
  own so merges never conflict semantically.
* Use **LF needles** with Serena's text tools on this Windows box.

---

## 8. Verification gates (run before declaring done)

```
npx tsc -b                                   # types
npm run lint                                 # eslint (2 accepted react-refresh warnings)
npm run format:check                         # prettier
npm run build                                # vite production build
npm run test                                 # vitest (reducer + client + new unit tests)
npm run e2e                                  # playwright (desktop + taskmanager)
cd server && go build ./... && go vet ./... && go test ./... && gofmt -l .   # Go
govulncheck ./...                            # from server/ (keep clean)
npm audit                                    # no new advisories
```

Plus a **live smoke test** against the running kind cluster:
`curl localhost:8700/api/metrics/nodes` and `/api/metrics/pods` return
`available:true`, and the UI shows non-zero CPU/Mem.

> **Tests originally deferred, then shipped (approved):** originally the
> mandatory gates were only `npx tsc -b`, `npm run build`, and `go build`/
> `go vet`. In the end more landed: `npm run test` (**114** vitest across 5
> files — the C2 `DataTable` and D2 hook suites plus the Phase 6 client/action
> tests landed after the deferral), `npm run e2e` (10 Playwright), `go test` and
> `gofmt -l` are all **green** as of 2026-10-16. `govulncheck`/`npm audit` were
> **not** run in this environment; the **live kind smoke test was run and
> passed** — `/api/health` → `{"source":"live"}`, `/api/metrics/nodes` →
> `available:true` (`kind-control-plane` cpu≈76m / mem≈936 MiB) and
> `/api/metrics/pods` → 10 pods.

> **Final gate run (2026-10-16):** `tsc -b` ✅ · `npm run build` ✅ · `eslint` ✅
> (2 accepted warnings) · `prettier --check` ✅ · `vitest` 114/114 ✅ · `go
> build`/`vet`/`test` ✅ · `gofmt -l` empty ✅ · `playwright` 10/10 ✅.
>
> **Post-review hardening (2026-10-16):** an independent review of the Phase 6
> work drove three fixes. (1) The Workloads **heat-map tint was inert**:
> `DataTable` read the heat value from the column `key` while `WorkloadNode`
> exposes `cpuMillis`/`memoryBytes`/`diskUsedBytes`/`networkRx|TxBytes`, so the
> cells were never tinted and `heatValue/100` assumed a 0–100 percentage. Fixed
> by adding a `heatValue` accessor to `DataTableColumn`, a `normalizeHeat` helper,
> tree-wide per-column maxima (`heatMaxima`) and hoisting the pod-metric index out
> of the recursive tree walk (also removes an O(pods×metrics) rebuild). (2) The
> confirm dialog gained a **double-submit latch** plus a **Tab focus trap and
> focus restore** (`taskmanagerActions.tsx`); its CSS moved off the view-owned
> class and onto `--kos-*` tokens. (3) Eight server error-path/edge subtests were
> added (`replicas` `0`/`1000`/`1001`, missing `namespace`/`pod`/`deployment`)
> with exact-message assertions. The `DataTable` tree toggle was also fixed to
> render only on rows with non-empty `children`. The net vitest count is **114**.
> One item is left **open for a product decision**: `withCORS` still sends
> `Access-Control-Allow-Origin: *`, which now fronts the destructive write
> endpoints (simple `fetch` POST/DELETE are not preflighted), so the origin
> should be restricted or a custom header required.

---

## 9. Non-goals

* No GPU/NPU/power columns (metrics-server does not expose them) — omit rather
  than fake.
* No server-side metric history / no database; all time-series live in React
  memory (60 samples).
* No new npm/go runtime dependencies beyond `k8s.io/metrics`.
* No changes to the desktop shell (taskbar, window manager, start menu, context
  menu) — only the Task Manager window app.
* Destructive cluster actions are limited to End task (delete pod), Restart and
  Scale (deployment) — no create/edit, no node actions. (Phase 6 was approved
  mid-milestone and shipped; see §6 Phase 6.)
* No breadcrumbs in the primary chrome (dropped by decision); the old drill-down
  capability survives only as detail flyouts.
* Test work was originally deferred, then shipped: the C2/D2 acceptance suites,
  the Phase 6 client/action tests and the metrics/action server tests all landed
  (see §8).

---

## 10. Definition of done

1. Task Manager opens as a Win11-styled dashboard: collapsible left rail
   (Workloads · Performance · Services · Pods · Namespaces · Nodes · Settings),
   per-page command bar, hero on Workloads/Performance.
2. Workloads shows the expandable **Deployment → ReplicaSet → Pod** tree with
   live, heat-mapped CPU/Memory/Disk/Network and per-column aggregates.
3. Performance shows cluster-combined real-time charts for CPU/Memory/Disk/
   Network with per-node breakdown, degrading gracefully without metrics.
4. Services, Pods, Namespaces, Nodes, Settings pages all render live data.
5. `available:false` empty-states appear when metrics-server is absent; nothing
   crashes offline.
6. Pod and deployment flyouts offer End task / Restart / Scale behind a confirm
   dialog, and RBAC/API failures surface inline without closing the dialog.
7. All gates in §8 pass; `spec.md`/`README.md`/`server/README.md` updated; every
   task's file ownership respected.

---

## 11. Decisions (RESOLVED — do not re-ask)

1. **Drill-down + breadcrumbs** → breadcrumbs **dropped**. Keep the capability
   only via detail flyouts (pod → logs; node → node detail; service → service
   detail; workload → children).
2. **Cluster handling** → **auto-select the single cluster** (preserve existing
   behaviour). Multi-cluster picker is out of scope.
3. **Default start page** → **Workloads**.
4. **Update speed default** → **Normal (2s poll / 15s data)**.
5. **Phase 6 destructive actions** → **approved mid-milestone and shipped**:
   End task / Restart / Scale behind confirm dialogs with RBAC error surfacing.
6. **`k8s.io/metrics`** on the server → **approved** (pin `v0.37.1` to match the
   other k8s libs).
7. **Tests** → **originally deferred, then shipped**: the C2/D2 suites, the
   Phase 6 client/action tests and the Go action tests landed (114 vitest / 10
   Playwright; see §8). Mandatory gates remain `tsc -b`, `npm run build`,
   `go build`, `go vet`.
