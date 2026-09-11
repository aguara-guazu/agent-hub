# MCP servers de prueba

`testdata/src/mcp_servers` contiene upstreams reales hechos con el SDK MCP de TypeScript:

| Server | Transporte | Herramientas |
|---|---|---|
| `notesServer` | stdio | `add_note`, `list_notes` |
| `opsServer` | stdio | `check_status`, `restart_service` |
| `flakyServer` | stdio | `always_fails`, `slow` |
| `httpServer` | Streamable HTTP | `ping`, `echo`, `whoami` |

Compilar y ejecutar:

```bash
npm run build --workspace @agenthub/testdata
node testdata/dist/mcp_servers/notesServer.js
OPS_AUDIT_FILE=/tmp/ops-audit.jsonl node testdata/dist/mcp_servers/opsServer.js
```

Los servidores stdio esperan mensajes JSON-RPC por stdin. `opsServer` agrega una línea al archivo indicado únicamente cuando `restart_service` llega realmente al upstream. La prueba crítica del gateway usa esa señal para demostrar que una llamada denegada no atravesó el puente.

Desde código:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['testdata/dist/mcp_servers/opsServer.js'],
})
const client = new Client({ name: 'manual', version: '1.0.0' })
await client.connect(transport)
console.log(await client.listTools())
await client.close()
```

Pruebas:

```bash
npm test -- testdata/src
```
