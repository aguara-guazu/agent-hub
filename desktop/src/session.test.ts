import { createServer, type Server } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { waitForDesktopSession } from './session.js'
import { createServer as httpServer } from 'node:http'

const servers: Server[] = []
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}
afterEach(() => { for (const server of servers.splice(0)) server.close() })
it('obtiene una sesión sólo del core esperado', async () => {
  const url = await listen(httpServer((req, res) => {
    res.setHeader('Connection', 'close')
    if (req.url === '/health') res.end(JSON.stringify({ service: 'agenthub-control-plane' }))
    else {
      expect(req.headers.authorization).toBe('Bearer bootstrap')
      res.end(JSON.stringify({ access_token: 'session' }))
    }
  }))
  expect(await waitForDesktopSession(url, 'bootstrap', () => false, 2000)).toBe('session')
})
it('vence aunque el puerto acepte conexiones sin responder HTTP', async () => {
  const url = await listen(createServer(socket => { socket.on('error', () => {}); socket.resume() }))
  const start = Date.now()
  await expect(waitForDesktopSession(url, 'bootstrap', () => false, 150)).rejects.toThrow('tiempo de arranque')
  expect(Date.now() - start).toBeLessThan(1500)
})
it('vence también si la respuesta nunca termina de enviar el cuerpo', async () => {
  const url = await listen(httpServer((_req, res) => { res.writeHead(200); res.write('{') }))
  await expect(waitForDesktopSession(url, 'bootstrap', () => false, 150)).rejects.toThrow('tiempo de arranque')
})
it('corta si el supervisor agotó los reinicios', async () => {
  await expect(waitForDesktopSession('http://127.0.0.1:1', 'bootstrap', () => true)).rejects.toThrow('no se pudo reiniciar')
})
