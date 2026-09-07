import { describe, expect, test } from 'vitest';
import {
  apiAccessToKey,
  getApiBaseType,
  getApiSubtype,
  isApiSubtype,
  normalizeApiAccessList,
} from '../api-format';

describe('API format helpers', () => {
  test('keeps legacy string access entries compatible', () => {
    expect(normalizeApiAccessList(['chat', 'Responses'])).toEqual(['chat', 'responses']);
  });

  test('canonicalizes legacy image target names', () => {
    expect(apiAccessToKey('images')).toBe('openai-images');
    expect(apiAccessToKey('openrouter')).toBe('openrouter-images');
    expect(apiAccessToKey('openrouter:web_search')).toBe('openrouter:web_search');
  });

  test('canonicalizes structured subtypes', () => {
    expect(apiAccessToKey({ type: ' Responses ', subtype: ' Lite ' })).toBe('responses:lite');
    expect(getApiBaseType('responses:lite')).toBe('responses');
    expect(getApiSubtype('responses:lite')).toBe('lite');
    expect(isApiSubtype('responses:lite')).toBe(true);
    expect(isApiSubtype('responses')).toBe(false);
  });
});
