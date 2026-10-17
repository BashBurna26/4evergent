import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ActivityRecord } from '../types';
import { StatusBadge, Skeleton, EmptyState, IntentAmount, PaginationFooter } from '../components';

const PAGE_SIZE = 50;

export default function Activity() {
  const [activity, setActivity] = useState<ActivityRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    try {
      const r = await api.listActivity(PAGE_SIZE, offset);
      setActivity(replace ? r.activity : (prev) => (prev ?? []).concat(r.activity));
      setHasMore(r.hasMore);
      setNextOffset(offset + r.activity.length);
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

  if (error) return <EmptyState title="Failed to load activity" message={error} />;
  if (activity === null) return <Skeleton label="Loading activity..." />;
  if (activity.length === 0) {
    return (
      <EmptyState
        title="No activity"
        message="Submit an intent to generate activity records."
      />
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>Activity</h1>
        <p className="muted">Audit trail of all agent operations.</p>
      </div>

      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Agent</th>
              <th>Intent</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((r) => (
              <tr
                key={r.id}
                className="table-row-link"
                onClick={() => navigate(`/agents/${r.agentId}/activity/${r.id}`)}
              >
                <td><code>{r.id.slice(0, 8)}</code></td>
                <td><code>{r.agentId.slice(0, 8)}</code></td>
                <td>{r.intent.type}</td>
                <td><IntentAmount intent={r.intent} /></td>
                <td><StatusBadge status={r.status} /></td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={activity.length} />
    </section>
  );
}
