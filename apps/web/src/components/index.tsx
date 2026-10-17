/**
 * Shared UI Components for 4evergent Control Plane.
 * Reusable building blocks to reduce duplication across pages.
 */

import type { ActivityRecord, ExecutionRecord, ApprovalRecord, AgentRecord } from '../types';

/* ==========================================================================
   StatusBadge
   ========================================================================== */

export type ActivityStatus = ActivityRecord['status'];
export type ExecutionStatus = ExecutionRecord['status'];
export type Approval = ApprovalRecord['status'];
export type AgentStat = AgentRecord['status'];

export function StatusBadge({ status }: { status: string }) {
  let cls: string;
  const label = status;

  if (status === 'submitted' || status === 'confirmed') {
    cls = 'badge-ok';
  } else if (status === 'failed' || status === 'rejected' || status === 'dead_letter') {
    cls = 'badge-err';
  } else if (status === 'requires_approval' || status === 'pending_approval') {
    cls = 'badge-warn';
  } else if (status === 'approved' || status === 'signed' || status === 'pending') {
    cls = 'badge-info';
  } else if (status === 'executing' || status === 'retrying' || status === 'queued') {
    cls = 'badge-info';
  } else if (status === 'expired') {
    cls = 'badge-err';
  } else if (status === 'disabled') {
    cls = 'badge-err';
  } else if (status === 'paused') {
    cls = 'badge-warn';
  } else if (status === 'active') {
    cls = 'badge-ok';
  } else if (status === 'cancelled') {
    cls = 'badge-neutral';
  } else {
    cls = 'badge-neutral';
  }

  return (
    <span className={`badge ${cls}`}>
      {label}
    </span>
  );
}

/* ==========================================================================
   AgentStatusBadge
   ========================================================================== */

export function AgentStatusBadge({ status }: { status: AgentStat }) {
  let cls: string;
  switch (status) {
    case 'active': cls = 'badge-ok'; break;
    case 'paused': cls = 'badge-warn'; break;
    case 'disabled': cls = 'badge-err'; break;
    default: cls = 'badge-neutral';
  }
  return <span className={`badge ${cls}`}>{status}</span>;
}

/* ==========================================================================
   Card
   ========================================================================== */

export function Card({ title, value, label }: { title: string; value: string; label?: string }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="card-value">{value}</div>
      {label && <div className="card-label">{label}</div>}
    </div>
  );
}

/* ==========================================================================
   Skeleton
   ========================================================================== */

export function Skeleton({ label }: { label: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-label={label}>
      {label}
    </div>
  );
}

/* ==========================================================================
   EmptyState
   ========================================================================== */

export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{message}</p>
    </div>
  );
}

/* ==========================================================================
   Amount Display
   ========================================================================== */

export function Amount({ value, asset }: { value: string | number; asset?: string }) {
  const str = typeof value === 'number' ? value.toLocaleString() : value;
  return <span className="amount">{str} {asset}</span>;
}

/* ==========================================================================
   Address Display
   ========================================================================== */

export function Address({ address, len = 12 }: { address: string; len?: number }) {
  if (!address) return <span className="muted">-</span>;
  const formatted = address.length > len ? `${address.slice(0, len / 2)}…${address.slice(-len / 2)}` : address;
  const copy = () => navigator.clipboard?.writeText(address);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copy();
    }
  };
  return (
    <code
      className="address"
      role="button"
      tabIndex={0}
      title={`${address} (click to copy)`}
      aria-label={`Copy address ${address}`}
      onClick={copy}
      onKeyDown={onKey}
    >
      {formatted}
    </code>
  );
}

/* ==========================================================================
   PageHeader
   ========================================================================== */

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
    </div>
  );
}

/* ==========================================================================
   LifecycleTrail
   ========================================================================== */

interface LifecycleStepConfig {
  label: string;
  completed: boolean;
  current?: boolean;
}

export function LifecycleTrail({ activeStep }: { activeStep: string }) {
  const stepMap: Record<string, number> = {
    agent: 0,
    policy: 1,
    intent: 2,
    approval: 3,
    execution: 4,
    stellar: 5,
    submitted: 5,
    confirmation: 6,
    activity: 7,
  };

  const idx = stepMap[activeStep] ?? 0;

  const stepsConfig: LifecycleStepConfig[] = [
    { label: 'Agent', completed: idx >= 0 },
    { label: 'Policy', completed: idx >= 1 },
    { label: 'Intent', completed: idx >= 2 },
    { label: 'Approval', completed: idx >= 3 },
    { label: 'Execution', completed: idx >= 4 },
    { label: 'Stellar', completed: idx >= 5 },
    { label: 'Confirmation', completed: idx >= 6 },
    { label: 'Activity', completed: idx >= 7 },
  ];

  return (
    <div className="lifecycle-trail">
      {stepsConfig.map((step, i) => (
        <div key={step.label}>
          <div
            className={`lifecycle-step ${step.completed ? 'completed' : ''} ${
              i === idx && step.completed ? 'current' : ''
            }`}
          >
            <span className="step-dot"></span>
            <span className="step-label">{step.label}</span>
          </div>
          {i < stepsConfig.length - 1 && <div className="lifecycle-divider"></div>}
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   DetailCard
   ========================================================================== */

export function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="detail-card">
      <div className="detail-card-title">{title}</div>
      <div className="detail-card-value">{children}</div>
    </div>
  );
}

/* ==========================================================================
   DataTable wrapper
   ========================================================================== */

export function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="table-wrapper">
      <table className="table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children}
        </tbody>
      </table>
    </div>
  );
}

/* ==========================================================================
   Section
   ========================================================================== */

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}

/* ==========================================================================
   IntentAmount (for rendering intent amounts across pages)
   ========================================================================== */

export function IntentAmount({ intent }: { intent: { type: string; amount?: string; asset?: string; assetDetails?: { code?: string } | null } }) {
  if (intent.type === 'payment') {
    const assetCode = intent.assetDetails?.code ?? intent.asset;
    return <span className="amount">{intent.amount} {assetCode}</span>;
  }
  return <span className="muted">-</span>;
}

/* ==========================================================================
   Button
   ========================================================================== */

export function Button({
  children,
  onClick,
  disabled = false,
  variant = 'primary',
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  type?: 'button' | 'submit';
}) {
  const cls = variant === 'secondary' ? 'btn-secondary' : variant === 'danger' ? 'btn-danger' : 'btn-primary';
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/* ==========================================================================
   PaginationFooter
   ========================================================================== */

export function PaginationFooter({
  hasMore,
  loadingMore,
  onLoadMore,
  itemCount,
}: {
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  itemCount: number;
}) {
  if (!hasMore) return null;
  return (
    <div className="pagination-footer">
      <span className="muted">{itemCount} shown</span>
      <Button onClick={onLoadMore} disabled={loadingMore} variant="secondary">
        {loadingMore ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  );
}

/* ==========================================================================
   Re-exports
   ========================================================================== */

export type { ActivityRecord as ActivityRecordType, ExecutionRecord as ExecutionRecordType };
