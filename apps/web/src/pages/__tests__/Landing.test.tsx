import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Landing from '../Landing';

vi.mock('../../api', () => ({
  api: {},
}));

describe('Landing page', () => {
  it('renders landing page branding and header navigation', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getAllByText('4evergent').length).toBeGreaterThan(0);

    const headerNav = screen.getByRole('navigation', { name: 'Landing sections' });
    expect(within(headerNav).getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      'https://github.com/naninu123/4evergent/tree/main/docs'
    );
    expect(within(headerNav).getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      'https://github.com/naninu123/4evergent'
    );
    expect(within(headerNav).getByRole('link', { name: 'Community' })).toHaveAttribute(
      'href',
      'https://github.com/naninu123/4evergent#readme'
    );
  });

  it('renders hero section and call to action', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/AutonomousFinancial Agents/);
    expect(screen.getByRole('link', { name: 'Get Started' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: /View docs/i })).toHaveAttribute(
      'href',
      'https://github.com/naninu123/4evergent/tree/main/docs'
    );
    expect(screen.getByRole('link', { name: 'Read the source' })).toHaveAttribute(
      'href',
      'https://github.com/naninu123/4evergent'
    );
    expect(screen.getByRole('img', { name: /Diagram: typed payment and trustline intents/i })).toBeInTheDocument();
  });

  it('renders all pipeline stages', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    const stages = [
      'Agent',
      'Intent',
      'Policy',
      'Approval',
      'Simulation',
      'Execution',
      'Stellar',
      'Activity',
    ];

    stages.forEach((stage) => {
      expect(screen.getAllByText(stage).length).toBeGreaterThan(0);
    });
  });

  it('renders capabilities section', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    expect(screen.getByText("Built for what's next.")).toBeInTheDocument();
    expect(screen.getByText('Persistent identity, Stellar address and a capability set.')).toBeInTheDocument();
    expect(screen.getByText('Tx and daily limits, allowed assets, destinations and contracts.')).toBeInTheDocument();
    expect(screen.getByText('Schema-typed payment and trustline requests.')).toBeInTheDocument();
    expect(screen.getByText('Fee, operations and warnings before any signature.')).toBeInTheDocument();
    expect(screen.getByText('Threshold-triggered human gate with expiry.')).toBeInTheDocument();
    expect(screen.getByText('One coordinated writer per account, retry and dead-letter.')).toBeInTheDocument();
    expect(screen.getByText('Recurring intents — active, paused or disabled.')).toBeInTheDocument();
    expect(screen.getByText('Every decision, simulation and transaction recorded.')).toBeInTheDocument();
  });

  it('renders testnet section and footer links', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    expect(screen.getByText('Try it on Stellar Testnet')).toBeInTheDocument();
    expect(screen.getByText('Secure. Compliant. Programmable.')).toBeInTheDocument();

    const footerNav = screen.getByRole('navigation', { name: 'Footer links' });
    expect(within(footerNav).getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      'https://github.com/naninu123/4evergent'
    );
    expect(within(footerNav).getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      'https://github.com/naninu123/4evergent/tree/main/docs'
    );
    expect(within(footerNav).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login'
    );
  });
});
