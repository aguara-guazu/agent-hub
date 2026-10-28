import { z } from 'zod'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AIConfig } from './config.js'
import { usesRemoteExtraction } from './config.js'
import type { MemoryAI } from './ai.js'
import { isExtractionCli, type CliExtractionRuntime } from './cli-extraction.js'
import type { Synthesizer } from './schedule-runtime.js'

/** The engine assigned to facts: a CLI runs as a tool-less process, any other provider goes through MemoryAI.extract. */
export class EngineSynthesizer implements Synthesizer {
  constructor(private o: { settings(): Promise<AIConfig>; cli: CliExtractionRuntime; ai: MemoryAI }) {}

  async engine() {
    const config = await this.o.settings()
    if (config.extraction === 'disabled' || (usesRemoteExtraction(config) && !config.remote_processing_enabled)) return null
    if (isExtractionCli(config.extraction)) return config.extraction_model ? { cli: config.extraction, model: config.extraction_model } : null
    return { cli: null, model: config.extraction_model || config.extraction }
  }

  async run(input: Parameters<Synthesizer['run']>[0]) {
    const config = await this.o.settings()
    if (isExtractionCli(config.extraction)) {
      const result = await this.o.cli.synthesize(config.extraction, config.extraction_model, input.system, input.content, input.schema, { signal: input.signal, effort: config.extraction_reasoning_effort, onSpawn: input.onSpawn })
      return { value: result.value, usage: result.usage }
    }
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(input.schema)
    const result = await this.o.ai.forJob(config, input.signal).extract(input.system, input.content, z.unknown().refine(value => validate(value), 'La síntesis no cumple el esquema'))
    return { value: result.value, usage: { model: result.usage.model ?? config.extraction_model, input_tokens: result.usage.input_tokens ?? 0, output_tokens: result.usage.output_tokens ?? 0 } }
  }
}
