# Principios y arquitectura

## Para qué existe este documento

Agent Hub creció agregando funciones donde había lugar: una pestaña más, un modal más, un aviso más. El resultado fue una app con tres niveles de navegación, 33 modales, diez pestañas en la ficha de proyecto, ajustes repartidos en dos lugares y textos que explican la interfaz en vez de dejarla hablar.

Este documento fija **dónde va cada cosa y por qué**. Es la referencia para diseñar y la regla para que los agentes que implementan el front no tengan que adivinar.

## Diagnóstico de la versión 0.11.7

| Problema | Evidencia | Decisión |
|---|---|---|
| Tres niveles de navegación apilados | Barra lateral → pestañas de Memoria → 10 pestañas de proyecto, la última cortada a 1440 px | Barra lateral + como máximo 5 pestañas |
| 33 modales, varios duplicados | «Vincular» y «Agregar vínculo» abren el mismo diálogo; cada entidad tiene su «Editar» | Edición en panel lateral; modal solo para crear |
| Confirmaciones para acciones reversibles | Ejecutar ahora, Pausar, Cancelar piden confirmar | Acción inmediata + «Deshacer» |
| Configuración partida | «Ajustes» y «Fuentes y ajustes»; Jira se configura en ambos | Una sola página de Ajustes con secciones |
| Avisos repetidos | 4 bloques rojos idénticos de «Falta autorizar la cuenta», uno por tarjeta | Un aviso por página que agrupa los casos |
| Texto de relleno | Subtítulos que repiten el título, bloques «Cómo se organizan», notas permanentes | Cero texto explicativo; ayuda en estados vacíos y tooltips |
| Redacción inconsistente | Voseo, tuteo y neutro mezclados; valores internos en inglés (`presales`, `belongs_to`) | Voseo en toda la app; todo valor traducido |
| Tema claro roto | Los tokens de superficie y texto fijan valores oscuros | Tokens con dos temas reales |
| Datos sin jerarquía | Tiles de totales que no llevan a ninguna acción | Contadores dentro de los filtros |
| Controles mezclados | `select` nativo junto a controles propios | Solo controles del sistema |

## Los seis principios

### 1. Un lugar para cada cosa
Cada concepto tiene un único dueño en la navegación. Si un dato aparece en dos lugares, uno es el dueño (donde se edita) y el otro solo muestra y enlaza. Ejemplo: las automatizaciones de un proyecto se ven como interruptores en la ficha del proyecto, pero su configuración completa vive en Automatizaciones.

### 2. Dos niveles de navegación como máximo
Barra lateral y, dentro de una ficha, hasta cinco pestañas. Nunca pestañas dentro de pestañas, nunca una barra de pestañas debajo de otra. Si una ficha necesita una sexta pestaña, dos de las existentes se tienen que fusionar o una tiene que pasar a ser un filtro. Única excepción, decidida por la persona: la ficha de proyecto tiene seis (Notas de agentes, al lado de Colaboración).

### 3. Editar donde se ve
Seleccionar una fila abre su panel lateral, con los campos editables ahí mismo. Un valor visible (título, etapa, hora) se edita en línea. El modal queda para crear algo nuevo con pocos campos.

### 4. Deshacer en lugar de confirmar
Si una acción se puede revertir, se ejecuta y ofrece «Deshacer» durante 6 segundos. Solo se confirma lo que destruye datos sin vuelta atrás (restaurar un respaldo, eliminar un proyecto con contenido).

### 5. Lo que necesita atención sube a Inicio
Autorizaciones pendientes, reinicios, propuestas de agentes en entregas, duplicados y vínculos sugeridos se juntan en la bandeja de Inicio, cada uno con su acción. Las demás vistas muestran **estado** (un chip), no alarmas.

### 6. La interfaz no se explica a sí misma
Nada de párrafos de ayuda permanentes. Si algo necesita explicación, va en el estado vacío, en el `hint` de un campo o en un tooltip. Un subtítulo que repite el título se borra.

## Arquitectura de información

### Antes: 3 niveles, 21 destinos

```
Esta computadora (tarjeta)
BIBLIOTECA
├ MCP servers
├ Skills
├ Memoria
│  ├ Proyectos → 10 pestañas
│  ├ Colaboración sin proyecto
│  ├ Explorar
│  ├ Buscar
│  ├ Por revisar
│  ├ Procesamiento
│  └ Fuentes y ajustes
├ Clientes
├ Automatizaciones → Programaciones · Entregas
└ Actividad
Estado de sincronización (tarjeta)
Ajustes
Barra superior: atrás · migas · búsqueda · sincronizar
```

### Después: 2 niveles, 10 destinos

```
Buscar o ir a…  ⌘K
Inicio                 bandeja de lo que necesita atención

TRABAJO
├ Proyectos            → Resumen · Contenido · Tareas · Decisiones · Colaboración · Notas
│                        (Colaboración: canales › hilos › mensajes, solo para ver)
├ Memoria              explorar + buscar en un solo lugar
└ Automatizaciones     Activas · Pausadas · Historial de entregas

CONEXIONES
├ Servidores MCP
├ Skills
├ Clientes
└ Actividad            llamadas + procesamiento

Ajustes                una página, ocho secciones
● equipo · estado de sincronización (una línea)
```

**Trabajo** agrupa lo que la persona produce y consulta. **Conexiones** agrupa la infraestructura que el hub entrega a los agentes. Inicio está fuera de los grupos porque es el punto de entrada. Ajustes va al pie porque se visita poco.

La colaboración no es un destino propio: todo canal pertenece a un proyecto y sus hilos se leen junto al resto del proyecto. Es **solo para ver**: la persona interactúa únicamente con el agente líder, por la terminal. Si un agente quiere que la persona decida algo, se lo pide por la CLI; el Hub no muestra ni guarda propuestas ni debates que esperan decisión.

**Pendiente de producto:** los canales sin proyecto (canales virtuales) no tienen vista propia en la UI.

### Dónde quedó cada cosa

| Antes | Ahora | Por qué |
|---|---|---|
| Tarjetas «Esta computadora» y «Sincronización» | Una línea de estado al pie de la barra lateral | Dos tarjetas para un dato que se mira poco |
| Barra superior con migas y «Sincronizar ahora» | Migas dentro de la ficha; sincronizar en la línea de estado | Recupera 52 px y elimina migas inconsistentes |
| Buscador global de la barra superior | «Buscar o ir a…» (⌘K) en la barra lateral | Una sola búsqueda global |
| Memoria › Explorar + Buscar | Memoria | Buscar es filtrar el mismo listado |
| Memoria › Por revisar, propuestas de entregas, fuentes sin asignar | Inicio › Pendientes | Todo lo que espera una decisión, junto |
| Memoria › Procesamiento | Actividad › pestaña Procesamiento | Es un registro, como las llamadas |
| Memoria › Fuentes y ajustes + Ajustes + Jira (dos veces) | Ajustes, con 8 secciones | Una sola fuente de verdad de configuración |
| Memoria › Colaboración sin proyecto | Pestaña Colaboración del proyecto; los canales sin proyecto no tienen vista propia (pendiente de producto) | Cada canal pertenece a un proyecto; un destino global duplicaba la pestaña |
| Destino Colaboración de la barra lateral (rediseño v1) | Proyecto › Colaboración, en tres columnas: canales › hilos › mensajes | Un solo lugar para los hilos |
| Automatizaciones › Programaciones + Entregas | Automatizaciones con segmentado Activas / Pausadas / Historial | Es la misma colección vista por estado; el historial junta las entregas de todas |
| Detalle de entrega | Historial › panel de la entrega (resumen, acciones propuestas, J/K); el panel de la automatización muestra sus últimas entregas con «Ver en Historial» | Las entregas se revisan en tanda, como una bandeja con sin ver |
| Proyecto › Colaboración, Foro compartido, Compartir y colaborar | Pestaña Colaboración (solo ver) + panel de «Compartir» | Tres pestañas para un mismo tema |
| Foro de agentes | Se quita de la UI | Duplicaba los canales |
| Personas con acceso y permisos | Panel de «Compartir» | Es una propiedad del acceso al proyecto, no de los hilos |
| Notas de trabajo de los agentes | Pestaña Notas de la ficha de proyecto (solo lectura) | Son del proyecto y no encajan en Contenido |
| Decisión que un agente necesita de la persona | La CLI del agente líder; el Hub no la muestra | La persona decide en la terminal; el Hub solo deja ver los hilos |
| Proyecto › Reuniones, Documentos, Colecciones | Pestaña Contenido con filtro por tipo | Son la misma lista con distinto tipo |
| Proyecto › Línea de tiempo | Pestaña Resumen › Última actividad | Es el resumen del proyecto |
| Proyecto › Brief y cierre | Resumen › bloque Automatizaciones (interruptores) | Es un interruptor, no una sección |
| Proyecto › Decisiones y hallazgos | Pestaña Decisiones | Se mantiene, con nombre corto |
| Unirme a un proyecto · Nueva empresa · Nuevo proyecto | «Nuevo proyecto» con menú; la empresa se crea desde el selector | Una acción primaria por página |
| Vincular + Agregar vínculo | «Vincular» en el bloque Conexiones | Eran el mismo diálogo |
| Tiles de totales | Contadores dentro de los filtros | Números que no llevan a ninguna decisión |
| ZIP para claude.ai (en cada skill y en el encabezado) | Menú «…» de la skill | Acción poco frecuente |
| «Usar credenciales de cliente propias» en cada server | Panel del servidor › Opciones avanzadas | Se usa una vez |
| Tarjeta «Cuotas de uso» por cliente | Panel del cliente › Uso semanal | Es un dato del cliente |
| «Revisar clientes» + aviso de detección automática | «Buscar clientes» | El aviso explicaba lo obvio |

## Qué no se movió y por qué

- **Servidores MCP, Skills y Clientes** siguen siendo destinos propios: son las tres cosas que el hub entrega a los agentes y la persona las administra por separado.
- **Actividad** se mantiene como registro de solo lectura. No se convierte en panel de métricas.
- **Proyectos** sigue siendo el centro de la memoria, pero ahora es un destino de primer nivel en lugar de una pestaña de Memoria.
