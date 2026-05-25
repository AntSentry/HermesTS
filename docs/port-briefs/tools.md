# Port Brief: `@hermests/tools`

Upstream commit/ref: `github.com/nousresearch/hermes-agent` @ `main`
Local cache: `/Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main`

Generated for task **#6 — Port @hermests/tools**. Splits `tools/` (95 files,
67,868 LOC) plus the three standalone files `toolsets.py` (866),
`toolset_distributions.py` (364), and `model_tools.py` (923) — **~70,021 LOC
total** — into independently portable sub-tasks.

---

## 1. Module summary

`tools/` is the largest single Python module in the upstream agent and the
**source of every callable tool the LLM exposes**. It is not one homogeneous
codebase; it is roughly twelve distinct subsystems glued together by a single
in-process tool registry. Each tool file follows the same shape:

1. Imports `from tools.registry import registry, tool_error, tool_result`.
2. Defines one or more handler callables (`def my_tool(args, **kw) -> str`).
3. Defines a `check_<feature>_requirements()` predicate.
4. At module-import time, calls `registry.register(name=..., toolset=...,
   schema=..., handler=..., check_fn=..., ...)` to publish itself.

The two pieces that make this hang together:

- **`tools/registry.py`** (590 LOC) — `ToolRegistry` singleton, `ToolEntry`
  dataclass-equivalent, `discover_builtin_tools()` (AST-scans the
  `tools/` directory for files that contain top-level `registry.register(...)`
  calls and imports them), `tool_error()` / `tool_result()` JSON helpers, and
  a TTL cache for `check_fn` probes. **This is the keystone of the entire
  module — everything else is a leaf hanging off it.**
- **`toolsets.py`** (866 LOC, sibling of `tools/`) — declarative grouping
  of tool names into toolsets (`"web"`, `"browser"`, `"terminal"`,
  `"file"`, etc.) plus `resolve_toolset()`, `validate_toolset()`,
  `create_custom_toolset()`. Toolsets compose other toolsets via an
  `includes` list. No imports from `tools/`.
- **`toolset_distributions.py`** (364 LOC) — sampling distributions over
  toolsets for RL/datagen runs. Depends only on `toolsets.py`.
- **`model_tools.py`** (923 LOC) — thin orchestration façade. `import`s the
  registry plus the tool modules (via `discover_builtin_tools()`), then
  exports `get_tool_definitions()`, `handle_function_call()`,
  `coerce_tool_args()`, and `_sanitize_tool_error()`. Heavily memoised by
  registry generation + config-file mtime fingerprint. **All upstream callers
  (run_agent, cli, batch_runner, gateway) talk to `model_tools.py`, not the
  registry.**

The eleven subsystem clusters inside `tools/` (with raw LOC totals):

| Cluster | Files | LOC | Notes |
|---|---:|---:|---|
| Core/registry/types | 11 | 4,253 | `registry`, `interrupt`, `path_security`, `binary_extensions`, `lazy_deps`, etc. |
| File ops + patch | 5 | 4,744 | `file_operations`, `file_tools`, `file_state`, `fuzzy_match`, `patch_parser` |
| Terminal / exec / sandbox | 5 | 8,067 | `terminal_tool`, `code_execution_tool`, `process_registry`, `checkpoint_manager`, `osv_check` |
| Environments (sandbox backends) | 13 | 5,094 | `environments/` subpackage (8 backends + base + sync + utils + managed) |
| Browser automation | 7 | 7,196 | `browser_tool`, `browser_supervisor`, `browser_cdp_tool`, `browser_camofox*`, `browser_dialog_tool`, `website_policy`, `url_safety` |
| Web/search | 3 | 2,438 | `web_tools`, `x_search_tool`, `xai_http` |
| Skills | 9 | 9,224 | `skills_tool`, `skills_hub`, `skills_guard`, `skills_sync`, `skill_manager_tool`, `skill_usage`, `skill_provenance`, `skills_dir` glue |
| MCP | 4 | 4,839 | `mcp_tool`, `mcp_oauth_manager`, `mcp_oauth`, `schema_sanitizer` |
| Computer-use (macOS GUI) | 6 | 2,050 | `computer_use_tool` + `computer_use/` subpackage |
| Delegation / kanban / approval / todo | 8 | 7,723 | `delegate_tool`, `kanban_tools`, `approval`, `clarify_tool`, `clarify_gateway`, `todo_tool`, `interrupt`, `slash_confirm` |
| Media (vision/image/video/audio) | 7 | 7,243 | `vision_tools`, `image_generation_tool`, `video_generation_tool`, `tts_tool`, `transcription_tools`, `voice_mode`, `neutts_synth` |
| Messaging / 3rd-party platforms | 9 | 5,247 | `send_message_tool`, `discord_tool`, `yuanbao_tools`, `homeassistant_tool`, `feishu_doc_tool`, `feishu_drive_tool`, `microsoft_graph_*`, `cronjob_tools` |
| Memory / session search | 2 | 1,292 | `memory_tool`, `session_search_tool` |
| Misc plumbing | 6 | 1,755 | `tirith_security` (CLI installer), `mixture_of_agents_tool`, `tool_backend_helpers`, `tool_output_limits`, `tool_result_storage`, `managed_tool_gateway`, `credential_files`, `openrouter_client`, `env_passthrough`, `fal_common` |

Subdivision (section 7) follows these cluster boundaries.

---

## 2. File inventory

All paths relative to upstream root. LOC = `wc -l` raw. Each file's exports
column lists module-level `def`/`class` names (private `_underscore` symbols
omitted unless externally consumed elsewhere in the codebase).

### Standalone (top-level) files

| LOC | Path | Top-level exports |
|---:|---|---|
| 866 | `toolsets.py` | `TOOLSETS` (dict), `get_toolset`, `resolve_toolset`, `resolve_multiple_toolsets`, `get_all_toolsets`, `get_toolset_names`, `validate_toolset`, `create_custom_toolset`, `get_toolset_info` |
| 364 | `toolset_distributions.py` | `DISTRIBUTIONS` (dict), `get_distribution`, `list_distributions`, `sample_toolsets_from_distribution`, `validate_distribution`, `print_distribution_info` |
| 923 | `model_tools.py` | `get_tool_definitions`, `_compute_tool_definitions`, `coerce_tool_args`, `handle_function_call`, `get_all_tool_names`, `get_toolset_for_tool`, `get_available_toolsets`, `check_toolset_requirements`, `check_tool_availability`, `_sanitize_tool_error`, `_get_tool_loop`, `_get_worker_loop`, `_run_async`, `_clear_tool_defs_cache`, module-level `_LEGACY_TOOLSET_MAP`, `_AGENT_LOOP_TOOLS`, `_READ_SEARCH_TOOLS` |

### `tools/` flat files

| LOC | Path | Top-level exports |
|---:|---|---|
| 25 | `__init__.py` | `check_file_requirements` |
| 44 | `ansi_strip.py` | `strip_ansi` |
| 1424 | `approval.py` | `set_current_session_key`, `reset_current_session_key`, `get_current_session_key`, `detect_hardline_command`, `detect_dangerous_command`, `_ApprovalEntry`, `register_gateway_notify`, `unregister_gateway_notify`, `resolve_gateway_approval`, `has_blocking_approval`, `submit_pending`, `approve_session`, `enable_session_yolo`, `disable_session_yolo`, `clear_session`, `is_session_yolo_enabled` |
| 42 | `binary_extensions.py` | `BINARY_EXTENSIONS` (set), `has_binary_extension` |
| 47 | `browser_camofox_state.py` | `get_camofox_state_dir`, `get_camofox_identity` |
| 699 | `browser_camofox.py` | `get_camofox_url`, `is_camofox_mode`, `check_camofox_available`, `get_vnc_url`, `camofox_soft_cleanup`, `camofox_navigate`, `camofox_snapshot`, `camofox_click`, `camofox_type`, `camofox_scroll`, `camofox_back`, `camofox_press` |
| 570 | `browser_cdp_tool.py` | `browser_cdp` (tool handler), `_browser_cdp_check` |
| 148 | `browser_dialog_tool.py` | `browser_dialog`, `_browser_dialog_check` |
| 1457 | `browser_supervisor.py` | `PendingDialog`, `DialogRecord`, `FrameInfo`, `ConsoleEvent`, `SupervisorSnapshot`, `CDPSupervisor`, `_SupervisorRegistry`, `SUPERVISOR_REGISTRY` |
| 3796 | `browser_tool.py` | Tool handlers `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_press`, `browser_get_images`, `browser_vision`, `browser_console` plus ~30 helpers (engine detection, cloud-provider routing, lightpanda fallback, dialog policy, CDP supervisor lifecycle) |
| 51 | `budget_config.py` | `BudgetConfig` (dataclass), `DEFAULT_RESULT_SIZE_CHARS` constant |
| 1638 | `checkpoint_manager.py` | `CheckpointManager`, `format_checkpoint_list`, `prune_checkpoints`, `maybe_auto_prune_checkpoints`, `store_status` |
| 278 | `clarify_gateway.py` | `_ClarifyEntry`, `register`, `wait_for_response`, `resolve_gateway_clarify`, `get_pending_for_session`, `mark_awaiting_text`, `has_pending`, `clear_session`, `get_clarify_timeout`, `register_notify`, `unregister_notify`, `get_notify` |
| 141 | `clarify_tool.py` | `clarify_tool`, `check_clarify_requirements` |
| 1783 | `code_execution_tool.py` | `execute_code`, `check_sandbox_requirements`, `generate_hermes_tools_module`, `build_execute_code_schema`, `SANDBOX_ALLOWED_TOOLS`, `SANDBOX_AVAILABLE`, plus internal RPC machinery (`_rpc_server_loop`, `_rpc_poll_loop`, `_execute_remote`, `_get_or_create_env`) |
| 39 | `computer_use_tool.py` | Shim: imports + re-exports from `computer_use/` subpackage |
| 436 | `credential_files.py` | `register_credential_file`, `register_credential_files`, `get_credential_file_mounts`, `get_skills_directory_mount`, `iter_skills_files`, `get_cache_directory_mounts`, `to_agent_visible_cache_path`, `iter_cache_files`, `clear_credential_files` |
| 775 | `cronjob_tools.py` | `cronjob` (handler), `check_cronjob_requirements`, plus ~15 helpers (`_format_job`, `_scan_cron_prompt`, `_validate_cron_script_path`, `_normalize_deliver_param`, `_resolve_model_override`) |
| 105 | `debug_helpers.py` | `DebugSession` (context manager + recorder) |
| 2801 | `delegate_tool.py` | `set_spawn_paused`, `is_spawn_paused`, `interrupt_subagent`, `list_active_subagents`, `DelegateEvent` (Enum), `check_delegate_requirements`, `DELEGATE_BLOCKED_TOOLS` (frozenset), plus the delegate handler and `_build_child_system_prompt`, `_subagent_auto_deny`/`auto_approve` callbacks |
| 959 | `discord_tool.py` | `DiscordAPIError`, plus per-action handlers `_list_guilds`, `_server_info`, `_list_channels`, `_channel_info`, `_list_roles`, `_member_info`, `_search_members`, `_fetch_messages`, `_list_pins`, `_pin_message`, `_unpin_message`, `_delete_message`, `_create_thread`, `_add_role`, `_remove_role`, `_detect_capabilities`, `_build_schema`, plus the registered `discord` tool handler |
| 145 | `env_passthrough.py` | `register_env_passthrough`, `is_env_passthrough`, `get_all_passthrough`, `clear_env_passthrough` |
| 163 | `fal_common.py` | `import_fal_client`, `_ManagedFalSyncClient` |
| 138 | `feishu_doc_tool.py` | `set_client`, `get_client`, handler `_handle_feishu_doc_read` (registered) |
| 431 | `feishu_drive_tool.py` | `set_client`, `get_client`, handlers `_handle_list_comments`, `_handle_list_replies`, `_handle_reply_comment`, `_handle_add_comment` |
| 1910 | `file_operations.py` | `ReadResult`, `WriteResult`, `PatchResult`, `SearchMatch`, `SearchResult`, `LintResult`, `ExecuteResult` (dataclasses), `FileOperations` (ABC), `ShellFileOperations`, `normalize_read_pagination`, `normalize_search_pagination` |
| 332 | `file_state.py` | `FileStateRegistry`, `get_registry`, `record_read`, `note_write`, `check_stale`, `lock_path`, `writes_since`, `known_reads` |
| 1177 | `file_tools.py` | Handlers `read_file_tool`, `write_file_tool`, `patch_tool`, `search_tool`; `clear_file_ops_cache`, `reset_file_dedup`, `notify_other_tool_call`, plus dispatch wrappers `_handle_read_file`, `_handle_write_file`, `_handle_patch`, `_handle_search_files` |
| 703 | `fuzzy_match.py` | `fuzzy_find_and_replace`, `find_closest_lines`, `format_no_match_hint`, plus 10 strategy functions (`_strategy_exact`, `_strategy_line_trimmed`, `_strategy_whitespace_normalized`, `_strategy_indentation_flexible`, `_strategy_escape_normalized`, `_strategy_trimmed_boundary`, `_strategy_unicode_normalized`, `_strategy_block_anchor`, `_strategy_context_aware`) |
| 513 | `homeassistant_tool.py` | Handlers `_handle_list_entities`, `_handle_get_state`, `_handle_call_service`, `_handle_list_services`; check `_check_ha_available` |
| 996 | `image_generation_tool.py` | `image_generate_tool`, `check_fal_api_key`, `check_image_generation_requirements`, `_handle_image_generate`, plus FAL backend helpers (`_submit_fal_request`, `_build_fal_payload`, `_upscale_image`, `_resolve_managed_fal_gateway`) |
| 98 | `interrupt.py` | `set_interrupt`, `is_interrupted`, `_interrupt_event` (re-exported), `_ThreadAwareEventProxy` |
| 1297 | `kanban_tools.py` | Handlers `_handle_show`, `_handle_list`, `_handle_complete`, `_handle_block`, `_handle_heartbeat`, `_handle_comment`, `_handle_create`, `_handle_unblock`, `_handle_link` |
| 613 | `lazy_deps.py` | `LAZY_DEPS` (dict — single source of truth for optional pip deps), `FeatureUnavailable`, `_InstallResult`, `ensure`, `is_available`, `feature_install_command`, `active_features`, `refresh_active_features`, `ensure_and_bind`, `feature_specs`, `feature_missing` |
| 167 | `managed_tool_gateway.py` | `ManagedToolGatewayConfig`, `auth_json_path`, `read_nous_access_token`, `get_tool_gateway_scheme`, `build_vendor_gateway_url`, `resolve_managed_tool_gateway`, `is_managed_tool_gateway_ready` |
| 607 | `mcp_oauth_manager.py` | `_ProviderEntry`, `MCPOAuthManager`, `get_manager`, `reset_manager_for_tests` |
| 648 | `mcp_oauth.py` | `OAuthNonInteractiveError`, `HermesTokenStorage`, `remove_oauth_tokens`, `build_oauth_auth`, plus internal `_wait_for_callback`, `_redirect_handler`, `_make_callback_handler` |
| 3584 | `mcp_tool.py` | `SamplingHandler`, `MCPServerTask`, `InvalidMcpUrlError`; module-level connector loop bootstrap; tool registration happens dynamically per MCP server tool discovered |
| 690 | `memory_tool.py` | `MemoryStore`, `memory_tool`, `check_memory_requirements`, `get_memory_dir` |
| 245 | `microsoft_graph_auth.py` | `MicrosoftGraphAuthError`, `MicrosoftGraphConfigError`, `MicrosoftGraphTokenError`, `GraphCredentials`, `CachedAccessToken`, `MicrosoftGraphTokenProvider` |
| 408 | `microsoft_graph_client.py` | `MicrosoftGraphClientError`, `MicrosoftGraphAPIError`, `MicrosoftGraphClient` |
| 542 | `mixture_of_agents_tool.py` | `mixture_of_agents_tool` (async), `check_moa_requirements`, `get_moa_configuration` |
| 104 | `neutts_synth.py` | `_write_wav`, `main` (CLI entry) |
| 33 | `openrouter_client.py` | `get_async_client`, `check_api_key` |
| 155 | `osv_check.py` | `check_package_for_malware`, `_infer_ecosystem`, `_parse_package_from_args`, `_parse_npm_package`, `_parse_pypi_package`, `_query_osv` |
| 622 | `patch_parser.py` | `OperationType` (Enum), `HunkLine`, `Hunk`, `PatchOperation` (dataclasses), `parse_v4a_patch`, `apply_v4a_operations` |
| 43 | `path_security.py` | `validate_within_dir`, `has_traversal_component` |
| 1544 | `process_registry.py` | `format_uptime_short`, `ProcessSession` (dataclass), `ProcessRegistry`, `format_process_notification`, `_handle_process` (registered handler) |
| 589 | `registry.py` | `discover_builtin_tools`, `ToolEntry`, `ToolRegistry`, `registry` (singleton), `tool_error`, `tool_result`, `invalidate_check_fn_cache` |
| 445 | `schema_sanitizer.py` | `sanitize_tool_schemas`, `strip_nullable_unions`, `strip_pattern_and_format`, `strip_slash_enum` |
| 1812 | `send_message_tool.py` | `send_message_tool` (handler), plus 13 platform-specific senders (`_send_telegram`, `_send_slack`, `_send_whatsapp`, `_send_signal`, `_send_email`, `_send_sms`, `_send_mattermost`, `_send_matrix`, `_send_matrix_via_adapter`, `_send_homeassistant`, `_send_dingtalk`, `_send_via_adapter`, `_send_to_platform`) |
| 602 | `session_search_tool.py` | `session_search`, `check_session_search_requirements`, plus internal `_scroll`, `_discover`, `_list_recent_sessions`, `_shape_message` |
| 931 | `skill_manager_tool.py` | `skill_manage` (handler), `_create_skill`, `_edit_skill`, `_patch_skill`, `_delete_skill`, `_write_file`, `_remove_file`, `_security_scan_skill`, `_validate_*` helpers |
| 78 | `skill_provenance.py` | `set_current_write_origin`, `reset_current_write_origin`, `get_current_write_origin`, `is_background_review` |
| 608 | `skill_usage.py` | `latest_activity_at`, `activity_count`, `list_agent_created_skill_names`, `list_archived_skill_names`, `is_agent_created`, `load_usage`, `save_usage`, `get_record`, `bump_view`, `bump_use`, `bump_patch`, `mark_agent_created`, `set_state` |
| 952 | `skills_guard.py` | `Finding`, `ScanResult`, `scan_file`, `scan_skill`, `should_allow_install`, `format_scan_report`, `content_hash`, `TRUSTED_REPOS` |
| 3456 | `skills_hub.py` | `SkillMeta`, `SkillBundle`, `GitHubAuth`, `SkillSource` (ABC), 9 concrete sources (`GitHubSource`, `WellKnownSkillSource`, `UrlSource`, `SkillsShSource`, `ClawHubSource`, `ClaudeMarketplaceSource`, `LobeHubSource`, `BrowseShSource`, `OptionalSkillSource`), `HubLockFile`, `TapsManager`, `append_audit_log`, `ensure_hub_dirs` |
| 434 | `skills_sync.py` | `sync_skills`, `reset_bundled_skill` |
| 1567 | `skills_tool.py` | `SkillReadinessStatus` (Enum), `set_secret_capture_callback`, `skill_matches_platform`, `check_skills_requirements`, `load_env`, plus handlers for the registered `skills_list` and `skill_view` tools |
| 167 | `slash_confirm.py` | `register`, `get_pending`, `clear`, `clear_if_stale`, `resolve`, `resolve_sync_compat` |
| 2379 | `terminal_tool.py` | `terminal` (handler — registered), `set_sudo_password_callback`, `set_approval_callback`, `register_task_env_overrides`, `clear_task_env_overrides`, plus extensive helpers (`_transform_sudo_command`, `_rewrite_real_sudo_invocations`, `_rewrite_compound_background`, `_check_all_guards`, `_validate_workdir`, `_handle_sudo_failure`, `_prompt_for_sudo_password`) |
| 803 | `tirith_security.py` | `is_platform_supported`, `ensure_installed`, `check_command_security`; tirith binary install/verify (cosign + sha256) |
| 277 | `todo_tool.py` | `TodoStore`, `todo_tool`, `check_todo_requirements` |
| 144 | `tool_backend_helpers.py` | `managed_nous_tools_enabled`, `normalize_browser_cloud_provider`, `coerce_modal_mode`, `normalize_modal_mode`, `has_direct_modal_credentials`, `resolve_modal_backend_state`, `resolve_openai_audio_api_key`, `prefers_gateway`, `fal_key_is_configured` |
| 92 | `tool_output_limits.py` | `get_tool_output_limits`, `get_max_bytes`, `get_max_lines`, `get_max_line_length` |
| 232 | `tool_result_storage.py` | `generate_preview`, `maybe_persist_tool_result`, `enforce_turn_budget` |
| 963 | `transcription_tools.py` | `transcribe_audio`, `is_stt_enabled`, plus per-provider backends (`_transcribe_local`, `_transcribe_local_command`, `_transcribe_groq`, `_transcribe_openai`, `_transcribe_mistral`, `_transcribe_xai`) |
| 2369 | `tts_tool.py` | TTS providers wrapped under registered handler; helpers `_run_command_tts`, `_render_command_tts_template`, provider importers `_import_edge_tts`, `_import_elevenlabs`, `_import_openai_client`, `_import_mistral_client`, `_import_kittentts`, `_import_piper`, `_import_sounddevice` |
| 351 | `url_safety.py` | `is_always_blocked_url`, `is_safe_url`, plus internal IP/host guards (`_is_blocked_ip`, `_allows_private_ip_resolution`, `_global_allow_private_urls`) |
| 561 | `video_generation_tool.py` | `check_video_generation_requirements`, `_handle_video_generate` (registered), `_build_dynamic_video_schema`, `_resolve_active_provider` |
| 1421 | `vision_tools.py` | `vision_analyze_tool` (async, registered), `video_analyze_tool` (async), `check_vision_requirements`, `_handle_vision_analyze`, `_handle_video_analyze`, plus image/video download + mime detection helpers |
| 1129 | `voice_mode.py` | `TermuxAudioRecorder`, `AudioRecorder`, `create_audio_recorder`, `play_beep`, `is_whisper_hallucination`, `transcribe_recording`, `stop_playback`, `play_audio_file`, `check_voice_requirements`, `cleanup_temp_recordings`, `detect_audio_environment` |
| 1561 | `web_tools.py` | `web_search_tool`, `web_extract_tool` (async), `web_crawl_tool` (async), `check_web_api_key`, `check_auxiliary_model`, `process_content_with_llm`, `clean_base64_images` |
| 282 | `website_policy.py` | `WebsitePolicyError`, `load_website_blocklist`, `check_website_access`, `invalidate_cache` |
| 526 | `x_search_tool.py` | `x_search_tool` (registered), `check_x_search_requirements`, `_handle_x_search` |
| 128 | `xai_http.py` | `has_xai_credentials`, `get_env_value`, `hermes_xai_user_agent`, `resolve_xai_http_credentials` |
| 737 | `yuanbao_tools.py` | `get_group_info`, `query_group_members`, `search_sticker`, `send_sticker`, `send_dm` (async), plus dispatch wrappers `_handle_yb_*` |

### `tools/computer_use/` subpackage

| LOC | Path | Top-level exports |
|---:|---|---|
| 43 | `__init__.py` | (re-exports) |
| 158 | `backend.py` | `UIElement`, `CaptureResult`, `ActionResult`, `ComputerUseBackend` (ABC) |
| 735 | `cua_backend.py` | `CuaDriverBackend`, `cua_driver_binary_available`, `cua_driver_install_hint`, plus `_CuaDriverSession`, `_AsyncBridge`, `_parse_element`, `_parse_elements_from_tree` |
| 213 | `schema.py` | `COMPUTER_USE_SCHEMA`, `get_computer_use_schema` |
| 749 | `tool.py` | `handle_computer_use`, `set_approval_callback`, `check_computer_use_requirements`, `get_computer_use_schema`, `reset_backend_for_tests`, `_NoopBackend` |
| 152 | `vision_routing.py` | `should_route_capture_to_aux_vision` |

### `tools/environments/` subpackage

| LOC | Path | Top-level exports |
|---:|---|---|
| 14 | `__init__.py` | (re-exports) |
| 854 | `base.py` | `BaseEnvironment` (ABC), `ProcessHandle` (Protocol), `_ThreadedProcessHandle`, `set_activity_callback`, `touch_activity_if_due`, `get_sandbox_dir`, `_popen_bash`, `_pipe_stdin`, `_load_json_store`, `_save_json_store`, `_file_mtime_key`, `_cwd_marker` |
| 270 | `daytona.py` | `DaytonaEnvironment` |
| 656 | `docker.py` | `DockerEnvironment`, `find_docker`, plus 7 setup helpers (`_normalize_forward_env_names`, `_normalize_env_dict`, `_load_hermes_env_vars`, `_build_security_args`, `_resolve_host_user_spec`, `_ensure_docker_available`) |
| 402 | `file_sync.py` | `FileSyncManager`, `iter_sync_files`, `quoted_rm_command`, `quoted_mkdir_command`, `unique_parent_dirs` |
| 677 | `local.py` | `LocalEnvironment`, `_find_shell`, `_resolve_safe_cwd`, `_sanitize_subprocess_env`, `_HERMES_PROVIDER_ENV_BLOCKLIST`, plus shell-init resolution |
| 282 | `managed_modal.py` | `ManagedModalEnvironment`, `_ManagedModalExecHandle` |
| 199 | `modal_utils.py` | `PreparedModalExec`, `ModalExecStart`, `BaseModalExecutionEnvironment`, `wrap_modal_stdin_heredoc`, `wrap_modal_sudo_pipe` |
| 478 | `modal.py` | `ModalEnvironment`, `_AsyncWorker`, snapshot store helpers |
| 262 | `singularity.py` | `SingularityEnvironment`, `_find_singularity_executable`, `_ensure_singularity_available`, `_get_scratch_dir`, `_get_apptainer_cache_dir`, `_get_or_build_sif` |
| 308 | `ssh.py` | `SSHEnvironment`, `_ensure_ssh_available` |
| 654 | `vercel_sandbox.py` | `VercelSandboxEnvironment`, `_SandboxCreateParams`, `_retry_vercel_call`, `_extract_status_code`, `_is_transient_vercel_error`, `_sandbox_status_type`, `_terminal_sandbox_states` |

---

## 3. Internal dependency graph

(Within `tools/`, `toolsets.py`, `toolset_distributions.py`, `model_tools.py`.)

The internal graph is **shallow but star-shaped around `registry.py`**. Most
tool files have exactly one internal dep: `from tools.registry import
registry, tool_error[, tool_result]`. The rest of the internal edges follow
predictable subsystem groupings.

### Hubs (incoming edges, ranked)

| Module | Incoming edges | Role |
|---|---:|---|
| `tools/registry.py` | ~60+ (every tool file) | Tool registration, dispatch, schema lookup. Foundation. |
| `tools/environments/base.py` | 11 (every other env backend + `terminal_tool` + `code_execution_tool` + `file_operations`) | `BaseEnvironment` ABC. |
| `tools/environments/file_sync.py` | 4 (docker, ssh, singularity, modal) | File staging for remote backends. |
| `tools/managed_tool_gateway.py` | 6 (browser, image, vision, tts, transcription, video, web) | Resolves whether to route a vendor API call through the Nous managed gateway vs direct creds. |
| `tools/tool_backend_helpers.py` | 7 (terminal, browser, tts, transcription, image, web, vision) | Cross-tool config helpers (modal/managed/fal/browser-cloud normalization). |
| `tools/interrupt.py` | 4 (terminal, browser, code_execution, environments/base) | Shared interrupt flag. |
| `tools/website_policy.py` | 3 (browser, web, browser_cdp) | Domain blocklist enforcement. |
| `tools/url_safety.py` | 3 (browser, web, browser_cdp) | SSRF/IP guard. |
| `tools/debug_helpers.py` | 4 (terminal, browser, code_execution, file_tools) | Per-task debug recorder. |
| `tools/binary_extensions.py` | 2 (file_operations, file_tools) | Extension-based binary detection. |

### Subsystem-specific internal clusters

- **File ops cluster**:
  `file_tools.py` → `file_operations.py` (`ShellFileOperations`) → `binary_extensions.py`, `path_security.py`, `fuzzy_match.py`, `patch_parser.py`, `file_state.py`. Also `file_tools.py` calls into `tools.environments.base` via `terminal_tool._active_environments` to get an `env` to wrap.

- **Terminal cluster**:
  `terminal_tool.py` → `environments/local.py`, `environments/docker.py`, `environments/modal.py`, `environments/ssh.py`, `environments/singularity.py`, `environments/daytona.py`, `environments/managed_modal.py`, `environments/vercel_sandbox.py`; also `tool_backend_helpers`, `interrupt`, `managed_tool_gateway`, `debug_helpers`, `approval`. → `process_registry.py` for background processes.
  `code_execution_tool.py` → same env list + `environments/file_sync.py` + `osv_check.py` + `env_passthrough.py`. Drives RPC.

- **Browser cluster**:
  `browser_tool.py` → `browser_supervisor.py` (CDP supervisor lifecycle), `browser_cdp_tool.py`, `browser_camofox*.py`, `website_policy.py`, `url_safety.py`, `tool_backend_helpers.py`. Plus `browser_cdp_tool.py` and `browser_dialog_tool.py` both consult `browser_supervisor.SUPERVISOR_REGISTRY`.

- **Skills cluster**:
  `skills_tool.py` → `skills_guard.py`, `skill_usage.py`, `skill_provenance.py`. `skill_manager_tool.py` → `skills_guard.py`, `skill_usage.py`, `skills_tool.py` (for find/list helpers). `skills_hub.py` → `skills_guard.py`, `url_safety.py`, `website_policy.py`. `skills_sync.py` is standalone.

- **MCP cluster**:
  `mcp_tool.py` → `mcp_oauth.py` (auth), `mcp_oauth_manager.py` (token store), `schema_sanitizer.py` (clean inbound tool schemas before registering with the registry).

- **Computer-use cluster**:
  `computer_use_tool.py` (39 LOC shim) → `computer_use/tool.py` → `computer_use/cua_backend.py` → `computer_use/backend.py`, `computer_use/schema.py`, `computer_use/vision_routing.py`.

- **Approval / clarify / delegate**:
  `approval.py` is standalone except `tool_output_limits` consumers. `clarify_tool.py` → `clarify_gateway.py`. `delegate_tool.py` → `terminal_tool` (`set_approval_callback`), `toolsets.py` (`TOOLSETS`), `file_state.py`.

- **Standalone trio**:
  `toolsets.py` — zero internal deps (pure data + resolution).
  `toolset_distributions.py` → `toolsets.py` (`validate_toolset`).
  `model_tools.py` → `tools.registry`, `toolsets`. **Imports every tool file transitively via `discover_builtin_tools()`.**

### Ports order (within the module)

1. `registry.py`, `interrupt.py`, `path_security.py`, `binary_extensions.py`,
   `ansi_strip.py`, `tool_output_limits.py`, `budget_config.py`,
   `env_passthrough.py`, `lazy_deps.py`, `url_safety.py`, `website_policy.py`.
2. `tool_backend_helpers.py`, `managed_tool_gateway.py`, `credential_files.py`,
   `xai_http.py`, `openrouter_client.py`, `fal_common.py`,
   `schema_sanitizer.py`, `debug_helpers.py`.
3. `tools/environments/base.py`.
4. The eight environment backends (`local`, `docker`, `ssh`, `singularity`,
   `modal`, `managed_modal`, `daytona`, `vercel_sandbox`) + `file_sync.py` +
   `modal_utils.py`.
5. `file_state.py`, `fuzzy_match.py`, `patch_parser.py`, `file_operations.py`,
   `file_tools.py`.
6. `approval.py`, `slash_confirm.py`, `clarify_gateway.py`, `clarify_tool.py`,
   `interrupt.py`, `tool_result_storage.py`, `osv_check.py`.
7. `process_registry.py`, `terminal_tool.py`, `code_execution_tool.py`,
   `checkpoint_manager.py`.
8. Browser cluster (supervisor first, then tool/cdp/dialog/camofox).
9. MCP cluster (`schema_sanitizer.py` is needed first → `mcp_oauth.py` →
   `mcp_oauth_manager.py` → `mcp_tool.py`).
10. Computer-use (`backend.py` → `schema.py` → `vision_routing.py` →
    `cua_backend.py` → `tool.py` → top-level shim).
11. Media tools (vision, image, video, tts, transcription, voice_mode,
    neutts_synth).
12. Skills cluster (`skills_guard.py` → `skills_hub.py` → `skill_usage.py` →
    `skill_provenance.py` → `skills_sync.py` → `skills_tool.py` →
    `skill_manager_tool.py`).
13. Messaging/platforms (`send_message_tool.py`, `discord_tool.py`,
    `yuanbao_tools.py`, `homeassistant_tool.py`, `feishu_*`,
    `microsoft_graph_*`, `cronjob_tools.py`).
14. Standalone misc (`memory_tool.py`, `session_search_tool.py`,
    `mixture_of_agents_tool.py`, `todo_tool.py`, `delegate_tool.py`,
    `web_tools.py`, `x_search_tool.py`, `tirith_security.py`).
15. `toolsets.py`, `toolset_distributions.py`, `model_tools.py`.

---

## 4. External dependency graph

### Project-internal (other workspace packages)

| Import | Files | Target package |
|---|---:|---|
| `from hermes_constants import get_hermes_home, display_hermes_home, ...` | ~24 | `@hermests/core` (#1) |
| `from utils import is_truthy_value, env_var_enabled, redact_sensitive_text, atomic_replace, is_termux, base_url_hostname, get_read_block_error, secure_parent_dir, ...` | ~11 | `@hermests/core` (#1) |
| `from hermes_cli.config import cfg_get, get_config_path, get_hermes_home` | ~8 | `@hermests/cli` (#14) — **back-edge** |
| `from hermes_cli._subprocess_compat import windows_hide_flags` | 2 | `@hermests/cli` (#14) — **back-edge** |
| `from hermes_cli.plugins import invoke_hook` (lazy) | 1 (`approval.py`) | `@hermests/cli` (#14) — **back-edge** |
| `from agent.auxiliary_client import call_llm, async_call_llm, _get_exa_client, extract_content_or_reasoning` | ~4 | `@hermests/agent` (#5) |
| `from agent.skill_utils import is_excluded_skill_path, EXCLUDED_SKILL_DIRS, get_bundled_skills_dir, get_hermes_dir` | ~4 | `@hermests/agent` (#5) |
| `from agent.file_safety import build_write_denied_paths, build_write_denied_prefixes, get_safe_write_root, is_write_denied` | 2 | `@hermests/agent` (#5) |
| `from agent.redact import redact_sensitive_text` | 2 | `@hermests/agent` (#5) |
| `from agent.browser_provider import BrowserProvider` | 1 | `@hermests/agent` (#5) |
| `from agent.browser_registry import get_provider` | 1 | `@hermests/agent` (#5) |
| `from agent.video_gen_provider import ...` | 1 | `@hermests/agent` (#5) |
| `from plugins.browser.<vendor>.provider import ...` | 1 (`browser_tool`) | `@hermests/plugins` (#8) — **back-edge** |

**Back-edges to address**: `tools/` imports from both `hermes_cli` and
`plugins`. These look like layering violations but they are deliberate
import-time-safe shims:

- `cfg_get`, `get_config_path`, `get_hermes_home`, `windows_hide_flags` are
  pure read-only helpers and can be moved into `@hermests/core`.
- `hermes_cli.plugins.invoke_hook` is lazy-imported inside a `try/except`
  with explicit silent fallback. In TS, model as an optional callback
  registration: `@hermests/tools` exports a `setApprovalPluginHook(cb)`
  function that `@hermests/cli` calls at startup.
- `plugins.browser.<vendor>.provider` imports in `browser_tool.py` are
  legacy aliases for backward compatibility. The active dispatch path uses
  `agent.browser_registry.get_provider`. In TS, omit the aliases (delete) and
  add a one-line note in the porter's PR.
- `agent.auxiliary_client.call_llm` is the LLM completion entry point used by
  web/vision/image/etc. for summarization or auxiliary reasoning. This is a
  hard runtime dep — `@hermests/agent` must be imported.

### Third-party Python deps (mapped to JS)

| Python lib | Used in | JS replacement |
|---|---|---|
| `httpx` | `mcp_tool`, `skills_hub`, `microsoft_graph_*`, `web_tools`, `vision_tools`, `image_generation_tool`, several others | Node `fetch` (built-in undici) for most cases; `undici` directly for stream/HTTP2/keep-alive options. Document in `dep-mapping.md`. |
| `requests` (sync) | `browser_tool`, `browser_camofox`, `transcription_tools`, `tts_tool`, `feishu_drive_tool`, `x_search_tool` | `undici.request` (sync-feeling via `await`) — Node has no truly sync HTTP. |
| `yaml` (PyYAML) | `skills_hub`, `skills_tool`, several config readers | `yaml` (npm — eemeli/yaml). |
| `websockets` | `browser_cdp_tool` (CDP transport) | `ws` (npm) — well-supported, used by Playwright. |
| `wave`, `sounddevice`, `kittentts`, `piper`, `edge-tts`, `elevenlabs`, `mistralai`, `faster-whisper` | Audio/TTS/STT (`tts_tool`, `transcription_tools`, `voice_mode`, `neutts_synth`) | Each vendor has a TS/JS SDK or REST API. `sounddevice` → `node-speaker`; `wave` → `wav` (npm); `edge-tts` → `edge-tts-node`; `elevenlabs` → official JS SDK; `kittentts`/`piper`/`faster-whisper` → spawn the binary via subprocess. **Most of this is optional; gate behind feature flags.** |
| `anthropic`, `openai` SDKs | indirectly via `agent.auxiliary_client` | `@anthropic-ai/sdk`, `openai` (both have TS/JS SDKs). Already handled by `@hermests/agent` port. |
| `mcp` (`modelcontextprotocol/python-sdk`) | `mcp_tool`, `mcp_oauth` | `@modelcontextprotocol/sdk` (official TS SDK). |
| `boto3` | (lazy, `provider.bedrock`) | `@aws-sdk/client-bedrock-runtime` — owned by `@hermests/providers` port. |
| `discord.py` | `discord_tool` | `discord.js` (well-maintained TS SDK). |
| `python-telegram-bot` | `send_message_tool` (Telegram path) | `node-telegram-bot-api` or `grammy`. |
| `slack-bolt`, `slack-sdk` | `send_message_tool` (Slack path) | `@slack/bolt`, `@slack/web-api`. |
| `mautrix[encryption]`, `aiohttp-socks` | `send_message_tool` (Matrix path) | `matrix-js-sdk` (Matrix Foundation). |
| `dingtalk-stream`, `alibabacloud-dingtalk` | `send_message_tool` (DingTalk) | No official TS SDK — REST API directly via `undici`. |
| `lark-oapi` | `feishu_*` | No official TS SDK — REST API directly. |
| `google-api-python-client`, `google-auth-oauthlib` | skills (workspace) — out of scope for tools port itself | `googleapis` (npm). Out of scope. |
| `youtube-transcript-api` | skills — out of scope for tools port | `youtube-transcript` (npm). Out of scope. |
| `playwright` (via `agent-browser` CLI) | `browser_tool` shells out to CLI | Stay as CLI dependency. `agent-browser` is the same Node binary in both worlds. |
| `cua-driver` MCP server | `computer_use/cua_backend.py` (talks to it over MCP) | Same external binary. TS port talks to it via `@modelcontextprotocol/sdk`. |
| `fal-client` | `image_generation_tool`, `fal_common` | `@fal-ai/serverless-client` (official). |
| `exa-py`, `firecrawl-py`, `parallel-web` | `web_tools` backends | `exa-js`, `firecrawl` (npm), Parallel has REST API. |
| `osv-scanner` (HTTP) | `osv_check` | Direct HTTPS to `https://api.osv.dev`. No client lib needed. |
| `daytona`, `modal`, `vercel` SDKs | `environments/{daytona,modal,vercel_sandbox}.py` | `@daytonaio/sdk` (TS), `modal` (no official JS — REST), `@vercel/sandbox` (TS). |
| `honcho-ai`, `hindsight-client` | memory providers | REST APIs. |
| `pyyaml`, `Markdown`, `aiosqlite`, `asyncpg`, `qrcode` | various platform paths | `yaml`, `marked`/`markdown-it`, `better-sqlite3`, `pg`, `qrcode` (all on npm). |
| `mcp` token storage | `mcp_oauth.py` | Hand-roll on top of `@modelcontextprotocol/sdk` auth primitives + filesystem JSON. |

Plain stdlib usages that need TS equivalents:

| Python stdlib | TS equivalent | Notes |
|---|---|---|
| `pathlib.Path` | `node:path`, `node:fs/promises`, `node:url` | Plenty of helpers; write a small adapter `pathlike.ts`. |
| `subprocess.Popen`, `subprocess.run` | `node:child_process` (`spawn`, `execFile`). | **No portable PTY in stdlib.** Use `node-pty` (npm) where the upstream code uses pty (terminal tool fallback path, voice recording). |
| `threading`, `threading.local`, `contextvars` | Node is single-threaded → use `AsyncLocalStorage` for `contextvars`; for `threading.local`, store in `AsyncLocalStorage` keyed by task_id. Worker threads via `node:worker_threads` (rare in this module). |
| `asyncio.new_event_loop`, `run_coroutine_threadsafe` | Node single loop; `_run_async` simplifies dramatically. `_get_worker_loop` becomes a no-op. |
| `socket`, `AF_UNIX` | `node:net` supports Unix domain sockets via `net.createServer({ path })`. Windows: TCP loopback fallback in upstream — same logic in TS. |
| `signal` (SIGTERM, SIGKILL, SIGINT) | `process.kill(pid, sig)`; ChildProcess.kill(). |
| `select.select` on file descriptors | `node:stream` event loop; or `epoll`/`@serialport/bindings-cpp` (avoid). Use `Readable.on('readable')`. |
| `wave`, `struct` (audio WAV writer in `neutts_synth`) | `wav` npm package. |
| `ipaddress` | `ip-address` npm or hand-roll the small subset in `url_safety`. |
| `unicodedata` | `unicode-properties` or `node:util.TextDecoder` for basics. Used in `approval.py` command-normalization and `skills_guard.py` zero-width-char detection. |
| `ast` (used in `registry.discover_builtin_tools`) | The TS equivalent is unneeded — TS tool registration uses explicit static imports, not module-scanning. See section 5. |

---

## 5. Tricky upstream constructs

> Use `tools/<file>.py:<line>` references where helpful. These are the
> non-obvious mechanisms a TS porter must understand and replicate (or
> deliberately replace).

### 5.1 Self-registering tool modules via `discover_builtin_tools`
`tools/registry.py:42` (`_module_registers_tools`) **AST-scans** every
`tools/*.py` file looking for module-body statements of the form
`registry.register(...)`. Files that contain such a top-level call are
imported, which triggers their `register()` call. This is a Python idiom
that doesn't map cleanly to TypeScript ESM — TS modules with side effects at
top level are an anti-pattern (tree-shakers will drop them).

**TS approach**: replace AST discovery with an explicit static index
(`tools/index.ts`) that imports every tool module by name. Each tool module
exports a `register(registry)` function (or a `ToolDescriptor` const) and
`tools/index.ts` iterates them. The static index is generated/validated by
a `bun run scripts/check-tool-index.ts` step that fails CI if a `.ts` file
in `packages/tools/src/` is missing from the index. This is exactly the
trade-off `model_tools.py:32` already makes — upstream chose AST scanning
to avoid hand-maintaining a list; TS can hand-maintain it and lint it.

### 5.2 Registry `_generation` counter for memoization
`tools/registry.py:163-167` monotonically bumps `_generation` on every
mutation (`register`, `deregister`, `register_toolset_alias`).
`model_tools.py:298` keys `_tool_defs_cache` on
`(frozenset(enabled), frozenset(disabled), _generation, cfg_fp, kanban_env)`.
This is THE caching contract — both sides must port faithfully. Get the
generation bump in the wrong place and `get_tool_definitions()` returns
stale schemas to long-lived gateway processes; this is what `model_tools.py`
issue #17335 / the cache poisoning bug fixed.

### 5.3 `check_fn` TTL cache
`tools/registry.py:121-148` (`_CHECK_FN_TTL_SECONDS = 30.0`,
`_check_fn_cached`). Per-call cache layered on top of TTL cache layered on
top of registry generation cache. **Three caches, all must be preserved.**
TS: a `Map<Function, [number, boolean]>` plus a 30s clock check.

### 5.4 Subprocess env scrubbing (security boundary)
`tools/code_execution_tool.py:73-95` (`_SAFE_ENV_PREFIXES`,
`_SECRET_SUBSTRINGS`, `_WINDOWS_ESSENTIAL_ENV_VARS`). The scrubber's exact
ordering matters: passthrough → secret-substring block → safe-prefix allow →
Windows essential allow. Port the order verbatim and write the equivalent of
upstream's `test_code_execution.py`/`test_code_execution_windows_env.py`
assertions.

### 5.5 Async tool dispatch over multiple event loops
`model_tools.py:47-105` (`_get_tool_loop`, `_get_worker_loop`,
`_run_async`). Upstream maintains a *persistent* asyncio event loop instead
of `asyncio.run()` per call to avoid "Event loop is closed" errors from
cached `httpx.AsyncClient` / `AsyncOpenAI` instances.
**TS doesn't have this problem** — Node has one event loop and one HTTP
agent pool. `_get_worker_loop` becomes a thin wrapper that just awaits;
`_get_tool_loop` collapses similarly. But preserve behavior of
`registry.dispatch` (`tools/registry.py:390`) when handlers are async vs
sync — TS callers should still get a string back, never a Promise.

### 5.6 UDS RPC for code_execution sandbox
`tools/code_execution_tool.py:319-563` runs a Unix-domain-socket RPC
server in a background thread; the LLM-generated script is a child process
that calls back to the parent via the socket for tool dispatch. **On
Windows, it falls back to loopback TCP** (`_IS_WINDOWS` branch around
`_execute_local`). Replicate verbatim — both transports — using `node:net`.
Remote backends (Docker/SSH/Modal) use **file-based RPC** instead
(`_rpc_poll_loop`, `_execute_remote`). Three transports total, gated on
backend type.

### 5.7 Browser CDP supervisor lifecycle
`tools/browser_supervisor.py:259` (`CDPSupervisor` class, 1100 LOC) is a
long-running asyncio task per browser session that subscribes to CDP
events, buffers console messages, surfaces JS dialogs, and resolves frames.
Sessions are reference-counted via `_SupervisorRegistry`
(`tools/browser_supervisor.py:1364`). `browser_tool.py:348`
(`_ensure_cdp_supervisor`) and `:396` (`_stop_cdp_supervisor`) are the
public entry points. Browser tool, dialog tool, and CDP tool all read from
the same supervisor via `SUPERVISOR_REGISTRY`. **In TS this becomes a
manager class around the CDP client provided by `chrome-remote-interface`
or the lower-level Playwright `CDPSession`.**

### 5.8 Approval pattern detection + per-session state
`tools/approval.py:269` (`detect_hardline_command`) and `:470`
(`detect_dangerous_command`) are large regex/pattern tables hardening
against destructive shell commands. The patterns must port byte-exact —
upstream test coverage (`tests/tools/test_approval.py`,
`test_hardline_blocklist.py`, `test_cron_approval_mode.py`,
`test_yolo_mode.py`) is the spec. Per-session state is keyed by a
**contextvar** (`_approval_session_key`,
`tools/approval.py:55`); in TS, use `AsyncLocalStorage` keyed by the
session id passed from the gateway.

### 5.9 Checkpoint store layout
`tools/checkpoint_manager.py` uses a **single shared bare-git store** at
`~/.hermes/checkpoints/store/` with per-project refs at
`refs/hermes/<dir_hash>` and per-project indexes. The shadow git invocation
sets `GIT_DIR` + `GIT_WORK_TREE` + `GIT_INDEX_FILE` explicitly per call
(`tools/checkpoint_manager.py:236`, `_git_env`). **TS port: use
`simple-git` or shell out to `git` directly** — but preserve the env-based
isolation. Tests exist at `tests/tools/test_checkpoint_manager.py`.

### 5.10 V4A patch format
`tools/patch_parser.py` implements a custom diff format ("Apply Patch v4a")
distinct from unified diff. The `parse_v4a_patch` (`:69`) state machine
plus the `_apply_*` helpers (`:455-557`) are the canonical reference — no
external spec. Port byte-exactly; tests at
`tests/tools/test_patch_parser.py`.

### 5.11 Fuzzy match strategy cascade
`tools/fuzzy_match.py` runs ten distinct match strategies in priority
order (`_strategy_exact` → `_strategy_line_trimmed` →
`_strategy_whitespace_normalized` → `_strategy_indentation_flexible` →
`_strategy_escape_normalized` → `_strategy_trimmed_boundary` →
`_strategy_unicode_normalized` → `_strategy_block_anchor` →
`_strategy_context_aware`). Each strategy uses different normalization on
both content and pattern. The position-mapping helpers
(`_build_orig_to_norm_map`, `_map_positions_norm_to_orig`,
`_map_normalized_positions`) are the only way to recover original-text
positions after a normalized-text match. **This is a 700-LOC pure function
with no I/O — port it as-is and validate against
`tests/tools/test_fuzzy_match.py`.**

### 5.12 MCP server lifecycle (async cancel-scope correctness)
`tools/mcp_tool.py` runs each MCP server as a long-lived asyncio Task on
a dedicated background event loop (`_mcp_loop`). On shutdown, each Task is
signalled to exit its own `async with` block so the anyio cancel-scope
cleanup happens in the *same* Task that opened the connection (anyio
requirement). **In TS this is simpler** — promises don't have anyio's
cancel-scope rules — but the underlying contract (call `client.close()`
from the same async context that called `client.connect()`) still applies.
See SDK docs.

### 5.13 MCP OAuth token storage
`tools/mcp_oauth.py:208` (`HermesTokenStorage`) implements the Python
MCP SDK's `TokenStorage` protocol with disk persistence at
`~/.hermes/mcp-tokens/`. The TS MCP SDK has the same interface — port
`HermesTokenStorage` to a TS class implementing the SDK's auth storage
interface.

### 5.14 Lazy deps allowlist
`tools/lazy_deps.py:25` (`LAZY_DEPS`) is the **only** sanctioned list of
pip packages the runtime may install at runtime. Specs are validated
against a conservative regex (`_SAFE_SPEC`,
`tools/lazy_deps.py:130`). **In TS this is conceptually different** — npm
deps are declared in `package.json`, not installed at runtime — but the
**concept of "optional features"** must port. Replace `LAZY_DEPS` with a
typed feature table; each entry maps a feature name (`"image.fal"`,
`"tts.edge"`, `"platform.discord"`) to the npm packages required and a
`isInstalled()` predicate (try to `import()` and catch ENOENT). The
`ensure()` UX (upstream prompts the user before installing) becomes
"throw `FeatureUnavailable` with install instructions"; the user runs
`bun add <pkg>` themselves.

### 5.15 Tool result size enforcement + persisted previews
`tools/tool_result_storage.py` writes oversized tool results to a sandbox
file and returns a preview with a heredoc marker. The dispatcher
(`model_tools.py` `handle_function_call`) consults
`registry.get_max_result_size()` per tool. Port the dataflow as-is; the
on-disk format is documented in the file's docstring.

### 5.16 Plugin override of registered tools
`tools/registry.py:234` (`register(..., override=True)`) allows a plugin to
**replace** a built-in tool implementation. Without `override=True`,
registrations that would shadow an existing tool from a different toolset
are rejected. MCP-to-MCP overwrites are silently allowed (server refresh).
Port the override semantics — they're load-bearing for the browser plugin
system.

### 5.17 Skill scanner (`skills_guard.py`)
A 950-LOC defense-in-depth scanner for skills loaded from untrusted
sources (GitHub, ClawHub, marketplace). Inspects: file structure
(`_check_structure`), forbidden Unicode chars (`_unicode_char_name`),
shell-injection patterns, suspicious URLs, trust levels by source.
**Port faithfully** — the regex patterns and `Finding`/`ScanResult`
data shapes are the contract; downstream `skill_manager_tool` and
`skills_hub` consume them.

### 5.18 Skills hub adapters (`skills_hub.py`)
3456 LOC. **Nine concrete skill source adapters** (`GitHubSource`,
`WellKnownSkillSource`, `UrlSource`, `SkillsShSource`, `ClawHubSource`,
`ClaudeMarketplaceSource`, `LobeHubSource`, `BrowseShSource`,
`OptionalSkillSource`), each ~200-700 LOC. They share `SkillSource` ABC
and `GitHubAuth`. Each adapter has its own remote-API quirks and tests.
**This single file is a natural standalone sub-task.**

### 5.19 Cronjob prompt-injection scanner
`tools/cronjob_tools.py:106-143` (`_strip_legitimate_emoji_zwj`,
`_scan_cron_prompt`) blocks prompt-injection vectors in user-supplied cron
prompts (zero-width joiners with non-emoji codepoints, suspicious unicode
categories). Tests: `tests/tools/test_cron_prompt_injection.py`.

### 5.20 Send-message platform fanout
`tools/send_message_tool.py` (1812 LOC) dispatches a single
`send_message(platform="...", target="...", text="...")` call across 13
platforms with platform-specific target-ref parsing
(`_parse_target_ref`), media-file handling, and retry policies (e.g.
`_telegram_retry_delay`). Each platform is largely independent; one TS
file per platform is reasonable.

### 5.21 Computer-use macOS-only gate
`tools/computer_use/cua_backend.py:80-92` requires
`platform.system() == "Darwin"` and shells out to a `cua-driver` MCP
binary (`cua_driver_binary_available`). The TS port stays Darwin-only;
the registered tool's `check_fn` returns false on other platforms.
Backend talks via `@modelcontextprotocol/sdk`.

### 5.22 SSRF guard for URL fetchers
`tools/url_safety.py:171` (`is_always_blocked_url`) and `:272`
(`is_safe_url`) implement an SSRF defense — block link-local, loopback,
metadata IPs, RFC1918 ranges (unless explicitly allowed). Used by browser
tools, web tools, skills hub. Port the IP/CIDR comparisons exactly; tests
at `tests/tools/test_url_safety.py`.

### 5.23 Voice mode (Termux + desktop)
`tools/voice_mode.py:247` (`TermuxAudioRecorder`) and `:375`
(`AudioRecorder`) — two recorder implementations selected at runtime by
`create_audio_recorder()`. Termux backend shells out to `termux-microphone-record`;
desktop uses `sounddevice`. TS: gate Termux behind `process.platform ===
'android'` plus an Android-API-installed check, and on desktop use a Node
audio library or shell out to `sox`/`arecord`. **Voice mode is
non-critical for an MVP port — punt to a follow-up sub-task.**

### 5.24 Schema sanitizer (provider compatibility)
`tools/schema_sanitizer.py` strips JSON-Schema features that some
providers reject: top-level combinators (`anyOf` at root),
`nullable: true` unions, `pattern`/`format` strings, slash-prefixed enums.
Run on every MCP tool schema before registration; tests at
`tests/tools/test_schema_sanitizer.py`. Port byte-exact; the sanitization
rules are the negotiated contract with each LLM provider.

### 5.25 Background process registry
`tools/process_registry.py:137` (`ProcessRegistry`) — in-memory registry
for background processes spawned via `terminal(background=true)`. Has a
**JSON crash-recovery checkpoint file**, **gateway-session-scoped tracking**
to prevent session-reset abuse, **rolling 200KB output buffer**, and an
**interrupt-aware wait** primitive. Tests:
`tests/tools/test_process_registry.py`, `test_notify_on_complete.py`,
`test_terminal_compound_background.py`.

---

## 6. Upstream test mapping

`tests/tools/` contains **120 test files** that target `tools/*.py`. An
additional **~34 tests outside `tests/tools/`** reference tools (gateway,
cli, hermes_cli, acp, agent, run_agent, integration, plugins). **Total:
154 test files.**

### Per-tool-cluster test mapping (the ones that matter)

| Sub-task | Tests to port |
|---|---|
| Core / registry / toolsets | `test_registry.py`, `test_toolsets.py`, `test_toolset_distributions.py`, `test_model_tools.py`, `test_get_tool_definitions_cache_isolation.py`, `test_sanitize_tool_error.py`, `test_transform_tool_result_hook.py`, `test_schema_sanitizer.py`, `test_tool_result_storage.py`, `test_tool_backend_helpers.py`, `test_lazy_deps.py`, `test_url_safety.py`, `test_website_policy.py`, `test_env_passthrough.py`, `test_budget_config.py`, `test_ansi_strip.py`, `test_credential_files.py`, `test_debug_helpers.py`, `test_parse_env_var.py`, `test_threaded_process_handle.py` |
| File ops | `test_file_operations.py`, `test_file_operations_edge_cases.py`, `test_file_ops_cwd_tracking.py`, `test_file_read_guards.py`, `test_file_staleness.py`, `test_file_state_registry.py`, `test_file_sync.py`, `test_file_sync_back.py`, `test_file_tools.py`, `test_file_tools_container_config.py`, `test_file_tools_live.py`, `test_file_write_safety.py`, `test_fuzzy_match.py`, `test_patch_parser.py`, `test_read_loop_detection.py`, `test_write_deny.py`, `test_watch_patterns.py`, `test_pr_6656_regressions.py` |
| Terminal & sandbox | `test_terminal_tool.py`, `test_terminal_tool_pty_fallback.py`, `test_terminal_tool_requirements.py`, `test_terminal_compound_background.py`, `test_terminal_exit_semantics.py`, `test_terminal_none_command_guard.py`, `test_terminal_output_transform_hook.py`, `test_terminal_task_cwd.py`, `test_terminal_timeout_output.py`, `test_command_guards.py`, `test_hardline_blocklist.py`, `test_yolo_mode.py`, `test_approval.py`, `test_approval_plugin_hooks.py`, `test_init_session_cwd_respect.py`, `test_local_*.py` (9), `test_modal_bulk_upload.py`, `test_singularity_preflight.py`, `test_ssh_bulk_upload.py`, `test_ssh_environment.py`, `test_docker_environment.py`, `test_docker_find.py`, `test_base_environment.py`, `test_sync_back_backends.py`, `test_local_background_child_hang.py`, `test_local_interrupt_cleanup.py`, `test_local_tempdir.py`, `test_process_registry.py`, `test_notify_on_complete.py`, `test_checkpoint_manager.py`, `test_osv_check.py` |
| Code execution | `test_code_execution.py`, `test_code_execution_modes.py`, `test_code_execution_windows_env.py`, `test_tirith_security.py` |
| Browser | `test_browser_camofox.py`, `test_browser_camofox_persistence.py`, `test_browser_cloud_fallback.py`, `test_browser_cloud_provider_cache.py`, `test_browser_homebrew_paths.py`, `test_browser_hybrid_routing.py` |
| MCP | `test_mcp_tool.py`, `test_mcp_dynamic_discovery.py`, `test_mcp_empty_error_message.py`, `test_mcp_invalid_url.py`, `test_mcp_oauth.py`, `test_mcp_oauth_metadata.py`, `test_mcp_tool_issue_948.py` |
| Skills | `test_skill_env_passthrough.py`, `test_skill_improvements.py`, `test_skill_manager_tool.py`, `test_skill_size_limits.py`, `test_skill_view_traversal.py`, `test_skills_guard.py`, `test_skills_hub.py`, `test_skills_hub_browse_sh.py`, `test_skills_hub_clawhub.py`, `test_skills_sync.py`, `test_skills_tool.py` |
| Messaging / platforms / cron | `test_send_message_tool.py`, `test_send_message_missing_platforms.py`, `test_discord_tool.py`, `test_feishu_tools.py`, `test_homeassistant_tool.py`, `test_cronjob_tools.py`, `test_cron_approval_mode.py`, `test_cron_prompt_injection.py`, `test_microsoft_graph_auth.py`, `test_microsoft_graph_client.py`, `test_kanban_codex_lane_skill.py` |
| Media | `test_tts_command_providers.py`, `test_tts_max_text_length.py`, `test_tts_piper.py`, `test_tts_xai_speech_tags.py`, `test_video_analyze.py`, `test_vision_native_fast_path.py`, `test_vision_tools.py`, `test_voice_cli_integration.py` |
| Memory / search / delegate | `test_memory_tool.py`, `test_memory_tool_import_fallback.py`, `test_memory_tool_schema.py`, `test_session_search.py`, `test_todo_tool.py`, `test_delegate.py`, `test_delegate_composite_toolsets.py`, `test_delegate_toolset_scope.py`, `test_clarify_tool.py` |
| Cross-package (do not port here — port in target package) | `tests/acp/test_edit_approval.py`, `tests/acp/test_permissions.py`, `tests/agent/*`, `tests/cli/*`, `tests/cron/test_scheduler.py`, `tests/gateway/*`, `tests/hermes_cli/*`, `tests/integration/test_*`, `tests/plugins/browser/check_parity_vs_main.py`, `tests/plugins/image_gen/check_parity_vs_main.py`, `tests/run_agent/*`, `tests/run_interrupt_test.py` |

### Coverage strategy

`vitest.config.ts` enforces 100% across the package. The 120 upstream tests
inside `tests/tools/` are the **starting point** but not sufficient — they
test against in-process Python objects and platform behaviour (`fork`,
`SIGCHLD`, etc.) that have no TS analogue. Each sub-task PR must:

1. Port every upstream test as a Vitest file in the same directory layout
   (`packages/tools/tests/<cluster>/<file>.test.ts`).
2. Add additional tests to reach 100% statement/branch/line/function
   coverage.
3. Mock external services (FAL, Telegram, MCP servers) at the HTTP boundary
   using `msw` or `undici`'s `MockAgent`.

---

## 7. Subdivision plan

Splitting `@hermests/tools` into **12 sub-tasks** of 4-8k LOC each, ordered
by internal-dep topological position. Every sub-task is blocked by **#5
(agent)** because every tool eventually imports from `agent.*` and
`hermes_cli.config`. Within the sub-tasks, dependencies are listed in the
"Depends on" column.

| # | Sub-task | Files | LOC | Depends on | Notes |
|---|---|---:|---:|---|---|
| **6a** | `core/` — registry, toolsets, model_tools, low-level helpers | 23 | ~6.2k | core, agent | Foundation of the whole package. Must merge first. See breakdown below. |
| **6b** | `environments/` — sandbox/exec backends | 13 | ~5.1k | 6a | All eight environment backends + base + file_sync + utils + managed_modal. |
| **6c** | `file-ops/` — file_operations, file_tools, fuzzy_match, patch_parser, file_state, binary_extensions, path_security | 7 | ~4.8k | 6a, 6b | Mostly pure TS once env interface is stable. |
| **6d** | `terminal/` — terminal_tool, process_registry, checkpoint_manager, osv_check, debug_helpers, approval, slash_confirm, clarify_tool, clarify_gateway, todo_tool, interrupt | 11 | ~8.4k | 6a, 6b, 6c | Largest single sub-task — terminal is the agent's heaviest tool. Approval gates here; delegate (which depends on terminal) deliberately moves to 6h. |
| **6e** | `code-exec/` — code_execution_tool, env_passthrough, tirith_security | 3 | ~2.5k | 6a, 6b, 6c, 6d | UDS RPC + remote RPC; depends on terminal env list. |
| **6f** | `browser/` — browser_tool, browser_supervisor, browser_cdp_tool, browser_dialog_tool, browser_camofox*, website_policy, url_safety | 8 | ~7.5k | 6a, agent (browser_provider), plugins (browser/* legacy alias — drop in TS) | Mostly self-contained once URL/policy helpers are in 6a. |
| **6g** | `mcp/` — mcp_tool, mcp_oauth, mcp_oauth_manager, schema_sanitizer (sanitizer is shared with the registry path, but lives in 6a) | 3 | ~4.8k | 6a | Use `@modelcontextprotocol/sdk` (TS). Schema_sanitizer is in 6a because the registry needs it. |
| **6h** | `delegate-kanban/` — delegate_tool, kanban_tools, mixture_of_agents_tool, session_search_tool, memory_tool | 5 | ~5.4k | 6a, agent | Delegate spawns subagents — depends on agent runtime. Memory writes to `~/.hermes/MEMORY.md`. |
| **6i** | `web/` — web_tools, x_search_tool, xai_http, openrouter_client, fal_common, managed_tool_gateway, tool_backend_helpers, credential_files, tool_output_limits, tool_result_storage | 10 | ~3.7k | 6a, agent (auxiliary_client) | Web search/extract/crawl + managed gateway dispatcher. tool_backend_helpers and managed_tool_gateway also feed terminal/browser, so they actually ship in 6a — listed here as the file owners for tracking purposes. **Actual NEW code here: web_tools, x_search_tool, xai_http, openrouter_client.** |
| **6j** | `media/` — vision_tools, image_generation_tool, video_generation_tool, tts_tool, transcription_tools, voice_mode, neutts_synth | 7 | ~7.2k | 6a, agent | Many provider-specific subpaths; each can be feature-gated and lazily loaded. Voice_mode (Termux + desktop) can be a v2 follow-up. |
| **6k** | `skills/` — skills_tool, skills_hub, skills_guard, skills_sync, skill_manager_tool, skill_usage, skill_provenance | 7 | ~9.2k | 6a, 6f (url_safety, website_policy) | The 3456-LOC skills_hub.py with 9 source adapters is the bulk; consider splitting **6k into 6k.1 (skills_hub adapters)** and **6k.2 (skills runtime + manager + guard + usage + sync + provenance + skills_tool)** in flight. Total budget intact. |
| **6l** | `messaging/` — send_message_tool, discord_tool, yuanbao_tools, homeassistant_tool, feishu_doc_tool, feishu_drive_tool, microsoft_graph_auth, microsoft_graph_client, cronjob_tools, computer_use(_tool + subpackage) | 10 | ~6.7k | 6a, 6d (cronjob approval), 6h (delegate auto-deny for cron-spawned children) | Multi-platform; each platform is a leaf and can be reviewed independently. Computer-use lumped here because it's Darwin-only and lifecycle-similar to platform tools. |

### 6a deep-dive (foundation)

Sub-task 6a is the **must-merge-first** sub-task. It contains:

| File | LOC | Why in 6a |
|---|---:|---|
| `tools/registry.py` | 590 | Singleton registry + AST discovery (replaced with static index). |
| `tools/interrupt.py` | 98 | Shared interrupt flag (`AsyncLocalStorage` in TS). |
| `tools/path_security.py` | 43 | Path traversal helper. |
| `tools/binary_extensions.py` | 42 | Binary-extension set. |
| `tools/ansi_strip.py` | 44 | Pure regex helper. |
| `tools/budget_config.py` | 51 | Defaults. |
| `tools/tool_output_limits.py` | 92 | Default limits. |
| `tools/tool_result_storage.py` | 232 | Storage of oversized results (terminal also needs this; goes here). |
| `tools/tool_backend_helpers.py` | 144 | Modal/Managed/FAL/Browser-cloud normalization. |
| `tools/managed_tool_gateway.py` | 167 | Managed gateway URL/cred resolution. |
| `tools/credential_files.py` | 436 | Credential mount tracking. |
| `tools/env_passthrough.py` | 145 | Env-var allowlist. |
| `tools/lazy_deps.py` | 613 | **Reframe as feature flags** — see 5.14. |
| `tools/openrouter_client.py` | 33 | Tiny client wrapper. |
| `tools/xai_http.py` | 128 | xAI HTTP creds helper. |
| `tools/fal_common.py` | 163 | FAL client import + wrapper. |
| `tools/schema_sanitizer.py` | 445 | MCP-schema sanitization (used by 6g, but the function is generic). |
| `tools/debug_helpers.py` | 105 | Per-task recorder used everywhere. |
| `tools/url_safety.py` | 351 | SSRF guard (needed by 6f and 6i). |
| `tools/website_policy.py` | 282 | Domain blocklist (same). |
| `tools/__init__.py` | 25 | Package init. |
| `toolsets.py` | 866 | Standalone — pure data + resolution. |
| `toolset_distributions.py` | 364 | Standalone — depends only on `toolsets.py`. |
| `model_tools.py` | 923 | Public façade. **Imports trigger registry discovery — in TS, the static index goes here.** |

**6a delivers**: working registry, `get_tool_definitions()` over an empty
tool set, `toolsets` resolver, full schema sanitizer, URL/website guards.
After 6a merges, every subsequent sub-task can land independently — each
adds one or more tool files that call `registry.register()` on the
already-merged registry, plus a new entry in the static index.

### Cluster-recommended subdivision constraints

- **Do not interleave clusters in one PR** unless the file count is <3.
  Reviewers need bounded surface area; 5-10k LOC per PR is the cap.
- **6a, 6b, and 6c are sequential** — they have hard internal deps.
- **6d through 6l can be parallelized** once 6a-6c are in.
- **6g (MCP) and 6f (Browser) are the trickiest** — pair with the most
  experienced porter; they touch async lifecycle correctness.
- **6k (Skills) is the largest by LOC and the most likely to be split
  again in flight** — recommend the porter consider 6k.1 (`skills_hub.py`
  + adapters) and 6k.2 (rest) before starting.

---

## 8. Effort estimates

Assumptions:

- TS porter is fluent in TypeScript + Node + Bun, knows Python.
- Vitest 100% coverage threshold enforced; tests are part of every PR.
- Upstream tests port roughly 1:1 in size but ~1.5× in time (TS mocking
  ceremony + async test patterns differ).
- Subagent typing/contract design has to be invented for each cluster
  (Python's duck typing forces explicit interfaces in TS).
- All estimates **person-days** for one porter; parallelizable subject to
  the dependency graph in section 7.

| Sub-task | LOC | Estimate (PDs) | Risk | Notes |
|---|---:|---:|---|---|
| 6a Core / registry / toolsets / model_tools / helpers | ~6.2k | **8-10** | medium | Foundation. Static-index replacement for AST discovery is the only material design call. Three-tier caching contract must be exact. |
| 6b Environments | ~5.1k | **9-12** | high | Eight backends, each with platform quirks. Local/Docker/SSH are mandatory; Modal/Daytona/Vercel/Singularity/managed_modal can land in a follow-up if needed. PTY support requires `node-pty`. |
| 6c File ops | ~4.8k | **6-8** | low-medium | Pure logic. Fuzzy match cascade is well-tested; patch parser is well-tested. The wrapper around env.execute() is the only env-coupled piece. |
| 6d Terminal + approval + process_registry + checkpoint + clarify + todo + interrupt | ~8.4k | **12-16** | high | Largest cluster. terminal_tool alone is 2379 LOC with 7 backends. Approval pattern table is regression-test territory — port byte-exactly. Checkpoint store git layout is non-trivial. |
| 6e Code execution + tirith + env_passthrough | ~2.5k | **8-10** | high | UDS + TCP + file-RPC three-transport sandbox. Test surface is wide (Windows env scrub, Linux fork model, Modal/Docker remote). |
| 6f Browser (tool + supervisor + cdp + camofox + dialog + url_safety + website_policy) | ~7.5k | **10-13** | high | CDP supervisor is the hardest single piece; uses `chrome-remote-interface` or Playwright's `CDPSession`. Browser tool itself has many fallback paths (lightpanda, headless, cloud). url_safety/website_policy are in 6a but tested here. |
| 6g MCP (tool + oauth + oauth_manager + schema_sanitizer) | ~4.8k | **7-10** | medium-high | TS SDK is well-supported; ~70% of code is auth + token storage + reconnection logic. Schema_sanitizer is in 6a. |
| 6h Delegate + kanban + MoA + session_search + memory | ~5.4k | **7-10** | medium | Delegate spawns subagents — depends on `@hermests/agent` being stable. Kanban tools interact with sqlite (or postgres) — needs an ORM/driver decision. |
| 6i Web (web_tools + x_search + xai_http + openrouter) | ~3.7k | **5-7** | low-medium | LLM calls go through `@hermests/agent.auxiliary_client`. Backends are mostly REST. Exa/Firecrawl/Parallel SDKs in TS are stable. |
| 6j Media (vision + image + video + tts + transcription + voice + neutts) | ~7.2k | **9-13** | medium | Each provider integration is independent. Voice mode (Termux + desktop) can be deferred. Decide whether to bundle Piper/Kitten or leave as user-installed CLI. |
| 6k Skills (hub + guard + sync + manager + usage + provenance + skills_tool) | ~9.2k | **12-16** | medium-high | skills_hub.py alone is 3456 LOC with 9 source adapters. **Recommend in-flight split into 6k.1 + 6k.2.** skills_guard regex patterns are the security contract — port byte-exact. |
| 6l Messaging + cronjob + computer_use + ms_graph + feishu + ha + discord + yuanbao | ~6.7k | **10-14** | medium | Wide vendor surface but each is independent. Some platforms (DingTalk, Feishu) lack official TS SDKs — REST API directly. Computer-use Darwin-only; check_fn gates other platforms. |
| **Total** | **~70k** | **103-139 PDs** | | Roughly **5-7 person-months of single-porter work**, or 6-8 weeks with three porters working sub-tasks in parallel after 6a/6b/6c land. |

### Key risks (read before scheduling)

1. **`@hermests/agent` must merge before tools work**. Every tool subtask
   reaches into `agent.auxiliary_client` or `agent.file_safety`. Sub-task
   #5 is the gate.
2. **`hermes_cli.config.cfg_get` back-edge**. Resolve early by moving
   `cfg_get` into `@hermests/core`. Don't ship 6a until this is done.
3. **`plugins.browser.*` legacy aliases in `browser_tool.py`**. Drop them
   in the TS port; no callers need them.
4. **Coverage at 100% on the env backends is hard.** Modal/Vercel/Daytona
   require live cloud creds or extensive HTTP mocking. Acceptable
   mitigation: gate them behind `// v8 ignore`-equivalent with documented
   rationale per the PORTING_PLAN.md exception policy.
5. **PTY behavior**. `node-pty` requires native compilation. Verify it
   ships with prebuilt binaries for the target platforms (Linux x64,
   macOS arm64+x64, Windows x64) before locking the dep.
6. **Test fan-out**. 154 upstream test files. Plan ~3 weeks of pure-test
   porting work overlapping with implementation.
