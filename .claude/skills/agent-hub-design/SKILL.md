---
name: agent-hub-design
description: Sistema de diseño, arquitectura de información y reglas de UX de Agent Hub. Usala SIEMPRE antes de crear, modificar, migrar o revisar cualquier vista, componente, texto o flujo del front de Agent Hub (React/Electron), y cuando haya que decidir dónde va una función nueva, si algo merece un modal, una pestaña o un destino, o cómo escribir un texto de la interfaz.
---

# Agent Hub · diseño y UX

Agent Hub es una app de escritorio (Electron + React) que centraliza servidores MCP, skills y una memoria local de proyectos para agentes de código. Esta skill define **dónde va cada cosa, cómo se ve y cómo se comporta**. Su objetivo es que ningún agente agregue interfaz que no tenga sentido: ni visualmente, ni de usabilidad, ni de lógica de producto.

La interfaz anterior (0.11.7) tenía tres niveles de navegación, 33 modales, diez pestañas por proyecto y avisos repetidos en cada tarjeta. Todo eso está prohibido ahora. Si al trabajar sentís la tentación de «agregar un botón más arriba», «un modal rápido» o «una pestaña para esto», casi seguro estás repitiendo ese error.

## Flujo obligatorio

1. **Ubicar.** Antes de escribir código, recorré el árbol de decisión (abajo) y escribí en una línea: destino, plantilla y zona donde va el cambio.
2. **Componer con el sistema.** Usá solo clases y variables de `assets/ah.css`. Si falta algo, frená y proponelo como agregado al sistema (ver `references/09-prompts-para-agentes.md`, prompt 6). No lo inventes en la vista.
3. **Leer la especificación** de la vista afectada en `references/07-especificacion-de-vistas.md`, incluida su lista **«No va»**.
4. **Implementar** con los estados de carga, vacío, vacío por filtro y error.
5. **Verificar** a 960 y 1440 px, en tema oscuro y claro.
6. **Cerrar** recorriendo `references/08-checklist-de-revision.md` y reportando el resultado punto por punto.

Si el pedido viola una regla: no lo implementes tal cual. Explicá qué regla viola, qué consecuencia tiene para la persona y proponé la alternativa del sistema. Implementá la alternativa solo si te la aprueban, o el pedido original si te piden explícitamente cambiar la regla.

## Arquitectura (fija)

```
Buscar o ir a… ⌘K
Inicio                 bandeja de lo que necesita atención
TRABAJO
├ Proyectos            → Resumen · Contenido · Tareas · Decisiones · Colaboración · Notas
│                        (Colaboración = canales › hilos › mensajes, solo para ver;
│                         Notas = notas de agentes, solo lectura)
├ Memoria              explorar + buscar
└ Automatizaciones     Activas · Pausadas · Historial de entregas
CONEXIONES
├ Servidores MCP
├ Skills
├ Clientes
└ Actividad            Llamadas · Procesamiento
Ajustes                General · Fuentes · IA y procesamiento · Automatizaciones ·
                       Colaboración y red · Integraciones · Respaldos · Sistema
● estado del equipo y sincronización (una línea al pie)
```

No hay barra superior ni destino global de Colaboración: los canales e hilos viven solo en la pestaña Colaboración de cada proyecto. El «Foro de agentes» ya no existe en la UI. La ficha de proyecto es la única con seis pestañas (excepción documentada en `references/03-plantillas-y-layout.md`). **Un agente nunca agrega destinos a la barra lateral, pestañas a una ficha ni secciones a Ajustes.** Eso es una decisión de producto que requiere actualizar esta skill.

## Árbol de decisión: dónde va una función

La primera respuesta afirmativa decide:

1. ¿La persona tiene que decidir o resolver algo? → fila en **Inicio › Pendientes** con una acción + chip de estado en el elemento. Si un agente necesita que la persona decida algo, se lo pide por la CLI: el Hub no muestra ni guarda propuestas ni debates pendientes.
2. ¿Es propiedad o acción de un elemento existente? → su **panel** o **ficha**; si es poco frecuente, en el menú «…».
3. ¿Es otra forma de ver una colección existente? → opción del **segmentado** o un **selector** de su barra.
4. ¿Es un tipo nuevo de contenido de proyecto? → un **tipo** en Proyecto › Contenido.
5. ¿Es una preferencia que se fija una vez? → fila en la sección de **Ajustes** que corresponda.
6. ¿Es un registro de algo que pasó? → **Actividad**.
7. Nada de lo anterior → frená y consultá. No crees destinos.

## Reglas no negociables

**Layout**
- Toda vista usa una plantilla: **A** Colección con panel · **B** Ficha · **C** Configuración · **D** Bandeja. Sin zonas extra.
- Un botón primario por vista; hasta dos secundarios; el resto en «…». En Automatizaciones › Historial la página no tiene primario y el único es «Aprobar N seleccionadas», en el panel de la entrega.
- Colecciones = `.list` de `.row`. Por fila: un título, un detalle, un estado, como mucho una acción.
- Un solo `.banner` por vista, agrupando casos. Nunca avisos dentro de filas o tarjetas.
- Sin scroll horizontal de página. Títulos con elipsis + `title`; descripciones con `.clamp2`; `min-width: 0` en hijos flexibles.

**Interacción**
- Editar: en línea o en `.panel`. Nunca en un modal.
- Modal: solo para crear (≤ 5 campos) o confirmar lo irreversible. Nunca modal sobre modal.
- Reversible (pausar, ejecutar, eliminar con borrado suave): se ejecuta y muestra `.toast` con «Deshacer».
- Un panel tiene un solo modelo de guardado: automático o explícito.
- Entidades relacionadas se eligen con combobox que permite crear («Crear «X»»).
- Colaboración es **solo para ver**: la persona lee canales, hilos y mensajes. Interactúa únicamente con el agente líder, por la terminal. El hilo se abre al tocarlo en la lista y se cierra al tocarlo de nuevo o con la X de la esquina superior derecha de su cabecera; al entrar no hay ningún hilo abierto. Las únicas acciones son las cuatro de recuperación de canal en el «…» del canal (Expulsar del canal, Designar coordinador, Eliminar a la papelera, Restaurar), con confirmación de la persona.
- Historial de entregas: sin ver (`.unread`), selección múltiple (`.check` + `.bulkbar`) y atajos J/K para ir a la siguiente o anterior sin ver.

**Visual**
- Solo `var(--*)` y clases de `ah.css`. Ningún hex, radio o tamaño a mano.
- Estados con `.chip` + `.c-ok | c-warn | c-danger | c-locked | c-info | c-off`, siempre punto + texto. Error ≠ Bloqueado.
- Nada de tarjetas de métricas, gradientes, bordes de color a la izquierda, emoji, `select` nativo.
- Tamaños de texto: 22 / 16 / 14 / 13 / 12. Nada menor a 12.

**Redacción**
- Voseo. Botones con verbo + objeto. Sentence case. Sin exclamaciones.
- Ningún valor interno visible: traducir etapas, relaciones y transportes (`references/06-redaccion.md`).
- Sin subtítulos ni párrafos que expliquen la interfaz. La ayuda va en estados vacíos, `hint` o tooltip.

## Mapa rápido de componentes

| Necesito… | Uso |
|---|---|
| Acción principal | `.btn.btn-primary` (una por vista) |
| Variantes de la acción principal | `.btn-group` + `.pop.menu` |
| Acciones secundarias de un elemento | `.btn.btn-icon` «…» + `.pop.menu` |
| Filtrar la misma lista | `.seg` con `.count` |
| Cambiar de contenido en una ficha | `.tabs` + `.tab` (máx. 5; la ficha de proyecto, 6) |
| Estado | `.chip.c-*` |
| Tipo de cosa | `.tag` |
| Activar / desactivar | `.switch` (role=switch, aplica al instante) |
| Ver y editar el elemento seleccionado | `.panel` (`.panel-h`, `.panel-b`, `.panel-f`) |
| Metadatos de solo lectura | `.dl` |
| Marcar elementos sin ver | `.row.is-unread` + `.unread` |
| Elegir varias filas y actuar sobre ellas | `.check` en cada fila + `.bulkbar` arriba de la lista |
| Canales, hilos y mensajes de un proyecto (solo ver) | `.collab` (`.collab-chans`, `.collab-threads`, `.collab-thread`) con `.msg` |
| Algo de toda la página necesita atención | `.banner.banner-warn` (uno) |
| Confirmar una acción reversible | `.toast` con «Deshacer» |
| Nada que mostrar | `.empty` con una acción |
| Identidad de proyecto, cliente, persona | `.av` + `.hue1…6` (por hash del nombre) |

Ejemplos completos y navegables de cada plantilla en `assets/ejemplos/` (`servidores.html` = A, `proyecto.html` = B, `ajustes.html` = C, `inicio.html` = D). Capturas en `assets/capturas/` (`vistas-oscuro/01-inicio.png` … `13-ajustes.png`; la colaboración es `06-proyecto-colaboracion.png` y el historial de entregas `08-automatizaciones-historial.png`).

## Señales de que algo está mal

Si tu cambio incluye alguna de estas cosas, revisalo antes de seguir:
- un segundo `.btn-primary` en la vista;
- un `<dialog>` o modal para editar algo existente;
- un `confirm()` o modal «¿Estás seguro?» para algo reversible;
- el mismo texto de aviso repetido en un `map()` de filas;
- un `<p>` que explica qué hace la sección;
- un destino «Colaboración» en la barra lateral o una lista de hilos fuera de la ficha de proyecto;
- un campo para escribir, un botón de aprobar o cualquier control de acción en la pestaña Colaboración fuera del «…» del canal;
- un número grande en una tarjeta sin acción asociada;
- una pestaña cuyo contenido es la misma lista que otra con otro filtro;
- un string en inglés o en `snake_case` renderizado tal cual;
- `style={{ color: '#…' }}` o cualquier valor que no sea un token.

## Referencias

Leé la que corresponda a la tarea; no hace falta leerlas todas siempre.

| Archivo | Cuándo |
|---|---|
| `references/01-principios-y-arquitectura.md` | Para entender por qué está todo donde está, y la tabla «dónde quedó cada cosa» |
| `references/02-sistema-de-diseno.md` | Tokens de ambos temas y catálogo de componentes con su marcado |
| `references/03-plantillas-y-layout.md` | Las 4 plantillas, reglas L1–L10 y comportamiento por ancho |
| `references/04-patrones-de-interaccion.md` | Modal vs panel vs en línea, Deshacer, ⌘K, estados de lista, teclado |
| `references/05-reglas-de-ux.md` | Árbol de decisión completo y criterios de rechazo U1–U16 |
| `references/06-redaccion.md` | Reglas R1–R8, vocabulario, traducciones de valores internos |
| `references/07-especificacion-de-vistas.md` | Qué va y qué no va en cada vista |
| `references/08-checklist-de-revision.md` | Para cerrar cualquier tarea de front |
| `references/09-prompts-para-agentes.md` | Prompts de tarea, revisión, auditoría y propuesta de componentes |
| `assets/ah.css` | La fuente de verdad del sistema visual |
