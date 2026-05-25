/**
 * Static defaults shared across the auxiliary client.
 * Faithful port of lines 423-441 of upstream `agent/auxiliary_client.py`.
 */

/** Default auxiliary model used when resolving through OpenRouter. */
export const OPENROUTER_MODEL = "google/gemini-3-flash-preview";

/** Default auxiliary model used when resolving through Nous Portal. */
export const NOUS_MODEL = "google/gemini-3-flash-preview";

/** Default Nous Portal inference base URL. */
export const NOUS_DEFAULT_BASE_URL = "https://inference-api.nousresearch.com/v1";

/** Default native-Anthropic base URL. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Codex OAuth endpoint used when a caller explicitly requests
 * `provider="openai-codex"`.
 *
 * There is deliberately no hardcoded default model: the set of models OpenAI
 * accepts on this endpoint for ChatGPT-account auth is an undocumented,
 * shifting allow-list, and pinning one here has drifted silently twice
 * (gpt-5.3-codex → gpt-5.2-codex → gpt-5.4 over 6 weeks in early 2026).
 * Callers must pass the model they want explicitly (from config.yaml
 * model.model, auxiliary.<task>.model, or the user's active Codex model
 * selection).
 */
export const CODEX_AUX_BASE_URL = "https://chatgpt.com/backend-api/codex";
