import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Login from '../Login';

const {
  mockAuthConfig,
  mockAuthStartUrl,
  mockLoginEmail,
  mockRegister,
  mockStellarChallenge,
  mockStellarVerify,
  mockIsConnected,
  mockRequestAccess,
  mockSignMessage,
  mockStoreSubject,
  mockClearAuth,
} = vi.hoisted(() => ({
  mockAuthConfig: vi.fn(),
  mockAuthStartUrl: vi.fn().mockReturnValue('http://localhost:3000/auth/google/start'),
  mockLoginEmail: vi.fn(),
  mockRegister: vi.fn(),
  mockStellarChallenge: vi.fn(),
  mockStellarVerify: vi.fn(),
  mockIsConnected: vi.fn(),
  mockRequestAccess: vi.fn(),
  mockSignMessage: vi.fn(),
  mockStoreSubject: vi.fn(),
  mockClearAuth: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    authConfig: mockAuthConfig,
    authStartUrl: mockAuthStartUrl,
    loginEmail: mockLoginEmail,
    register: mockRegister,
    stellarChallenge: mockStellarChallenge,
    stellarVerify: mockStellarVerify,
  },
}));

vi.mock('@stellar/freighter-api', () => ({
  isConnected: mockIsConnected,
  requestAccess: mockRequestAccess,
  signMessage: mockSignMessage,
}));

vi.mock('../../auth', () => ({
  storeSubject: mockStoreSubject,
  clearAuth: mockClearAuth,
}));

describe('Login page', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthConfig.mockResolvedValue({
      email: true,
      google: true,
      stellar: true,
      registration: true,
    });

    delete (window as any).location;
    (window as any).location = {
      ...originalLocation,
      href: 'http://localhost/',
      search: '',
    };
  });

  afterEach(() => {
    (window as any).location = originalLocation;
  });

  it('renders auth form with Google, Freighter, and email options', async () => {
    render(
      <MemoryRouter>
        <Login onSuccess={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Connect with Freighter/i })).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders fallback when authConfig fails', async () => {
    mockAuthConfig.mockRejectedValue(new Error('Config error'));
    render(
      <MemoryRouter>
        <Login onSuccess={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Continue with Google/i })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('surfaces Google auth error query param from URL', async () => {
    (window as any).location.search = '?auth_error=google_failed';
    render(
      <MemoryRouter>
        <Login onSuccess={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Google sign-in failed. Please try again.')).toBeInTheDocument();
    });
  });

  describe('Email authentication flow', () => {
    it('successfully logs in with valid email credentials', async () => {
      const onSuccess = vi.fn();
      mockLoginEmail.mockResolvedValue({ subject: 'user-sub-1' });

      render(
        <MemoryRouter>
          <Login onSuccess={onSuccess} />
        </MemoryRouter>
      );

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'alice@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => {
        expect(mockLoginEmail).toHaveBeenCalledWith({
          email: 'alice@example.com',
          password: 'password123',
        });
      });

      expect(mockClearAuth).toHaveBeenCalled();
      expect(mockStoreSubject).toHaveBeenCalledWith('user-sub-1');
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('shows error message on invalid_credentials error', async () => {
      const onSuccess = vi.fn();
      mockLoginEmail.mockRejectedValue(new Error('invalid_credentials'));

      render(
        <MemoryRouter>
          <Login onSuccess={onSuccess} />
        </MemoryRouter>
      );

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'wrong@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrongpass' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => {
        expect(screen.getByText('Invalid email or password.')).toBeInTheDocument();
      });
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('shows specific messages for invalid_email and generic errors', async () => {
      mockLoginEmail.mockRejectedValueOnce(new Error('invalid_email'));

      render(
        <MemoryRouter>
          <Login onSuccess={vi.fn()} />
        </MemoryRouter>
      );

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'notanemail@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => {
        expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
      });

      mockLoginEmail.mockRejectedValueOnce(new Error('unknown_network_error'));
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => {
        expect(screen.getByText('Authentication failed.')).toBeInTheDocument();
      });
    });

    it('supports switching to register mode and registering a new account', async () => {
      const onSuccess = vi.fn();
      mockRegister.mockResolvedValue({ subject: 'user-new-sub' });

      render(
        <MemoryRouter>
          <Login onSuccess={onSuccess} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
      });

      // Switch to register mode
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

      expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bob@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });

      const form = screen.getByLabelText('Email').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(mockRegister).toHaveBeenCalledWith({
          email: 'bob@example.com',
          password: 'password123',
        });
      });

      expect(mockStoreSubject).toHaveBeenCalledWith('user-new-sub');
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('handles register error for email_registered and weak_password', async () => {
      mockRegister.mockRejectedValueOnce(new Error('email_registered'));

      render(
        <MemoryRouter>
          <Login onSuccess={vi.fn()} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'existing@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });

      const form = screen.getByLabelText('Email').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText('That email is already registered. Sign in instead.')).toBeInTheDocument();
      });

      mockRegister.mockRejectedValueOnce(new Error('weak_password'));
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument();
      });
    });
  });

  describe('Google OAuth flow', () => {
    it('navigates to authStartUrl on clicking Google button', async () => {
      render(
        <MemoryRouter>
          <Login onSuccess={vi.fn()} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Continue with Google/i }));

      expect(mockAuthStartUrl).toHaveBeenCalled();
      expect(window.location.href).toBe('http://localhost:3000/auth/google/start');
    });
  });

  describe('Freighter wallet flow', () => {
    it('completes challenge -> sign -> verify flow successfully', async () => {
      const onSuccess = vi.fn();
      mockIsConnected.mockResolvedValue({ isConnected: true });
      mockRequestAccess.mockResolvedValue({ address: 'GBFREIGHTER123456789' });
      mockStellarChallenge.mockResolvedValue({
        challengeId: 'challenge-xyz',
        message: 'Sign this challenge string',
        expiresAt: '2026-01-01T00:00:00Z',
        network: 'testnet',
      });
      mockSignMessage.mockResolvedValue({
        signedMessage: 'signature-base64-content',
      });
      mockStellarVerify.mockResolvedValue({
        subject: 'user-freighter-sub',
      });

      render(
        <MemoryRouter>
          <Login onSuccess={onSuccess} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Connect with Freighter/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Connect with Freighter/i }));

      await waitFor(() => {
        expect(mockIsConnected).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(mockRequestAccess).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(mockStellarChallenge).toHaveBeenCalledWith('GBFREIGHTER123456789');
      });

      await waitFor(() => {
        expect(mockSignMessage).toHaveBeenCalledWith('Sign this challenge string', {
          networkPassphrase: 'Test SDF Network ; September 2015',
          address: 'GBFREIGHTER123456789',
        });
      });

      await waitFor(() => {
        expect(mockStellarVerify).toHaveBeenCalledWith({
          publicKey: 'GBFREIGHTER123456789',
          challengeId: 'challenge-xyz',
          signature: 'signature-base64-content',
        });
      });

      expect(mockClearAuth).toHaveBeenCalled();
      expect(mockStoreSubject).toHaveBeenCalledWith('user-freighter-sub');
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('shows wallet_not_found error when Freighter is not installed', async () => {
      const onSuccess = vi.fn();
      mockIsConnected.mockResolvedValue({ isConnected: false });

      render(
        <MemoryRouter>
          <Login onSuccess={onSuccess} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Connect with Freighter/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Connect with Freighter/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Stellar wallet not found. Install Freighter to continue.')
        ).toBeInTheDocument();
      });

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('shows user_rejected error when wallet access is rejected', async () => {
      const onSuccess = vi.fn();
      mockIsConnected.mockResolvedValue({ isConnected: true });
      mockRequestAccess.mockResolvedValue({
        error: { message: 'user_rejected' },
      });

      render(
        <MemoryRouter>
          <Login onSuccess={onSuccess} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Connect with Freighter/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Connect with Freighter/i }));

      await waitFor(() => {
        expect(screen.getByText('Signing was rejected in your wallet.')).toBeInTheDocument();
      });

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('shows user_rejected error when message signing is rejected', async () => {
      const onSuccess = vi.fn();
      mockIsConnected.mockResolvedValue({ isConnected: true });
      mockRequestAccess.mockResolvedValue({ address: 'GBFREIGHTER123456789' });
      mockStellarChallenge.mockResolvedValue({
        challengeId: 'challenge-xyz',
        message: 'Sign this challenge string',
      });
      mockSignMessage.mockResolvedValue({
        error: { message: 'user_rejected' },
      });

      render(
        <MemoryRouter>
          <Login onSuccess={onSuccess} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Connect with Freighter/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Connect with Freighter/i }));

      await waitFor(() => {
        expect(screen.getByText('Signing was rejected in your wallet.')).toBeInTheDocument();
      });

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('handles generic wallet failure', async () => {
      const onSuccess = vi.fn();
      mockIsConnected.mockResolvedValue({ isConnected: true });
      mockRequestAccess.mockResolvedValue({ address: 'GBFREIGHTER123456789' });
      mockStellarChallenge.mockRejectedValue(new Error('Network failure'));

      render(
        <MemoryRouter>
          <Login onSuccess={onSuccess} />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Connect with Freighter/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Connect with Freighter/i }));

      await waitFor(() => {
        expect(screen.getByText('Wallet authentication failed.')).toBeInTheDocument();
      });

      expect(onSuccess).not.toHaveBeenCalled();
    });
  });
});
