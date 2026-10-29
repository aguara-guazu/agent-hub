# Patrones de interacción

De 33 modales quedan tres usos: **crear**, **confirmar lo irreversible** y la **paleta de búsqueda**. Todo lo demás se resuelve en la página o en el panel.

## ¿Modal, panel o en línea?

| Situación | Usar | Ejemplo |
|---|---|---|
| Cambiar un valor visible | **En línea** | Título del proyecto, etapa, hora de una automatización |
| Ver o editar un elemento de una lista | **Panel lateral** | Configuración de un servidor, una skill, un cliente |
| Crear algo con 5 campos o menos | **Modal** | Nuevo proyecto, nueva nota, agregar servidor |
| Crear algo largo o técnico | **Panel lateral** | Nueva skill (editor de instrucciones), colección con columnas |
| Acción reversible | **Inmediata + Deshacer** | Pausar, reanudar, ejecutar ahora, eliminar un servidor, cancelar una automatización |
| Borra datos sin vuelta atrás | **Confirmación** | Restaurar un respaldo, eliminar un proyecto con contenido |
| Elegir entre variantes de una acción | **Menú** | «Nuevo proyecto ▾ · Unirme con una invitación · Restaurar desde un respaldo» |
| Un flujo externo (OAuth) | **Bloque de acción en el panel** | «Autorizar cuenta» abre el navegador y vuelve |

Nunca: modal sobre modal, modal para editar, modal para informar («¡Listo!»), modal para elegir una sola opción.

## Crear · modal corto

- Título = acción («Nuevo proyecto»). Sin texto introductorio.
- Hasta 5 campos. El primero recibe el foco.
- Las entidades relacionadas se eligen con un **combobox que permite crear** («Crear «Lumen Ret»»). Así desaparece el modal «Nueva empresa».
- Pie: «Cancelar» (fantasma) + «Crear proyecto» (primario). Enter envía; Escape cancela.
- Al crear: se cierra, se navega al elemento nuevo o se selecciona en la lista, y un toast confirma.

## Editar · panel lateral

- Se abre al hacer click en la fila; la fila queda marcada con `.is-selected`.
- Cabecera: identidad + chip de estado + «…» (acciones secundarias y destructivas).
- Si el elemento necesita una acción para funcionar (autorizar, reiniciar), va **primero**, en un bloque con un botón primario.
- Campos editables directamente. Dos modelos, uno por panel, nunca mezclados:
  - **Guardado automático** (interruptores, horarios, preferencias): pie con «Los cambios se guardan solos».
  - **Guardado explícito** (configuración técnica, texto largo): pie con «Descartar» + «Guardar cambios», activos solo si hay cambios.
- Escape o la X cierran el panel. Si hay cambios sin guardar, el panel no se cierra y marca el botón Guardar.

## Deshacer en lugar de confirmar

```
Antes:  click en «Cancelar» → modal «¿Cancelar automatización?» → «Volver» / «Cancelar automatización»
Ahora:  click en «Eliminar» → la fila desaparece → toast «Se eliminó …» con «Deshacer» durante 6 s
```

- El backend aplica el cambio de forma diferida o reversible (borrado suave).
- El toast nombra el elemento afectado.
- Un solo toast a la vez; el nuevo reemplaza al anterior y el anterior se confirma.

## Confirmar · solo lo irreversible

- Título en forma de pregunta que nombra el objeto: «¿Restaurar el respaldo del 28 de octubre?»
- Una línea que dice **qué se pierde**.
- Botón destructivo que repite la acción: «Restaurar y reemplazar». Nunca «Aceptar» ni «Sí».
- El foco inicial va a «Cancelar».

## Buscar o ir a · ⌘K

- Una sola búsqueda global, abierta con ⌘K o desde la barra lateral.
- Resultados en tres grupos: **Proyectos y memoria**, **Ir a** (destinos de la app), **Acciones** («Nueva nota en …»).
- La última opción siempre es «Buscar «…» en toda la memoria», que abre Memoria con la consulta.
- Teclado: ↑↓ moverse, ↵ abrir, ⌘↵ abrir en panel, esc cerrar.
- No tiene filtros propios: los filtros viven en Memoria.

## Edición en línea

- El valor se ve como texto; al pasar el cursor muestra un fondo `--surface-2`; al hacer click se convierte en campo.
- Enter guarda, Escape cancela, perder el foco guarda.
- Aplica a: título de ficha, etapa (abre menú), hora y días de automatización, nombre en Ajustes.

## Avisos emergentes (toast)

| Caso | Texto | Acción |
|---|---|---|
| Acción reversible | «Automatización pausada» | Deshacer |
| Acción en segundo plano | «Reprocesando 14 fuentes» | Ver en Actividad |
| Error de una acción | «No se pudo conectar con Supabase» | Reintentar |
| Guardado explícito | «Cambios guardados» | — |

No se usa un toast para informar algo que la pantalla ya muestra.

## Estados de toda lista

| Estado | Forma | Ejemplo |
|---|---|---|
| Cargando | 3 filas esqueleto con la misma altura que las reales | — |
| Vacía | `.empty`: icono + título + una línea + una acción | «Todavía no hay servidores» · Agregar servidor |
| Vacía por filtro | Una línea + «Limpiar filtros» | «Ningún servidor coincide con «sup»» |
| Error | `.empty` con icono de error + causa + acción | «La memoria no responde» · Reiniciar servicio |
| Sin permiso | `.empty` + qué falta | «Autorizá la cuenta para ver las herramientas» |

## Teclado y foco

- Todo es accesible con Tab en el orden visual.
- Foco visible con `--focus` (anillo de 3 px), nunca `outline: none` sin reemplazo.
- Atajos globales: ⌘K buscar, ⌘N crear en la vista actual, Escape cierra la capa superior.
- Los atajos no se muestran en la interfaz salvo en la paleta ⌘K y en tooltips.
