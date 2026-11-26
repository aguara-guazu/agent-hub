# Agent Hub 0.15.8

## Asistentes

- Al seleccionar un pendiente o una microtarea, el chat conserva su contexto entre preguntas. Usa la terminal, el modelo y el nivel de razonamiento elegidos en Ajustes, con los servidores MCP y las skills de esa terminal.
- El asistente verifica en Jira los tickets que generan avisos y vuelve a consultar el ticket seleccionado cuando preguntás por su estado. Si la cuenta pierde acceso a una tarea, el Hub retira el pendiente y conserva el historial. Si Jira está temporalmente caído, espera a verificar el estado antes de volver a avisar.
- Para atender un mensaje de Slack sobre un cliente, el asistente consulta primero Jira y completa la respuesta con la memoria del proyecto cuando necesita más contexto.
- El asistente puede crear y coordinar equipos del proyecto en el Hub, leer sus resultados y responder sus preguntas. Las preferencias del proyecto siguen controlando qué fuentes pueden usar los modelos externos.
- El chat y las microtareas pueden seguir trabajando durante todo el día. Se eliminó el límite diario de turnos del Hub. Los turnos siguen apareciendo en el historial de consumo.

## Proyectos y preferencias

- Podés archivar proyectos para retirarlos de los pendientes, avisos y automatizaciones. Su historial se conserva y podés reactivar el seguimiento desde **Proyectos → Archivados**.
- En **Ajustes** podés activar cada módulo por separado y configurar los avisos de los asistentes.
- Cuando se acerca una reunión, el escritorio puede avisarte para que decidas si querés grabarla. En Memoria podés revisar quién habló. En Ajustes elegís si recibís esos avisos y cuánto tiempo conservás el audio.
- La sincronización de fuentes de Google renueva el acceso durante la lectura.
