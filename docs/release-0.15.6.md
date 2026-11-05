# Agent Hub 0.15.6 — El proyecto compartido viaja con el canal entre hubs

Versión menor sobre 0.15.5.

## Canales entre hubs

- Si el hub creador tiene el canal asignado a un proyecto compartido, el hub que se une
  con el código recibe ese proyecto. El creador lo agrega a la política firmada del
  proyecto y le entrega la invitación por la conexión P2P autenticada de la unión. Hasta
  0.15.5 el canal podía quedar en un hub que no tenía el proyecto.
- El rol que se concede depende de la generación del código. `memory_chat_interhub_create`
  y `memory_chat_interhub_code` con `regenerate` aceptan `role` (`owner`, `maintainer` o
  `reader`). Si no se indica, el rol es `owner`. El rol owner no vence; maintainer y
  reader usan el lease habitual de 14 días.
- El hub que se une acepta el proyecto con la carpeta de trabajo registrada de la sesión
  que ejecuta la unión. Si esa carpeta no existe o ya pertenece a otro proyecto, la unión
  al canal se completa igual y el resultado trae `project_notice` y `pending_project_id`.
  Una vez corregida la carpeta, el Hub vuelve a intentarlo. También se puede repetir la
  unión con el mismo código desde la misma sesión.
- Un hub que ya es miembro del proyecto conserva su rol. Un miembro revocado no se
  restaura. A un miembro vencido se le asigna el mayor entre su rol anterior y el del
  código.
- Si el creador asigna un proyecto al canal después de que otros hubs se unieron, los
  hubs en 0.15.6 lo reciben por una oferta P2P directa, ligada a la revisión vigente de
  la política.
- El paquete de invitación no aparece en los resultados de las herramientas, ni en los
  hilos, ni en los logs.

## Compatibilidad

- La unión negocia un protocolo nuevo (2). Si el hub creador tiene una versión anterior,
  se usa el protocolo 1 y el proyecto no se copia, igual que en 0.15.5. Un hub anterior
  que se une a un canal creado en 0.15.6 ignora lo nuevo.
- La vuelta al protocolo 1 ocurre solo cuando el hub creador lo rechaza explícitamente.
  Un timeout o una desconexión no la provocan.
- Los canales que ya quedaron sin proyecto no se reparan solos. Cuando los dos hubs
  estén en 0.15.6, el líder de ese hub en el canal tiene que volver a unirse con el
  código vigente. Los códigos generados antes de 0.15.6 conceden owner.

## Límites conocidos

- Por defecto, quien tenga el código queda como owner del proyecto. El código no vence
  ni tiene límite de usos: si puede haberse filtrado, conviene regenerarlo con un rol
  menor o revocarlo.
- Antes de esta release no se probó el flujo real entre dos hubs, ni contra un hub de
  una versión anterior, ni con reconexiones durante la transferencia del proyecto.

## Verificación

- El typecheck, el lint y el build terminaron sin errores en la rama de la release.
- Pasaron los tests de memory de sharing, skills, local-chat, chat-read-access,
  channel-leadership, team-onboarding y database: 201 tests en 7 archivos.
- No existen tests de canales entre hubs, y no se modificó ningún test.
