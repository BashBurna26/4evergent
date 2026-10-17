import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { ScheduleRecord } from '../types';
import { PaginationFooter } from '../components';

interface ScheduleListProps {
  agentId: string;
  onError?: (msg: string) => void;
}

const PAGE_SIZE = 50;

export function ScheduleList({ agentId: propAgentId, onError }: ScheduleListProps) {
  const { agentId: routeAgentId } = useParams();
  const agentId = propAgentId ?? routeAgentId;
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    if (!agentId) return;
    try {
      const r = await api.listSchedules(agentId, PAGE_SIZE, offset);
      setSchedules(replace ? r.schedules : (prev) => (prev ?? []).concat(r.schedules));
      setHasMore(r.hasMore);
      setNextOffset(offset + r.schedules.length);
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
  if (schedules === null) return <div className="skeleton">Loading schedules...</div>;
  if (schedules.length === 0) {
    return (
      <div className="empty-state">
        <p>No schedules for this agent.</p>
      </div>
    );
  }

  const handleAction = async (scheduleId: string, action: 'pause' | 'resume' | 'disable') => {
    try {
      if (action === 'pause') await api.pauseSchedule(agentId, scheduleId);
      else if (action === 'resume') await api.resumeSchedule(agentId, scheduleId);
      else await api.disableSchedule(agentId, scheduleId);
      loadPage(0, true);
    } catch (e: any) {
      onError?.(e.message);
    }
  };

  return (
    <>
      <table>
        <thead>
          <tr><th>ID</th><th>Expression</th><th>Next Run</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.id}>
              <td><code>{s.id.slice(0, 8)}</code></td>
              <td>{s.scheduleExpression}</td>
              <td>{new Date(s.nextRunAt).toLocaleString()}</td>
              <td><StatusBadge status={s.status} /></td>
              <td>
                {s.status === 'active' && (
                  <>
                    <button onClick={() => handleAction(s.id, 'pause')}>Pause</button>
                    {' '}
                    <button onClick={() => handleAction(s.id, 'disable')}>Disable</button>
                  </>
                )}
                {s.status === 'paused' && (
                  <>
                    <button onClick={() => handleAction(s.id, 'resume')}>Resume</button>
                    {' '}
                    <button onClick={() => handleAction(s.id, 'disable')}>Disable</button>
                  </>
                )}
                {s.status === 'disabled' && (
                  <button onClick={() => handleAction(s.id, 'resume')}>Resume</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={schedules.length} />
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'badge-ok'
    : status === 'paused' ? 'badge-warn'
    : 'badge-err';
  return <span className={'badge ' + cls}>{status}</span>;
}
