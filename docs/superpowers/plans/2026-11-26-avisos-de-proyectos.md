# Avisos de proyectos durante la jornada

La secretaría reúne los pendientes de los proyectos activos antes de interrumpir al dueño. El core toma la misma decisión para el escritorio y para el cliente headless.

1. En Asistentes, guardar una política general para el intervalo entre avisos, la protección de reuniones, su umbral de severidad y la cantidad de presentaciones diarias. El primer recordatorio espera 30 minutos por defecto y cada intervalo se duplica.
2. Leer Calendar mediante la conexión del dueño y complementar con los eventos guardados en memoria. Ignorar invitaciones rechazadas, cancelaciones, eventos de día completo y horarios libres. Considerar la próxima reunión del proyecto y la urgencia de responder a Slack o de desbloquear tareas para ordenar el trabajo. La excepción para interrumpir una reunión usa la severidad del asunto.
3. Preparar una sola notificación por turno y ajustar la pausa según el tamaño de la cola y los avisos presentados durante la última hora. Registrar la presentación en SQLite por asunto y día local. Compartir una reserva entre consumidores para impedir ráfagas o duplicados y revalidar el conjunto al entregar. Conservar fuentes, motivos y enlaces en el detalle del grupo.
4. Al agotar el cupo diario, incorporar los asuntos abiertos al próximo correo del brief diario por la ruta Gmail que el dueño tenga habilitada. Al cambiar el día local, recalcular los pendientes. Los asuntos atendidos y los proyectos archivados salen del seguimiento.
5. Probar reuniones coincidentes, prioridades, reinicios, dos consumidores, cupo y correo con datos aislados. Verificar módulos encendidos, apagados y reactivados además de Ajustes, el escritorio y el modo headless.
