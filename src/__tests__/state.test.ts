import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  responseCache,
  thinkingSteps,
  analysisCache,
  backgroundProcesses,
  startCleanupTimers,
  stopCleanupTimers,
} from '../state.js';

describe('state – cleanup logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    responseCache.clear();
    thinkingSteps.clear();
    analysisCache.clear();
    backgroundProcesses.clear();
  });

  afterEach(() => {
    stopCleanupTimers();
    vi.useRealTimers();
  });

  const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes, matches state.ts

  function triggerCleanup() {
    startCleanupTimers();
    vi.advanceTimersByTime(CLEANUP_INTERVAL + 1);
  }

  // ══════════════════════════════════════════════
  // Response cache expiry
  // ══════════════════════════════════════════════

  describe('response cache – TTL expiry', () => {
    it('should remove entries whose TTL has elapsed', () => {
      const now = Date.now();
      responseCache.set('short-lived', { response: 'a', timestamp: now, ttl: 1 });     // 1s TTL
      responseCache.set('long-lived', { response: 'b', timestamp: now, ttl: 3600 });   // 1h TTL

      triggerCleanup(); // advances 5 minutes

      expect(responseCache.has('short-lived')).toBe(false);
      expect(responseCache.has('long-lived')).toBe(true);
    });

    it('should keep entries that have not expired', () => {
      const now = Date.now();
      responseCache.set('k1', { response: 'v1', timestamp: now, ttl: 600 });  // 10 min TTL
      responseCache.set('k2', { response: 'v2', timestamp: now, ttl: 7200 }); // 2h TTL

      triggerCleanup();

      expect(responseCache.has('k1')).toBe(true);
      expect(responseCache.has('k2')).toBe(true);
    });

    it('should remove all expired entries in one sweep', () => {
      const now = Date.now();
      for (let i = 0; i < 50; i++) {
        responseCache.set(`expired-${i}`, { response: `v${i}`, timestamp: now, ttl: 1 });
      }
      responseCache.set('survivor', { response: 'ok', timestamp: now, ttl: 7200 });

      triggerCleanup();

      expect(responseCache.size).toBe(1);
      expect(responseCache.has('survivor')).toBe(true);
    });
  });

  // ══════════════════════════════════════════════
  // Response cache size limits (MAX_CACHE_SIZE = 1000)
  // ══════════════════════════════════════════════

  describe('response cache – size limit', () => {
    it('should trim to 1000 entries when over limit', () => {
      const now = Date.now();
      for (let i = 0; i < 1100; i++) {
        responseCache.set(`key${i}`, {
          response: `val${i}`,
          timestamp: now + i,  // ascending order so oldest = smallest i
          ttl: 999999,         // never expire
        });
      }
      expect(responseCache.size).toBe(1100);

      triggerCleanup();

      expect(responseCache.size).toBe(1000);
    });

    it('should evict oldest entries first', () => {
      const now = Date.now();
      for (let i = 0; i < 1100; i++) {
        responseCache.set(`key${i}`, {
          response: `val${i}`,
          timestamp: now + i,
          ttl: 999999,
        });
      }

      triggerCleanup();

      // Oldest 100 evicted (key0..key99)
      expect(responseCache.has('key0')).toBe(false);
      expect(responseCache.has('key99')).toBe(false);
      // Newest retained
      expect(responseCache.has('key100')).toBe(true);
      expect(responseCache.has('key1099')).toBe(true);
    });

    it('should not evict when exactly at limit', () => {
      const now = Date.now();
      for (let i = 0; i < 1000; i++) {
        responseCache.set(`key${i}`, { response: `v${i}`, timestamp: now + i, ttl: 999999 });
      }

      triggerCleanup();

      expect(responseCache.size).toBe(1000);
    });
  });

  // ══════════════════════════════════════════════
  // Analysis cache size limits (MAX_ANALYSIS_CACHE_SIZE = 500)
  // ══════════════════════════════════════════════

  describe('analysis cache – size limit', () => {
    it('should trim analysis cache to 500 entries', () => {
      const now = Date.now();
      for (let i = 0; i < 600; i++) {
        analysisCache.set(`analysis${i}`, {
          result: { metadata: {}, summary: { total_issues: 0, by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } }, issues: [] } as any,
          timestamp: now + i,
        });
      }
      expect(analysisCache.size).toBe(600);

      triggerCleanup();

      expect(analysisCache.size).toBe(500);
    });

    it('should evict oldest analysis entries first', () => {
      const now = Date.now();
      for (let i = 0; i < 600; i++) {
        analysisCache.set(`a${i}`, { result: {} as any, timestamp: now + i });
      }

      triggerCleanup();

      expect(analysisCache.has('a0')).toBe(false);
      expect(analysisCache.has('a99')).toBe(false);
      expect(analysisCache.has('a599')).toBe(true);
    });
  });

  // ══════════════════════════════════════════════
  // Thinking session cleanup (MAX_THINKING_SESSIONS = 100)
  // ══════════════════════════════════════════════

  describe('thinking sessions – purge old sessions', () => {
    it('should trim to 100 sessions when over limit', () => {
      for (let i = 0; i < 120; i++) {
        thinkingSteps.set(`session${i}`, [
          { step: 1, thought: `thought${i}`, timestamp: new Date().toISOString() },
        ]);
      }
      expect(thinkingSteps.size).toBe(120);

      triggerCleanup();

      expect(thinkingSteps.size).toBe(100);
    });

    it('should remove the earliest-inserted sessions (Map insertion order)', () => {
      for (let i = 0; i < 120; i++) {
        thinkingSteps.set(`s${i}`, [{ step: 1, thought: `t${i}`, timestamp: '' }]);
      }

      triggerCleanup();

      // First 20 sessions removed (s0..s19)
      expect(thinkingSteps.has('s0')).toBe(false);
      expect(thinkingSteps.has('s19')).toBe(false);
      // Later sessions retained
      expect(thinkingSteps.has('s20')).toBe(true);
      expect(thinkingSteps.has('s119')).toBe(true);
    });

    it('should not purge when exactly at limit', () => {
      for (let i = 0; i < 100; i++) {
        thinkingSteps.set(`s${i}`, [{ step: 1, thought: `t${i}`, timestamp: '' }]);
      }

      triggerCleanup();

      expect(thinkingSteps.size).toBe(100);
    });

    it('should not purge when under limit', () => {
      for (let i = 0; i < 50; i++) {
        thinkingSteps.set(`s${i}`, [{ step: 1, thought: `t${i}`, timestamp: '' }]);
      }

      triggerCleanup();

      expect(thinkingSteps.size).toBe(50);
    });
  });

  // ══════════════════════════════════════════════
  // Timer lifecycle
  // ══════════════════════════════════════════════

  describe('cleanup timer lifecycle', () => {
    it('should run cleanup periodically', () => {
      const now = Date.now();
      responseCache.set('expires-soon', { response: 'x', timestamp: now, ttl: 1 });

      startCleanupTimers();

      // Not yet cleaned
      expect(responseCache.has('expires-soon')).toBe(true);

      // After one interval
      vi.advanceTimersByTime(CLEANUP_INTERVAL + 1);
      expect(responseCache.has('expires-soon')).toBe(false);
    });

    it('should stop running after stopCleanupTimers', () => {
      const now = Date.now();

      startCleanupTimers();
      stopCleanupTimers();

      // Add expired entry after stopping
      responseCache.set('should-stay', { response: 'x', timestamp: now, ttl: 1 });

      // Advance past cleanup interval
      vi.advanceTimersByTime(CLEANUP_INTERVAL * 3);

      // Entry still there because timers are stopped
      expect(responseCache.has('should-stay')).toBe(true);
    });
  });
});
