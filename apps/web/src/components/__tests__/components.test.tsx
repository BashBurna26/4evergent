import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import {
  StatusBadge,
  AgentStatusBadge,
  Card,
  Skeleton,
  EmptyState,
  Amount,
  Address,
  PageHeader,
  LifecycleTrail,
  DetailCard,
  DataTable,
  Section,
  IntentAmount,
  Button,
  PaginationFooter,
} from '../index';

describe('Shared UI Components', () => {
  describe('StatusBadge', () => {
    // ActivityStatus: "pending" | "rejected" | "requires_approval" | "approved" | "signed" | "submitted" | "failed"
    // ExecutionStatus: "queued" | "executing" | "submitted" | "confirmed" | "failed" | "dead_letter"
    // ApprovalStatus: "pending_approval" | "approved" | "rejected" | "expired" | "executing" | "submitted" | "confirmed" | "failed"
    // Also from index.tsx: "active", "paused", "disabled", "retrying"

    const cases: Array<[string, string]> = [
      // badge-ok
      ['submitted', 'badge-ok'],
      ['confirmed', 'badge-ok'],
      ['active', 'badge-ok'],
      // badge-err
      ['failed', 'badge-err'],
      ['rejected', 'badge-err'],
      ['dead_letter', 'badge-err'],
      ['expired', 'badge-err'],
      ['disabled', 'badge-err'],
      // badge-warn
      ['requires_approval', 'badge-warn'],
      ['pending_approval', 'badge-warn'],
      ['paused', 'badge-warn'],
      // badge-info
      ['approved', 'badge-info'],
      ['signed', 'badge-info'],
      ['pending', 'badge-info'],
      ['executing', 'badge-info'],
      ['retrying', 'badge-info'],
      ['queued', 'badge-info'],
      // Unmapped status fallback
      ['unknown_status', 'badge-neutral'],
    ];

    cases.forEach(([status, expectedClass]) => {
      it(`renders status "${status}" with badge class "${expectedClass}"`, () => {
        const { container } = render(<StatusBadge status={status} />);
        const badge = container.querySelector('.badge');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveClass(expectedClass);
        expect(badge).toHaveTextContent(status);
      });
    });
  });

  describe('AgentStatusBadge', () => {
    it('renders "active" status with badge-ok class', () => {
      const { container } = render(<AgentStatusBadge status="active" />);
      const badge = container.querySelector('.badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass('badge-ok');
      expect(badge).toHaveTextContent('active');
    });

    it('renders "paused" status with badge-warn class', () => {
      const { container } = render(<AgentStatusBadge status="paused" />);
      const badge = container.querySelector('.badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass('badge-warn');
      expect(badge).toHaveTextContent('paused');
    });

    it('renders "disabled" status with badge-err class', () => {
      const { container } = render(<AgentStatusBadge status="disabled" />);
      const badge = container.querySelector('.badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass('badge-err');
      expect(badge).toHaveTextContent('disabled');
    });

    it('renders unknown status with badge-neutral class', () => {
      // Cast to test default branch behavior
      const { container } = render(<AgentStatusBadge status={'unknown' as any} />);
      const badge = container.querySelector('.badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass('badge-neutral');
      expect(badge).toHaveTextContent('unknown');
    });
  });

  describe('Address', () => {
    const sampleAddress = 'GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI';

    it('renders formatted address with default len=12', () => {
      render(<Address address={sampleAddress} />);
      // default len = 12 => slice(0, 6) + '…' + slice(-6)
      const expected = `${sampleAddress.slice(0, 6)}…${sampleAddress.slice(-6)}`;
      const elem = screen.getByRole('button', { name: `Copy address ${sampleAddress}` });
      expect(elem).toBeInTheDocument();
      expect(elem).toHaveTextContent(expected);
      expect(elem).toHaveAttribute('title', `${sampleAddress} (click to copy)`);
    });

    it('renders formatted address with custom len', () => {
      render(<Address address={sampleAddress} len={8} />);
      // len = 8 => slice(0, 4) + '…' + slice(-4)
      const expected = `${sampleAddress.slice(0, 4)}…${sampleAddress.slice(-4)}`;
      const elem = screen.getByRole('button', { name: `Copy address ${sampleAddress}` });
      expect(elem).toHaveTextContent(expected);
    });

    it('renders full address when address length is <= len', () => {
      const shortAddress = 'GBZXN7';
      render(<Address address={shortAddress} len={12} />);
      const elem = screen.getByRole('button', { name: `Copy address ${shortAddress}` });
      expect(elem).toHaveTextContent(shortAddress);
    });

    it('renders fallback muted dash when address is empty string', () => {
      const { container } = render(<Address address="" />);
      const muted = container.querySelector('.muted');
      expect(muted).toBeInTheDocument();
      expect(muted).toHaveTextContent('-');
    });

    it('copies address to clipboard on click', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: {
          writeText: writeTextMock,
        },
      });

      render(<Address address={sampleAddress} />);
      const elem = screen.getByRole('button', { name: `Copy address ${sampleAddress}` });
      fireEvent.click(elem);
      expect(writeTextMock).toHaveBeenCalledWith(sampleAddress);
    });

    it('copies address to clipboard on Enter and Space keypress', () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: {
          writeText: writeTextMock,
        },
      });

      render(<Address address={sampleAddress} />);
      const elem = screen.getByRole('button', { name: `Copy address ${sampleAddress}` });

      fireEvent.keyDown(elem, { key: 'Enter' });
      expect(writeTextMock).toHaveBeenCalledWith(sampleAddress);

      writeTextMock.mockClear();
      fireEvent.keyDown(elem, { key: ' ' });
      expect(writeTextMock).toHaveBeenCalledWith(sampleAddress);

      writeTextMock.mockClear();
      fireEvent.keyDown(elem, { key: 'Escape' });
      expect(writeTextMock).not.toHaveBeenCalled();
    });
  });

  describe('Amount', () => {
    it('renders amount without asset', () => {
      const { container } = render(<Amount value="100.5" />);
      const amountElem = container.querySelector('.amount');
      expect(amountElem).toBeInTheDocument();
      expect(amountElem).toHaveTextContent('100.5');
    });

    it('renders amount with asset', () => {
      const { container } = render(<Amount value="100.5" asset="XLM" />);
      const amountElem = container.querySelector('.amount');
      expect(amountElem).toBeInTheDocument();
      expect(amountElem).toHaveTextContent('100.5 XLM');
    });

    it('formats numeric amount with toLocaleString', () => {
      const { container } = render(<Amount value={1000000} asset="USDC" />);
      const amountElem = container.querySelector('.amount');
      expect(amountElem).toBeInTheDocument();
      expect(amountElem).toHaveTextContent(`${(1000000).toLocaleString()} USDC`);
    });
  });

  describe('IntentAmount', () => {
    it('renders amount and asset for payment intent', () => {
      const intent = {
        type: 'payment',
        amount: '250',
        asset: 'XLM',
      };
      const { container } = render(<IntentAmount intent={intent} />);
      const amountElem = container.querySelector('.amount');
      expect(amountElem).toBeInTheDocument();
      expect(amountElem).toHaveTextContent('250 XLM');
    });

    it('prefers assetDetails.code over asset for payment intent', () => {
      const intent = {
        type: 'payment',
        amount: '50',
        asset: 'native',
        assetDetails: { code: 'USDC' },
      };
      const { container } = render(<IntentAmount intent={intent} />);
      const amountElem = container.querySelector('.amount');
      expect(amountElem).toBeInTheDocument();
      expect(amountElem).toHaveTextContent('50 USDC');
    });

    it('renders fallback dash for trustline intent', () => {
      const intent = {
        type: 'trustline',
        asset: 'USDC',
      };
      const { container } = render(<IntentAmount intent={intent} />);
      const muted = container.querySelector('.muted');
      expect(muted).toBeInTheDocument();
      expect(muted).toHaveTextContent('-');
    });

    it('renders fallback dash for contract_call intent', () => {
      const intent = {
        type: 'contract_call',
      };
      const { container } = render(<IntentAmount intent={intent} />);
      const muted = container.querySelector('.muted');
      expect(muted).toBeInTheDocument();
      expect(muted).toHaveTextContent('-');
    });

    it('renders fallback dash for account_settings intent', () => {
      const intent = {
        type: 'account_settings',
      };
      const { container } = render(<IntentAmount intent={intent} />);
      const muted = container.querySelector('.muted');
      expect(muted).toBeInTheDocument();
      expect(muted).toHaveTextContent('-');
    });
  });

  describe('Skeleton and EmptyState', () => {
    it('renders Skeleton with the provided label', () => {
      render(<Skeleton label="Loading data..." />);
      const skeleton = screen.getByRole('status', { name: 'Loading data...' });
      expect(skeleton).toBeInTheDocument();
      expect(skeleton).toHaveTextContent('Loading data...');
    });

    it('renders EmptyState with title and message', () => {
      const { container } = render(<EmptyState title="No items" message="Nothing to display at this time." />);
      const emptyState = container.querySelector('.empty-state');
      expect(emptyState).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('No items');
      expect(screen.getByText('Nothing to display at this time.')).toBeInTheDocument();
    });
  });

  describe('LifecycleTrail', () => {
    it('renders active, completed, and pending step classes for mid-flow activeStep', () => {
      // mid-flow step 'approval' corresponds to idx = 3
      // Steps: Agent (0), Policy (1), Intent (2), Approval (3), Execution (4), Stellar (5), Confirmation (6), Activity (7)
      const { container } = render(<LifecycleTrail activeStep="approval" />);
      const trail = container.querySelector('.lifecycle-trail');
      expect(trail).toBeInTheDocument();

      const steps = container.querySelectorAll('.lifecycle-step');
      expect(steps.length).toBe(8);

      // Steps 0, 1, 2 are completed
      expect(steps[0]).toHaveClass('completed');
      expect(steps[0]).not.toHaveClass('current');

      expect(steps[1]).toHaveClass('completed');
      expect(steps[1]).not.toHaveClass('current');

      expect(steps[2]).toHaveClass('completed');
      expect(steps[2]).not.toHaveClass('current');

      // Step 3 (Approval) is current and completed
      expect(steps[3]).toHaveClass('completed');
      expect(steps[3]).toHaveClass('current');

      // Steps 4, 5, 6, 7 are pending (not completed and not current)
      expect(steps[4]).not.toHaveClass('completed');
      expect(steps[4]).not.toHaveClass('current');

      expect(steps[5]).not.toHaveClass('completed');
      expect(steps[5]).not.toHaveClass('current');

      expect(steps[6]).not.toHaveClass('completed');
      expect(steps[6]).not.toHaveClass('current');

      expect(steps[7]).not.toHaveClass('completed');
      expect(steps[7]).not.toHaveClass('current');
    });

    it('handles fallback activeStep defaulting to step 0', () => {
      const { container } = render(<LifecycleTrail activeStep="unknown_step" />);
      const steps = container.querySelectorAll('.lifecycle-step');
      expect(steps[0]).toHaveClass('completed');
      expect(steps[0]).toHaveClass('current');
      expect(steps[1]).not.toHaveClass('completed');
    });
  });

  describe('DataTable', () => {
    it('renders table with columns and rows', () => {
      const headers = ['ID', 'Name', 'Role'];
      const { container } = render(
        <DataTable headers={headers}>
          <tr>
            <td>1</td>
            <td>Alice</td>
            <td>Admin</td>
          </tr>
          <tr>
            <td>2</td>
            <td>Bob</td>
            <td>Member</td>
          </tr>
        </DataTable>
      );

      headers.forEach((h) => {
        expect(screen.getByText(h)).toBeInTheDocument();
      });

      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();

      const rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(2);
    });

    it('renders empty table when rows are empty', () => {
      const headers = ['Col 1', 'Col 2'];
      const { container } = render(
        <DataTable headers={headers}>
          {null}
        </DataTable>
      );

      headers.forEach((h) => {
        expect(screen.getByText(h)).toBeInTheDocument();
      });

      const rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(0);
    });
  });

  describe('Card', () => {
    it('renders title, value, and optional label', () => {
      const { rerender } = render(<Card title="Total Agents" value="42" label="+5 this week" />);
      expect(screen.getByText('Total Agents')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.getByText('+5 this week')).toBeInTheDocument();

      rerender(<Card title="Total Agents" value="42" />);
      expect(screen.queryByText('+5 this week')).not.toBeInTheDocument();
    });
  });

  describe('PageHeader', () => {
    it('renders title and optional subtitle', () => {
      const { rerender } = render(<PageHeader title="Approvals" subtitle="Manage pending transactions" />);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Approvals');
      expect(screen.getByText('Manage pending transactions')).toBeInTheDocument();

      rerender(<PageHeader title="Approvals" />);
      expect(screen.queryByText('Manage pending transactions')).not.toBeInTheDocument();
    });
  });

  describe('DetailCard', () => {
    it('renders title and children content', () => {
      render(
        <DetailCard title="Configuration">
          <span>Child Detail Content</span>
        </DetailCard>
      );
      expect(screen.getByText('Configuration')).toBeInTheDocument();
      expect(screen.getByText('Child Detail Content')).toBeInTheDocument();
    });
  });

  describe('Section', () => {
    it('renders title and children content', () => {
      render(
        <Section title="Overview Section">
          <p>Section body</p>
        </Section>
      );
      expect(screen.getByText('Overview Section')).toBeInTheDocument();
      expect(screen.getByText('Section body')).toBeInTheDocument();
    });
  });

  describe('Button and PaginationFooter', () => {
    it('renders Button with variants and responds to clicks', () => {
      const handleClick = vi.fn();
      const { rerender } = render(<Button onClick={handleClick}>Click Me</Button>);
      const btn = screen.getByRole('button', { name: 'Click Me' });
      expect(btn).toHaveClass('btn-primary');

      fireEvent.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(1);

      rerender(<Button onClick={handleClick} variant="secondary">Secondary</Button>);
      expect(screen.getByRole('button', { name: 'Secondary' })).toHaveClass('btn-secondary');

      rerender(<Button onClick={handleClick} variant="danger">Danger</Button>);
      expect(screen.getByRole('button', { name: 'Danger' })).toHaveClass('btn-danger');

      rerender(<Button onClick={handleClick} disabled>Disabled</Button>);
      expect(screen.getByRole('button', { name: 'Disabled' })).toBeDisabled();
    });

    it('renders PaginationFooter correctly when hasMore is true and false', () => {
      const handleLoadMore = vi.fn();
      const { rerender } = render(
        <PaginationFooter hasMore={true} loadingMore={false} onLoadMore={handleLoadMore} itemCount={25} />
      );

      expect(screen.getByText('25 shown')).toBeInTheDocument();
      const loadMoreBtn = screen.getByRole('button', { name: 'Load more' });
      expect(loadMoreBtn).toBeInTheDocument();

      fireEvent.click(loadMoreBtn);
      expect(handleLoadMore).toHaveBeenCalledTimes(1);

      // When loadingMore is true
      rerender(
        <PaginationFooter hasMore={true} loadingMore={true} onLoadMore={handleLoadMore} itemCount={25} />
      );
      expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();

      // When hasMore is false
      rerender(
        <PaginationFooter hasMore={false} loadingMore={false} onLoadMore={handleLoadMore} itemCount={25} />
      );
      expect(screen.queryByText('25 shown')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });
  });
});
