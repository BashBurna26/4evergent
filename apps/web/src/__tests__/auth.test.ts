import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getStoredSubject,
  storeSubject,
  clearStoredSubject,
  getStoredToken,
  storeAuth,
  clearAuth,
} from '../auth';

describe('auth storage helpers', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  describe('subject', () => {
    it('returns null when nothing is stored', () => {
      expect(getStoredSubject()).toBeNull();
    });

    it('stores and reads the subject', () => {
      storeSubject('subject-abc');
      expect(getStoredSubject()).toBe('subject-abc');
    });

    it('clears the subject', () => {
      storeSubject('subject-abc');
      clearStoredSubject();
      expect(getStoredSubject()).toBeNull();
    });
  });

  describe('legacy bearer token', () => {
    it('returns null when nothing is stored', () => {
      expect(getStoredToken()).toBeNull();
    });

    it('stores and reads the token', () => {
      storeAuth('tok-123', 'sub-1');
      expect(getStoredToken()).toBe('tok-123');
    });

    it('storeAuth also stores the subject', () => {
      storeAuth('tok-123', 'sub-1');
      expect(getStoredSubject()).toBe('sub-1');
    });

    it('clearAuth removes both token and subject', () => {
      storeAuth('tok-123', 'sub-1');
      clearAuth();
      expect(getStoredToken()).toBeNull();
      expect(getStoredSubject()).toBeNull();
    });
  });

  describe('resilience when sessionStorage throws', () => {
    // The helpers swallow storage errors (private browsing, quota exceeded).
    // Each must degrade to null / no-op instead of propagating.

    it('getStoredSubject returns null when getItem throws', () => {
      const spy = vi
        .spyOn(window.sessionStorage, 'getItem')
        .mockImplementation(() => {
          throw new Error('SecurityError');
        });
      expect(getStoredSubject()).toBeNull();
      spy.mockRestore();
    });

    it('getStoredToken returns null when getItem throws', () => {
      const spy = vi
        .spyOn(window.sessionStorage, 'getItem')
        .mockImplementation(() => {
          throw new Error('SecurityError');
        });
      expect(getStoredToken()).toBeNull();
      spy.mockRestore();
    });

    it('storeSubject does not throw when setItem throws', () => {
      const spy = vi
        .spyOn(window.sessionStorage, 'setItem')
        .mockImplementation(() => {
          throw new Error('QuotaExceededError');
        });
      expect(() => storeSubject('sub')).not.toThrow();
      spy.mockRestore();
    });

    it('storeAuth does not throw when setItem throws', () => {
      const spy = vi
        .spyOn(window.sessionStorage, 'setItem')
        .mockImplementation(() => {
          throw new Error('QuotaExceededError');
        });
      expect(() => storeAuth('tok', 'sub')).not.toThrow();
      spy.mockRestore();
    });

    it('clearStoredSubject does not throw when removeItem throws', () => {
      const spy = vi
        .spyOn(window.sessionStorage, 'removeItem')
        .mockImplementation(() => {
          throw new Error('SecurityError');
        });
      expect(() => clearStoredSubject()).not.toThrow();
      spy.mockRestore();
    });

    it('clearAuth does not throw when removeItem throws', () => {
      const spy = vi
        .spyOn(window.sessionStorage, 'removeItem')
        .mockImplementation(() => {
          throw new Error('SecurityError');
        });
      expect(() => clearAuth()).not.toThrow();
      spy.mockRestore();
    });
  });
});
