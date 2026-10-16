import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import type { ExecutionRecord, ExecutionStatus } from '../types';
import { Skeleton, EmptyState, DetailCard, IntentAmount } from '../components';

function statusLabel(status: ExecutionStatus): string {
  switch (status) {
    case 'queued': return 'Queued';
    case 'executing': return 'Executing';
    case 'submitted': return 'Submitted';
    case 'confirmed': return 'Confirmed';
    case 'failed': return 'Failed';
    case 'dead_letter': return 'Dead Letter';
    case 'cancelled': return 'Cancelled';
  }
}

function statusClass(status: ExecutionStatus): string {
  switch (status) {
    case 'queued': return 'badge-info';
    case 'executing': return 'badge-warn';
    case 'submitted': return 'badge-warn';
    case 'confirmed': return 'badge-ok';
    case 'failed': return 'badge-err';
    case 'dead_letter': return 'badge-err';
    case 'cancelled': return 'badge-neutral';
  }
}

function statusDescription(status: ExecutionStatus): string | null {
  switch (status) {
    case 'queued': return 'Execution is waiting in the queue.';
    case 'executing': return 'Execution is being processed by the worker.';
    case 'submitted': return 'Transaction submitted to Stellar. Waiting for on-chain confirmation.';
    case 'confirmed': return 'Transaction confirmed on-chain.';
    case 'failed': return 'Transaction failed on-chain.';
    case 'dead_letter': return 'Execution failed and will not be retried automatically.';
    case 'cancelled': return 'Execution was cancelled by operator and will not be retried.';
  }
}

export default function ExecutionDetail() {
  const { executionId } = useParams<{ executionId: string }>();
  const [execution, setExecution] = useState<ExecutionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!executionId) return;
    api.getExecution(executionId)
      .then((r) => setExecution(r.execution))
      .catch((e: any) => setError(e.message ?? 'Failed to load execution'))
      .finally(() => setLoading(false));
  }, [executionId]);

  if (loading) return <Skeleton label="Loading execution..." />;
  if (error) return <EmptyState title="Failed to load execution" message={error} />;
  if (!execution) return (
    <EmptyState title="Execution not found" message="This execution does not exist or you do not have access." />
  );

  const desc = statusDescription(execution.status);
  const canRetry = execution.status === 'failed' || execution.status === 'dead_letter';
  const canCancel = execution.status === 'queued' || execution.status === 'executing';
  const isProcessing = actionLoading !== null;

  const handleRetry = async () => {
    if (!executionId || actionLoading !== null) return;
    setActionLoading('retry');
    setActionError(null);
    try {
      const r = await api.retryExecution(executionId);
      setExecution(r.execution);
    } catch (e: any) {
      if (e.status === 409) {
        setActionError(e.message ?? 'Conflict: execution state changed');
        try {
          const r = await api.getExecution(executionId);
          setExecution(r.execution);
        } catch { /* ignore refresh failure */ }
      } else {
        setActionError(e.message ?? 'Retry failed');
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async () => {
    if (!executionId || actionLoading !== null) return;
    setActionLoading('cancel');
    setActionError(null);
    try {
      const r = await api.cancelExecution(executionId);
      setExecution(r.execution);
    } catch (e: any) {
      if (e.status === 409) {
        setActionError(e.message ?? 'Conflict: execution state changed');
        try {
          const r = await api.getExecution(executionId);
          setExecution(r.execution);
        } catch { /* ignore refresh failure */ }
      } else {
        setActionError(e.message ?? 'Cancel failed');
      }
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Execution <code>{execution.id.slice(0, 8)}</code></h1>
          <p className="muted">
            Agent: {execution.agentId.slice(0, 8)} · {execution.intent.type}
          </p>
        </div>
        <Link to="/executions" className="btn btn-ghost btn-sm">← Executions</Link>
      </div>

      <div className="detail-grid">
        <DetailCard title="Status">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
            <span className={`badge ${statusClass(execution.status)}`}>{statusLabel(execution.status)}</span>
            {desc && <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>{desc}</span>}
          </div>
        </DetailCard>
        <DetailCard title="Agent"><code>{execution.agentId.slice(0, 8)}</code></DetailCard>
        <DetailCard title="Intent">{execution.intent.type}</DetailCard>
        <DetailCard title="Amount"><IntentAmount intent={execution.intent} /></DetailCard>
        <DetailCard title="Transaction Hash">
          {execution.txHash ? <code className="address">{execution.txHash.slice(0, 12)}…{execution.txHash.slice(-8)}</code> : '-'}
        </DetailCard>
        <DetailCard title="Attempt">{execution.attempt > 0 ? String(execution.attempt) : '-'}</DetailCard>
        <DetailCard title="Created">{new Date(execution.createdAt).toLocaleString()}</DetailCard>
        <DetailCard title="Updated">{new Date(execution.updatedAt).toLocaleString()}</DetailCard>
        {execution.startedAt && (
          <DetailCard title="Started">{new Date(execution.startedAt).toLocaleString()}</DetailCard>
        )}
        {execution.completedAt && (
          <DetailCard title="Completed">{new Date(execution.completedAt).toLocaleString()}</DetailCard>
        )}
        {execution.error && (
          <DetailCard title="Error">{execution.error}</DetailCard>
        )}
      </div>

      {/* Cross-link to originating activity */}
      {execution.activityId && (
        <div style={{ marginTop: 'var(--space-md)', padding: 'var(--space-sm)', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }}>
          <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            Activity: <code>{execution.activityId.slice(0, 8)}</code>
          </span>
          {' '}
          <Link to={`/agents/${execution.agentId}/activity/${execution.activityId}`} className="btn btn-ghost btn-sm">
            View Activity
          </Link>
        </div>
      )}

      {/* Operator Recovery Actions */}
      <div style={{ marginTop: 'var(--space-lg)', display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', alignItems: 'center' }}>
        {canRetry && (
          <button className="btn btn-primary" disabled={isProcessing || actionLoading === 'retry'} onClick={handleRetry}>
            {actionLoading === 'retry' ? 'Retrying...' : 'Retry Execution'}
          </button>
        )}
        {canCancel && (
          <button className="btn btn-danger" disabled={isProcessing || actionLoading === 'cancel'} onClick={handleCancel}>
            {actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel Execution'}
          </button>
        )}
        {!canRetry && !canCancel && (
          <span className="muted">No recovery actions available for this status.</span>
        )}
        {actionError && (
          <div className="error-banner" style={{ width: '100%' }}>{actionError}</div>
        )}
      </div>
    </section>
  );
}
