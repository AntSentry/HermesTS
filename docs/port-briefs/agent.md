# Port Brief — `@hermests/agent`

> Decision-grade brief for the future port of upstream `hermes-agent/agent/` to TypeScript.
> Source of truth: `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/agent/` @ main.
> Scope: 102 Python files, **63,297 LOC**. 108 upstream test files import from this module.
> Read this brief in full before claiming any agent sub-task.

---

## 1. Module summary

`agent/` is the runtime for one user turn through a Hermes agent: it owns the conversation loop (`conversation_loop.run_conversation`), the agent constructor (`agent_init.init_agent`), per-provider transports/adapters (Anthropic, Bedrock, Codex Responses, Codex app-server, Gemini native, Gemini Cloud Code, Copilot ACP, generic OpenAI chat-completions), and a wide collection of cross-cutting helpers (credential pool, auxiliary client for side tasks, context compression, message sanitization, retry/error classification, LSP integration, skill/memory plumbing, image/video/web/browser provider registries, display/spinner, file safety, rate-limit guards, and OAuth flows for Google/Anthropic). The module is an extraction of what used to be ~28,000 lines of `run_agent.py`/`AIAgent`; each file documents its slice of that legacy class in its header docstring, and many functions take the parent `AIAgent` as their first argument and reach back through a deliberate `_ra()` lazy-import shim so that test patches against `run_agent.*` still work. There is **one cycle in the entire 102-file module** (`agent/lsp/__init__.py ↔ agent/lsp/manager.py`, the standard package-init re-export pattern), 61 leaf files with zero internal deps, and the integrator (`conversation_loop.py`) imports only 15 siblings — meaning the module ports unusually well in parallel.

---

## 2. File inventory

102 `.py` files. Public exports were extracted from `^(def |class |async def )` lines, filtering names starting with `_`. Generated via `wc -l` and grep over upstream.

| path | LOC | public exports | one-line purpose |
|---|---:|---|---|
| `agent/__init__.py` | 6 | _(none)_ | Package marker. Just a docstring. |
| `agent/account_usage.py` | 326 | `AccountUsageSnapshot, AccountUsageWindow, fetch_account_usage, render_account_usage_lines` | Account quota / spend snapshot fetch + CLI rendering. |
| `agent/agent_init.py` | 1638 | `init_agent` | Extracted body of `AIAgent.__init__` (60+ params, attribute init, provider auto-detect, credential resolution, context-engine bootstrap). |
| `agent/agent_runtime_helpers.py` | 2228 | `anthropic_prompt_cache_policy, apply_pending_steer_to_tool_results, cleanup_dead_connections, convert_to_trajectory_format, copy_reasoning_content_for_api, create_openai_client, drop_thinking_only_and_merge_users, dump_api_request_debug, extract_api_error_context, extract_reasoning, force_close_tcp_sockets, invoke_tool, looks_like_codex_intermediate_ack, recover_with_credential_pool, repair_message_sequence, repair_tool_call, restore_primary_runtime, sanitize_api_messages, sanitize_tool_call_arguments, strip_think_blocks, switch_model, try_recover_primary_transport` | Assorted runtime helpers that AIAgent calls during a turn — pool rotation, message sequence repair, reasoning extraction, request debug dumps, OpenAI-SDK client builder. |
| `agent/anthropic_adapter.py` | 2244 | `build_anthropic_bedrock_client, build_anthropic_client, build_anthropic_kwargs, convert_messages_to_anthropic, convert_tools_to_anthropic, is_claude_code_token_valid, normalize_model_name, read_claude_code_credentials, read_claude_managed_key, read_hermes_oauth_credentials, refresh_anthropic_oauth_pure, resolve_anthropic_token, run_hermes_oauth_login_pure, run_oauth_setup_token` | Anthropic Messages API adapter — request/response conversion + auth (api-key, sk-ant-oat OAuth, Claude Code credentials). |
| `agent/async_utils.py` | 68 | `safe_schedule_threadsafe` | Tiny async/sync bridge — schedule a coroutine onto a loop from any thread, no-op on dead loops. |
| `agent/auxiliary_client.py` | 5289 | `AnthropicAuxiliaryClient, async_call_llm, AsyncAnthropicAuxiliaryClient, AsyncCodexAuxiliaryClient, auxiliary_max_tokens_param, build_nvidia_nim_headers, build_or_headers, call_llm, cleanup_stale_async_clients, clear_runtime_main, CodexAuxiliaryClient, extract_content_or_reasoning, get_async_text_auxiliary_client, get_auxiliary_extra_body, get_available_vision_backends, get_text_auxiliary_client, neuter_async_httpx_del, resolve_provider_client, resolve_vision_provider_client, set_runtime_main, shutdown_cached_clients` | Single auxiliary-LLM router for all side tasks (context compression, session search, web extract, vision, browser vision) with a 7-step resolution chain. Largest file in the module. |
| `agent/azure_identity_adapter.py` | 555 | `build_bearer_http_client, build_credential, build_token_provider, describe_active_credential, EntraIdentityConfig, has_azure_identity_credentials, has_azure_identity_installed, is_token_provider, materialize_bearer_for_http, reset_credential_cache` | Microsoft Entra ID adapter for Microsoft Foundry. |
| `agent/background_review.py` | 587 | `build_memory_write_metadata, spawn_background_review_thread, summarize_background_review_actions` | Forks the agent in a background thread after each turn to evaluate "should any skill/memory be saved or updated?". |
| `agent/bedrock_adapter.py` | 1289 | `bedrock_model_ids_or_none, build_converse_kwargs, call_converse, call_converse_stream, classify_bedrock_error, convert_messages_to_converse, convert_tools_to_converse, discover_bedrock_models, get_bedrock_context_length, get_bedrock_model_ids, has_aws_credentials, invalidate_runtime_client, is_anthropic_bedrock_model, is_context_overflow_error, is_stale_connection_error, normalize_converse_response, normalize_converse_stream_events, reset_client_cache, reset_discovery_cache, resolve_aws_auth_env_var, resolve_bedrock_region, stream_converse_with_callbacks` | AWS Bedrock Converse API adapter — uses AWS SDK, supports cross-region inference profiles + guardrails. |
| `agent/browser_provider.py` | 175 | `BrowserProvider` | ABC for browser providers. |
| `agent/browser_registry.py` | 223 | `get_active_browser_provider, get_provider, list_providers, register_provider` | Browser provider registry. |
| `agent/chat_completion_helpers.py` | 2153 | `build_api_kwargs, build_assistant_message, cleanup_task_resources, handle_max_iterations, interruptible_api_call, interruptible_streaming_api_call, try_activate_fallback` | OpenAI-SDK chat-completion call path with interruption + fallback activation. |
| `agent/codex_responses_adapter.py` | 1082 | _(all underscore-prefixed; internal helpers used by tests via name mangling)_ | OpenAI Responses API format conversion (Codex, xAI, GitHub Models). |
| `agent/codex_runtime.py` | 448 | `run_codex_app_server_turn, run_codex_create_stream_fallback, run_codex_stream` | Codex API runtime entry points (App Server + Responses-API streaming). |
| `agent/context_compressor.py` | 1748 | `ContextCompressor` | Automatic context-window compression with its own auxiliary OpenAI client; structured Resolved/Pending/Remaining-Work template, image-token shrinking. |
| `agent/context_engine.py` | 211 | `ContextEngine` | ABC for pluggable context engines. |
| `agent/context_references.py` | 518 | `ContextReference, ContextReferenceResult, parse_context_references, preprocess_context_references, preprocess_context_references_async` | `@file` / `@url` reference expansion in user messages. |
| `agent/conversation_compression.py` | 603 | `check_compression_model_feasibility, compress_context, replay_compression_warning, try_shrink_image_parts_in_messages` | The AIAgent methods that drive summarisation; sits between conversation_loop and context_compressor. |
| `agent/conversation_loop.py` | 4191 | `run_conversation` | Extracted ~3,900-line body of `AIAgent.run_conversation` — drives one user turn (model call, tool dispatch, retries, fallbacks, compression, post-turn hooks). The integrator. |
| `agent/copilot_acp_client.py` | 686 | `CopilotACPClient` | OpenAI-compatible shim that forwards Hermes requests to `copilot --acp`. |
| `agent/credential_pool.py` | 1955 | `CredentialPool, get_custom_provider_pool_key, get_pool_strategy, label_from_token, list_custom_pool_providers, load_pool, PooledCredential` | Persistent multi-credential pool for same-provider failover (rotation on 429, TTL refresh, JWT decode, atomic disk persistence). |
| `agent/credential_sources.py` | 448 | `find_removal_step, register, RemovalResult, RemovalStep` | Unified removal contract — every credential source Hermes reads from registers a `remove` step here so `hermes auth remove` is exhaustive. |
| `agent/curator_backup.py` | 696 | `format_size, get_keep, is_enabled, list_backups, rollback, snapshot_skills, summarize_backups` | Curator snapshot + rollback for agent-created skills. |
| `agent/curator.py` | 1781 | `apply_automatic_transitions, get_archive_after_days, get_interval_hours, get_min_idle_hours, get_stale_after_days, is_enabled, is_paused, load_state, maybe_run_curator, run_curator_review, save_state, set_paused, should_run_now` | Background skill-maintenance orchestrator (inactivity-triggered). |
| `agent/display.py` | 987 | `build_tool_preview, capture_local_edit_snapshot, extract_edit_diff, get_cute_tool_message, get_skin_tool_prefix, get_tool_emoji, get_tool_preview_max_len, KawaiiSpinner, LocalEditSnapshot, render_edit_diff_with_delta, set_tool_preview_max_len` | CLI presentation — spinner, kawaii faces, tool preview formatting. |
| `agent/error_classifier.py` | 1134 | `ClassifiedError, classify_api_error, FailoverReason` | Centralized API error taxonomy + classification pipeline → retry/rotate/fallback/compress/abort. |
| `agent/file_safety.py` | 256 | `build_write_denied_paths, build_write_denied_prefixes, get_read_block_error, get_safe_write_root, is_write_denied` | Shared file safety rules used by tools and ACP shims. |
| `agent/gemini_cloudcode_adapter.py` | 909 | `build_gemini_request, GeminiCloudCodeClient, wrap_code_assist_request` | OpenAI-compatible facade over Google Cloud Code Assist backend (used by free/paid Gemini CLI). |
| `agent/gemini_native_adapter.py` | 971 | `AsyncGeminiNativeClient, build_gemini_request, gemini_http_error, GeminiAPIError, GeminiNativeClient, is_free_tier_quota_error, is_native_gemini_base_url, probe_gemini_tier, translate_gemini_response, translate_stream_event` | OpenAI-compatible facade over Google AI Studio native Gemini API. |
| `agent/gemini_schema.py` | 99 | `sanitize_gemini_schema, sanitize_gemini_tool_parameters` | Strip JSON-Schema fields outside Gemini's OpenAPI 3.0 subset. |
| `agent/google_code_assist.py` | 452 | `CodeAssistError, CodeAssistProjectInfo, load_code_assist, onboard_user, ProjectContext, ProjectIdRequiredError, QuotaBucket, resolve_project_context, retrieve_user_quota` | Google Code Assist API client — project discovery, onboarding, quota. |
| `agent/google_oauth.py` | 1059 | `clear_credentials, exchange_code, get_valid_access_token, GoogleCredentials, GoogleOAuthError, load_credentials, refresh_access_token, RefreshParts, resolve_project_id_from_env, run_gemini_oauth_login_pure, save_credentials, start_oauth_flow, update_project_ids` | Google OAuth PKCE (S256) flow for the Gemini provider. Stores creds at `~/.hermes/auth/google_oauth.json` chmod 0o600. |
| `agent/i18n.py` | 258 | `get_language, reset_language_cache, t` | Lightweight i18n for static UI messages. |
| `agent/image_gen_provider.py` | 242 | `error_response, ImageGenProvider, resolve_aspect_ratio, save_b64_image, success_response` | ABC + helpers for image-generation providers. |
| `agent/image_gen_registry.py` | 145 | `get_active_provider, get_provider, list_providers, register_provider` | Image-gen provider registry. |
| `agent/image_routing.py` | 391 | `build_native_content_parts, decide_image_input_mode` | Decide whether inbound images go as native vision parts vs. saved-and-referenced. |
| `agent/insights.py` | 930 | `InsightsEngine` | SQL-backed cost/usage insights. |
| `agent/iteration_budget.py` | 62 | `IterationBudget` | Per-agent thread-safe iteration counter. |
| `agent/lmstudio_reasoning.py` | 48 | `resolve_lmstudio_effort` | Shared reasoning-effort resolver for the chat-completions transport. |
| `agent/lsp/__init__.py` | 106 | `get_service, shutdown_service` | LSP package entry — singleton accessor. |
| `agent/lsp/cli.py` | 308 | `register_subparser, run_lsp_command` | `hermes lsp` argparse subparser. |
| `agent/lsp/client.py` | 930 | `file_uri, LSPClient, uri_to_path` | Async LSP client over stdin/stdout (one per `(server, workspace)`). |
| `agent/lsp/eventlog.py` | 213 | `log_active, log_clean, log_diagnostics, log_disabled, log_no_project_root, log_no_server_configured, log_server_error, log_server_unavailable, log_spawn_failed, log_timeout, reset_announce_caches` | Per-server LSP event log with announce de-dup. |
| `agent/lsp/install.py` | 376 | `detect_status, hermes_lsp_bin_dir, try_install` | LSP server auto-install. |
| `agent/lsp/manager.py` | 644 | `LSPService` | Service-level orchestration: bridges sync file_operations to async LSPClient via a single-thread asyncio event loop. |
| `agent/lsp/protocol.py` | 196 | `classify_message, encode_message, LSPProtocolError, LSPRequestError, make_error_response, make_notification, make_request, make_response, read_message` | JSON-RPC framing for LSP. |
| `agent/lsp/range_shift.py` | 149 | `build_line_shift, shift_baseline, shift_diagnostic_range` | Diagnostic range arithmetic across edits (delta-key baseline). |
| `agent/lsp/reporter.py` | 78 | `format_diagnostic, report_for_file, truncate` | Pretty-format diagnostics for inclusion in tool output. |
| `agent/lsp/servers.py` | 1040 | `find_server_for_file, language_id_for, ServerContext, ServerDef, SpawnSpec` | Per-language LSP server definitions — extension matching, root resolution, spawn command, init options. |
| `agent/lsp/workspace.py` | 223 | `clear_cache, find_git_worktree, is_inside_workspace, nearest_root, normalize_path, resolve_workspace_for_file` | Workspace-root discovery (git-aware). |
| `agent/manual_compression_feedback.py` | 49 | `summarize_manual_compression` | User-facing summaries for `/compact`. |
| `agent/markdown_tables.py` | 309 | `is_table_divider, looks_like_table_row, realign_markdown_tables, split_table_row` | CJK/wide-char-aware re-alignment of model-emitted markdown tables. |
| `agent/memory_manager.py` | 609 | `build_memory_context_block, MemoryManager, sanitize_context, StreamingContextScrubber` | Orchestrates memory providers for the agent. |
| `agent/memory_provider.py` | 279 | `MemoryProvider` | ABC for memory providers. |
| `agent/message_sanitization.py` | 444 | _(all underscore-prefixed)_ | Sanitize surrogate/non-ASCII in messages and tool payloads. Provider-quirk normalisation. |
| `agent/model_metadata.py` | 1828 | `detect_local_server_type, estimate_messages_tokens_rough, estimate_request_tokens_rough, estimate_tokens_rough, fetch_endpoint_model_metadata, fetch_model_metadata, get_cached_context_length, get_model_context_length, get_next_probe_tier, grok_supports_reasoning_effort, is_local_endpoint, parse_available_output_tokens_from_error, parse_context_limit_from_error, query_ollama_num_ctx, save_context_length` | Provider-side model metadata fetch + context-length cache. The most-imported file in the module (7 siblings). |
| `agent/models_dev.py` | 726 | `fetch_models_dev, get_model_capabilities, get_model_info, get_provider_info, list_agentic_models, list_provider_models, lookup_models_dev_context, ModelCapabilities, ModelInfo, ProviderInfo` | models.dev registry integration — primary provider/model DB. |
| `agent/moonshot_schema.py` | 262 | `is_moonshot_model, sanitize_moonshot_tool_parameters, sanitize_moonshot_tools` | Translate OpenAI tool schemas to Moonshot's schema subset. |
| `agent/nous_rate_guard.py` | 325 | `clear_nous_rate_limit, format_remaining, is_genuine_nous_rate_limit, nous_rate_limit_remaining, record_nous_rate_limit` | Cross-session rate-limit guard for Nous Portal (persisted to disk). |
| `agent/onboarding.py` | 193 | `busy_input_hint_cli, busy_input_hint_gateway, detect_openclaw_residue, is_seen, mark_seen, openclaw_residue_hint_cli, tool_progress_hint_cli, tool_progress_hint_gateway` | One-time onboarding hints with seen-state persistence. |
| `agent/plugin_llm.py` | 1046 | `make_plugin_llm_for_test, PluginLlm, PluginLlmCompleteResult, PluginLlmImageInput, PluginLlmStructuredResult, PluginLlmTextInput, PluginLlmTrustError, PluginLlmUsage` | LLM-call API exposed to plugins (trust-gated, structured outputs supported). |
| `agent/portal_tags.py` | 64 | `hermes_client_tag, nous_portal_tags` | Centralized Nous Portal request tags. |
| `agent/process_bootstrap.py` | 167 | _(all underscore-prefixed)_ | Process-level bootstrap helpers — safe stdio install, proxy env normalization. |
| `agent/prompt_builder.py` | 1465 | `build_context_files_prompt, build_environment_hints, build_nous_subscription_prompt, build_skills_system_prompt, clear_skills_system_prompt_cache, load_soul_md` | System-prompt assembly — identity, platform hints, skills index, context files. Stateless. |
| `agent/prompt_caching.py` | 79 | `apply_anthropic_cache_control` | Anthropic prompt caching strategy — assign `cache_control` breakpoints. |
| `agent/rate_limit_tracker.py` | 246 | `format_rate_limit_compact, format_rate_limit_display, parse_rate_limit_headers, RateLimitBucket, RateLimitState` | Parse + format inference-API rate-limit headers. |
| `agent/redact.py` | 467 | `mask_secret, redact_sensitive_text, RedactingFormatter` | Regex-based secret redaction for logs and tool output. |
| `agent/retry_utils.py` | 57 | `jittered_backoff` | Decorrelated jittered backoff. |
| `agent/secret_sources/__init__.py` | 13 | _(none)_ | Package marker. |
| `agent/secret_sources/bitwarden.py` | 515 | `apply_bitwarden_secrets, fetch_bitwarden_secrets, FetchResult, find_bws, install_bws` | Bitwarden Secrets Manager (`bws` CLI) integration — auto-install pinned binary, fetch + cache. |
| `agent/shell_hooks.py` | 847 | `allowlist_entry_for, allowlist_path, iter_configured_hooks, load_allowlist, register_from_config, reset_for_tests, revoke, run_once, save_allowlist, script_is_executable, script_mtime_iso, ShellHookSpec` | Shell-script hook bridge — reads `hooks:` from cli-config.yaml, prompts consent, registers callbacks via existing plugin hook manager. |
| `agent/skill_bundles.py` | 410 | `build_bundle_invocation_message, bundle_path_for, delete_bundle, get_bundle, get_skill_bundles, list_bundles, reload_bundles, resolve_bundle_command_key, save_bundle, scan_bundles` | Skill bundles — aliases that load multiple skills under one slash command. |
| `agent/skill_commands.py` | 523 | `build_preloaded_skills_prompt, build_skill_invocation_message, get_skill_commands, reload_skills, resolve_skill_command_key, scan_skill_commands` | Slash-command helpers for skills. |
| `agent/skill_preprocessing.py` | 139 | `expand_inline_shell, load_skills_config, preprocess_skill_content, run_inline_shell, substitute_template_vars` | Preprocess SKILL.md (template vars, inline shell expansion). |
| `agent/skill_utils.py` | 566 | `discover_all_skill_config_vars, extract_skill_conditions, extract_skill_config_vars, extract_skill_description, get_all_skills_dirs, get_disabled_skill_names, get_external_skills_dirs, is_excluded_skill_path, is_valid_namespace, iter_skill_index_files, parse_frontmatter, parse_qualified_name, resolve_skill_config_values, skill_matches_platform, yaml_load` | Lightweight skill-metadata utilities shared with prompt_builder and the skills tool. |
| `agent/stream_diag.py` | 280 | `emit_stream_drop, flatten_exception_chain, log_stream_retry, stream_diag_capture_response, stream_diag_init` | Per-attempt stream diagnostics + exception-chain logging. |
| `agent/subdirectory_hints.py` | 224 | `SubdirectoryHintTracker` | Progressive subdirectory-CONTEXT.md hint discovery. |
| `agent/system_prompt.py` | 346 | `build_system_prompt, build_system_prompt_parts, format_tools_for_system_message, invalidate_system_prompt` | System-prompt assembly for AIAgent (uses prompt_builder pieces). |
| `agent/think_scrubber.py` | 386 | `StreamingThinkScrubber` | Stateful streaming scrubber for `<think>` blocks in assistant text. |
| `agent/title_generator.py` | 171 | `auto_title_session, generate_title, maybe_auto_title` | Auto-generate short session titles from first user/assistant exchange (auxiliary LLM). |
| `agent/tool_dispatch_helpers.py` | 350 | `make_tool_result_message` | Tool-dispatch helpers — parallelism gating, multimodal envelopes, mutation tracking. |
| `agent/tool_executor.py` | 910 | `execute_tool_calls_concurrent, execute_tool_calls_sequential` | Sequential + concurrent tool-call dispatch. |
| `agent/tool_guardrails.py` | 475 | `append_toolguard_guidance, canonical_tool_args, classify_tool_failure, ToolCallGuardrailConfig, ToolCallGuardrailController, ToolCallSignature, toolguard_synthetic_result, ToolGuardrailDecision` | Pure guardrail primitives for the tool-call loop (repeat-detect, synthetic results). |
| `agent/tool_result_classification.py` | 26 | `file_mutation_result_landed` | Tiny helper — did a file-mutation tool result land? |
| `agent/trajectory.py` | 56 | `convert_scratchpad_to_think, has_incomplete_scratchpad, save_trajectory` | Trajectory file saving + static helpers. |
| `agent/transports/__init__.py` | 68 | `get_transport, register_transport` | Transport registry. |
| `agent/transports/anthropic.py` | 179 | `AnthropicTransport` | Anthropic Messages transport. Wraps `anthropic_adapter`. |
| `agent/transports/base.py` | 89 | `ProviderTransport` | ABC for transports. |
| `agent/transports/bedrock.py` | 154 | `BedrockTransport` | Bedrock Converse transport. Wraps `bedrock_adapter`. |
| `agent/transports/chat_completions.py` | 629 | `ChatCompletionsTransport` | Default OpenAI chat-completions transport (~16 providers). Lots of provider-specific `build_kwargs` branches. |
| `agent/transports/codex_app_server_session.py` | 810 | `CodexAppServerSession, TurnResult` | Owns one Codex thread per Hermes session; drives turn/start, polls notifications, handles approval requests. |
| `agent/transports/codex_app_server.py` | 399 | `check_codex_binary, CodexAppServerClient, CodexAppServerError, parse_codex_version` | JSON-RPC client over codex app-server stdio. |
| `agent/transports/codex_event_projector.py` | 312 | `CodexEventProjector, ProjectionResult` | Projects codex app-server events into Hermes `messages[]`. |
| `agent/transports/codex.py` | 280 | `ResponsesApiTransport` | OpenAI Responses API (Codex) transport. |
| `agent/transports/hermes_tools_mcp_server.py` | 233 | `main` | Standalone MCP server exposing Hermes tools to the codex_app_server runtime. Runs in subprocess. |
| `agent/transports/types.py` | 162 | `build_tool_call, map_finish_reason, NormalizedResponse, ToolCall, Usage` | Shared types for normalized provider responses. Foundation for the transport layer. |
| `agent/usage_pricing.py` | 877 | `BillingRoute, CanonicalUsage, CostResult, estimate_usage_cost, format_duration_compact, format_token_count_compact, get_pricing_entry, has_known_pricing, normalize_usage, PricingEntry, resolve_billing_route` | Per-turn cost estimation with `Decimal` precision and provider-specific billing routes. |
| `agent/video_gen_provider.py` | 299 | `error_response, save_b64_video, save_bytes_video, success_response, VideoGenProvider` | ABC + helpers for video-generation providers. |
| `agent/video_gen_registry.py` | 117 | `get_active_provider, get_provider, list_providers, register_provider` | Video-gen provider registry. |
| `agent/web_search_provider.py` | 221 | `WebSearchProvider` | ABC for web-search providers. |
| `agent/web_search_registry.py` | 262 | `get_active_crawl_provider, get_active_extract_provider, get_active_search_provider, get_provider, list_providers, register_provider` | Web-search/crawl/extract provider registry. |

**Total: 102 files / 63,297 LOC.**

---

## 3. Internal dependency graph

Adjacency was built by parsing every `^from agent[.]…` / `^import agent.…` / `^from . / from .. …` import in every `.py` file under `agent/`, resolving to the longest matching module path, and deduplicating. Files not listed below have **zero internal `agent/` dependencies** (61 leaves — they ground the dep graph; they can be ported first by anyone with no cross-talk).

| file | imports from (other `agent/*` files) |
|---|---|
| `agent/account_usage.py` | `agent/anthropic_adapter.py` |
| `agent/agent_init.py` | `agent/context_compressor.py, agent/iteration_budget.py, agent/memory_manager.py, agent/model_metadata.py, agent/process_bootstrap.py, agent/subdirectory_hints.py, agent/think_scrubber.py, agent/tool_guardrails.py` |
| `agent/agent_runtime_helpers.py` | `agent/error_classifier.py, agent/message_sanitization.py, agent/tool_dispatch_helpers.py, agent/trajectory.py` |
| `agent/auxiliary_client.py` | `agent/credential_pool.py, agent/portal_tags.py` |
| `agent/browser_registry.py` | `agent/browser_provider.py` |
| `agent/chat_completion_helpers.py` | `agent/error_classifier.py, agent/message_sanitization.py, agent/model_metadata.py, agent/retry_utils.py, agent/tool_dispatch_helpers.py, agent/tool_guardrails.py` |
| `agent/codex_responses_adapter.py` | `agent/prompt_builder.py` |
| `agent/context_compressor.py` | `agent/auxiliary_client.py, agent/context_engine.py, agent/model_metadata.py, agent/redact.py` |
| `agent/context_references.py` | `agent/model_metadata.py` |
| `agent/conversation_compression.py` | `agent/model_metadata.py` |
| `agent/conversation_loop.py` | `agent/anthropic_adapter.py, agent/auxiliary_client.py, agent/codex_responses_adapter.py, agent/display.py, agent/error_classifier.py, agent/iteration_budget.py, agent/memory_manager.py, agent/message_sanitization.py, agent/model_metadata.py, agent/nous_rate_guard.py, agent/process_bootstrap.py, agent/prompt_caching.py, agent/retry_utils.py, agent/trajectory.py, agent/usage_pricing.py` |
| `agent/copilot_acp_client.py` | `agent/file_safety.py, agent/redact.py` |
| `agent/curator_backup.py` | `agent/skill_utils.py` |
| `agent/display.py` | `agent/tool_result_classification.py` |
| `agent/gemini_cloudcode_adapter.py` | `agent/gemini_schema.py, agent/google_code_assist.py` |
| `agent/gemini_native_adapter.py` | `agent/gemini_schema.py` |
| `agent/image_gen_registry.py` | `agent/image_gen_provider.py` |
| `agent/insights.py` | `agent/usage_pricing.py` |
| `agent/lsp/__init__.py` | `agent/lsp/manager.py` |
| `agent/lsp/client.py` | `agent/lsp/protocol.py` |
| `agent/lsp/manager.py` | `agent/lsp/__init__.py, agent/lsp/client.py, agent/lsp/servers.py, agent/lsp/workspace.py` |
| `agent/lsp/servers.py` | `agent/lsp/workspace.py` |
| `agent/memory_manager.py` | `agent/memory_provider.py` |
| `agent/prompt_builder.py` | `agent/skill_utils.py` |
| `agent/skill_commands.py` | `agent/skill_preprocessing.py` |
| `agent/subdirectory_hints.py` | `agent/prompt_builder.py` |
| `agent/system_prompt.py` | `agent/prompt_builder.py` |
| `agent/title_generator.py` | `agent/auxiliary_client.py` |
| `agent/tool_dispatch_helpers.py` | `agent/tool_result_classification.py` |
| `agent/tool_executor.py` | `agent/display.py, agent/tool_dispatch_helpers.py, agent/tool_guardrails.py` |
| `agent/tool_guardrails.py` | `agent/tool_result_classification.py` |
| `agent/transports/__init__.py` | `agent/transports/types.py` |
| `agent/transports/anthropic.py` | `agent/transports/__init__.py, agent/transports/base.py, agent/transports/types.py` |
| `agent/transports/base.py` | `agent/transports/types.py` |
| `agent/transports/bedrock.py` | `agent/transports/__init__.py, agent/transports/base.py, agent/transports/types.py` |
| `agent/transports/chat_completions.py` | `agent/lmstudio_reasoning.py, agent/moonshot_schema.py, agent/prompt_builder.py, agent/transports/__init__.py, agent/transports/base.py, agent/transports/types.py` |
| `agent/transports/codex.py` | `agent/transports/__init__.py, agent/transports/base.py, agent/transports/types.py` |
| `agent/transports/codex_app_server_session.py` | `agent/redact.py, agent/transports/codex_app_server.py, agent/transports/codex_event_projector.py` |
| `agent/usage_pricing.py` | `agent/model_metadata.py` |
| `agent/video_gen_registry.py` | `agent/video_gen_provider.py` |
| `agent/web_search_registry.py` | `agent/web_search_provider.py` |

**Stats:** 102 nodes, 94 directed edges, 1 non-trivial SCC.

**The one cycle:** `agent/lsp/__init__.py ↔ agent/lsp/manager.py`. This is the standard package-init re-export pattern: `__init__.py` exposes `get_service`/`shutdown_service` that delegate to `manager.LSPService`, and `manager.py` imports the package for side-effect registration. In TS this should be flattened — keep `manager.ts` as the implementation and have `index.ts` re-export from it (one-way only). **Faithful-divergence call:** allowed.

**Hubs (most-imported / foundation files — port these first):**

| in-degree | file | role |
|---:|---|---|
| 7 | `agent/model_metadata.py` | Context-length cache + token estimation. Everyone needs it. |
| 6 | `agent/transports/types.py` | `NormalizedResponse`, `ToolCall`, `Usage`. Foundation of transport layer. |
| 4 | `agent/prompt_builder.py` | System-prompt pieces. |
| 4 | `agent/transports/__init__.py`, `agent/transports/base.py` | Transport ABC + registry. |
| 3 | `tool_guardrails.py`, `error_classifier.py`, `message_sanitization.py`, `tool_dispatch_helpers.py`, `redact.py`, `auxiliary_client.py`, `tool_result_classification.py` | Cross-cutting helpers used by ≥3 siblings. |

**Fan-out (integrators — port these last):**

| out-degree | file |
|---:|---|
| 15 | `agent/conversation_loop.py` |
| 8 | `agent/agent_init.py` |
| 6 | `agent/chat_completion_helpers.py`, `agent/transports/chat_completions.py` |
| 4 | `agent/agent_runtime_helpers.py`, `agent/context_compressor.py`, `agent/lsp/manager.py` |

---

## 4. External dependency graph

### 4a. Upstream sibling-package dependencies (the agent → other-packages graph)

Per-file imports from upstream packages outside `agent/` (i.e. `hermes_constants`, `hermes_logging`, `hermes_cli`, `tools`, `utils`, `model_tools`). This is what blocks the agent port behind tasks #1–#4 (core, state, providers, trajectory) and what feeds **into** task #6 (tools — but with a controlled cycle, see §5).

| file | cross-module imports |
|---|---|
| `agent/account_usage.py` | `from hermes_cli.auth import _read_codex_tokens, resolve_codex_runtime_credentials` · `from hermes_cli.runtime_provider import resolve_runtime_provider` |
| `agent/agent_init.py` | `hermes_cli.config.cfg_get` · `hermes_cli.timeouts.get_provider_request_timeout` · `hermes_constants.get_hermes_home` · `model_tools.check_toolset_requirements, get_tool_definitions` · `utils.base_url_host_matches` |
| `agent/agent_runtime_helpers.py` | `hermes_cli.timeouts.get_provider_request_timeout` · `utils.base_url_host_matches, base_url_hostname, env_var_enabled, atomic_json_write` |
| `agent/anthropic_adapter.py` | `hermes_constants.get_hermes_home` · `utils.base_url_host_matches, normalize_proxy_env_vars` |
| `agent/auxiliary_client.py` | `hermes_cli.__version__` · `hermes_cli.config.get_hermes_home` · `hermes_constants.OPENROUTER_BASE_URL` · `utils.base_url_host_matches, base_url_hostname, normalize_proxy_env_vars` |
| `agent/chat_completion_helpers.py` | `hermes_cli.timeouts.get_provider_request_timeout, get_provider_stale_timeout` · `tools.terminal_tool.is_persistent_env` · `utils.base_url_host_matches, base_url_hostname` |
| `agent/conversation_loop.py` | `hermes_constants.display_hermes_home` · `hermes_logging.set_session_context` · `tools.schema_sanitizer.strip_pattern_and_format` · `tools.skill_provenance.set_current_write_origin` · `utils.base_url_host_matches, env_var_enabled` |
| `agent/credential_pool.py` | `hermes_cli.auth (large import list)` · `hermes_cli.config.get_env_value, load_env` · `hermes_constants.OPENROUTER_BASE_URL` · `import hermes_cli.auth as auth_mod` |
| `agent/curator_backup.py` | `hermes_constants.get_hermes_home` |
| `agent/curator.py` | `hermes_constants.get_hermes_home` · `tools.skill_usage` |
| `agent/display.py` | `utils.safe_json_loads` |
| `agent/google_oauth.py` | `hermes_constants.get_hermes_home, secure_parent_dir` · `utils.atomic_replace` |
| `agent/memory_manager.py` | `tools.registry.tool_error` |
| `agent/model_metadata.py` | `hermes_constants.OPENROUTER_MODELS_URL` · `utils.base_url_host_matches, base_url_hostname` |
| `agent/models_dev.py` | `utils.atomic_json_write` |
| `agent/nous_rate_guard.py` | `utils.atomic_replace` |
| `agent/process_bootstrap.py` | `utils.base_url_hostname, normalize_proxy_url` |
| `agent/prompt_builder.py` | `hermes_constants.get_hermes_home, get_skills_dir, is_wsl` · `utils.atomic_json_write` |
| `agent/shell_hooks.py` | `hermes_constants.get_hermes_home` · `utils.atomic_replace` |
| `agent/skill_bundles.py` | `hermes_constants.get_hermes_home` |
| `agent/skill_commands.py` | `hermes_constants.display_hermes_home` |
| `agent/skill_utils.py` | `hermes_constants.get_config_path, get_skills_dir, is_termux` |
| `agent/tool_executor.py` | `tools.terminal_tool (large import list)` · `tools.tool_result_storage (large import list)` |
| `agent/tool_guardrails.py` | `utils.safe_json_loads` |
| `agent/usage_pricing.py` | `utils.base_url_host_matches` |

**Controlled cycle with `tools/`:** four files (`agent_init`, `chat_completion_helpers`, `conversation_loop`, `curator`, `memory_manager`, `tool_executor`) import from `tools/*`, but `tools/` is task #6 and is downstream of `agent`. The upstream resolves this with **lazy/local imports inside function bodies** — when porting, mark these as `import { … } from "@hermests/tools"` calls and rely on lazy `import()` (or a package-cycle break: pull the minimal interface tools uses up to `@hermests/core`). Document each in the per-task brief.

### 4b. Third-party Python libraries (aggregated across all 102 agent files)

Frequency = number of files that import the module (counted via `^from X` / `^import X` after stripping suffix).

| count | python lib | category | suggested TS equivalent |
|---:|---|---|---|
| 94 | `typing` | stdlib | native TS types |
| 75 | `__future__` | stdlib | n/a (stripped — TS doesn't need PEP 563) |
| 63 | `logging` | stdlib | `pino` or repo's own logger from `@hermests/core` |
| 44 | `os` | stdlib | `node:fs`, `node:os`, `node:path`, `process.env` |
| 38 | `json` | stdlib | `JSON.parse`/`JSON.stringify` (use `safe-json-stringify` for cycles) |
| 32 | `pathlib` | stdlib | `node:path` + `node:fs/promises` |
| 28 | `threading` | stdlib | **No direct equiv.** Use `worker_threads` only when blocking work; otherwise re-architect to event-loop / `AsyncLocalStorage` |
| 28 | `re` | stdlib | TS `RegExp` (note: Python `(?P<name>)` → `(?<name>)`; verify lookbehind support) |
| 27 | `time` | stdlib | `Date.now()`, `performance.now()`, `process.hrtime.bigint()` for monotonic |
| 21 | `dataclasses` | stdlib | TS `class` / `interface` (use `readonly` for frozen) |
| 16 | `utils` | upstream — task #1 `@hermests/core` | (intra-port) |
| 15 | `urllib` | stdlib | `URL`, `URLSearchParams`; `urllib.request` → `fetch` |
| 14 | `hermes_constants` | upstream — task #1 `@hermests/core` | (intra-port) |
| 14 | `datetime` | stdlib | `Date` + `dayjs` or `date-fns` |
| 12 | `uuid` | stdlib | `crypto.randomUUID()` (Node 19+) |
| 11 | `hermes_cli` | upstream — task #14 `@hermests/cli` | (intra-port; **cycle risk** — see §5) |
| 10 | `sys` | stdlib | `process.argv`, `process.exit`, `process.stdin/stdout/stderr` |
| 8 | `types` | stdlib (`SimpleNamespace`) | plain object literal `{}` or `class` |
| 8 | `subprocess` | stdlib | `node:child_process` (`spawn`, `execFile`) — never `exec` for security |
| 7 | `tools` | upstream — task #6 `@hermests/tools` | (intra-port; lazy imports required, see §5) |
| 7 | `abc` | stdlib | TS `abstract class` |
| 6 | `tempfile` | stdlib | `os.tmpdir()` + `crypto.randomUUID()` + `node:fs/promises` |
| 6 | `hashlib` | stdlib | `node:crypto.createHash` |
| 6 | `copy` | stdlib | `structuredClone()` (Node 17+) |
| 6 | `base64` | stdlib | `Buffer.from(...).toString('base64')` |
| 6 | `asyncio` | stdlib | **No direct equiv.** Async/await is built-in; `asyncio.Queue` → custom or `p-queue`; `asyncio.gather` → `Promise.all`; `asyncio.wait_for` → `AbortSignal.timeout()` |
| 5 | `random` | stdlib | `Math.random()` or `node:crypto.randomInt` |
| 4 | `shutil` | stdlib | `node:fs/promises.cp`, `node:fs/promises.rm` |
| 4 | `concurrent` (`concurrent.futures`) | stdlib | `Promise.all` / `Promise.allSettled` / `p-limit` for bounded |
| 3 | `shlex` | stdlib | `shell-quote` npm package |
| 3 | `httpx` | third-party | `undici` (Node 18+ native `fetch`) |
| 3 | `difflib` | stdlib | `diff` npm package |
| 3 | `contextlib` | stdlib | `try/finally` blocks, async iterators with `Symbol.asyncDispose` |
| 3 | `collections` (mostly `OrderedDict`) | stdlib | `Map` (insertion-ordered since ES2015) |
| 2 | `yaml` (`PyYAML`) | third-party | `yaml` npm package |
| 2 | `stat` | stdlib | constants under `node:fs.constants` |
| 2 | `requests` | third-party | `undici` / `fetch` |
| 2 | `queue` | stdlib | custom or `p-queue` |
| 2 | `platform` | stdlib | `process.platform`, `os.arch()`, `os.release()` |
| 2 | `mimetypes` | stdlib | `mime-types` npm package |
| 2 | `inspect` | stdlib | n/a — TS has no runtime reflection; rework call sites |
| 2 | `functools` | stdlib | `lru-cache`, manual memoization |
| 2 | `contextvars` | stdlib | **`AsyncLocalStorage` from `node:async_hooks`** — see §5 (tricky construct) |
| 1 each | `zipfile, tarfile, ssl, secrets, ipaddress, http, enum, decimal, atexit, argparse, wcwidth` | mixed | `adm-zip`/`tar-stream`, `node:tls`, `node:crypto.randomBytes`, `ipaddr.js`, `node:http`/`undici`, TS string-literal unions or `enum`, `decimal.js`, `process.on('exit')`, `commander` / `yargs`, `string-width` |
| 1 | `pydantic` | third-party | `zod` |
| 1 | `boto3`/`botocore` (in `bedrock_adapter.py`) | third-party | `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-bedrock` |
| 1 | `anthropic` SDK | third-party | direct `fetch` (upstream is already mostly hand-rolled HTTP — keep that path) |
| 4 | `openai` SDK | third-party | direct `fetch` for chat completions; for the Responses API use `openai` npm package |
| 1 | `google.*` | third-party | direct `fetch` (upstream is hand-rolled — keep) |
| 6 | `prompt_toolkit` | third-party | `@inquirer/prompts` for prompts, raw ANSI for spinner (already done by `display.py`) |
| 16 | `aiohttp`/`httpx` | third-party | `undici` |

**Key observation:** the upstream is almost entirely hand-rolled HTTP — only 4 files use the `openai` SDK, 1 uses `anthropic`, 1 uses `boto3`. **This is a huge porting simplification:** the adapters can be ported verbatim using `fetch`/`undici` without dragging in heavy SDK shims. The exception is `bedrock_adapter.py` which uses the AWS SDK directly for credential chain + Converse API.

---

## 5. Tricky upstream constructs

The handful of Python-specific patterns that need a "faithful divergence" call when ported to TS. Each row is one named hazard; details below explain why and what to do.

| location | construct | why it's tricky | suggested TS approach |
|---|---|---|---|
| `agent/conversation_loop.py:121-127` (and ~30 other sites) | **`_ra()` lazy `import run_agent`** | The pattern `def _ra(): import run_agent; return run_agent` lets tests monkey-patch symbols on `run_agent.*` (e.g. `run_agent.OpenAI`, `run_agent.handle_function_call`, `run_agent._set_interrupt`) and have those patches reach the extracted function bodies. There is no equivalent in TS — `jest.mock` / `vi.mock` work at module-resolution time, not runtime attribute lookup. | Two options: **(a)** convert each `_ra()` call site to take the patchable symbol as a constructor arg on `AIAgent` (DI), and have the upstream test become an "AIAgent fixture with `openaiClient` override". **(b)** Keep a global `RunAgentRegistry` object that tests can mutate; pay the awkwardness cost. Recommend **(a)** — the test contract becomes cleaner. Document this divergence in the per-task brief; ~30 call sites affected. |
| `agent/conversation_loop.py:25` · `agent/tool_executor.py:21` · `agent/credential_pool.py:8` · ~25 other files | **`threading` + `threading.Lock` + `threading.local`** | 28 files use `threading.Lock`, `threading.local`, or `threading.Event` for synchronization. Hermes is multi-threaded: one main thread for the event loop, daemon threads for background review (`background_review.spawn_background_review_thread`), curator runs, LSP service (`agent/lsp/manager.py` runs an asyncio loop in a background thread bridged to sync callers via `loop.call_soon_threadsafe`), shell-hook execution. | Node has no shared-memory threads. **Most locks can be deleted** because Node's event loop is single-threaded by default — verify each `Lock` site to confirm it was only protecting against multi-thread races, not async re-entrancy. For asyncio-loop-in-background patterns (LSP), use `node:worker_threads` only if the work is CPU-bound; otherwise re-architect to run the loop on the main thread (Node's `fetch`/`fs` are async natively). `threading.local` → `AsyncLocalStorage`. |
| `agent/tool_executor.py:18` · `agent/auxiliary_client.py` · `agent/conversation_loop.py` | **`contextvars.ContextVar` for per-turn interrupt flag** | Hermes uses `ContextVar("interrupt_requested")` to propagate Ctrl+C and cancellation across async boundaries without explicit plumbing. | `AsyncLocalStorage` from `node:async_hooks`. Wrap turn entry in `als.run(store, async () => …)`. **Critical:** `AsyncLocalStorage` does NOT propagate across `setTimeout` in all Node versions — verify behavior in target Node. |
| `agent/conversation_loop.py` (multiple sites) · `agent/chat_completion_helpers.py` · `agent/auxiliary_client.py` (`async_call_llm`) | **`asyncio.create_task` + `wait_for(..., timeout)` + cancellation** | Wraps long-running provider calls in `asyncio.wait_for(coro, timeout=N)` and treats `asyncio.CancelledError` distinctly from other exceptions. Cancellation propagates to the streaming HTTP read. | Wrap each provider call with `AbortController` + `AbortSignal.timeout(N * 1000)` and pass `signal` to `fetch`. Catch `AbortError` (DOMException) separately from network errors. The pattern is well-supported in `undici` and native `fetch`. |
| `agent/lsp/manager.py:21-30` (LSPService) | **Single asyncio event loop running on a background `threading.Thread`** | The LSP client is async; the rest of `tools/file_operations.py` is sync; the bridge is a dedicated daemon thread that owns an asyncio loop and a `Queue`. Sync callers do `service.get_diagnostics_sync(...)` which calls `asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=N)`. | Node is fully async — there is no sync caller above. Re-architect: make `tools/file_operations` async at the call sites that touch LSP, and have `LSPService` expose only async methods. The bridge thread disappears. **Faithful-divergence call:** justified (~50 lines of sync-bridging code deleted). Document in `lsp` sub-task. |
| `agent/transports/codex_app_server.py:9-14` · `agent/transports/codex_app_server_session.py:9-30` · `agent/transports/hermes_tools_mcp_server.py` | **`subprocess.Popen` + line-delimited JSON-RPC over stdin/stdout + reader threads** | Codex app-server is a subprocess; Hermes spawns it, sends `{"jsonrpc":"2.0"...}\n` lines, and reads stream responses. Reader threads push events to blocking-with-timeout `Queue` objects. Same pattern for the `hermes-tools` MCP server (which runs as a child of codex-app-server). | `node:child_process.spawn` returns streams; use `readline.createInterface({ input: proc.stdout })` to get an async iterator of lines. No reader thread needed — Node handles it. Wrap as `AsyncIterableIterator<CodexEvent>`. Test against fixture stdout. |
| `agent/anthropic_adapter.py:1-30` · `agent/secret_sources/bitwarden.py` · `agent/google_oauth.py` | **`subprocess.run(['claude', '--print-credentials'])` / `subprocess.run(['bws', ...])` for credential discovery + CLI tooling** | Some credentials live in the Claude CLI (`~/.claude.json`) or Bitwarden (`bws` CLI). Adapter shells out to those binaries to read or refresh. Also: PKCE flow uses `webbrowser.open()` plus a local HTTP server callback. | `node:child_process.execFile` (never `exec`/`spawn` with shell). For the local OAuth callback HTTP server, use `node:http.createServer`. For `webbrowser.open`, use `open` npm package. |
| `agent/credential_pool.py:1-30` · `agent/redact.py` | **`dataclass(frozen=True)` + `replace()`** | Lots of `@dataclass(frozen=True)` records that get cloned with `dataclasses.replace(obj, field=new_val)`. | TS `readonly` interface or `class`. For "clone with override", use spread: `{ ...obj, field: newVal }`. If you want true immutability, freeze in constructor. |
| `agent/usage_pricing.py:1-30` | **`decimal.Decimal` arithmetic** | Cost calculation uses `Decimal` for precision: `Decimal("0.000003") * Decimal(tokens)`. JS `Number` loses precision for sub-cent values. | `decimal.js` (or `big.js` if no division). Wrap multiply/divide via helper to enforce string-source inputs. |
| `agent/gemini_native_adapter.py:18-30` · multiple adapters | **`from types import SimpleNamespace`** for ad-hoc records used as fake API-response objects | `SimpleNamespace(**dict)` is used to mock OpenAI-shaped response objects (`choices[0].message.content`) when translating from Gemini/Anthropic native shapes. | TS plain object literal with a structural type. No mocking needed — TS interfaces are duck-typed. |
| `agent/auxiliary_client.py` (`neuter_async_httpx_del`) | **Monkey-patching `httpx.AsyncClient.__del__`** to avoid noisy GC errors | `__del__` runs at GC time and complains about non-closed clients; the patch silences it. | Not needed in TS — `undici` clients are explicitly closed, not GC-finalized. Delete this whole helper. |
| `agent/redact.py` (`RedactingFormatter`) | **`logging.Formatter` subclass that mutates log records** | Python's logging has a Formatter hook that fires per record. Used to scrub secrets from every log line. | `pino` has built-in `redact` config. Use that, list paths to scrub. Much simpler. |
| `agent/anthropic_adapter.py` · `agent/google_oauth.py` | **Atomic file write via `os.replace(tmp, dst)` + `os.chmod(0o600)`** | OAuth tokens are stored with strict perms, written through a temp file to avoid torn writes. | `node:fs/promises.writeFile` + `node:fs/promises.rename` (atomic on POSIX) + `node:fs/promises.chmod`. Wrap in a `writeAtomic600(path, contents)` helper in `@hermests/core`. |
| `agent/context_compressor.py` · `agent/conversation_compression.py` | **Hashlib content fingerprints** | Caches compressor outputs keyed by `hashlib.sha256(messages_repr).hexdigest()`. | `node:crypto.createHash('sha256').update(...).digest('hex')`. |
| `agent/message_sanitization.py` (`_sanitize_messages_surrogates`) | **UTF-16 surrogate handling + non-ASCII stripping** | Python strings are Unicode-code-point arrays; surrogate pairs encode characters >U+FFFF. The sanitizer strips lone surrogates and optionally non-ASCII. | JS strings are UTF-16 — surrogate pairs are visible. Use `String.prototype.codePointAt` and iterate by code points, not by `.length`. Test with emoji + lone surrogate fixtures. |
| `agent/markdown_tables.py` | **`wcwidth` for CJK / wide-char column alignment** | Markdown table re-alignment must know that 你好 is 4 cells wide, not 2 chars. | `string-width` npm package (the equivalent). |
| `agent/think_scrubber.py` · `agent/memory_manager.py:StreamingContextScrubber` | **Stateful streaming scrubbers that buffer partial token sequences** | Server-sent events arrive chunk-by-chunk; `<think>` open/close may straddle a chunk. The scrubber holds a small buffer and emits scrubbed text. | TS `TransformStream` or a small custom class with a buffer. Test with a streaming fixture split at every byte to verify partial-token handling. |
| `agent/tool_executor.py` (`execute_tool_calls_concurrent`) | **`concurrent.futures.ThreadPoolExecutor` for parallel tool dispatch** | When the model returns multiple tool calls and the toolset is marked parallel-safe, dispatch happens through a thread pool with bounded concurrency. | `Promise.all` for unbounded; `p-limit(N)` for bounded. No thread pool needed — tools are I/O-bound. |
| `agent/bedrock_adapter.py` | **`boto3` AWS credential chain** (IAM roles, SSO profiles, env vars, IMDSv2) | Hermes leans on boto3's credential resolution and never explicitly fetches credentials. | `@aws-sdk/credential-providers` (`fromNodeProviderChain`) handles the same chain. Pass into `BedrockRuntimeClient`. |
| `agent/transports/chat_completions.py` (`_build_gemini_thinking_config` + provider-specific branches) | **Provider-quirk conditionals in one giant `build_kwargs`** | The default chat-completions transport has ~16 provider-specific branches (`max_tokens` defaults, reasoning config, temperature handling, `extra_body` assembly per provider). | Keep the table-driven structure but use a `Map<ProviderId, BuildKwargsFn>` instead of `if/elif`. Each branch becomes a tiny function. This is also the right place to drop dead branches. |
| `agent/agent_init.py` (~1,600 LOC monolith) | **60+-parameter constructor with positional + kw overloads** | `init_agent(agent, *, model, base_url, ...)` takes more than 60 keyword arguments and does provider auto-detect, credential resolution, context-engine bootstrap inline. | Don't replicate verbatim. Introduce an `AIAgentOptions` interface and use object destructuring. Split the body into 6–8 named init steps (`autoDetectProvider`, `resolveCredentials`, `bootstrapContextEngine`, ...). Each step is its own testable export. Faithful-divergence call documented in `init` sub-task. |
| `agent/onboarding.py` (seen-state) · `agent/curator.py` · `agent/nous_rate_guard.py` | **`~/.hermes/*` file persistence with JSON + chmod + lock** | All these helpers write small JSON state files in `~/.hermes/`. | Centralize in a `HermesHomeStore` in `@hermests/core` that gives `read<T>(name): Promise<T>`, `writeAtomic600(name, obj)`, `withLock(name, fn)`. |

**Patterns explicitly NOT problematic** (often expected as tricky but here they aren't): no metaclasses, no `__init_subclass__` / `__class_getitem__` / `__set_name__`, no descriptors (`__get__`/`__set__`/`__delete__`), no dynamic-class creation via `type(name, bases, dict)`, no multiple inheritance with diamond hierarchies. The grep confirmed zero hits across the module.

---

## 6. Upstream test mapping

108 upstream test files import from `agent.*`. Below is the full table with case counts (counted via `^(async )?def test_`). Total case count: **~3,000+ tests** when including the giant fixtures (`test_anthropic_adapter.py` at 152, `test_auxiliary_client.py` at 157, `test_error_classifier.py` at 136, `test_run_agent.py` at 337 — that one cuts across many agent modules and feeds task #14 as much as it does the agent module).

**For sub-task assignment, the rule is:** the porter who owns the agent module under test also owns porting the corresponding upstream test cases.

| test path | case count | agent modules imported |
|---|---:|---|
| `tests/agent/lsp/test_backend_gate.py` | 5 | `agent.lsp` |
| `tests/agent/lsp/test_broken_set.py` | 7 | `agent.lsp.manager, agent.lsp.servers, agent.lsp.workspace` |
| `tests/agent/lsp/test_client_e2e.py` | 6 | `agent.lsp.client` |
| `tests/agent/lsp/test_delta_key.py` | 18 | `agent.lsp.client, agent.lsp.manager, agent.lsp.range_shift` |
| `tests/agent/lsp/test_eventlog.py` | 18 | `agent.lsp` |
| `tests/agent/lsp/test_install_and_lint_fixes.py` | 12 | `agent.lsp.install` |
| `tests/agent/lsp/test_lifecycle.py` | 8 | `agent.lsp` |
| `tests/agent/lsp/test_protocol.py` | 18 | `agent.lsp.protocol` |
| `tests/agent/lsp/test_reporter.py` | 10 | `agent.lsp.reporter` |
| `tests/agent/lsp/test_service.py` | 5 | `agent.lsp.manager, agent.lsp.servers` |
| `tests/agent/lsp/test_workspace.py` | 12 | `agent.lsp.workspace` |
| `tests/agent/test_anthropic_adapter.py` | 152 | `agent.anthropic_adapter, agent.prompt_caching, agent.transports` |
| `tests/agent/test_anthropic_keychain.py` | 12 | `agent.anthropic_adapter` |
| `tests/agent/test_anthropic_oauth_pkce.py` | (under tests/agent/) | `agent.anthropic_adapter` |
| `tests/agent/test_arcee_trinity_overrides.py` | 6 | `agent.auxiliary_client` |
| `tests/agent/test_async_utils.py` | 6 | `agent.async_utils` |
| `tests/agent/test_auxiliary_client.py` | 157 | `agent.auxiliary_client` |
| `tests/agent/test_auxiliary_client_anthropic_custom.py` | _(small)_ | `agent.auxiliary_client` |
| `tests/agent/test_auxiliary_client_azure_foundry.py` | _(small)_ | `agent.auxiliary_client` |
| `tests/agent/test_auxiliary_named_custom_providers.py` | _(small)_ | `agent.auxiliary_client` |
| `tests/agent/test_azure_identity_adapter.py` | _(small)_ | `agent.azure_identity_adapter` |
| `tests/agent/test_compress_focus.py` | 4 | `agent.context_compressor` |
| `tests/agent/test_compressor_historical_media.py` | 27 | `agent.context_compressor` |
| `tests/agent/test_compressor_image_tokens.py` | 12 | `agent.context_compressor` |
| `tests/agent/test_context_compressor_summary_continuity.py` | 2 | `agent.context_compressor` |
| `tests/agent/test_context_compressor.py` | 83 | `agent.context_compressor` |
| `tests/agent/test_context_engine.py` | 19 | `agent.context_compressor, agent.context_engine` |
| `tests/agent/test_copilot_acp_client.py` | 7 | `agent.copilot_acp_client` |
| `tests/agent/test_copilot_acp_deprecation.py` | 6 | `agent.copilot_acp_client` |
| `tests/agent/test_curator_backup.py` | _(small)_ | `agent.curator_backup` |
| `tests/agent/test_curator_classification.py` | _(small)_ | `agent.curator` |
| `tests/agent/test_custom_provider_extra_body.py` | 3 | `agent.agent_init` |
| `tests/agent/test_deepseek_anthropic_thinking.py` | _(small)_ | `agent.anthropic_adapter` |
| `tests/agent/test_display_emoji.py` | 10 | `agent.display` |
| `tests/agent/test_display.py` | 31 | `agent.display` |
| `tests/agent/test_error_classifier.py` | 136 | `agent.error_classifier` |
| `tests/agent/test_external_skills_dirs_cache.py` | 6 | `agent.skill_utils` |
| `tests/agent/test_gemini_free_tier_gate.py` | 22 | `agent.gemini_native_adapter` |
| `tests/agent/test_gemini_native_adapter.py` | _(large)_ | `agent.gemini_native_adapter` |
| `tests/agent/test_gemini_schema.py` | 11 | `agent.gemini_schema` |
| `tests/agent/test_image_gen_registry.py` | 10 | `agent.image_gen_provider` |
| `tests/agent/test_image_routing.py` | 57 | `agent.image_routing` |
| `tests/agent/test_insights.py` | 56 | `agent.insights` |
| `tests/agent/test_kimi_coding_anthropic_thinking.py` | _(small)_ | `agent.anthropic_adapter` |
| `tests/agent/test_local_stream_timeout.py` | 9 | `agent.model_metadata` |
| `tests/agent/test_markdown_tables.py` | 15 | `agent.markdown_tables` |
| `tests/agent/test_memory_provider.py` | 74 | `agent.memory_manager, agent.memory_provider` |
| `tests/agent/test_memory_session_switch.py` | 12 | `agent.memory_manager, agent.memory_provider` |
| `tests/agent/test_memory_user_id.py` | 14 | `agent.memory_manager, agent.memory_provider` |
| `tests/agent/test_minimax_auxiliary_url.py` | 9 | `agent.auxiliary_client` |
| `tests/agent/test_model_metadata_ssl.py` | 9 | `agent.model_metadata` |
| `tests/agent/test_model_metadata.py` | 102 | `agent.model_metadata` |
| `tests/agent/test_models_dev.py` | 32 | `agent.models_dev` |
| `tests/agent/test_moonshot_schema.py` | 31 | `agent.moonshot_schema` |
| `tests/agent/test_onboarding.py` | 33 | `agent.onboarding` |
| `tests/agent/test_plugin_llm.py` | 56 | `agent.plugin_llm` |
| `tests/agent/test_prompt_builder.py` | 124 | `agent.prompt_builder` |
| `tests/agent/test_prompt_caching.py` | 14 | `agent.prompt_caching` |
| `tests/agent/test_proxy_and_url_validation.py` | 6 | `agent.auxiliary_client` |
| `tests/agent/test_rate_limit_tracker.py` | 24 | `agent.rate_limit_tracker` |
| `tests/agent/test_redact.py` | 80 | `agent.redact` |
| `tests/agent/test_shell_hooks.py` | _(medium)_ | `agent.shell_hooks` |
| `tests/agent/test_shell_hooks_consent.py` | _(medium)_ | `agent.shell_hooks` |
| `tests/agent/test_skill_bundles.py` | 33 | `agent.skill_bundles` |
| `tests/agent/test_skill_commands.py` | 41 | `agent.skill_commands` |
| `tests/agent/test_skill_commands_reload.py` | _(small)_ | `agent.skill_commands` |
| `tests/agent/test_skill_utils.py` | 15 | `agent.skill_utils` |
| `tests/agent/test_streaming_context_scrubber.py` | 21 | `agent.memory_manager` |
| `tests/agent/test_subagent_progress.py` | 21 | `agent.display` |
| `tests/agent/test_subdirectory_hints.py` | 18 | `agent.subdirectory_hints` |
| `tests/agent/test_system_prompt_restore.py` | 10 | `agent.conversation_loop` |
| `tests/agent/test_think_scrubber.py` | 27 | `agent.think_scrubber` |
| `tests/agent/test_title_generator.py` | 20 | `agent.title_generator` |
| `tests/agent/test_tool_guardrails.py` | 13 | `agent.tool_guardrails` |
| `tests/agent/test_tool_result_classification.py` | 3 | `agent.tool_result_classification` |
| `tests/agent/test_unsupported_parameter_retry.py` | 6 | `agent.auxiliary_client` |
| `tests/agent/test_unsupported_temperature_retry.py` | 7 | `agent.auxiliary_client` |
| `tests/agent/test_usage_pricing.py` | 11 | `agent.usage_pricing` |
| `tests/agent/test_video_gen_registry.py` | 10 | `agent.video_gen_provider` |
| `tests/agent/transports/test_bedrock_transport.py` | 19 | `agent.transports.types` |
| `tests/agent/transports/test_chat_completions.py` | 67 | `agent.transports.types` |
| `tests/agent/transports/test_codex_app_server_session.py` | 51 | `agent.transports.codex_app_server_session` |
| `tests/agent/transports/test_codex_event_projector.py` | 20 | `agent.transports.codex_event_projector` |
| `tests/agent/transports/test_codex_transport.py` | 39 | `agent.transports.types` |
| `tests/agent/transports/test_transport.py` | 23 | `agent.transports.base, agent.transports.types` |
| `tests/agent/transports/test_types.py` | 37 | `agent.transports.types` |
| `tests/gateway/test_compress_plugin_engine.py` | 2 | `agent.context_engine` _(cross-cutting; gateway also touches)_ |
| `tests/gateway/test_restart_drain.py` | 16 | `agent.i18n` _(cross-cutting)_ |
| `tests/gateway/test_session_hygiene.py` | 23 | `agent.model_metadata` _(cross-cutting)_ |
| `tests/hermes_cli/test_gemini_provider.py` | 46 | `agent.model_metadata, agent.models_dev` _(cross-cutting)_ |
| `tests/hermes_cli/test_gmi_provider.py` | 23 | `agent.auxiliary_client, agent.model_metadata` _(cross-cutting)_ |
| `tests/hermes_cli/test_image_gen_picker.py` | 14 | `agent.image_gen_provider` |
| `tests/hermes_cli/test_ollama_cloud_provider.py` | 45 | `agent.model_metadata, agent.models_dev` |
| `tests/hermes_cli/test_video_gen_picker.py` | 8 | `agent.video_gen_provider` |
| `tests/providers/test_e2e_wiring.py` | 6 | `agent.transports.chat_completions` |
| `tests/providers/test_profile_wiring.py` | 22 | `agent.transports.chat_completions` |
| `tests/providers/test_transport_parity.py` | 19 | `agent.transports.chat_completions` |
| `tests/run_agent/test_413_compression.py` | 15 | `agent.context_compressor` |
| `tests/run_agent/test_codex_app_server_integration.py` | 15 | `agent.transports.codex_app_server_session` |
| `tests/run_agent/test_codex_multimodal_tool_result.py` | 7 | `agent.codex_responses_adapter` |
| `tests/run_agent/test_compression_boundary.py` | 6 | `agent.context_compressor` |
| `tests/run_agent/test_compression_feasibility.py` | 16 | `agent.context_compressor` |
| `tests/run_agent/test_compressor_fallback_update.py` | 2 | `agent.context_compressor` |
| `tests/run_agent/test_image_shrink_recovery.py` | 13 | `agent.error_classifier` |
| `tests/run_agent/test_multimodal_tool_content_recovery.py` | 15 | `agent.error_classifier` |
| `tests/run_agent/test_plugin_context_engine_init.py` | 2 | `agent.context_engine` |
| `tests/run_agent/test_provider_parity.py` | 83 | `agent.codex_responses_adapter` |
| `tests/run_agent/test_run_agent_multimodal_prologue.py` | 15 | `agent.codex_responses_adapter` |
| `tests/run_agent/test_run_agent.py` | 337 | `agent.codex_responses_adapter, agent.error_classifier, agent.prompt_builder` |
| `tests/run_agent/test_session_reset_fix.py` | 4 | `agent.context_compressor` |
| `tests/run_agent/test_switch_model_context.py` | 2 | `agent.context_compressor` |
| `tests/run_agent/test_tool_name_db_persistence.py` | 1 | `agent.tool_dispatch_helpers` |
| `tests/test_account_usage.py` | 4 | `agent.account_usage` |
| `tests/test_bitwarden_secrets.py` | 20 | `agent.secret_sources` |
| `tests/test_ollama_num_ctx.py` | 8 | `agent.model_metadata` |
| `tests/test_retry_utils.py` | 9 | `agent.retry_utils` |
| `tests/test_sql_injection.py` | 4 | `agent.insights` |
| `tests/tools/test_image_generation_plugin_dispatch.py` | 3 | `agent.image_gen_provider` _(cross-cutting; tools)_ |
| `tests/tools/test_llm_content_none_guard.py` | 28 | `agent.auxiliary_client` _(cross-cutting; tools)_ |
| `tests/tools/test_video_generation_dispatch.py` | 7 | `agent.video_gen_provider` _(cross-cutting; tools)_ |
| `tests/tools/test_video_generation_dynamic_schema.py` | 5 | `agent.video_gen_provider` _(cross-cutting; tools)_ |

**Cross-cutting note:** ~10 of these tests live under `tests/gateway/`, `tests/hermes_cli/`, `tests/tools/`, `tests/providers/` but happen to import from `agent.*` (mostly `agent.model_metadata`, `agent.auxiliary_client`, the registries). These should be ported alongside their **primary** module (gateway / cli / tools / providers) once the agent dependency exists — the agent porter is NOT responsible for these. Marked above.

The `tests/run_agent/test_run_agent.py` monster (337 cases) is largely a **task #14 (cli) responsibility** even though it imports a few agent symbols — those imports are only there to set up the AIAgent fixture; the test bodies exercise `run_agent.AIAgent.run_conversation` end-to-end. Coordinate with the cli porter.

---

## 7. Subdivision plan

The strategy: respect the dep graph. Port foundations first, integrators last. Three waves:

* **Wave A (5 sub-tasks):** foundation files with zero or trivial agent-internal deps. Parallel from the moment tasks #1–#4 land.
* **Wave B (7 sub-tasks):** mid-layer modules — adapters, helpers, registries. Depend on at least one Wave A sub-task and on `@hermests/providers`/`@hermests/tools` types.
* **Wave C (3 sub-tasks):** integrators — conversation loop, agent_init, tool_executor. Last to merge.

15 sub-tasks total, sized 1–7 kLOC each:

| sub-task # | scope (files) | LOC | depends on (other sub-tasks) | depends on (packages) | recommended porter |
|---|---|---:|---|---|---|
| **5a** | **agent-core-utils** — `async_utils.py`, `retry_utils.py`, `iteration_budget.py`, `tool_result_classification.py`, `trajectory.py`, `lmstudio_reasoning.py`, `gemini_schema.py`, `moonshot_schema.py`, `i18n.py`, `manual_compression_feedback.py`, `portal_tags.py`, `prompt_caching.py`, `markdown_tables.py`, `process_bootstrap.py`, `file_safety.py`, `system_prompt.py`, `subdirectory_hints.py`, `trajectory.py`, `secret_sources/__init__.py`, `__init__.py` | ~2,600 | _(none)_ | `@hermests/core` | porter-A-foundations |
| **5b** | **transports-foundation** — `transports/types.py`, `transports/base.py`, `transports/__init__.py`, `transports/anthropic.py`, `transports/bedrock.py`, `transports/codex.py`, `transports/chat_completions.py` (transport layer ports + tests) | ~1,400 | _(none)_ | `@hermests/core`, `@hermests/providers` | porter-B-transports |
| **5c** | **model-metadata + pricing** — `model_metadata.py`, `models_dev.py`, `usage_pricing.py`, `rate_limit_tracker.py`, `nous_rate_guard.py`, `context_references.py` | ~4,200 | _(none)_ | `@hermests/core` | porter-C-metadata |
| **5d** | **registries + provider ABCs** — `browser_provider.py`, `browser_registry.py`, `image_gen_provider.py`, `image_gen_registry.py`, `image_routing.py`, `video_gen_provider.py`, `video_gen_registry.py`, `web_search_provider.py`, `web_search_registry.py`, `context_engine.py`, `memory_provider.py` | ~2,500 | _(none)_ | `@hermests/core` | porter-D-registries |
| **5e** | **error-classifier + sanitizers + redaction** — `error_classifier.py`, `message_sanitization.py`, `redact.py`, `think_scrubber.py`, `tool_dispatch_helpers.py`, `tool_guardrails.py`, `stream_diag.py` | ~3,300 | _(none)_ | `@hermests/core` | porter-E-classifier |
| **5f** | **skill plumbing** — `skill_utils.py`, `skill_preprocessing.py`, `skill_commands.py`, `skill_bundles.py`, `prompt_builder.py`, `onboarding.py`, `title_generator.py` (later — depends on 5j auxiliary_client) | ~3,700 | 5j | `@hermests/core` | porter-F-skills |
| **5g** | **auth + credentials** — `credential_pool.py`, `credential_sources.py`, `secret_sources/bitwarden.py`, `google_oauth.py`, `azure_identity_adapter.py`, `google_code_assist.py` | ~5,000 | _(none)_ | `@hermests/core`, `@hermests/cli`-auth-types (extract minimal interface) | porter-G-auth |
| **5h** | **anthropic + bedrock adapters** — `anthropic_adapter.py`, `bedrock_adapter.py`, `prompt_caching.py` (full surface), `transports/anthropic.py` and `transports/bedrock.py` wrappers | ~3,700 | 5b, 5g | `@hermests/providers` | porter-H-anthropic |
| **5i** | **gemini + codex + copilot adapters** — `gemini_native_adapter.py`, `gemini_cloudcode_adapter.py`, `codex_responses_adapter.py`, `codex_runtime.py`, `copilot_acp_client.py`, `transports/codex.py` | ~4,200 | 5b, 5g | `@hermests/providers` | porter-I-gemini-codex |
| **5j** | **auxiliary client** — `auxiliary_client.py` (the 5,289-LOC monster — its own sub-task). Splitting it further introduces cycles. | ~5,300 | 5g, 5h, 5i (needs all three adapters to route to) | `@hermests/providers` | porter-J-aux |
| **5k** | **context compression** — `context_compressor.py`, `conversation_compression.py`, `memory_manager.py` (depends on memory_provider in 5d), `account_usage.py`, `insights.py` | ~4,200 | 5c, 5d, 5e, 5j | `@hermests/core` | porter-K-compress |
| **5l** | **curator + background review + shell hooks + display** — `curator.py`, `curator_backup.py`, `background_review.py`, `shell_hooks.py`, `display.py`, `plugin_llm.py` | ~5,800 | 5e, 5f, 5j | `@hermests/core` | porter-L-curator |
| **5m** | **LSP subpackage** — all of `agent/lsp/*` (10 files: __init__, cli, client, eventlog, install, manager, protocol, range_shift, reporter, servers, workspace) | ~4,300 | 5a | `@hermests/core` | porter-M-lsp |
| **5n** | **codex app-server transport** — `transports/codex_app_server.py`, `transports/codex_app_server_session.py`, `transports/codex_event_projector.py`, `transports/hermes_tools_mcp_server.py` | ~1,800 | 5b, 5e (uses `redact`) | `@hermests/core`, `@hermests/tools` (for the MCP-server child) | porter-N-codex-appserver |
| **5o** | **integrators — agent_init + chat_completion_helpers + tool_executor + agent_runtime_helpers + conversation_loop** | ~11,100 | **all prior sub-tasks (5a–5n)** | `@hermests/core`, `@hermests/state`, `@hermests/providers`, `@hermests/trajectory`, `@hermests/tools` (lazy import) | porter-O-integrators |

**Subtotals:**
* Wave A (5a–5e): ~14,000 LOC — 5 porters in parallel as soon as #1 + relevant tasks land.
* Wave B (5f–5n): ~38,000 LOC — 9 porters, partially in parallel (5h/5i/5j must chain, 5j unlocks 5f/5k/5l).
* Wave C (5o): ~11,100 LOC — 1 porter, depends on all of the above. Hardest single sub-task.

**Sum:** ~63,000 LOC — matches the upstream total within ~300 LOC of rounding.

---

## 8. Effort estimates

Assuming:
* a competent TS porter at ~150 net LOC/day for greenfield (read upstream, port, write Vitest tests to 100% coverage, run typecheck);
* heavy adapters (Anthropic, Bedrock, Gemini, Codex) at ~120 LOC/day (more provider quirks, more fixture engineering);
* integrators at ~80 LOC/day (cross-cutting changes, hardest to test).

| sub-task | LOC | rate (LOC/day) | est. days |
|---|---:|---:|---:|
| 5a agent-core-utils | 2,600 | 150 | **17** |
| 5b transports-foundation | 1,400 | 120 | **12** |
| 5c model-metadata + pricing | 4,200 | 150 | **28** |
| 5d registries + provider ABCs | 2,500 | 150 | **17** |
| 5e error-classifier + sanitizers | 3,300 | 150 | **22** |
| 5f skill plumbing | 3,700 | 150 | **25** |
| 5g auth + credentials | 5,000 | 120 | **42** |
| 5h anthropic + bedrock adapters | 3,700 | 120 | **31** |
| 5i gemini + codex + copilot | 4,200 | 120 | **35** |
| 5j auxiliary client | 5,300 | 120 | **44** |
| 5k context compression | 4,200 | 150 | **28** |
| 5l curator + background review + display | 5,800 | 150 | **39** |
| 5m LSP subpackage | 4,300 | 120 | **36** |
| 5n codex app-server transport | 1,800 | 120 | **15** |
| 5o integrators | 11,100 | 80 | **139** |
| **Total person-days (serial)** | **63,100** | | **~530** |
| **Wall-clock with full 15-porter parallelism** | | | **~140 days** (limited by 5o critical path: max wave time = 44d (5j) → 39d (5l) → 139d (5o), but 5o starts only after all of A+B complete, so ~250 days wall-clock realistically — call it **~10 months with 15 porters** vs. **~24 months serial**) |

**Variance drivers (push estimates up):**
* Hitting 100% coverage on the 30+ `_ra()`-patched call sites — every test needs a DI shim before it can be ported.
* The `threading` ↔ `async` re-architecture in `lsp/manager.py` and `tool_executor.py` is non-trivial; budget extra design-review time.
* `auxiliary_client.py` is one file but contains 21 named exports plus dozens of provider-quirk branches — splitting it into 3 TS files (sync/async/anthropic) during port is recommended but adds ~3 days.
* The `tools/` cycle (§4a) needs a clean break. If task #6 (tools) lands first, this is free; if tasks ship in parallel, plan a 2-day interface-extraction PR jointly with the tools porter.

**Variance drivers (pull estimates down):**
* Almost no third-party SDK use — adapters are already mostly `fetch`-based. ~10% savings.
* No metaclasses / descriptors / multiple-inheritance hairballs. Direct class translation works for ~95% of types.
* Each upstream file has a thorough docstring header explaining purpose and design — reading time per file is minutes, not hours.

---

## Appendix A — generated artifacts (in this branch under `.scratch/`, not committed)

Deterministic data used to build this brief:
* `file_inventory.tsv` — 102 rows: path, LOC, exports.
* `dep_graph.tsv` — 102 rows: adjacency list (file → comma-separated dep paths).
* `internal_deps.tsv` — raw `from agent.*` / `from .*` lines per file.
* `external_deps.tsv` — all non-agent imports per file.
* `upstream_cross_module.tsv` — sibling-package imports (`hermes_*`, `tools`, `utils`, etc.) per file.
* `third_party_libs.txt` — frequency-sorted module names.
* `test_case_counts.tsv` — 107 rows: test path, case count, imported agent modules.
* `tricky_constructs.tsv` — grep hits for metaclass/dunder-hook/descriptor/dynamic-class/contextvar/asyncio/multi-inherit/signal/process-io patterns.

These are not committed (the brief replaces them) but can be regenerated from the upstream with the snippets in this PR description.
