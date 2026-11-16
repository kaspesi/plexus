import { describe, expect, it } from 'bun:test';

import { parseAnthropicRequest } from '../../anthropic/request-parser';
import { buildGeminiRequest } from '../request-builder';
import { sanitizeGeminiFunctionParameters } from '../utils/function-schema';
import claudeCodeTools from './fixtures/claude-code-2.1.318-tools.json';

// Keys of Gemini's `Schema` proto. Anything else in `parameters` is a 400.
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'anyOf',
  'propertyOrdering',
  'example',
  'default',
]);

function collectInvalidKeys(schema: any, path: string, out: string[]) {
  if (!schema || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) out.push(`${path}.${key}`);
    if (key === 'properties') {
      for (const [name, sub] of Object.entries(value as object)) {
        collectInvalidKeys(sub, `${path}.properties.${name}`, out);
      }
    } else if (key === 'items') {
      collectInvalidKeys(value, `${path}.items`, out);
    } else if (key === 'anyOf') {
      (value as any[]).forEach((b, i) => collectInvalidKeys(b, `${path}.anyOf[${i}]`, out));
    }
  }
}

async function declarationsFor(tools: any[]) {
  const unified = await parseAnthropicRequest({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    tools,
  });
  const gemini = await buildGeminiRequest(unified);
  const decls = gemini.tools!.find((t) => t.functionDeclarations)!.functionDeclarations!;
  return Object.fromEntries(decls.map((d) => [d.name, d.parameters as any]));
}

describe('Gemini function parameter sanitizing', () => {
  describe('Claude Code 2.1.318 tool fixture via /v1/messages', () => {
    it('raw fixture contains the keys Gemini rejected on 2026-11-13', () => {
      const raw = JSON.stringify(claudeCodeTools);
      expect(raw).toContain('"$schema"');
      expect(raw).toContain('"additionalProperties"');
      expect(raw).toContain('"exclusiveMinimum"');
      expect(raw).toContain('"const"');
      expect(raw).toContain('"allOf"');
    });

    it('emits only Gemini Schema keys for every one of the 24 tools', async () => {
      const decls = await declarationsFor(claudeCodeTools);
      expect(Object.keys(decls)).toHaveLength(24);
      const invalid: string[] = [];
      for (const [name, params] of Object.entries(decls)) collectInvalidKeys(params, name, invalid);
      expect(invalid).toEqual([]);
    });

    it('keeps the constraints Gemini can express', async () => {
      const decls = await declarationsFor(claudeCodeTools);

      expect(decls.Bash.type).toBe('object');
      expect(decls.Bash.required).toEqual(['command']);
      expect(decls.Bash.properties.command).toEqual({
        description: 'The command to execute',
        type: 'string',
      });

      // exclusiveMinimum: 0 → minimum: 0
      expect(decls.Read.properties.limit.minimum).toBe(0);
      expect(decls.Read.properties.limit.exclusiveMinimum).toBeUndefined();

      // const → single-value string enum
      expect(decls.PushNotification.properties.status.enum).toEqual(['proactive']);

      // allOf of two patterns → first pattern kept
      expect(decls.SendMessage.properties.to.pattern).toBe('^[^\\n\\r]*$');
      expect(decls.SendMessage.properties.to.allOf).toBeUndefined();

      // format: uri is not a Gemini string format
      expect(decls.WebFetch.properties.url.type).toBe('string');
      expect(decls.WebFetch.properties.url.format).toBeUndefined();

      expect(decls.Edit.properties.replace_all.default).toBe(false);

      // nested object inside array items is sanitized too
      const viewport = decls.DesignSync.properties.assets.items.properties.viewport;
      expect(viewport.additionalProperties).toBeUndefined();
      expect(viewport.properties.width.minimum).toBe(0);
    });
  });

  describe('sanitizeGeminiFunctionParameters', () => {
    it('inlines local $refs from $defs and drops the definitions', () => {
      const out = sanitizeGeminiFunctionParameters({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: { point: { type: 'object', properties: { x: { type: 'number' } } } },
        properties: { a: { $ref: '#/$defs/point', description: 'start' } },
      });
      expect(out).toEqual({
        type: 'object',
        properties: {
          a: { type: 'object', properties: { x: { type: 'number' } }, description: 'start' },
        },
      });
    });

    it('terminates on recursive $refs', () => {
      const out = sanitizeGeminiFunctionParameters({
        type: 'object',
        $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } },
        properties: { head: { $ref: '#/$defs/node' } },
      });
      let depth = 0;
      let cur = out.properties.head;
      while (cur?.properties?.next) {
        cur = cur.properties.next;
        depth += 1;
      }
      expect(depth).toBeGreaterThan(0);
      expect(depth).toBeLessThanOrEqual(17);
      expect(cur.type).toBe('object');
    });

    it('maps nullable unions to nullable', () => {
      const out = sanitizeGeminiFunctionParameters({
        type: 'object',
        properties: {
          a: { type: ['string', 'null'] },
          b: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          c: { type: ['string', 'integer'] },
        },
      });
      expect(out.properties.a).toEqual({ type: 'string', nullable: true });
      expect(out.properties.b).toEqual({ type: 'integer', nullable: true });
      expect(out.properties.c).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
    });

    it('maps oneOf to anyOf and drops unsupported keywords', () => {
      const out = sanitizeGeminiFunctionParameters({
        type: 'object',
        additionalProperties: false,
        propertyNames: { pattern: '^[a-z]+$' },
        patternProperties: { '^x': { type: 'string' } },
        properties: {
          v: {
            oneOf: [{ type: 'string' }, { type: 'number', exclusiveMaximum: 5 }],
            examples: ['a'],
          },
          n: { type: 'integer', enum: [1, 2], uniqueItems: true },
        },
        required: ['v', 'missing'],
      });
      expect(out).toEqual({
        type: 'object',
        properties: {
          v: { anyOf: [{ type: 'string' }, { type: 'number', maximum: 5 }] },
          n: { type: 'integer' },
        },
        required: ['v'],
      });
    });

    it('leaves an already-valid Gemini schema unchanged', () => {
      const schema = {
        type: 'OBJECT',
        properties: {
          when: { type: 'STRING', format: 'date-time', description: 'ISO time' },
          tags: { type: 'ARRAY', items: { type: 'STRING', enum: ['a', 'b'] }, maxItems: 3 },
        },
        required: ['when'],
      };
      expect(sanitizeGeminiFunctionParameters(schema)).toEqual(schema);
    });
  });
});
