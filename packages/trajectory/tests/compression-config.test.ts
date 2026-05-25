// Ported from tests/test_trajectory_compressor.py — TestCompressionConfig

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OPENROUTER_BASE_URL } from "@hermests/core";
import { CompressionConfig } from "../src/compression-config.js";

describe("CompressionConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trajectory-cfg-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults match upstream", () => {
    const config = new CompressionConfig();
    expect(config.targetMaxTokens).toBe(15250);
    expect(config.summaryTargetTokens).toBe(750);
    expect(config.protectLastNTurns).toBe(4);
    expect(config.skipUnderTarget).toBe(true);
    expect(config.tokenizerName).toBe("moonshotai/Kimi-K2-Thinking");
    expect(config.trustRemoteCode).toBe(true);
    expect(config.summarizationModel).toBe("google/gemini-3-flash-preview");
    expect(config.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(config.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(config.temperature).toBe(0.3);
    expect(config.maxRetries).toBe(3);
    expect(config.retryDelay).toBe(2);
    expect(config.addSummaryNotice).toBe(true);
    expect(config.outputSuffix).toBe("_compressed");
    expect(config.numWorkers).toBe(4);
    expect(config.maxConcurrentRequests).toBe(50);
    expect(config.saveOverLimit).toBe(true);
    expect(config.perTrajectoryTimeout).toBe(300);
    expect(config.metricsEnabled).toBe(true);
    expect(config.metricsPerTrajectory).toBe(true);
    expect(config.metricsOutputFile).toBe("compression_metrics.json");
    expect(config.protectFirstSystem).toBe(true);
    expect(config.protectFirstHuman).toBe(true);
    expect(config.protectFirstGpt).toBe(true);
    expect(config.protectFirstTool).toBe(true);
    expect(config.summaryNoticeText).toContain("summarized");
  });

  it("init overrides apply", () => {
    const config = new CompressionConfig({
      tokenizerName: "custom",
      trustRemoteCode: false,
      targetMaxTokens: 100,
      summaryTargetTokens: 25,
      protectFirstSystem: false,
      protectFirstHuman: false,
      protectFirstGpt: false,
      protectFirstTool: false,
      protectLastNTurns: 1,
      summarizationModel: "gpt-test",
      baseUrl: "https://example.com/v1",
      apiKeyEnv: "OTHER_KEY",
      temperature: 0.9,
      maxRetries: 7,
      retryDelay: 11,
      addSummaryNotice: false,
      summaryNoticeText: "x",
      outputSuffix: "_x",
      numWorkers: 12,
      maxConcurrentRequests: 13,
      skipUnderTarget: false,
      saveOverLimit: false,
      perTrajectoryTimeout: 17,
      metricsEnabled: false,
      metricsPerTrajectory: false,
      metricsOutputFile: "m.json",
    });
    expect(config.tokenizerName).toBe("custom");
    expect(config.trustRemoteCode).toBe(false);
    expect(config.protectLastNTurns).toBe(1);
    expect(config.maxRetries).toBe(7);
    expect(config.retryDelay).toBe(11);
    expect(config.addSummaryNotice).toBe(false);
    expect(config.summaryNoticeText).toBe("x");
    expect(config.outputSuffix).toBe("_x");
    expect(config.numWorkers).toBe(12);
    expect(config.maxConcurrentRequests).toBe(13);
    expect(config.skipUnderTarget).toBe(false);
    expect(config.saveOverLimit).toBe(false);
    expect(config.perTrajectoryTimeout).toBe(17);
    expect(config.metricsEnabled).toBe(false);
    expect(config.metricsPerTrajectory).toBe(false);
    expect(config.metricsOutputFile).toBe("m.json");
    expect(config.protectFirstSystem).toBe(false);
    expect(config.protectFirstHuman).toBe(false);
    expect(config.protectFirstGpt).toBe(false);
    expect(config.protectFirstTool).toBe(false);
    expect(config.summarizationModel).toBe("gpt-test");
    expect(config.baseUrl).toBe("https://example.com/v1");
    expect(config.apiKeyEnv).toBe("OTHER_KEY");
    expect(config.temperature).toBe(0.9);
    expect(config.targetMaxTokens).toBe(100);
    expect(config.summaryTargetTokens).toBe(25);
  });

  it("fromYaml — full override", () => {
    const yaml = `tokenizer:
  name: custom-tokenizer
  trust_remote_code: false
compression:
  target_max_tokens: 10000
  summary_target_tokens: 500
protected_turns:
  first_system: true
  first_human: false
  first_gpt: false
  first_tool: false
  last_n_turns: 6
summarization:
  model: gpt-4
  base_url: https://example.com/v1
  api_key_env: OTHER_KEY
  temperature: 0.5
  max_retries: 5
  retry_delay: 9
output:
  add_summary_notice: false
  summary_notice_text: notice
  output_suffix: _short
processing:
  num_workers: 8
  max_concurrent_requests: 100
  skip_under_target: false
  save_over_limit: false
  per_trajectory_timeout: 22
metrics:
  enabled: false
  per_trajectory: false
  output_file: my_metrics.json
`;
    const file = join(tmp, "config.yaml");
    writeFileSync(file, yaml, "utf-8");

    const config = CompressionConfig.fromYaml(file);
    expect(config.tokenizerName).toBe("custom-tokenizer");
    expect(config.trustRemoteCode).toBe(false);
    expect(config.targetMaxTokens).toBe(10000);
    expect(config.summaryTargetTokens).toBe(500);
    expect(config.protectFirstHuman).toBe(false);
    expect(config.protectFirstSystem).toBe(true);
    expect(config.protectFirstGpt).toBe(false);
    expect(config.protectFirstTool).toBe(false);
    expect(config.protectLastNTurns).toBe(6);
    expect(config.summarizationModel).toBe("gpt-4");
    expect(config.baseUrl).toBe("https://example.com/v1");
    expect(config.apiKeyEnv).toBe("OTHER_KEY");
    expect(config.temperature).toBe(0.5);
    expect(config.maxRetries).toBe(5);
    expect(config.retryDelay).toBe(9);
    expect(config.addSummaryNotice).toBe(false);
    expect(config.summaryNoticeText).toBe("notice");
    expect(config.outputSuffix).toBe("_short");
    expect(config.numWorkers).toBe(8);
    expect(config.maxConcurrentRequests).toBe(100);
    expect(config.skipUnderTarget).toBe(false);
    expect(config.saveOverLimit).toBe(false);
    expect(config.perTrajectoryTimeout).toBe(22);
    expect(config.metricsEnabled).toBe(false);
    expect(config.metricsPerTrajectory).toBe(false);
    expect(config.metricsOutputFile).toBe("my_metrics.json");
  });

  it("fromYaml — partial override keeps defaults", () => {
    const file = join(tmp, "config.yaml");
    writeFileSync(file, "compression:\n  target_max_tokens: 8000\n", "utf-8");
    const config = CompressionConfig.fromYaml(file);
    expect(config.targetMaxTokens).toBe(8000);
    expect(config.protectLastNTurns).toBe(4);
    expect(config.numWorkers).toBe(4);
  });

  it("fromYaml — empty file uses all defaults", () => {
    const file = join(tmp, "config.yaml");
    writeFileSync(file, "{}\n", "utf-8");
    const config = CompressionConfig.fromYaml(file);
    expect(config.targetMaxTokens).toBe(15250);
  });

  it("fromYaml — empty string (parse returns null) uses defaults", () => {
    const file = join(tmp, "config.yaml");
    writeFileSync(file, "", "utf-8");
    const config = CompressionConfig.fromYaml(file);
    expect(config.targetMaxTokens).toBe(15250);
  });

  it("fromYaml — null base_url keeps default (null-guard)", () => {
    // Ported from tests/tools/test_config_null_guard.py
    //   TestTrajectoryCompressorNullGuard.test_config_loading_null_base_url_keeps_default
    const file = join(tmp, "config.yaml");
    writeFileSync(file, "summarization:\n  base_url: null\n", "utf-8");
    const config = CompressionConfig.fromYaml(file);
    expect(config.baseUrl).toBe(OPENROUTER_BASE_URL);
  });

  it("fromYaml — empty-string base_url also keeps default", () => {
    const file = join(tmp, "config.yaml");
    writeFileSync(file, 'summarization:\n  base_url: ""\n', "utf-8");
    const config = CompressionConfig.fromYaml(file);
    expect(config.baseUrl).toBe(OPENROUTER_BASE_URL);
  });
});
