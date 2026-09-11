/**
 * `@iarna/toml` trae `index.d.ts` pero su package.json no declara `types` ni
 * `exports`, así que la resolución NodeNext no lo encuentra. Se declara acá la
 * superficie mínima que usa el daemon: `parse` y `stringify`.
 */
declare module '@iarna/toml' {
  export function parse(toml: string): Record<string, unknown>
  export function stringify(obj: Record<string, unknown>): string
}
