import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Executions from '../Executions';

// Mock API — hoisted so vi.fn references are available in the mock factory
const { mockListAllExecutions, mockGetQueueStatus, mockGetAgent, mockListAgentExecutions, mockListActivity, mockListAgents } = vi.hoisted(() => ({
  mockListAllExecutions: vi.fn(),
  mockGetQueueStatus: vi.fn(),
  mockGetAgent: vi.fn(),
  mockListAgentExecutions: vi.fn(),
  mockListActivity: vi.fn(),
  mockListAgents: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listAllExecutions: mockListAllExecutions,
    getQueueStatus: mockGetQueueStatus,
    getAgent: mockGetAgent,
    listAgentExecutions: mockListAgentExecutions,
    listActivity: mockListActivity,
    listAgents: mockListAgents,
  },
}));

describe('Executions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    mockListAllExecutions.mockReturnValue(new Promise(() => {}));
    mockGetQueueStatus.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Executions /></MemoryRouter>);
    expect(screen.getByText('Loading executions...')).toBeInTheDocument();
  });

  it('renders empty state when no executions', async () => {
    mockListAllExecutions.mockResolvedValue({ executions: [] });
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('No executions found')).toBeInTheDocument();
    });
  });

  it('renders error state', async () => {
    mockListAllExecutions.mockRejectedValue(new Error('API error'));
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('API error')).toBeInTheDocument();
    });
  });

  it('renders execution list with correct data', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-1',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'submitted',
          policyDecision: null,
          simulationResult: null,
          txHash: 'tx-hash-1',
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { submitted: 1 } });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('exec-1'.slice(0, 8))).toBeInTheDocument();
    });
  });

  it('renders a View execution link per row with correct href', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-1',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'submitted',
          policyDecision: null,
          simulationResult: null,
          txHash: 'tx-hash-1',
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { submitted: 1 } });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /exec-1/ });
      expect(link).toHaveAttribute('href', '/executions/exec-1');
    });
  });

  it('does not render a link when execution id is missing', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: '',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'queued',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: null,
          attempt: 0,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });

  it('renders dead-letter status correctly', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-dl',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'dead_letter',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: 'Max retries exceeded',
          attempt: 3,
          nextRetryAt: null,
          startedAt: null,
          completedAt: '2026-01-01T00:00:00Z',
          errorClass: 'permanent',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { dead_letter: 1 } });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getAllByText(/Dead Letter/).length).toBeGreaterThan(0);
    });
  });

  it('renders cancelled status correctly and includes Cancelled in filter options', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-cancelled',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'cancelled',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: 'cancelled by user',
          attempt: 0,
          nextRetryAt: null,
          startedAt: null,
          completedAt: '2026-01-01T00:00:00Z',
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { cancelled: 1 } });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      const badge = screen.getByText('Cancelled', { selector: '.badge' });
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass('badge-neutral');
    });
    expect(screen.getByRole('option', { name: 'Cancelled' })).toBeInTheDocument();
  });

  it('calls listAllExecutions and never listAgents (N+1 removed)', async () => {
    mockListAllExecutions.mockResolvedValue({ executions: [] });
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<MemoryRouter><Executions /></MemoryRouter>);
    await waitFor(() => {
      expect(mockListAllExecutions).toHaveBeenCalledTimes(1);
    });
    expect(mockListAgents).not.toHaveBeenCalled();
    expect(mockListAgentExecutions).not.toHaveBeenCalled();
  });
});
