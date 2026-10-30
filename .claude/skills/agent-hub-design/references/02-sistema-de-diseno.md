# Sistema de diseño

Todo el sistema vive en un solo archivo: **`ah.css`**. Define los tokens (variables CSS) para los dos temas y las clases de los componentes. Ningún componente usa un color, tamaño o radio escrito a mano: todo sale de `var(--*)`.

**Regla de oro:** si necesitás algo que no está en `ah.css`, primero se agrega al sistema (con su documentación aquí) y después se usa. Nunca al revés.

## Temas

El tema oscuro es el predeterminado. El claro se activa con la clase `t-light` en la raíz (`t-dark` vuelve al oscuro). Los mismos componentes funcionan en ambos sin cambios porque solo leen variables.

```html
<div class="ah shell t-dark">…</div>   <!-- oscuro -->
<div class="ah shell t-light">…</div>  <!-- claro -->
```

La preferencia «Del sistema» en Ajustes aplica `t-light` o `t-dark` según `prefers-color-scheme`.

## Color

### Superficies y texto

| Token | Oscuro | Claro | Uso |
|---|---|---|---|
| `--bg` | `#0E1110` | `#F4F6F5` | Fondo de la app |
| `--surface` | `#151918` | `#FFFFFF` | Listas, tarjetas, paneles, barra lateral |
| `--surface-2` | `#1B201F` | `#F0F3F2` | Hover, cabeceras de lista, fila seleccionada |
| `--surface-3` | `#232928` | `#E6EBE9` | Tags, pistas de interruptor, avisos emergentes |
| `--border` | `#262C2B` | `#DFE5E2` | Divisores y bordes de contenedores |
| `--border-strong` | `#353D3B` | `#C9D2CE` | Bordes de controles |
| `--text` | `#EDF1EF` | `#121614` | Texto principal |
| `--text-2` | `#B3BDB8` | `#44504A` | Texto secundario, descripciones |
| `--text-3` | `#8A9590` | `#5C6762` | Metadatos, etiquetas, placeholders |

`--text-3` es el gris más claro permitido para texto: cumple 4,5:1 sobre `--surface` en ambos temas. No hay un `--text-4`.

### Acento

| Token | Oscuro | Claro | Uso |
|---|---|---|---|
| `--accent` | `#A7E7C8` | `#17704B` | Botón primario, interruptor activo, pestaña activa |
| `--accent-hover` | `#C2F2DA` | `#115C3D` | Hover del primario |
| `--accent-ink` | `#0B2419` | `#FFFFFF` | Texto sobre `--accent` |
| `--accent-text` | `#A7E7C8` | `#146543` | Enlaces y texto de acento |
| `--accent-weak` | `#172E26` | `#E2F3EA` | Ítem activo de la barra lateral, resaltado de búsqueda |
| `--accent-border` | `#2E5A47` | `#B3DCC6` | Borde de foco y de elementos destacados |

El acento se usa con moderación: **una** acción primaria por vista, el estado activo de la navegación y los enlaces. Nunca como fondo decorativo.

### Estados

Cada estado tiene tres tokens: color (`--x`), fondo débil (`--x-weak`) y borde (`--x-border`).

| Estado | Clase de chip | Significa | Ejemplos |
|---|---|---|---|
| Correcto | `c-ok` | Funciona, sin acción | Conectado, Sincronizado, Ejecutada, Entregada |
| Atención | `c-warn` | Necesita algo de la persona | Requiere autorización, Reinicio pendiente, Bloqueada (tarea) |
| Error | `c-danger` | Falló | Error, Falló, No responde |
| Bloqueado | `c-locked` | Lo detuvo una política | Llamada bloqueada, Solo lectura |
| En curso | `c-info` | Está pasando ahora o va a pasar | Procesando, Importando, En 2 h, En curso |
| Apagado | `c-off` | Desactivado a propósito | Pausado, Apagado, Completado, Por hacer |

**Error y Bloqueado nunca comparten color.** Un error es una falla; un bloqueo es una política funcionando.

Los chips siempre llevan **punto + texto**. El color nunca es el único portador del significado.

## Tipografía

- **Geist** para la interfaz. **Geist Mono** para identificadores, rutas, comandos, horas en columnas y código.
- Pesos: 400, 500 y 600. No se usa 700.

| Token | Tamaño | Uso |
|---|---|---|
| `--fs-xl` | 22 px / 600 | Título de página (`.h1`) |
| `--fs-lg` | 16 px / 600 | Título de sección (`.h2`) |
| `--fs-md` | 14 px / 500 | Título de fila, texto destacado (`.h3`, `.row-title`) |
| `--fs-sm` | 13 px / 400 | Texto base, controles |
| `--fs-xs` | 12 px / 400–500 | Metadatos, chips, etiquetas de campo |
| mono | 12 px | Identificadores |

Nada por debajo de 12 px. No hay tamaños intermedios. Interlineado base 1.45; prosa larga 1.6 con `.prose` (máx. 68 caracteres por línea).

## Espacio, radios y medidas

| Token | Valor | | Token | Valor |
|---|---|---|---|---|
| `--sp-1` | 4 px | | `--r-sm` | 6 px (controles) |
| `--sp-2` | 8 px | | `--r` | 10 px (contenedores) |
| `--sp-3` | 12 px | | `--r-full` | 999 px (chips, avatares redondos) |
| `--sp-4` | 16 px | | `--control-h` | 32 px |
| `--sp-5` | 24 px | | `--row-h` | 52 px |
| `--sp-6` | 32 px | | `--side-w` | 232 px |
| `--sp-7` | 48 px | | `--panel-w` | 440 px |

- Página: máximo 1240 px de ancho, márgenes de 40 px, 20 px entre bloques.
- Entre secciones de una misma vista: 24 px.
- Movimiento: `--dur` 160 ms con `--ease`. Sin rebotes ni animaciones decorativas.
- Sombras: solo `--shadow-pop`, y solo en capas flotantes (menú, modal, aviso emergente, paleta ⌘K).

## Iconos

- Trazo de 1,75 px, esquinas redondeadas, 16 px (`.ico`) o 14 px (`.ico-sm`), `currentColor`.
- Un icono acompaña un texto; solo va sin texto en botones de `.btn-icon`, y entonces lleva `aria-label`.
- Nunca emoji como icono.
- Los íconos de la barra lateral son fijos; una vista nueva no inventa uno sin agregarlo al sistema.

## Componentes

### Botón — `.btn`

| Variante | Clase | Cuándo |
|---|---|---|
| Primario | `.btn .btn-primary` | La acción principal de la vista. **Máximo uno visible.** |
| Secundario | `.btn` | Acciones frecuentes. Máximo dos visibles junto al primario. |
| Fantasma | `.btn .btn-ghost` | Cancelar, acciones terciarias dentro de paneles |
| Destructivo | `.btn .btn-danger` | Solo en confirmaciones y en zonas de peligro |
| Icono | `.btn .btn-icon` | El menú «…»; siempre con `aria-label` |
| Compacto | `+ .btn-sm` | Dentro de filas, paneles y avisos |
| Dividido | `.btn-group` | Primario con menú de variantes («Nuevo proyecto ▾») |

```html
<button class="btn btn-primary" type="button">Nuevo proyecto</button>
<button class="btn btn-icon" type="button" aria-label="Más acciones">…</button>
```

Etiquetas: verbo + objeto («Autorizar cuenta», «Crear proyecto»). Nunca «OK», «Aceptar» ni «Continuar».

### Campo — `.field` + `.label` + `.input`

```html
<div class="field">
  <label class="label" for="p-name">Nombre</label>
  <input class="input" id="p-name">
  <span class="hint">Opcional: texto de ayuda breve</span>
</div>
```

- La etiqueta va siempre arriba, nunca solo un placeholder.
- `textarea.input` para texto largo; `.input.mono` para URL, rutas, horas.
- **Selector propio** (`.btn.select` con «Etiqueta: **Valor**» y chevron) en lugar de `<select>` nativo.
- Búsqueda: `.search` con icono a la izquierda; ancho entre 200 y 360 px.

### Segmentado — `.seg`

Filtra **la misma lista** por estado o tipo. Cada opción puede llevar contador (`.count`). Entre 2 y 5 opciones. La opción activa lleva `aria-pressed="true"`.

### Pestañas — `.tabs` + `.tab`

Cambian **el contenido** de una ficha. Máximo 5. La activa lleva `.is-active`. Si cabe en un `.seg`, no es una pestaña.

### Chip de estado — `.chip` + `.c-*`

Ver la tabla de estados. Un chip por fila. Texto de 1 a 3 palabras.

### Tag — `.tag`

Marca el **tipo** de una cosa (Reunión, Documento, HTTP, v2). Neutro, sin color de estado.

### Contador — `.badge`, `.badge.attn`

Número junto a un ítem de navegación, un canal o una opción del segmentado. `.attn` solo cuando el número significa «necesita atención».

### Avatar — `.av`

Iniciales (2 letras) sobre uno de 6 tonos (`.hue1`…`.hue6`), elegidos por hash del nombre para que dos elementos vecinos no se parezcan. `.av-sm` (24 px) en filas compactas, `.av-round` para personas, cuadrado para proyectos, clientes y servidores.

### Fila de lista — `.list` + `.row`

La unidad de casi toda la app. Anatomía, de izquierda a derecha:

1. **Identidad** (opcional): avatar o icono de 32 px.
2. **Título + detalle** (`.row-main` › `.row-title` + `.row-sub`): una línea cada uno, con elipsis.
3. **Metadatos** (`.row-meta`): tag de tipo, chip de estado, fecha relativa.
4. **Acción** (opcional): un interruptor, un botón compacto o un «…».

```html
<div class="list">
  <div class="row-head">Servidor …</div>
  <a class="row" href="…">
    <span class="av hue2">AR</span>
    <div class="row-main">
      <span class="row-title">Atlassian Rovo</span>
      <span class="row-sub">Jira y Confluence · HTTP</span>
    </div>
    <span class="chip c-ok">Conectado</span>
  </a>
</div>
```

- La fila entera es el objetivo del click y abre el panel o la ficha.
- Si la fila contiene controles (interruptor, botón), la fila es un `div` y el título es el enlace; nunca un control dentro de un `<a>`.
- `.row.is-selected` marca la fila cuyo panel está abierto.
- `.row-head` agrupa (con texto) o rotula columnas.

### Sin ver y selección múltiple — `.unread`, `.check`, `.bulkbar`

Para colecciones que la persona revisa en tanda (hoy, Automatizaciones › Historial).

```html
<div class="bulkbar" role="region" aria-label="Selección">
  <strong>3 seleccionadas</strong>
  <button class="btn btn-sm" type="button">Marcar como vistas</button>
  <button class="btn btn-sm btn-ghost" type="button">Marcar como no vistas</button>
  <a class="xs" href="#">Seleccionar las 6 sin ver</a>
  <button class="btn btn-sm btn-icon btn-ghost" type="button" aria-label="Quitar selección">×</button>
</div>
<div class="list scroll-x">
  <div class="row-head"><input class="check" type="checkbox" aria-label="Seleccionar todas las visibles"><span style="width: 8px"></span><span style="flex: 1">Hoy · 4 sin ver</span>…</div>
  <div class="row is-unread">
    <input class="check" type="checkbox" aria-label="Seleccionar Resumen de guardias">
    <span class="unread" aria-label="Sin ver"></span>
    <div class="row-main"><span class="row-title">Resumen de guardias</span><span class="row-sub">Soporte administrado Lumen</span></div>
    <span class="chip c-ok">Entregada</span>
  </div>
  <div class="row"><input class="check" type="checkbox" aria-label="…"><span class="unread is-read" aria-hidden="true"></span>…</div>
</div>
```

- `.row.is-unread` pone el título en negrita y muestra el punto `.unread`; una fila vista lleva `.unread.is-read`, que conserva el espacio para que las columnas no salten.
- `.check` va primero en la fila y en la `.row-head` («Seleccionar todas las visibles»). Cada casilla tiene `aria-label` con el nombre del elemento. Hacer click en la fila fuera de la casilla abre el panel; la casilla solo selecciona.
- `.bulkbar` aparece arriba de la lista solo mientras hay selección: contador en `<strong>`, como máximo dos acciones `.btn-sm`, un enlace para ampliar la selección y la X para quitarla. No lleva primario.
- Abrir una entrega en el panel la marca como vista. El pie del panel lleva «Anterior» (K) y «Siguiente sin ver» (J) con `.kbd`; J y K funcionan en toda la vista mientras el foco no esté en un campo.
- El contador de la opción del segmentado que agrupa lo sin ver usa `.badge.attn` en lugar de `.count`.
- `ah.css` tiene además `.row-check` y `.bulkbar-count`, de una versión anterior de esta sección; usá `.check` y `<strong>` como en el ejemplo.

### Colaboración: canales › hilos › debate — `.collab`

Tres columnas dentro de la pestaña Colaboración de un proyecto. Bajo 1100 px los canales pasan a una fila arriba.

```html
<div class="collab">
  <nav class="collab-chans" aria-label="Canales del proyecto">
    <div class="nav-group">Canales</div>
    <a class="nav-item is-active" href="#"><span class="chan-hash">#</span>infra<span class="badge attn">1</span></a>
    <a class="nav-item" href="#"><span class="chan-hash">#</span>datos<span class="badge">2</span></a>
    <div style="flex: 1"></div>
    <button class="btn btn-sm btn-ghost" type="button">Nuevo canal</button>
  </nav>
  <section class="collab-threads" aria-label="Hilos de #infra">
    <div class="collab-head">… nombre del canal, descripción, avatares de agentes · .seg Abiertos / Resueltos</div>
    <div class="list">
      <div class="row is-selected"><div class="row-main">
        <span class="row-title">¿NAT Gateway por zona o uno compartido?</span>
        <span class="row-sub">3 agentes · 4 mensajes · hace 4 min</span>
        <span class="chip c-warn">Espera tu decisión</span>
      </div></div>
    </div>
  </section>
  <section class="collab-thread" aria-label="Hilo seleccionado">
    <div class="collab-head">… título (.h3.clamp2), canal · quién lo inició · «…»</div>
    <div class="msgs">
      <div class="msg"><span class="av av-sm hue3">CC</span><div class="msg-body">
        <div class="msg-meta"><b>Claude Code</b><span class="tag">Propuesta</span><span class="xs t3">13:52</span></div>
        <p class="prose">…</p>
      </div></div>
    </div>
    <div class="resolution">
      <span class="eyebrow">Propuesta de resolución · 3 de 3 agentes de acuerdo</span>
      <span class="md">NAT Gateway por zona en producción y uno compartido en staging.</span>
      <div><button class="btn btn-primary btn-sm" type="button">Aprobar y registrar decisión</button><button class="btn btn-sm" type="button">Pedir otra ronda</button></div>
    </div>
    <div class="composer"><input class="input" aria-label="Mensaje para el hilo" placeholder="Escribí en el hilo para sumar contexto o reorientar el debate"><button class="btn" type="button">Enviar</button></div>
  </section>
</div>
```

- Canal: `.nav-item` con `.chan-hash`; el contador es `.badge.attn` si hay un hilo que espera decisión y `.badge` si solo hay mensajes nuevos.
- Hilo en la lista: título, «N agentes · N mensajes · fecha relativa» y un chip: «Espera tu decisión» `c-warn` o «En debate» `c-info`. Los resueltos se ven con el segmentado, no mezclados.
- Mensaje: avatar, autor en `<b>`, tipo en `.tag` (Propuesta, Objeción, Dato, Acuerdo) y hora. Los mensajes de la persona usan el mismo `.msg` con su avatar redondo.
- `.resolution` aparece solo cuando los agentes propusieron una resolución; es el bloque de decisión del hilo y lleva el único primario compacto de la pestaña. Al aprobar, la decisión se registra en Proyecto › Decisiones y el hilo pasa a Resueltos.
- `.composer` va siempre al pie del hilo; Enter envía. Nunca un modal para escribir.
- `.collab-full` quita el borde y el radio cuando `.collab` ocupa todo el alto disponible.

### Interruptor — `.switch`

`<button role="switch" aria-checked>`. Aplica al instante, sin botón «Guardar». No lleva texto «Habilitado» al lado: el interruptor ya lo dice.

### Aviso de página — `.banner`, `.banner-warn`, `.banner-danger`

**Uno por vista**, arriba del contenido, agrupando todos los casos («3 servidores necesitan…») con una sola acción. Desaparece cuando se resuelve. Nunca dentro de una fila o tarjeta.

### Panel de detalle — `.panel`

Columna derecha de 440 px (`--panel-w`; 520 px para editores de texto). Tres zonas: `.panel-h` (identidad + estado + acciones), `.panel-b` (campos), `.panel-f` (Descartar / Guardar cambios, o «Los cambios se guardan solos»). Bajo 1100 px se apila a todo el ancho.

### Lista de propiedades — `.dl`

Pares etiqueta/valor en dos columnas (120 px + resto). Para metadatos de solo lectura en paneles y fichas.

### Menú — `.pop.menu` + `.menu-item`

Acciones secundarias de un elemento. Lo destructivo va último, separado por `.menu-sep` y con `.danger`.

### Aviso emergente — `.toast`

Abajo a la izquierda, 6 segundos. Confirma una acción y ofrece **Deshacer**. Uno a la vez.

### Modal — `.pop.modal`

Máximo 480 px. Título, hasta 5 campos, pie con Cancelar + acción primaria. Ver «Patrones» para cuándo se permite.

### Estado vacío — `.empty`

Icono + título + una línea + una acción. Ver «Patrones».

## Lo que el sistema no tiene (a propósito)

- **Tarjetas de estadística (KPI tiles).** Los números van dentro de los filtros o en el texto.
- **Acordeones dentro de listas.** El detalle se abre en el panel.
- **Tooltips con contenido largo.** Un tooltip es una línea.
- **Pestañas verticales** fuera de Ajustes.
- **Bordes de color a la izquierda** como acento decorativo.
- **Gradientes** y sombras en contenedores estáticos.
