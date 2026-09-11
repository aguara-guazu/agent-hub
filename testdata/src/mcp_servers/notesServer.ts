/**
 * MCP server de prueba con estado en memoria: bloc de notas.
 *
 * Es el upstream "bien portado": dos herramientas inofensivas, una que escribe y otra
 * que lee, sin efectos fuera del proceso. El estado vive en el proceso: arranca vacio
 * y se mantiene mientras el cliente conserve la conexion, que es lo que prueba que el
 * gateway reusa una sola sesion upstream en lugar de levantar un proceso por llamada.
 */

import { TestServer, ToolError } from './base.js'

export const SERVER_NAME = 'notes'
export const SERVER_VERSION = '1.0.0'

interface NoteView {
  id: number
  title: string
  body: string
}

export function createNotesServer(): TestServer {
  const notes: NoteView[] = []
  const server = new TestServer(
    SERVER_NAME,
    SERVER_VERSION,
    'Bloc de notas en memoria para probar el hub. Los datos se pierden al cerrar.',
  )

  server.tool({
    name: 'add_note',
    description: 'Agrega una nota al bloc en memoria y devuelve su identificador.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: (args) => {
      const title = String(args['title'] ?? '')
      if (!title.trim()) throw new ToolError('El titulo de la nota no puede estar vacio.')
      const note: NoteView = { id: notes.length + 1, title, body: String(args['body'] ?? '') }
      notes.push(note)
      return `nota ${note.id} agregada`
    },
  })

  server.tool({
    name: 'list_notes',
    description: 'Lista las notas agregadas en esta sesion, en orden de creacion.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: () => notes.map((note) => ({ ...note })),
  })

  return server
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void createNotesServer().runStdio()
}
