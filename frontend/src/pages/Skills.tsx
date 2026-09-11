/** Mis skills.
 *
 *  Una skill es texto: un SKILL.md que el daemon materializa en tu maquina, en las
 *  carpetas que lee cada cliente MCP. La version y el hash son la unica forma de
 *  saber si lo que hay en disco es lo que dice el hub, asi que van en la tabla y no
 *  escondidos en el detalle.
 *
 *  Como los MCP servers: son tuyas, y ningun rol de la organizacion las administra.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { DataTable, shortHash } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { errorMessage } from '../components/ErrorState'
import { ConfirmDialog } from '../components/Modal'
import { SkillForm, renderFrontmatter } from '../components/SkillForm'
import type { SkillFormPayload } from '../components/SkillForm'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'
import { invalidateAfterCatalogChange, useSkills } from '../lib/queries'
import type { Skill } from '../lib/types'
import '../styles/pages.css'

export function Skills() {
  const skills = useSkills()
  const toast = useToast()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Skill | null>(null)
  const [toDelete, setToDelete] = useState<Skill | null>(null)

  const rows = useMemo(() => {
    const all = skills.data ?? []
    const needle = search.trim().toLowerCase()
    if (needle === '') return all
    return all.filter(
      (skill) =>
        skill.slug.includes(needle) ||
        skill.display_name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle),
    )
  }, [skills.data, search])

  /* ----------------------------------------------------------------- mutaciones */

  const save = useMutation<Skill, Error, { id: string | null; payload: SkillFormPayload }>({
    mutationFn: ({ id, payload }) =>
      id === null
        ? api.post<Skill>('/catalog/skills', payload)
        : api.patch<Skill>(`/catalog/skills/${id}`, payload),
    onSuccess: async (skill) => {
      await invalidateAfterCatalogChange(queryClient)
      setFormOpen(false)
      setEditing(null)
      toast.success(`${skill.slug} guardada`, `Versión ${skill.version}`)
    },
    onError: (error) => toast.error('No se pudo guardar la skill', errorMessage(error)),
  })

  const remove = useMutation<void, Error, Skill>({
    mutationFn: (skill) => api.delete<void>(`/catalog/skills/${skill.id}`),
    onSuccess: async (_data, skill) => {
      await invalidateAfterCatalogChange(queryClient)
      setToDelete(null)
      toast.success(`${skill.slug} eliminada`)
    },
    onError: (error) => toast.error('No se pudo eliminar', errorMessage(error)),
  })

  function toggleExpanded(id: string): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* -------------------------------------------------------------------- columnas */

  const columns: Column<Skill>[] = [
    {
      key: 'skill',
      header: 'Skill',
      className: 'wrap',
      render: (skill) => (
        <div className="cell-stack">
          <div className="row gap-1">
            <strong>{skill.display_name}</strong>
            <code className="faint">{skill.slug}</code>
          </div>
          {skill.description && <span className="muted">{skill.description}</span>}
        </div>
      ),
    },
    {
      key: 'version',
      header: 'Versión',
      className: 'num',
      render: (skill) => <span>v{skill.version}</span>,
    },
    {
      key: 'hash',
      header: 'Hash',
      render: (skill) => (
        <code className="faint" title={skill.content_hash}>
          {shortHash(skill.content_hash)}
        </code>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Acciones</span>,
      className: 'cell-tight',
      render: (skill) => (
        <div className="row gap-1 actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => toggleExpanded(skill.id)}
            aria-expanded={expanded.has(skill.id)}
          >
            {expanded.has(skill.id) ? 'Ocultar' : 'Ver SKILL.md'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setEditing(skill)
              setFormOpen(true)
            }}
          >
            Editar
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setToDelete(skill)}>
            Eliminar
          </button>
        </div>
      ),
    },
  ]

  function renderDetail(skill: Skill) {
    if (!expanded.has(skill.id)) return null
    const frontmatter = renderFrontmatter(skill.slug, skill.description, skill.display_name)
    return (
      <div className="detail">
        <div className="detail-head">
          <strong>{skill.slug}/SKILL.md</strong>
          <span className="faint mono" title={skill.content_hash}>
            v{skill.version} · {shortHash(skill.content_hash, 16)}
          </span>
        </div>
        <pre className="preview">{`${frontmatter}\n\n${skill.body.trim()}\n`}</pre>
      </div>
    )
  }

  return (
    <section className="section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Mis skills</h1>
          <p className="page-subtitle">
            El daemon materializa cada una como un SKILL.md en las carpetas que lee cada cliente MCP. Se
            apagan por cliente en la matriz, igual que los servers.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            Nueva skill
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="field">
          <label className="sr-only" htmlFor="skills-search">
            Buscar
          </label>
          <input
            id="skills-search"
            type="search"
            placeholder="Buscar por slug o nombre"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="grow" />
        <span className="faint">
          {rows.length} de {(skills.data ?? []).length}
        </span>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(skill) => skill.id}
        loading={skills.isPending}
        loadingLabel="Cargando las skills…"
        error={skills.isError ? skills.error : undefined}
        onRetry={() => void skills.refetch()}
        empty={
          (skills.data ?? []).length === 0
            ? 'Todavía no creaste ninguna skill.'
            : 'Ninguna skill coincide con el filtro.'
        }
        renderDetail={renderDetail}
        caption="Mis skills"
      />

      <SkillForm
        open={formOpen}
        skill={editing}
        busy={save.isPending}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        onSubmit={(payload) => save.mutate({ id: editing?.id ?? null, payload })}
      />

      <ConfirmDialog
        open={toDelete !== null}
        title="Eliminar la skill"
        destructive
        busy={remove.isPending}
        confirmLabel="Eliminar"
        message={
          <>
            Se elimina <code>{toDelete?.slug}</code> y desaparece de tus máquinas en cuanto baje el
            próximo snapshot.
          </>
        }
        onConfirm={() => toDelete && remove.mutate(toDelete)}
        onClose={() => setToDelete(null)}
      />

</section>
  )
}

export default Skills
