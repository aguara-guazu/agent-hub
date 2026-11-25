import { NATIVE_EMBEDDING_MODEL } from '../embedding-model.js'
import { queueMedia, processFilesInput, mediaSettings } from './media-processing.js'
import { z } from 'zod'
import { id } from '../contracts.js'
import { MemoryStore } from "../store.js"

const page = { limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }
export const transcriptionReadOperations = ['transcript'] as const satisfies readonly (keyof typeof transcriptionDefinitions)[]

export const transcriptionDefinitions = {
  process_files: ['Local OCR, transcription, embeddings for PDF pages, images, audio, video per «Ajustes». No version_id: all current files; force re-analyzes, keeps versions. Track via list_jobs.', processFilesInput],
  transcript: ['Utterances of a source version; filter by person/project.', z.object({ entity_id: id, version_id: id.optional(), person_id: id.optional(), project_id: id.optional(), ...page }).strict()],
  assign_fragment: ['Fix utterance projects/speaker; keeps audit and original text.', z.object({ fragment_id: id, project_ids: z.array(id).max(100), person_id: id.nullable().optional() }).strict()],
} satisfies Record<string, [string, z.ZodType]>

export function callTranscription(store: MemoryStore, media: import('./media-runtime.js').MediaRuntime | undefined, operation: string, input: any, actor: string) {
  switch (operation) {
    case 'process_files': return queueMedia(store, input, false, media)
    case 'transcript': return store.fragments(input.entity_id, input)
    case 'assign_fragment': return store.assignFragment(input.fragment_id, input.project_ids, input.person_id, actor)
  }
}

export async function rebuildMediaEmbeddings(store: MemoryStore, media: import('./media-runtime.js').MediaRuntime | undefined, model: string) {
  if (model !== NATIVE_EMBEDDING_MODEL) return { queued: 0 }
  const settings = await mediaSettings(store)
  return settings.vision || settings.audio ? queueMedia(store, { force: true }, false, media) : { queued: 0 }
}
