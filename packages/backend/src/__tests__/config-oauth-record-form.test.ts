import { describe, expect, test } from 'vitest';
import { ProviderConfigSchema } from '../config';

const oauthProvider = {
  api_key: 'oauth',
  oauth_provider: 'openai-codex',
  oauth_account: 'default',
};

describe('api_base_url oauth:// handling', () => {
  test('accepts the string form for OAuth providers', () => {
    const parsed = ProviderConfigSchema.safeParse({
      ...oauthProvider,
      api_base_url: 'oauth://',
    });

    expect(parsed.success).toBe(true);
  });

  test('rejects oauth:// inside the record form', () => {
    const parsed = ProviderConfigSchema.safeParse({
      ...oauthProvider,
      api_base_url: { 'codex-images': 'oauth://' },
    });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "use the string form api_base_url: 'oauth://'"
    );
  });

  test('rejects oauth:// alongside real URLs in the record form', () => {
    const parsed = ProviderConfigSchema.safeParse({
      ...oauthProvider,
      api_base_url: { chat: 'https://provider.example/v1', 'codex-images': 'oauth://' },
    });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "use the string form api_base_url: 'oauth://'"
    );
  });

  test('still accepts a record form of real URLs', () => {
    const parsed = ProviderConfigSchema.safeParse({
      api_key: 'provider-key',
      api_base_url: { chat: 'https://provider.example/v1', gemini: 'https://gemini.example' },
    });

    expect(parsed.success).toBe(true);
  });
});
