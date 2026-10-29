# Agent Hub · Rediseño de UX/UI · v1

Paquete completo del rediseño: biblia de diseño, documentos, vistas, skill para agentes de front y el CSS del sistema.

## Contenido

```
01-biblia/
  Biblia-de-diseno-Agent-Hub.pdf     Todo en un solo documento (59 páginas)

02-documentos/
  01-principios-y-arquitectura.pdf   Diagnóstico, 6 principios, nueva arquitectura, dónde quedó cada cosa
  02-sistema-de-diseno.pdf           Tokens de ambos temas, tipografía, espacio, catálogo de componentes
  03-plantillas-y-layout.pdf         Las 4 plantillas, reglas L1–L10, comportamiento por ancho
  04-patrones-de-interaccion.pdf     Modal vs panel vs en línea, Deshacer, ⌘K, estados, teclado
  05-reglas-de-ux.pdf                Árbol de decisión y criterios de rechazo U1–U15
  06-redaccion.pdf                   Reglas R1–R8, vocabulario, traducciones de valores internos
  07-especificacion-de-vistas.pdf    Qué va y qué no va en cada vista, con capturas
  08-checklist-de-revision.pdf       Checklist para cerrar cualquier cambio de front
  09-prompts-para-agentes.pdf        Prompts listos para implementar, migrar, revisar y auditar
  markdown/                          Los mismos documentos en Markdown (editables)
  tableros/                          Los 4 tableros de fundamentos del lienzo, en PDF

03-vistas/
  html/index.html                    Prototipo navegable (abrir en el navegador, funciona sin internet)
  png/oscuro/  png/claro/            Las 12 vistas a 2880×1920 en ambos temas
  png/variantes/                     Pestañas de Proyecto, secciones de Ajustes y vistas a 960 px
  png/fundamentos/                   Los 4 tableros de fundamentos
  Vistas-Agent-Hub.pdf               Las 12 vistas en ambos temas, una por página

04-skill/agent-hub-design/           Skill para los agentes de front
  SKILL.md                           Flujo obligatorio, reglas no negociables, árbol de decisión
  references/                        Los 9 documentos
  assets/ah.css                      El sistema visual
  assets/ejemplos/                   Prototipo HTML (una vista por plantilla y todas las demás)
  assets/capturas/                   Capturas de referencia

05-fuente/
  ah.css                             Tokens + componentes. Fuente de verdad del sistema visual.
```

## Cómo instalar la skill en el repo del front

1. Copiá `04-skill/agent-hub-design/` a `.claude/skills/agent-hub-design/` en el repo (para Claude Code), o a la carpeta de skills o instrucciones que use cada agente.
2. Copiá `05-fuente/ah.css` a `src/styles/ah.css` y cargalo antes que cualquier otro estilo.
3. Agregá al `CLAUDE.md` / `AGENTS.md` del repo el bloque del prompt 1 de `09-prompts-para-agentes`.
4. Para migrar, usá el prompt 3 vista por vista. Para revisar cada PR, el prompt 4.

## Prototipo HTML

Abrí `03-vistas/html/index.html`. La barra lateral, las pestañas de Proyecto, las secciones de Ajustes y el menú de «Nuevo proyecto» funcionan. El botón flotante cambia entre tema oscuro y claro. También se puede abrir una vista con `?theme=light` o `?tab=tareas` en la URL.

## Fuentes tipográficas

Geist y Geist Mono (SIL Open Font License 1.1, licencia incluida en `03-vistas/html/assets/fonts/`).

## Datos

Todos los nombres, empresas, proyectos y conversaciones son ficticios.
