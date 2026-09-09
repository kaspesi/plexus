/**
 * Tests for the `preserveToolDescriptions` option on
 * `stripDescriptionsAndInjectSyntheticTools()`.
 *
 * Background: a genuine Claude Code session sends FULL tool descriptions on
 * every tool (built-in and MCP). Blanking them (the default/legacy behavior)
 * both diverges from that fingerprint and denies the model the information it
 * needs to select/parameterize a tool. The option preserves the caller's real
 * descriptions; these tests pin both modes so neither regresses.
 */

import { describe, expect, it } from 'vitest';
import { stripDescriptionsAndInjectSyntheticTools } from '../cc-tools';
import type { RenamePair } from '../types';

const customTools = () => [
  {
    type: 'custom',
    name: 'mcp__weather__get_forecast',
    description: 'Retrieve the current weather forecast for a city.',
    input_schema: { type: 'object', properties: { city: { type: 'string' } } },
  },
  {
    // type-less tools are treated as custom too
    name: 'mcp__fx__convert',
    description:
      "Convert money between currencies. 'amt' is the amount; 'from'/'to' are ISO codes.",
    input_schema: { type: 'object' },
  },
];

describe('stripDescriptionsAndInjectSyntheticTools — preserveToolDescriptions', () => {
  it('default (no options) blanks custom/MCP descriptions', () => {
    const out = stripDescriptionsAndInjectSyntheticTools({ tools: customTools() });
    expect(out.tools.find((t: any) => t.name === 'mcp__weather__get_forecast').description).toBe(
      ''
    );
    expect(out.tools.find((t: any) => t.name === 'mcp__fx__convert').description).toBe('');
  });

  it('default with explicit false still blanks', () => {
    const out = stripDescriptionsAndInjectSyntheticTools({ tools: customTools() }, [], {
      preserveToolDescriptions: false,
    });
    expect(out.tools.find((t: any) => t.name === 'mcp__weather__get_forecast').description).toBe(
      ''
    );
  });

  it('preserve=true keeps the caller real descriptions verbatim', () => {
    const out = stripDescriptionsAndInjectSyntheticTools({ tools: customTools() }, [], {
      preserveToolDescriptions: true,
    });
    expect(out.tools.find((t: any) => t.name === 'mcp__weather__get_forecast').description).toBe(
      'Retrieve the current weather forecast for a city.'
    );
    expect(out.tools.find((t: any) => t.name === 'mcp__fx__convert').description).toBe(
      "Convert money between currencies. 'amt' is the amount; 'from'/'to' are ISO codes."
    );
  });

  it('preserve=true still prepends the synthetic Claude Code tools', () => {
    const out = stripDescriptionsAndInjectSyntheticTools({ tools: customTools() }, [], {
      preserveToolDescriptions: true,
    });
    expect(out.tools.some((t: any) => t.name === 'Agent')).toBe(true);
    expect(out.tools.some((t: any) => t.name === 'NotebookEdit')).toBe(true);
  });

  it('server-side tools stay byte-identical in preserve mode (no description key added)', () => {
    const server = { type: 'advisor_20260301', name: 'advisor', model: 'claude-sonnet-5' };
    const out = stripDescriptionsAndInjectSyntheticTools({ tools: [server] }, [], {
      preserveToolDescriptions: true,
    });
    const emitted = out.tools.find((t: any) => t.name === 'advisor');
    expect(Object.hasOwn(emitted, 'description')).toBe(false);
    expect(emitted).toEqual(server);
  });

  describe('collision-rename note handling', () => {
    // A collision pair: original 'Bash' shape renamed to 'BashCustom', with a
    // note the model reads to prefer the renamed tool. Note is keyed by the
    // RENAMED name, so the tool in tools[] must carry that name.
    const pairs: RenamePair[] = [['Bash', 'BashCustom', 'Prefer this over the built-in Bash.']];
    const renamedTool = () => ({
      type: 'custom',
      name: 'BashCustom',
      description: 'Run a shell command in the sandbox.',
      input_schema: { type: 'object' },
    });

    it('default mode: note becomes the entire description', () => {
      const out = stripDescriptionsAndInjectSyntheticTools({ tools: [renamedTool()] }, pairs);
      expect(out.tools.find((t: any) => t.name === 'BashCustom').description).toBe(
        'Prefer this over the built-in Bash.'
      );
    });

    it('preserve mode: note is appended to the real description', () => {
      const out = stripDescriptionsAndInjectSyntheticTools({ tools: [renamedTool()] }, pairs, {
        preserveToolDescriptions: true,
      });
      expect(out.tools.find((t: any) => t.name === 'BashCustom').description).toBe(
        'Run a shell command in the sandbox.\n\nPrefer this over the built-in Bash.'
      );
    });

    it('preserve mode: renamed tool with no original description falls back to the note', () => {
      const noDesc = { type: 'custom', name: 'BashCustom', input_schema: { type: 'object' } };
      const out = stripDescriptionsAndInjectSyntheticTools({ tools: [noDesc] }, pairs, {
        preserveToolDescriptions: true,
      });
      expect(out.tools.find((t: any) => t.name === 'BashCustom').description).toBe(
        'Prefer this over the built-in Bash.'
      );
    });
  });

  it('leaves a body without tools[] untouched in preserve mode', () => {
    const body = { messages: [] };
    expect(
      stripDescriptionsAndInjectSyntheticTools(body, [], { preserveToolDescriptions: true })
    ).toBe(body);
  });
});
