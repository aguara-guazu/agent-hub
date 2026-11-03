# Agent Hub 0.14.4 — Invitación comprimida y carpeta obligatoria en proyectos compartidos

Versión de correcciones sobre 0.14.3.

## Invitaciones a proyectos compartidos

- La invitación se genera como un código de una sola línea con el prefijo
  `ahinv1.` (JSON de la invitación comprimido con Brotli y codificado en
  base64url). En las invitaciones reales medidas, el código es entre 28 % y 40 %
  más corto que el JSON y no se corta al copiarlo desde la terminal ni al
  pegarlo en Slack.
- Al unirse se acepta el código nuevo o el JSON `agenthub-invitation-v1` de
  versiones anteriores, desde la interfaz, la ruta HTTP y la herramienta MCP
  `shared_join`. El contenido firmado no cambia y las firmas se verifican igual
  que antes.
- El código se reconoce aunque llegue con comillas, bloques de código, saltos
  de línea, espacios o caracteres invisibles agregados al pegar.
- Un código truncado o corrupto, un texto con más de un código o una invitación
  que supere el tamaño máximo se rechazan con un mensaje claro, sin importar
  nada. Si el código no se puede generar, el cambio de membresía se revierte.

## Proyectos compartidos y agentes

- Aceptar un proyecto compartido exige una carpeta local, desde la interfaz, la
  ruta HTTP de unión o restauración y `shared_join`. Los proyectos ya aceptados
  sin carpeta muestran un aviso permanente y aparecen en `memory_context`.
- Las sesiones de los agentes resuelven su proyecto por la carpeta o por el
  canal o equipo asignado.
- Crear un proyecto desde un agente que ya tiene uno asignado, o con proyectos
  compartidos sin carpeta pendientes, responde 409 salvo que se indique
  `assigned_project_override` con un motivo, que queda auditado.
- Las rutas locales nunca salen del hub.

## Límites conocidos

- Las invitaciones de proyectos con muchas políticas siguen ocupando varios
  miles de caracteres: el tamaño lo determina el material criptográfico firmado.
- Una invitación de más de 32 MiB ya no se puede emitir ni importar como código.
- La comunicación entre hubs se verificó en una misma máquina, no a través de
  internet.
- El DMG para Mac con procesador Intel no se actualiza automáticamente.
