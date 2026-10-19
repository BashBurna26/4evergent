import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { ExecutionRecord, ExecutionStatus } from '../types';
import { PaginationFooter, Skeleton } from '../components';

interface ExecutionListProps {
  agentId: string;
  onError?: (msg: string) => void;
  onExecutionClick?: (id: string) => void;
}

const PAGE_SIZE = 50;

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

export function ExecutionList({ agentId: propAgentId, onError, onExecutionClick }: ExecutionListProps) {
  const { agentId: routeAgentId } = useParams();
  const agentId = propAgentId ?? routeAgentId;
  const [executions, setExecutions] = useState<ExecutionRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    if (!agentId) return;
    try {
      const r = await api.listAgentExecutions(agentId, PAGE_SIZE, offset);
      setExecutions(replace ? r.executions : (prev) => (prev ?? []).concat(r.executions));
      setHasMore(r.hasMore);
      setNextOffset(offset + r.executions.length);
    } catch (e: any) {
      setError(e.message);
      onError?.(e.message);
    }
  }, [agentId, onError]);

  const loadMore = useCallback(() => {
    if (!agentId) return;
    setLoadingMore(true);
    loadPage(nextOffset, false).finally(() => setLoadingMore(false));
  }, [agentId, loadPage, nextOffset]);

  useEffect(() => {
    if (agentId) loadPage(0, true).catch(() => {});
  }, [agentId, loadPage]);

  if (!agentId) return <div className="empty-state"><p>No agent specified.</p></div>;
  if (error) return <div className="error">{error}</div>;
  if (executions === null) return <Skeleton label="Loading executions..." />;
  if (executions.length === 0) {
    return (
      <div className="empty-state">
        <p>No executions for this agent yet.</p>
      </div>
    );
  }

  return (
    <>
      <table>
        <thead>
          <tr><th>ID</th><th>Intent</th><th>Amount</th><th>Status</th><th>Attempt</th><th>Created</th></tr>
        </thead>
        <tbody>
          {executions.map((e) => {
            const isRetrying = e.status === 'failed' && e.nextRetryAt !== null && e.errorClass === 'transient';
            const display = isRetrying ? 'Retrying' : statusLabel(e.status);
            const cls = isRetrying ? 'badge-warn' : statusClass(e.status);
            return (
              <tr key={e.id} onClick={() => onExecutionClick?.(e.id)} style={{ cursor: onExecutionClick ? 'pointer' : undefined }}>
                <td><code>{e.id.slice(0, 8)}</code></td>
                <td>{e.intent.type}</td>
                <td>{e.intent.type === 'payment' ? `${e.intent.amount} ${(e.intent.assetDetails as { code?: string } | undefined)?.code ?? e.intent.asset}` : '-'}</td>
                <td><span className={`badge ${cls}`}>{display}</span></td>
                <td>{e.attempt > 0 ? String(e.attempt) : '-'}</td>
                <td>{new Date(e.createdAt).toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={executions.length} />
    </>
  );
}
