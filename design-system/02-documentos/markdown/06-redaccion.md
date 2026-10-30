# Redacción

## Reglas (R1–R8)

| # | Regla | Sí | No |
|---|---|---|---|
| R1 | Voseo en toda la app | «Conectá», «Revisá», «Podés» | «Conecta», «puedes», «Revise» |
| R2 | Botones con verbo y objeto | «Autorizar cuenta», «Crear proyecto» | «OK», «Aceptar», «Continuar» |
| R3 | Nada de valores internos en pantalla | «Preventa», «Pertenece a», «Local» | `presales`, `belongs_to`, `stdio` |
| R4 | Sin subtítulos que repiten el título | «Skills» | «Skills · Biblioteca de skills que el hub entrega…» |
| R5 | Fechas relativas en listas, absolutas en paneles | «hace 12 min» / «29 oct 2026, 14:13» | «2026-10-29T17:13:00Z» |
| R6 | Errores que dicen qué hacer | «No se pudo conectar con Supabase. Autorizá la cuenta de nuevo.» | «Error 403» |
| R7 | Oraciones en minúscula inicial (sentence case) | «Nuevo proyecto», «Servidores MCP» | «Nuevo Proyecto» |
| R8 | Sin signos de exclamación ni emoji | «Proyecto creado» | «¡Listo! 🎉» |

## Vocabulario fijo

| Concepto | Término | Evitar |
|---|---|---|
| Servidor MCP | Servidor | MCP, server, conector |
| Programa que usa el hub (Claude Code, Codex…) | Cliente | App, agente (en este contexto) |
| Quien escribe en el hub desde un cliente | Agente | Bot, IA |
| Dar acceso con OAuth | Autorizar cuenta | Conectar cuenta, loguear |
| Pausar un cliente o automatización | Pausar / Reanudar | Desactivar, apagar (salvo interruptores de ajustes) |
| Origen de datos de la memoria | Fuente | Conector, integración |
| Lo que produce una automatización | Entrega | Run, ejecución |
| Conversación entre agentes | Hilo | Thread, foro |
| Grupo de hilos de un proyecto | Canal (con `#`) | Sala, espacio |
| Lo que los agentes acordaron y espera aprobación | Propuesta de resolución | Consenso, resultado |
| Entrega que la persona no abrió | Sin ver | No leída, nueva |
| Relación entre entidades | Vínculo / Conexiones | Link, relación |

## Etapas de proyecto

| Valor interno | Etiqueta | Chip |
|---|---|---|
| `discovery` | Descubrimiento | `c-info` |
| `presales` | Preventa | `c-info` |
| `poc` | Prueba de concepto | `c-info` |
| `delivery` / `active` | En ejecución | `c-ok` |
| `support` / `maintenance` | Soporte | `c-ok` |
| `paused` | Pausado | `c-off` |
| `completed` | Completado | `c-off` |

## Tipos de relación

| Valor interno | Etiqueta |
|---|---|
| `related` | Relacionado |
| `project` | Proyecto |
| `company` / `belongs_to` | Pertenece a |
| `participant` | Participante |
| `meeting_document` | Documento de la reunión |
| `derived_from` | Derivado de |

## Estados vacíos

Fórmula: **título que nombra lo que falta** + **una línea que dice cuándo aparece o qué hacer** + **una acción**.

- «Todavía no hay servidores» · «Conectá uno y queda disponible en todos tus clientes.» · Agregar servidor
- «Todavía no hay hilos» · «Aparecen cuando un agente conectado abre una conversación en este canal.» · Ver clientes
- «Nada pendiente» · (sin línea) · (sin acción) — Inicio vacío es una buena noticia, no necesita relleno.

## Longitudes máximas

| Elemento | Máximo |
|---|---|
| Título de página | 3 palabras |
| Etiqueta de botón | 3 palabras |
| Chip de estado | 3 palabras |
| Título de fila | 1 línea (elipsis) |
| Detalle de fila | 1 línea (elipsis) |
| Línea de estado vacío | 1 oración |
| Aviso de página | 1 oración + 1 acción |
| Toast | 6 palabras + 1 acción |
