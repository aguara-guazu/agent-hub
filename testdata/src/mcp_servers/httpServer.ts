/**
 * MCP server de prueba sobre Streamable HTTP: la rama de upstream remoto.
 *
 * Los otros servers hablan stdio. Este escucha HTTP en un puerto, para ejercitar el
 * camino en que el catalogo guarda `url` y `headers` en lugar de `command` y `args`.
 * Funciona en modo stateless (sin sesion) para que cada pedido se atienda solo.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { TestServer, ToolError } from './base.js'

export const SERVER_NAME = 'httpecho'
export const SERVER_VERSION = '1.0.0'
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PATH = '/mcp'

export function createHttpEchoServer(): TestServer {
  const server = new TestServer(SERVER_NAME, SERVER_VERSION, 'Server de prueba remoto. Solo devuelve lo que se le manda.')

  server.tool({
    name: 'ping',
    description: "Responde 'pong'. Sirve para comprobar que el upstream remoto contesta.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: () => 'pong',
  })

  server.tool({
    name: 'echo',
    description: 'Devuelve el mismo mensaje que recibio.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: (args) => {
      const message = String(args['message'] ?? '')
      if (!message) throw new ToolError('El mensaje no puede estar vacio.')
      return message
    },
  })

  server.tool({
    name: 'whoami',
    description: 'Devuelve nombre, version y transporte de este server de prueba.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: () => ({ name: SERVER_NAME, version: SERVER_VERSION, transport: 'http' }),
  })

  return server
}

export interface HttpEchoHandle {
  server: HttpServer
  port: number
  url: string
  close: () => Promise<void>
}

/** Levanta el server HTTP y devuelve la URL del endpoint MCP. Elige puerto libre si `port` es 0. */
export async function startHttpEchoServer(
  options: { host?: string; port?: number; path?: string } = {},
): Promise<HttpEchoHandle> {
  const host = options.host ?? DEFAULT_HOST
  const path = options.path ?? DEFAULT_PATH
  const port = options.port ?? 0

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!req.url || new URL(req.url, `http://${host}`).pathname !== path) {
      res.writeHead(404).end()
      return
    }
    // Un TestServer y un transport nuevos por pedido: modo stateless, aislado.
    const mcp = createHttpEchoServer()
    // Sin `sessionIdGenerator` el transporte es stateless. Con `exactOptionalPropertyTypes`
    // no se puede pasar `undefined` explícito, y las clases del SDK no encajan con su
    // propia interfaz `Transport`: de ahí el cast.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0])
    const body = await readBody(req)
    await transport.handleRequest(req, res, body)
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res)
  })

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve))
  const address = httpServer.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    server: httpServer,
    port: boundPort,
    url: `http://${host}:${boundPort}${path}`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  return new Promise((resolve) => {
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        resolve(undefined)
      }
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env['PORT'] ?? 8931)
  void startHttpEchoServer({ port })
}
