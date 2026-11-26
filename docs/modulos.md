# Desarrollo por módulos

La unidad de trabajo es una función del producto. Un módulo puede aportar una pantalla React, rutas del core, herramientas para los agentes y tareas en otro proceso. Los paquetes de Node siguen delimitando procesos y dependencias de compilación. El identificador del módulo une sus partes a través de esos paquetes.

## Dónde trabajar

| Módulo | Identificador | Implementación principal |
| --- | --- | --- |
| Conexiones a servicios | `connections` | `packages/memory/src/connectors`, incluidas las rutas, las herramientas y los trabajos de sincronización |
| [Asistentes residentes](asistentes.md) | `assistants` | `packages/memory/src/assistants` para el reloj, fuentes, chat y microtareas, cliente headless en `packages/core/src/modules/assistants` y avisos en `desktop/src/modules/assistants` |
| Agentes | `agents` | `packages/core/src/modules/agents` y `packages/memory/src/agents`, clientes del daemon, equipos, chat y cuotas de uso |
| Proyectos y memoria | `memory` | `packages/memory/src/projects`, incluidas las rutas, las herramientas, la búsqueda y los trabajos de inferencia |
| Servidores MCP | `mcp` | `packages/core/src/modules/mcp` para el catálogo, `packages/memory/src/mcp` para el servidor integrado y `packages/gateway` para el transporte |
| Skills | `skills` | `packages/core/src/modules/skills` para catálogo y sincronización, `packages/memory/src/skills` para la referencia que leen los agentes |
| Transcripciones y multimedia | `transcriptions` | `packages/memory/src/transcriptions` para el procesamiento y `desktop/src/modules/transcriptions` para la captura |
| Cronjobs y automatizaciones | `schedules` | `packages/memory/src/schedules` para las rutas y el reloj, `desktop/src/modules/schedules` para avisos y reanudación, `packages/core/src/effects` para los efectos |
| Proyectos compartidos | `sharing` | `packages/memory/src/sharing` e `interhub`, publicaciones y transporte entre hubs |

Cada identificador tiene una declaración en `packages/shared/src/modules/<id>.ts`. Ahí viven la clave de persistencia, los destinos, las rutas HTTP, las operaciones, las familias de trabajos y las dependencias del módulo. En `frontend/src/modules/<id>/index.ts` se registran sus vistas y su sección de Ajustes. General y Sistema pertenecen a la aplicación que aloja los módulos.

Los puntos de entrada reúnen las partes que corren en el mismo proceso. En el servicio de memoria, `routes.ts` registra las rutas de cada módulo, `operations.ts` valida permisos y despacha herramientas, y `jobs.ts` administra la cola, los reintentos y la cancelación. Los esquemas de las herramientas, las consultas y el código que ejecuta cada trabajo viven en la carpeta responsable. En Electron, `main.ts` conecta los módulos con el ciclo de vida de la ventana y el proceso.

Por ejemplo, para cambiar qué ocurre al detener una grabación, empezá en `desktop/src/modules/transcriptions/desktop.ts`. La recepción del audio está en `packages/memory/src/transcriptions/routes.ts` y su procesamiento en `packages/memory/src/transcriptions/jobs.ts`. Los controles de Ajustes están en `frontend/src/modules/transcriptions`.

## Cómo agregar o cambiar una función

1. Elegí el módulo dueño del comportamiento. Guardá sus pantallas y controles en su carpeta. Mantené las operaciones de dominio junto a sus validaciones y usá contratos acotados para pedir servicios a otro módulo.
2. Si creás un módulo, agregá su declaración a `appModules`, sus vistas a `moduleViews` y las etiquetas en español e inglés. Un módulo sin pantalla principal también tiene sección de Ajustes. Conservá los enlaces históricos al mover controles.
3. Para una ruta o herramienta nueva, declarala en el módulo que la ejecuta. Cuando un solo endpoint despacha varias operaciones, comprobá el módulo después de identificar la operación. Para un trabajo nuevo, declará su tipo y revisá el punto donde el worker lo reclama.
4. Considerá también el arranque, los temporizadores, los reintentos, la sincronización de clientes y los efectos externos. Una dependencia específica se comprueba antes de ejecutar ese trabajo. Por ejemplo, un recordatorio personal con entrega local puede correr con Proyectos y memoria apagado.
5. Probá el cambio desde su entrada pública, con datos existentes y con otro módulo en uso. Verificá también el enlace directo, la reactivación después de reiniciar y, si hay colas, que encender el módulo conserve los trabajos válidos.

## Qué pasa al apagar

El dueño local guarda la preferencia mediante `PUT /api/modules/:id`. La consola lee `GET /api/modules`. El core conserva el valor en SQLite y actualiza los procesos interesados. La ausencia de un valor equivale al estado inicial activo. En un core remoto multiusuario, el estado de la instalación es de solo lectura para las sesiones de las organizaciones. El interruptor de Cronjobs reutiliza la preferencia histórica de Automatizaciones. Las preferencias más específicas de colaboración, grabación, permisos por cliente y fuentes individuales se conservan.

La sección de Ajustes del módulo sigue disponible para volver a activarlo. La política de los clientes sincronizados refleja el cambio en su snapshot. Los trabajos de importación y multimedia que escriben en memoria esperan en la cola cuando una dependencia está apagada. Un cronjob que necesita un módulo apagado registra la ocurrencia omitida con el motivo y conserva su programación. La red de proyectos compartidos necesita Proyectos y memoria. El escritorio puede finalizar una captura ya iniciada y preservar el archivo.

La sesión, el almacenamiento común, los diagnósticos, las actualizaciones y la pantalla de Ajustes forman parte del núcleo. La disponibilidad de la base de almacenamiento es independiente de que estén habilitadas las funciones de Proyectos y memoria. Los servicios pueden usarla para sus propias tablas.

## Verificación

Desde la raíz, instalá las dependencias y compilá una vez con `npm run build`. Ejecutá `npm run test:module -- <identificador>` con el identificador de la tabla. Por ejemplo, `npm run test:module -- transcriptions` cubre la captura de escritorio y el procesamiento en memoria. Al crear una suite del módulo, incluí su ruta en `scripts/test-module.mjs` si todavía no coincide con ninguno de sus filtros.

Para verificar el contrato entre módulos ejecutá `npx vitest run packages/core/test/modules.test.ts`. El cierre de un cambio transversal incluye `npm run typecheck`, `npm run lint` y `npm test`.
