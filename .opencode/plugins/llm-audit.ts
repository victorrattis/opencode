// Wire-level audit log for LLM provider traffic.
//
// Answers "what did opencode actually send to the model, what came back, and
// how many tokens did it take?" — the full system prompt, the tool schemas,
// every message in the history, the assembled reply, and the token bill, one
// record per model request. Self-contained: drop this one file in
// `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global) of
// a stock opencode install and it works. No fork, no dependencies.
//
// Enable with `OPENCODE_LLM_AUDIT=1` (or point `OPENCODE_LLM_AUDIT_DIR` at a
// directory), or from config:
//
//   { "plugin": [["./llm-audit.ts", { "dir": "/tmp/audit", "raw": true }]] }
//
// A "turn" here is one HTTP request to the model. A single thing you typed
// usually spans several turns, because each tool call round-trips again.
//
// The directory is organized by conversation, not by process: one folder per
// session, reopened whenever you come back to that session, so everything a
// conversation ever sent stays in one place however often you resume it.
//
//   <dir>/<timestamp>-<session>/        one conversation, from its first turn
//   <dir>/<timestamp>-<session>/pieces.jsonl   its prompts, each kept once
//   <dir>/<timestamp>-<session>/tools.jsonl    one line per tool it ran
//   <dir>/<timestamp>-<session>/events.jsonl   compaction, as it happened
//   <dir>/runs/<timestamp>-<pid>.json   what one process did, as an index
//   <dir>/runs/<timestamp>-<pid>.config.json   the config it ran with, redacted
//   <dir>/latest.json                   where the current process is writing
//
// A subagent (the `task` tool) is a session of its own on the wire, with its own
// id, but its turns are the work of whoever spawned it, so they are written to
// that conversation's folder — numbered in the same sequence, in the order they
// were actually sent. Each turn says which session it came from (`session`), who
// spawned it (`parent_session`) and whose folder it is in (`root_session`), and
// `summary.json` breaks the totals down `by_session` so what a subagent used is
// a number you can read off.
//
// Per turn, `<dir>/<timestamp>-<session>/turn_NNN.json` holds:
//
//   prompt   what the harness sent, decoded out of the provider's dialect:
//            system blocks, tool schemas and messages, each with its size, its
//            share of the prompt, cache markers and a preview; plus the
//            sampling settings (max_tokens, temperature, thinking, ...)
//   reuse    the diff against the previous turn of the same session: how much
//            of the prompt is a byte-identical prefix (cacheable) and where it
//            first diverged — the number to watch when hunting for waste
//   reply    the model's output assembled from the stream: text, reasoning,
//            tool calls with their ids and arguments, stop reason
//   usage    the token bill (see below)
//   timing   when the answer arrived: first byte, first token, last byte. The
//            split that tells a slow provider from a long answer
//   request  the verbatim bytes on the wire (method, URL, headers, body)
//   response status, headers, parsed JSON or SSE events
//
// plus, when there is something to say: `request_index`, which numbers the
// thing the user typed that this turn is part of; `retry_of`, when the prompt
// repeats a turn the provider rejected, so the tokens are being paid twice; and
// `compaction`, on the first turn sent after the history was rewritten, with
// what that rewrite threw away.
//
// Every message row in `prompt` names the tool traffic inside it. A `tool_use`
// carries the call's id and the tool's name; a `tool_result` carries the id it
// answers and — resolved from the call that went by earlier — the name of the
// tool that produced it. That is what lets `summary.json` say, in `by_tool`,
// what each tool has cost: `result_tokens` the first time its output was sent,
// and `resent_tokens` for every turn it has travelled in since, which in a long
// session is the larger of the two by far.
//
// The bulk of that is the conversation, and every turn carries all of it again
// — the same tool schemas, the same system prompt, the same messages as the
// turn before — with the providers echoing the tool schemas back inside the
// response on top. So each piece large enough to be worth it is written once to
// the folder's `pieces.jsonl` (`{"h":<hash>,"b":<the piece verbatim>}`) and left
// in the turn as `{"$ref":"<hash>"}`. Nothing is lost: joining the two gives
// back exactly the record that would otherwise have been written, and a turn
// that uses the store says so in its `pieces` field. Over a real folder it is
// the difference between 194 KB and 25 KB per turn.
//
// About the token counts. `usage` is normalized onto one shape across the
// dialects, and `usage.source` says where it came from:
//
//   "provider"  the counts the provider billed, taken off the wire. Exact.
//   "estimated" the provider reported nothing for this request (some
//               OpenAI-compatible endpoints omit usage unless asked, and a
//               Bedrock event stream is binary), so the counts are derived from
//               the characters on the wire and are a guess.
//
// `input` is always the prompt tokens billed at the full rate, with cache reads
// and cache writes kept separate, so `prompt` = input + cache_read +
// cache_write and `total` = prompt + output. `reasoning` is reported as part of
// `output`, never added on top of it, because that is how it is billed.
//
// A counter the dialect does not report is left out rather than written as
// zero: a model with no prompt cache and a cache that missed are opposite
// findings, and a `0` cannot tell them apart. The running totals in
// `summary.json` keep every counter, because there a zero is a sum.
//
// Because the provider only gives one number for the whole prompt, the per-part
// token counts are that number distributed across the parts in proportion to
// their characters (largest remainder, so the parts add up to the total
// exactly). That is exact in aggregate and approximate per row — and it is only
// indicative for a row holding an image or audio, whose token cost has nothing
// to do with the size of its base64; those rows are flagged `binary`.
//
// `turns.jsonl` is one compact line per turn for scanning or piping into jq,
// `summary.json` keeps running totals broken down by model and by agent —
// cumulative over every run that wrote to the folder — and `state.json` is what
// the next run reads to pick the conversation up where it left off: the turn
// counter, the totals, and the prompt fingerprints the reuse diff needs.
// `latest.json` one level up points at the current run.
//
// How it hooks in: it wraps the process's `fetch` and records the calls whose
// shape says "model request" (see `isModelCall`). That covers every provider —
// API key, OAuth, gateway, Bedrock, Vertex, Copilot, custom baseURL, and the
// experimental native runtime alike — because it does not depend on how a
// provider is configured or which SDK it uses, only on the HTTP it sends. The
// bytes recorded are the bytes on the wire. Non-model traffic (model catalog,
// npm, share, MCP, the webfetch tool) is left alone.
//
// The one thing it cannot see: GitLab Duo workflow models, which stream over a
// WebSocket instead of HTTP.
//
// The hooks supply what the wire does not carry, and none of them writes to its
// `output`, so arming the audit cannot change what opencode does:
//
//   chat.params    session, agent, model id and reasoning variant, to attribute
//                  and label a turn
//   chat.message   the user typed something: the boundary `request_index` counts
//   tool.execute.*  what running a tool cost in wall clock, and whether it
//                  failed at all — a `before` with no `after` is the failure,
//                  because opencode does not fire `after` on the throwing path
//   compaction     `experimental.session.compacting`, `...autocontinue` and the
//                  `session.compacted` event, which between them say when the
//                  history was rewritten and whether the context forced it
//   config         a hash of the resolved config, so two runs can be told apart
//                  when what changed between them is a setting
//
// A tool execution is written to `tools.jsonl`, keyed by the same call id the
// wire uses, so the line and the tokens its output occupies are one join apart:
// `call_id` -> the `tool_results` entry on a prompt row -> that row's `ref` ->
// the bytes in `pieces.jsonl`. The output itself is never written to
// `tools.jsonl`; it is already on disk as the next turn's tool result.
//
// The one place that join does not hold is the `task` tool, which opencode
// identifies to the hooks by a part id rather than the id it put on the wire.
// Those lines match on tool, session and time instead.
//
// Credentials in headers and query params are redacted; bodies are stored
// verbatim — in the turn or in the piece store next to it — so treat the
// directory as sensitive.
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const REDACTED = "<redacted>"
const SENSITIVE_NAME =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|cookie|signature/i
const SHORT_QUERY_NAME = /^(key|sig)$/i
const TEXT_CONTENT = /^(text\/|application\/(json|x-ndjson|jsonl|.*\+json))/i

// Paths the model APIs use: OpenAI-style completions and responses, Anthropic
// messages, Gemini generateContent, Bedrock converse/invoke, Cohere-style chat.
const MODEL_PATH =
  /(chat\/completions|\/completions|\/responses|\/messages|generatecontent|\/converse|\/invoke|\/predict|\/chat)(\b|$)/i
// Body keys that mean "this is a prompt", across every dialect.
const PROMPT_KEY = /"(messages|contents|system_instruction|systemInstruction)"\s*:/

// The fallback ratio, used only for the turns where the provider reports no
// usage at all. Where it does report, the real count is distributed instead.
const CHARS_PER_TOKEN = 4
const PREVIEW_CHARS = 240

// Turns that arrive without a session id on the wire and without a context to
// borrow one from still have to be written somewhere.
const NO_SESSION = "sem-sessao"

// The cache breakpoint markers. A well-behaved client moves them forward as
// the conversation grows, which changes the bytes without changing a word of
// what the model reads — so they are stripped before fingerprinting a prompt,
// or every turn would look like a broken prefix.
const CACHE_MARKER = /,?"(cache_control|cachePoint)"\s*:\s*\{[^{}]*\}/g

// Block types whose size on the wire says nothing about their token cost.
const BINARY_KIND = /image|audio|video|document|file|inline_?data|blob|source/i

// Sampling knobs worth auditing, across dialects. Everything else in the body
// is either the prompt itself or plumbing.
const SETTING_KEYS = [
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "maxTokens",
  "temperature",
  "top_p",
  "top_k",
  "topP",
  "topK",
  "thinking",
  "reasoning",
  "reasoning_effort",
  "tool_choice",
  "toolChoice",
  "parallel_tool_calls",
  "stop_sequences",
  "stop",
  "service_tier",
  "generationConfig",
  "inferenceConfig",
  "truncation",
  "store",
  "metadata",
]

// The prompt lists whose elements are worth keeping once and pointing at. The
// same tool schemas and the same messages come back on every turn of a
// conversation, and the providers echo them again inside the response, so this
// one set of names covers both halves of the record.
const PIECE_LIST = new Set(["system", "tools", "messages", "input", "contents"])
// Below this a reference costs more than the piece it replaces.
const PIECE_MIN_CHARS = 200
const PIECE_FILE = "pieces.jsonl"

// Where the providers put their token counts. Cohere hangs them off `meta`.
const USAGE_KEY = /^(usage|usage_?metadata|billed_units|token_?usage)$/i

// How many tool call ids to carry across a restart. A result answers a call
// from the turn before it, so the recent ones are the only ones anybody joins
// on, and the map would otherwise grow for the length of the conversation.
const TOOL_NAME_LIMIT = 2000

// Files a session folder keeps alongside its turns.
const TOOL_FILE = "tools.jsonl"
const EVENT_FILE = "events.jsonl"

// Bumped when the shape of what is written changes, so a reader looking at an
// old folder knows which fields it can expect to find.
const PLUGIN_VERSION = 2

type FetchLike = typeof globalThis.fetch

// Only the parts of the model this file uses. Declared locally because
// `@opencode-ai/plugin` does not export the model type, and the value we get
// from `chat.params` is structurally wider than this.
type ModelInfo = {
  id: string
  providerID: string
  // opencode's own catalog price for this model, per million tokens. Recorded
  // rather than turned into a dollar figure: the amount is arithmetic anyone can
  // redo, while the rate is a fact about the moment the request went out, and
  // the catalog is the only place it is both current and complete.
  cost?: { input: number; output: number; cache: { read: number; write: number } }
}

/**
 * One request's token bill, normalized across the dialects.
 *
 * `input` excludes what was read from or written to the cache, so the four
 * prompt-side counters never overlap and `prompt` is their sum. `reasoning` is
 * the thinking part of `output`, not an addition to it.
 */
type Usage = {
  input: number
  // Absent when the dialect has no such counter, which is not the same finding
  // as a zero: one says the model has no prompt cache, the other says the cache
  // was there and missed. A zero cannot tell them apart, so it is not written.
  cache_read?: number
  cache_write?: number
  output: number
  reasoning?: number
  prompt: number
  total: number
  source: "provider" | "estimated"
  // Counters only some providers report: the cache TTL split, audio and
  // prediction tokens, built-in tool requests, the provider's own total (kept
  // as reported, to check ours against, with `total_mismatch` written whenever
  // the two disagree), and its own cost when it bills in dollars rather than
  // tokens.
  details?: Record<string, number>
}

type Settings = {
  enabled: boolean
  dir: string
  raw: boolean
}

type Context = {
  sessionID: string
  agent: string
  providerID: string
  model: ModelInfo
  // Which reasoning variant of the model was asked for: "high", "max", "none",
  // and so on, or "default" when none was chosen. The same model id at two
  // efforts is not the same model to compare, so the turn has to say which.
  variant: string
}

// One decoded piece of the prompt: a system block, a tool schema, or a message.
// Sized in characters here; tokens are attributed later, once the provider has
// said what the whole prompt was actually billed at.
type Piece = {
  index: number
  role?: string
  name?: string
  kinds?: string[]
  chars: number
  share?: number
  binary?: boolean
  description_chars?: number
  schema_chars?: number
  cache?: string
  preview?: string
  // Where the message is in the folder's store, when it was big enough to go
  // there — the row and the bytes it describes join on this. Only messages
  // carry it: a tool row describes the schema unwrapped out of its envelope,
  // and a system row the content lifted out of its message, so neither is the
  // list element the store holds, and a reference that resolves to nothing
  // would be worse than none.
  ref?: string
  text?: string
  // Hash of the piece with the cache markers removed, for the reuse diff.
  stable?: string
  // The tool traffic inside this message. `kinds` says a block is a
  // `tool_result`; these say whose it is — without them the tokens a message
  // carries cannot be charged to the tool that produced them, which is the
  // first question anyone asks of this log.
  tool_calls?: { id?: string; name?: string; chars: number }[]
  tool_results?: { id?: string; tool?: string; chars: number; error?: boolean }[]
}

type Prompt = {
  dialect: string
  settings: Record<string, unknown>
  totals: {
    chars: number
    system_chars: number
    tools_chars: number
    messages_chars: number
    tool_count: number
    message_count: number
  }
  system: Piece[]
  tools: Piece[]
  messages: Piece[]
}

// The prompt with its tokens attributed: the JSON view, plus the per-message
// numbers the reuse diff needs.
type Attributed = {
  view: Record<string, unknown>
  perSystem: number[]
  perTool: number[]
  perMessage: number[]
  system: number
  tools: number
  messages: number
  total: number
  measured: boolean
}

// What a turn looked like, kept so the next turn of the same session can be
// diffed against it.
type Fingerprint = {
  turn: number
  system: string
  tools: string
  messages: string[]
  chars: number[]
  // Store references for the same messages, so a diff can point at the two
  // versions of the message that broke the prefix instead of only saying where.
  refs: (string | undefined)[]
}

type Reuse = {
  previous_turn: number
  system_changed: boolean
  tools_changed: boolean
  stable_messages: number
  changed_at: number | null
  added_messages: number
  dropped_messages: number
  prefix_stable: boolean
  // The prompt is the previous one, to the byte. Either the harness sent the
  // same request twice — a retry, when the first attempt failed — or it sent a
  // turn that added nothing, which is a bug worth seeing either way.
  identical: boolean
  resent_chars: number
  new_chars: number
  // The size of what is no longer in the prompt, read off the previous turn —
  // this one cannot say, the messages are gone from it. What compaction costs
  // is measured here.
  dropped_chars: number
  // The message the prefix broke on: what it is, and where to read both
  // versions of it. The first thing to look at when the cache stops hitting.
  changed_piece?: { index: number; role?: string; preview?: string; before?: string; after?: string }
}

type Reply = {
  text: string
  reasoning: string
  // `id` is the provider's tool call id: what the next turn's `tool_result`
  // points back at, and what `tools.jsonl` is keyed by. It is the join between
  // what the model asked for and what running it actually cost.
  tool_calls: { id?: string; name?: string; arguments: unknown; chars: number }[]
  stop_reason?: string
  chars: { text: number; reasoning: number; tool_calls: number; total: number }
}

type Draft = {
  text: string[]
  reasoning: string[]
  calls: Map<string, { id?: string; name?: string; args: string }>
  stop?: string
}

/**
 * How the response arrived, in milliseconds from the request going out.
 *
 * `elapsed_seconds` alone cannot tell a slow provider from a long answer: both
 * are one big number. The split is what makes the difference readable —
 * `first_token_ms` is the provider's latency, and what comes after it is the
 * model generating, which is priced per token and not per second.
 */
type Timing = {
  first_byte_ms: number
  // When the first frame carrying generated content arrived. Only for a stream:
  // a response delivered whole has no such moment, and a number there would
  // invite comparing it with one that means something else.
  first_token_ms?: number
  last_byte_ms: number
  // Time spent streaming, first byte to last. Divide the output tokens by it for
  // the generation rate.
  stream_ms: number
  chunks: number
}

// The fields that identify a turn, at the head of its record.
type Head = {
  turn: number
  provider: string | undefined
  model: string | undefined
  variant: string | undefined
  session: string | undefined
  agent: string | undefined
  started_at: string
  elapsed_seconds: number
}

// Running totals. Kept per model and per agent as well as overall, because
// tokens from a title model and tokens from the coding model are neither the
// same money nor the same problem.
type Bucket = {
  turns: number
  usage: Usage
}

/**
 * What one tool has cost the conversation.
 *
 * Two halves that answer different questions. `result_tokens` is the prompt
 * tokens its output occupied — the money it costs, and it keeps costing it on
 * every turn afterwards, because the result stays in the history. `ms` is the
 * wall clock it took, which costs no tokens at all but is the whole of what a
 * slow session feels like.
 */
type ToolCost = {
  calls: number
  result_tokens: number
  result_chars: number
  // What re-sending that same output has cost since. A result is written to the
  // history once and then travels in every prompt after it, so a tool that
  // returns too much is not paid for once — it is paid for on every turn that
  // follows, which is where the money in a long session actually goes.
  resent_tokens: number
  errors: number
  // From the execution hooks rather than the wire, so they stay at zero for a
  // provider-only record. `runs` counts the executions actually observed.
  runs: number
  failed: number
  ms: number
  ms_max: number
  output_chars: number
}

/** A tool execution between `tool.execute.before` and its `after`. */
type Running = {
  tool: string
  session: string
  started: number
  args_chars: number
  args_preview?: string
  request_index?: number
}

/**
 * One conversation, and one folder.
 *
 * A process serves however many conversations you open — `/new` does not start
 * a new process — and one conversation outlives however many processes, since
 * resuming it starts a new one. So the folder is neither: it belongs to the
 * session, is found again by id when the session is resumed, and keeps its turn
 * numbering and its totals across every run that writes to it. Everything is
 * counted here rather than on the run, which only indexes what it touched.
 *
 * Subagents (the `task` tool) are sessions of their own on the wire, with their
 * own id and a `parentID`, but they are part of the work of whoever spawned
 * them, so their turns are filed under the root session's folder.
 */
type Session = {
  id: string
  dir: string
  started: number
  turns: number
  errors: number
  incomplete: number
  reported: Bucket
  estimated: Bucket
  byModel: Map<string, Bucket>
  byAgent: Map<string, Bucket>
  // Per session id filed here, so what a subagent used is a number and not an
  // inference from the agent breakdown.
  bySession: Map<string, Bucket>
  // The reuse chains. Keeping them on the session makes diffing one
  // conversation's prompt against another's structurally impossible.
  history: Map<string, Fingerprint>
  // Every session id filed under this folder: the root and its subagents.
  members: Set<string>
  // Child -> parent among them, kept so the chain survives a restart: the wire
  // only ever names the immediate parent.
  parents: Map<string, string>
  prompt: { system: number; tools: number; messages: number; total: number }
  resent: number
  breaks: number
  // The pieces already in this folder's store, by hash. What is here is what
  // the next turn can point at instead of writing again.
  pieces: Set<string>
  // Tool call id -> tool name, learned from the `tool_use` blocks as they go by.
  // A `tool_result` names only the id it answers, so without this the row that
  // carries the tokens cannot say which tool earned them.
  toolNames: Map<string, string>
  // What each tool has cost, summed over the folder: the tokens of the results
  // it returned, and how often it was called.
  byTool: Map<string, ToolCost>
  // Tool executions still running, by call id, from `tool.execute.before`. A
  // call that never gets its `after` failed, was denied, or was interrupted.
  runningTools: Map<string, Running>
  // Compaction that has happened but whose cost is not yet visible, per session
  // id: the next turn that session sends is the one that shows what it dropped.
  pendingCompaction: Map<string, { at: string; overflow?: boolean }>
  // How many things the user has typed, per session id. A turn is filed under
  // the request that caused it, which is the unit a person recognizes — one
  // question of theirs, however many round trips it took to answer.
  requests: Map<string, number>
  // The last user message id seen per session, carried onto the turns so a
  // request can be found again in opencode's own storage.
  messages: Map<string, string>
  // How each turn ended, by turn number. Keyed by the number rather than by the
  // chain because the responses do not come back in the order the requests went
  // out — a request the provider rejects in one millisecond lands long before
  // the streamed answer sent ahead of it — and a map keyed by chain would hand
  // a turn whichever outcome happened to arrive last. Written when the response
  // headers arrive, which is the order opencode itself sees.
  outcomes: Map<number, { failed: boolean; status?: number }>
  retries: number
  retryTokens: number
  compactions: number
  compactionOverflow: number
  compactionDropped: number
  // Turns whose response had not landed yet. A request still in flight when the
  // process exits would otherwise leave no trace at all.
  pending: Map<number, Record<string, unknown>>
  // The runs that have written here, oldest first. More than one means the
  // conversation was resumed.
  runs: string[]
}

/** A session's folder as the previous run left it, read back from `state.json`. */
type Saved = {
  session: string
  started: number
  turns: number
  errors: number
  incomplete: number
  reported: Bucket
  estimated: Bucket
  byModel: Map<string, Bucket>
  byAgent: Map<string, Bucket>
  bySession: Map<string, Bucket>
  history: Map<string, Fingerprint>
  members: Set<string>
  parents: Map<string, string>
  prompt: Session["prompt"]
  resent: number
  breaks: number
  runs: string[]
  toolNames: Map<string, string>
  byTool: Map<string, ToolCost>
  requests: Map<string, number>
  retries: number
  retryTokens: number
  compactions: number
  compactionOverflow: number
  compactionDropped: number
}

// The process. It owns no folder of its own: the folders belong to the
// conversations, which outlive it. All it keeps is the roll-up it writes to
// `runs/`, saying which sessions it touched and where they live.
type Run = {
  base: string
  file: string
  started: number
  requests: number
  sessions: Map<string, Session>
  queue: Promise<void>
  // What this opencode was, so two runs can be told apart when the point of
  // comparing them is a setting that changed between the two. Learned from the
  // hooks, and absent on a run that recorded traffic before they fired.
  version?: string
  configHash?: string
}

// opencode can create more than one plugin instance per process; they all share
// one run and one set of session contexts.
type State = {
  settings: Settings
  // By session, which is how the requests identify themselves on the wire.
  contexts: Map<string, Context>
  // By model, only for requests that do not say which session they belong to.
  byModel: Map<string, Context>
  // Child session -> parent, learned from `x-parent-session-id`.
  parents: Map<string, string>
  recent?: Context
  run?: Run | false
}

export const LLMAuditPlugin: Plugin = async (_input, options) => {
  const settings = resolve(options)
  if (!settings.enabled) return {}
  const state = shared(settings)
  install(state)

  return {
    async "chat.params"(input) {
      // `model.providerID` rather than `provider`: the hook's declared type says
      // `provider` is a ProviderContext, but the session passes the provider
      // Info itself, so the shape of that argument is not something to rely on.
      const context: Context = {
        sessionID: input.sessionID,
        agent: input.agent,
        providerID: input.model.providerID,
        model: input.model,
        variant: variantOf(input.message),
      }
      state.contexts.set(context.sessionID, context)
      state.byModel.set(context.model.id, context)
      state.recent = context
    },

    // The rest of the hooks record what the wire cannot show. A tool call is a
    // string in the next prompt by the time it reaches the network: what it
    // cost to run, how long it took, and whether it failed at all happen
    // entirely inside opencode. Same for compaction, which the wire shows only
    // as a history that mysteriously got shorter.
    //
    // Every one of them is read-only. None writes to its `output` argument, so
    // arming the audit cannot change what opencode does — only what is known
    // about it.

    /** A new thing the user typed: the boundary the turns are grouped by. */
    async "chat.message"(input) {
      const sess = sessionOf(state, input.sessionID)
      if (!sess) return
      const next = (sess.requests.get(input.sessionID) ?? 0) + 1
      sess.requests.set(input.sessionID, next)
      if (input.messageID) sess.messages.set(input.sessionID, input.messageID)
    },

    async "tool.execute.before"(input, output) {
      const sess = sessionOf(state, input.sessionID)
      if (!sess) return
      const serial = safeStringify(output.args)
      sess.runningTools.set(input.callID, {
        tool: input.tool,
        session: input.sessionID,
        started: Date.now(),
        args_chars: serial.length,
        args_preview: preview(serial),
        request_index: sess.requests.get(input.sessionID),
      })
    },

    async "tool.execute.after"(input, output) {
      const sess = sessionOf(state, input.sessionID)
      const run = runOf(state)
      if (!sess || !run) return
      const started = sess.runningTools.get(input.callID)
      sess.runningTools.delete(input.callID)
      const ms = started ? Date.now() - started.started : undefined
      const text = typeof output.output === "string" ? output.output : safeStringify(output.output)
      const cost = toolCost(sess, input.tool)
      cost.runs += 1
      cost.output_chars += text.length
      if (ms !== undefined) {
        cost.ms += ms
        cost.ms_max = Math.max(cost.ms_max, ms)
      }
      append(run, sess, TOOL_FILE, {
        call_id: input.callID,
        tool: input.tool,
        session: input.sessionID,
        root_session: sess.id === NO_SESSION ? undefined : sess.id,
        request_index: started?.request_index ?? sess.requests.get(input.sessionID),
        started_at: new Date(started?.started ?? Date.now()).toISOString(),
        ms,
        args_chars: started?.args_chars ?? safeStringify(input.args).length,
        args_preview: started?.args_preview ?? preview(safeStringify(input.args)),
        title: output.title,
        output_chars: text.length,
        output_preview: preview(text),
        // The whole output is not written here. It reaches the model as the next
        // turn's tool result, and the store already holds that message verbatim,
        // so the way to it is `call_id` -> the `tool_results` entry on a prompt
        // row -> that row's `ref`. Repeating the bytes would be a third copy of
        // something already on disk twice.
        metadata_keys: isRecord(output.metadata) ? Object.keys(output.metadata) : undefined,
        ok: true,
      })
    },

    /** Compaction, in the three moments opencode announces it. */
    async "experimental.session.compacting"(input) {
      const sess = sessionOf(state, input.sessionID)
      const run = runOf(state)
      if (sess && run) append(run, sess, EVENT_FILE, event("compacting", input.sessionID, sess))
    },

    async "experimental.compaction.autocontinue"(input) {
      const sess = sessionOf(state, input.sessionID)
      const run = runOf(state)
      if (!sess || !run) return
      const at = new Date().toISOString()
      // `overflow` is the distinction that matters: a compaction the context
      // forced is a limit being hit, an elective one is a choice.
      sess.pendingCompaction.set(input.sessionID, { at, overflow: input.overflow })
      append(run, sess, EVENT_FILE, { ...event("compacted", input.sessionID, sess), overflow: input.overflow })
    },

    async event({ event: incoming }) {
      if (incoming.type !== "session.compacted") return
      const sessionID = str(record(incoming.properties)?.["sessionID"])
      if (!sessionID) return
      const sess = sessionOf(state, sessionID)
      const run = runOf(state)
      if (!sess || !run) return
      // The autocontinue hook is the one that knows about `overflow`, and it may
      // or may not run. Whichever arrives first opens the pending record; the
      // other only fills it in.
      if (!sess.pendingCompaction.has(sessionID))
        sess.pendingCompaction.set(sessionID, { at: new Date().toISOString() })
      append(run, sess, EVENT_FILE, event("session.compacted", sessionID, sess))
    },

    /** What this opencode was configured to be, for comparing one run to another. */
    async config(input) {
      const run = runOf(state)
      if (!run || run.configHash) return
      const redacted = redactDeep(input)
      run.configHash = hash(safeJson(redacted))
      run.version ??= await version()
      run.queue = run.queue
        .then(() => fs.promises.writeFile(run.file.replace(/\.json$/, ".config.json"), text(redacted)))
        .then(() => fs.promises.writeFile(run.file, text(runSummary(run))))
        .catch(() => undefined)
    },
  }
}

/**
 * Which opencode this is, if it will say.
 *
 * There is no route on the SDK client that reports it and no environment
 * variable that carries it, so the only handle is the module the built-in
 * plugins import it from. That module is not a declared dependency of this
 * file, and making it one would cost the property that matters most here —
 * that this is one file you drop into a stock install. So it is asked for
 * politely and the answer is allowed to be nothing.
 */
async function version(): Promise<string | undefined> {
  // Held in a variable so the specifier stays out of the module graph: written
  // inline it would be a compile-time dependency of a file that deliberately
  // has none.
  const specifier = "@opencode-ai/core/installation/version"
  try {
    const module: unknown = await import(specifier)
    return str(record(module)?.["InstallationVersion"])
  } catch {
    return undefined
  }
}

/** A session-level line, with the fields every one of them carries. */
function event(type: string, sessionID: string, sess: Session) {
  return {
    type,
    at: new Date().toISOString(),
    session: sessionID,
    root_session: sess.id === NO_SESSION ? undefined : sess.id,
    turn: sess.turns,
    request_index: sess.requests.get(sessionID),
  }
}

/**
 * The reasoning variant the user message asked for, or "default" when it asked
 * for none.
 *
 * Read structurally rather than off the type: the generated `UserMessage` still
 * declares `model` as `{providerID, modelID}` while the session fills in a third
 * field, so the property exists at runtime and not in the SDK's idea of it. The
 * same reason `ModelInfo` above is declared locally.
 *
 * "default" is written rather than left absent, and the two are not the same
 * finding: it says a variant was resolved and it was none, where a missing field
 * says the log predates this being recorded at all. A reader that cannot tell
 * them apart would report every old turn as running at default effort.
 */
function variantOf(message: unknown): string {
  const model = isRecord(message) ? message["model"] : undefined
  const variant = isRecord(model) ? model["variant"] : undefined
  return typeof variant === "string" && variant ? variant : "default"
}

/**
 * The folder a hook's session writes to, opened if this run has not opened it
 * yet. Same resolution the turns use, so a subagent's tools land in the folder
 * of the conversation whose work it is doing.
 */
function sessionOf(state: State, sessionID: string): Session | undefined {
  const run = runOf(state)
  if (!run) return undefined
  return openSession(state, run, rootOf(state, sessionID))
}

/** Appends one JSONL line to a file in the session's folder, through the queue. */
function append(run: Run, sess: Session, file: string, line: Record<string, unknown>) {
  run.queue = run.queue
    .then(() => fs.promises.appendFile(path.join(sess.dir, file), JSON.stringify(strip(line)) + "\n"))
    .catch(() => undefined)
}

/** Drops the keys whose value is undefined, which `JSON.stringify` keeps as noise. */
function strip(line: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(line)) if (value !== undefined) result[key] = value
  return result
}

/**
 * A config with anything credential-shaped taken out, by the same rule the
 * headers use. The file is written next to the turns, and a config carries
 * provider keys.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 12) return value
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1))
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value))
    result[key] = SENSITIVE_NAME.test(key) ? REDACTED : redactDeep(child, depth + 1)
  return result
}

function shared(settings: Settings): State {
  const global = globalThis as Record<string, unknown>
  const existing = global["__opencodeLLMAuditState"] as State | undefined
  if (existing) return existing
  const state: State = { settings, contexts: new Map(), byModel: new Map(), parents: new Map() }
  global["__opencodeLLMAuditState"] = state
  return state
}

/** Wraps the process's fetch, once, however many plugin instances load. */
function install(state: State) {
  const global = globalThis as Record<string, unknown>
  if (global["__opencodeLLMAuditFetch"]) return
  const original = globalThis.fetch
  const patched = (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const request = describeRequest(input, init)
    if (!isModelCall(request)) return original(input, init)
    return capture(state, request, () => original(input, init))
  }
  // Carries over anything the runtime hangs off fetch (Bun's `preconnect`).
  global["__opencodeLLMAuditFetch"] = true
  globalThis.fetch = Object.assign(patched, original) as FetchLike
  const run = runOf(state)
  if (!run) return
  // Written as soon as the audit arms itself, so a run that records nothing
  // still shows that the plugin loaded and where it was pointed.
  run.queue = run.queue
    .then(() => fs.promises.writeFile(run.file, text(runSummary(run))))
    .catch(() => undefined)
  // Written synchronously: an exit handler is too late for the queue.
  process.on("exit", () => flush(run))
}

/** Records the turns still in flight, so a turn is never silently lost. */
function flush(run: Run) {
  for (const sess of folders(run)) {
    if (sess.pending.size) {
      sess.incomplete = sess.pending.size
      for (const [turn, record] of sess.pending) {
        try {
          const { record: deflated, fresh, refs } = deflate(record, sess)
          if (refs) deflated["pieces"] = PIECE_FILE
          if (fresh.size) fs.appendFileSync(path.join(sess.dir, PIECE_FILE), pieceLines(fresh))
          fs.writeFileSync(turnPath(sess, turn), text(deflated))
          fs.appendFileSync(
            path.join(sess.dir, "turns.jsonl"),
            JSON.stringify({
              turn,
              time: record["started_at"],
              session: record["session"],
              parent_session: record["parent_session"],
              root_session: record["root_session"],
              agent: record["agent"],
              model: record["model"],
              incomplete: true,
            }) + "\n",
          )
        } catch {
          // Nothing useful to do at exit.
        }
      }
      sess.pending.clear()
    }
    // A tool that got its `before` and never its `after` did not finish: it
    // threw, was denied, or the process left while it was still running.
    // opencode does not fire the `after` hook on the failing path, so the
    // absence is the record — without this the call would leave no trace at all,
    // and a tool that fails constantly would look like a tool nobody calls.
    for (const [callID, running] of sess.runningTools) {
      const cost = toolCost(sess, running.tool)
      cost.runs += 1
      cost.failed += 1
      try {
        fs.appendFileSync(
          path.join(sess.dir, TOOL_FILE),
          JSON.stringify(
            strip({
              call_id: callID,
              tool: running.tool,
              session: running.session,
              root_session: sess.id === NO_SESSION ? undefined : sess.id,
              request_index: running.request_index,
              started_at: new Date(running.started).toISOString(),
              ms: Date.now() - running.started,
              args_chars: running.args_chars,
              args_preview: running.args_preview,
              ok: false,
              note: "no completion was recorded: the tool failed, was denied, or was still running when the process exited",
            }),
          ) + "\n",
        )
      } catch {
        // Nothing useful to do at exit.
      }
    }
    sess.runningTools.clear()
    try {
      fs.writeFileSync(path.join(sess.dir, "summary.json"), text(summary(sess)))
      // Last, and always: without it the next run would not find this folder,
      // and would start the conversation over in a new one.
      fs.writeFileSync(path.join(sess.dir, "state.json"), text(checkpoint(sess)))
    } catch {
      // Nothing useful to do at exit.
    }
  }
  try {
    fs.writeFileSync(run.file, text(runSummary(run)))
  } catch {
    // Nothing useful to do at exit.
  }
}

/**
 * A model call POSTs a JSON body shaped like a prompt. Both halves matter: the
 * shape alone would catch opencode's own APIs, and the path alone would catch
 * unrelated traffic to the same hosts.
 */
function isModelCall(request: ReturnType<typeof describeRequest>) {
  if (request.method !== "POST" || typeof request.raw !== "string") return false
  if (!PROMPT_KEY.test(request.raw) && !isRecord(request.body)) return false
  if (!isRecord(request.body)) return false
  const shape =
    "messages" in request.body ||
    "contents" in request.body ||
    "prompt" in request.body ||
    ("input" in request.body && "model" in request.body)
  if (!shape) return false
  return MODEL_PATH.test(pathOf(request.url)) || typeof request.body["model"] === "string"
}

async function capture(state: State, request: ReturnType<typeof describeRequest>, send: () => Promise<Response>) {
  const run = runOf(state)
  if (!run) return send()

  const started = Date.now()
  run.requests += 1
  const model = modelOf(request)
  // opencode names the session on every request it makes. Matching on that is
  // exact; falling back to the model is a guess that goes wrong the moment two
  // sessions share one — a `/new` while the old session still has a request in
  // flight would file that request under the new session, and diff its prompt
  // against a conversation it has nothing to do with.
  // `x-opencode-session` because the opencode-hosted providers name the session
  // under that header instead of `X-Session-Id` (see `session/llm/request.ts`);
  // without it their traffic would fall through to the guesses below.
  const wire =
    headerOf(request, "x-session-id") ??
    headerOf(request, "x-session-affinity") ??
    headerOf(request, "x-opencode-session")
  const context =
    (wire ? state.contexts.get(wire) : undefined) ?? (model ? state.byModel.get(model) : undefined) ?? state.recent
  const parent = headerOf(request, "x-parent-session-id")
  // Learned only from an id that was on the wire. A guessed id is not the one
  // that sent the request, and filing a parent under it would put a session
  // that has nothing to do with this one inside someone else's folder.
  if (wire && parent) state.parents.set(wire, parent)
  const sessionID = wire ?? context?.sessionID
  // A subagent gets its own folder nowhere: it is filed with the session whose
  // work it is doing. A request carrying a parent header is a subagent's by
  // definition, so even when its own id never reached us, the folder is the
  // parent's — a better answer than whichever session spoke last.
  const root = wire ? rootOf(state, wire) : parent ? rootOf(state, parent) : rootOf(state, sessionID)
  const sess = openSession(state, run, root)
  if (!sess) return send()
  if (sessionID) sess.members.add(sessionID)
  if (wire && parent) sess.parents.set(wire, parent)
  const turn = ++sess.turns

  // Decoded before the request goes out, so the reuse chain follows the order
  // the turns were sent rather than the order the responses came back.
  const prompt = readPrompt(request.body, sess.toolNames)
  const reuse = track(sess, turn, sessionID, context, model, prompt)
  // The request this turn is part of: whatever the user last typed into this
  // session, and — for a subagent, whose own counter starts at one — the one
  // that caused the conversation it is doing the work of.
  const requestIndex = sess.requests.get(sessionID ?? "?")
  const rootIndex = sess.requests.get(sess.id)
  // A compaction that has fired since the last turn is charged here: this is
  // the first prompt written against the rewritten history, so its reuse diff
  // is the measurement of what the compaction actually threw away.
  const compacted = sessionID ? sess.pendingCompaction.get(sessionID) : undefined
  if (sessionID) sess.pendingCompaction.delete(sessionID)
  const sent = {
    method: request.method,
    url: redactUrl(request.url),
    headers: request.headers,
    body: request.body,
  }
  sess.pending.set(turn, {
    turn,
    provider: context?.providerID ?? hostOf(request.url),
    model: model ?? context?.model.id,
    variant: context?.variant,
    session: sessionID,
    parent_session: parent,
    root_session: sess.id === NO_SESSION ? undefined : sess.id,
    agent: context?.agent,
    started_at: new Date(started).toISOString(),
    request_index: requestIndex,
    root_request_index: rootIndex !== requestIndex ? rootIndex : undefined,
    user_message: sessionID ? sess.messages.get(sessionID) : undefined,
    incomplete: true,
    note: "the process exited while this request was still in flight, so nothing is known about its token usage",
    prompt: view(prompt),
    reuse: resolveReuse(reuse, undefined),
    request: sent,
  })

  const write = (
    result: { response?: unknown; error?: unknown; reply?: Reply; timing?: Timing },
    reported: Usage | undefined,
    billed = true,
  ) => {
    // A turn the provider said nothing about still consumed tokens; counting it
    // as zero would quietly understate the run, so estimate it and label it.
    const usage = reported ?? (billed ? guess(prompt, result.reply) : undefined)
    const tokens = attribute(prompt, usage)
    const diff = resolveReuse(reuse, tokens)
    // A prompt sent again byte for byte, after the turn it repeats failed, is a
    // retry: nothing new was asked and the tokens are being paid a second time.
    // Every one of them is pure waste, which is why it is worth a field of its
    // own rather than a turn that merely looks like its neighbour.
    //
    // `previous_turn` is the turn this prompt was diffed against, assigned when
    // the request went out, so the link follows the order things were sent
    // rather than the order the answers came back.
    const before = reuse ? sess.outcomes.get(reuse.previous_turn) : undefined
    const retry = reuse?.identical && before?.failed ? { turn: reuse.previous_turn, status: before.status } : undefined
    if (retry) {
      sess.retries += 1
      sess.retryTokens += usage?.total ?? 0
    }
    if (compacted) {
      sess.compactions += 1
      if (compacted.overflow) sess.compactionOverflow += 1
      sess.compactionDropped += droppedTokens(reuse, tokens, prompt)
    }
    sess.pending.delete(turn)
    tally(sess, sessionID, context, model, usage, tokens, reuse, prompt)

    const head: Head = {
      turn,
      provider: context?.providerID ?? hostOf(request.url),
      model: model ?? context?.model.id,
      variant: context?.variant,
      session: sessionID,
      agent: context?.agent,
      started_at: new Date(started).toISOString(),
      elapsed_seconds: (Date.now() - started) / 1000,
    }
    persist(
      run,
      sess,
      turn,
      {
        ...head,
        parent_session: parent,
        // The conversation this folder is: the same as `session` unless the turn
        // is a subagent's, in which case it is whoever spawned it.
        root_session: sess.id === NO_SESSION ? undefined : sess.id,
        request_index: requestIndex,
        root_request_index: rootIndex !== requestIndex ? rootIndex : undefined,
        user_message: sessionID ? sess.messages.get(sessionID) : undefined,
        retry_of: retry?.turn,
        retry_reason: retry ? (retry.status ? `HTTP ${retry.status}` : "the request never returned") : undefined,
        compaction: compacted
          ? {
              ...compacted,
              dropped_messages: reuse?.dropped_messages,
              dropped_tokens: droppedTokens(reuse, tokens, prompt),
            }
          : undefined,
        usage,
        cache_hit_rate: hitRate(usage),
        // What a token of each kind cost here, straight from opencode's model
        // catalog. Not multiplied out: what this turn was worth is the reader's
        // multiplication to do, and a total frozen into the file would be one
        // more number to distrust when the catalog moves.
        rates_per_million: context?.model.cost
          ? {
              input: context.model.cost.input,
              output: context.model.cost.output,
              cache_read: context.model.cost.cache.read,
              cache_write: context.model.cost.cache.write,
            }
          : undefined,
        timing: result.timing,
        prompt: tokens?.view ?? view(prompt),
        reuse: diff,
        reply: replyView(result.reply, usage),
        request: sent,
        response: result.response,
        error: result.error,
      },
      {
        turn,
        time: head.started_at,
        session: head.session,
        // Carried on the index line too, so grouping a folder's turns by
        // conversation never means opening every turn file.
        parent_session: parent,
        root_session: sess.id === NO_SESSION ? undefined : sess.id,
        agent: head.agent,
        model: head.model,
        request_index: requestIndex,
        retry_of: retry?.turn,
        compaction: compacted ? true : undefined,
        source: usage?.source,
        input_tokens: usage?.input,
        cache_read_tokens: usage?.cache_read,
        cache_write_tokens: usage?.cache_write,
        prompt_tokens: usage?.prompt,
        output_tokens: usage?.output,
        reasoning_tokens: usage?.reasoning,
        total_tokens: usage?.total,
        cache_hit_rate: hitRate(usage),
        system_tokens: tokens?.system,
        tools_tokens: tokens?.tools,
        messages_tokens: tokens?.messages,
        stable_messages: reuse?.stable_messages,
        prefix_stable: reuse?.prefix_stable,
        stop_reason: result.reply?.stop_reason,
        tool_calls: result.reply?.tool_calls.map((call) => call.name).filter(Boolean),
        first_token_ms: result.timing?.first_token_ms,
        seconds: head.elapsed_seconds,
      },
    )
  }

  try {
    const response = await send()
    let read: Promise<{ buffer?: ArrayBuffer; timing?: Timing }>
    try {
      read = timedBody(response.clone(), started).catch(() => ({}))
    } catch {
      read = Promise.resolve({})
    }
    const status = response.status
    // Recorded here rather than where the turn is written: opencode decides
    // whether to retry the moment it sees this status, so this is the one point
    // that is guaranteed to come before the retry is sent. The record itself is
    // written much later, once the body has been read, and by then several
    // turns may have overtaken each other.
    sess.outcomes.set(turn, { failed: status >= 400, status })
    forget(sess.outcomes, turn)
    const headers = redactHeaders(response.headers)
    const type = response.headers.get("content-type") ?? ""
    void read.then(({ buffer, timing }) => {
      const body = describeResponse(type, buffer, state.settings.raw)
      const payload = body["events"] ?? body["body"]
      // A rejected request bought nothing. Keep whatever the provider did
      // report, but never invent an estimate for a turn that was not served.
      const served = status < 400
      if (!served) sess.errors += 1
      write(
        { response: { status, headers, ...body }, reply: readReply(payload), timing },
        usageOf(payload),
        served,
      )
    }, nothing)
    return response
  } catch (error) {
    sess.errors += 1
    sess.outcomes.set(turn, { failed: true })
    forget(sess.outcomes, turn)
    write({ error: describeError(error) }, undefined, false)
    throw error
  }
}

// Only the recent turns are ever asked about — a retry follows the turn it
// repeats — so the map is kept short rather than growing for the length of the
// conversation.
const OUTCOME_MEMORY = 50

function forget(outcomes: Map<number, unknown>, turn: number) {
  for (const past of outcomes.keys()) if (past < turn - OUTCOME_MEMORY) outcomes.delete(past)
}

// Where a stream stops being latency and starts being generation: the first
// frame that carries a piece of the answer. Matched on the bytes rather than on
// parsed frames because the point is to know *when* it arrived, and the parse
// only happens once the whole body is in. Deliberately loose — every dialect
// spells its delta differently, and being a frame early or late costs a few
// milliseconds on a number whose interesting range is hundreds.
const FIRST_TOKEN = /content_block_delta|"delta"\s*:|\.delta"|"candidates"/

/**
 * The response body, with the clock kept while it arrives.
 *
 * The buffered read this replaces resolves only once the stream has ended, so
 * every moment inside it was lost — and a streamed answer is nearly all inside
 * it. Reading the clone frame by frame costs one pass over bytes that were
 * being decoded anyway, and buys the one measurement that separates a slow
 * provider from a long answer.
 *
 * The response handed back to opencode is untouched: this reads a clone.
 */
async function timedBody(response: Response, started: number): Promise<{ buffer?: ArrayBuffer; timing?: Timing }> {
  const body = response.body
  // No stream to read: a body already in hand, or a runtime that does not
  // expose one. Fall back to the buffered read, and report no timing rather
  // than a made-up one.
  if (!body) return { buffer: await response.arrayBuffer().catch(nothing) }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder("utf-8", { fatal: false })
  let size = 0
  let first: number | undefined
  let token: number | undefined
  let last = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    const at = Date.now() - started
    if (first === undefined) first = at
    last = at
    chunks.push(value)
    size += value.byteLength
    // `stream: true` so a multi-byte character split across two chunks does not
    // come back as a replacement character and hide the marker behind it.
    if (token === undefined && FIRST_TOKEN.test(decoder.decode(value, { stream: true }))) token = at
  }

  const buffer = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    buffer: buffer.buffer,
    timing:
      first === undefined
        ? undefined
        : {
            first_byte_ms: first,
            // Only meaningful when the answer came in pieces. One chunk is a
            // response that was assembled before it was sent, and its first
            // token never had a moment of its own.
            first_token_ms: chunks.length > 1 ? token : undefined,
            last_byte_ms: last,
            stream_ms: last - first,
            chunks: chunks.length,
          },
  }
}

function resolve(options?: PluginOptions): Settings {
  const env = process.env
  const flag = env["OPENCODE_LLM_AUDIT"]
  const dir = (options?.["dir"] as string) ?? env["OPENCODE_LLM_AUDIT_DIR"]
  return {
    enabled:
      (options?.["enabled"] as boolean) ??
      (flag === undefined ? Boolean(dir) : flag !== "" && flag !== "0" && flag.toLowerCase() !== "false"),
    dir:
      dir ??
      path.join(env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share"), "opencode", "log", "llm-audit"),
    raw: (options?.["raw"] as boolean) ?? env["OPENCODE_LLM_AUDIT_RAW"] === "1",
  }
}

/**
 * The folders this run has open. `run.sessions` is keyed by session id and a
 * folder can be reached through more than one — a subagent aliased onto the
 * conversation that owns it — so anything that walks the folders walks these.
 */
function folders(run: Run) {
  return [...new Set(run.sessions.values())]
}

/** The run, opened once per process. */
function runOf(state: State): Run | undefined {
  if (state.run !== undefined) return state.run || undefined
  const run = open(state.settings.dir)
  state.run = run ?? false
  return run
}

function open(base: string): Run | undefined {
  const now = new Date()
  const file = path.join(base, "runs", `${stamp(now)}-${process.pid}.json`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      path.join(base, "latest.json"),
      text({ time: now.toISOString(), pid: process.pid, cwd: process.cwd(), path: base, run: file }),
    )
  } catch {
    return undefined
  }
  return { base, file, started: Date.now(), requests: 0, sessions: new Map(), queue: Promise.resolve() }
}

/**
 * The folder a session writes into: the one it already has if it has one, so
 * resuming a conversation appends to it rather than scattering the same
 * conversation over a folder per run. Everything the previous run counted is
 * read back with it, so the totals and the turn numbers carry on.
 */
function openSession(state: State, run: Run, root: string): Session | undefined {
  const existing = run.sessions.get(root)
  if (existing) return existing
  let found: { dir: string; id: string }
  let prior: Saved | undefined
  try {
    found = sessionDir(run.base, root)
    prior = readState(found.dir)
    fs.mkdirSync(found.dir, { recursive: true })
  } catch {
    return undefined
  }
  // The folder can already be open under another id: a subagent whose parent
  // chain never reached us resolves to the folder its root opened. One folder
  // is one set of counters, so the id is aliased onto the session that has it.
  const opened = [...run.sessions.values()].find((sess) => sess.dir === found.dir)
  if (opened) {
    run.sessions.set(root, opened)
    return opened
  }
  if (prior && prior.session !== found.id) prior = undefined
  const created: Session = {
    id: found.id,
    dir: found.dir,
    started: prior?.started ?? Date.now(),
    // Never below what is on disk: a state file that was lost or truncated must
    // not make this run overwrite the turns the last one wrote.
    turns: Math.max(prior?.turns ?? 0, lastTurn(found.dir)),
    errors: prior?.errors ?? 0,
    incomplete: prior?.incomplete ?? 0,
    reported: prior?.reported ?? bucket(),
    estimated: prior?.estimated ?? bucket(),
    byModel: prior?.byModel ?? new Map(),
    byAgent: prior?.byAgent ?? new Map(),
    bySession: prior?.bySession ?? new Map(),
    history: prior?.history ?? new Map(),
    members: prior?.members ?? new Set(),
    parents: prior?.parents ?? new Map(),
    prompt: prior?.prompt ?? { system: 0, tools: 0, messages: 0, total: 0 },
    resent: prior?.resent ?? 0,
    breaks: prior?.breaks ?? 0,
    pieces: storedPieces(found.dir),
    pending: new Map(),
    runs: [...(prior?.runs ?? []), path.basename(run.file)],
    toolNames: prior?.toolNames ?? new Map(),
    byTool: prior?.byTool ?? new Map(),
    runningTools: new Map(),
    pendingCompaction: new Map(),
    requests: prior?.requests ?? new Map(),
    messages: new Map(),
    outcomes: new Map(),
    retries: prior?.retries ?? 0,
    retryTokens: prior?.retryTokens ?? 0,
    compactions: prior?.compactions ?? 0,
    compactionOverflow: prior?.compactionOverflow ?? 0,
    compactionDropped: prior?.compactionDropped ?? 0,
  }
  if (created.id !== NO_SESSION) created.members.add(created.id)
  // The chain this folder learned in earlier runs. Without it, a subagent that
  // spawns a subagent loses its root the moment the process restarts: the wire
  // only ever names the immediate parent.
  for (const [child, parent] of created.parents) if (!state.parents.has(child)) state.parents.set(child, parent)
  run.sessions.set(root, created)
  if (root !== created.id) run.sessions.set(created.id, created)
  return created
}

/**
 * Where a conversation lives: the same folder every time, so coming back to a
 * session months later writes next to what it wrote then.
 *
 * The name leads with the time the session was first seen, so a reader sorting
 * folder names — which is what the viewer does — reads them in the order the
 * conversations started. The name is only a label, though: what identifies the
 * folder is the session id in its `state.json`, because ten characters of an id
 * are not a promise of uniqueness.
 *
 * A subagent asked for by its own id lands on the folder of whoever spawned it,
 * because that folder lists it as a member — the fallback that keeps a session's
 * work together even when the parent chain did not survive the restart. Turns
 * that arrive without a session id have nothing to be matched on at all, so they
 * always open a folder of their own.
 */
function sessionDir(base: string, id: string): { dir: string; id: string } {
  if (id !== NO_SESSION) {
    const pattern = new RegExp(`^\\d{8}_\\d{6}-${escaped(short(id))}(-\\d+)?$`)
    const folders = []
    for (const name of entriesOf(base).sort()) {
      const dir = path.join(base, name)
      if (pattern.test(name)) {
        const saved = readState(dir)
        if (saved?.session === id) return { dir, id }
      } else if (/^\d{8}_\d{6}-/.test(name)) folders.push(dir)
    }
    for (const dir of folders) {
      const saved = readState(dir)
      if (saved && saved.session !== NO_SESSION && saved.members.has(id)) return { dir, id: saved.session }
    }
  }
  const first = `${stamp(new Date())}-${short(id)}`
  let name = first
  for (let i = 2; fs.existsSync(path.join(base, name)); i++) name = `${first}-${i}`
  return { dir: path.join(base, name), id }
}

function entriesOf(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** The highest turn already written to a folder, whatever its state file says. */
function lastTurn(dir: string) {
  let highest = 0
  for (const name of entriesOf(dir)) {
    const match = /^turn_(\d+)/.exec(name)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

/**
 * The folder as the last run left it. Anything unreadable is treated as absent:
 * starting the counts over is a wrong number in one folder, while trusting a
 * file we cannot parse would merge two conversations.
 */
function readState(dir: string): Saved | undefined {
  let data: unknown
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))
  } catch {
    return undefined
  }
  if (!isRecord(data) || typeof data["session"] !== "string") return undefined
  const prompt = isRecord(data["prompt"]) ? data["prompt"] : {}
  return {
    session: data["session"],
    started: num(data["started"]) || Date.now(),
    turns: num(data["turns"]),
    errors: num(data["errors"]),
    incomplete: num(data["incomplete"]),
    reported: reviveBucket(data["reported"]),
    estimated: reviveBucket(data["estimated"]),
    byModel: reviveBuckets(data["by_model"]),
    byAgent: reviveBuckets(data["by_agent"]),
    bySession: reviveBuckets(data["by_session"]),
    history: reviveHistory(data["history"]),
    members: new Set(strings(data["members"])),
    parents: reviveParents(data["parents"]),
    prompt: {
      system: num(prompt["system"]),
      tools: num(prompt["tools"]),
      messages: num(prompt["messages"]),
      total: num(prompt["total"]),
    },
    resent: num(data["resent"]),
    breaks: num(data["breaks"]),
    runs: strings(data["runs"]),
    toolNames: reviveParents(data["tool_names"]),
    byTool: reviveTools(data["by_tool"]),
    requests: reviveCounts(data["requests"]),
    retries: num(data["retries"]),
    retryTokens: num(data["retry_tokens"]),
    compactions: num(data["compactions"]),
    compactionOverflow: num(data["compaction_overflow"]),
    compactionDropped: num(data["compaction_dropped_tokens"]),
  }
}

/** The per-tool totals as the last run left them. */
function reviveTools(value: unknown): Map<string, ToolCost> {
  const map = new Map<string, ToolCost>()
  if (!isRecord(value)) return map
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    map.set(name, {
      calls: num(entry["calls"]),
      result_tokens: num(entry["result_tokens"]),
      result_chars: num(entry["result_chars"]),
      resent_tokens: num(entry["resent_tokens"]),
      errors: num(entry["errors"]),
      runs: num(entry["runs"]),
      failed: num(entry["failed"]),
      ms: num(entry["ms"]),
      ms_max: num(entry["ms_max"]),
      output_chars: num(entry["output_chars"]),
    })
  }
  return map
}

/** A map of counters, read back as it was written. */
function reviveCounts(value: unknown): Map<string, number> {
  const map = new Map<string, number>()
  if (!isRecord(value)) return map
  for (const [key, count] of Object.entries(value)) if (typeof count === "number") map.set(key, count)
  return map
}

/** The child -> parent links this folder has seen, as the next run needs them. */
function reviveParents(value: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (!isRecord(value)) return map
  for (const [child, parent] of Object.entries(value)) if (typeof parent === "string") map.set(child, parent)
  return map
}

function reviveBucket(value: unknown): Bucket {
  const created = bucket()
  if (!isRecord(value)) return created
  created.turns = num(value["turns"])
  const usage = isRecord(value["usage"]) ? value["usage"] : {}
  for (const key of ["input", "cache_read", "cache_write", "output", "reasoning", "prompt", "total"] as const)
    created.usage[key] = num(usage[key])
  const details = isRecord(usage["details"]) ? usage["details"] : undefined
  const kept: Record<string, number> = {}
  for (const [key, amount] of Object.entries(details ?? {})) if (typeof amount === "number") kept[key] = amount
  if (Object.keys(kept).length) created.usage.details = kept
  return created
}

function reviveBuckets(value: unknown): Map<string, Bucket> {
  const map = new Map<string, Bucket>()
  if (!isRecord(value)) return map
  for (const [key, entry] of Object.entries(value)) map.set(key, reviveBucket(entry))
  return map
}

/** The prompt fingerprints, so the first turn after a resume still diffs. */
function reviveHistory(value: unknown): Map<string, Fingerprint> {
  const map = new Map<string, Fingerprint>()
  if (!isRecord(value)) return map
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    if (typeof entry["system"] !== "string" || typeof entry["tools"] !== "string") continue
    if (!Array.isArray(entry["messages"]) || !Array.isArray(entry["chars"])) continue
    map.set(key, {
      turn: num(entry["turn"]),
      system: entry["system"],
      tools: entry["tools"],
      messages: strings(entry["messages"]),
      chars: entry["chars"].map(num),
      // Absent in a folder written before the store existed: the diff then says
      // where the prefix broke, just not where to read it.
      refs: Array.isArray(entry["refs"]) ? entry["refs"].map((item) => str(item)) : [],
    })
  }
  return map
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Walks the parent chain up to the session that owns the work. */
function rootOf(state: State, session: string | undefined): string {
  if (!session) return NO_SESSION
  let current = session
  // A subagent can spawn a subagent; the guard is against a cycle, not depth.
  for (let step = 0; step < 8; step++) {
    const parent = state.parents.get(current)
    if (!parent || parent === current) break
    current = parent
  }
  return current
}

function short(id: string) {
  if (id === NO_SESSION) return NO_SESSION
  return id.replace(/^ses_/, "").slice(0, 10) || NO_SESSION
}

/**
 * The hashes a folder's store already holds.
 *
 * Read off the file rather than out of `state.json`, because the set is a
 * promise that a reference can be resolved: a state file that is newer than the
 * store — or a store someone trimmed by hand — would make it a lie, and the
 * turn that trusted it would point at nothing.
 */
function storedPieces(dir: string) {
  const found = new Set<string>()
  try {
    const lines = fs.readFileSync(path.join(dir, PIECE_FILE), "utf8")
    for (const match of lines.matchAll(/^\{"h":"([0-9a-f]+)"/gm)) found.add(match[1])
  } catch {
    // No store yet, or one that cannot be read: every piece is written again,
    // which costs space and is never wrong.
  }
  return found
}

/**
 * The record with its bulk moved to the store.
 *
 * Every turn of a conversation carries the whole conversation — the same tool
 * schemas, the same system prompt, the same messages as the turn before, plus
 * whatever is new — and the providers echo the tool schemas back inside the
 * response on top of that. Written out whole, one turn of a long session runs to
 * hundreds of kilobytes of text that is already on disk a dozen times over.
 *
 * So each list element big enough to be worth it is written once to
 * `pieces.jsonl` and left in the record as `{"$ref": <hash>}`. Nothing is lost:
 * the piece is stored verbatim, and joining the two gives back exactly the
 * record that would have been written.
 */
function deflate(value: unknown, sess: Session) {
  const fresh = new Map<string, string>()
  let refs = 0
  // Only inside the verbatim halves of the record. The `prompt` view next to
  // them is a list of rows named `messages` too, but it is this turn's
  // measurement — its token counts differ from every other turn's, so no two
  // rows ever hash alike and storing them fills the file with entries that can
  // never be reused. Those rows already carry a `ref` to reach the bytes they
  // describe; they are the index, not the thing indexed.
  const walk = (item: unknown, verbatim: boolean): unknown => {
    if (Array.isArray(item)) return item.map((child) => walk(child, verbatim))
    if (!isRecord(item)) return item
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(item)) {
      const inside = verbatim || key === "request" || key === "response"
      result[key] =
        inside && PIECE_LIST.has(key) && Array.isArray(child) ? child.map(store) : walk(child, inside)
    }
    return result
  }
  const store = (piece: unknown) => {
    const serial = safeJson(piece)
    if (serial.length < PIECE_MIN_CHARS) return walk(piece, true)
    const id = hash(serial)
    // Registrada aqui, e não quando a fila grava: dois turnos podem passar por
    // aqui antes de a fila rodar, e o segundo reescreveria a mesma linha. A
    // peça e o turno que a cita vão no mesmo bloco da fila — ou entram os dois,
    // ou não entra nenhum.
    if (!sess.pieces.has(id)) {
      fresh.set(id, serial)
      sess.pieces.add(id)
    }
    refs += 1
    return { $ref: id }
  }
  return { record: walk(value, false) as Record<string, unknown>, fresh, refs }
}

/**
 * The hash a piece will have in the store, by the same rule `deflate` uses, so
 * a row written now can be joined to bytes written later. Undefined for a piece
 * small enough to stay inline, which is then simply not in the store.
 */
function refOf(piece: unknown) {
  const serial = safeJson(piece)
  return serial.length < PIECE_MIN_CHARS ? undefined : hash(serial)
}

/** The store lines for the pieces this turn is the first to mention. */
function pieceLines(fresh: Map<string, string>) {
  let out = ""
  for (const [id, serial] of fresh) out += `{"h":"${id}","b":${serial}}\n`
  return out
}

function persist(
  run: Run,
  sess: Session,
  turn: number,
  body: Record<string, unknown>,
  index: Record<string, unknown>,
) {
  const { record, fresh, refs } = deflate(body, sess)
  if (refs) record["pieces"] = PIECE_FILE
  run.queue = run.queue
    .then(async () => {
      // The pieces before the turn that names them, always: a reference to a
      // line that is not there yet is a record that cannot be read.
      if (fresh.size) await fs.promises.appendFile(path.join(sess.dir, PIECE_FILE), pieceLines(fresh))
      await fs.promises.writeFile(turnPath(sess, turn), text(record))
      await fs.promises.appendFile(path.join(sess.dir, "turns.jsonl"), JSON.stringify(index) + "\n")
      await fs.promises.writeFile(path.join(sess.dir, "summary.json"), text(summary(sess)))
      await fs.promises.writeFile(path.join(sess.dir, "state.json"), text(checkpoint(sess)))
      await fs.promises.writeFile(run.file, text(runSummary(run)))
    })
    .catch(() => undefined)
}

/**
 * Where a turn is written. The name is the turn number — unless a file of that
 * name is already there, which means two processes are on the same conversation
 * at once, and the one arriving second keeps its copy rather than overwriting
 * the other's. The turn number inside the record is the one that counts.
 */
function turnPath(sess: Session, turn: number) {
  const name = `turn_${String(turn).padStart(3, "0")}`
  let file = path.join(sess.dir, `${name}.json`)
  for (let i = 2; fs.existsSync(file); i++) file = path.join(sess.dir, `${name}-${i}.json`)
  return file
}

/**
 * What the next run needs to continue this folder: the counters in the shape
 * they are kept in memory, so resuming restores them exactly rather than
 * reconstructing them from the rounded, human-facing summary next to it.
 */
function checkpoint(sess: Session) {
  return {
    version: 1,
    session: sess.id,
    started: sess.started,
    updated: Date.now(),
    turns: sess.turns,
    errors: sess.errors,
    incomplete: sess.incomplete,
    reported: sess.reported,
    estimated: sess.estimated,
    by_model: Object.fromEntries(sess.byModel),
    by_agent: Object.fromEntries(sess.byAgent),
    by_session: Object.fromEntries(sess.bySession),
    prompt: sess.prompt,
    resent: sess.resent,
    breaks: sess.breaks,
    members: [...sess.members],
    parents: Object.fromEntries(sess.parents),
    history: Object.fromEntries(sess.history),
    runs: sess.runs,
    by_tool: Object.fromEntries(sess.byTool),
    // Only the recent ids: a `tool_result` names a call from the turn before,
    // never one from a thousand turns ago, and an unbounded map would grow the
    // checkpoint without ever being read.
    tool_names: Object.fromEntries([...sess.toolNames].slice(-TOOL_NAME_LIMIT)),
    requests: Object.fromEntries(sess.requests),
    retries: sess.retries,
    retry_tokens: sess.retryTokens,
    compactions: sess.compactions,
    compaction_overflow: sess.compactionOverflow,
    compaction_dropped_tokens: sess.compactionDropped,
  }
}

// ---------------------------------------------------------------------------
// Totals.
// ---------------------------------------------------------------------------

function tally(
  sess: Session,
  sessionID: string | undefined,
  context: Context | undefined,
  model: string | undefined,
  usage: Usage | undefined,
  tokens: Attributed | undefined,
  reuse: Reuse | undefined,
  prompt: Prompt | undefined,
) {
  if (tokens) {
    sess.prompt.system += tokens.system
    sess.prompt.tools += tokens.tools
    sess.prompt.messages += tokens.messages
    sess.prompt.total += tokens.total
  }
  if (reuse) {
    sess.resent += resent(reuse, tokens)
    if (!reuse.prefix_stable) sess.breaks += 1
  }
  chargeTools(sess, prompt, tokens, reuse)
  if (!usage) return
  // The variant is part of the name, not a detail of it: the same model at two
  // reasoning efforts spends differently and answers differently, so summing the
  // two into one row hides exactly the comparison the row exists to make.
  const name =
    `${context?.providerID ?? "?"}/${model ?? context?.model.id ?? "?"}` +
    ` · ${context?.variant ?? "default"}`
  for (const target of [
    usage.source === "provider" ? sess.reported : sess.estimated,
    into(sess.byModel, name),
    into(sess.byAgent, context?.agent ?? "?"),
    into(sess.bySession, sessionID ?? "?"),
  ])
    accumulate(target, usage)
}

/**
 * Charges this turn's prompt to the tools that filled it.
 *
 * The split that matters is new against resent, and `reuse` has already drawn
 * that line: everything below `stable_messages` is history the model has read
 * before, everything at or above it is what this turn added. So a result is
 * counted as `result_tokens` on the turn it first appears and as
 * `resent_tokens` on every turn after — which is the difference between what a
 * tool cost and what keeping its answer around costs. When the prefix breaks
 * the line moves back, and the messages behind it are charged as new again:
 * that is not a miscount, it is what a broken prefix actually does.
 *
 * The tokens are the row's, scaled by the share of the row its results occupy,
 * so a message mixing prose and a tool result does not hand the prose's tokens
 * to the tool. Like every per-row number here it comes from the proportional
 * split, exact in aggregate and approximate on one line.
 */
function chargeTools(
  sess: Session,
  prompt: Prompt | undefined,
  tokens: Attributed | undefined,
  reuse: Reuse | undefined,
) {
  if (!prompt) return
  const stable = reuse?.stable_messages ?? 0
  prompt.messages.forEach((piece, index) => {
    const fresh = index >= stable
    if (fresh) for (const call of piece.tool_calls ?? []) toolCost(sess, call.name ?? "?").calls += 1
    const results = piece.tool_results ?? []
    if (!results.length) return
    const rowTokens = tokens?.perMessage[index] ?? est(piece.chars)
    const resultChars = results.reduce((total, result) => total + result.chars, 0)
    const share = piece.chars ? Math.min(1, resultChars / piece.chars) : 1
    const split = distribute(
      Math.round(rowTokens * share),
      results.map((result) => result.chars),
    )
    results.forEach((result, at) => {
      const cost = toolCost(sess, result.tool ?? "?")
      if (!fresh) {
        cost.resent_tokens += split[at]
        return
      }
      cost.result_tokens += split[at]
      cost.result_chars += result.chars
      if (result.error) cost.errors += 1
    })
  })
}

function toolCost(sess: Session, name: string) {
  const existing = sess.byTool.get(name)
  if (existing) return existing
  const created: ToolCost = {
    calls: 0,
    result_tokens: 0,
    result_chars: 0,
    resent_tokens: 0,
    errors: 0,
    runs: 0,
    failed: 0,
    ms: 0,
    ms_max: 0,
    output_chars: 0,
  }
  sess.byTool.set(name, created)
  return created
}

function accumulate(target: Bucket, usage: Usage) {
  target.turns += 1
  add(target.usage, usage)
}

function into(map: Map<string, Bucket>, key: string) {
  const existing = map.get(key)
  if (existing) return existing
  const created = bucket()
  map.set(key, created)
  return created
}

function bucket(): Bucket {
  return { turns: 0, usage: zero("provider") }
}

/** What one session's folder is worth, written as its `summary.json`. */
function summary(sess: Session) {
  const reported = sess.reported
  const estimated = sess.estimated
  return {
    session: sess.id === NO_SESSION ? undefined : sess.id,
    // The subagents filed here, when there are any: they are sessions of their
    // own on the wire but part of this one's work.
    sessions_included: sess.members.size > 1 ? [...sess.members] : undefined,
    turns: sess.turns,
    errors: sess.errors,
    // Turns that were sent but whose response never arrived: their tokens are
    // missing from everything below.
    incomplete_turns: sess.incomplete || undefined,
    // The exact bill, and — kept apart so it cannot contaminate it — what the
    // turns the provider stayed silent about are worth at chars / 4.
    tokens: shape(reported),
    estimated_tokens: estimated.turns ? shape(estimated) : undefined,
    coverage: `${reported.turns}/${reported.turns + estimated.turns} turns counted by the provider`,
    // Where the prompt tokens went, summed over the run.
    prompt_tokens_by_part: sess.prompt,
    // Prompt the model saw again because it was an unchanged prefix: cheap when
    // the provider caches it, paid in full when the prefix keeps breaking.
    resent_tokens: sess.resent,
    // Turns whose cacheable prefix changed. Every one of these is a cache miss
    // on the whole history — the first thing to look at when token usage is high.
    prefix_breaks: sess.breaks,
    // Both breakdowns count every turn, estimated ones included.
    by_model: Object.fromEntries([...sess.byModel].map(([name, value]) => [name, shape(value)])),
    by_agent: Object.fromEntries([...sess.byAgent].map(([name, value]) => [name, shape(value)])),
    // What each tool cost: the tokens its answers took up the first time, what
    // carrying them since has cost on top, and — when the execution hooks are
    // in play — the wall clock it spent and how often it failed. The answer to
    // "where is the context going", which is where a long session's money goes.
    by_tool: sess.byTool.size
      ? Object.fromEntries(
          [...sess.byTool]
            .sort((a, b) => b[1].result_tokens + b[1].resent_tokens - (a[1].result_tokens + a[1].resent_tokens))
            .map(([name, cost]) => [name, { ...cost, ms_avg: cost.runs ? Math.round(cost.ms / cost.runs) : undefined }]),
        )
      : undefined,
    // Turns that resent a prompt the provider had already rejected. Pure waste:
    // every token here was paid for twice or more.
    retry_turns: sess.retries || undefined,
    retry_tokens: sess.retryTokens || undefined,
    // What compaction did, when it ran. `overflow` counts the ones forced by a
    // context that had already filled, as opposed to the elective ones.
    compactions: sess.compactions || undefined,
    compaction_overflow: sess.compactionOverflow || undefined,
    compaction_dropped_tokens: sess.compactionDropped || undefined,
    // Per conversation filed here: the root, and a row for each subagent it
    // spawned — what the `task` tool actually used, without leaving the folder.
    by_session:
      sess.bySession.size > 1
        ? Object.fromEntries([...sess.bySession].map(([name, value]) => [name, shape(value)]))
        : undefined,
    // Who spawned whom, for a reader putting the rows above in order.
    session_parents: sess.parents.size ? Object.fromEntries(sess.parents) : undefined,
    // The conversation's own clock: first turn to last, which for a session
    // that was resumed spans the time it sat idle in between.
    elapsed_seconds: (Date.now() - sess.started) / 1000,
    started_at: new Date(sess.started).toISOString(),
    updated_at: new Date().toISOString(),
    // The runs that wrote here. More than one means the session was resumed,
    // and that everything above is the total over all of them.
    runs: sess.runs.length > 1 ? sess.runs : undefined,
    path: sess.dir,
  }
}

/**
 * The process, as an index over the folders it opened. Everything worth
 * counting is counted per session; this only says which sessions there were.
 */
function runSummary(run: Run) {
  return {
    started_at: new Date(run.started).toISOString(),
    pid: process.pid,
    cwd: process.cwd(),
    // Which opencode wrote this, and with what configuration. Two folders are
    // only comparable when these match — otherwise the difference between them
    // may be the point rather than the noise.
    opencode_version: run.version,
    config_hash: run.configHash,
    plugin_version: PLUGIN_VERSION,
    requests: run.requests,
    // One folder per session — that is the unit a reader groups by. The counts
    // are the folder's, not this run's: a resumed session brings its history
    // with it, and splitting the two would only invite adding them together.
    sessions: Object.fromEntries(
      folders(run).map((sess) => [
        path.basename(sess.dir),
        {
          session: sess.id === NO_SESSION ? undefined : sess.id,
          resumed: sess.runs.length > 1 || undefined,
          turns: sess.turns,
          errors: sess.errors,
          tokens: shape(sess.reported),
        },
      ]),
    ),
    elapsed_seconds: (Date.now() - run.started) / 1000,
    dir: run.base,
    path: run.file,
  }
}

function shape(value: Bucket) {
  const usage = value.usage
  return {
    turns: value.turns,
    input: usage.input,
    cache_read: usage.cache_read ?? 0,
    cache_write: usage.cache_write ?? 0,
    prompt: usage.prompt,
    output: usage.output,
    reasoning: usage.reasoning ?? 0,
    total: usage.total,
    cache_hit_rate: hitRate(usage),
    details: usage.details && Object.keys(usage.details).length ? usage.details : undefined,
  }
}

// ---------------------------------------------------------------------------
// Usage: the token bill, normalized across the dialects.
// ---------------------------------------------------------------------------

/**
 * Pulls the token counts out of a response payload.
 *
 * Providers report usage under `usage` / `usageMetadata` / `meta.billed_units`,
 * at the top level for a single JSON response and spread across frames while
 * streaming (Anthropic sends the input counts in `message_start` and the final
 * output count in `message_delta`). The raw counters are merged first, keeping
 * the largest value seen for each, and normalized once at the end — normalizing
 * each frame on its own would misread a frame that carries a prompt total
 * before the cached-token detail that belongs with it.
 */
function usageOf(payload: unknown): Usage | undefined {
  const merged: Record<string, unknown> = {}
  let found = false
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || typeof value !== "object") return
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1))
    for (const [key, item] of Object.entries(value)) {
      if (USAGE_KEY.test(key) && isRecord(item)) {
        merge(merged, item)
        found = true
        continue
      }
      visit(item, depth + 1)
    }
  }
  visit(payload, 0)
  if (!found) return undefined
  return normalize(merged)
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value)) target[key] = Math.max(num(target[key]), value)
    else if (isRecord(value)) {
      const nested = record(target[key]) ?? {}
      merge(nested, value)
      target[key] = nested
    }
  }
}

/**
 * One shape out of every dialect.
 *
 * The prompt counters are the subtle part. Anthropic reports `input_tokens`
 * already net of the cache, and names the cached tokens separately. The OpenAI
 * dialects and Google fold the cached tokens into the prompt total and say so
 * in a details object — so the cached part is subtracted back out, which is
 * also why the absence of that details object is what distinguishes the two
 * conventions. Bedrock uses the same counters under camelCase names.
 *
 * The output counter is the other one. Anthropic and OpenAI already count
 * thinking inside the completion tokens; Gemini reports `thoughtsTokenCount`
 * on the side and bills it on top of the candidates, so it is added there.
 */
function normalize(value: Record<string, unknown>): Usage | undefined {
  const inputDetails = record(value["input_tokens_details"]) ?? record(value["prompt_tokens_details"]) ?? {}
  const outputDetails = record(value["output_tokens_details"]) ?? record(value["completion_tokens_details"]) ?? {}
  const creation = record(value["cache_creation"]) ?? {}

  // The cache counters the prompt total already contains. Read is named three
  // ways (`cached_tokens` nested, the same name at the top level on Moonshot,
  // `cachedContentTokenCount` on Google) and never twice at once, so the two
  // spellings of the same number are taken as alternatives rather than summed.
  // Write only shows up nested, on the dialects that fold it into the prompt.
  const cachedRead =
    Math.max(num(inputDetails["cached_tokens"]), num(value["cached_tokens"])) +
    num(value["cachedContentTokenCount"])
  const cachedWrite = num(inputDetails["cache_write_tokens"]) + num(inputDetails["cache_creation_input_tokens"])
  const inclusive = cachedRead + cachedWrite
  const prompt =
    num(value["input_tokens"]) +
    num(value["inputTokens"]) +
    num(value["prompt_tokens"]) +
    num(value["promptTokenCount"])
  const write5m = num(creation["ephemeral_5m_input_tokens"])
  const write1h = num(creation["ephemeral_1h_input_tokens"])
  const thoughts = num(value["thoughtsTokenCount"])

  // Whether this dialect counts cache and thinking at all. A counter it never
  // reports is left out of the record rather than written as zero.
  const counts = (...items: unknown[]) => items.some((item) => typeof item === "number")
  const cached = counts(
    inputDetails["cached_tokens"],
    value["cached_tokens"],
    value["cachedContentTokenCount"],
    value["cache_read_input_tokens"],
    value["cacheReadInputTokens"],
    value["cache_creation_input_tokens"],
    value["cacheWriteInputTokens"],
    inputDetails["cache_write_tokens"],
    inputDetails["cache_creation_input_tokens"],
    creation["ephemeral_5m_input_tokens"],
    creation["ephemeral_1h_input_tokens"],
  )
  const thinks = counts(outputDetails["reasoning_tokens"], value["reasoning_tokens"], value["thoughtsTokenCount"])
  const cacheRead = cachedRead + num(value["cache_read_input_tokens"]) + num(value["cacheReadInputTokens"])
  // The same number under three conventions — the top-level counter, the TTL
  // split beside it, and the nested one already inside the prompt total — so the
  // largest, not the sum. Adding them would bill one write twice.
  const cacheWrite = Math.max(
    num(value["cache_creation_input_tokens"]) + num(value["cacheWriteInputTokens"]),
    write5m + write1h,
    cachedWrite,
  )

  const usage: Usage = {
    // Gemini bills the prompt its built-in tools generate on top of the prompt.
    input: Math.max(0, prompt - inclusive) + num(value["toolUsePromptTokenCount"]),
    ...(cached ? { cache_read: cacheRead, cache_write: cacheWrite } : {}),
    output:
      num(value["output_tokens"]) +
      num(value["outputTokens"]) +
      num(value["completion_tokens"]) +
      num(value["candidatesTokenCount"]) +
      thoughts,
    ...(thinks ? { reasoning: num(outputDetails["reasoning_tokens"]) + num(value["reasoning_tokens"]) + thoughts } : {}),
    prompt: 0,
    total: 0,
    source: "provider",
  }
  usage.prompt = usage.input + (usage.cache_read ?? 0) + (usage.cache_write ?? 0)
  usage.total = usage.prompt + usage.output
  if (usage.total === 0) return undefined

  const details: Record<string, number> = {}
  const note = (key: string, amount: number) => {
    if (amount) details[key] = amount
  }
  // The cache TTLs are priced differently, so the split has to survive.
  note("cache_write_5m", write5m)
  note("cache_write_1h", write1h)
  note("audio_input", num(inputDetails["audio_tokens"]))
  note("audio_output", num(outputDetails["audio_tokens"]))
  note("accepted_prediction", num(outputDetails["accepted_prediction_tokens"]))
  note("rejected_prediction", num(outputDetails["rejected_prediction_tokens"]))
  for (const [key, amount] of Object.entries(record(value["server_tool_use"]) ?? {})) note(key, num(amount))
  // Kept as reported, so a disagreement with the total above is visible rather
  // than smoothed over — and the disagreement itself is written down, because a
  // counter this dialect reports and we do not read is exactly what it looks
  // like, and nobody finds it by reading the two numbers side by side.
  const reported = num(value["total_tokens"]) + num(value["totalTokens"]) + num(value["totalTokenCount"])
  note("reported_total", reported)
  note("total_mismatch", reported ? reported - usage.total : 0)
  // Gateways that bill in money rather than tokens (OpenRouter) report it here.
  note("provider_cost", num(value["cost"]))
  if (Object.keys(details).length) usage.details = details
  return usage
}

/**
 * The fallback for a turn the provider reported nothing about. The cache
 * counters stay out: nothing was reported, so nothing is known, and a zero here
 * would read as a cache that missed.
 */
function guess(prompt: Prompt | undefined, reply: Reply | undefined): Usage | undefined {
  if (!prompt) return undefined
  const input = est(prompt.totals.chars)
  const output = est(reply?.chars.total ?? 0)
  const reasoning = est(reply?.chars.reasoning ?? 0)
  const usage: Usage = {
    input,
    output,
    ...(reasoning ? { reasoning } : {}),
    prompt: input,
    total: input + output,
    source: "estimated",
  }
  return usage.total ? usage : undefined
}

/**
 * Share of the prompt the provider served from cache rather than reading anew.
 * Undefined when the dialect reports no cache at all — a model without a prompt
 * cache has no hit rate, and showing it 0% would read as one that never hits.
 */
function hitRate(usage: Usage | undefined) {
  if (!usage || !usage.prompt || usage.cache_read === undefined) return undefined
  return round(usage.cache_read / usage.prompt)
}

// The buckets keep every counter, zeros included: a bucket mixes models, so a
// zero there is a sum and not the absence a turn's own record would mean.
function add(target: Usage, value: Usage) {
  target.input += value.input
  target.cache_read = (target.cache_read ?? 0) + (value.cache_read ?? 0)
  target.cache_write = (target.cache_write ?? 0) + (value.cache_write ?? 0)
  target.output += value.output
  target.reasoning = (target.reasoning ?? 0) + (value.reasoning ?? 0)
  target.prompt += value.prompt
  target.total += value.total
  if (!value.details) return
  const details = target.details ?? {}
  for (const [key, amount] of Object.entries(value.details)) {
    if (key === "reported_total" || key === "provider_cost") continue
    details[key] = num(details[key]) + amount
  }
  if (Object.keys(details).length) target.details = details
}

function zero(source: Usage["source"]): Usage {
  return { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, prompt: 0, total: 0, source }
}

// ---------------------------------------------------------------------------
// Attribution: the provider's one prompt number, spread over the parts.
// ---------------------------------------------------------------------------

function attribute(prompt: Prompt | undefined, usage: Usage | undefined): Attributed | undefined {
  if (!prompt) return undefined
  const pieces = [...prompt.system, ...prompt.tools, ...prompt.messages]
  const chars = pieces.map((piece) => piece.chars)
  const billed = usage?.source === "provider" ? usage.prompt : 0
  const measured = billed > 0 && chars.some(Boolean)
  const tokens = distribute(measured ? billed : est(prompt.totals.chars), chars)

  const cut = (from: number, count: number) => tokens.slice(from, from + count)
  const systemTokens = cut(0, prompt.system.length)
  const toolTokens = cut(prompt.system.length, prompt.tools.length)
  const messageTokens = cut(prompt.system.length + prompt.tools.length, prompt.messages.length)
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const total = sum(tokens)

  const rows = (list: Piece[], counts: number[]) =>
    list.map((piece, index) => ({
      ...piece,
      tokens: counts[index],
      // The text lives verbatim in `request.body`; repeating it here would
      // double the size of every record.
      text: undefined,
      stable: undefined,
    }))

  return {
    view: {
      dialect: prompt.dialect,
      settings: prompt.settings,
      tokens: {
        total,
        system: sum(systemTokens),
        tools: sum(toolTokens),
        messages: sum(messageTokens),
        // Exact and split proportionally, or a chars / 4 guess throughout.
        source: measured ? "provider total, distributed by characters" : `characters / ${CHARS_PER_TOKEN}`,
        chars_per_token: total ? round2(prompt.totals.chars / total) : undefined,
      },
      totals: prompt.totals,
      system: rows(prompt.system, systemTokens),
      tools: rows(prompt.tools, toolTokens),
      messages: rows(prompt.messages, messageTokens),
    },
    perSystem: systemTokens,
    perTool: toolTokens,
    perMessage: messageTokens,
    system: sum(systemTokens),
    tools: sum(toolTokens),
    messages: sum(messageTokens),
    total,
    measured,
  }
}

/**
 * Splits `total` across `weights` as whole tokens that still add up to `total`
 * exactly, giving the leftover to the largest remainders.
 */
function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((carry, weight) => carry + weight, 0)
  if (!sum) return weights.map(() => 0)
  const exact = weights.map((weight) => (weight * total) / sum)
  const result = exact.map(Math.floor)
  let left = total - result.reduce((carry, value) => carry + value, 0)
  const order = exact
    .map((value, index) => ({ remainder: value - Math.floor(value), index }))
    .sort((a, b) => b.remainder - a.remainder)
  for (const entry of order) {
    if (left <= 0) break
    result[entry.index] += 1
    left -= 1
  }
  return result
}

/** The prompt without attribution, for the turns where there is no usage at all. */
function view(prompt: Prompt | undefined) {
  if (!prompt) return undefined
  const rows = (list: Piece[]) => list.map((piece) => ({ ...piece, text: undefined, stable: undefined }))
  return {
    dialect: prompt.dialect,
    settings: prompt.settings,
    totals: prompt.totals,
    system: rows(prompt.system),
    tools: rows(prompt.tools),
    messages: rows(prompt.messages),
  }
}

/**
 * The reply with its output tokens attributed. Reasoning is taken from the
 * provider's own count rather than guessed; what is left over is split between
 * the prose and the tool-call arguments by size.
 */
function replyView(reply: Reply | undefined, usage: Usage | undefined) {
  if (!reply) return undefined
  const measured = usage?.source === "provider" && usage.output > 0
  // Providers that count thinking separately (OpenAI, Gemini) hand us the
  // number. Anthropic folds it into `output` without breaking it out, so its
  // share is split by size along with everything else rather than silently
  // landing on the prose.
  const counted = measured ? Math.min(usage.reasoning ?? 0, usage.output) : 0
  const budget = Math.max(0, measured ? usage.output - counted : est(reply.chars.total))
  const [textTokens, reasoningTokens, callTokens] = distribute(budget, [
    reply.chars.text,
    counted ? 0 : reply.chars.reasoning,
    reply.chars.tool_calls,
  ])
  const calls = distribute(
    callTokens,
    reply.tool_calls.map((call) => call.chars),
  )
  return {
    stop_reason: reply.stop_reason,
    tokens: {
      output: counted + budget,
      reasoning: counted + reasoningTokens,
      text: textTokens,
      tool_calls: callTokens,
      source: measured ? "provider" : `characters / ${CHARS_PER_TOKEN}`,
    },
    chars: reply.chars,
    text: reply.text || undefined,
    reasoning: reply.reasoning || undefined,
    tool_calls: reply.tool_calls.map((call, index) => ({ ...call, tokens: calls[index] })),
  }
}

// ---------------------------------------------------------------------------
// Prompt: what the harness sent, decoded out of the provider's dialect.
// ---------------------------------------------------------------------------

function readPrompt(body: unknown, names?: Map<string, string>): Prompt | undefined {
  if (!isRecord(body)) return undefined
  const dialect = dialectOf(body)
  const system = systemPieces(body, dialect)
  const tools = toolPieces(body, dialect)
  const messages = messagePieces(body, dialect, names)

  const sum = (pieces: Piece[]) => pieces.reduce((total, piece) => total + piece.chars, 0)
  const systemChars = sum(system)
  const toolsChars = sum(tools)
  const messagesChars = sum(messages)
  const chars = systemChars + toolsChars + messagesChars
  for (const piece of [...system, ...tools, ...messages]) piece.share = chars ? round(piece.chars / chars) : 0

  return {
    dialect,
    settings: settingsOf(body),
    totals: {
      chars,
      system_chars: systemChars,
      tools_chars: toolsChars,
      messages_chars: messagesChars,
      tool_count: tools.length,
      message_count: messages.length,
    },
    system,
    tools,
    messages,
  }
}

/**
 * Which API dialect the body speaks. Checked by shape rather than by URL: the
 * same provider is reachable through gateways and proxies that rewrite paths,
 * but the body keys are the contract.
 */
function dialectOf(body: Record<string, unknown>) {
  if ("contents" in body) return "gemini"
  if ("toolConfig" in body || "inferenceConfig" in body || "additionalModelRequestFields" in body) return "bedrock"
  if ("input" in body && !("messages" in body)) return "openai-responses"
  if ("messages" in body) {
    if ("anthropic_version" in body || "system" in body) return "anthropic"
    const first = arrayOf(body["tools"])[0]
    if (isRecord(first) && "input_schema" in first) return "anthropic"
    return "openai-chat"
  }
  return "unknown"
}

function systemPieces(body: Record<string, unknown>, dialect: string): Piece[] {
  if (dialect === "gemini") {
    const instruction = record(body["systemInstruction"]) ?? record(body["system_instruction"])
    const parts = arrayOf(instruction?.["parts"])
    return parts.length ? parts.map((part, index) => piece(index, part)) : instruction ? [piece(0, instruction)] : []
  }
  if (dialect === "openai-responses") {
    const instructions = body["instructions"]
    return instructions ? [piece(0, instructions)] : []
  }
  if (dialect === "openai-chat") {
    // OpenAI carries the system prompt as ordinary messages; lifting them out
    // keeps the system/tools/messages split comparable across dialects.
    return arrayOf(body["messages"])
      .filter((message) => isSystemRole(record(message)?.["role"]))
      .map((message, index) => piece(index, record(message)?.["content"] ?? message))
  }
  const system = body["system"]
  if (typeof system === "string") return system ? [piece(0, system)] : []
  return arrayOf(system).map((block, index) => piece(index, block))
}

function toolPieces(body: Record<string, unknown>, dialect: string): Piece[] {
  return toolList(body, dialect).map((tool, index) => {
    const spec = record(tool) ?? {}
    const schema = spec["input_schema"] ?? spec["parameters"] ?? spec["inputSchema"] ?? spec["parametersJsonSchema"]
    const serial = safeStringify(tool)
    return {
      index,
      name: str(spec["name"]) ?? str(spec["type"]),
      chars: serial.length,
      description_chars: sizeOf(spec["description"]),
      schema_chars: sizeOf(schema),
      cache: cacheOf(serial),
      preview: preview(str(spec["description"]) ?? serial),
      text: str(spec["description"]),
      stable: stamped(serial),
    }
  })
}

function toolList(body: Record<string, unknown>, dialect: string): unknown[] {
  if (dialect === "bedrock")
    return arrayOf(record(body["toolConfig"])?.["tools"]).map((tool) => record(tool)?.["toolSpec"] ?? tool)
  const tools = arrayOf(body["tools"])
  if (dialect === "gemini") {
    const declarations: unknown[] = []
    for (const tool of tools) {
      const list = record(tool)?.["functionDeclarations"] ?? record(tool)?.["function_declarations"]
      if (Array.isArray(list)) declarations.push(...list)
      else declarations.push(tool)
    }
    return declarations
  }
  // OpenAI nests the schema under `function`; flatten so every dialect reads
  // the same downstream.
  return tools.map((tool) => (isRecord(tool) && isRecord(tool["function"]) ? tool["function"] : tool))
}

function messagePieces(body: Record<string, unknown>, dialect: string, names?: Map<string, string>): Piece[] {
  const list =
    dialect === "gemini"
      ? arrayOf(body["contents"])
      : dialect === "openai-responses"
        ? arrayOf(body["input"])
        : arrayOf(body["messages"])

  const pieces: Piece[] = []
  for (const message of list) {
    const value = record(message)
    const role = str(value?.["role"]) ?? str(value?.["type"]) ?? "message"
    if (dialect === "openai-chat" && isSystemRole(role)) continue
    // Gemini keeps parts under `parts`; the Responses API has bare items with
    // no content wrapper at all, so fall back to the item itself.
    const content = value ? (value["content"] ?? value["parts"] ?? value) : message
    const serial = safeStringify(message)
    const body = textOf(content)
    const kinds = kindsOf(content)
    const { calls, results } = toolRefsOf(value, content, dialect)
    // The calls of this prompt before its results: within one conversation a
    // call always goes by in an earlier message than the result answering it,
    // so one forward pass names every result. The map outlives the turn because
    // the same result comes back on every turn afterwards, and the call that
    // named it eventually falls off the end of a compacted history.
    if (names) {
      for (const call of calls) if (call.id && call.name) names.set(call.id, call.name)
      for (const result of results) if (!result.tool && result.id) result.tool = names.get(result.id)
    }
    pieces.push({
      index: pieces.length,
      role,
      kinds,
      chars: serial.length,
      binary: kinds.some((kind) => BINARY_KIND.test(kind)) || undefined,
      cache: cacheOf(serial),
      preview: preview(body),
      ref: refOf(message),
      text: body || undefined,
      stable: stamped(serial),
      tool_calls: calls.length ? calls : undefined,
      tool_results: results.length ? results : undefined,
    })
  }
  return pieces
}

function settingsOf(body: Record<string, unknown>) {
  const settings: Record<string, unknown> = {}
  for (const key of SETTING_KEYS) if (key in body) settings[key] = body[key]
  return settings
}

function piece(index: number, value: unknown, extra: Partial<Piece> = {}): Piece {
  const serial = typeof value === "string" ? value : safeStringify(value)
  const body = textOf(value) || (typeof value === "string" ? value : "")
  return {
    index,
    chars: serial.length,
    cache: cacheOf(serial),
    ...extra,
    preview: preview(body || serial),
    text: body || undefined,
    stable: stamped(serial),
  }
}

/**
 * The tool traffic inside one message: what it asked to run, and what came back.
 *
 * `kinds` already says a block is a `tool_result`; what it cannot say is whose.
 * A result names only the id of the call it answers, and the call that carries
 * the name went by in an earlier message — so the id is the join, and the whole
 * point of pulling it out here is that the tokens a result occupies can then be
 * charged to the tool that produced them.
 *
 * Every dialect spells this differently, and Gemini does not spell the id at
 * all: it repeats the function name on both halves instead, which is enough to
 * attribute the cost and not enough to tell two concurrent calls of the same
 * tool apart.
 */
function toolRefsOf(message: Record<string, unknown> | undefined, content: unknown, dialect: string) {
  const calls: NonNullable<Piece["tool_calls"]> = []
  const results: NonNullable<Piece["tool_results"]> = []

  // OpenAI's chat dialect keeps both halves on the message itself rather than
  // in a content block, so it is read off the envelope and not the parts.
  if (dialect === "openai-chat" && message) {
    for (const call of arrayOf(message["tool_calls"])) {
      const value = record(call)
      const fn = record(value?.["function"]) ?? value
      calls.push({ id: str(value?.["id"]), name: str(fn?.["name"]), chars: sizeOf(fn?.["arguments"]) })
    }
    const answered = str(message["tool_call_id"])
    if (answered) results.push({ id: answered, chars: sizeOf(message["content"]) })
  }

  const collect = (part: unknown) => {
    const value = record(part)
    if (!value) return
    switch (str(value["type"])) {
      case "tool_use":
        calls.push({ id: str(value["id"]), name: str(value["name"]), chars: sizeOf(value["input"]) })
        return
      case "tool_result":
        results.push({
          id: str(value["tool_use_id"]),
          chars: sizeOf(value["content"]),
          error: value["is_error"] === true || undefined,
        })
        return
      // The Responses API, whose items are bare rather than wrapped in content.
      case "function_call":
        calls.push({ id: str(value["call_id"]), name: str(value["name"]), chars: sizeOf(value["arguments"]) })
        return
      case "function_call_output":
        results.push({ id: str(value["call_id"]), chars: sizeOf(value["output"]) })
        return
    }
    // Bedrock and Gemini name the block by its key instead of a `type` field.
    const use = record(value["toolUse"])
    if (use) calls.push({ id: str(use["toolUseId"]), name: str(use["name"]), chars: sizeOf(use["input"]) })
    const result = record(value["toolResult"])
    if (result)
      results.push({
        id: str(result["toolUseId"]),
        chars: sizeOf(result["content"]),
        error: result["status"] === "error" || undefined,
      })
    const fnCall = record(value["functionCall"]) ?? record(value["function_call"])
    // Gemini has no call id at all: the name is the only handle, on both halves.
    if (fnCall) calls.push({ name: str(fnCall["name"]), chars: sizeOf(fnCall["args"]) })
    const fnResult = record(value["functionResponse"]) ?? record(value["function_response"])
    if (fnResult) results.push({ tool: str(fnResult["name"]), chars: sizeOf(fnResult["response"]) })
  }

  if (Array.isArray(content)) content.forEach(collect)
  else collect(content)
  return { calls, results }
}

/** The block types inside a message: text, tool_use, tool_result, image, ... */
function kindsOf(content: unknown): string[] {
  if (typeof content === "string") return ["text"]
  const kinds = new Set<string>()
  const collect = (part: unknown) => {
    if (typeof part === "string") {
      kinds.add("text")
      return
    }
    const value = record(part)
    if (!value) return
    const type = str(value["type"])
    if (type) {
      kinds.add(type)
      return
    }
    // Gemini and Bedrock name the block by its key rather than a `type` field.
    for (const key of Object.keys(value)) if (key !== "role") kinds.add(key)
  }
  if (Array.isArray(content)) content.forEach(collect)
  else collect(content)
  return [...kinds]
}

// Keys that hold something a human would read, plus the ones that hold tool
// arguments — those are JSON, but they are part of what the model was sent.
const TEXT_KEYS = ["text", "thinking", "reasoning", "content", "parts", "output", "result", "response", "summary"]
const CODE_KEYS = ["input", "arguments", "args", "functionCall", "functionResponse", "toolUse", "toolResult"]

function textOf(value: unknown, depth = 0): string {
  if (typeof value === "string") return value
  if (depth > 8 || value === null || typeof value !== "object") return ""
  if (Array.isArray(value))
    return value
      .map((item) => textOf(item, depth + 1))
      .filter(Boolean)
      .join("\n")
  const entry = record(value)
  if (!entry) return ""
  const parts: string[] = []
  for (const key of TEXT_KEYS) if (key in entry) parts.push(textOf(entry[key], depth + 1))
  for (const key of CODE_KEYS) if (key in entry) parts.push(safeStringify(entry[key]))
  return parts.filter(Boolean).join("\n")
}

function stamped(serial: string) {
  return hash(serial.replace(CACHE_MARKER, ""))
}

function cacheOf(serial: string) {
  const match = /"cache_control"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(serial)
  if (match) return match[1]
  if (serial.includes('"cachePoint"')) return "point"
  return undefined
}

function isSystemRole(role: unknown) {
  return role === "system" || role === "developer"
}

// ---------------------------------------------------------------------------
// Reuse: how much of this prompt is the previous prompt, byte for byte.
// ---------------------------------------------------------------------------

function track(
  sess: Session,
  turn: number,
  sessionID: string | undefined,
  context: Context | undefined,
  model: string | undefined,
  prompt: Prompt | undefined,
): Reuse | undefined {
  if (!prompt) return undefined
  // The chains live on the session, so two conversations can never be diffed
  // against each other. Within one folder there is still a chain per session id
  // — a subagent files here but is its own conversation — and per model and
  // dialect, so a small model called for titles does not read as a break.
  const key = chainOf(sessionID, context, model, prompt.dialect)
  const next: Fingerprint = {
    turn,
    system: hash(prompt.system.map((piece) => piece.stable).join("\n")),
    tools: hash(prompt.tools.map((piece) => piece.stable).join("\n")),
    messages: prompt.messages.map((piece) => piece.stable ?? ""),
    chars: prompt.messages.map((piece) => piece.chars),
    refs: prompt.messages.map((piece) => piece.ref),
  }
  const previous = sess.history.get(key)
  sess.history.set(key, next)
  if (!previous) return undefined
  const diff = compare(previous, next)
  // Saying the prefix broke at index 12 leaves the reading to be done by hand.
  // Naming the message, and pointing at both versions of it in the store, is
  // the answer to "why did the cache stop hitting" rather than the start of it.
  if (diff.changed_at !== null) {
    const piece = prompt.messages[diff.changed_at]
    diff.changed_piece = {
      index: diff.changed_at,
      role: piece?.role,
      preview: piece?.preview,
      before: previous.refs?.[diff.changed_at],
      after: next.refs[diff.changed_at],
    }
  }
  return diff
}

/**
 * Which chain of turns this one belongs to. One per session, model and dialect:
 * a subagent is its own conversation, and a small model called for a title is
 * not a break in the coding model's history. Both the reuse diff and the retry
 * check key off it, so they must agree on what it is.
 */
function chainOf(
  sessionID: string | undefined,
  context: Context | undefined,
  model: string | undefined,
  dialect: string,
) {
  return [sessionID ?? "?", model ?? context?.model.id ?? "", dialect].join("|")
}

function compare(previous: Fingerprint, next: Fingerprint): Reuse {
  let stable = 0
  while (
    stable < previous.messages.length &&
    stable < next.messages.length &&
    previous.messages[stable] === next.messages[stable]
  )
    stable++
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const systemChanged = previous.system !== next.system
  const toolsChanged = previous.tools !== next.tools
  return {
    previous_turn: previous.turn,
    system_changed: systemChanged,
    tools_changed: toolsChanged,
    stable_messages: stable,
    changed_at: stable < previous.messages.length ? stable : null,
    added_messages: next.messages.length - stable,
    dropped_messages: Math.max(0, previous.messages.length - stable),
    // True when this turn only appended: everything the provider could have
    // cached is still there, unchanged, in the same order.
    prefix_stable: !systemChanged && !toolsChanged && stable >= previous.messages.length,
    identical:
      !systemChanged &&
      !toolsChanged &&
      stable === previous.messages.length &&
      stable === next.messages.length,
    resent_chars: sum(next.chars.slice(0, stable)),
    new_chars: sum(next.chars.slice(stable)),
    dropped_chars: sum(previous.chars.slice(stable)),
  }
}

/** The reuse diff priced in tokens, once the turn's tokens are known. */
function resolveReuse(reuse: Reuse | undefined, tokens: Attributed | undefined) {
  if (!reuse) return undefined
  return {
    ...reuse,
    resent_tokens: resent(reuse, tokens),
    new_tokens: tokens
      ? tokens.perMessage.slice(reuse.stable_messages).reduce((total, value) => total + value, 0)
      : est(reuse.new_chars),
  }
}

function resent(reuse: Reuse, tokens: Attributed | undefined) {
  if (!tokens) return est(reuse.resent_chars)
  return tokens.perMessage.slice(0, reuse.stable_messages).reduce((total, value) => total + value, 0)
}

/**
 * What a rewritten history threw away, priced in tokens.
 *
 * Always an estimate of the discarded side: those messages are gone from this
 * prompt, so their size comes off the previous turn's fingerprint rather than
 * off anything the provider counted. They are charged at the rate this turn's
 * own prompt is being billed at, so the number is in the same currency as the
 * ones printed next to it — and at the flat ratio when there is no turn with
 * real counts to calibrate against.
 */
function droppedTokens(reuse: Reuse | undefined, tokens: Attributed | undefined, prompt: Prompt | undefined) {
  if (!reuse?.dropped_chars) return 0
  const chars = prompt?.totals.messages_chars ?? 0
  const rate = chars && tokens?.messages ? tokens.messages / chars : 1 / CHARS_PER_TOKEN
  return Math.round(reuse.dropped_chars * rate)
}

// ---------------------------------------------------------------------------
// Reply: the model's output, reassembled from the stream.
// ---------------------------------------------------------------------------

function readReply(payload: unknown): Reply | undefined {
  if (payload === undefined || payload === null || typeof payload === "string") return undefined
  const draft: Draft = { text: [], reasoning: [], calls: new Map() }
  if (Array.isArray(payload)) payload.forEach((event) => absorb(draft, event))
  else absorb(draft, payload)

  const text = draft.text.join("")
  const reasoning = draft.reasoning.join("")
  const calls = [...draft.calls.values()].filter((call) => call.name || call.args)
  if (!text && !reasoning && calls.length === 0 && !draft.stop) return undefined
  const callChars = calls.reduce((total, call) => total + call.args.length, 0)
  return {
    text,
    reasoning,
    tool_calls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: json(call.args),
      chars: call.args.length,
    })),
    stop_reason: draft.stop,
    chars: {
      text: text.length,
      reasoning: reasoning.length,
      tool_calls: callChars,
      total: text.length + reasoning.length + callChars,
    },
  }
}

/**
 * Folds one payload into the draft. Handles the streaming frames and the
 * single-shot bodies of every dialect in one place, because they overlap: the
 * same block shapes show up in `content_block_start`, in a non-streaming
 * `content` array, and in a Responses `output` item.
 */
function absorb(draft: Draft, event: unknown) {
  const value = record(event)
  if (!value) return
  const type = str(value["type"]) ?? ""

  // Anthropic streaming.
  if (type === "content_block_start") {
    absorbBlock(draft, key(value["index"]), record(value["content_block"]))
    return
  }
  if (type === "content_block_delta") {
    const delta = record(value["delta"]) ?? {}
    push(draft.text, delta["text"])
    push(draft.reasoning, delta["thinking"])
    if (typeof delta["partial_json"] === "string") call(draft, key(value["index"])).args += delta["partial_json"]
    return
  }
  if (type === "message_start") {
    absorb(draft, value["message"])
    return
  }
  if (type === "message_delta") {
    draft.stop = str(record(value["delta"])?.["stop_reason"]) ?? draft.stop
    return
  }

  // OpenAI Responses streaming. Only the deltas are folded in; the terminal
  // `response.completed` frame repeats the whole output and would double it.
  if (type.startsWith("response.")) {
    if (type.endsWith(".delta") && typeof value["delta"] === "string") {
      const delta = value["delta"]
      if (type.includes("function_call_arguments"))
        call(draft, key(value["output_index"] ?? value["item_id"])).args += delta
      else if (type.includes("reasoning")) draft.reasoning.push(delta)
      else draft.text.push(delta)
      return
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      // Message and reasoning items repeat text that already arrived as deltas;
      // only the function call is worth picking up, for its name.
      const item = record(value["item"])
      if (str(item?.["type"])?.includes("function_call")) absorbBlock(draft, key(value["output_index"]), item)
      return
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const response = record(value["response"])
      draft.stop = str(response?.["status"]) ?? draft.stop
      return
    }
    return
  }

  // OpenAI chat completions, streamed or not.
  const choices = arrayOf(value["choices"])
  if (choices.length) {
    for (const choice of choices) {
      const entry = record(choice)
      if (!entry) continue
      draft.stop = str(entry["finish_reason"]) ?? draft.stop
      const message = record(entry["delta"]) ?? record(entry["message"])
      if (!message) continue
      push(draft.text, message["content"])
      if (Array.isArray(message["content"]))
        for (const part of message["content"]) absorbBlock(draft, "0", record(part))
      push(draft.reasoning, message["reasoning_content"] ?? message["reasoning"])
      arrayOf(message["tool_calls"]).forEach((item, position) => {
        const use = record(item)
        if (!use) return
        const target = call(draft, key(use["id"] ?? use["index"] ?? position))
        const fn = record(use["function"]) ?? use
        target.name = str(fn["name"]) ?? target.name
        target.id = str(use["id"]) ?? target.id
        if (typeof fn["arguments"] === "string") target.args += fn["arguments"]
      })
    }
    return
  }

  // Gemini, streamed or not.
  const candidates = arrayOf(value["candidates"])
  if (candidates.length) {
    for (const candidate of candidates) {
      const entry = record(candidate)
      if (!entry) continue
      draft.stop = str(entry["finishReason"]) ?? draft.stop
      arrayOf(record(entry["content"])?.["parts"]).forEach((part, position) => {
        const item = record(part)
        if (!item) return
        // Gemini marks reasoning by flagging an ordinary text part.
        if (typeof item["text"] === "string")
          push(item["thought"] === true ? draft.reasoning : draft.text, item["text"])
        const fn = record(item["functionCall"]) ?? record(item["function_call"])
        if (fn) {
          const target = call(draft, key(str(fn["name"]) ?? position))
          target.name = str(fn["name"]) ?? target.name
          target.args = safeStringify(fn["args"] ?? fn["arguments"] ?? {})
        }
      })
    }
    return
  }

  // Anthropic non-streaming, and Bedrock Converse.
  if (Array.isArray(value["content"])) {
    value["content"].forEach((block, position) => absorbBlock(draft, key(position), record(block)))
    draft.stop = str(value["stop_reason"]) ?? draft.stop
    return
  }
  if (Array.isArray(value["output"])) {
    value["output"].forEach((item, position) => absorbBlock(draft, key(position), record(item)))
    draft.stop = str(value["status"]) ?? draft.stop
    return
  }
  const output = record(value["output"])
  if (output) {
    absorb(draft, output["message"] ?? output)
    draft.stop = str(value["stopReason"]) ?? draft.stop
  }
}

function absorbBlock(draft: Draft, id: string, block: Record<string, unknown> | undefined) {
  if (!block) return
  const type = str(block["type"]) ?? ""
  if (type === "text" || type === "output_text" || type === "input_text") {
    push(draft.text, block["text"])
    return
  }
  if (type === "thinking" || type === "reasoning" || type === "reasoning_content") {
    push(draft.reasoning, block["thinking"] ?? block["text"])
    for (const item of arrayOf(block["summary"]).concat(arrayOf(block["content"])))
      push(draft.reasoning, record(item)?.["text"])
    return
  }
  if (type === "redacted_thinking") {
    push(draft.reasoning, REDACTED)
    return
  }
  if (type === "tool_use" || type === "server_tool_use" || type === "function_call") {
    // Keyed by position, never by the block's own id: the frames that carry the
    // arguments identify the call by its index in the stream. The id is kept as
    // a field instead — it is what the next turn's `tool_result` points back at,
    // and what the execution record is filed under.
    const target = call(draft, id)
    target.name = str(block["name"]) ?? target.name
    target.id = str(block["id"] ?? block["call_id"] ?? block["toolUseId"]) ?? target.id
    const input = block["input"] ?? block["arguments"]
    // While streaming, the opening frame carries empty arguments and the real
    // ones arrive as deltas, so never overwrite what is already there.
    if (typeof input === "string") {
      if (input && !target.args) target.args = input
    } else if (isRecord(input) && Object.keys(input).length) target.args = safeStringify(input)
    return
  }
  if (type === "message") {
    for (const part of arrayOf(block["content"])) absorbBlock(draft, id, record(part))
    return
  }
  // Bedrock blocks have no `type`; the key is the type.
  if (!type) {
    push(draft.text, block["text"])
    const use = record(block["toolUse"])
    if (use) absorbBlock(draft, id, { type: "tool_use", ...use })
    const reasoning = record(block["reasoningContent"])
    if (reasoning) push(draft.reasoning, textOf(reasoning))
  }
}

function call(draft: Draft, id: string) {
  const existing = draft.calls.get(id)
  if (existing) return existing
  const created: { id?: string; name?: string; args: string } = { args: "" }
  draft.calls.set(id, created)
  return created
}

function push(target: string[], value: unknown) {
  if (typeof value === "string" && value) target.push(value)
}

function key(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "0"
}

function describeRequest(input: unknown, init: { method?: string; headers?: unknown; body?: unknown } | undefined) {
  const raw = rawBody(init?.body)
  return {
    method: (init?.method ?? methodOf(input) ?? "GET").toUpperCase(),
    url: urlOf(input),
    headers: redactHeaders(init?.headers ?? headersOf(input)),
    raw,
    body: typeof raw === "string" ? json(raw) : raw,
  }
}

function describeResponse(type: string, buffer: ArrayBuffer | undefined, raw: boolean): Record<string, unknown> {
  if (!buffer) return {}
  const bytes = buffer.byteLength
  if (type && !TEXT_CONTENT.test(type) && !type.includes("event-stream")) return { bytes, encoding: "binary" }
  const body = new TextDecoder().decode(buffer)
  if (type.includes("event-stream") || body.startsWith("data:") || body.startsWith("event:")) {
    const events = sse(body)
    // `raw` is the same bytes a second time whenever the frames parsed, and a
    // stream is the biggest thing in the record — so it is kept only when it
    // says something they do not: a frame that came back as a string is one the
    // parser could not read. The setting forces it for whoever wants the wire
    // bytes anyway, and doubles the record when they do.
    const lost = !events.length || events.some((event) => typeof event === "string")
    return { bytes, events, ...(lost || raw ? { raw: body } : {}) }
  }
  return { bytes, body: json(body) }
}

function describeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, cause: causeOf(error.cause) }
  return { message: typeof error === "string" ? error : JSON.stringify(error) }
}

// Server-sent events as the providers emit them: one JSON payload per `data:`
// line, terminator frames dropped.
function sse(body: string) {
  const events: unknown[] = []
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
    if (!data || data === "[DONE]") continue
    events.push(json(data))
  }
  return events
}

// Anthropic and the OpenAI dialects name the model in the body; Gemini and
// Bedrock put it in the path.
function modelOf(request: { url: string; body: unknown }) {
  if (isRecord(request.body) && typeof request.body["model"] === "string" && request.body["model"])
    return request.body["model"]
  return /\/models?\/([^:/?]+)/.exec(request.url)?.[1]
}

function rawBody(body: unknown): string | undefined {
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body as Uint8Array)
  return undefined
}

function urlOf(input: unknown) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  if (isRecord(input) && typeof input["url"] === "string") return input["url"]
  return String(input)
}

function methodOf(input: unknown) {
  return isRecord(input) && typeof input["method"] === "string" ? input["method"] : undefined
}

function headersOf(input: unknown) {
  return isRecord(input) ? input["headers"] : undefined
}

/** Um header da requisição, se ele sobreviveu à redação. */
function headerOf(request: { headers: Record<string, string> }, name: string) {
  const value = request.headers[name]
  return value && value !== REDACTED ? value : undefined
}

function pathOf(url: string) {
  return URL.canParse(url) ? new URL(url).pathname : url
}

function hostOf(url: string) {
  return URL.canParse(url) ? new URL(url).host : undefined
}

function redactUrl(value: string) {
  if (!URL.canParse(value)) return value
  const url = new URL(value)
  url.searchParams.forEach((_, key) => {
    if (SENSITIVE_NAME.test(key) || SHORT_QUERY_NAME.test(key)) url.searchParams.set(key, REDACTED)
  })
  return url.toString()
}

function redactHeaders(input: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (input === undefined || input === null) return result
  try {
    new Headers(input as HeadersInit).forEach((value, name) => {
      result[name.toLowerCase()] = SENSITIVE_NAME.test(name) ? REDACTED : value
    })
  } catch {
    return result
  }
  return result
}

function json(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function text(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? String(item) : item), 2) + "\n"
}

function safeStringify(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? String(item) : item)) ?? ""
  } catch {
    return "<unserializable>"
  }
}

/** A piece as it goes into the store: valid JSON for any value, always. */
function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? String(item) : item)) ?? "null"
  } catch {
    return "null"
  }
}

function sizeOf(value: unknown) {
  return typeof value === "string" ? value.length : value === undefined ? 0 : safeStringify(value).length
}

function est(chars: number) {
  return Math.round(chars / CHARS_PER_TOKEN)
}

function preview(value: string) {
  if (!value) return undefined
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS) + "…" : flat
}

function hash(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 16)
}

function stamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("")
}

function causeOf(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return typeof cause === "string" ? cause : undefined
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown) {
  return isRecord(value) ? value : undefined
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function nothing() {
  return undefined
}
