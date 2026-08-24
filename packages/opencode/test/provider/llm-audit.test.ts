import { afterEach, beforeEach, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { streamText } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LLMAudit } from "@opencode-ai/core/observability/llm-audit"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"

let directory: string | undefined

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-llm-audit-"))
  process.env["OPENCODE_LLM_AUDIT_DIR"] = directory
  LLMAudit.reset()
})

afterEach(async () => {
  delete process.env["OPENCODE_LLM_AUDIT_DIR"]
  LLMAudit.reset()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

it.live("records the request, the streamed response, and running totals", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => streamingServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })
          expect(yield* Effect.promise(() => result.text)).toBe("ok")

          const turn = yield* Effect.promise(() => read("turn_001.json"))
          expect(turn.request.method).toBe("POST")
          expect(turn.request.headers.authorization).toBe("<redacted>")
          expect(turn.request.body.model).toBe("test-model")
          expect(JSON.stringify(turn.request.body.messages)).toContain("hello")
          expect(turn.model).toBe("test-model")
          expect(turn.provider).toBe("test")
          expect(turn.response.status).toBe(200)
          expect(turn.response.events.length).toBe(2)
          expect(turn.usage).toMatchObject({ input: 10, output: 5, cache_read: 2, total: 17 })
          expect(turn.estimated_cost_usd).toBeCloseTo(0.000105, 9)

          const summary = yield* Effect.promise(() => read("summary.json"))
          expect(summary).toMatchObject({ turns: 1, errors: 0, input_tokens: 10, output_tokens: 5, total_tokens: 17 })
        }),
      { config: auditProviderConfig(server.url) },
    )
  }),
)

it.live("records transport failures with no response", () =>
  Effect.gen(function* () {
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            maxRetries: 0,
            messages: [{ role: "user", content: "hello" }],
          })
          yield* Effect.promise(async () => {
            for await (const _ of result.fullStream) {
            }
          })

          const turn = yield* Effect.promise(() => read("turn_001.json"))
          expect(turn.response).toBeUndefined()
          expect(turn.error.message.length).toBeGreaterThan(0)
          const summary = yield* Effect.promise(() => read("summary.json"))
          expect(summary.errors).toBe(1)
        }),
      // Nothing is listening on this port, so the request never reaches a server.
      { config: auditProviderConfig("http://127.0.0.1:1") },
    )
  }),
)

function auditProviderConfig(url: string) {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        models: {
          "test-model": {
            ...config.provider.test.models["test-model"],
            cost: { input: 3, output: 15 },
          },
        },
      },
    },
  }
}

/** Waits for the background writer to flush, then parses one audit file. */
async function read(name: string): Promise<any> {
  const dir = LLMAudit.directory()
  if (!dir) throw new Error("audit directory was never created")
  const file = path.join(dir, name)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`audit file ${file} was never written`)
}

async function streamingServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(
      [
        'data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}',
        "",
        'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}
