<p align="center">
  <a href="" rel="noopener">
 <img width=200px height=200px src="src/assets/kubernetesoslogo.png" alt="Project logo"></a>
</p>

<h3 align="center">KuberneticOS</h3>

<div align="center">

[![Status](https://img.shields.io/badge/status-active-success.svg)]()
[![GitHub Issues](https://img.shields.io/github/issues/gbozo/kuberneticos.svg)](https://github.com/gbozo/kuberneticos/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/gbozo/kuberneticos.svg)](https://github.com/gbozo/kuberneticos/pulls)
[![License](https://img.shields.io/badge/license-GPLv3-yellowgreen)](/LICENSE)

</div>

---

<p align="center"> KuberneticOS is a Web Desktop for Kubernetes. It has a real window
manager written in React and mimics/acts like a real desktop — the resemblance to
Microsoft Windows is deliberate. The goal is to give users a familiar environment
in which to explore and manage a Kubernetes cluster. Windows, macOS, GNOME and KDE
themes are on the roadmap.
    <br>
</p>

## About

KuberneticOS is a browser desktop environment for Kubernetes. A taskbar, start
menu, focus-aware resizable windows and a right-click context menu form the shell;
"applications" running inside windows talk to a cluster through a single typed
client layer.

Planned / in progress:

- A package manager (Helm charts) that installs software into your cluster and
  integrates it with KuberneticOS.
- Node / ReplicaSet / ReplicationController / Pod management.
- A Kubernetes task manager with multi-level drill-down, launched from the
  taskbar.

This project is specified in [`spec.md`](spec.md) and documented for contributors
and AI agents in [`agents.md`](agents.md).

## Repository layout

| Path | What it is |
|---|---|
| `src/` | The frontend: TypeScript + React 19 + Vite. Shell components, state model, window apps. |
| `src/state/` | Immutable `DesktopState` reducer + typed event bus. |
| `src/components/ui/` | Small local UI kit (buttons, menus, toggles, icons) that replaced the abandoned `react-uwp`. |
| `src/window-apps/` | Pluggable window applications (e.g. TestWindow, ClusterExplorer). |
| `src/theme/` | Design tokens + the Windows/macOS/GNOME/KDE theme slots. |
| `src/cluster/` | The one typed cluster-client interface. |
| `server/` | Go JSON API backed by [`k8s.io/client-go`](https://github.com/kubernetes/client-go). |

## 🏁 Getting Started

### Prerequisites

- Node.js 20+ and npm (the app is built with Vite).
- Go 1.24+ (only if you run the cluster server).
- A Kubernetes cluster — or minikube — reachable through a kubeconfig (optional:
  without one the server runs in offline mode).

### Install & run the frontend

```bash
npm install
npm run dev          # Vite dev server, http://localhost:5173
```

The dev server proxies `/api` to the Go server at `http://localhost:8700`
(see `vite.config.ts`).

### Run the cluster server (optional)

```bash
cd server
go run .             # listens on :8700, CORS-enabled JSON API
```

Without cluster configuration the server still starts and answers with
`"source":"offline"` and empty lists, so the web desktop runs either way. See
[`server/README.md`](server/README.md) for endpoints and environment variables.

### Production build

```bash
npm run build        # typecheck + vite build → dist/
npm run preview      # serve the production build locally
```

## 🔧 Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | `tsc -b && vite build` |
| `npm run preview` | Serve the production build |
| `npm run lint` | ESLint 9 (flat config) |
| `npm run format` / `npm run format:check` | Prettier |
| `npm run test` | Vitest unit tests |
| `npm run e2e` | Playwright end-to-end tests |

## 🎈 Architecture

- **One immutable desktop state.** `src/state/reducer.ts` is a pure reducer over
  `DesktopState` (windows, focus, z-order, start menu, context menu); focus and
  z-order are computed, not stored as CSS hacks.
- **A typed event bus** (`src/state/events.ts`) is the only cross-component
  observation channel (window added/removed/focused, start-menu toggled).
- **Windows** are `react-rnd` elements whose geometry lives in state; the focused
  window is frontmost below the taskbar, blur/minimize/restore are distinct.
- **Cluster access** is centralized in the typed `ClusterClient`
  (`src/cluster/client.ts`): an offline default and an HTTP implementation that
  talks to the Go server. No ad-hoc `fetch` calls in components.

## ✍️ Authors

- [@gbozo](https://github.com/gbozo) — idea & initial work.

See also the list of
[contributors](https://github.com/gbozo/kuberneticos/graphs/contributors) who
participated in this project.

## License

GPL-3.0. See [`LICENSE`](LICENSE).
