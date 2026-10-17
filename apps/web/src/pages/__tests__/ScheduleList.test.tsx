import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ScheduleList } from '../ScheduleList';

const {
  mockListSchedules,
  mockPauseSchedule,
  mockResumeSchedule,
  mockDisableSchedule,
} = vi.hoisted(() => ({
  mockListSchedules: vi.fn(),
  mockPauseSchedule: vi.fn(),
  mockResumeSchedule: vi.fn(),
  mockDisableSchedule: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listSchedules: mockListSchedules,
    pauseSchedule: mockPauseSchedule,
    resumeSchedule: mockResumeSchedule,
    disableSchedule: mockDisableSchedule,
  },
}));

describe('ScheduleList component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when no agentId is provided', () => {
    render(
      <MemoryRouter>
        <ScheduleList agentId="" />
      </MemoryRouter>
    );

    expect(screen.getByText('No agent specified.')).toBeInTheDocument();
    expect(mockListSchedules).not.toHaveBeenCalled();
  });

  it('renders loading skeleton when fetching schedules', () => {
    mockListSchedules.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <ScheduleList agentId="agent-1" />
      </MemoryRouter>
    );

    expect(screen.getByRole('status', { name: 'Loading schedules...' })).toBeInTheDocument();
  });

  it('renders error state and invokes onError when api rejects', async () => {
    const onError = vi.fn();
    mockListSchedules.mockRejectedValue(new Error('Failed to fetch schedules'));

    render(
      <MemoryRouter>
        <ScheduleList agentId="agent-1" onError={onError} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Failed to fetch schedules')).toBeInTheDocument();
    });
    expect(onError).toHaveBeenCalledWith('Failed to fetch schedules');
  });

  it('renders empty state when agent has no schedules', async () => {
    mockListSchedules.mockResolvedValue({
      schedules: [],
      hasMore: false,
    });

    render(
      <MemoryRouter>
        <ScheduleList agentId="agent-1" />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No schedules for this agent.')).toBeInTheDocument();
    });
  });

  it('renders schedules table with fetched data', async () => {
    mockListSchedules.mockResolvedValue({
      schedules: [
        {
          id: 'sched-12345678-abcd',
          agentId: 'agent-1',
          ownerId: 'owner-1',
          status: 'active',
          intent: { type: 'payment', asset: 'XLM', amount: '50' },
          scheduleExpression: '0 12 * * *',
          timezone: 'UTC',
          nextRunAt: '2026-03-01T12:00:00Z',
          lastRunAt: null,
          createdAt: '2026-02-01T10:00:00Z',
          updatedAt: '2026-02-01T10:00:00Z',
        },
      ],
      hasMore: false,
    });

    render(
      <MemoryRouter>
        <ScheduleList agentId="agent-1" />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('sched-12')).toBeInTheDocument();
    });

    expect(screen.getByText('0 12 * * *')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  describe('Schedule actions (pause, resume, disable)', () => {
    it('calls pauseSchedule when Pause button is clicked and refreshes list', async () => {
      mockListSchedules.mockResolvedValue({
        schedules: [
          {
            id: 'sched-active-1',
            agentId: 'agent-1',
            ownerId: 'owner-1',
            status: 'active',
            intent: { type: 'payment' },
            scheduleExpression: '0 0 * * *',
            timezone: 'UTC',
            nextRunAt: '2026-03-01T00:00:00Z',
            lastRunAt: null,
            createdAt: '2026-02-01T10:00:00Z',
            updatedAt: '2026-02-01T10:00:00Z',
          },
        ],
        hasMore: false,
      });
      mockPauseSchedule.mockResolvedValue({
        schedule: { id: 'sched-active-1', status: 'paused' },
      });

      render(
        <MemoryRouter>
          <ScheduleList agentId="agent-1" />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

      await waitFor(() => {
        expect(mockPauseSchedule).toHaveBeenCalledWith('agent-1', 'sched-active-1');
      });

      // Assert it reloads the schedule list
      expect(mockListSchedules).toHaveBeenCalledTimes(2);
      expect(mockListSchedules).toHaveBeenLastCalledWith('agent-1', 50, 0);
    });

    it('calls resumeSchedule when Resume button is clicked on paused schedule', async () => {
      mockListSchedules.mockResolvedValue({
        schedules: [
          {
            id: 'sched-paused-1',
            agentId: 'agent-1',
            ownerId: 'owner-1',
            status: 'paused',
            intent: { type: 'payment' },
            scheduleExpression: '0 0 * * *',
            timezone: 'UTC',
            nextRunAt: '2026-03-01T00:00:00Z',
            lastRunAt: null,
            createdAt: '2026-02-01T10:00:00Z',
            updatedAt: '2026-02-01T10:00:00Z',
          },
        ],
        hasMore: false,
      });
      mockResumeSchedule.mockResolvedValue({
        schedule: { id: 'sched-paused-1', status: 'active' },
      });

      render(
        <MemoryRouter>
          <ScheduleList agentId="agent-1" />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

      await waitFor(() => {
        expect(mockResumeSchedule).toHaveBeenCalledWith('agent-1', 'sched-paused-1');
      });

      expect(mockListSchedules).toHaveBeenCalledTimes(2);
    });

    it('calls resumeSchedule on disabled schedule which only has Resume button', async () => {
      mockListSchedules.mockResolvedValue({
        schedules: [
          {
            id: 'sched-disabled-1',
            agentId: 'agent-1',
            ownerId: 'owner-1',
            status: 'disabled',
            intent: { type: 'payment' },
            scheduleExpression: '0 0 * * *',
            timezone: 'UTC',
            nextRunAt: '2026-03-01T00:00:00Z',
            lastRunAt: null,
            createdAt: '2026-02-01T10:00:00Z',
            updatedAt: '2026-02-01T10:00:00Z',
          },
        ],
        hasMore: false,
      });
      mockResumeSchedule.mockResolvedValue({
        schedule: { id: 'sched-disabled-1', status: 'active' },
      });

      render(
        <MemoryRouter>
          <ScheduleList agentId="agent-1" />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

      await waitFor(() => {
        expect(mockResumeSchedule).toHaveBeenCalledWith('agent-1', 'sched-disabled-1');
      });
    });

    it('calls disableSchedule when Disable button is clicked', async () => {
      mockListSchedules.mockResolvedValue({
        schedules: [
          {
            id: 'sched-active-2',
            agentId: 'agent-1',
            ownerId: 'owner-1',
            status: 'active',
            intent: { type: 'payment' },
            scheduleExpression: '0 0 * * *',
            timezone: 'UTC',
            nextRunAt: '2026-03-01T00:00:00Z',
            lastRunAt: null,
            createdAt: '2026-02-01T10:00:00Z',
            updatedAt: '2026-02-01T10:00:00Z',
          },
        ],
        hasMore: false,
      });
      mockDisableSchedule.mockResolvedValue({
        schedule: { id: 'sched-active-2', status: 'disabled' },
      });

      render(
        <MemoryRouter>
          <ScheduleList agentId="agent-1" />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

      await waitFor(() => {
        expect(mockDisableSchedule).toHaveBeenCalledWith('agent-1', 'sched-active-2');
      });

      expect(mockListSchedules).toHaveBeenCalledTimes(2);
    });

    it('invokes onError when an action fails', async () => {
      const onError = vi.fn();
      mockListSchedules.mockResolvedValue({
        schedules: [
          {
            id: 'sched-active-3',
            agentId: 'agent-1',
            ownerId: 'owner-1',
            status: 'active',
            intent: { type: 'payment' },
            scheduleExpression: '0 0 * * *',
            timezone: 'UTC',
            nextRunAt: '2026-03-01T00:00:00Z',
            lastRunAt: null,
            createdAt: '2026-02-01T10:00:00Z',
            updatedAt: '2026-02-01T10:00:00Z',
          },
        ],
        hasMore: false,
      });
      mockPauseSchedule.mockRejectedValue(new Error('Action authorization failed'));

      render(
        <MemoryRouter>
          <ScheduleList agentId="agent-1" onError={onError} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith('Action authorization failed');
      });
    });
  });

  it('supports pagination via loadMore when hasMore is true', async () => {
    mockListSchedules.mockResolvedValueOnce({
      schedules: [
        {
          id: 'sched-p1',
          agentId: 'agent-1',
          ownerId: 'owner-1',
          status: 'active',
          intent: { type: 'payment' },
          scheduleExpression: '0 1 * * *',
          timezone: 'UTC',
          nextRunAt: '2026-03-01T01:00:00Z',
          lastRunAt: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
      hasMore: true,
    });

    render(
      <MemoryRouter>
        <ScheduleList agentId="agent-1" />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Load more/i })).toBeInTheDocument();
    });

    mockListSchedules.mockResolvedValueOnce({
      schedules: [
        {
          id: 'sched-p2',
          agentId: 'agent-1',
          ownerId: 'owner-1',
          status: 'active',
          intent: { type: 'payment' },
          scheduleExpression: '0 2 * * *',
          timezone: 'UTC',
          nextRunAt: '2026-03-01T02:00:00Z',
          lastRunAt: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
      hasMore: false,
    });

    fireEvent.click(screen.getByRole('button', { name: /Load more/i }));

    await waitFor(() => {
      expect(mockListSchedules).toHaveBeenCalledWith('agent-1', 50, 1);
    });

    await waitFor(() => {
      expect(screen.getByText('0 2 * * *')).toBeInTheDocument();
    });
  });

  it('reads agentId from route params when not passed in props', async () => {
    mockListSchedules.mockResolvedValue({
      schedules: [],
      hasMore: false,
    });

    render(
      <MemoryRouter initialEntries={['/agents/route-agent-999/schedules']}>
        <Routes>
          <Route
            path="/agents/:agentId/schedules"
            element={<ScheduleList agentId={undefined as any} />}
          />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockListSchedules).toHaveBeenCalledWith('route-agent-999', 50, 0);
    });
  });
});
