/**
 * Public surface of `@hermests/agent` (sub-task 5f scope).
 *
 * Re-exports are deliberately named to avoid `*` clashes between
 * modules that each define internal `_internals` blobs.
 */

export {
  // Skill utils
  PLATFORM_MAP,
  EXCLUDED_SKILL_DIRS,
  SKILL_CONFIG_PREFIX,
  isExcludedSkillPath,
  yamlLoad,
  _setYamlLoaderForTests,
  parseFrontmatter,
  skillMatchesPlatform,
  _platformProvider,
  _setPlatformForTests,
  _termuxProvider,
  _setIsTermuxForTests,
  getDisabledSkillNames,
  _externalDirsCacheClear,
  getExternalSkillsDirs,
  getAllSkillsDirs,
  extractSkillConditions,
  type SkillConditions,
  extractSkillConfigVars,
  type SkillConfigVar,
  discoverAllSkillConfigVars,
  resolveSkillConfigValues,
  extractSkillDescription,
  iterSkillIndexFiles,
  parseQualifiedName,
  isValidNamespace,
} from "./skills/skill-utils.js";

export {
  loadSkillsConfig,
  substituteTemplateVars,
  runInlineShell,
  expandInlineShell,
  preprocessSkillContent,
} from "./skills/skill-preprocessing.js";

export {
  type SkillCommandInfo,
  _loadSkillPayload,
  _buildSkillMessage,
  scanSkillCommands,
  getSkillCommands,
  reloadSkills,
  type ReloadSkillsResult,
  resolveSkillCommandKey,
  buildSkillInvocationMessage,
  buildPreloadedSkillsPrompt,
  buildPreloadedSkillsPromptTuple,
  _internals as _skillCommandsInternals,
} from "./skills/skill-commands.js";

export {
  type BundleInfo,
  BundleExistsError,
  BundleNotFoundError,
  _slugify,
  scanBundles,
  getSkillBundles,
  resolveBundleCommandKey,
  reloadBundles,
  type ReloadBundlesResult,
  listBundles,
  buildBundleInvocationMessage,
  bundlePathFor,
  saveBundle,
  deleteBundle,
  getBundle,
  _internals as _skillBundlesInternals,
} from "./skills/skill-bundles.js";

export {
  // Prompt builder
  DEFAULT_AGENT_IDENTITY,
  HERMES_AGENT_HELP_GUIDANCE,
  MEMORY_GUIDANCE,
  SESSION_SEARCH_GUIDANCE,
  SKILLS_GUIDANCE,
  KANBAN_GUIDANCE,
  TOOL_USE_ENFORCEMENT_GUIDANCE,
  TOOL_USE_ENFORCEMENT_MODELS,
  OPENAI_MODEL_EXECUTION_GUIDANCE,
  GOOGLE_MODEL_OPERATIONAL_GUIDANCE,
  COMPUTER_USE_GUIDANCE,
  DEVELOPER_ROLE_MODELS,
  PLATFORM_HINTS,
  WSL_ENVIRONMENT_HINT,
  CONTEXT_FILE_MAX_CHARS,
  CONTEXT_TRUNCATE_HEAD_RATIO,
  CONTEXT_TRUNCATE_TAIL_RATIO,
  _backendProber,
  _setBackendProberForTests,
  _clearBackendProbeCache,
  buildEnvironmentHints,
  clearSkillsSystemPromptCache,
  buildSkillsSystemPrompt,
  buildNousSubscriptionPrompt,
  loadSoulMd,
  buildContextFilesPrompt,
} from "./prompt/prompt-builder.js";

export {
  BUSY_INPUT_FLAG,
  TOOL_PROGRESS_FLAG,
  OPENCLAW_RESIDUE_FLAG,
  busyInputHintGateway,
  busyInputHintCli,
  toolProgressHintGateway,
  toolProgressHintCli,
  openclawResidueHintCli,
  detectOpenclawResidue,
  isSeen,
  markSeen,
} from "./onboarding/onboarding.js";

export {
  type SessionDb,
  type FailureCallback,
  type TitleCallback,
  generateTitle,
  autoTitleSession,
  maybeAutoTitle,
  _scheduler,
  _setSchedulerForTests,
} from "./title/title-generator.js";

export {
  setSkillsToolHooks,
  getSkillsToolHooks,
  setSkillUsageHooks,
  getSkillUsageHooks,
  setSessionContextHooks,
  getSessionContextHooks,
  setHermesHomeHooks,
  getHermesHomeHooks,
  setNousManagedHooks,
  getNousManagedHooks,
  setAuxiliaryLlmHooks,
  getAuxiliaryLlmHooks,
  setAgentFsHooks,
  getAgentFsHooks,
  resetExtensions,
  type AgentExtensions,
  type AgentFsHooks,
  type AuxiliaryLlmHooks,
  type AuxiliaryLlmResponse,
  type CallLlmOptions,
  type HermesHomeHooks,
  type NousManagedHooks,
  type NousSubscriptionFeature,
  type NousSubscriptionFeatures,
  type SessionContextHooks,
  type SkillUsageHooks,
  type SkillsToolHooks,
  type SkillViewPayload,
} from "./extensions/index.js";

export { defaultFsHooks } from "./extensions/default-fs.js";
