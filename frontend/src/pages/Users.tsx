/** Personas, squads y cuentas de cliente de la organizacion.
 *
 *  Pantalla solo para admin. La compuerta de la consola es de comodidad: el backend
 *  rechaza igual a quien no lo sea, asi que aca no hay logica de permisos, solo un
 *  aviso para no dejar la ruta en blanco si alguien la escribe a mano.
 *
 *  La vigencia de una membresia se define al asignarla. `GET /identity/users`
 *  devuelve unicamente las membresias VIGENTES hoy, asi que la columna de squads
 *  muestra el presente y el rango completo vive en el formulario de asignacion.
 */

import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Badge } from '../components/Badge'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { errorMessage } from '../components/ErrorState'
import { ConfirmDialog, Modal } from '../components/Modal'
import { Spinner } from '../components/Spinner'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { queryKeys, invalidateAfterIdentityChange, useClientAccounts, useSquads, useUsers } from '../lib/queries'
import type { ClientAccount, OrgRole, Squad, SquadRole, User } from '../lib/types'
import '../styles/pages.css'

const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Miembro',
}

const SQUAD_ROLE_LABELS: Record<SquadRole, string> = {
  lead: 'Lead',
  member: 'Miembro',
}

/** Mismo formato que `normalize_slug` del backend. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Valor de un `datetime-local` a ISO 8601 en UTC.
 *  Cadena vacia es extremo abierto, no error: una membresia sin fin es lo normal. */
function toIso(value: string): { iso: string | null; invalid: boolean } {
  if (value.trim() === '') return { iso: null, invalid: false }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { iso: null, invalid: true }
  return { iso: date.toISOString(), invalid: false }
}

/* -------------------------------------------------------------------------- */
/* Alta de persona                                                             */
/* -------------------------------------------------------------------------- */

interface UserCreatePayload {
  email: string
  full_name: string
  password: string
  org_role: OrgRole
}

function NewUserDialog({
  busy,
  onSubmit,
  onClose,
}: {
  busy: boolean
  onSubmit: (payload: UserCreatePayload) => void
  onClose: () => void
}) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [orgRole, setOrgRole] = useState<OrgRole>('member')
  const [errors, setErrors] = useState<string[]>([])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const problems: string[] = []
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) problems.push('El email no tiene un formato válido.')
    if (password === '') problems.push('La contraseña inicial es obligatoria.')
    setErrors(problems)
    if (problems.length > 0) return
    onSubmit({
      email: email.trim().toLowerCase(),
      full_name: fullName.trim(),
      password,
      org_role: orgRole,
    })
  }

  return (
    <Modal open title="Nueva persona" onClose={onClose} busy={busy}>
      <form className="form-grid" onSubmit={handleSubmit} noValidate>
        {errors.length > 0 && (
          <div className="form-errors" role="alert">
            <strong>No se dio de alta a nadie:</strong>
            <ul>
              {errors.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="field">
          <label htmlFor="user-email">Email</label>
          <input
            id="user-email"
            type="email"
            value={email}
            autoComplete="off"
            placeholder="persona@craftech.io"
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="user-name">Nombre completo</label>
          <input id="user-name" value={fullName} onChange={(event) => setFullName(event.target.value)} />
        </div>

        <div className="field-row">
          <div className="field grow">
            <label htmlFor="user-password">Contraseña inicial</label>
            <input
              id="user-password"
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <span className="field-hint">
              Se la entregas por un canal fuera de banda. No queda visible en ningún listado.
            </span>
          </div>
          <div className="field">
            <label htmlFor="user-role">Rol</label>
            <select id="user-role" value={orgRole} onChange={(event) => setOrgRole(event.target.value as OrgRole)}>
              <option value="member">Miembro</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </select>
          </div>
        </div>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size={12} label="Creando" />}
            Crear persona
          </button>
        </div>
      </form>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* Edicion de persona                                                          */
/* -------------------------------------------------------------------------- */

interface UserUpdatePayload {
  full_name?: string
  org_role?: OrgRole
  is_active?: boolean
}

function EditUserDialog({
  user,
  busy,
  onSubmit,
  onClose,
}: {
  user: User
  busy: boolean
  onSubmit: (payload: UserUpdatePayload) => void
  onClose: () => void
}) {
  const [fullName, setFullName] = useState(user.full_name)
  const [orgRole, setOrgRole] = useState<OrgRole>(user.org_role)

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSubmit({ full_name: fullName.trim(), org_role: orgRole })
  }

  return (
    <Modal open title={`Editar ${user.email}`} onClose={onClose} busy={busy}>
      <form className="form-grid" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="edit-user-name">Nombre completo</label>
          <input id="edit-user-name" value={fullName} onChange={(event) => setFullName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-user-role">Rol en la organización</label>
          <select
            id="edit-user-role"
            value={orgRole}
            onChange={(event) => setOrgRole(event.target.value as OrgRole)}
          >
            <option value="member">Miembro</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
          <span className="field-hint">
            Admin y owner ven toda la organización y pueden escribir reglas de nivel org y squad.
          </span>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size={12} label="Guardando" />}
            Guardar cambios
          </button>
        </div>
      </form>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* Alta de squad y de cuenta de cliente                                        */
/* -------------------------------------------------------------------------- */

interface SquadCreatePayload {
  slug: string
  name: string
  client_account_id: string | null
}

function NewSquadDialog({
  clientAccounts,
  busy,
  onSubmit,
  onClose,
}: {
  clientAccounts: readonly ClientAccount[]
  busy: boolean
  onSubmit: (payload: SquadCreatePayload) => void
  onClose: () => void
}) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [accountId, setAccountId] = useState('')
  const [errors, setErrors] = useState<string[]>([])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const problems: string[] = []
    if (!SLUG_RE.test(slug.trim())) {
      problems.push('El slug admite minúsculas, dígitos, guion y guion bajo, y empieza con letra o dígito.')
    }
    if (name.trim() === '') problems.push('El nombre del squad es obligatorio.')
    setErrors(problems)
    if (problems.length > 0) return
    onSubmit({ slug: slug.trim(), name: name.trim(), client_account_id: accountId === '' ? null : accountId })
  }

  return (
    <Modal open title="Nuevo squad" onClose={onClose} busy={busy}>
      <form className="form-grid" onSubmit={handleSubmit} noValidate>
        {errors.length > 0 && (
          <div className="form-errors" role="alert">
            <strong>No se creó el squad:</strong>
            <ul>
              {errors.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="field-row">
          <div className="field">
            <label htmlFor="squad-slug">Slug</label>
            <input id="squad-slug" value={slug} placeholder="plataforma" onChange={(event) => setSlug(event.target.value)} />
          </div>
          <div className="field grow">
            <label htmlFor="squad-name">Nombre</label>
            <input id="squad-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="squad-account">Cuenta de cliente</label>
          <select id="squad-account" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">Sin cuenta de cliente</option>
            {clientAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Habilita para el squad los MCP servers y las skills atados a esa cuenta. Se define ahora: la API
            no expone todavía una edición del squad.
          </span>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size={12} label="Creando" />}
            Crear squad
          </button>
        </div>
      </form>
    </Modal>
  )
}

function NewAccountDialog({
  busy,
  onSubmit,
  onClose,
}: {
  busy: boolean
  onSubmit: (payload: { slug: string; name: string }) => void
  onClose: () => void
}) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [errors, setErrors] = useState<string[]>([])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const problems: string[] = []
    if (!SLUG_RE.test(slug.trim())) {
      problems.push('El slug admite minúsculas, dígitos, guion y guion bajo, y empieza con letra o dígito.')
    }
    if (name.trim() === '') problems.push('El nombre de la cuenta es obligatorio.')
    setErrors(problems)
    if (problems.length > 0) return
    onSubmit({ slug: slug.trim(), name: name.trim() })
  }

  return (
    <Modal open title="Nueva cuenta de cliente" onClose={onClose} busy={busy}>
      <form className="form-grid" onSubmit={handleSubmit} noValidate>
        {errors.length > 0 && (
          <div className="form-errors" role="alert">
            <strong>No se creó la cuenta:</strong>
            <ul>
              {errors.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="field-row">
          <div className="field">
            <label htmlFor="account-slug">Slug</label>
            <input id="account-slug" value={slug} onChange={(event) => setSlug(event.target.value)} />
          </div>
          <div className="field grow">
            <label htmlFor="account-name">Nombre</label>
            <input id="account-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size={12} label="Creando" />}
            Crear cuenta
          </button>
        </div>
      </form>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* Asignacion a squad, con vigencia                                            */
/* -------------------------------------------------------------------------- */

export interface MembershipPayload {
  squadId: string
  user_id: string
  role: SquadRole
  valid_from: string | null
  valid_to: string | null
}

function MembershipDialog({
  users,
  squads,
  presetUserId,
  presetSquadId,
  busy,
  onSubmit,
  onClose,
}: {
  users: readonly User[]
  squads: readonly Squad[]
  presetUserId: string
  presetSquadId: string
  busy: boolean
  onSubmit: (payload: MembershipPayload) => void
  onClose: () => void
}) {
  const [userId, setUserId] = useState(presetUserId || (users[0]?.id ?? ''))
  const [squadId, setSquadId] = useState(presetSquadId || (squads[0]?.id ?? ''))
  const [role, setRole] = useState<SquadRole>('member')
  const [validFrom, setValidFrom] = useState('')
  const [validTo, setValidTo] = useState('')
  const [errors, setErrors] = useState<string[]>([])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const problems: string[] = []
    if (userId === '') problems.push('Elige una persona.')
    if (squadId === '') problems.push('Elige un squad.')

    const from = toIso(validFrom)
    const to = toIso(validTo)
    if (from.invalid) problems.push('La fecha de inicio no es válida.')
    if (to.invalid) problems.push('La fecha de fin no es válida.')
    if (from.iso !== null && to.iso !== null && to.iso < from.iso) {
      problems.push('La fecha de fin no puede ser anterior a la de inicio.')
    }

    setErrors(problems)
    if (problems.length > 0) return
    onSubmit({ squadId, user_id: userId, role, valid_from: from.iso, valid_to: to.iso })
  }

  return (
    <Modal open title="Asignar a un squad" onClose={onClose} busy={busy}>
      <form className="form-grid" onSubmit={handleSubmit} noValidate>
        {errors.length > 0 && (
          <div className="form-errors" role="alert">
            <strong>No se asignó nada:</strong>
            <ul>
              {errors.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="field">
          <label htmlFor="membership-user">Persona</label>
          <select id="membership-user" value={userId} onChange={(event) => setUserId(event.target.value)}>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.full_name ? `${user.full_name} · ${user.email}` : user.email}
              </option>
            ))}
          </select>
        </div>

        <div className="field-row">
          <div className="field grow">
            <label htmlFor="membership-squad">Squad</label>
            <select id="membership-squad" value={squadId} onChange={(event) => setSquadId(event.target.value)}>
              {squads.map((squad) => (
                <option key={squad.id} value={squad.id}>
                  {squad.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="membership-role">Rol en el squad</label>
            <select
              id="membership-role"
              value={role}
              onChange={(event) => setRole(event.target.value as SquadRole)}
            >
              <option value="member">Miembro</option>
              <option value="lead">Lead</option>
            </select>
          </div>
        </div>

        <div className="field-row">
          <div className="field grow">
            <label htmlFor="membership-from">Vigente desde</label>
            <input
              id="membership-from"
              type="datetime-local"
              value={validFrom}
              onChange={(event) => setValidFrom(event.target.value)}
            />
          </div>
          <div className="field grow">
            <label htmlFor="membership-to">Vigente hasta</label>
            <input
              id="membership-to"
              type="datetime-local"
              value={validTo}
              onChange={(event) => setValidTo(event.target.value)}
            />
          </div>
        </div>
        <span className="field-hint">
          Los extremos vacíos son abiertos. Fuera de la vigencia la persona no hereda las reglas del squad,
          aunque la membresía siga registrada.
        </span>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size={12} label="Asignando" />}
            Asignar
          </button>
        </div>
      </form>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* Pantalla                                                                    */
/* -------------------------------------------------------------------------- */

interface MembershipTarget {
  userId: string
  squadId: string
}

export function Users() {
  const { isAdmin, user: me } = useAuth()
  const users = useUsers()
  const squads = useSquads()
  const clientAccounts = useClientAccounts()
  const toast = useToast()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [newUserOpen, setNewUserOpen] = useState(false)
  const [newSquadOpen, setNewSquadOpen] = useState(false)
  const [newAccountOpen, setNewAccountOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [membership, setMembership] = useState<MembershipTarget | null>(null)
  const [toDeactivate, setToDeactivate] = useState<User | null>(null)

  const allUsers = useMemo(() => users.data ?? [], [users.data])
  const allSquads = useMemo(() => squads.data ?? [], [squads.data])
  const accounts = clientAccounts.data ?? []

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return allUsers
    return allUsers.filter(
      (user) =>
        user.email.toLowerCase().includes(needle) ||
        user.full_name.toLowerCase().includes(needle) ||
        user.squads.some((squad) => squad.slug.includes(needle)),
    )
  }, [allUsers, search])

  /* ----------------------------------------------------------------- mutaciones */

  const createUser = useMutation<User, Error, UserCreatePayload>({
    mutationFn: (payload) => api.post<User>('/identity/users', payload),
    onSuccess: async (user) => {
      await invalidateAfterIdentityChange(queryClient)
      setNewUserOpen(false)
      toast.success(`${user.email} dado de alta`)
    },
    onError: (error) => toast.error('No se pudo crear la persona', errorMessage(error)),
  })

  const updateUser = useMutation<User, Error, { id: string; payload: UserUpdatePayload; message: string }>({
    mutationFn: ({ id, payload }) => api.patch<User>(`/identity/users/${id}`, payload),
    onSuccess: async (_data, { message }) => {
      await invalidateAfterIdentityChange(queryClient)
      setEditing(null)
      setToDeactivate(null)
      toast.success(message)
    },
    onError: (error) => toast.error('No se pudo actualizar la persona', errorMessage(error)),
  })

  const createSquad = useMutation<Squad, Error, SquadCreatePayload>({
    mutationFn: (payload) => api.post<Squad>('/identity/squads', payload),
    onSuccess: async (squad) => {
      await invalidateAfterIdentityChange(queryClient)
      setNewSquadOpen(false)
      toast.success(`Squad ${squad.slug} creado`)
    },
    onError: (error) => toast.error('No se pudo crear el squad', errorMessage(error)),
  })

  const createAccount = useMutation<ClientAccount, Error, { slug: string; name: string }>({
    mutationFn: (payload) => api.post<ClientAccount>('/identity/client-accounts', payload),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.clientAccounts })
      setNewAccountOpen(false)
      toast.success(`Cuenta ${account.name} creada`)
    },
    onError: (error) => toast.error('No se pudo crear la cuenta', errorMessage(error)),
  })

  const addMember = useMutation<void, Error, MembershipPayload>({
    mutationFn: ({ squadId, ...body }) => api.post<void>(`/identity/squads/${squadId}/members`, body),
    onSuccess: async () => {
      await invalidateAfterIdentityChange(queryClient)
      setMembership(null)
      toast.success('Membresía guardada')
    },
    onError: (error) => toast.error('No se pudo asignar', errorMessage(error)),
  })

  const removeMember = useMutation<void, Error, { squadId: string; userId: string; label: string }>({
    mutationFn: ({ squadId, userId }) => api.delete<void>(`/identity/squads/${squadId}/members/${userId}`),
    onSuccess: async (_data, { label }) => {
      await invalidateAfterIdentityChange(queryClient)
      toast.success(`Se quitó la membresía de ${label}`)
    },
    onError: (error) => toast.error('No se pudo quitar la membresía', errorMessage(error)),
  })

  /* -------------------------------------------------------------------- columnas */

  const userColumns: Column<User>[] = [
    {
      key: 'person',
      header: 'Persona',
      className: 'wrap',
      render: (user) => (
        <div className="cell-stack">
          <div className="row gap-1">
            <strong>{user.full_name || user.email}</strong>
            {user.id === me?.id && <Badge tone="accent">tú</Badge>}
          </div>
          {user.full_name !== '' && <span className="muted">{user.email}</span>}
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Rol',
      render: (user) => (
        <Badge tone={user.org_role === 'member' ? 'neutral' : 'accent'}>{ORG_ROLE_LABELS[user.org_role]}</Badge>
      ),
    },
    {
      key: 'active',
      header: 'Estado',
      render: (user) =>
        user.is_active ? <Badge tone="on">activa</Badge> : <Badge tone="off">desactivada</Badge>,
    },
    {
      key: 'squads',
      header: 'Squads vigentes',
      className: 'wrap',
      render: (user) =>
        user.squads.length === 0 ? (
          <span className="faint">sin squads</span>
        ) : (
          <ul className="chip-list">
            {user.squads.map((squad) => (
              <li key={squad.id} className="chip">
                <span>{squad.name}</span>
                <span className="faint">{SQUAD_ROLE_LABELS[squad.role]}</span>
                <button
                  type="button"
                  className="chip-remove"
                  title={`Quitar a ${user.email} de ${squad.name}`}
                  aria-label={`Quitar a ${user.email} de ${squad.name}`}
                  disabled={removeMember.isPending}
                  onClick={() =>
                    removeMember.mutate({ squadId: squad.id, userId: user.id, label: user.email })
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Acciones</span>,
      className: 'cell-tight',
      render: (user) => (
        <div className="row gap-1 actions">
          <button type="button" className="btn btn-sm" onClick={() => setEditing(user)}>
            Editar
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={allSquads.length === 0}
            title={allSquads.length === 0 ? 'Primero crea un squad' : undefined}
            onClick={() => setMembership({ userId: user.id, squadId: '' })}
          >
            Asignar a squad
          </button>
          {user.is_active ? (
            <button type="button" className="btn btn-sm btn-danger" onClick={() => setToDeactivate(user)}>
              Desactivar
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              disabled={updateUser.isPending}
              onClick={() =>
                updateUser.mutate({
                  id: user.id,
                  payload: { is_active: true },
                  message: `${user.email} reactivada`,
                })
              }
            >
              Activar
            </button>
          )}
        </div>
      ),
    },
  ]

  const squadColumns: Column<Squad>[] = [
    {
      key: 'squad',
      header: 'Squad',
      className: 'wrap',
      render: (squad) => (
        <div className="row gap-1">
          <strong>{squad.name}</strong>
          <code className="faint">{squad.slug}</code>
        </div>
      ),
    },
    {
      key: 'account',
      header: 'Cuenta de cliente',
      render: (squad) =>
        squad.client_account_id === null ? (
          <span className="faint">sin cuenta</span>
        ) : (
          <Badge tone="neutral">
            {accounts.find((account) => account.id === squad.client_account_id)?.name ?? squad.client_account_id}
          </Badge>
        ),
    },
    {
      key: 'members',
      header: 'Miembros',
      className: 'num',
      render: (squad) => squad.member_count,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Acciones</span>,
      className: 'cell-tight',
      render: (squad) => (
        <div className="row gap-1 actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={allUsers.length === 0}
            onClick={() => setMembership({ userId: '', squadId: squad.id })}
          >
            Asignar persona
          </button>
        </div>
      ),
    },
  ]

  /* ---------------------------------------------------------------------- render */

  if (!isAdmin) {
    return (
      <section className="section">
        <div className="page-header">
          <div>
            <h1 className="page-title">Personas</h1>
            <p className="page-subtitle">Administración de la organización.</p>
          </div>
        </div>
        <p className="callout callout-warning" role="alert">
          Esta sección es solo para admin y owner. Si necesitas un cambio de squad o de rol, pídeselo a
          quien administra la organización.
        </p>
      </section>
    )
  }

  return (
    <section className="section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Personas</h1>
          <p className="page-subtitle">
            Quién es quién en la organización, en qué squads está y con qué vigencia. Los squads son el
            nivel intermedio de la cadena de reglas.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setNewAccountOpen(true)}>
            Nueva cuenta de cliente
          </button>
          <button type="button" className="btn" onClick={() => setNewSquadOpen(true)}>
            Nuevo squad
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setNewUserOpen(true)}>
            Nueva persona
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="field">
          <label className="sr-only" htmlFor="users-search">
            Buscar
          </label>
          <input
            id="users-search"
            type="search"
            placeholder="Buscar por email, nombre o squad"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="grow" />
        <span className="faint">
          {rows.length} de {allUsers.length}
        </span>
      </div>

      <DataTable
        columns={userColumns}
        rows={rows}
        rowKey={(user) => user.id}
        loading={users.isPending}
        loadingLabel="Cargando las personas…"
        error={users.isError ? users.error : undefined}
        onRetry={() => void users.refetch()}
        empty={allUsers.length === 0 ? 'No hay personas cargadas.' : 'Nadie coincide con el filtro.'}
        rowClassName={(user) => (user.is_active ? undefined : 'row-muted')}
        caption="Personas de la organización"
      />

      <div className="subsection">
        <div className="subsection-head">
          <h2 className="subsection-title">Squads</h2>
          <span className="faint">
            La cuenta de cliente de un squad habilita el catálogo atado a esa cuenta.
          </span>
        </div>
        <DataTable
          columns={squadColumns}
          rows={allSquads}
          rowKey={(squad) => squad.id}
          loading={squads.isPending}
          loadingLabel="Cargando los squads…"
          error={squads.isError ? squads.error : undefined}
          onRetry={() => void squads.refetch()}
          empty="No hay squads. Crea el primero para poder escribir reglas de nivel squad."
          caption="Squads de la organización"
        />
      </div>

      {clientAccounts.isError && (
        <p className="callout callout-warning" role="alert">
          No se pudieron cargar las cuentas de cliente: {errorMessage(clientAccounts.error)}
        </p>
      )}

      {newUserOpen && (
        <NewUserDialog
          busy={createUser.isPending}
          onSubmit={(payload) => createUser.mutate(payload)}
          onClose={() => setNewUserOpen(false)}
        />
      )}

      {editing !== null && (
        <EditUserDialog
          user={editing}
          busy={updateUser.isPending}
          onSubmit={(payload) =>
            updateUser.mutate({ id: editing.id, payload, message: `${editing.email} actualizada` })
          }
          onClose={() => setEditing(null)}
        />
      )}

      {newSquadOpen && (
        <NewSquadDialog
          clientAccounts={accounts}
          busy={createSquad.isPending}
          onSubmit={(payload) => createSquad.mutate(payload)}
          onClose={() => setNewSquadOpen(false)}
        />
      )}

      {newAccountOpen && (
        <NewAccountDialog
          busy={createAccount.isPending}
          onSubmit={(payload) => createAccount.mutate(payload)}
          onClose={() => setNewAccountOpen(false)}
        />
      )}

      {membership !== null && (
        <MembershipDialog
          users={allUsers}
          squads={allSquads}
          presetUserId={membership.userId}
          presetSquadId={membership.squadId}
          busy={addMember.isPending}
          onSubmit={(payload) => addMember.mutate(payload)}
          onClose={() => setMembership(null)}
        />
      )}

      <ConfirmDialog
        open={toDeactivate !== null}
        title="Desactivar a la persona"
        destructive
        busy={updateUser.isPending}
        confirmLabel="Desactivar"
        message={
          <>
            <strong>{toDeactivate?.email}</strong> no va a poder iniciar sesión. Sus máquinas y sus reglas
            quedan como están; el daemon sigue sincronizando hasta que se revoque cada máquina.
          </>
        }
        onConfirm={() =>
          toDeactivate &&
          updateUser.mutate({
            id: toDeactivate.id,
            payload: { is_active: false },
            message: `${toDeactivate.email} desactivada`,
          })
        }
        onClose={() => setToDeactivate(null)}
      />
    </section>
  )
}

export default Users
