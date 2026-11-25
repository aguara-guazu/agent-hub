/** Paths and operation names are contracts shared by the HTTP host, worker and renderer. */
export interface ModuleDefinition {
  id: string
  label: string
  setting: string
  routes: readonly string[]
  destinations: readonly string[]
  operations: readonly string[]
  operationPrefixes: readonly string[]
  requires?: readonly string[]
  jobs: readonly string[]
}
