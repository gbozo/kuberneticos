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
│  Window apps ── registry: TestWindow, ClusterExplorer,   │
│                  TaskManager                             │
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
- **Window apps** (`src/window-apps/`): `TestWindow`, `ClusterExplorer` and
  `TaskManager`, registered in `registry.ts`. Cluster Explorer lists clusters;
  Task Manager drills down from a cluster to node detail and from a namespace to
  its deployments / replica sets / replication controllers / services / pods and
  pod logs. Both show *"No clusters configured — start the Go server"* when the
  API returns none.

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
}
```

- `ClusterInfo { id, name, server }`, `NamespaceInfo { name, status }`,
  `NodeInfo { name, status, roles, version? }`, `NodeDetailInfo { name, status,
  roles, version, capacity, allocatable, conditions, addresses }`,
  `PodInfo { name, namespace, node?, phase }`, plus `DeploymentInfo`,
  `ReplicaSetInfo`, `ReplicationControllerInfo` (each with a
  `ReplicaCounts { desired, ready, available, updated }`) and
  `ServiceInfo { name, namespace, type, clusterIP, ports }`.
- `HttpClusterClient` (the default) talks to `/api` and unwraps the server's
  `{ source, … }` envelopes.
- `OfflineClusterClient` returns empty lists, an empty-safe `NodeDetailInfo`
  and empty log text — the fallback that keeps the app usable with no server.

The Go server (`server/main.go`) uses the standard library `net/http` and
`k8s.io/client-go` v0.37.1:

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

Kubeconfig resolution order is `KUBERNETICOS_KUBECONFIG` → `KUBECONFIG` →
in-cluster → `$HOME/.kube/config`. If none is usable the server must still
start and answer `"source":"offline"` with empty lists — it must never crash.
CORS is open (`*`) and `OPTIONS` returns 204. `/api/nodes/detail` requires
`name` (400 without it); a missing node or pod returns 404. Pod logs default to
`tailLines=200`, clamped to 1–5000.

## 6. Testing

- `vitest` (`npm run test`): 13 reducer tests (window add/remove/focus,
  z-order, minimize/restore, maximize, immutability) + 19 cluster-client tests
  (URL/query construction for every endpoint, envelope unwrapping, error
  handling, offline fallback).
- `playwright` (`npm run e2e`): 6 specs — the 3 desktop-shell contract specs
  (taskbar pinned, start menu launches a window, close control) plus 3 Task
  Manager specs (launch/title, an API-mocked cluster→namespace→pod-log
  drill-down, and the offline empty-cluster message).
- Go tests (`cd server && go test ./...`): handler tests over a stub
  `ClusterClient`, offline `[]`-not-`null` assertions, 400/404/500 mapping,
  `nodeStatus`/`nodeRoles` units, and a `client-go` fake-clientset test.
- Gates: `tsc -b`, `eslint .`, `prettier --check .`, `vite build`,
  `go build ./...`, `go vet ./...`, `go test ./...`, `govulncheck ./...` and
  `npm audit` must all stay clean.

## 7. Decision table

| ID | Decision | Outcome |
|---|---|---|
| D1 | Vendored legacy Go tree | **Deleted.** The archived `github.com/kubernetes-client/go` is superseded by the maintained **`k8s.io/client-go`**, which the server depends on. |
| D2 | Cluster integration shape | **Go server + typed client (B).** `server/` serves JSON under `/api` via Vite's dev proxy; the app calls it through `HttpClusterClient`. |
| D3 | Build tooling | **Vite owns build/dev.** gulp, flow, babel-register, styleguidist and source-map-explorer are gone. |
| D4 | react-uwp replacement | **Local components + tokens.** Ten primitives in `src/components/ui/`; themes are `--kos-*` token overrides (windows default, macos/gnome/kde stubs). |
| D5 | Window resize | **Kept `react-rnd`** (10.x), driving drag/resize with the behaviour contract intact. |
| D6 | Scope | **Full code modernization**, delivered: TS + React 19 + Vite frontend, Go server, rewritten docs, and clean `npm audit` / `govulncheck` baselines. |
