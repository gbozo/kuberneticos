# spec.md — KuberneticOS project specification

Status: **active** · Version target: **2026 modern stack** · License: GPL-3

This document specifies what KuberneticOS *is* and what it must become.
`agents.md` points agents here. Decision points (D1–D5) are flagged inline and
tracked in the decision table at the end.

---

## 1. Purpose

KuberneticOS is a **web desktop for Kubernetes**. It renders a real desktop
metaphor in the browser — taskbar, start menu, context menu, resizable
overlapping windows, focus/blur — and the "applications" that run inside those
windows manage Kubernetes clusters: nodes, pods, Helm-style package
management, and a task-manager style multi-level drill-down.

The Windows-like look is deliberate: users already understand a desktop, and
that familiarity is the product's affordance. The roadmap includes MacOS,
Gnome, and KDE skins as **themes**, not code forks.

## 2. Current state (as found)

| Aspect | Now | Target |
|---|---|---|
| Language | Flow-syntax JS (`import X from "y"`, `import * as`, `const a: T`) — not parseable by modern toolchains | TypeScript, ES modules, strict mode |
| React | 16.7, `extends Component` classes, `static contextTypes` | React 19.x, function components + `use*` hooks |
| App shell | Create React App 2.1.3 (deprecated) | Vite 6 + React plugin |
| Theming | `react-uwp` (abandoned ~2018) | Local components + one themed CSS stylesheet with design tokens |
| Window resize | `react-rnd` 9.1 | Keep `react-rnd` (still maintained) or small custom implementation — decision D5 |
| State/event layer | `flux` Dispatcher + EventEmitter "store" + `WMActions` | Plain immutable state + a small typed event bus only where cross-component observation is required |
| IDs | `shortid` | `crypto.randomUUID()` |
| Build | gulp 4 + babel-register + flow-bin + styleguidist | vite build; no gulp; no babel-register |
| Tests | CRA `App.test.js` (jest via react-scripts) | vitest units + playwright e2e |
| Lint/format | implicit CRA eslint | eslint 9 flat config + prettier |
| Go code | ~2,200 vendored files of the deprecated `kubernetes-client/go` | Decision D1 (delete vs. keep as vendor data) |
| Docs | README (CRA template, wrong badges), stale `help.md` | Rewritten README; `help.md` replaced |

The app today has **no live Kubernetes connection** — the cluster management
described in the README is aspirational.

## 3. Architecture (target)

```
┌──────────────────────────────────────────────────────────┐
│ Desktop shell (React 19 + Vite, TypeScript)              │
│  Taskbar ── Clock · StartMenu · WindowList · ContextMenu │
│  WindowManager ── z-order, focus/blur, minimize/restore  │
│  Window apps ── pluggable "apps" (TestWindow today,     │
│                  cluster/pod/Helm apps in future)        │
└───────────────┬──────────────────────────────────────────┘
                │ typed client interface (no raw fetch in components)
┌───────────────▼──────────────────────────────────────────┐
│ Cluster layer: browser client to a proxied cluster API   │
│ (decision D2: which client/transport — see §6)           │
└──────────────────────────────────────────────────────────┘
```

### Behavior contract (must be preserved)

1. Taskbar is `position: fixed` at the bottom, `z-index` above windows.
2. Windows overlap with z-ordering; the focused window is frontmost and
   visually distinct (focus/blur states).
3. Windows are draggable and resizable; minimize/restore and close semantics
   exist and are distinct.
4. Start menu opens from the taskbar above it (z 1050 vs taskbar 1100 layering
   as currently coded — keep the layering, not the magic numbers).
5. Right-click anywhere opens the context menu.
6. The clock ticks in the taskbar.

### State model (target)

- One immutable `DesktopState` (windows list, focus, z-order, app registry).
- A single event bus (`dispatch(action)` → typed action records) **only** for
  cross-component observation (focus changes, store listeners). No
  EventEmitter-per-store pattern, no `flux` package.
- Components subscribe via React hooks (`useEvent`-style), not
  `addChangeListener` bookkeeping.

## 4. Modernization plan

- **D2 — App framework**: Vite + React 19 + TypeScript. (CRA is deprecated;
  react-scripts upgrades won't reach 2026 idioms.)
- **D3 — Build tooling**: delete `gulpfile.babel.js`, `.babelrc`,
  `.flowconfig`, `babel-register`, `source-map-explorer`; vite handles build/dev.
- **D4 — Theming**: replace every `react-uwp` widget with small local
  components (`AppBarButton`, `Menu`, `Toggle`, `Icon`, `Tooltip`, …) styled by
  one CSS file with custom properties; ship a `windows-11`-style default theme
  and stub theme slots for macos/gnome/kde.
- **D5 — Window resize**: keep `react-rnd` (maintained upstream) or write a
  ~100-line custom drag/resize controller. Either is acceptable; keep the
  behavior contract.
- **Language conversion**: convert Flow sources to TypeScript ES modules as a
  rewrite, not incremental syntax fixes (see agents.md rule 2).
- **Docs**: rewrite README (fix badges, real getting-started), delete
  `help.md` CRA boilerplate, keep `FUNDING.yml` and LICENSE.

## 5. Testing (target)

- `vitest`: unit tests for state model (window add/remove/focus, z-order,
  actions) — pure functions, no DOM.
- `playwright` e2e: boot the desktop, open a window, assert taskbar/focus
  behavior. Replaces the CRA `App.test.js`.

## 6. Kubernetes integration (target)

The README promises cluster management; the code has none. Two candidate
shapes — **this is decision D2's second half**:

- **A. Browser-side**: TypeScript client (e.g. `backstage/kubernetes-client`-style
  or a thin typed wrapper over the cluster REST API) talking to a CORS-proxied
  API. Keeps the app a pure web app.
- **B. Server-side Go**: a real Go service using the modern
  [`go/kubernetes-client`](https://github.com/kubernetes-client/go) (generated
  from the OpenAPI spec — *not* the vendored legacy tree), serving JSON to the
  web app. This is what the vendored Go tree hints the original author wanted.

Either way: one typed client interface in the app; no scattered `fetch`.

## 7. Decision table

| ID | Decision | Outcome |
|---|---|---|
| D1 | Vendored legacy Go tree | **Replace** with a dependency on the modern [`go/kubernetes-client`](https://github.com/kubernetes-client/go); delete the vendored subtree in one change |
| D2 | Cluster integration shape | **B: Go server + modern client** — a Go service using `go/kubernetes-client` serves JSON to the web app through one typed client interface |
| D3 | Build tooling | **Remove** gulp, flow, babel-register, styleguidist, source-map-explorer; Vite owns build/dev |
| D4 | react-uwp replacement | **Replace** all react-uwp widgets with small local components + one themed CSS stylesheet with design tokens (theme slots: windows default, macos/gnome/kde stubs) |
| D5 | Window resize | **Keep `react-rnd`** (maintained upstream, works with React 19) |
| D6 | Scope | **Full code modernization**: rewrite the app to TypeScript + React 19 + Vite, add the Go server, rewrite docs |
