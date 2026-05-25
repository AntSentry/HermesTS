/**
 * CompressionConfig — faithful port of `CompressionConfig` (Python dataclass,
 * upstream `trajectory_compressor.py` lines 82-179).
 *
 * The Python `from_yaml` classmethod is preserved as a static factory; defaults
 * mirror the dataclass field defaults exactly.
 */

import { readFileSync } from "node:fs";
import { OPENROUTER_BASE_URL } from "@hermests/core";
import { parse as yamlParse } from "yaml";

/**
 * Shape of values read out of YAML — every key is optional and may be `null`.
 * Mirrors `data.get(...)` semantics in the Python `from_yaml`.
 */
interface RawYamlConfig {
  tokenizer?: {
    name?: string | null;
    trust_remote_code?: boolean | null;
  } | null;
  compression?: {
    target_max_tokens?: number | null;
    summary_target_tokens?: number | null;
  } | null;
  protected_turns?: {
    first_system?: boolean | null;
    first_human?: boolean | null;
    first_gpt?: boolean | null;
    first_tool?: boolean | null;
    last_n_turns?: number | null;
  } | null;
  summarization?: {
    model?: string | null;
    base_url?: string | null;
    api_key_env?: string | null;
    temperature?: number | null;
    max_retries?: number | null;
    retry_delay?: number | null;
  } | null;
  output?: {
    add_summary_notice?: boolean | null;
    summary_notice_text?: string | null;
    output_suffix?: string | null;
  } | null;
  processing?: {
    num_workers?: number | null;
    max_concurrent_requests?: number | null;
    skip_under_target?: boolean | null;
    save_over_limit?: boolean | null;
    per_trajectory_timeout?: number | null;
  } | null;
  metrics?: {
    enabled?: boolean | null;
    per_trajectory?: boolean | null;
    output_file?: string | null;
  } | null;
}

/**
 * Construction arguments for `CompressionConfig` — every field is optional and
 * falls back to the upstream Python default. Matches the dataclass kwargs
 * surface exactly.
 */
export interface CompressionConfigInit {
  // Tokenizer
  tokenizerName?: string;
  trustRemoteCode?: boolean;

  // Compression targets
  targetMaxTokens?: number;
  summaryTargetTokens?: number;

  // Protected turns
  protectFirstSystem?: boolean;
  protectFirstHuman?: boolean;
  protectFirstGpt?: boolean;
  protectFirstTool?: boolean;
  protectLastNTurns?: number;

  // Summarization
  summarizationModel?: string;
  baseUrl?: string | null;
  apiKeyEnv?: string;
  temperature?: number;
  maxRetries?: number;
  retryDelay?: number;

  // Output
  addSummaryNotice?: boolean;
  summaryNoticeText?: string;
  outputSuffix?: string;

  // Processing
  numWorkers?: number;
  maxConcurrentRequests?: number;
  skipUnderTarget?: boolean;
  saveOverLimit?: boolean;
  perTrajectoryTimeout?: number;

  // Metrics
  metricsEnabled?: boolean;
  metricsPerTrajectory?: boolean;
  metricsOutputFile?: string;
}

/**
 * Configuration for trajectory compression. Field names use camelCase in the
 * TS port; the YAML on-disk schema keeps the upstream snake_case so configs
 * remain interchangeable between the Python and TS implementations.
 */
export class CompressionConfig {
  // Tokenizer
  tokenizerName: string;
  trustRemoteCode: boolean;

  // Compression targets
  targetMaxTokens: number;
  summaryTargetTokens: number;

  // Protected turns
  protectFirstSystem: boolean;
  protectFirstHuman: boolean;
  protectFirstGpt: boolean;
  protectFirstTool: boolean;
  protectLastNTurns: number;

  // Summarization (OpenRouter by default)
  summarizationModel: string;
  baseUrl: string | null;
  apiKeyEnv: string;
  temperature: number;
  maxRetries: number;
  retryDelay: number;

  // Output
  addSummaryNotice: boolean;
  summaryNoticeText: string;
  outputSuffix: string;

  // Processing
  numWorkers: number;
  maxConcurrentRequests: number;
  skipUnderTarget: boolean;
  saveOverLimit: boolean;
  perTrajectoryTimeout: number;

  // Metrics
  metricsEnabled: boolean;
  metricsPerTrajectory: boolean;
  metricsOutputFile: string;

  constructor(init: CompressionConfigInit = {}) {
    this.tokenizerName = init.tokenizerName ?? "moonshotai/Kimi-K2-Thinking";
    this.trustRemoteCode = init.trustRemoteCode ?? true;

    this.targetMaxTokens = init.targetMaxTokens ?? 15250;
    this.summaryTargetTokens = init.summaryTargetTokens ?? 750;

    this.protectFirstSystem = init.protectFirstSystem ?? true;
    this.protectFirstHuman = init.protectFirstHuman ?? true;
    this.protectFirstGpt = init.protectFirstGpt ?? true;
    this.protectFirstTool = init.protectFirstTool ?? true;
    this.protectLastNTurns = init.protectLastNTurns ?? 4;

    this.summarizationModel = init.summarizationModel ?? "google/gemini-3-flash-preview";
    this.baseUrl = init.baseUrl ?? OPENROUTER_BASE_URL;
    this.apiKeyEnv = init.apiKeyEnv ?? "OPENROUTER_API_KEY";
    this.temperature = init.temperature ?? 0.3;
    this.maxRetries = init.maxRetries ?? 3;
    this.retryDelay = init.retryDelay ?? 2;

    this.addSummaryNotice = init.addSummaryNotice ?? true;
    this.summaryNoticeText =
      init.summaryNoticeText ??
      "\n\nSome of your previous tool responses may be summarized to preserve context.";
    this.outputSuffix = init.outputSuffix ?? "_compressed";

    this.numWorkers = init.numWorkers ?? 4;
    this.maxConcurrentRequests = init.maxConcurrentRequests ?? 50;
    this.skipUnderTarget = init.skipUnderTarget ?? true;
    this.saveOverLimit = init.saveOverLimit ?? true;
    this.perTrajectoryTimeout = init.perTrajectoryTimeout ?? 300;

    this.metricsEnabled = init.metricsEnabled ?? true;
    this.metricsPerTrajectory = init.metricsPerTrajectory ?? true;
    this.metricsOutputFile = init.metricsOutputFile ?? "compression_metrics.json";
  }

  /**
   * Load configuration from a YAML file. Equivalent to the Python
   * `CompressionConfig.from_yaml(path)` classmethod. Missing sections fall back
   * to the dataclass defaults — partial overrides are supported.
   *
   * The YAML uses upstream snake_case keys; the TS port maps them onto
   * camelCase fields.
   */
  static fromYaml(yamlPath: string): CompressionConfig {
    const text = readFileSync(yamlPath, "utf-8");
    // `yaml.parse('') === null` — the `?? {}` covers fully empty files.
    const parsed = yamlParse(text) as RawYamlConfig | null;
    const data: RawYamlConfig = parsed ?? {};

    const config = new CompressionConfig();

    if (data.tokenizer != null) {
      const t = data.tokenizer;
      if (t.name != null) config.tokenizerName = t.name;
      if (t.trust_remote_code != null) config.trustRemoteCode = t.trust_remote_code;
    }

    if (data.compression != null) {
      const c = data.compression;
      if (c.target_max_tokens != null) config.targetMaxTokens = c.target_max_tokens;
      if (c.summary_target_tokens != null) {
        config.summaryTargetTokens = c.summary_target_tokens;
      }
    }

    if (data.protected_turns != null) {
      const p = data.protected_turns;
      if (p.first_system != null) config.protectFirstSystem = p.first_system;
      if (p.first_human != null) config.protectFirstHuman = p.first_human;
      if (p.first_gpt != null) config.protectFirstGpt = p.first_gpt;
      if (p.first_tool != null) config.protectFirstTool = p.first_tool;
      if (p.last_n_turns != null) config.protectLastNTurns = p.last_n_turns;
    }

    if (data.summarization != null) {
      const s = data.summarization;
      if (s.model != null) config.summarizationModel = s.model;
      // Faithful to upstream: `data['summarization'].get('base_url') or config.base_url`
      // — a null/empty base_url keeps the default. This is the
      // documented "null guard" behaviour exercised by `test_config_null_guard.py`.
      if (s.base_url) config.baseUrl = s.base_url;
      if (s.api_key_env != null) config.apiKeyEnv = s.api_key_env;
      if (s.temperature != null) config.temperature = s.temperature;
      if (s.max_retries != null) config.maxRetries = s.max_retries;
      if (s.retry_delay != null) config.retryDelay = s.retry_delay;
    }

    if (data.output != null) {
      const o = data.output;
      if (o.add_summary_notice != null) config.addSummaryNotice = o.add_summary_notice;
      if (o.summary_notice_text != null) config.summaryNoticeText = o.summary_notice_text;
      if (o.output_suffix != null) config.outputSuffix = o.output_suffix;
    }

    if (data.processing != null) {
      const p = data.processing;
      if (p.num_workers != null) config.numWorkers = p.num_workers;
      if (p.max_concurrent_requests != null) {
        config.maxConcurrentRequests = p.max_concurrent_requests;
      }
      if (p.skip_under_target != null) config.skipUnderTarget = p.skip_under_target;
      if (p.save_over_limit != null) config.saveOverLimit = p.save_over_limit;
      if (p.per_trajectory_timeout != null) {
        config.perTrajectoryTimeout = p.per_trajectory_timeout;
      }
    }

    if (data.metrics != null) {
      const m = data.metrics;
      if (m.enabled != null) config.metricsEnabled = m.enabled;
      if (m.per_trajectory != null) config.metricsPerTrajectory = m.per_trajectory;
      if (m.output_file != null) config.metricsOutputFile = m.output_file;
    }

    return config;
  }
}
