import type { MemoryStore } from './store.js'

export async function seedDemo(store: MemoryStore) {
  async function entity(kind: 'company' | 'project' | 'collection', title: string, data: Record<string, any> = {}, projects: string[] = []) {
    const existing = (await store.list({ kind, query: title })).items.find(e => e.title === title)
    return existing ?? store.create({ kind, title, data, project_ids: projects }, 'demo')
  }
  const company = await entity('company', 'Norte · ejemplo', { description: 'Empresa ficticia para probar la memoria' })
  const second = await entity('company', 'Sur · ejemplo')
  const north = await entity('project', 'POC de soporte · ejemplo', { company_id: company.id, status: 'poc', description: 'Asistente para consultas de soporte. Datos ficticios.' })
  const south = await entity('project', 'Portal comercial · ejemplo', { company_id: second.id, status: 'discovery', description: 'Relevamiento del portal comercial. Datos ficticios.' })
  const meeting = await store.ingest({ external_id: 'demo:meeting:2026-09-11', kind: 'meeting', title: 'Seguimiento interno — Norte y Sur · ejemplo',
    occurred_at: '2026-09-11T13:00:00Z', timezone: 'America/Argentina/Cordoba', project_ids: [north.id, south.id],
    participants: [{ external_id: 'ana@example.com', name: 'Ana Pérez', email: 'ana@example.com', identity_verified: true },
      { external_id: 'martin@example.com', name: 'Martín Díaz', email: 'martin@example.com', identity_verified: true }],
    fragments: [
      { text: 'Para Norte ya validamos la primera integración. Nos falta probar las respuestas con el equipo de soporte.', speaker: 'ana@example.com', start_time: '2026-09-11T13:02:00Z', project_ids: [north.id] },
      { text: 'Puedo revisar los resultados los martes de 14 a 17, hora de Argentina.', speaker: 'martin@example.com', start_time: '2026-09-11T13:04:00Z', project_ids: [north.id] },
      { text: 'En Sur estamos esperando el listado de usuarios. El portal sigue en relevamiento.', speaker: 'ana@example.com', start_time: '2026-09-11T13:15:00Z', project_ids: [south.id] },
      { text: 'Me llevo pedir ese listado y dejar el avance registrado para la próxima reunión.', speaker: 'martin@example.com', start_time: '2026-09-11T13:17:00Z', project_ids: [south.id] },
    ] }, 'demo')
  await store.ingest({ external_id: 'demo:findings:north', kind: 'document', title: 'Findings de la POC · ejemplo', project_ids: [north.id],
    text: 'El equipo necesita consultar el estado de tickets y recuperar respuestas anteriores. La primera integración quedó validada; quedan pendientes las pruebas de aceptación.' }, 'demo')
  const collection = await entity('collection', 'Disponibilidad del cliente · ejemplo', { fields: [
    { key: 'horario', label: 'Horario mencionado', type: 'text', required: true }, { key: 'persona', label: 'Persona', type: 'entity', required: false },
    { key: 'zona', label: 'Zona horaria', type: 'text', required: false },
  ] }, [north.id])
  const fragments = await store.fragments(meeting.entity_id)
  const schedule = fragments.items[1]!
  await store.addRecord(collection.id, { values: { horario: 'Martes de 14 a 17', persona: schedule.speaker_id, zona: 'America/Argentina/Cordoba' },
    evidence_ids: [schedule.id], idempotency_key: 'demo:schedule' }, 'demo')
  return { projects: [north.id, south.id], meeting: meeting.entity_id, collection: collection.id }
}
