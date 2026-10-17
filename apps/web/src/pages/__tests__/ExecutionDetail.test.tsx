import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ExecutionDetail from '../ExecutionDetail';

const mockGetExecution = vi.fn();
const mockRetryExecution = vi.fn();
const mockCancelExecution = vi.fn();

vi.mock('../../api', () => ({
  api: {
    getExecution: (...args: any[]) => mockGetExecution(...args),
    retryExecution: (...args: any[]) => mockRetryExecution(...args),
    cancelExecution: (...args: any[]) => mockCancelExecution(...args),
  },
}));

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/executions/exec-1']}>
      <Routes>
        <Route path="/executions/:executionId" element={<ExecutionDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

function makeExecution(overrides: Partial<any> = {}) {
  return {
    id: 'exec-1',
    agentId: 'agent-1',
    ownerId: 'owner-1',
    status: 'failed',
    intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
    txHash: null,
    error: 'network timeout',
    attempt: 1,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ExecutionDetail retry/cancel actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExecution.mockResolvedValue({ execution: makeExecution() });
  });

  describe('Retry visibility', () => {
    it('shows Retry for failed status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'failed' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Retry Execution')).toBeInTheDocument();
      });
    });

    it('shows Retry for dead_letter status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'dead_letter' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Retry Execution')).toBeInTheDocument();
      });
    });

    it('hides Retry for queued status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'queued' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Retry Execution')).not.toBeInTheDocument();
      });
    });

    it('hides Retry for executing status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'executing' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Retry Execution')).not.toBeInTheDocument();
      });
    });

    it('hides Retry for submitted status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'submitted' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Retry Execution')).not.toBeInTheDocument();
      });
    });

    it('hides Retry for confirmed status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'confirmed' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Retry Execution')).not.toBeInTheDocument();
      });
    });

    it('hides Retry for cancelled status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'cancelled' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Retry Execution')).not.toBeInTheDocument();
      });
    });
  });

  describe('Retry action', () => {
    it('calls retryExecution with correct ID and refreshes on success', async () => {
      mockRetryExecution.mockResolvedValue({ execution: makeExecution({ status: 'queued', attempt: 2 }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Retry Execution')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Retry Execution'));
      await waitFor(() => {
        expect(mockRetryExecution).toHaveBeenCalledWith('exec-1');
        expect(mockGetExecution).toHaveBeenCalledTimes(1);
      });
    });

    it('disables button during request', async () => {
      mockRetryExecution.mockImplementation(() => new Promise(() => {}));
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Retry Execution')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Retry Execution'));
      expect(screen.getByText('Retrying...')).toBeDisabled();
    });
  });

  describe('Retry error handling', () => {
    it('shows error and refreshes on 409', async () => {
      const err: any = new Error('max retry attempts reached');
      err.status = 409;
      mockRetryExecution.mockRejectedValue(err);
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Retry Execution')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Retry Execution'));
      await waitFor(() => {
        expect(screen.getByText('max retry attempts reached')).toBeInTheDocument();
        expect(mockGetExecution).toHaveBeenCalledTimes(2);
      });
    });

    it('shows error without crashing on non-409', async () => {
      const err: any = new Error('network error');
      err.status = 500;
      mockRetryExecution.mockRejectedValue(err);
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Retry Execution')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Retry Execution'));
      await waitFor(() => {
        expect(screen.getByText('network error')).toBeInTheDocument();
      });
    });
  });

  describe('Cancel visibility (mirrors backend FSM: queued, executing)', () => {
    it('shows Cancel for queued status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'queued' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Cancel Execution')).toBeInTheDocument();
      });
    });

    it('shows Cancel for executing status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'executing' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Cancel Execution')).toBeInTheDocument();
      });
    });

    it('hides Cancel for failed status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'failed' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Cancel Execution')).not.toBeInTheDocument();
      });
    });

    it('hides Cancel for dead_letter status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'dead_letter' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Cancel Execution')).not.toBeInTheDocument();
      });
    });

    it('hides Cancel for confirmed status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'confirmed' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Cancel Execution')).not.toBeInTheDocument();
      });
    });

    it('hides Cancel for cancelled status', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'cancelled' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.queryByText('Cancel Execution')).not.toBeInTheDocument();
      });
    });
  });

  describe('Cancelled status display', () => {
    it('displays Cancelled badge and description for cancelled execution', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'cancelled' }) });
      renderDetail();
      await waitFor(() => {
        const badge = screen.getByText('Cancelled');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveClass('badge-neutral');
        expect(screen.getByText('Execution was cancelled by operator and will not be retried.')).toBeInTheDocument();
      });
    });
  });

  describe('Cancel action', () => {
    it('calls cancelExecution with correct ID and refreshes on success', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'queued' }) });
      mockCancelExecution.mockResolvedValue({ execution: makeExecution({ status: 'cancelled' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Cancel Execution')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Cancel Execution'));
      await waitFor(() => {
        expect(mockCancelExecution).toHaveBeenCalledWith('exec-1');
        expect(mockGetExecution).toHaveBeenCalledTimes(1);
      });
    });

    it('disables button during request', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'queued' }) });
      mockCancelExecution.mockImplementation(() => new Promise(() => {}));
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Cancel Execution')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Cancel Execution'));
      expect(screen.getByText('Cancelling...')).toBeDisabled();
    });
  });

  describe('Cancel conflict', () => {
    it('shows 409 error and refreshes execution state', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'queued' }) });
      const err: any = new Error('cannot cancel execution in status confirmed');
      err.status = 409;
      mockCancelExecution.mockRejectedValue(err);
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Cancel Execution')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Cancel Execution'));
      await waitFor(() => {
        expect(screen.getByText('cannot cancel execution in status confirmed')).toBeInTheDocument();
        expect(mockGetExecution).toHaveBeenCalledTimes(2);
      });
    });

    it('does not crash on 409', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ status: 'queued' }) });
      const err: any = new Error('state changed');
      err.status = 409;
      mockCancelExecution.mockRejectedValue(err);
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Cancel Execution')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Cancel Execution'));
      await waitFor(() => {
        expect(screen.getByText('state changed')).toBeInTheDocument();
      });
    });
  });

  describe('Activity cross-link', () => {
    it('shows View Activity link when execution has an activityId', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ activityId: 'act-42' }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('View Activity')).toBeInTheDocument();
      });
    });

    it('hides View Activity link when execution has no activityId', async () => {
      mockGetExecution.mockResolvedValue({ execution: makeExecution({ activityId: null }) });
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Execution')).toBeInTheDocument();
      });
      expect(screen.queryByText('View Activity')).not.toBeInTheDocument();
    });
  });
});
