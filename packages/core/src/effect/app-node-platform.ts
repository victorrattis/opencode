import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpClient } from "effect/unstable/http"
import { LLMAudit } from "../observability/llm-audit"
import { makeGlobalNode } from "./app-node"

// The experimental native LLM runtime executes provider requests through this
// client instead of the AI SDK, so it gets the same opt-in wire audit
// (OPENCODE_LLM_AUDIT=1) the AI SDK path gets in `Provider.resolveSDK`. The
// shared `httpClient` node below is deliberately left alone: it carries
// unrelated traffic (config, catalog, share, installer).
const auditedFetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const audit = LLMAudit.begin({ input, init })
    if (!audit) return fetch(input, init)
    try {
      const response = await fetch(input, init)
      audit.response(response)
      return response
    } catch (error) {
      audit.failure(error)
      throw error
    }
  },
  { preconnect: (url: string) => globalThis.fetch.preconnect?.(url) },
) as typeof globalThis.fetch

export const filesystem = makeGlobalNode({ service: FileSystem.FileSystem, layer: NodeFileSystem.layer, deps: [] })
export const path = makeGlobalNode({ service: Path.Path, layer: NodePath.layer, deps: [] })
export const httpClient = makeGlobalNode({ service: HttpClient.HttpClient, layer: FetchHttpClient.layer, deps: [] })
export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer.pipe(
    Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, auditedFetch)))),
  ),
  deps: [],
})
export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export * as LayerNodePlatform from "./app-node-platform"
