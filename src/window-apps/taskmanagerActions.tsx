// Destructive workload actions for Task Manager 2.0 (tasks.md §6 / OPT-1).
//
// "End task" deletes a pod, "Restart" performs a rolling restart and "Scale" sets the
// replica count of a deployment. Every action ships behind an explicit confirm dialog and
// surfaces the client's rejection message verbatim — a 403 therefore shows the server's
// RBAC text and the offline client explains that no cluster is configured.
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { clusterClient } from '../cluster/client';
import './taskmanagerActions.css';

export type WorkloadActionTarget =
  | { readonly kind: 'pod'; readonly name: string; readonly namespace: string }
  | {
      readonly kind: 'deployment';
      readonly name: string;
      readonly namespace: string;
      readonly replicas?: number;
    };

export interface WorkloadActionsProps {
  readonly clusterId?: string;
  readonly target: WorkloadActionTarget;
  /** Called after a successful action so the parent can refresh its data. */
  readonly onComplete?: () => void;
}

type WorkloadActionKind = 'end-task' | 'restart' | 'scale';

const REPLICAS_ERROR = 'Enter a whole number of replicas (0–1000).';

const FOCUSABLE_SELECTOR =
  'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/** Confirm-gated destructive actions for a pod or deployment. */
export function WorkloadActions({
  clusterId,
  target,
  onComplete,
}: WorkloadActionsProps): ReactElement {
  const activeClusterId = clusterId ?? '';
  const disabled = activeClusterId === '';
  const { name, namespace } = target;
  const initialReplicas = target.kind === 'deployment' ? (target.replicas ?? 1) : 1;

  const [dialog, setDialog] = useState<WorkloadActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replicasText, setReplicasText] = useState(String(initialReplicas));
  // Synchronous latch: `busy` only flips after a re-render, so a second click in the
  // same tick would otherwise fire a duplicate mutation.
  const inFlightRef = useRef(false);

  const openDialog = (next: WorkloadActionKind): void => {
    inFlightRef.current = false;
    setError(null);
    setBusy(false);
    if (next === 'scale') {
      setReplicasText(String(initialReplicas));
    }
    setDialog(next);
  };

  const closeDialog = (): void => {
    inFlightRef.current = false;
    setDialog(null);
    setError(null);
    setBusy(false);
  };

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      setDialog(null);
      setBusy(false);
      onComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleConfirm = (): void => {
    if (busy || inFlightRef.current) return;
    if (activeClusterId === '') return;

    if (dialog === 'end-task' && target.kind === 'pod') {
      const { namespace: ns, name: pod } = target;
      void runAction(() => clusterClient.deletePod(activeClusterId, ns, pod));
      return;
    }

    if (dialog === 'restart' && target.kind === 'deployment') {
      const { namespace: ns, name: deployment } = target;
      void runAction(() => clusterClient.restartDeployment(activeClusterId, ns, deployment));
      return;
    }

    if (dialog === 'scale' && target.kind === 'deployment') {
      const trimmed = replicasText.trim();
      const parsed = Number(trimmed);
      if (trimmed === '' || !Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
        setError(REPLICAS_ERROR);
        return;
      }
      const { namespace: ns, name: deployment } = target;
      void runAction(() => clusterClient.scaleDeployment(activeClusterId, ns, deployment, parsed));
    }
  };

  return (
    <div className="kos-tm-actions">
      {target.kind === 'pod' ? (
        <button
          type="button"
          className="kos-tm-button kos-tm-button--danger"
          title="Delete the pod"
          aria-label="End task: delete the pod"
          disabled={disabled}
          onClick={() => openDialog('end-task')}
        >
          End task
        </button>
      ) : (
        <>
          <button
            type="button"
            className="kos-tm-button"
            title="Restart the deployment rollout"
            disabled={disabled}
            onClick={() => openDialog('restart')}
          >
            Restart
          </button>
          <button
            type="button"
            className="kos-tm-button"
            title="Scale the deployment"
            disabled={disabled}
            onClick={() => openDialog('scale')}
          >
            Scale
          </button>
        </>
      )}

      {disabled && <p className="kos-tm-actions__hint">No cluster selected.</p>}

      {dialog === 'end-task' && (
        <ConfirmDialog
          title="End task"
          message={`Delete pod ${namespace}/${name}?`}
          warning="This immediately terminates the pod. Its controller may immediately create a replacement."
          confirmLabel="End task"
          destructive
          busy={busy}
          error={error}
          onConfirm={handleConfirm}
          onCancel={closeDialog}
        />
      )}

      {dialog === 'restart' && (
        <ConfirmDialog
          title="Restart deployment"
          message={`Perform a rolling restart of ${namespace}/${name}?`}
          warning="Pods are replaced one at a time as the rollout progresses."
          confirmLabel="Restart"
          busy={busy}
          error={error}
          onConfirm={handleConfirm}
          onCancel={closeDialog}
        />
      )}

      {dialog === 'scale' && (
        <ConfirmDialog
          title="Scale deployment"
          message={`Set the number of replicas for ${namespace}/${name}.`}
          confirmLabel="Scale"
          busy={busy}
          error={error}
          onConfirm={handleConfirm}
          onCancel={closeDialog}
        >
          <label className="kos-tm-field">
            <span className="kos-tm-field__label">Replicas</span>
            <input
              className="kos-tm-field__input"
              type="number"
              min={0}
              max={1000}
              inputMode="numeric"
              value={replicasText}
              onChange={(event) => setReplicasText(event.target.value)}
            />
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}

export interface ConfirmDialogProps {
  readonly title: string;
  readonly message: string;
  readonly warning?: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly children?: ReactNode; // extra fields, e.g. the replicas input
}

/** Accessible, presentational confirm dialog. Focuses the confirm button on mount. */
export function ConfirmDialog({
  title,
  message,
  warning,
  confirmLabel,
  destructive = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps): ReactElement {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hasAttribute('disabled'),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const atEdge = event.shiftKey ? active === first : active === last;
      const outside = active === null || active === node || !node.contains(active);
      if (atEdge || outside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    node.addEventListener('keydown', handleKeyDown);
    return () => node.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel]);

  const confirmClassName = destructive
    ? 'kos-tm-button kos-tm-button--primary kos-tm-button--danger'
    : 'kos-tm-button kos-tm-button--primary';

  return (
    <div className="kos-tm-dialog-backdrop">
      <div
        ref={dialogRef}
        className="kos-tm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId} className="kos-tm-dialog__title">
          {title}
        </h3>
        <p className="kos-tm-dialog__message">{message}</p>
        {warning !== undefined && <p className="kos-tm-dialog__warning">⚠ {warning}</p>}
        {error !== undefined && error !== null && (
          <p className="kos-tm-dialog__error" role="alert">
            {error}
          </p>
        )}
        {children}
        <div className="kos-tm-dialog__actions">
          <button type="button" className="kos-tm-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={confirmClassName}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
