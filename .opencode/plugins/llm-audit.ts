// Wire-level audit log for LLM provider traffic.
//
// Answers "what did opencode actually send to the model?" — the full system
// prompt, the message history, the tool schemas — and what the provider
// streamed back. Self-contained: drop this one file in `.opencode/plugins/`
// (project) or `~/.config/opencode/plugins/` (global) of a stock opencode
// install and it works. No fork, no dependencies.
//
// Enable with `OPENCODE_LLM_AUDIT=1` (or point `OPENCODE_LLM_AUDIT_DIR` at a
// directory), or from config:
//
//   { "plugin": [["./llm-audit.ts", { "dir": "/tmp/audit", "raw": true }]] }
//
// Every model request lands in `<dir>/<timestamp>-<pid>/turn_NNN.json` with the
// request (method, URL, headers, body), the response (status, headers, parsed
// JSON or SSE events), token usage, and an estimated cost. Running totals go to
// `summary.json`, `run.json` records how the run was configured, and
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
// `chat.params` supplies what the wire does not carry — session, agent, and the
// model's catalog pricing for the cost estimate.
//
// Credentials in headers and query params are redacted; bodies are stored
// verbatim, so treat the directory as sensitive.
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
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

type FetchLike = typeof globalThis.fetch

// Only the parts of the model this file uses. Declared locally because
// `@opencode-ai/plugin` does not export the model type, and the value we get
// from `chat.params` is structurally wider than this.
type ModelInfo = {
  id: string
  providerID: string
  cost: { input: number; output: number; cache: { read: number; write: number } }
}

type Usage = {
  input: number
  output: number
  cache_read: number
  cache_write: number
  reasoning: number
  total: number
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
}

type Run = {
  dir: string
  started: number
  turns: number
  errors: number
  cost: number
  usage: Usage
  queue: Promise<void>
}

// opencode can create more than one plugin instance per process; they all share
// one run directory, one turn counter, and one set of session contexts.
type State = {
  settings: Settings
  contexts: Map<string, Context>
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
      }
      state.contexts.set(context.model.id, context)
      state.recent = context
    },
  }
}

function shared(settings: Settings): State {
  const global = globalThis as Record<string, unknown>
  const existing = global["__opencodeLLMAuditState"] as State | undefined
  if (existing) return existing
  const state: State = { settings, contexts: new Map() }
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
  const run = session(state)
  if (run) describeRun(run, state.settings)
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
  const run = session(state)
  if (!run) return send()

  const started = Date.now()
  const turn = ++run.turns
  const model = modelOf(request)
  const context = (model ? state.contexts.get(model) : undefined) ?? state.recent
  const write = (extra: Record<string, unknown>, usage: Usage | undefined) => {
    const cost = usage && context ? estimate(usage, context.model.cost) : undefined
    if (usage) add(run.usage, usage)
    if (cost !== undefined) run.cost += cost
    persist(run, turn, {
      turn,
      provider: context?.providerID ?? hostOf(request.url),
      model: model ?? context?.model.id,
      session: context?.sessionID,
      agent: context?.agent,
      started_at: new Date(started).toISOString(),
      elapsed_seconds: (Date.now() - started) / 1000,
      request: { method: request.method, url: redactUrl(request.url), headers: request.headers, body: request.body },
      ...extra,
      usage,
      estimated_cost_usd: cost === undefined ? undefined : round(cost),
    })
  }

  try {
    const response = await send()
    let buffer: Promise<ArrayBuffer | undefined>
    try {
      buffer = response.clone().arrayBuffer().catch(nothing)
    } catch {
      buffer = Promise.resolve(undefined)
    }
    const status = response.status
    const headers = redactHeaders(response.headers)
    const type = response.headers.get("content-type") ?? ""
    void buffer.then((value) => {
      const body = describeResponse(type, value, state.settings.raw)
      write({ response: { status, headers, ...body } }, usageOf(body["events"] ?? body["body"]))
    }, nothing)
    return response
  } catch (error) {
    run.errors += 1
    write({ error: describeError(error) }, undefined)
    throw error
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

/** The run directory, opened once per process. */
function session(state: State): Run | undefined {
  if (state.run !== undefined) return state.run || undefined
  const run = open(state.settings.dir)
  state.run = run ?? false
  return run
}

function open(base: string): Run | undefined {
  const dir = path.join(base, `${stamp(new Date())}-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(base, "latest.json"),
      text({ time: new Date().toISOString(), pid: process.pid, cwd: process.cwd(), path: dir }),
    )
  } catch {
    return undefined
  }
  return { dir, started: Date.now(), turns: 0, errors: 0, cost: 0, usage: empty(), queue: Promise.resolve() }
}

// Written when the audit arms itself, so a run that records nothing still shows
// that the plugin loaded and where it was pointed.
function describeRun(run: Run, settings: Settings) {
  run.queue = run.queue
    .then(() =>
      fs.promises.writeFile(
        path.join(run.dir, "run.json"),
        text({
          time: new Date().toISOString(),
          pid: process.pid,
          cwd: process.cwd(),
          records: "every model request this process sends",
          raw: settings.raw,
        }),
      ),
    )
    .catch(() => undefined)
}

function persist(run: Run, turn: number, body: Record<string, unknown>) {
  run.queue = run.queue
    .then(async () => {
      await fs.promises.writeFile(path.join(run.dir, `turn_${String(turn).padStart(3, "0")}.json`), text(body))
      await fs.promises.writeFile(path.join(run.dir, "summary.json"), text(summary(run)))
    })
    .catch(() => undefined)
}

function summary(run: Run) {
  return {
    turns: run.turns,
    errors: run.errors,
    input_tokens: run.usage.input,
    output_tokens: run.usage.output,
    cache_read_tokens: run.usage.cache_read,
    cache_write_tokens: run.usage.cache_write,
    reasoning_tokens: run.usage.reasoning,
    total_tokens: run.usage.total,
    elapsed_seconds: (Date.now() - run.started) / 1000,
    estimated_cost_usd: round(run.cost),
    path: run.dir,
  }
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
  if (type.includes("event-stream") || body.startsWith("data:") || body.startsWith("event:"))
    return { bytes, events: sse(body), ...(raw ? { raw: body } : {}) }
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

/**
 * Pulls token counts out of a response payload. Providers report usage under
 * `usage` / `usageMetadata`, at the top level for a single JSON response and
 * spread across frames while streaming (Anthropic sends input counts in
 * `message_start` and the final output count in `message_delta`), so walk the
 * payload and keep the largest value seen for each counter.
 */
function usageOf(payload: unknown): Usage | undefined {
  const result = empty()
  let found = false
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || typeof value !== "object") return
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1))
    for (const [key, item] of Object.entries(value)) {
      if ((key === "usage" || key === "usageMetadata") && isRecord(item)) {
        const usage = normalize(item)
        if (usage) {
          found = true
          result.input = Math.max(result.input, usage.input)
          result.output = Math.max(result.output, usage.output)
          result.cache_read = Math.max(result.cache_read, usage.cache_read)
          result.cache_write = Math.max(result.cache_write, usage.cache_write)
          result.reasoning = Math.max(result.reasoning, usage.reasoning)
        }
        continue
      }
      visit(item, depth + 1)
    }
  }
  visit(payload, 0)
  if (!found) return undefined
  result.total = result.input + result.output + result.cache_read + result.cache_write
  return result
}

// Normalizes the provider dialects onto one shape. `input` is always non-cached
// input tokens: Anthropic reports `input_tokens` that way already, while OpenAI
// and Google fold cache reads into the prompt count.
function normalize(value: Record<string, unknown>): Usage | undefined {
  const inputDetails = record(value["input_tokens_details"]) ?? record(value["prompt_tokens_details"]) ?? {}
  const outputDetails = record(value["output_tokens_details"]) ?? record(value["completion_tokens_details"]) ?? {}

  const inclusive = num(inputDetails["cached_tokens"]) + num(value["cachedContentTokenCount"])
  const prompt = num(value["input_tokens"]) + num(value["prompt_tokens"]) + num(value["promptTokenCount"])
  const usage: Usage = {
    input: Math.max(0, prompt - inclusive),
    output: num(value["output_tokens"]) + num(value["completion_tokens"]) + num(value["candidatesTokenCount"]),
    cache_read: inclusive + num(value["cache_read_input_tokens"]),
    cache_write: num(value["cache_creation_input_tokens"]),
    reasoning: num(outputDetails["reasoning_tokens"]) + num(value["thoughtsTokenCount"]),
    total: 0,
  }
  if (usage.input + usage.output + usage.cache_read + usage.cache_write + usage.reasoning === 0) return undefined
  return usage
}

function estimate(usage: Usage, cost: ModelInfo["cost"]) {
  return (
    (usage.input * cost.input +
      usage.output * cost.output +
      usage.cache_read * cost.cache.read +
      usage.cache_write * cost.cache.write) /
    1_000_000
  )
}

function add(target: Usage, value: Usage) {
  target.input += value.input
  target.output += value.output
  target.cache_read += value.cache_read
  target.cache_write += value.cache_write
  target.reasoning += value.reasoning
  target.total += value.total
}

function empty(): Usage {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 }
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

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown) {
  return isRecord(value) ? value : undefined
}

function nothing() {
  return undefined
}
