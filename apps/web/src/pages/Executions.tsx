import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { ExecutionRecord, QueueSummary, ExecutionStatus } from '../types';

type StatusFilter = 'all' | ExecutionStatus;

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'executing', label: 'Executing' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'failed', label: 'Failed' },
  { value: 'dead_letter', label: 'Dead Letter' },
  { value: 'cancelled', label: 'Cancelled' },
];

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
    case 'submitted': return 'badge-ok';
    case 'confirmed': return 'badge-ok';
    case 'failed': return 'badge-err';
    case 'dead_letter': return 'badge-err';
    case 'cancelled': return 'badge-neutral';
  }
}

function inferRetrying(e: ExecutionRecord): boolean {
  return e.status === 'failed' && e.nextRetryAt !== null && e.errorClass === 'transient';
}

export default function Executions({ onExecutionClick }: { onExecutionClick?: (id: string) => void }) {
  const [executions, setExecutions] = useState<ExecutionRecord[] | null>(null);
  const [queue, setQueue] = useState<QueueSummary | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [list, q] = await Promise.all([
          api.listAllExecutions(),
          api.getQueueStatus(),
        ]);
        setExecutions(list.executions);
        setQueue(q);
      } catch (e: any) {
        setError(e.message ?? 'Failed to load executions');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Skeleton label="Loading executions..." />;
  if (error) return <EmptyState title="Failed to load executions" message={error} />;
  if (executions === null) return <Skeleton label="Loading executions..." />;

  const filtered = filter === 'all'
    ? executions
    : executions.filter((e) => e.status === filter || (filter === 'failed' && inferRetrying(e)));

  const retryingCount = executions.filter(inferRetrying).length;

  return (
    <section>
      <h1>Executions</h1>

      {queue && (
        <div className="cards" style={{ marginBottom: 16 }}>
          <Card title="Queue Running" value={queue.running ? 'Yes' : 'No'} />
          <Card title="Queued" value={String(queue.byStatus['queued'] ?? 0)} />
          <Card title="Executing" value={String(queue.byStatus['executing'] ?? 0)} />
          <Card title="Retrying" value={String(retryingCount)} />
          <Card title="Failed" value={String(queue.byStatus['failed'] ?? 0)} />
          <Card title="Dead Letter" value={String(queue.byStatus['dead_letter'] ?? 0)} />
        </div>
      )}

      <div className="filter-bar">
        <label>Status:</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
          {FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No executions found"
          message={filter === 'all'
            ? 'Executions will appear here when an approved intent enters the execution queue.'
            : 'No executions match the selected filter.'}
        />
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Agent</th>
                <th>Intent</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Attempt</th>
                <th>Next Retry</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const isRetrying = inferRetrying(e);
                const statusDisplay = isRetrying ? 'Retrying' : statusLabel(e.status);
                const statusCls = isRetrying ? 'badge-warn' : statusClass(e.status);
                return (
                  <tr
                    key={e.id}
                    onClick={() => onExecutionClick?.(e.id)}
                    style={{ cursor: onExecutionClick ? 'pointer' : undefined }}
                  >
                    <td>
                      {e.id ? (
                        <Link to={`/executions/${encodeURIComponent(e.id)}`} className="table-row-link">
                          <code>{e.id.slice(0, 8)}</code>
                        </Link>
                      ) : (
                        <code>{e.id.slice(0, 8)}</code>
                      )}
                    </td>
                    <td><code>{e.agentId.slice(0, 8)}</code></td>
                    <td>{e.intent.type}</td>
                    <td>{e.intent.type === 'payment' ? `${e.intent.amount} ${(e.intent.assetDetails as { code?: string } | undefined)?.code ?? e.intent.asset}` : '-'}</td>
                    <td>
                      <span className={`badge ${statusCls}`}>
                        {statusDisplay}
                        {e.status === 'dead_letter' && ' ⚠'}
                      </span>
                    </td>
                    <td>{e.attempt > 0 ? String(e.attempt) : '-'}</td>
                    <td>{e.nextRetryAt ? new Date(e.nextRetryAt).toLocaleString() : '-'}</td>
                    <td>{new Date(e.createdAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="card-value">{value}</div>
    </div>
  );
}

function Skeleton({ label }: { label: string }) {
  return <div className="skeleton">{label}</div>;
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  );
}
