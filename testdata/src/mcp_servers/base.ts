/**
 * Base minima para los MCP servers de prueba en TypeScript.
 *
 * Se construye sobre el `Server` de bajo nivel del SDK en vez de `McpServer`, a
 * proposito: `McpServer.tool()` toma esquemas de zod, y la version de zod del SDK
 * (v3) no es la del workspace (v4). El nivel bajo solo pide handlers de request y
 * evita esa incompatibilidad, que es justo lo que quiere una pieza de prueba.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Tool['inputSchema']
  annotations?: Tool['annotations']
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

/** Un MCP server de prueba con herramientas registradas por nombre. */
export class TestServer {
  private readonly server: Server
  private readonly tools = new Map<string, ToolDefinition>()

  constructor(name: string, version: string, instructions: string) {
    this.server = new Server({ name, version }, { capabilities: { tools: {} }, instructions })
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...this.tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    }))
    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const tool = this.tools.get(request.params.name)
      if (tool === undefined) {
        return { content: [{ type: 'text', text: `herramienta desconocida: ${request.params.name}` }], isError: true }
      }
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      try {
        const value = await tool.handler(args)
        return toResult(value)
      } catch (err) {
        const message = err instanceof ToolError ? err.message : `error inesperado: ${String(err)}`
        return { content: [{ type: 'text', text: message }], isError: true }
      }
    })
  }

  tool(def: ToolDefinition): void {
    this.tools.set(def.name, def)
  }

  get mcpServer(): Server {
    return this.server
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport)
  }

  async close(): Promise<void> {
    await this.server.close()
  }

  /** Arranca por stdio. Es el punto de entrada cuando el gateway lo lanza como hijo. */
  async runStdio(): Promise<void> {
    await this.server.connect(new StdioServerTransport())
  }
}

function toResult(value: unknown): CallToolResult {
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] }
  }
  const text = JSON.stringify(value)
  // `structuredContent` del MCP tiene que ser un objeto: un arreglo va solo como texto.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { content: [{ type: 'text', text }], structuredContent: value as Record<string, unknown> }
  }
  return { content: [{ type: 'text', text }] }
}
