# Agent Hub 0.14.3 — Canales compartidos entre hubs y base de la actualización silenciosa

Versión de correcciones sobre 0.14.2.

## Colaboración entre hubs

- Los canales inter-hub quedan asociados al proyecto compartido en todos los
  hubs participantes. El creador anuncia el proyecto con un evento firmado; un
  hub de una versión anterior lo ignora y sigue sincronizando el canal.
- Al arrancar, al cambiar los miembros, al importar una invitación y al reanudar
  un proyecto pausado se asignan los canales sin proyecto cuando hay un único
  proyecto compartido válido.
- Si la membresía vence o se revoca, o si se borra el proyecto, el canal pasa a
  «Canales globales entre hubs sin proyecto» con el motivo, y vuelve a su
  proyecto cuando la membresía se renueva.
- El panel Compartir del proyecto muestra si el uso compartido está pausado y
  permite pausarlo o reanudarlo. La herramienta MCP `memory_shared_pause` hace lo
  mismo para los agentes.
- La herramienta MCP `chat_interhub_assign_project` permite al líder local
  asignar un canal inter-hub a un proyecto compartido.
- La interfaz ya no pide ni muestra el código de unión de los canales inter-hub;
  el código sigue disponible por MCP para el líder creador.

## Proyectos duplicados

- Crear o renombrar un proyecto con un título equivalente a uno existente
  (sin distinguir mayúsculas, espacios ni variantes Unicode) responde 409 con el
  proyecto existente; `allow_duplicate: true` permite crearlo a propósito.
- La herramienta MCP `memory_merge_projects` unifica un proyecto local dentro de
  otro: archiva el origen, mueve tareas, registros y referencias, y completa en
  el destino los campos vacíos. Si el destino es compartido, las fuentes,
  recuerdos, conectores y reglas del origen quedan en el proyecto archivado y se
  listan para publicarlas una por una; nada se publica automáticamente.
- Un proyecto unificado no acepta trabajo nuevo, pero sigue recibiendo lo que
  importan sus conectores de forma privada y se puede borrar.

## Continuidad de los agentes

- El gateway reintenta la conexión con la memoria del Hub cuando el core no
  acepta conexiones o está drenando, sin el bloqueo de 30 s posterior a un fallo
  de conexión.
- La colaboración de OpenCode se reconecta sola y conserva el cierre de sesión
  hasta poder entregarlo.

## Actualización automática

- Se incorpora, todavía sin activar, el código base de la actualización
  silenciosa: copias de la app por versión para los gateways, compuerta de
  admisiones durante una actualización y pista de nueva versión entre hubs.
- La publicación genera un manifiesto con sha256 y tamaño de cada artefacto,
  firmado solo si el repositorio tiene configurada la clave de firma.
- El actualizador de la app de escritorio no cambia en esta versión: la
  actualización sin cortar a los agentes todavía no está activa.

## Límites conocidos

- La comunicación entre hubs se verificó en una misma máquina, no a través de
  internet.
- El DMG para Mac con procesador Intel no se actualiza automáticamente.
