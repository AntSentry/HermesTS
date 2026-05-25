/**
 * LM Studio reasoning-effort resolution shared by the chat-completions
 * transport and run_agent's iteration-limit summary path.
 *
 * Faithful port of upstream `agent/lmstudio_reasoning.py`.
 *
 * LM Studio publishes per-model `capabilities.reasoning.allowed_options`
 * (e.g. `["off","on"]` for toggle-style models, `["off","minimal","low"]`
 * for graduated models). We map the user's `reasoning_config` onto LM
 * Studio's OpenAI-compatible vocabulary, then clamp against the model's
 * allowed set so the server doesn't 400 on an unsupported effort.
 */

const LM_VALID_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const LM_EFFORT_ALIASES: Readonly<Record<string, string>> = {
  off: "none",
  on: "medium",
};

/** Reasoning config shape accepted by `resolveLmstudioEffort`. */
export interface LmstudioReasoningConfig {
  enabled?: unknown;
  effort?: unknown;
}

/**
 * Return the `reasoning_effort` string to send to LM Studio, or `null`.
 *
 * `null` means "omit the field": the user picked a level the model can't
 * honor, so let LM Studio fall back to the model's declared default rather
 * than silently substituting a different effort. When `allowedOptions` is
 * falsy (probe failed), skip clamping and send the resolved effort anyway.
 */
export function resolveLmstudioEffort(
  reasoningConfig: LmstudioReasoningConfig | null | undefined,
  allowedOptions: readonly string[] | null | undefined,
): string | null {
  let effort = "medium";
  if (reasoningConfig && typeof reasoningConfig === "object") {
    if (reasoningConfig.enabled === false) {
      effort = "none";
    } else {
      const rawValue = reasoningConfig.effort;
      const raw = (typeof rawValue === "string" ? rawValue : "").trim().toLowerCase();
      const mapped = LM_EFFORT_ALIASES[raw] ?? raw;
      if (LM_VALID_EFFORTS.has(mapped)) {
        effort = mapped;
      }
    }
  }
  if (allowedOptions && allowedOptions.length > 0) {
    const allowed = new Set<string>();
    for (const opt of allowedOptions) {
      allowed.add(LM_EFFORT_ALIASES[opt] ?? opt);
    }
    if (!allowed.has(effort)) {
      return null;
    }
  }
  return effort;
}
