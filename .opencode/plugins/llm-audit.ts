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
//   { "plugin": [["./llm-audit.ts", { "dir": "/tmp/audit", "raw": true,
//                                     "providers": ["anthropic"] }]] }
//
// Every provider request lands in `<dir>/<timestamp>-plugin-<id>/turn_NNN.json`
// with the request (method, URL, headers, body), the response (status, headers,
// parsed JSON or SSE events), token usage, and an estimated cost. Running
// totals go to `summary.json`, and `latest.json` one level up points at the
// current run.
//
// How it hooks in: the `config` hook runs before opencode reads `cfg.provider`,
// so it can install a `fetch` on each provider's options. opencode calls that
// fetch with the request fully assembled, which is why the recorded bytes are
// exactly what crossed the network.
//
// Which providers get recorded: every one declared under `provider` in your
// config, plus every one with credentials from `opencode auth login`. Setting
// `providers` (or OPENCODE_LLM_AUDIT_PROVIDERS) replaces the auth-store half
// with your own list. Each run writes `providers.json` naming what it covers,
// so a run that records nothing still shows why.
//
// Known coverage limits, all inherent to the plugin seam:
//   - `google-vertex` on `@ai-sdk/google-vertex` drops `options.fetch`, so
//     those calls cannot be seen from here.
//   - The experimental native runtime (OPENCODE_EXPERIMENTAL_NATIVE_LLM) does
//     not go through provider fetch at all.
//   - GitLab Duo workflow models talk WebSocket, not HTTP.
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

type FetchLike = (input: any, init?: any) => Promise<Response>

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
  providers: string[]
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

export const LLMAuditPlugin: Plugin = async (_input, options) => {
  const settings = resolve(options)
  if (!settings.enabled) return {}

  // `chat.params` fires just before the request with the pieces the wire does
  // not carry: which agent asked, and the model's catalog pricing. Keyed by
  // provider + model so parallel sessions land on the right entry, with the
  // most recent one as fallback for requests we cannot key (title generation
  // reuses the small model).
  const contexts = new Map<string, Context>()
  let recent: Context | undefined
  const decorated = new WeakSet<object>()

  const audited =
    (providerID: string, upstream: FetchLike | undefined): FetchLike =>
    async (input, init) => {
      const run = session(settings.dir)
      if (!run) return (upstream ?? fetch)(input, init)
      const started = Date.now()
      const turn = ++run.turns
      const request = describeRequest(input, init)
      const body = record(request.body)
      const model = typeof body?.["model"] === "string" ? body["model"] : undefined
      const context = contexts.get(`${providerID}/${model}`) ?? recent
      const send = (extra: Record<string, unknown>, usage: Usage | undefined) => {
        const cost = usage && context ? estimate(usage, context.model.cost) : undefined
        if (usage) add(run.usage, usage)
        if (cost !== undefined) run.cost += cost
        persist(run, turn, {
          turn,
          provider: providerID,
          model: model ?? context?.model.id,
          session: context?.sessionID,
          agent: context?.agent,
          started_at: new Date(started).toISOString(),
          elapsed_seconds: (Date.now() - started) / 1000,
          request,
          ...extra,
          usage,
          estimated_cost_usd: cost === undefined ? undefined : round(cost),
        })
      }

      try {
        const response = await (upstream ?? fetch)(input, init)
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
          const body = describeResponse(type, value, settings.raw)
          send({ response: { status, headers, ...body } }, usageOf(body["events"] ?? body["body"]))
        }, nothing)
        return response
      } catch (error) {
        run.errors += 1
        send({ error: describeError(error) }, undefined)
        throw error
      }
    }

  return {
    async config(cfg) {
      const providers = ((cfg.provider ??= {}) as Record<string, { options?: Record<string, unknown> }>) ?? {}
      // Config is only half the picture: a provider set up with
      // `opencode auth login` has credentials but no config entry, so take the
      // ids from the auth store too. An explicit `providers` list wins over
      // both, for anything neither source knows about.
      const sources = {
        config: Object.keys(providers),
        auth: settings.providers.length > 0 ? [] : authenticated(),
        option: settings.providers,
      }
      const ids = new Set([...sources.config, ...sources.auth, ...sources.option])
      for (const id of ids) {
        const provider = (providers[id] ??= {})
        const options = (provider.options ??= {})
        if (decorated.has(options)) continue
        decorated.add(options)
        const upstream = typeof options["fetch"] === "function" ? (options["fetch"] as FetchLike) : undefined
        options["fetch"] = audited(id, upstream)
      }
      // Written up front so a run that records nothing still says why: the
      // directory exists, and this file shows which providers are covered.
      const run = session(settings.dir)
      if (run) manifest(run, [...ids], sources)
    },
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
      contexts.set(`${context.providerID}/${context.model.id}`, context)
      recent = context
    },
  }
}

function resolve(options?: PluginOptions): Settings {
  const env = process.env
  const flag = env["OPENCODE_LLM_AUDIT"]
  const dir = (options?.["dir"] as string) ?? env["OPENCODE_LLM_AUDIT_DIR"]
  const providers = options?.["providers"] ?? env["OPENCODE_LLM_AUDIT_PROVIDERS"]?.split(",")
  return {
    enabled:
      (options?.["enabled"] as boolean) ??
      (flag === undefined ? Boolean(dir) : flag !== "" && flag !== "0" && flag.toLowerCase() !== "false"),
    dir:
      dir ??
      path.join(env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share"), "opencode", "log", "llm-audit"),
    raw: (options?.["raw"] as boolean) ?? env["OPENCODE_LLM_AUDIT_RAW"] === "1",
    providers: (Array.isArray(providers) ? providers : []).map((id) => String(id).trim()).filter(Boolean),
  }
}

/**
 * The run every plugin instance in this process shares — opencode may create
 * more than one — opened on the first recorded request so an instance that
 * never talks to a model leaves no empty directory behind.
 */
function session(base: string): Run | undefined {
  const global = globalThis as Record<string, unknown>
  const existing = global["__opencodeLLMAuditPluginRun"] as Run | false | undefined
  if (existing !== undefined) return existing || undefined
  const run = open(base)
  global["__opencodeLLMAuditPluginRun"] = run ?? false
  return run
}

/**
 * Provider ids that have credentials stored by `opencode auth login`. Only the
 * ids are read — never the values — and any failure means "none", since this
 * is a convenience over the explicit `providers` option.
 */
function authenticated(): string[] {
  const base = process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share")
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(base, "opencode", "auth.json"), "utf8"))
    return isRecord(stored) ? Object.keys(stored) : []
  } catch {
    return []
  }
}

function manifest(run: Run, providers: string[], sources: Record<string, string[]>) {
  run.queue = run.queue
    .then(() =>
      fs.promises.writeFile(
        path.join(run.dir, "providers.json"),
        text({ recording: providers.sort(), sources, time: new Date().toISOString() }),
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

function open(base: string): Run | undefined {
  const dir = path.join(base, `${stamp(new Date())}-plugin-${process.pid}`)
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
  return {
    method: (init?.method ?? "POST").toUpperCase(),
    url: redactUrl(urlOf(input)),
    headers: redactHeaders(init?.headers),
    body: bodyOf(init?.body),
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

// Normalizes the three provider dialects onto one shape. `input` is always
// non-cached input tokens: Anthropic reports `input_tokens` that way already,
// while OpenAI and Google fold cache reads into the prompt count.
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

function bodyOf(body: unknown): unknown {
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") return json(body)
  if (body instanceof ArrayBuffer) return json(new TextDecoder().decode(body))
  if (ArrayBuffer.isView(body)) return json(new TextDecoder().decode(body as Uint8Array))
  return { unsupported: body.constructor?.name ?? typeof body }
}

function urlOf(input: unknown) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  if (isRecord(input) && typeof input["url"] === "string") return input["url"]
  return String(input)
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
