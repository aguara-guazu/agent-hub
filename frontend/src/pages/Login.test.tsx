/** Pruebas de la pantalla de ingreso.
 *
 *  Lo que se prueba con mas insistencia es la compuerta del SSO: el boton no lo
 *  decide la consola, lo decide `GET /auth/providers`. Si el backend no declara
 *  un proveedor, el boton no existe en el DOM —no alcanza con esconderlo—, y el
 *  ingreso por contrasena sigue estando en los dos casos.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import Login from './Login'
import type { AuthProviders } from './Login'
import type { User } from '../lib/types'
import { getToken } from '../lib/api'
import {
  click,
  installFetch,
  jsonResponse,
  need,
  q,
  qa,
  renderWithProviders,
  setValue,
  setupDom,
  teardownDom,
} from '../test-utils'

const member: User = {
  id: 'u-1',
  email: 'dev@craftech.io',
  full_name: 'Dev',
  org_role: 'member',
  is_active: true,
  squads: [],
  organization: 'Craftech',
}

function providers(overrides: Partial<AuthProviders> = {}): AuthProviders {
  return {
    password_enabled: true,
    oidc_enabled: false,
    oidc_label: '',
    oidc_login_url: '',
    ...overrides,
  }
}

const CON_SSO = providers({
  oidc_enabled: true,
  oidc_label: 'Ingresar con Craftech ID',
  oidc_login_url: '/api/auth/oidc/login',
})

/** El `fetch` simulado, con la respuesta de /auth/providers que pida la prueba. */
function install(body: AuthProviders | null, status = 200) {
  return installFetch({
    user: null,
    handle: (call) => {
      if (call.path !== '/auth/providers') return undefined
      return jsonResponse(body ?? { detail: 'sin proveedores' }, status)
    },
  })
}

function ssoLink(container: HTMLElement): HTMLAnchorElement | null {
  return q<HTMLAnchorElement>(container, '[data-testid="sso-button"]')
}

describe('Login', () => {
  beforeEach(setupDom)
  afterEach(teardownDom)

  it('no muestra el boton de SSO cuando el backend no declara proveedor', async () => {
    const { container } = await renderWithProviders(<Login />, { route: '/login' })

    expect(ssoLink(container)).toBeNull()
    expect(qa(container, 'a').length).toBe(0)
    // El ingreso local no depende del SSO: tiene que estar igual.
    expect(need(container, '#login-email')).toBeTruthy()
    expect(need(container, '#login-password')).toBeTruthy()
  })

  it('muestra el boton de SSO cuando /auth/providers lo declara', async () => {
    install(CON_SSO)

    const { container } = await renderWithProviders(<Login />, { route: '/login' })

    const link = ssoLink(container)
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('Ingresar con Craftech ID')
    // Enlace de verdad: el 302 al proveedor lo tiene que seguir el navegador.
    expect(link?.getAttribute('href')).toBe('/api/auth/oidc/login')
    // Y el formulario de contrasena sigue estando: los dos metodos conviven.
    expect(need(container, '#login-password')).toBeTruthy()
  })

  it('sin url de ingreso no dibuja el boton aunque diga que esta habilitado', async () => {
    install(providers({ oidc_enabled: true, oidc_login_url: '' }))

    const { container } = await renderWithProviders(<Login />, { route: '/login' })

    expect(ssoLink(container)).toBeNull()
  })

  it('si /auth/providers falla se puede entrar igual con contrasena', async () => {
    const fetchMock = install(null, 500)

    const { container } = await renderWithProviders(<Login />, { route: '/login' })

    expect(ssoLink(container)).toBeNull()
    expect(fetchMock.callsTo('/auth/providers').length).toBe(1)
    expect(need(container, '#login-email')).toBeTruthy()
  })

  it('el ingreso por contrasena manda email y clave a /auth/login', async () => {
    const fetchMock = installFetch({
      user: null,
      handle: (call) => {
        if (call.path === '/auth/providers') return jsonResponse(CON_SSO)
        if (call.path === '/auth/login') {
          return jsonResponse({ access_token: 'jwt-nuevo', token_type: 'bearer', user: member })
        }
        return undefined
      },
    })

    const { container } = await renderWithProviders(<Login />, { route: '/login' })
    await setValue(need(container, '#login-email'), '  DEV@craftech.io ')
    await setValue(need(container, '#login-password'), 'secret123')
    await click(need(container, 'button[type="submit"]'))

    // La consola solo recorta espacios; el email lo normaliza el backend.
    expect(fetchMock.lastCall('/auth/login', 'POST')?.body).toEqual({
      email: 'DEV@craftech.io',
      password: 'secret123',
    })
    expect(getToken()).toBe('jwt-nuevo')
  })

  it('en el hub local no dibuja el formulario y dice qué correr', async () => {
    // `password_enabled: false` es lo que declara un hub que corre en la máquina de
    // una sola persona: ahí no hay contraseña que verificar. Dejar el formulario
    // sería mandar a probar credenciales que no existen.
    install(providers({ password_enabled: false }))

    const { container } = await renderWithProviders(<Login />, { route: '/login' })

    expect(q(container, '#login-password')).toBeNull()
    expect(q(container, '#login-email')).toBeNull()
    expect(need(container, '[data-testid="local-hint"]').textContent).toContain('Abrí Agent Hub')
  })

  it('con SSO y sin contraseña muestra el botón y no el aviso del hub local', async () => {
    // Una organización puede tener el ingreso por contraseña apagado y SSO puesto;
    // ahí el camino sigue siendo el botón, no la terminal.
    install(providers({ ...CON_SSO, password_enabled: false }))

    const { container } = await renderWithProviders(<Login />, { route: '/login' })

    expect(ssoLink(container)).not.toBeNull()
    expect(q(container, '[data-testid="local-hint"]')).toBeNull()
    expect(q(container, '#login-password')).toBeNull()
  })

  it('adopta el JWT que el callback de OIDC deja en la query y lo borra de la URL', async () => {
    window.history.replaceState(null, '', '/?sso_token=jwt-de-sso#/login')
    const fetchMock = installFetch({
      user: null,
      handle: (call) => {
        if (call.path === '/auth/providers') return jsonResponse(CON_SSO)
        // /auth/me contesta con la persona solo si viaja el token del SSO.
        if (call.path === '/auth/me') return jsonResponse(member)
        return undefined
      },
    })

    await renderWithProviders(<Login />, { route: '/login' })

    expect(getToken()).toBe('jwt-de-sso')
    expect(fetchMock.callsTo('/auth/me').length).toBeGreaterThan(0)
    expect(window.location.search).toBe('')
  })
})
