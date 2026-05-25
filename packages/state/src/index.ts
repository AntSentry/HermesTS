export {
  SessionDB,
  DEFAULT_DB_PATH,
  type SessionRow,
  type MessageRow,
  type CreateSessionOptions,
  type UpdateTokenCountsOptions,
  type AppendMessageOptions,
  type ReplaceMessage,
  type ConversationMessage,
  type SearchMessagesOptions,
  type SearchMessageResult,
  type ListSessionsOptions,
  type RichSessionRow,
  type AnchoredWindow,
  type AnchoredView,
  type MaybeAutoPruneResult,
  type HandoffState,
  type SessionDbOptions,
} from "./session-db.js";

export {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  FTS_SQL,
  FTS_TRIGRAM_SQL,
} from "./schema.js";

export {
  applyWalWithFallback,
  getLastInitError,
  formatSessionDbUnavailable,
  WAL_INCOMPAT_MARKERS,
  _setLastInitError,
  _resetWalFallbackWarnedPaths,
} from "./wal-fallback.js";

export { _encodeContent, _decodeContent, CONTENT_JSON_PREFIX } from "./content-codec.js";
export { _sanitizeFts5Query } from "./fts5.js";
export { _isCjkCodepoint, _containsCjk, _countCjk } from "./cjk.js";
export { sanitizeTitle, MAX_TITLE_LENGTH } from "./title.js";
