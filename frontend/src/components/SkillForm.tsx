/** Editor de una skill de la organizacion.
 *
 *  Lo que se escribe aca es el CUERPO del SKILL.md. El frontmatter lo genera el
 *  daemon al materializar el archivo (`packages/daemon/src/adapters/skills.ts`),
 *  con `name` igual al slug, porque los CLIs no cargan una skill cuya carpeta y
 *  cuyo `name` no coinciden. La vista previa de este formulario reproduce ese
 *  frontmatter carácter por carácter para que no haya sorpresas en la máquina.
 */

import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import type { Skill } from '../lib/types'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

/** Escalar YAML entre comillas dobles. Igual que `_yaml_scalar` del daemon. */
export function yamlScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ')
  return `"${escaped.trim()}"`
}

/** Frontmatter que va a quedar en el SKILL.md materializado. */
export function renderFrontmatter(slug: string, description: string, displayName: string): string {
  const text = description.trim() || displayName.trim() || slug
  return ['---', `name: ${yamlScalar(slug)}`, `description: ${yamlScalar(text)}`, '---'].join('\n')
}

export interface BodyFrontmatter {
  /** Valor de `name:` dentro del bloque, sin comillas, o cadena vacia si no está. */
  name: string
  /** Cuerpo sin el bloque. */
  rest: string
}

/** Detecta un frontmatter pegado dentro del cuerpo.
 *
 *  Es el error mas comun al pegar un SKILL.md entero: el daemon antepone el suyo y
 *  el archivo termina con dos bloques, que ningun CLI parsea. */
export function extractBodyFrontmatter(body: string): BodyFrontmatter | null {
  const match = /^\s*---\n([\s\S]*?)\n---\n?/.exec(body)
  if (match === null) return null
  const nameLine = /^name:\s*(.*)$/m.exec(match[1])
  const raw = (nameLine?.[1] ?? '').trim()
  const name = raw.replace(/^["']/, '').replace(/["']$/, '')
  return { name, rest: body.slice(match[0].length) }
}

export interface SkillFormPayload {
  slug?: string
  display_name: string
  description: string
  body: string
}

export interface SkillFormProps {
  open: boolean
  /** `null` es alta. Con una skill, el slug queda bloqueado. */
  skill: Skill | null
  busy?: boolean
  onSubmit: (payload: SkillFormPayload) => void
  onClose: () => void
}

const SLUG_RE = /^[a-z][a-z0-9_-]{1,47}$/

interface FormState {
  slug: string
  displayName: string
  description: string
  body: string
}

function initialState(skill: Skill | null): FormState {
  return {
    slug: skill?.slug ?? '',
    displayName: skill?.display_name ?? '',
    description: skill?.description ?? '',
    body: skill?.body ?? '',
  }
}

export function SkillForm({ open, skill, busy = false, onSubmit, onClose }: SkillFormProps) {
  const [state, setState] = useState<FormState>(() => initialState(skill))
  const [errors, setErrors] = useState<string[]>([])

  const skillId = skill?.id ?? ''
  useEffect(() => {
    if (open) {
      setState(initialState(skill))
      setErrors([])
    }
    // El id, no el objeto: `skill` cambia de identidad en cada refetch.
  }, [open, skillId, skill])

  const isEdit = skill !== null
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((current) => ({ ...current, [key]: value }))

  const frontmatter = useMemo(
    () => renderFrontmatter(state.slug.trim() || 'sin-slug', state.description, state.displayName),
    [state.slug, state.description, state.displayName],
  )
  const bodyFrontmatter = useMemo(() => extractBodyFrontmatter(state.body), [state.body])
  const nameMismatch =
    bodyFrontmatter !== null && bodyFrontmatter.name !== '' && bodyFrontmatter.name !== state.slug.trim()

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const problems: string[] = []
    const slug = state.slug.trim()

    if (!isEdit && !SLUG_RE.test(slug)) {
      problems.push('El slug admite minúsculas, dígitos, guion y guion bajo, empieza con letra y tiene entre 2 y 48 caracteres.')
    }
    if (state.displayName.trim() === '') problems.push('El nombre visible es obligatorio.')
    if (nameMismatch && bodyFrontmatter !== null) {
      problems.push(
        `El frontmatter del cuerpo declara name: «${bodyFrontmatter.name}» y el slug es «${slug}». Los CLIs no cargan una skill cuyo name no coincide con la carpeta.`,
      )
    }

    setErrors(problems)
    if (problems.length > 0) return

    const payload: SkillFormPayload = {
      display_name: state.displayName.trim(),
      description: state.description.trim(),
      body: state.body,
    }
    if (!isEdit) payload.slug = slug
    onSubmit(payload)
  }

  return (
    <Modal
      open={open}
      title={isEdit ? `Editar ${skill.slug}` : 'Nueva skill'}
      onClose={onClose}
      busy={busy}
      width={720}
    >
      <form id="skill-form" className="form-grid" onSubmit={handleSubmit} noValidate>
        {errors.length > 0 && (
          <div className="form-errors" role="alert">
            <strong>No se guardó nada:</strong>
            <ul>
              {errors.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="field-row">
          <div className="field">
            <label htmlFor="skill-slug">Slug</label>
            <input
              id="skill-slug"
              value={state.slug}
              disabled={isEdit}
              placeholder="revision-de-terraform"
              onChange={(event) => set('slug', event.target.value)}
            />
            <span className="field-hint">
              {isEdit ? 'El slug no se puede cambiar.' : 'Es el nombre de la carpeta y el name del frontmatter.'}
            </span>
          </div>
          <div className="field grow">
            <label htmlFor="skill-name">Nombre visible</label>
            <input
              id="skill-name"
              value={state.displayName}
              onChange={(event) => set('displayName', event.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="skill-description">Descripción</label>
          <input
            id="skill-description"
            value={state.description}
            onChange={(event) => set('description', event.target.value)}
          />
          <span className="field-hint">Es lo que el CLI lee para decidir cuándo usar la skill.</span>
        </div>

        <div className="field">
          <label htmlFor="skill-body">Cuerpo del SKILL.md</label>
          <textarea
            id="skill-body"
            className="mono"
            rows={14}
            value={state.body}
            onChange={(event) => set('body', event.target.value)}
          />
        </div>

        {bodyFrontmatter !== null && (
          <div className={nameMismatch ? 'callout callout-error' : 'callout callout-warning'} role="alert">
            {nameMismatch ? (
              <>
                El cuerpo trae <code>name: {bodyFrontmatter.name}</code> y el slug es{' '}
                <code>{state.slug.trim() || '(vacío)'}</code>. Tienen que coincidir.
              </>
            ) : (
              <>El cuerpo ya trae un frontmatter. El daemon antepone el suyo, así que quedarían dos bloques.</>
            )}{' '}
            <button type="button" className="link-button" onClick={() => set('body', bodyFrontmatter.rest)}>
              Quitar el frontmatter del cuerpo
            </button>
          </div>
        )}

        <div className="field">
          <span className="field-label">Vista previa del frontmatter generado</span>
          <pre className="preview" data-testid="skill-frontmatter">
            {frontmatter}
          </pre>
          <span className="field-hint">
            El daemon escribe este bloque arriba del cuerpo, en <code>~/.agenthub/skills/{state.slug.trim() || 'slug'}/SKILL.md</code>.
          </span>
        </div>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size={12} label="Guardando" />}
            {isEdit ? 'Guardar cambios' : 'Crear skill'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default SkillForm
