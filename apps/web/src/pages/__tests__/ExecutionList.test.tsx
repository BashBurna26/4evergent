import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ExecutionList } from '../ExecutionList';

const { mockListAgentExecutions } = vi.hoisted(() => ({
  mockListAgentExecutions: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listAgentExecutions: mockListAgentExecutions,
  },
}));

describe('ExecutionList component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when no agentId is provided', () => {
    render(
      <MemoryRouter>
        <ExecutionList agentId="" />
      </MemoryRouter>
    );

    expect(screen.getByText('No agent specified.')).toBeInTheDocument();
    expect(mockListAgentExecutions).not.toHaveBeenCalled();
  });

  it('renders loading state when executions are fetching', () => {
    mockListAgentExecutions.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <ExecutionList agentId="agent-1" />
      </MemoryRouter>
    );

    expect(screen.getByRole('status', { name: 'Loading executions...' })).toBeInTheDocument();
  });

  it('renders error state and calls onError callback when api rejects', async () => {
    const onError = vi.fn();
    mockListAgentExecutions.mockRejectedValue(new Error('Network error loading executions'));

    render(
      <MemoryRouter>
        <ExecutionList agentId="agent-1" onError={onError} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Network error loading executions')).toBeInTheDocument();
    });
    expect(onError).toHaveBeenCalledWith('Network error loading executions');
  });

  it('renders empty state when agent has no executions', async () => {
    mockListAgentExecutions.mockResolvedValue({
      executions: [],
      hasMore: false,
    });

    render(
      <MemoryRouter>
        <ExecutionList agentId="agent-1" />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No executions for this agent yet.')).toBeInTheDocument();
    });
  });

  it('renders execution table with fetched data', async () => {
    const onExecutionClick = vi.fn();
    mockListAgentExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-12345678-abcd',
          ownerId: 'owner-1',
          agentId: 'agent-1',
          approvalId: null,
          activityId: null,
          intent: {
            type: 'payment',
            asset: 'XLM',
            amount: '100',
            destination: 'GDESTINATION123',
          },
          status: 'confirmed',
          policyDecision: null,
          simulationResult: null,
          txHash: 'tx-hash-1',
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-03-01T10:00:00Z',
          updatedAt: '2026-03-01T10:00:00Z',
        },
      ],
      hasMore: false,
    });

    render(
      <MemoryRouter>
        <ExecutionList agentId="agent-1" onExecutionClick={onExecutionClick} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('exec-123')).toBeInTheDocument();
    });

    expect(screen.getByText('payment')).toBeInTheDocument();
    expect(screen.getByText('100 XLM')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    // Clicking row triggers onExecutionClick
    fireEvent.click(screen.getByText('exec-123'));
    expect(onExecutionClick).toHaveBeenCalledWith('exec-12345678-abcd');
  });

  it('displays Retrying status for transient failed executions', async () => {
    mockListAgentExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-retry-12345',
          ownerId: 'owner-1',
          agentId: 'agent-1',
          approvalId: null,
          activityId: null,
          intent: {
            type: 'trustline',
            assetCode: 'USDC',
            issuer: 'GISSUER',
          },
          status: 'failed',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: 'Rate limit',
          attempt: 2,
          nextRetryAt: '2026-03-01T10:05:00Z',
          startedAt: null,
          completedAt: null,
          errorClass: 'transient',
          createdAt: '2026-03-01T10:00:00Z',
          updatedAt: '2026-03-01T10:00:00Z',
        },
      ],
      hasMore: false,
    });

    render(
      <MemoryRouter>
        <ExecutionList agentId="agent-1" />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Retrying')).toBeInTheDocument();
    });
    expect(screen.getByText('-')).toBeInTheDocument(); // trustline amount displays '-'
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('supports pagination via loadMore when hasMore is true', async () => {
    mockListAgentExecutions.mockResolvedValueOnce({
      executions: [
        {
          id: 'exec-page1-item1',
          ownerId: 'owner-1',
          agentId: 'agent-1',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10' },
          status: 'submitted',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: null,
          attempt: 0,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-03-01T10:00:00Z',
          updatedAt: '2026-03-01T10:00:00Z',
        },
      ],
      hasMore: true,
    });

    render(
      <MemoryRouter>
        <ExecutionList agentId="agent-1" />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Load more/i })).toBeInTheDocument();
    });

    mockListAgentExecutions.mockResolvedValueOnce({
      executions: [
        {
          id: 'exec-page2-item2',
          ownerId: 'owner-1',
          agentId: 'agent-1',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '20' },
          status: 'confirmed',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-03-01T11:00:00Z',
          updatedAt: '2026-03-01T11:00:00Z',
        },
      ],
      hasMore: false,
    });

    fireEvent.click(screen.getByRole('button', { name: /Load more/i }));

    await waitFor(() => {
      expect(mockListAgentExecutions).toHaveBeenCalledWith('agent-1', 50, 1);
    });

    await waitFor(() => {
      expect(screen.getByText('20 XLM')).toBeInTheDocument();
    });
  });

  it('reads agentId from route params when not supplied in props', async () => {
    mockListAgentExecutions.mockResolvedValue({
      executions: [],
      hasMore: false,
    });

    render(
      <MemoryRouter initialEntries={['/agents/agent-route-xyz']}>
        <Routes>
          <Route path="/agents/:agentId" element={<ExecutionList agentId={undefined as any} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockListAgentExecutions).toHaveBeenCalledWith('agent-route-xyz', 50, 0);
    });
  });
});
