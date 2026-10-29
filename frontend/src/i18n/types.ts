import type es from "./locales/es"
import type en from "./locales/en"

/** Recursos tipados: el español es la fuente de las claves; el inglés debe replicarlas. */
export type Resources = typeof es

/** Nombre de cada diccionario (un archivo por vista o dominio). */
export type Namespace = keyof Resources

/** Idiomas que la interfaz sabe mostrar. */
export type Language = "es" | "en"

/** Lo que la persona elige en Ajustes: un idioma fijo o seguir al sistema. */
export type LanguagePreference = Language | "auto"

/** Misma forma que `T`, con cada hoja tipada como `string`. Se usa para tipar los diccionarios en inglés. */
export type Messages<T> = { [K in keyof T]: T[K] extends string ? string : Messages<T[K]> }

/** Claves completas (`a.b.c`) de todas las hojas de un diccionario. */
export type LeafKeys<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : LeafKeys<T[K], `${P}${K}.`>
}[keyof T & string]

type KeyBase<K, Suffix extends string> = K extends `${infer Base}${Suffix}` ? Base : never

/** Claves base que tienen las dos formas plurales `_one` y `_other`. */
export type PluralKey<N extends Namespace> = Extract<KeyBase<LeafKeys<Resources[N]>, "_one">, KeyBase<LeafKeys<Resources[N]>, "_other">>

type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T

/** Por namespace, `true` si es y en tienen exactamente las mismas claves. */
export type LocaleParity = { [N in Namespace]: SameKeys<LeafKeys<Resources[N]>, LeafKeys<(typeof en)[N]>> }

/** Falla la compilación si algún namespace difiere entre idiomas; el detalle aparece en el `satisfies` del archivo en inglés. */
export type AssertLocaleParity = Expect<LocaleParity[Namespace]>

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common"
    resources: Resources
    returnNull: false
  }
}
