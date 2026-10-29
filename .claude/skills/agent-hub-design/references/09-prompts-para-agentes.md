# Prompts para agentes de front

Prompts listos para usar con los agentes que implementan el front de Agent Hub (Claude Code, Codex CLI, Gemini CLI u otros). Asumen que la skill **`agent-hub-design`** está instalada en el repo (`.claude/skills/agent-hub-design/`) o que la carpeta `references/` de la skill está disponible.

Los textos entre `[corchetes]` se reemplazan.

## 1 · Bloque para CLAUDE.md / AGENTS.md del repo de front

```markdown
## Diseño y UX de Agent Hub

Antes de tocar cualquier archivo de interfaz, cargá la skill `agent-hub-design` y seguila.

- Toda vista usa una de las 4 plantillas (Colección con panel, Ficha, Configuración, Bandeja).
- Solo clases y variables de `src/styles/ah.css`. Nada de colores, radios ni tamaños a mano.
- Un botón primario por vista. Como máximo 5 pestañas. No se agregan destinos a la barra lateral.
- Editar en línea o en panel lateral. Modal solo para crear (≤ 5 campos) o confirmar lo irreversible.
- Lo reversible se ejecuta al instante con «Deshacer»; no se piden confirmaciones.
- Un solo aviso por página; el estado de cada elemento va en un chip.
- Voseo. Ningún valor interno (enums, snake_case) visible.
- Si una tarea pide algo que viola estas reglas, no lo implementes: explicá qué regla viola y proponé la alternativa del sistema.
- Antes de terminar, recorré `references/08-checklist-de-revision.md` y reportá el resultado.
```

## 2 · Implementar una función nueva

```text
Necesito agregar [descripción de la función] en Agent Hub.

Antes de escribir código:
1. Cargá la skill agent-hub-design.
2. Recorré el árbol de decisión de references/05-reglas-de-ux.md y decime en qué
   destino, plantilla y zona va esta función, y por qué.
3. Listá qué componentes de ah.css vas a usar. Si falta alguno, frená y proponelo
   como agregado al sistema en lugar de inventarlo.
4. Si la función implica un modal, una confirmación, una pestaña nueva, un destino
   nuevo o un segundo primario, explicá por qué es necesario o cambiá el enfoque.

Después implementá, cubrí los estados de carga, vacío y error, y cerrá con el
checklist de revisión marcado punto por punto.
```

## 3 · Migrar una vista existente al nuevo sistema

```text
Migrá la vista [nombre / ruta] al rediseño de Agent Hub.

1. Cargá la skill agent-hub-design y leé la especificación de esa vista en
   references/07-especificacion-de-vistas.md (incluida la lista «No va»).
2. Compará con la implementación actual y listá: qué se elimina, qué se mueve a
   otro destino (y a cuál), qué modales se reemplazan por panel / en línea / Deshacer.
3. Reescribí la vista con la plantilla indicada y solo con clases de ah.css.
4. Traducí todos los valores internos según references/06-redaccion.md.
5. Verificá a 960 y 1440 px, en tema claro y oscuro, y adjuntá capturas.
6. Cerrá con el checklist de revisión.

No agregues nada que no esté en la especificación sin preguntarme.
```

## 4 · Revisar un cambio de front (PR o diff)

```text
Revisá este cambio de front de Agent Hub contra el sistema de diseño.

Cargá la skill agent-hub-design. Para cada problema reportá:
- archivo y línea,
- regla violada (L1–L10, U1–U15, R1–R8 o punto del checklist),
- qué ve o sufre la persona por ese problema,
- la corrección concreta usando componentes del sistema.

Ordená por gravedad: primero lógica y ubicación (UX), después interacción, después
visual, después redacción. No reportes preferencias personales que no estén en
las reglas. Si el cambio está bien, decilo en una línea.
```

## 5 · Auditar la app completa

```text
Auditá el front completo de Agent Hub contra la skill agent-hub-design.

Para cada destino de la arquitectura (Inicio, Proyectos, Proyecto, Memoria,
fichas de entidad, Colaboración, Automatizaciones, Servidores MCP, Skills,
Clientes, Actividad, Ajustes):
1. Compará con su especificación y su lista «No va».
2. Contá: botones primarios visibles, modales que se pueden abrir, avisos de
   página, pestañas, valores internos visibles, colores escritos a mano.
3. Marcá cada desvío con la regla que viola.

Entregá una tabla por vista y un resumen con los 10 desvíos de mayor impacto
para la persona, ordenados.
```

## 6 · Proponer un componente nuevo para el sistema

```text
Para [necesidad] creo que hace falta un componente que ah.css no tiene.

Cargá la skill agent-hub-design y:
1. Demostrá que ningún componente existente (o combinación) lo resuelve.
2. Describí el componente: nombre de clase, anatomía, variantes, estados,
   tokens que usa (solo existentes), comportamiento de teclado y accesibilidad.
3. Indicá en qué vistas se usaría y qué reemplaza.
4. Escribí el CSS usando solo variables de ah.css y la entrada para
   references/02-sistema-de-diseno.md.

No lo uses en ninguna vista hasta que lo apruebe.
```

## 7 · Diseñar una pantalla nueva (en el lienzo de diseño)

```text
Diseñá [pantalla] para Agent Hub en el lienzo, siguiendo el sistema existente:
mismo ah.css, misma barra lateral, una de las 4 plantillas, voseo, tema oscuro
con variante clara. Antes de dibujar, decime qué plantilla usás, qué va en cada
zona y qué dejás afuera. Usá datos de ejemplo coherentes con los proyectos
Northwind y Lumen. Nada de métricas decorativas, texto de relleno ni modales
para editar.
```

## 8 · Responder cuando el pedido contradice el sistema

Cuando una persona (o una tarea) pide algo que viola una regla, el agente responde con esta forma:

```text
Esto choca con la regla [U4: modal para editar]. Si lo hago así, [consecuencia
para la persona]. Propongo [alternativa del sistema: editar en el panel lateral
del servidor, con guardado explícito]. ¿Avanzo con la alternativa o preferís
mantener el pedido original y actualizamos la regla?
```
