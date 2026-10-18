import { useEffect, useState } from 'react';
import { api } from '../api';
import { Skeleton } from '../components';
import type { ScheduleRecord, SubmitPaymentIntent } from '../types';

interface ScheduleManagementProps {
  agentId: string;
  onError?: (msg: string) => void;
}

const SUPPORTED_TIMEZONES = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];

const CRON_PRESETS = [
  { label: 'Every hour', expression: '0 * * * *' },
  { label: 'Every 6 hours', expression: '0 */6 * * *' },
  { label: 'Every 12 hours', expression: '0 */12 * * *' },
  { label: 'Daily (midnight)', expression: '0 0 * * *' },
  { label: 'Daily (noon)', expression: '0 12 * * *' },
  { label: 'Weekly (Monday)', expression: '0 0 * * 1' },
];

export function ScheduleManagement({ agentId, onError }: ScheduleManagementProps) {
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track which schedule is being edited and its draft expression
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editExpression, setEditExpression] = useState<string>('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const load = () => {
    api.listSchedules(agentId)
      .then((r) => setSchedules(r.schedules))
      .catch((e: any) => {
        setError(e.message);
        onError?.(e.message);
      });
  };

  useEffect(() => { load(); }, [agentId]);

  const handleAction = async (scheduleId: string, action: 'pause' | 'resume' | 'disable') => {
    try {
      if (action === 'pause') await api.pauseSchedule(agentId, scheduleId);
      else if (action === 'resume') await api.resumeSchedule(agentId, scheduleId);
      else await api.disableSchedule(agentId, scheduleId);
      load();
    } catch (e: any) {
      onError?.(e.message);
    }
  };

  const handleDelete = async (scheduleId: string) => {
    if (!confirm('Delete this schedule? This cannot be undone.')) return;
    try {
      await api.deleteSchedule(agentId, scheduleId);
      load();
    } catch (e: any) {
      onError?.(e.message);
    }
  };

  const startEdit = (schedule: ScheduleRecord) => {
    setEditingId(schedule.id);
    setEditExpression(schedule.scheduleExpression ?? '');
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditExpression('');
    setEditError(null);
  };

  const saveEdit = async (scheduleId: string) => {
    if (!editingId || editSaving) return;
    const trimmed = editExpression.trim();
    if (!trimmed) {
      setEditError('Schedule expression is required.');
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const result = await api.updateSchedule(agentId, scheduleId, {
        scheduleExpression: trimmed,
      });
      // Update the local schedule list with the server response
      setSchedules((prev) =>
        prev
          ? prev.map((s) => (s.id === scheduleId ? result.schedule : s))
          : prev
      );
      cancelEdit();
    } catch (e: any) {
      setEditError(e.message ?? 'Failed to update schedule expression.');
    } finally {
      setEditSaving(false);
    }
  };

  if (error && schedules === null) return <div className="error">{error}</div>;

  return (
    <div className="schedule-management">
      <div className="schedule-header">
        <h3>Recurring Schedules</h3>
        <button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : 'Create Schedule'}
        </button>
      </div>

      {showCreate && (
        <CreateScheduleForm
          agentId={agentId}
          onSuccess={() => { setShowCreate(false); load(); }}
          onError={(e) => { setError(e); onError?.(e); }}
        />
      )}

      {schedules === null ? (
        <Skeleton label="Loading schedules..." />
      ) : schedules.length === 0 ? (
        <div className="empty-state">
          <p>No schedules for this agent. Create a recurring schedule to automate agent operations.</p>
        </div>
      ) : (
        <table className="schedule-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Intent</th>
              <th>Schedule</th>
              <th>Next Run</th>
              <th>Last Run</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td><code>{s.id.slice(0, 8)}</code></td>
                <td>
                  <div>{s.intent.type}</div>
                  <div className="muted">{s.intent.amount} {s.intent.asset} → {s.intent.destination?.slice(0, 8)}...</div>
                </td>
                <td>
                  {editingId === s.id ? (
                    <form
                      className="schedule-edit-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await saveEdit(s.id);
                      }}
                    >
                      <label>
                        <span>Cron expression</span>
                        <input
                          type="text"
                          value={editExpression}
                          onChange={(e) => setEditExpression(e.target.value)}
                          placeholder="0 0 * * *"
                          disabled={editSaving}
                          aria-label="Edit schedule expression"
                        />
                      </label>
                      <div className="cron-presets">
                        <span className="muted">Presets:</span>
                        {CRON_PRESETS.map((preset) => (
                          <button
                            key={preset.expression}
                            type="button"
                            className="preset-btn"
                            onClick={() => setEditExpression(preset.expression)}
                            disabled={editSaving}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      {editError && <div className="error">{editError}</div>}
                      <div className="form-actions">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={editSaving}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={editSaving}
                        >
                          {editSaving ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <code>{s.scheduleExpression}</code>
                      <div className="muted">{s.timezone}</div>
                    </>
                  )}
                </td>
                <td>{new Date(s.nextRunAt).toLocaleString()}</td>
                <td>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '-'}</td>
                <td><ScheduleStatusBadge status={s.status} /></td>
                <td className="schedule-actions">
                  {editingId === s.id ? (
                    <span className="muted">editing</span>
                  ) : (
                    <button onClick={() => startEdit(s)}>Edit</button>
                  )}
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
                  {' '}
                  <button className="danger" onClick={() => handleDelete(s.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CreateScheduleForm({ agentId, onSuccess, onError }: {
  agentId: string;
  onSuccess: () => void;
  onError: (e: string) => void;
}) {
  const [asset, setAsset] = useState('XLM');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [scheduleExpression, setScheduleExpression] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;

    setSaving(true);
    setError(null);

    const intent: SubmitPaymentIntent = {
      type: 'payment',
      asset: asset === 'XLM' ? 'XLM' : asset,
      destination,
      amount,
      reason,
    };

    try {
      await api.createSchedule(agentId, {
        intent,
        scheduleExpression,
        timezone,
      });
      onSuccess();
    } catch (e: any) {
      const msg = e.message ?? 'Failed to create schedule';
      setError(msg);
      onError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="schedule-create-form">
      {error && <div className="error">{error}</div>}

      <h4>New Recurring Schedule</h4>
      <p className="muted">This will create a recurring payment that executes automatically. All scheduled executions are subject to policy enforcement and approval workflows.</p>

      <div className="form-grid">
        <label>
          <span>Asset</span>
          <select id="schedule-asset" value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option value="XLM">XLM (native)</option>
            <option value="USDC">USDC</option>
            <option value="BTC">BTC</option>
          </select>
        </label>
        <label>
          <span>Amount</span>
          <input
            id="schedule-amount"
            type="number"
            step="0.0000001"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10"
            required
          />
        </label>
        <label>
          <span>Destination (G...)</span>
          <input
            id="schedule-destination"
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="G..."
            required
          />
        </label>
        <label>
          <span>Reason</span>
          <input
            id="schedule-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Recurring payment"
            minLength={3}
            required
          />
        </label>
      </div>

      <label className="full-width">
        <span>Schedule (cron expression)</span>
        <input
          id="schedule-expression"
          type="text"
          value={scheduleExpression}
          onChange={(e) => setScheduleExpression(e.target.value)}
          placeholder="0 0 * * * (minute hour day-of-month month day-of-week)"
          required
        />
        <small>5-field cron expression: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6, 0=Sunday)</small>
      </label>

      <div className="cron-presets">
        <span className="muted">Presets:</span>
        {CRON_PRESETS.map((preset) => (
          <button
            key={preset.expression}
            type="button"
            className="preset-btn"
            onClick={() => setScheduleExpression(preset.expression)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="form-grid">
        <label>
          <span>Timezone</span>
          <select id="schedule-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {SUPPORTED_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-actions">
        <button type="button" onClick={onSuccess} disabled={saving}>Cancel</button>
        <button type="submit" disabled={saving}>
          {saving ? 'Creating...' : 'Create Schedule'}
        </button>
      </div>
    </form>
  );
}

function ScheduleStatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'badge-ok'
    : status === 'paused' ? 'badge-warn'
    : 'badge-err';
  return <span className={'badge ' + cls}>{status}</span>;
}