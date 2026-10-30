# Reglas de UX y lógica de producto

El sistema visual evita que algo se vea mal. Estas reglas evitan que algo **tenga sentido solo en apariencia**: un botón bien dibujado en el lugar equivocado, una pestaña prolija que duplica otra, un aviso correcto que nadie necesita.

## El modelo mental de Agent Hub

La persona usa Agent Hub para tres cosas, en este orden de frecuencia:

1. **Saber si algo necesita su intervención** → Inicio.
2. **Consultar y ordenar lo que sus agentes saben y hacen** → Proyectos (con su pestaña Colaboración), Memoria, Automatizaciones.
3. **Administrar lo que el hub entrega a los agentes** → Servidores MCP, Skills, Clientes, y revisar Actividad.

Configurar es lo menos frecuente → Ajustes, al pie.

Los **agentes** (Claude Code, Codex CLI, Gemini CLI…) son quienes más escriben en el hub: crean tareas, decisiones, hilos, automatizaciones. La persona **revisa, corrige y decide**. Por eso la interfaz prioriza leer, revisar y aprobar por sobre crear a mano. En la colaboración entre agentes, la UI es solo para ver: la persona decide con el agente líder, por la terminal.

## Árbol de decisión: dónde va una función nueva

Antes de escribir una línea de front, respondé en orden. La primera respuesta afirmativa decide.

1. **¿Es algo que la persona tiene que decidir o resolver?** (aprobar, autorizar, reiniciar, revisar un duplicado)
   → Una fila en **Inicio › Pendientes**, con una sola acción. Además, un chip de estado en el elemento afectado. Lo que un agente quiere que la persona decida no pasa por acá: se lo pide por la CLI.
2. **¿Es una propiedad o acción de un elemento que ya existe?** (un campo nuevo de servidor, una acción sobre una skill)
   → En el **panel** o la **ficha** de ese elemento. Si es frecuente, como secundario; si no, en «…».
3. **¿Es una forma nueva de ver una colección que ya existe?** (ver solo los fallidos, agrupar por cliente)
   → Una opción en el **segmentado** o un **selector** de la barra de esa colección. No una vista nueva.
4. **¿Es un tipo nuevo de contenido de un proyecto?** (planillas, grabaciones)
   → Un **tipo** más en la pestaña Contenido (filtro + tag). No una pestaña nueva.
5. **¿Es una preferencia que se fija una vez?**
   → Una fila en la sección correspondiente de **Ajustes**.
6. **¿Es un registro de algo que pasó?**
   → Una pestaña o filtro en **Actividad**.
7. **¿Es un concepto nuevo de primer nivel**, que la persona va a visitar seguido, con su propia colección de elementos, y que no encaja en nada de lo anterior?
   → Recién entonces se evalúa un destino nuevo en la barra lateral. Requiere actualizar este documento, la arquitectura y la barra lateral en el sistema. **Un agente no agrega destinos por su cuenta.**

## Criterios para rechazar una propuesta de interfaz

Un agente de front debe **no implementar** (y explicar por qué, proponiendo la alternativa) cualquier cambio que:

| # | Rechazar si… | Alternativa |
|---|---|---|
| U1 | Agrega un tercer nivel de navegación o una sexta pestaña (la ficha de proyecto ya usa su única excepción: Notas) | Fusionar pestañas o convertir en filtro |
| U2 | Agrega un segundo botón primario a una vista | Pasar a secundario o a «…» |
| U3 | Duplica una acción que ya existe en otro lugar de la misma vista | Dejar una sola, en el lugar del dueño |
| U4 | Crea un modal para editar, informar o confirmar algo reversible | Panel, en línea, o Deshacer |
| U5 | Repite el mismo aviso en varias filas o tarjetas | Un aviso de página que agrupa + chips |
| U6 | Agrega un texto que explica cómo usar la interfaz | Estado vacío, `hint` o tooltip; o mejorar la etiqueta |
| U7 | Muestra un número que no lleva a ninguna decisión (tiles de totales) | Contador en el filtro, o nada |
| U8 | Expone un valor interno (`snake_case`, IDs, enums en inglés) como texto principal | Traducir; el valor técnico solo en mono y en paneles |
| U9 | Agrega configuración fuera de Ajustes (salvo el ajuste propio de un elemento en su panel) | Fila en la sección de Ajustes que corresponda |
| U10 | Crea una vista nueva para un filtro de una colección existente | Opción en el segmentado |
| U11 | Usa un control nativo (`select`, `date`) junto a controles del sistema | Selector propio del sistema |
| U12 | Introduce un color, tamaño o componente que no está en `ah.css` | Usar el existente o proponer agregarlo al sistema |
| U13 | Pide confirmación para ejecutar algo que el agente ya propuso y la persona eligió | Ejecutar + toast |
| U14 | Mezcla guardado automático y botón Guardar en el mismo panel | Elegir un modelo |
| U15 | Pone un control dentro de un enlace, o un enlace dentro de un control | Separar: fila `div` con título enlazado |
| U16 | Agrega una vista de colaboración fuera de la ficha de proyecto, o cualquier control de acción en la colaboración (escribir, aprobar, pedir otra ronda, crear canal, cerrar o mover hilos, iniciar o detener agentes, aprobar planes de equipo) | Pestaña Colaboración del proyecto, solo para ver, sin propuestas ni pendientes de decisión; la decisión, en la terminal con el agente líder. Abrir y cerrar un hilo (tocarlo o su X) no es una acción sobre el hilo. Solo se conservan las 4 acciones de recuperación del «…» del canal (Expulsar del canal, Designar coordinador, Eliminar a la papelera, Restaurar), confirmadas por la persona |

## Heurísticas aplicadas a Agent Hub

**Visibilidad del estado.** Cada elemento conectable (servidor, cliente, fuente, automatización) muestra su estado con un chip. El estado global del hub es una línea al pie de la barra lateral. Lo que está pasando ahora usa `c-info` («Procesando», «En 2 h»).

**Hablar el idioma de la persona.** «Requiere autorización», no «OAuth pending». «Preventa», no «presales». «Pertenece a», no «belongs_to».

**Control y libertad.** Todo lo reversible se puede deshacer. Escape siempre cierra la capa superior. Los paneles no pierden cambios sin avisar.

**Consistencia.** Una acción se llama igual en toda la app («Autorizar cuenta», no «Conectar cuenta» en un lado y «Autorizar» en otro). Mismo componente para el mismo concepto.

**Prevención de errores.** Los campos validan al salir del campo, no al enviar. Los botones de crear se deshabilitan hasta que el formulario es válido, con el motivo en el `hint`.

**Reconocer antes que recordar.** Los selectores muestran nombres y avatares, no IDs. Las fechas en listas son relativas («hace 12 min») con la absoluta en el tooltip.

**Flexibilidad.** ⌘K para todo. Atajos de teclado para crear y cerrar. Pero nada depende de un atajo.

**Minimalismo.** Cada elemento tiene que justificar su lugar. Ante la duda, se saca.

**Errores que dicen qué hacer.** «No se pudo conectar con Supabase. Autorizá la cuenta de nuevo.» + botón. Nunca un código solo.

## Densidad y jerarquía

- Por fila: **un** título, **un** detalle, **un** estado, **una** acción. Si hace falta más, va al panel.
- Por vista: el ojo tiene que encontrar en 2 segundos el título, la acción primaria y el primer elemento de la lista.
- Los metadatos (fechas, conteos, autores) van en `--text-3`, alineados a la derecha.
- El acento de color marca **lo accionable**, no lo importante. Lo importante se marca con posición y tamaño.

## Datos y números

- Fechas en listas: relativas hasta 7 días («hace 3 h», «ayer», «lun»), después absolutas cortas («16 oct»). En paneles: absolutas completas («29 oct 2026, 14:19»).
- Duraciones: «48 min», «1 h 05 min», «2,1 s», «142 ms».
- Números con separador local: «1.240», «2,1».
- Conteos en filtros, no en tarjetas.
- Un dato faltante se muestra como «—», nunca vacío ni «null».

## Lo que hacen los agentes y lo que hace la persona

| Lo crea un agente | La persona… | Dónde |
|---|---|---|
| Tareas, decisiones, hallazgos | Lee, corrige, cierra | Proyecto › Tareas / Decisiones |
| Canales e hilos de colaboración | Lee; decide con el agente líder por la terminal; recupera un canal si hace falta | Proyecto › Colaboración (solo ver) |
| Notas de trabajo de los agentes | Lee | Proyecto › Notas (solo lectura) |
| Entregas de automatizaciones | Revisa sin ver, marca vistas en tanda | Automatizaciones › Historial |
| Automatizaciones | Ajusta horario y canales, pausa | Automatizaciones |
| Propuestas en entregas | Aprueba o rechaza | Inicio › Pendientes → Automatizaciones › Historial, panel de la entrega |
| Vínculos sugeridos | Acepta o descarta | Inicio › Pendientes |

Por eso: **las acciones de creación manual existen pero no dominan.** Un primario de «Crear» solo va donde la persona crea seguido (Proyectos, Memoria › Nueva nota, Servidores, Skills).
