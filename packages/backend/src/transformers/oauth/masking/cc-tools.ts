/**
 * Tool description stripping + synthetic Claude Code tool injection —
 * v2-native, ported from vendor/eliza/plugins/plugin-anthropic-proxy/src/
 * proxy/cc-tool-injection.ts (see cc-constants.ts's module doc for the
 * de-vendoring rationale).
 *
 * The vendored version operated on the raw JSON string with hand-rolled
 * bracket-matching (its own comment: "skips [ and ] inside JSON string
 * values so description text can't corrupt depth") to avoid a parse/
 * re-stringify round-trip. That constraint doesn't apply here — this
 * pipeline already parses the body once for tool-rename computation (see
 * `registry.ts`'s caller in `apply-masking.ts`) and passes the parsed
 * object through every subsequent stage, so operating on the object
 * directly is both simpler and safer than re-deriving bracket-matching
 * logic.
 */

import { CC_SYNTHETIC_TOOLS } from './cc-constants';
import type { RenamePair } from './types';

/** Behavior knobs for {@link stripDescriptionsAndInjectSyntheticTools}. */
export interface ToolMaskingOptions {
  /**
   * When `true`, the caller's real `description` on custom/MCP tools is
   * PRESERVED instead of blanked. Defaults to `false` (the historical
   * blank-everything behavior) so callers that don't opt in are unaffected.
   *
   * Why preserving is safe — and better: the original rationale for blanking
   * (below) assumed "real Claude Code sends minimal/no tool descriptions."
   * An on-the-wire capture of a genuine Claude Code session (v2.1.246)
   * disproves that: every built-in tool ships a large description (`Bash`
   * ≈9.8k chars, `Agent` ≈6.9k) and user-configured MCP tools are forwarded
   * with their descriptions intact — 0 of 22 tools were empty. So blanking
   * makes the request LESS like real Claude Code (a real session never sends
   * an empty tool description), while costing the model the information it
   * needs to choose and parameterize a tool correctly (an opaque-named MCP
   * tool with a blanked description gets refused or mis-called). Preserving
   * descriptions is therefore both more authentic and more capable; it is
   * gated behind this flag only so the change is opt-in and non-breaking.
   */
  preserveToolDescriptions?: boolean;
}

/**
 * Masks custom/MCP tool `description` fields and prepends the synthetic
 * Claude Code tool stubs so the tool set fingerprints like a real Claude
 * Code session even when the caller's own tools don't cover them.
 *
 * Description handling depends on {@link ToolMaskingOptions.preserveToolDescriptions}:
 *   - default (`false`): every custom/MCP tool's `description` is blanked to
 *     an empty string (legacy fingerprint behavior).
 *   - `true`: the caller's real description is kept verbatim.
 *
 * A rename pair carrying a third element (see `cc-collision-shape.ts`) is a
 * name-collision disambiguation, not a cosmetic rename: the model will see
 * both this tool (now renamed) and the real Claude Code tool of its
 * original name in the same `tools[]`, so it needs a note telling it which
 * to prefer. In the default mode that note becomes the tool's ENTIRE
 * description; in preserve mode it is appended to the real description so
 * both the semantic text AND the disambiguation survive.
 *
 * Server-side tools (`type` other than "custom") are ALWAYS left
 * byte-identical in both modes — their schemas are closed and carry no
 * client-authored description (see `cc-tools-server-tools.test.ts`).
 *
 * Must run BEFORE `dedupeSyntheticToolCollisions()` (a computed rename
 * from `registry.ts` may target one of the reserved synthetic names,
 * producing a duplicate that the dedupe pass then resolves).
 *
 * @param body - Parsed JSON request body with a `tools[]` array
 * @param renamePairs - The same pairs passed to `applyToolRenames()`, used
 *   only to look up which renamed tool names need a collision note
 * @param options - See {@link ToolMaskingOptions}
 * @returns New body object with tool descriptions masked per `options` and
 *   synthetic tools prepended (same reference if there's no `tools[]`)
 */
export function stripDescriptionsAndInjectSyntheticTools(
  body: any,
  renamePairs: readonly RenamePair[] = [],
  options: ToolMaskingOptions = {}
): any {
  if (!Array.isArray(body?.tools)) {
    return body;
  }

  const { preserveToolDescriptions = false } = options;

  const noteByRenamedName = new Map<string, string>();
  for (const [, renamedName, note] of renamePairs) {
    if (note) noteByRenamedName.set(renamedName, note);
  }

  const maskedTools = body.tools.map((t: any) => {
    // Server-side tools (`bash_20250124`, `web_search_*`, `advisor_20260301`, …)
    // are identified by a `type` other than "custom", and their schemas are
    // CLOSED — Anthropic rejects unknown keys with
    // `tools.N.<type>.description: Extra inputs are not permitted`. They carry
    // no client-authored description to fingerprint anyway, so there is nothing
    // to strip. Leave them byte-identical.
    //
    // This mirrors the rule `applyClaudeOAuthTransform` already applies in
    // `oauth-claude.ts` ("Skip built-in tools (they have a `type` field)").
    const type = typeof t?.type === 'string' ? t.type : undefined;
    if (type && type !== 'custom') {
      return t;
    }
    const note = noteByRenamedName.get(t?.name);

    if (preserveToolDescriptions) {
      // Keep the caller's real description untouched. Only a collision rename
      // needs a change: append its disambiguation note so the model still
      // knows to prefer the renamed tool over the same-named real CC tool.
      if (!note) return t;
      const original = typeof t?.description === 'string' ? t.description : '';
      return { ...t, description: original ? `${original}\n\n${note}` : note };
    }

    // Default (legacy) behavior: blank client-authored descriptions so no
    // caller fingerprint reaches Anthropic; collision renames keep their note.
    return { ...t, description: note ?? '' };
  });

  return {
    ...body,
    tools: [...CC_SYNTHETIC_TOOLS.map((t) => ({ ...t })), ...maskedTools],
  };
}
