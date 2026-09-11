/** Pantalla de ingreso. Unico lugar que pide credenciales.
 *
 *  Hay dos maneras de entrar y conviven: contrasena local y SSO por OIDC. Cual
 *  esta habilitada lo dice el backend en `GET /auth/providers`, y esta pantalla
 *  no lo adivina: el boton de SSO aparece solo si esa respuesta lo declara.
 */

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { errorMessage } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api, setToken } from '../lib/api'
import { useAuth } from '../lib/auth'

/** Respuesta de GET /auth/providers. */
export interface AuthProviders {
  password_enabled: boolean
  oidc_enabled: boolean
  oidc_label: string
  oidc_login_url: string
}

/** Destino guardado por la ruta protegida que rebotó a /login. */
interface LoginLocationState {
  from?: { pathname: string; search?: string; hash?: string }
}

/** Parámetro con el que el callback de OIDC devuelve el JWT al navegador. */
const SSO_TOKEN_PARAM = 'sso_token'

function ssoTokenFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get(SSO_TOKEN_PARAM)
}

export function Login() {
  const { user, loading, login, reload } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // El token llega en la URL, así que se sabe antes del primer render si hay una
  // sesión de SSO por adoptar: sin esto la pantalla parpadea el formulario.
  const [adoptingSso, setAdoptingSso] = useState(() => ssoTokenFromUrl() !== null)

  /** Los métodos de ingreso son públicos: esta consulta corre sin sesión. */
  const providers = useQuery<AuthProviders>({
    queryKey: ['auth-providers'],
    queryFn: () => api.get<AuthProviders>('/auth/providers'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  // El callback de OIDC vuelve al navegador con el JWT en la query. Se guarda, se
  // borra de la barra de direcciones (queda en el historial y en cualquier captura
  // de pantalla) y se pide /auth/me para que la sesión exista de verdad.
  useEffect(() => {
    const token = ssoTokenFromUrl()
    if (token === null) return

    setToken(token)
    const params = new URLSearchParams(window.location.search)
    params.delete(SSO_TOKEN_PARAM)
    const search = params.toString()
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search === '' ? '' : `?${search}`}${window.location.hash}`,
    )

    let cancelled = false
    void reload()
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setAdoptingSso(false)
      })
    return () => {
      cancelled = true
    }
  }, [reload])

  const state = location.state as LoginLocationState | null
  const from = state?.from
  const destination = from ? `${from.pathname}${from.search ?? ''}${from.hash ?? ''}` : '/matrix'

  if (user !== null) return <Navigate to={destination} replace />

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email.trim(), password)
      navigate(destination, { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  const sso = providers.data
  const showSso = sso !== undefined && sso.oidc_enabled && sso.oidc_login_url !== ''
  // El hub local no tiene contraseña que verificar: la cuenta del sistema ya es la
  // frontera y la sesión la firma el daemon. Dibujar el formulario sería mandar a la
  // persona a probar credenciales que no existen, así que se le dice qué correr.
  //
  // La comparación es contra `false` a propósito: apagar el formulario tiene que ser
  // una afirmación explícita del backend. Con una respuesta a la que le falte el
  // campo —un hub más viejo, un proxy que la recorte— la pantalla sigue dejando
  // entrar, que es el modo de fallar correcto para la única puerta que hay.
  const showPassword = sso?.password_enabled !== false
  const localOnly = sso?.password_enabled === false && !sso.oidc_enabled

  return (
    <div className="login-page">
      <div className="card login-card">
        <div className="login-brand">
          <span className="brand-mark">
            <Icon name="hub" />
          </span>
          <span>
            <strong>Agent Hub</strong>
            <span>Consola de la organización</span>
          </span>
        </div>

        {adoptingSso ? (
          <p className="login-hint" role="status">
            <Spinner size={12} label="Ingresando" /> Terminando el ingreso por SSO…
          </p>
        ) : localOnly ? (
          <p className="login-hint" data-testid="local-hint">
            Este hub corre en tu máquina y no tiene contraseña. Abrí Agent Hub desde el menú
            de aplicaciones para recibir una sesión local segura.
          </p>
        ) : showPassword ? (
          <form className="login-form" onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="login-email">Correo</label>
              <input
                id="login-email"
                type="email"
                name="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="login-password">Contraseña</label>
              <input
                id="login-password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            {error && (
              <div className="login-error" role="alert">
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={submitting || loading}>
              {submitting && <Spinner size={12} label="Ingresando" />}
              {submitting ? 'Ingresando…' : 'Ingresar'}
            </button>
          </form>
        ) : null}

        {showSso && !adoptingSso && (
          // Enlace y no botón con fetch: el flujo arranca con un 302 a otro origen,
          // que el navegador tiene que seguir por su cuenta.
          <div className="login-form">
            <p className="login-hint">o ingresa con la identidad de la organización</p>
            <a className="btn btn-ghost" href={sso.oidc_login_url} data-testid="sso-button">
              {sso.oidc_label || 'Ingresar con SSO'}
            </a>
          </div>
        )}

        {import.meta.env.DEV && (
          <p className="login-hint">
            Entorno local sembrado: <code>admin@craftech.io</code>, <code>dev@craftech.io</code> o{' '}
            <code>data@craftech.io</code>, con la clave <code>agenthub</code>.
          </p>
        )}
      </div>
    </div>
  )
}

export default Login
