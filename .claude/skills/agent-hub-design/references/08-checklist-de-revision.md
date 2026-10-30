# Checklist de revisión

Para revisar cualquier cambio de front (propio o de un agente) antes de darlo por terminado. Cada punto es sí/no. Un «no» bloquea.

## Ubicación y lógica

- [ ] La función está donde indica el árbol de decisión (Reglas de UX).
- [ ] No duplica una acción, un dato editable o un aviso que ya existe en otra parte de la vista.
- [ ] No agrega destinos a la barra lateral ni pestañas por encima de 5 (la ficha de proyecto tiene 6 por excepción; no se suma ninguna más).
- [ ] Si algo necesita la atención de la persona, aparece en Inicio › Pendientes y como chip en el elemento.
- [ ] Ningún ajuste nuevo vive fuera de Ajustes (salvo el propio de un elemento, en su panel).
- [ ] La colaboración aparece solo en Proyecto › Colaboración; ningún destino ni lista de hilos fuera de la ficha.
- [ ] Nada de la colaboración llega a Inicio: no hay propuestas de resolución, chips «Espera tu decisión» ni `.badge.attn` por hilos pendientes.

## Plantilla y layout

- [ ] La vista usa una plantilla A–D sin zonas extra.
- [ ] Un solo botón primario visible; como máximo dos secundarios; el resto en «…».
- [ ] Como máximo un aviso de página.
- [ ] Las colecciones son listas de filas; cada fila tiene un título, un detalle, un estado y como mucho una acción.
- [ ] Sin scroll horizontal de página a 960 y 1440 px. Las tablas anchas hacen scroll dentro de su caja.
- [ ] Ningún texto se desborda: títulos con elipsis y `title`, descripciones con `.clamp2`, `min-width: 0` en hijos flexibles.

## Interacción

- [ ] Editar ocurre en línea o en el panel, no en un modal.
- [ ] Los modales son solo para crear (≤ 5 campos) o confirmar lo irreversible.
- [ ] Las acciones reversibles se ejecutan al instante y ofrecen Deshacer.
- [ ] Cada panel usa un solo modelo de guardado (automático o explícito).
- [ ] Hay estados de carga, vacío, vacío por filtro y error, cada uno con una acción.
- [ ] Todo es alcanzable con Tab, con foco visible; Escape cierra la capa superior.
- [ ] En listas con selección múltiple: cada `.check` tiene `aria-label` con el nombre, la `.bulkbar` aparece solo con selección y sus acciones se aplican sin confirmar.
- [ ] En listas con sin ver: abrir marca como visto, J/K navegan y no se disparan con el foco en un campo.
- [ ] En colaboración: la pestaña es solo para ver; no hay campo para escribir, botones de aprobar o pedir otra ronda, «Nuevo canal» ni acciones sobre hilos. Solo el «…» del canal ofrece las 4 acciones de recuperación, con confirmación. Ningún hilo abierto al entrar; tocar el hilo o su X abre y cierra la columna.
- [ ] La pestaña Notas es solo lectura y «Personas con acceso» vive en el panel de «Compartir».

## Sistema visual

- [ ] Solo clases y variables de `ah.css`. Ningún hex, `px` de color, radio o tamaño de fuente escrito a mano.
- [ ] Ningún control nativo con estilo distinto (`select`, `input type=date`).
- [ ] Los estados usan el chip correcto; Error ≠ Bloqueado.
- [ ] Iconos de 16/14 px con trazo; los botones de solo icono tienen `aria-label`.
- [ ] Funciona en tema claro y oscuro sin cambios en el marcado.
- [ ] Contraste de texto ≥ 4,5:1 (nada más claro que `--text-3`).

## Redacción

- [ ] Voseo en todos los textos.
- [ ] Botones con verbo y objeto.
- [ ] Ningún valor interno visible (enums, snake_case, IDs) como texto principal.
- [ ] Sin subtítulos ni párrafos que expliquen la interfaz.
- [ ] Fechas relativas en listas, absolutas en paneles.
- [ ] Errores con causa y acción.
