import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { CooldownManager } from '../runtime/cooldown-manager';
import { setConfigForTesting } from '../../config';

// A failure only escalates the backoff once the previous cooldown has lapsed
// (failures during an active cooldown are in-flight requests from the same
// incident). Jump the clock past any cooldown, then record the next failure.
async function failAfterCooldownLapses(cm: CooldownManager, provider: string, model: string) {
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
  await cm.markProviderFailure(provider, model);
}

describe('CooldownManager', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    CooldownManager.resetInstance();
    await CooldownManager.getInstance().clearCooldown();
  });

  afterEach(async () => {
    await CooldownManager.getInstance().clearCooldown();
    CooldownManager.resetInstance();
    vi.useRealTimers();
  });

  describe('exponential backoff', () => {
    test('first failure uses initial duration (2 minutes default)', async () => {
      setConfigForTesting({
        providers: {},
        models: {},
        keys: {},
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cm = CooldownManager.getInstance();
      const before = Date.now();

      await cm.markProviderFailure('test-provider', 'test-model');

      const cooldowns = cm.getCooldowns();
      expect(cooldowns).toHaveLength(1);

      const cooldown = cooldowns[0]!;
      // First failure should be ~2 minutes (120 seconds), allowing some tolerance
      const duration = cooldown.expiry - before;
      expect(duration).toBeGreaterThanOrEqual(115000); // ~2 minutes
      expect(duration).toBeLessThanOrEqual(125000);
      expect(cooldown.consecutiveFailures).toBe(1);
    });

    test('second failure doubles the duration (4 minutes)', async () => {
      setConfigForTesting({
        providers: {},
        models: {},
        keys: {},
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cm = CooldownManager.getInstance();

      // First failure
      await cm.markProviderFailure('test-provider', 'test-model');

      // Clear and simulate second failure
      await cm.clearCooldown('test-provider', 'test-model');
      await cm.markProviderFailure('test-provider', 'test-model');
      await failAfterCooldownLapses(cm, 'test-provider', 'test-model');

      const cooldowns = cm.getCooldowns();
      const cooldown = cooldowns[0]!;
      const duration = cooldown.expiry - Date.now();

      // Second failure should be ~4 minutes (240 seconds)
      expect(duration).toBeGreaterThanOrEqual(235000); // ~4 minutes
      expect(duration).toBeLessThanOrEqual(245000);
      expect(cooldown.consecutiveFailures).toBe(2);
    });

    test('exponential progression follows 2^n pattern', async () => {
      setConfigForTesting({
        providers: {},
        models: {},
        keys: {},
        cooldown: { initialMinutes: 1, maxMinutes: 60 },
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cm = CooldownManager.getInstance();
      const provider = 'exp-test';
      const model = 'exp-model';

      // Expected durations with 1-minute initial, max 60 minutes
      // n=0: 1 min, n=1: 2 min, n=2: 4 min, n=3: 8 min, n=4: 16 min, n=5: 32 min, n=6: 60 min (capped)
      const expectedMinutes = [1, 2, 4, 8, 16, 32, 60, 60];

      for (let i = 0; i < expectedMinutes.length; i++) {
        await cm.clearCooldown(provider, model);

        // Mark failure i+1 times
        await cm.markProviderFailure(provider, model);
        for (let j = 1; j <= i; j++) {
          await failAfterCooldownLapses(cm, provider, model);
        }

        const cooldowns = cm.getCooldowns().filter((c) => c.provider === provider);
        expect(cooldowns).toHaveLength(1);

        const cooldown = cooldowns[0]!;
        const durationMinutes = Math.round(cooldown.timeRemainingMs / 60000);
        expect(durationMinutes).toBe(expectedMinutes[i]!);
        expect(cooldown.consecutiveFailures).toBe(i + 1);
      }
    });

    test('respects max cooldown cap from config', async () => {
      setConfigForTesting({
        providers: {},
        models: {},
        keys: {},
        cooldown: { initialMinutes: 2, maxMinutes: 10 }, // 10 minute cap
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cm = CooldownManager.getInstance();
      const provider = 'cap-test';
      const model = 'cap-model';

      // Force many failures to hit the cap
      for (let i = 0; i < 10; i++) {
        await failAfterCooldownLapses(cm, provider, model);
      }

      const cooldowns = cm.getCooldowns().filter((c) => c.provider === provider);
      const cooldown = cooldowns[0]!;
      const durationMinutes = Math.round(cooldown.timeRemainingMs / 60000);

      // Should be capped at 10 minutes, not 2^10 * 2 = 2048 minutes
      expect(durationMinutes).toBeLessThanOrEqual(10);
      expect(durationMinutes).toBeGreaterThanOrEqual(9);
    });

    test('failures during an active cooldown do not escalate it', async () => {
      setConfigForTesting({
        providers: {},
        models: {},
        keys: {},
        cooldown: { initialMinutes: 2, maxMinutes: 300 },
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cm = CooldownManager.getInstance();
      const start = Date.now();

      // One upstream overload, four requests in flight: 2026-10-15 incident.
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(start + i * 1000);
        await cm.markProviderFailure('burst', 'model');
      }

      const [cooldown] = cm.getCooldowns().filter((c) => c.provider === 'burst');
      expect(cooldown!.consecutiveFailures).toBe(1);
      expect(cooldown!.expiry).toBe(start + 2 * 60 * 1000);
    });

    test('an explicit duration (429 retry-after, quota) still overrides an active cooldown', async () => {
      const cm = CooldownManager.getInstance();
      const start = Date.now();

      await cm.markProviderFailure('explicit', 'model');
      await cm.markProviderFailure('explicit', 'model', 30 * 60 * 1000, 'rate limited');

      const [cooldown] = cm.getCooldowns().filter((c) => c.provider === 'explicit');
      expect(cooldown!.expiry).toBe(start + 30 * 60 * 1000);
      expect(cooldown!.consecutiveFailures).toBe(2);
      expect(cooldown!.lastError).toBe('rate limited');
    });
  });

  describe('getSoonestRecoveryMs', () => {
    test('returns null when no target is cooling down', () => {
      const cm = CooldownManager.getInstance();
      expect(cm.getSoonestRecoveryMs([{ provider: 'a', model: 'm' }])).toBeNull();
    });

    test('returns the earliest recovery across targets, honouring provider-wide cooldowns', async () => {
      const cm = CooldownManager.getInstance();

      await cm.markProviderFailure('a', 'm', 90_000);
      await cm.markProviderFailure('b', 'm', 30_000);
      // b is also quota-blocked provider-wide for 10 minutes, so it recovers later than a.
      await cm.markProviderFailure('b', '', 600_000);

      expect(
        cm.getSoonestRecoveryMs([
          { provider: 'a', model: 'm' },
          { provider: 'b', model: 'm' },
        ])
      ).toBe(90_000);
      expect(cm.getSoonestRecoveryMs([{ provider: 'b', model: 'm' }])).toBe(600_000);
    });
  });

  describe('markProviderSuccess', () => {
    test('resets consecutive failure count', async () => {
      setConfigForTesting({
        providers: {},
        models: {},
        keys: {},
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cm = CooldownManager.getInstance();
      const provider = 'success-test';
      const model = 'success-model';

      // Create multiple failures
      await cm.markProviderFailure(provider, model);
      await failAfterCooldownLapses(cm, provider, model);
      await failAfterCooldownLapses(cm, provider, model);

      let cooldowns = cm.getCooldowns().filter((c) => c.provider === provider);
      expect(cooldowns[0]!.consecutiveFailures).toBe(3);

      // Mark success
      await cm.markProviderSuccess(provider, model);

      // Cooldown should be cleared
      cooldowns = cm.getCooldowns().filter((c) => c.provider === provider);
      expect(cooldowns).toHaveLength(0);

      // Next failure should be treated as first
      await cm.markProviderFailure(provider, model);
      cooldowns = cm.getCooldowns().filter((c) => c.provider === provider);
      expect(cooldowns[0]!.consecutiveFailures).toBe(1);
    });

    test('success on non-cooled provider does nothing', async () => {
      const cm = CooldownManager.getInstance();

      // Should not throw
      await cm.markProviderSuccess('never-failed', 'model');

      const cooldowns = cm.getCooldowns().filter((c) => c.provider === 'never-failed');
      expect(cooldowns).toHaveLength(0);
    });
  });

  describe('getCooldowns', () => {
    test('returns cooldown with consecutiveFailures', async () => {
      setConfigForTesting({
        providers: {},
        models: {},
        keys: {},
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cm = CooldownManager.getInstance();

      await cm.markProviderFailure('p1', 'm1');
      await failAfterCooldownLapses(cm, 'p1', 'm1');
      await cm.markProviderFailure('p2', 'm2');

      const cooldowns = cm.getCooldowns();

      const p1 = cooldowns.find((c) => c.provider === 'p1');
      const p2 = cooldowns.find((c) => c.provider === 'p2');

      expect(p1?.consecutiveFailures).toBe(2);
      expect(p2?.consecutiveFailures).toBe(1);
    });

    test('does not create cooldown for providers with disable_cooldown=true', async () => {
      setConfigForTesting({
        providers: {
          synthetic_new: {
            api_base_url: 'https://example.com/v1',
            api_key: 'test-key',
            disable_cooldown: true,
          },
        },
        models: {},
        keys: {},
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cm = CooldownManager.getInstance();
      await cm.markProviderFailure('synthetic_new', 'test-model');

      const cooldowns = cm.getCooldowns();
      expect(cooldowns.some((c) => c.provider === 'synthetic_new')).toBe(false);
    });

    test('does not create cooldown when lastError indicates deadline expired', async () => {
      const cm = CooldownManager.getInstance();
      await cm.markProviderFailure(
        'google-s',
        'gemini-3.6-flash',
        undefined,
        '503 Deadline expired before operation could complete.'
      );

      const cooldowns = cm.getCooldowns();
      expect(cooldowns.some((c) => c.provider === 'google-s')).toBe(false);
    });

    test('filters existing cooldowns when provider switches to disable_cooldown=true', async () => {
      const cm = CooldownManager.getInstance();

      setConfigForTesting({
        providers: {
          synthetic_new: {
            api_base_url: 'https://example.com/v1',
            api_key: 'test-key',
            disable_cooldown: false,
          },
        },
        models: {},
        keys: {},
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      await cm.markProviderFailure('synthetic_new', 'test-model');
      expect(cm.getCooldowns().some((c) => c.provider === 'synthetic_new')).toBe(true);

      setConfigForTesting({
        providers: {
          synthetic_new: {
            api_base_url: 'https://example.com/v1',
            api_key: 'test-key',
            disable_cooldown: true,
          },
        },
        models: {},
        keys: {},
        failover: { enabled: false, retryableStatusCodes: [], retryableErrors: [] },
        quotas: [],
      } as any);

      const cooldowns = cm.getCooldowns();
      expect(cooldowns.some((c) => c.provider === 'synthetic_new')).toBe(false);
    });
  });

  describe('clearCooldown', () => {
    test('clears specific provider and model', async () => {
      const cm = CooldownManager.getInstance();

      await cm.markProviderFailure('p1', 'm1');
      await cm.markProviderFailure('p1', 'm2');
      await cm.markProviderFailure('p2', 'm1');

      await cm.clearCooldown('p1', 'm1');

      const cooldowns = cm.getCooldowns();
      expect(cooldowns).toHaveLength(2);
      expect(cooldowns.some((c) => c.provider === 'p1' && c.model === 'm1')).toBe(false);
    });

    test('clears all cooldowns for a provider', async () => {
      const cm = CooldownManager.getInstance();

      await cm.markProviderFailure('p1', 'm1');
      await cm.markProviderFailure('p1', 'm2');
      await cm.markProviderFailure('p2', 'm1');

      await cm.clearCooldown('p1');

      const cooldowns = cm.getCooldowns();
      expect(cooldowns).toHaveLength(1);
      expect(cooldowns[0]!.provider).toBe('p2');
    });

    test('clears all cooldowns when no args', async () => {
      const cm = CooldownManager.getInstance();

      await cm.markProviderFailure('p1', 'm1');
      await cm.markProviderFailure('p2', 'm2');

      await cm.clearCooldown();

      expect(cm.getCooldowns()).toHaveLength(0);
    });
  });
});
