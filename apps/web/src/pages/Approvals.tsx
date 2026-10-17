import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { ApprovalRecord } from '../types';
import { Skeleton, EmptyState, PaginationFooter } from '../components';

const PAGE_SIZE = 50;

export default function Approvals() {
  const [approvals, setApprovals] = useState<ApprovalRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    try {
      const r = await api.listApprovals('pending_approval', PAGE_SIZE, offset);
      setApprovals(replace ? r.approvals : (prev) => (prev ?? []).concat(r.approvals));
      setHasMore(r.hasMore);
      setNextOffset(offset + r.approvals.length);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadPage(0, true).catch(() => {});
  }, [loadPage]);

  const loadMore = () => {
    setLoadingMore(true);
    loadPage(nextOffset, false).finally(() => setLoadingMore(false));
  };

  const handleAction = (id: string, action: 'approve' | 'reject') => {
    setLoadingId(id);
    const call = action === 'approve' ? api.approve(id) : api.reject(id);
    call
      .then(() => loadPage(0, true))
      .catch(() => { /* list untouched on failure; row remains */ })
      .finally(() => setLoadingId(null));
  };

  if (error) return <EmptyState title="Failed to load approvals" message={error} />;
  if (approvals === null) return <Skeleton label="Loading approvals..." />;
  if (approvals.length === 0) {
    return (
      <EmptyState title="No pending approvals" message="Approvals requiring action will appear here." />
    );
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Approvals</h1>
          <p className="muted">Operational review queue for human-in-the-loop authorization.</p>
        </div>
      </div>

      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr><th>Approval</th><th>Agent</th><th>Intent</th><th>Amount</th><th>Asset</th><th>Expires</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id}>
                <td><Link to={`/approvals/${a.id}`} className="table-row-link">{a.id.slice(0, 8)}</Link></td>
                <td><code>{a.agentId}</code></td>
                <td>{a.intent.type}</td>
                <td>{a.intent.amount || '-'}</td>
                <td>{a.intent.asset || ''}</td>
                <td>{a.expiresAt ? new Date(a.expiresAt).toLocaleString() : 'no expiry'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                    <button className="btn btn-primary btn-sm" disabled={loadingId === a.id} onClick={() => handleAction(a.id, 'approve')}>
                      {loadingId === a.id ? 'Processing...' : 'Approve'}
                    </button>
                    <button className="btn btn-danger btn-sm" disabled={loadingId === a.id} onClick={() => {
                      if (!confirm('Reject this approval? This cannot be undone.')) return;
                      handleAction(a.id, 'reject');
                    }}>Reject</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={approvals.length} />
    </section>
  );
}
