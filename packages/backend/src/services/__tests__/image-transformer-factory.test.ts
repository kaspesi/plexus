import { describe, expect, test } from 'vitest';
import { ImageGenerationTransformerFactory } from '../dispatch/image-transformer-factory';

describe('ImageGenerationTransformerFactory', () => {
  test('resolves OpenAI Images targets and legacy images aliases', () => {
    expect(ImageGenerationTransformerFactory.getTransformer('openai-images').name).toBe('image');
    expect(ImageGenerationTransformerFactory.getTransformer('images').name).toBe('image');
    expect(ImageGenerationTransformerFactory.getTransformer('chat').name).toBe('image');
  });

  test('resolves native Gemini image targets', () => {
    expect(ImageGenerationTransformerFactory.getTransformer('gemini').name).toBe('gemini');
  });

  test('resolves the dedicated OpenRouter image target', () => {
    expect(ImageGenerationTransformerFactory.getTransformer('openrouter-images').name).toBe(
      'openrouter-images'
    );
    expect(ImageGenerationTransformerFactory.getTransformer('openrouter').name).toBe(
      'openrouter-images'
    );
  });

  test('rejects unsupported target protocols', () => {
    expect(() => ImageGenerationTransformerFactory.getTransformer('messages')).toThrow(
      'Unsupported image provider type'
    );
  });
});
