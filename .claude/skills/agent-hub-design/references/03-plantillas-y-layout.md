# Plantillas y reglas de layout

Toda vista de Agent Hub usa **una** de cuatro plantillas y llena sus zonas. Si una función no entra en ninguna zona, la respuesta es simplificar la función, no inventar una zona.

## Estructura común (shell)

```html
<div class="ah shell t-dark">
  <nav class="side">…barra lateral…</nav>
  <main class="main">
    <div class="page">…plantilla…</div>
    <!-- o, con panel: -->
    <div class="split">
      <div class="page">…</div>
      <aside class="panel">…</aside>
    </div>
  </main>
</div>
```

- La barra lateral es un componente único. Ninguna vista la modifica salvo para marcar el ítem activo y actualizar contadores.
- No hay barra superior. Las migas de pan viven dentro del encabezado de las fichas.
- La búsqueda global es «Buscar o ir a…» (⌘K) en la barra lateral.

## Encabezado de página (`.ph`)

```html
<div class="ph">
  <div class="ph-text"><h1 class="h1">Servidores MCP</h1></div>
  <div class="ph-actions">
    <button class="btn btn-primary">Agregar servidor</button>
    <button class="btn btn-icon" aria-label="Más acciones">…</button>
  </div>
</div>
```

- Título: el nombre de la sección, igual al de la barra lateral.
- **Sin subtítulo** salvo que diga algo que cambia (Inicio: «6 cosas esperan una decisión»).
- Acciones: como máximo **un primario, dos secundarios y un «…»**.

## Plantilla A · Colección con panel

**Se usa en:** Servidores MCP, Skills, Clientes, Automatizaciones (incluido Historial), Actividad, Memoria (sin panel), Proyectos (sin panel: las filas abren la ficha).

| Zona | Contenido | Reglas |
|---|---|---|
| 1 · Encabezado | Título + 1 primaria + «…» | |
| (aviso) | Un `.banner` si algo necesita atención | Máximo uno |
| 2 · Barra | `.seg` de estado/tipo + `.search` + hasta 2 selectores | Se envuelve en ventanas angostas |
| 3 · Lista | `.list` de `.row` | Cabecera de columnas si hay más de 2 metadatos |
| 4 · Panel | Ver y editar el elemento seleccionado | Se abre al hacer click en la fila |

**Cuándo una colección no tiene panel:** cuando el elemento tiene su propia ficha (Proyectos, resultados de Memoria) o cuando no hay nada que editar.

## Plantilla B · Ficha

**Se usa en:** Proyecto, Persona, Empresa, Reunión, Documento, Nota.

| Zona | Contenido | Reglas |
|---|---|---|
| Migas | «Sección /» | Solo un nivel hacia arriba |
| 1 · Identidad | Avatar + título (editable en línea) + chip de estado + metadatos en una línea | Título en una línea con elipsis |
| Acciones | 1 primaria, «Compartir» si aplica, «…» | Editar detalles va en «…» o en la columna de datos |
| 2 · Pestañas | Máximo 5 | Opcional si la ficha cabe en una sola vista |
| 3 · Contenido | Lo que muestra la pestaña | Listas de filas, prosa con `.prose` |
| 4 · Columna de datos | Detalles (`.dl`), interruptores relevantes, Conexiones | 280–340 px; se apila debajo en ventanas angostas |

Las pestañas de proyecto son fijas: **Resumen, Contenido, Tareas, Decisiones, Colaboración.**

La pestaña Colaboración reemplaza las zonas 3 y 4 por `.collab`, a todo el ancho: canales (220 px) › hilos del canal › hilo seleccionado con su resolución propuesta y el campo para escribir. Es la única pestaña sin columna de datos.

## Plantilla C · Configuración

**Se usa en:** Ajustes (única).

- Índice de secciones a la izquierda (200 px), con estilo de ítem de navegación.
- Cada sección es una `.list` de **filas de ajuste**: etiqueta y una línea de ayuda a la izquierda, control a la derecha.
- Los interruptores y campos guardan solos. Las acciones de mantenimiento son botones secundarios que ejecutan y avisan con un toast.
- Las opciones avanzadas van en un `<details>` «Opciones avanzadas» al final de la sección.

Secciones fijas: **General, Fuentes, IA y procesamiento, Automatizaciones, Colaboración y red, Integraciones, Respaldos, Sistema.** Un ajuste nuevo entra en una de ellas; no se crea una sección para un solo ajuste.

## Plantilla D · Bandeja

**Se usa en:** Inicio (única).

- Saludo + una línea de estado general («7 cosas esperan una decisión. Todo lo demás está funcionando.»).
- **Pendientes:** lista agrupada por tipo (Conexiones, Propuestas de agentes, Memoria). Propuestas de agentes incluye los debates que esperan decisión y las entregas con acciones propuestas. Cada fila tiene **una** acción que resuelve o lleva a resolver el pendiente. Cuando se resuelve, la fila desaparece.
- Columna derecha: «Hoy» (automatizaciones del día) y «Proyectos recientes». Nada más.
- Inicio no tiene acciones de creación ni configuración.

## Reglas de layout (L1–L10)

| # | Regla |
|---|---|
| L1 | Toda vista usa una plantilla A–D. No se agregan zonas. |
| L2 | Un botón primario por vista. Hasta dos secundarios. El resto, en «…». Excepción: un bloque de decisión dentro de un panel o de un hilo (autorizar cuenta, aprobar acciones propuestas, aprobar una resolución) lleva su propio primario compacto. |
| L3 | Las colecciones son listas de filas. Tarjetas solo en Inicio y en bloques de ayuda dentro de paneles. |
| L4 | Un solo aviso de página. Nunca un aviso dentro de una fila o tarjeta: el estado va en un chip. |
| L5 | Un solo contenedor con scroll por zona. Las tablas anchas hacen scroll horizontal dentro de su caja (`.scroll-x` + `min-width`); la página, nunca. |
| L6 | Títulos de fila en una línea con elipsis y el texto completo en `title`. Descripciones: máximo dos líneas (`.clamp2`). |
| L7 | Todo hijo flexible lleva `min-width: 0`. Rutas e IDs largos se acortan por el medio (`~/Library/…/config.json`). |
| L8 | Solo tokens de `ah.css`. Un valor de color, radio o tamaño escrito a mano es un error de revisión. |
| L9 | Toda lista tiene estado de carga, vacío y error, cada uno con una acción. |
| L10 | Se prueba a 960 px y a 1440 px de ancho. Si algo se corta o desborda en alguno, no está terminado. |

## Comportamiento por ancho

| Ancho | Comportamiento |
|---|---|
| ≥ 1280 px | Diseño completo: barra lateral + contenido + panel o columna de datos |
| 1100–1279 px | El contenido se angosta; columnas de lista prescindibles se ocultan |
| < 1100 px | El panel y la columna de datos se apilan debajo del contenido a todo el ancho |
| < 960 px | Fuera de soporte para la app de escritorio; nada debe romperse, pero no se optimiza |

Columnas que se ocultan primero, en este orden: personas (avatares), contenido (conteos), duración. Nunca se ocultan título ni estado.
