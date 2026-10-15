import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { setConfigForTesting } from '../../../config';
import { registerInferenceRoutes } from '../index';
import { Dispatcher } from '../../../services/dispatch/dispatcher';
import { UsageStorageService } from '../../../services/observability/usage-storage';
import { DebugManager } from '../../../services/observability/debug-manager';
import { SelectorFactory } from '../../../services/routing/selectors/factory';

const TEST_CONFIG = {
  providers: {
    anthropic: {
      api_key: 'sk-test',
      api_base_url: 'https://api.anthropic.com/v1',
      estimateTokens: false,
      disable_cooldown: false,
      stall_cooldown: false,
      allow_100_percent_utilization: false,
      useClaudeMasking: false,
      models: { 'claude-test': { pricing: { source: 'simple' as const, input: 1, output: 1 } } },
    },
  },
  models: {
    'claude-test': {
      priority: 'selector' as const,
      sticky_session: false,
      targets: [{ provider: 'anthropic', model: 'claude-test' }],
    },
  },
  keys: { 'test-key-1': { secret: 'sk-valid-key', comment: 'Test Key' } },
  failover: { enabled: true, retryableStatusCodes: [429, 500, 502, 503, 504], retryableErrors: [] },
  quotas: [],
};

describe('POST /v1/messages when no target is healthy', () => {
  let fastify: FastifyInstance;
  let routingContext: Record<string, unknown>;

  beforeEach(async () => {
    setConfigForTesting(TEST_CONFIG);
    fastify = Fastify();

    const dispatcher = {
      dispatch: vi.fn(async () => {
        const error = new Error("No healthy target selected for alias 'claude-test'") as any;
        error.routingContext = routingContext;
        throw error;
      }),
    } as unknown as Dispatcher;

    const usageStorage = {
      saveRequest: vi.fn(),
      saveError: vi.fn(),
      saveDebugLog: vi.fn(),
      updatePerformanceMetrics: vi.fn(),
      emitStartedAsync: vi.fn(),
      emitUpdatedAsync: vi.fn(),
    } as unknown as UsageStorageService;

    DebugManager.getInstance().setStorage(usageStorage);
    SelectorFactory.setUsageStorage(usageStorage);
    await registerInferenceRoutes(fastify, dispatcher, usageStorage);
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  const post = () =>
    fastify.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: 'Bearer sk-valid-key', 'content-type': 'application/json' },
      payload: {
        model: 'claude-test',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

  it('answers 503 overloaded_error with the retry-after hint', async () => {
    routingContext = { statusCode: 503, code: 'no_healthy_target', retryAfterSeconds: 45 };

    const response = await post();

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('45');
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.code).toBe('no_healthy_target');
    expect(body.error.message).toBe("No healthy target selected for alias 'claude-test'");
  });

  it('omits retry-after when no cooldown will lift', async () => {
    routingContext = { statusCode: 503, code: 'no_healthy_target' };

    const response = await post();

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBeUndefined();
    expect(JSON.parse(response.body).error.type).toBe('overloaded_error');
  });
});
