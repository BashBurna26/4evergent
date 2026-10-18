import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Agents from '../Agents';

const { mockListAgents, mockCreateAgent } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockCreateAgent: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listAgents: mockListAgents,
    createAgent: mockCreateAgent,
  },
}));

describe('Agents page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state on mount', () => {
    mockListAgents.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    expect(screen.getByText('Loading agents...')).toBeInTheDocument();
  });

  it('renders error state when api.listAgents fails', async () => {
    mockListAgents.mockRejectedValue(new Error('Failed to fetch agents'));
    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Failed to load agents')).toBeInTheDocument();
      expect(screen.getByText('Failed to fetch agents')).toBeInTheDocument();
    });
  });

  it('renders empty state when there are no agents', async () => {
    mockListAgents.mockResolvedValue({ agents: [] });
    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No agents yet')).toBeInTheDocument();
      expect(
        screen.getByText('Create your first agent to start submitting intents and schedules.')
      ).toBeInTheDocument();
    });
  });

  it('renders table with fetched agents data', async () => {
    mockListAgents.mockResolvedValue({
      agents: [
        {
          id: 'agent-1',
          displayName: 'Treasury Agent',
          description: 'Autonomous payment agent',
          ownerId: 'owner-1',
          stellarAddress: 'GBAGENT12345678901234567890',
          capabilities: ['payment', 'trustline'],
          status: 'active',
          active: true,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Treasury Agent')).toBeInTheDocument();
    });

    expect(screen.getByText('GBAGENT12345678901234567890')).toBeInTheDocument();
    expect(screen.getByText('payment, trustline')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/agents/agent-1');
  });

  describe('Create Agent modal', () => {
    it('opens create modal when clicking Create Agent button', async () => {
      mockListAgents.mockResolvedValue({ agents: [] });
      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      expect(screen.getByRole('heading', { name: 'Create Agent' })).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText(/Description/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Capabilities/i)).toBeInTheDocument();
    });

    it('shows validation error when name is empty', async () => {
      mockListAgents.mockResolvedValue({ agents: [] });
      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      // Submit with empty name
      const form = screen.getByLabelText('Name').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeInTheDocument();
      });

      expect(mockCreateAgent).not.toHaveBeenCalled();
    });

    it('submits form with valid input and calls api.createAgent with expected body', async () => {
      mockListAgents.mockResolvedValue({ agents: [] });
      mockCreateAgent.mockResolvedValue({
        agent: {
          id: 'agent-new-123',
          displayName: 'Yield Agent',
          description: 'Automates yield strategies',
          ownerId: 'owner-1',
          stellarAddress: 'GBYIELD12345',
          capabilities: ['payment', 'trustline'],
          status: 'active',
          active: true,
          createdAt: '2026-02-01T00:00:00Z',
          updatedAt: '2026-02-01T00:00:00Z',
        },
      });

      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Yield Agent' } });
      fireEvent.change(screen.getByLabelText(/Description/i), {
        target: { value: 'Automates yield strategies' },
      });
      fireEvent.change(screen.getByLabelText(/Capabilities/i), {
        target: { value: 'payment, trustline' },
      });

      const form = screen.getByLabelText('Name').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledWith({
          displayName: 'Yield Agent',
          description: 'Automates yield strategies',
          capabilities: ['payment', 'trustline'],
        });
      });

      // Modal closes on success
      await waitFor(() => {
        expect(screen.queryByRole('heading', { name: 'Create Agent' })).not.toBeInTheDocument();
      });
    });

    it('shows API error when createAgent rejects', async () => {
      mockListAgents.mockResolvedValue({ agents: [] });
      mockCreateAgent.mockRejectedValue(new Error('Agent name already exists'));

      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Duplicate Agent' } });

      const form = screen.getByLabelText('Name').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText('Agent name already exists')).toBeInTheDocument();
      });
    });

    it('closes modal when clicking Cancel button', async () => {
      mockListAgents.mockResolvedValue({ agents: [] });
      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
      expect(screen.getByRole('heading', { name: 'Create Agent' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('heading', { name: 'Create Agent' })).not.toBeInTheDocument();
    });
  });
});
