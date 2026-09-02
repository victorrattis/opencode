#!/usr/bin/env bun
// Reads what `llm-audit` wrote and emits a digest small enough to think about.
//
// The audit keeps one folder per conversation and, inside it, one JSON per model
// request with the whole prompt embedded — around a megabyte each. A session of
// two hundred turns is two hundred megabytes, so the one thing this must never
// do is hand those files to a model. It aggregates first and prints a few
// kilobytes: where the money went, what broke, what the agent actually did, and
// the prompts that caused it all, with each prompt's own bill attached.
//
// Reads both dialects of the same format: the opencode plugin
// (`.opencode/plugins/llm-audit.ts`) and the Claude Code reader
// (`~/.claude/scripts/llm-audit/report.ts`). Where they differ the difference is
// named in the output rather than smoothed over.
//
//   bun analyze.ts --list                     which conversations there are
//   bun analyze.ts                            the most recent one
//   bun analyze.ts --session <id|folder|all>
//   bun analyze.ts --last 3 --json
//
// Strictly read-only: it never writes inside the audit directory. `--out` writes
// the report somewhere else, and refuses a path under the audit root.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// A turn file holds the conversation verbatim. Enough of it is quoted to
// recognize a prompt or an error; none of it is quoted whole.
const PREVIEW = 300
const PROMPT_MAX = 2000
// Cache breaks come by the hundred and each one costs a megabyte of reading to
// explain, so only a spread of them is opened. The count is exact; the diagnosis
// is a sample, and says so.
const BREAK_SAMPLE = 8
// Text the harness injects into a user message. Everything matching here is the
// client talking to itself, not the person typing.
const INJECTED =
  /^\s*<(system-reminder|command-name|command-message|command-args|local-command-|user-prompt-submit-hook|budget:)/

type Json = Record<string, unknown>

type Cli = {
  dir?: string
  session?: string
  last?: number
  list: boolean
  json: boolean
  out?: string
  top: number
}

type SessionRef = { folder: string; dir: string; summary: Json; mtime: number }

function main() {
  const cli = parseArgs(process.argv.slice(2))
  const root = findRoot(cli.dir)
  if (!root) {
    fail(
      "nenhum diretório de auditoria encontrado. Tente --dir <caminho>, ou defina OPENCODE_LLM_AUDIT_DIR / CLAUDE_LLM_AUDIT_DIR.",
    )
    return
  }
  const sessions = listSessions(root.dir)
  if (!sessions.length) {
    fail(`${root.dir} não tem nenhuma pasta de sessão.`)
    return
  }

  if (cli.list) {
    emit(cli, { dir: root.dir, flavor: root.flavor, sessions: sessions.map(brief) }, () => renderList(root, sessions))
    return
  }

  const chosen = pick(sessions, cli)
  if (!chosen.length) {
    fail(`nenhuma sessão casa com --session ${cli.session}. Rode --list para ver as que existem.`)
    return
  }
  const analyses = chosen.map((ref) => analyze(ref, cli))
  emit(cli, { dir: root.dir, flavor: root.flavor, analyses }, () =>
    analyses.map((one) => render(one, cli)).join("\n\n"),
  )
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { list: false, json: false, top: 10 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === "--dir") cli.dir = next()
    else if (arg === "--session" || arg === "-s") cli.session = next()
    else if (arg === "--last") cli.last = Number(next())
    else if (arg === "--top") cli.top = Number(next())
    else if (arg === "--out") cli.out = next()
    else if (arg === "--list" || arg === "-l") cli.list = true
    else if (arg === "--json") cli.json = true
    else if (arg === "--help" || arg === "-h") {
      console.log(usage())
      process.exit(0)
    } else fail(`opção desconhecida: ${arg}`)
  }
  return cli
}

function usage() {
  return `bun analyze.ts [opções]

  --list, -l            lista as conversas auditadas
  --session, -s <x>     id, nome da pasta, "latest" ou "all"  (default: latest)
  --last <n>            as n conversas mais recentes
  --top <n>             quantas linhas por ranking            (default: 10)
  --json                a mesma estrutura, em JSON
  --out <arquivo>       grava em vez de imprimir (fora do diretório de auditoria)
  --dir <caminho>       o diretório de auditoria`
}

function fail(message: string): never {
  console.error(`analyze: ${message}`)
  process.exit(1)
}

/**
 * Where the audit writes. Each harness has its own default and a machine can
 * easily have both, so every candidate is tried and the first one that actually
 * holds sessions wins — with which one it was kept, because a number from the
 * opencode side and a number from the Claude Code side do not mean quite the
 * same thing.
 */
function findRoot(explicit?: string): { dir: string; flavor: string } | undefined {
  const data = process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share")
  const candidates: { dir: string; flavor: string }[] = []
  if (explicit) candidates.push({ dir: explicit, flavor: "explícito" })
  const fromOpencode = process.env["OPENCODE_LLM_AUDIT_DIR"]
  if (fromOpencode) candidates.push({ dir: fromOpencode, flavor: "opencode" })
  const fromClaude = process.env["CLAUDE_LLM_AUDIT_DIR"]
  if (fromClaude) candidates.push({ dir: fromClaude, flavor: "claude-code" })
  candidates.push({ dir: path.join(data, "opencode", "log", "llm-audit"), flavor: "opencode" })
  candidates.push({ dir: path.join(data, "claude-code", "log", "llm-audit"), flavor: "claude-code" })
  for (const candidate of candidates) if (listSessions(candidate.dir).length) return candidate
  return candidates.find((candidate) => exists(candidate.dir))
}

/** A session folder is one with a `turns.jsonl`. Nothing else in the root is one. */
function listSessions(dir: string): SessionRef[] {
  const found: SessionRef[] = []
  for (const name of entries(dir)) {
    const child = path.join(dir, name)
    const index = path.join(child, "turns.jsonl")
    if (!exists(index)) continue
    found.push({
      folder: name,
      dir: child,
      summary: readJson(path.join(child, "summary.json")) ?? {},
      mtime: stat(index)?.mtimeMs ?? 0,
    })
  }
  return found.sort((a, b) => a.mtime - b.mtime)
}

function pick(sessions: SessionRef[], cli: Cli): SessionRef[] {
  if (cli.session === "all") return sessions
  if (cli.session && cli.session !== "latest") {
    const wanted = cli.session
    return sessions.filter(
      (ref) => ref.folder === wanted || ref.folder.includes(wanted) || str(ref.summary["session"]) === wanted,
    )
  }
  return sessions.slice(-(cli.last ?? 1))
}

function brief(ref: SessionRef) {
  const tokens = record(ref.summary["tokens"])
  return {
    folder: ref.folder,
    session: ref.summary["session"],
    started_at: ref.summary["started_at"],
    turns: ref.summary["turns"],
    errors: ref.summary["errors"],
    cost_usd: ref.summary["cost_usd"] ?? tokens?.["cost_usd"],
    total_tokens: tokens?.["total"],
    cache_hit_rate: tokens?.["cache_hit_rate"],
    path: ref.dir,
  }
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

type Group = {
  key: string
  index: number
  turns: number[]
  started_at?: string
  prompt?: string
  prompt_note?: string
  tokens: number
  prompt_tokens: number
  output_tokens: number
  cost_usd: number
  // Whether any turn of the group reported a price at all. Without it a folder
  // whose catalog had no entry for the model would show every request at
  // $0.0000, which reads as free rather than as unknown.
  costed: boolean
  seconds: number
  tools: Record<string, number>
  stop_reasons: Record<string, number>
  prefix_breaks: number
  tool_errors: { tool: string; message: string }[]
}

// A group always has at least one turn, but saying so in code beats asserting it
// at four call sites.
const opened = (group: Group) => group.turns[0] ?? 0
const closed = (group: Group) => group.turns[group.turns.length - 1] ?? 0

function analyze(ref: SessionRef, cli: Cli) {
  const rows = readJsonl(path.join(ref.dir, "turns.jsonl"))
  const summary = ref.summary
  const groups = groupTurns(rows)

  // The bodies. Two per group: the first turn carries the message the user had
  // just typed, the last carries every tool result the group accumulated. Ten
  // files instead of two hundred, and it survives a compaction — which empties
  // the history the final turn would otherwise have been asked for.
  const wanted = new Set<number>()
  for (const group of groups) {
    wanted.add(opened(group))
    wanted.add(closed(group))
  }
  const bodies = new Map<number, Json | undefined>()
  for (const turn of [...wanted].sort((a, b) => a - b)) bodies.set(turn, loadTurn(ref.dir, turn))

  fillPrompts(groups, bodies)
  const conversation = readConversation(bodies)
  attachToolErrors(groups, conversation)

  return {
    folder: ref.folder,
    session: summary["session"] ?? null,
    path: ref.dir,
    started_at: summary["started_at"] ?? rows[0]?.["time"] ?? null,
    elapsed_seconds: summary["elapsed_seconds"] ?? null,
    totals: totals(summary, rows),
    by_model: summary["by_model"] ?? null,
    by_agent: summary["by_agent"] ?? null,
    by_tool: summary["by_tool"] ?? null,
    requests: groups,
    errors: errorsOf(ref, rows, summary, conversation, cli),
    cache: cacheOf(ref, rows, summary),
    behavior: behaviorOf(rows, groups, conversation, cli),
    prompts: groups.map((group) => ({
      request: group.index,
      turns: group.turns.length,
      cost_usd: group.costed ? round(group.cost_usd, 4) : null,
      tokens: group.tokens,
      tool_errors: group.tool_errors.length,
      text: group.prompt ? clip(group.prompt, PROMPT_MAX) : null,
      note: group.prompt_note ?? null,
    })),
    caveats: caveats(rows, summary),
  }
}

/**
 * Turns grouped into the thing the user recognizes: one request of theirs, and
 * every round trip it took to answer. Claude Code names that boundary
 * `prompt_id`, opencode counts it as `request_index`; a folder with neither
 * degrades to one group per turn rather than to nothing.
 */
function groupTurns(rows: Json[]): Group[] {
  const byKey = new Map<string, Group>()
  const order: Group[] = []
  for (const row of rows) {
    const turn = num(row["turn"]) ?? 0
    const key =
      str(row["prompt_id"]) ?? (row["request_index"] !== undefined ? `req-${row["request_index"]}` : `turn-${turn}`)
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        index: order.length + 1,
        turns: [],
        started_at: str(row["time"]),
        tokens: 0,
        prompt_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        costed: false,
        seconds: 0,
        tools: {},
        stop_reasons: {},
        prefix_breaks: 0,
        tool_errors: [],
      }
      byKey.set(key, group)
      order.push(group)
    }
    group.turns.push(turn)
    group.tokens += num(row["total_tokens"]) ?? 0
    group.prompt_tokens += num(row["prompt_tokens"]) ?? 0
    group.output_tokens += num(row["output_tokens"]) ?? 0
    const cost = num(row["cost_usd"])
    if (cost !== undefined) {
      group.cost_usd += cost
      group.costed = true
    }
    group.seconds += num(row["seconds"]) ?? 0
    if (row["prefix_stable"] === false) group.prefix_breaks += 1
    const stop = str(row["stop_reason"])
    if (stop) group.stop_reasons[stop] = (group.stop_reasons[stop] ?? 0) + 1
    for (const call of list(row["tool_calls"])) {
      const name = str(call)
      if (name) group.tools[name] = (group.tools[name] ?? 0) + 1
    }
  }
  return order
}

/** The turn record, with any piece references resolved against the folder's store. */
function loadTurn(dir: string, turn: number): Json | undefined {
  const file = turnFile(dir, turn)
  if (!file) return undefined
  const found = readJson(file)
  if (!found) return undefined
  const refs = collectRefs(found)
  if (!refs.size) return found
  return inflate(found, readPieces(path.join(dir, "pieces.jsonl"), refs)) as Json
}

function turnFile(dir: string, turn: number) {
  const padded = String(turn).padStart(3, "0")
  const direct = path.join(dir, `turn_${padded}.json`)
  if (exists(direct)) return direct
  // A turn number can repeat across runs, and the plugin suffixes the collision.
  const pattern = new RegExp(`^turn_${padded}(-\\d+)?\\.json$`)
  const match = entries(dir).find((name) => pattern.test(name))
  return match ? path.join(dir, match) : undefined
}

function collectRefs(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into)
    return into
  }
  if (!isRecord(value)) return into
  const ref = str(value["$ref"])
  if (ref && Object.keys(value).length === 1) {
    into.add(ref)
    return into
  }
  for (const child of Object.values(value)) collectRefs(child, into)
  return into
}

function inflate(value: unknown, pieces: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => inflate(item, pieces))
  if (!isRecord(value)) return value
  const ref = str(value["$ref"])
  if (ref && Object.keys(value).length === 1) {
    // A reference that resolves to nothing is a piece store that was pruned or
    // truncated. Say so in place of the message; never throw over it.
    return pieces.has(ref) ? pieces.get(ref) : { $ref: ref, unresolved: true }
  }
  const out: Json = {}
  for (const [key, child] of Object.entries(value)) out[key] = inflate(child, pieces)
  return out
}

/**
 * The pieces this turn asks for, and only those. The store holds every distinct
 * message of the conversation, so most lines are something nobody wants: they
 * are matched with a regex and never parsed.
 */
function readPieces(file: string, wanted: Set<string>): Map<string, unknown> {
  const found = new Map<string, unknown>()
  if (!exists(file) || !wanted.size) return found
  try {
    const text = fs.readFileSync(file, "utf8")
    let from = 0
    while (from < text.length && found.size < wanted.size) {
      const end = text.indexOf("\n", from)
      const line = text.slice(from, end === -1 ? undefined : end)
      from = end === -1 ? text.length : end + 1
      if (!line) continue
      const id = /"h"\s*:\s*"([^"]+)"/.exec(line)?.[1]
      if (!id || !wanted.has(id) || found.has(id)) continue
      const parsed = parse(line)
      if (isRecord(parsed)) found.set(id, parsed["b"])
    }
  } catch {
    // A store that cannot be read leaves the references unresolved, which the
    // record already knows how to say.
  }
  return found
}

// ---------------------------------------------------------------------------
// Reading the conversation out of the bodies
// ---------------------------------------------------------------------------

type Call = { id?: string; tool: string; args: string; turn: number }
type ToolError = { tool: string; message: string; turn: number }
type Conversation = { calls: Call[]; errors: ToolError[] }

/**
 * Every message list in the bodies we opened, read once.
 *
 * Two bodies of the same conversation overlap almost entirely — the history
 * repeats in every prompt — so the same call and the same failure arrive again
 * in each one. They are deduplicated by the id the wire gave them, and the turn
 * kept is the first body they were seen in, which is the earliest moment they
 * are known to have existed. Without this a single failing command is counted
 * once per body and the error section is pure inflation.
 */
function readConversation(bodies: Map<number, Json | undefined>): Conversation {
  const conversation: Conversation = { calls: [], errors: [] }
  const seenCalls = new Set<string>()
  const seenErrors = new Set<string>()
  for (const [turn, body] of [...bodies].sort((a, b) => a[0] - b[0])) {
    const messages = messagesOf(body)
    if (!messages) continue
    const names = new Map<string, string>()
    for (const message of messages) {
      for (const block of blocksOf(message["content"])) {
        const kind = str(block["type"])
        if (kind === "tool_use" || kind === "toolUse") {
          const id = str(block["id"]) ?? str(block["toolUseId"])
          const tool = str(block["name"]) ?? "?"
          if (id) names.set(id, tool)
          const args = stringify(block["input"] ?? block["arguments"])
          const key = id ?? `${tool} ${args}`
          if (seenCalls.has(key)) continue
          seenCalls.add(key)
          conversation.calls.push({ id, tool, args, turn })
        } else if (kind === "tool_result" || kind === "toolResult") {
          if (!truthy(block["is_error"]) && !truthy(block["isError"])) continue
          const id = str(block["tool_use_id"]) ?? str(block["toolUseId"])
          const message = clip(textOf(block["content"]), PREVIEW)
          const tool = (id ? names.get(id) : undefined) ?? "?"
          const key = id ?? `${tool} ${message}`
          if (seenErrors.has(key)) continue
          seenErrors.add(key)
          conversation.errors.push({ tool, message, turn })
        }
      }
    }
  }
  return conversation
}

/**
 * Each group's prompt: the last thing the user typed before its first turn went
 * out, which is the last such message in that turn's history. The history
 * repeats every earlier prompt, so a message already claimed by an earlier group
 * is not this group's.
 */
function fillPrompts(groups: Group[], bodies: Map<number, Json | undefined>) {
  const claimed = new Set<string>()
  for (const group of groups) {
    const body = bodies.get(opened(group))
    if (!body) {
      group.prompt_note = "sem corpo casado para este turno: a requisição não foi observada"
      continue
    }
    const messages = messagesOf(body)
    if (!messages) {
      group.prompt_note = "o corpo deste turno não traz as mensagens"
      continue
    }
    const texts: string[] = []
    for (const message of messages) {
      if (str(message["role"]) !== "user") continue
      const content = message["content"]
      if (typeof content === "string") {
        if (!INJECTED.test(content)) texts.push(content)
        continue
      }
      for (const block of blocksOf(content)) {
        if (str(block["type"]) !== "text") continue
        const text = str(block["text"]) ?? ""
        if (text && !INJECTED.test(text)) texts.push(text)
      }
    }
    const fresh = texts.filter((text) => !claimed.has(text))
    const own = fresh.length ? fresh[fresh.length - 1] : texts[texts.length - 1]
    for (const text of texts) claimed.add(text)
    if (own) group.prompt = own
    else group.prompt_note = "nenhuma mensagem digitada encontrada neste turno"
  }
}

/**
 * Tool failures, charged to the request that caused them.
 *
 * A failure is seen for the first time in the body of the turn *after* the call,
 * so a body that is a group's opening turn is showing history: the failure
 * happened while the previous request was being answered, and belongs to it.
 * Anywhere else inside a group's span, the failure is that group's own.
 */
function attachToolErrors(groups: Group[], conversation: Conversation) {
  const owner = (turn: number) => {
    const at = groups.findIndex((group) => turn >= opened(group) && turn <= closed(group))
    const found = at === -1 ? undefined : groups[at]
    if (!found) return undefined
    return turn === opened(found) && at > 0 ? groups[at - 1] : found
  }
  for (const error of conversation.errors)
    owner(error.turn)?.tool_errors.push({ tool: error.tool, message: error.message })
}

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

function totals(summary: Json, rows: Json[]) {
  const tokens = record(summary["tokens"]) ?? {}
  const parts = record(summary["prompt_tokens_by_part"]) ?? {}
  const resent = num(summary["resent_tokens"]) ?? 0
  const prompt = num(tokens["prompt"]) ?? 0
  return {
    turns: summary["turns"] ?? rows.length,
    input: tokens["input"] ?? null,
    cache_read: tokens["cache_read"] ?? null,
    cache_write: tokens["cache_write"] ?? null,
    prompt_tokens: prompt || null,
    output: tokens["output"] ?? null,
    reasoning: tokens["reasoning"] ?? null,
    total: tokens["total"] ?? null,
    cache_hit_rate: tokens["cache_hit_rate"] ?? summary["cache_hit_rate"] ?? null,
    cost_usd: summary["cost_usd"] ?? tokens["cost_usd"] ?? null,
    coverage: summary["coverage"] ?? null,
    by_part: parts,
    // How much of the prompt bill is history travelling again rather than
    // anything new being said. In a long session it is nearly all of it.
    resent_tokens: resent || null,
    resent_share: prompt ? round(resent / prompt, 4) : null,
    estimated_tokens: summary["estimated_tokens"] ?? null,
  }
}

function errorsOf(ref: SessionRef, rows: Json[], summary: Json, conversation: Conversation, cli: Cli) {
  // A turn that came back without a stop reason and without output is the shape
  // a rejected request leaves in the index. Only those are opened, to read the
  // status and the message off the record itself.
  const suspects = rows
    .filter((row) => !row["stop_reason"] && !num(row["output_tokens"]))
    .map((row) => num(row["turn"]) ?? 0)
    .slice(0, cli.top)
  const failed: Json[] = []
  for (const turn of suspects) {
    const found = loadTurn(ref.dir, turn)
    if (!found) continue
    const response = record(found["response"])
    const status = num(response?.["status"])
    const error = found["error"]
    if (error || (status !== undefined && status >= 400))
      failed.push({ turn, status: status ?? null, error: clip(stringify(error ?? response?.["body"]), PREVIEW) })
  }

  const byTool: Record<string, number> = {}
  const bySignature = new Map<string, { tool: string; message: string; count: number }>()
  for (const error of conversation.errors) {
    byTool[error.tool] = (byTool[error.tool] ?? 0) + 1
    // Grouped on the head of the message: the same mistake made ten times says
    // something a list of ten lines does not.
    const signature = `${error.tool} ${error.message.slice(0, 80)}`
    const found = bySignature.get(signature)
    if (found) found.count += 1
    else bySignature.set(signature, { tool: error.tool, message: error.message, count: 1 })
  }

  return {
    // From the folder's own running totals, which counted every turn — not just
    // the ones opened here.
    counted_by_plugin: summary["errors"] ?? 0,
    incomplete_turns: summary["incomplete_turns"] ?? 0,
    retry_turns: summary["retry_turns"] ?? 0,
    retry_tokens: summary["retry_tokens"] ?? 0,
    compactions: summary["compactions"] ?? 0,
    compaction_overflow: summary["compaction_overflow"] ?? 0,
    compaction_dropped_tokens: summary["compaction_dropped_tokens"] ?? 0,
    // Answers the model was cut off in the middle of: a truncated result, not
    // merely an expensive one.
    truncated_turns: rows.filter((row) => row["stop_reason"] === "max_tokens").map((row) => row["turn"]),
    retried_turns: rows
      .filter((row) => row["retry_of"] !== undefined)
      .map((row) => ({ turn: row["turn"], retry_of: row["retry_of"] })),
    failed_turns: failed,
    tool_errors_total: conversation.errors.length,
    tool_errors_by_tool: byTool,
    tool_errors_note:
      "lidos dos corpos abertos (primeiro e último turno de cada requisição) e deduplicados pelo id da chamada; um erro cujo turno não foi aberto não aparece aqui",
    top_tool_errors: [...bySignature.values()].sort((a, b) => b.count - a.count).slice(0, cli.top),
  }
}

function cacheOf(ref: SessionRef, rows: Json[], summary: Json) {
  const breaks = rows.filter((row) => row["prefix_stable"] === false).map((row) => num(row["turn"]) ?? 0)
  // Opening every broken turn would cost a gigabyte of reading to say the same
  // thing eight times. A spread across the session is enough to name the cause.
  const step = Math.max(1, Math.floor(breaks.length / BREAK_SAMPLE))
  const sampled: Json[] = []
  for (let i = 0; i < breaks.length && sampled.length < BREAK_SAMPLE; i += step) {
    const turn = breaks[i]
    if (turn === undefined) continue
    const found = loadTurn(ref.dir, turn)
    const reuse = record(found?.["reuse"])
    if (!reuse) continue
    const piece = record(reuse["changed_piece"])
    // `changed_piece` is the opencode plugin's; the Claude Code reader does not
    // write it. When the system prefix is what moved, the first system block is
    // the thing to look at — it is where a client puts the per-request header
    // that changes on every turn and invalidates everything behind it.
    const system = list(record(found?.["prompt"])?.["system"]).filter(isRecord)[0]
    sampled.push({
      turn,
      system_changed: reuse["system_changed"] ?? null,
      tools_changed: reuse["tools_changed"] ?? null,
      changed_at: reuse["changed_at"] ?? null,
      stable_messages: reuse["stable_messages"] ?? null,
      dropped_messages: reuse["dropped_messages"] ?? null,
      changed_role: piece?.["role"] ?? null,
      changed_preview: piece ? clip(str(piece["preview"]) ?? "", PREVIEW) : null,
      system_preview: reuse["system_changed"] === true && system ? clip(str(system["preview"]) ?? "", PREVIEW) : null,
    })
  }
  return {
    hit_rate: record(summary["tokens"])?.["cache_hit_rate"] ?? null,
    prefix_breaks: summary["prefix_breaks"] ?? breaks.length,
    turns: rows.length,
    resent_tokens: summary["resent_tokens"] ?? null,
    sample: sampled,
    sample_note: `amostra de ${sampled.length} de ${breaks.length} turnos com prefixo quebrado`,
  }
}

function behaviorOf(rows: Json[], groups: Group[], conversation: Conversation, cli: Cli) {
  const counts: Record<string, number> = {}
  const sequence: string[] = []
  for (const row of rows)
    for (const call of list(row["tool_calls"])) {
      const name = str(call)
      if (!name) continue
      counts[name] = (counts[name] ?? 0) + 1
      sequence.push(name)
    }
  const bigrams: Record<string, number> = {}
  for (let i = 1; i < sequence.length; i++) {
    const key = `${sequence[i - 1]} -> ${sequence[i]}`
    bigrams[key] = (bigrams[key] ?? 0) + 1
  }

  // The same tool called twice with byte-identical arguments did the same work
  // twice. The final turn of a group repeats the calls of every turn before it,
  // so a call seen under an id already counted is one call, not two.
  const repeats = new Map<string, { tool: string; args: string; count: number }>()
  const ids = new Set<string>()
  for (const call of conversation.calls) {
    if (call.id) {
      if (ids.has(call.id)) continue
      ids.add(call.id)
    }
    const key = `${call.tool} ${call.args}`
    const found = repeats.get(key)
    if (found) found.count += 1
    else repeats.set(key, { tool: call.tool, args: call.args, count: 1 })
  }

  const perRequest = groups.map((group) => group.turns.length)
  const slowest = [...rows]
    .sort((a, b) => (num(b["seconds"]) ?? 0) - (num(a["seconds"]) ?? 0))
    .slice(0, cli.top)
    .map((row) => ({
      turn: row["turn"],
      seconds: row["seconds"],
      first_token_ms: row["first_token_ms"] ?? null,
      tools: row["tool_calls"] ?? null,
    }))

  return {
    tool_calls: sorted(counts, cli.top),
    tool_pairs: sorted(bigrams, cli.top),
    repeated_calls: [...repeats.values()]
      .filter((entry) => entry.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, cli.top)
      .map((entry) => ({ tool: entry.tool, count: entry.count, args: clip(entry.args, PREVIEW) })),
    turns_per_request: {
      requests: groups.length,
      average: perRequest.length ? round(perRequest.reduce((a, b) => a + b, 0) / perRequest.length, 1) : null,
      worst: perRequest.length ? Math.max(...perRequest) : null,
    },
    slowest_turns: slowest,
  }
}

function caveats(rows: Json[], summary: Json) {
  const notes: string[] = []
  const matches = new Map<string, number>()
  for (const row of rows) {
    const match = str(row["request_match"])
    if (match) matches.set(match, (matches.get(match) ?? 0) + 1)
  }
  if (matches.size)
    notes.push(
      `casamento requisição/turno: ${[...matches].map(([key, count]) => `${key}=${count}`).join(", ")}. "adjacent" é casamento por proximidade, não exato — no lado Claude Code não existe join exato.`,
    )
  const estimated = rows.filter((row) => row["source"] === "estimated").length
  if (estimated)
    notes.push(`${estimated} turnos com usage estimado (chars/4), não contado pelo provider: some-os com cuidado.`)
  if (summary["incomplete_turns"])
    notes.push(`${summary["incomplete_turns"]} turnos ficaram sem resposta: os tokens deles faltam em tudo acima.`)
  notes.push(
    "tokens por parte (system/tools/messages) são o total do provider distribuído por caracteres: exato no agregado, aproximado por linha.",
  )
  notes.push("um contador ausente não é zero — o plugin omite o que o dialeto não reporta.")
  return notes
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function emit(cli: Cli, data: unknown, markdown: () => string) {
  const text = cli.json ? JSON.stringify(data, null, 2) : markdown()
  if (!cli.out) {
    console.log(text)
    return
  }
  const out = path.resolve(cli.out)
  const root = findRoot(cli.dir)
  if (root && out.startsWith(path.resolve(root.dir) + path.sep))
    fail("--out aponta para dentro do diretório de auditoria, que é somente leitura aqui.")
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text)
  console.log(`escrito em ${out}`)
}

function renderList(root: { dir: string; flavor: string }, sessions: SessionRef[]) {
  const lines = ["# Conversas auditadas", "", `Diretório: \`${root.dir}\` (${root.flavor})`, ""]
  lines.push("| pasta | início | turnos | erros | tokens | cache | custo |")
  lines.push("|---|---|---:|---:|---:|---:|---:|")
  for (const ref of sessions) {
    const info = brief(ref)
    lines.push(
      `| ${info.folder} | ${short(str(info.started_at))} | ${info.turns ?? "?"} | ${info.errors ?? 0} | ${thousands(num(info.total_tokens))} | ${percent(num(info.cache_hit_rate))} | ${money(num(info.cost_usd))} |`,
    )
  }
  return lines.join("\n")
}

function render(one: ReturnType<typeof analyze>, cli: Cli) {
  const totals = one.totals
  const out: string[] = []
  const push = (...lines: string[]) => out.push(...lines)

  push(`# ${one.folder}`, "")
  push(
    `Sessão \`${one.session ?? "?"}\` · início ${short(str(one.started_at))} · ${fixed(num(one.elapsed_seconds), 0)}s de relógio`,
    "",
  )

  push("## 1. Custo e volume", "")
  push(
    `- turnos: **${totals.turns}** em **${one.requests.length}** requisições suas`,
    `- custo: **${money(num(totals.cost_usd))}** · total **${thousands(num(totals.total))}** tokens`,
    `- prompt ${thousands(num(totals.prompt_tokens))} (cache read ${thousands(num(totals.cache_read))}, write ${thousands(num(totals.cache_write))}, novo ${thousands(num(totals.input))}) · saída ${thousands(num(totals.output))} (raciocínio ${thousands(num(totals.reasoning))})`,
    `- cache hit rate: **${percent(num(totals.cache_hit_rate))}** · ${totals.coverage ?? ""}`,
  )
  const parts = totals.by_part
  if (num(parts["total"]))
    push(
      `- para onde foi o prompt: system ${share(num(parts["system"]), num(parts["total"]))}, tools ${share(num(parts["tools"]), num(parts["total"]))}, mensagens ${share(num(parts["messages"]), num(parts["total"]))}`,
    )
  if (totals.resent_tokens)
    push(
      `- reenviado: **${thousands(num(totals.resent_tokens))}** tokens (${percent(num(totals.resent_share))} do prompt) — histórico viajando de novo, não coisa nova sendo dita`,
    )
  push("")

  push("## 2. Suas requisições, por custo", "")
  push("| # | prompt | turnos | tokens | custo | seg | erros de tool | tools |")
  push("|---:|---|---:|---:|---:|---:|---:|---|")
  for (const group of [...one.requests].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, cli.top)) {
    const tools = Object.entries(group.tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => `${name}x${count}`)
      .join(" ")
    push(
      `| ${group.index} | ${cell(group.prompt ?? group.prompt_note ?? "—", 90)} | ${group.turns.length} | ${thousands(group.tokens)} | ${group.costed ? money(group.cost_usd) : "—"} | ${fixed(group.seconds, 0)} | ${group.tool_errors.length || ""} | ${tools} |`,
    )
  }
  push("")

  push("## 3. Erros e desperdício", "")
  const errors = one.errors
  push(
    `- requisições rejeitadas pelo provider: **${errors.counted_by_plugin}** · turnos sem resposta: ${errors.incomplete_turns}`,
    `- retries (prompt pago duas vezes): **${errors.retry_turns}** · ${thousands(num(errors.retry_tokens))} tokens`,
    `- respostas truncadas (\`max_tokens\`): ${errors.truncated_turns.length ? errors.truncated_turns.join(", ") : "nenhuma"}`,
    `- compactações: ${errors.compactions} (por overflow: ${errors.compaction_overflow}, descartados ${thousands(num(errors.compaction_dropped_tokens))} tokens)`,
    `- erros de tool observados: **${errors.tool_errors_total}**`,
  )
  if (Object.keys(errors.tool_errors_by_tool).length) push(`  - por tool: ${sortedLine(errors.tool_errors_by_tool)}`)
  if (errors.top_tool_errors.length) {
    push("", "Erros de tool recorrentes:", "")
    for (const item of errors.top_tool_errors) push(`- \`${item.tool}\` x${item.count} — ${cell(item.message, 160)}`)
  }
  if (errors.failed_turns.length) {
    push("", "Turnos que falharam:", "")
    for (const item of errors.failed_turns)
      push(`- turno ${item["turn"]} · HTTP ${item["status"] ?? "?"} — ${cell(str(item["error"]) ?? "", 160)}`)
  }
  push("", `> ${errors.tool_errors_note}`, "")

  push("## 4. Cache", "")
  const cache = one.cache
  push(
    `- prefixo quebrado em **${cache.prefix_breaks}** de ${cache.turns} turnos · hit rate ${percent(num(cache.hit_rate))}`,
    `- ${cache.sample_note}`,
  )
  if (cache.sample.length) {
    push("")
    push("| turno | system mudou | tools mudaram | quebrou na msg | o que mudou |")
    push("|---:|---|---|---:|---|")
    for (const item of cache.sample)
      push(
        `| ${item["turn"]} | ${item["system_changed"]} | ${item["tools_changed"]} | ${item["changed_at"] ?? "—"} | ${cell(str(item["changed_preview"]) ?? str(item["system_preview"]) ?? "—", 110)} |`,
      )
  }
  push("")

  push("## 5. Comportamento do agente", "")
  const behavior = one.behavior
  push(
    `- ${behavior.turns_per_request.requests} requisições · média de **${behavior.turns_per_request.average}** turnos cada · pior caso **${behavior.turns_per_request.worst}**`,
    `- tools mais chamadas: ${sortedLine(behavior.tool_calls)}`,
    `- pares consecutivos: ${sortedLine(behavior.tool_pairs)}`,
  )
  if (behavior.repeated_calls.length) {
    push("", "Chamadas idênticas repetidas (mesmo tool, mesmos argumentos):", "")
    for (const item of behavior.repeated_calls) push(`- \`${item.tool}\` x${item.count} — ${cell(item.args, 140)}`)
  }
  const byTool = record(one.by_tool)
  if (byTool) {
    push("", "Custo por tool, segundo o plugin:", "")
    push("| tool | chamadas | tokens do resultado | reenviados | falhas | ms médio |")
    push("|---|---:|---:|---:|---:|---:|")
    for (const [name, value] of Object.entries(byTool).slice(0, cli.top)) {
      const cost = record(value) ?? {}
      push(
        `| ${name} | ${cost["calls"] ?? cost["runs"] ?? "?"} | ${thousands(num(cost["result_tokens"]))} | ${thousands(num(cost["resent_tokens"]))} | ${cost["failed"] ?? 0} | ${cost["ms_avg"] ?? "—"} |`,
      )
    }
  }
  push("")

  push("## 6. Os prompts, na íntegra", "")
  for (const prompt of one.prompts) {
    push(
      `### Requisição ${prompt.request} — ${prompt.turns} turnos, ${thousands(prompt.tokens)} tokens, ${money(prompt.cost_usd ?? undefined)}${prompt.tool_errors ? `, ${prompt.tool_errors} erros de tool` : ""}`,
      "",
    )
    push("```", (prompt.text ?? prompt.note ?? "—").trim(), "```", "")
  }

  push("## 7. Ressalvas", "")
  for (const note of one.caveats) push(`- ${note}`)
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function messagesOf(body: Json | undefined) {
  const request = record(body?.["request"])
  const payload = record(request?.["body"])
  const messages = payload?.["messages"] ?? payload?.["contents"] ?? payload?.["input"]
  return Array.isArray(messages) ? (messages.filter(isRecord) as Json[]) : undefined
}

function blocksOf(content: unknown): Json[] {
  if (!Array.isArray(content)) return []
  return content.filter(isRecord) as Json[]
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value.map((item) => (isRecord(item) ? (str(item["text"]) ?? stringify(item)) : String(item))).join(" ")
  return stringify(value)
}

function sorted(counts: Record<string, number>, top: number) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, top),
  )
}

function sortedLine(counts: Record<string, number>) {
  const found = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return found.length ? found.map(([name, count]) => `${name} ${count}`).join(" · ") : "—"
}

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function cell(text: string, max: number) {
  return clip(text, max).replace(/\|/g, "\\|")
}

function share(part: number | undefined, total: number | undefined) {
  if (part === undefined || !total) return "—"
  return `${thousands(part)} (${percent(part / total)})`
}

const thousands = (value?: number) => (value === undefined ? "—" : value.toLocaleString("pt-BR"))
const percent = (value?: number) => (value === undefined ? "—" : `${(value * 100).toFixed(1)}%`)
const money = (value?: number) => (value === undefined ? "—" : `$${value.toFixed(4)}`)
const fixed = (value: number | undefined, digits: number) => (value === undefined ? "—" : value.toFixed(digits))
const short = (value?: string) => (value ? value.replace("T", " ").slice(0, 16) : "—")
const round = (value: number, digits: number) => Number(value.toFixed(digits))

function readJson(file: string): Json | undefined {
  try {
    const parsed = parse(fs.readFileSync(file, "utf8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function readJsonl(file: string): Json[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(parse).filter(isRecord) as Json[]
  } catch {
    return []
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function stringify(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function entries(dir: string) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function exists(file: string) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function stat(file: string) {
  try {
    return fs.statSync(file)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const record = (value: unknown) => (isRecord(value) ? value : undefined)
const str = (value: unknown) => (typeof value === "string" ? value : undefined)
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const list = (value: unknown) => (Array.isArray(value) ? value : [])
const truthy = (value: unknown) => value === true || value === "true"

main()
