import type { MemoryStore } from '../store.js'
import { mediaSettings } from './media-processing.js'

export async function mediaCapabilities(store: MemoryStore) {
  return {
    local_media: {
      process: 'memory_process_files', settings: await mediaSettings(store),
      pdf: { max_pages: 200, text: true, requires_module_download: false, page_preview: 'memory_get_file con page', visual: 'encoder visual opcional' },
      max_duration_minutes: 30, video_frame_interval_seconds: 5, requires_module_download: true, generated_content_requires_review: true,
    },
    binary_search_with_enabled_modules: 'OCR, timestamped transcription and native visual/audio embeddings (EmbeddingGemma 2)',
  }
}
