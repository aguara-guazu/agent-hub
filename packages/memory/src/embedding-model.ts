/** The ID includes the precision/revision contract: vectors from other models never share an index. */
export const NATIVE_EMBEDDING_MODEL = 'embeddinggemma-2-native-q8-v1'
export const EMBEDDING_REPOSITORY = 'onnx-community/embeddinggemma-2-ONNX'
export const EMBEDDING_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
export const embeddingInput = (text: string, query: boolean) => query
  ? `task: search result | query: ${text}` : `title: none | text: ${text}`
