// Wire-level audit log for LLM provider traffic.
//
// Off by default. Set `OPENCODE_LLM_AUDIT=1` (or point `OPENCODE_LLM_AUDIT_DIR`
// at a directory) and every HTTP request opencode sends to a model provider —
// plus the response that comes back — is written to
// `<dir>/<timestamp>-<run>/turn_NNN.json`, with running totals in
// `summary.json`. This answers "what did we actually send to the model?":
// system prompt, message history, tool schemas, and the raw provider events,
// exactly as they crossed the network.
//
// Header credentials and sensitive query params are redacted; bodies are
// stored verbatim, so treat the directory as sensitive.
//
// Recording never blocks or fails the request: bodies are captured from a
// clone of the response, files are written on a background queue, and every
// failure inside this module is swallowed.
import fs from "fs"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"

const REDACTED = "<redacted>"
const SENSITIVE_NAME =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|cookie|signature/i
const SHORT_QUERY_NAME = /^(key|sig)$/i
const TEXT_CONTENT = /^(text\/|application\/(json|x-ndjson|jsonl|.*\+json))/i

export type Cost = {
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number; readonly write: number }
}

export type Usage = {
  input: number
  output: number
  cache_read: number
  cache_write: number
  reasoning: number
  total: number
}

export type Recorder = {
  /** Records the response and returns it untouched. */
  readonly response: (response: Response) => Response
  /** Records a transport failure (no response ever arrived). */
  readonly failure: (error: unknown) => void
}

export type BeginInput = {
  readonly input: unknown
  readonly init?: { method?: string; headers?: unknown; body?: unknown } | undefined
  readonly providerID?: string | undefined
  /** Looks up per-million-token pricing for the model named in the request body. */
  readonly cost?: ((modelID: string) => Cost | undefined) | undefined
}

type Run = {
  readonly dir: string
  readonly started: number
  turns: number
  errors: number
  cost: number
  usage: Usage
}

let run: Run | false | undefined
let queue: Promise<void> = Promise.resolve()

export function enabled() {
  const flag = process.env["OPENCODE_LLM_AUDIT"]
  if (flag !== undefined) return flag !== "" && flag !== "0" && flag.toLowerCase() !== "false"
  return Boolean(process.env["OPENCODE_LLM_AUDIT_DIR"])
}

/** Directory the current process writes to, or undefined when auditing is off. */
export function directory() {
  return current()?.dir
}

/** Test seam: forget the current run so the next request opens a fresh directory. */
export function reset() {
  run = undefined
}

export function begin(input: BeginInput): Recorder | undefined {
  const state = current()
  if (!state) return undefined

  const turn = state.turns + 1
  state.turns = turn
  const started = Date.now()
  const request = describeRequest(input)
  const modelID = modelOf(request.url, request.body)
  const cost = modelID ? input.cost?.(modelID) : undefined
  let done = false

  const finish = (extra: Record<string, unknown>, usage: Usage | undefined) => {
    if (done) return
    done = true
    const estimated = usage && cost ? estimate(usage, cost) : undefined
    if (usage) merge(state.usage, usage)
    if (estimated !== undefined) state.cost += estimated
    persist(state, turn, {
      turn,
      provider: input.providerID,
      model: modelID,
      session: request.headers["x-session-id"] ?? request.headers["x-opencode-session"],
      started_at: new Date(started).toISOString(),
      elapsed_seconds: (Date.now() - started) / 1000,
      request,
      ...extra,
      usage,
      estimated_cost_usd: estimated === undefined ? undefined : round(estimated),
    })
  }

  return {
    response(response) {
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
        const body = describeResponse(type, value)
        finish({ response: { status, headers, ...body } }, usageOf(body["events"] ?? body["body"]))
      }, nothing)
      return response
    },
    failure(error) {
      state.errors += 1
      finish({ error: describeError(error) }, undefined)
    },
  }
}

function current(): Run | undefined {
  if (run !== undefined) return run || undefined
  if (!enabled()) {
    run = false
    return undefined
  }
  const base = process.env["OPENCODE_LLM_AUDIT_DIR"] || path.join(Global.Path.log, "llm-audit")
  const dir = path.join(base, `${stamp(new Date())}-${runID}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(base, "latest.json"),
      text({ time: new Date().toISOString(), pid: process.pid, cwd: process.cwd(), path: dir }) + "\n",
    )
  } catch {
    run = false
    return undefined
  }
  run = { dir, started: Date.now(), turns: 0, errors: 0, cost: 0, usage: empty() }
  return run
}

function persist(state: Run, turn: number, record: Record<string, unknown>) {
  queue = queue
    .then(async () => {
      await fs.promises.writeFile(path.join(state.dir, `turn_${String(turn).padStart(3, "0")}.json`), text(record))
      await fs.promises.writeFile(path.join(state.dir, "summary.json"), text(summary(state)))
    })
    .catch(nothing)
}

function summary(state: Run) {
  return {
    turns: state.turns,
    errors: state.errors,
    input_tokens: state.usage.input,
    output_tokens: state.usage.output,
    cache_read_tokens: state.usage.cache_read,
    cache_write_tokens: state.usage.cache_write,
    reasoning_tokens: state.usage.reasoning,
    total_tokens: state.usage.total,
    elapsed_seconds: (Date.now() - state.started) / 1000,
    estimated_cost_usd: round(state.cost),
    path: state.dir,
  }
}

function describeRequest(input: BeginInput) {
  const url = urlOf(input.input)
  const headers = redactHeaders(input.init?.headers)
  return {
    method: (input.init?.method ?? methodOf(input.input) ?? "POST").toUpperCase(),
    url: redactUrl(url),
    headers,
    body: bodyOf(input.init?.body),
  }
}

function describeResponse(type: string, buffer: ArrayBuffer | undefined): Record<string, unknown> {
  if (!buffer) return {}
  const bytes = buffer.byteLength
  if (type && !TEXT_CONTENT.test(type) && !type.includes("event-stream")) return { bytes, encoding: "binary" }
  const body = new TextDecoder().decode(buffer)
  const raw = process.env["OPENCODE_LLM_AUDIT_RAW"] === "1" ? { raw: body } : {}
  if (type.includes("event-stream") || body.startsWith("data:") || body.startsWith("event:"))
    return { bytes, events: sse(body), ...raw }
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

function causeOf(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return typeof cause === "string" ? cause : undefined
}

function json(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
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

function methodOf(input: unknown) {
  return isRecord(input) && typeof input["method"] === "string" ? input["method"] : undefined
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
    new Headers(input as ConstructorParameters<typeof Headers>[0]).forEach((value, name) => {
      result[name.toLowerCase()] = SENSITIVE_NAME.test(name) ? REDACTED : value
    })
  } catch {
    return result
  }
  return result
}

// Anthropic and OpenAI name the model in the body; Gemini puts it in the path.
function modelOf(url: string, body: unknown) {
  if (isRecord(body) && typeof body["model"] === "string" && body["model"]) return body["model"]
  return /\/models\/([^:/?]+)/.exec(url)?.[1]
}

function empty(): Usage {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 }
}

function merge(target: Usage, value: Usage) {
  target.input += value.input
  target.output += value.output
  target.cache_read += value.cache_read
  target.cache_write += value.cache_write
  target.reasoning += value.reasoning
  target.total += value.total
}

/**
 * Pulls token counts out of a response payload. Providers report usage under
 * `usage` / `usageMetadata`, at the top level for a single JSON response and
 * spread across several frames while streaming (Anthropic sends input counts
 * in `message_start` and the final output count in `message_delta`), so we
 * walk the whole payload and keep the largest value seen for each counter.
 */
export function usageOf(payload: unknown): Usage | undefined {
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
// while OpenAI and Google fold cache reads into the prompt count, so those get
// subtracted back out.
function normalize(value: Record<string, unknown>): Usage | undefined {
  const inputDetails = record(value["input_tokens_details"]) ?? record(value["prompt_tokens_details"]) ?? {}
  const outputDetails = record(value["output_tokens_details"]) ?? record(value["completion_tokens_details"]) ?? {}

  const inclusive = num(inputDetails["cached_tokens"]) + num(value["cachedContentTokenCount"])
  const exclusive = num(value["cache_read_input_tokens"])
  const prompt = num(value["input_tokens"]) + num(value["prompt_tokens"]) + num(value["promptTokenCount"])
  const output = num(value["output_tokens"]) + num(value["completion_tokens"]) + num(value["candidatesTokenCount"])
  const usage: Usage = {
    input: Math.max(0, prompt - inclusive),
    output,
    cache_read: inclusive + exclusive,
    cache_write: num(value["cache_creation_input_tokens"]),
    reasoning: num(outputDetails["reasoning_tokens"]) + num(value["thoughtsTokenCount"]),
    total: 0,
  }
  if (usage.input + usage.output + usage.cache_read + usage.cache_write + usage.reasoning === 0) return undefined
  return usage
}

function estimate(usage: Usage, cost: Cost) {
  return (
    (usage.input * cost.input +
      usage.output * cost.output +
      usage.cache_read * cost.cache.read +
      usage.cache_write * cost.cache.write) /
    1_000_000
  )
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
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

function text(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? String(item) : item), 2) + "\n"
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

export * as LLMAudit from "./llm-audit"
