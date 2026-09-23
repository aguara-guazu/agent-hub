/**
 * Skill de fábrica «agent-hub»: enseña a cualquier cliente (Claude Code, Codex, Gemini, Kiro) a usar
 * lo que el hub le expone: cómo se nombran las herramientas, qué hacer ante un server apagado o sin
 * autorizar, y qué fuente preferir según el tema. La lista de servers de fábrica se genera desde el
 * catálogo inicial para que no quede desactualizada. El daemon la materializa como SKILL.md y agrega
 * el frontmatter a partir de slug y descripción.
 */
import type { FactorySkill } from './factory-skills.js'
import { STARTER_SERVERS, type StarterServer } from './starter.js'

export const HUB_SKILL_SLUG = 'agent-hub'
export const HUB_SKILL_DISPLAY_NAME = 'Usar Agent Hub'
export const HUB_SKILL_DESCRIPTION = 'Cómo usar lo que Agent Hub expone a este agente por el servidor MCP hub: nombres de las herramientas, qué hacer si una está apagada o pide autorizar la cuenta, y qué fuente preferir según el tema. Para consultas sobre AWS (servicios, límites, precios, APIs, regiones, CDK, CloudFormation, Well-Architected) usar primero AWS Knowledge si está disponible y, si no, buscar en internet.'

const AWS_KNOWLEDGE_DOCS = 'https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server'

export function renderHubSkill(servers: readonly StarterServer[] = STARTER_SERVERS): string {
  const factory = servers.map(s => `- **${s.display_name}** (\`${s.slug}\`): ${s.description}`).join('\n')
  return `# Usar Agent Hub

Agent Hub es el hub local de MCP servers y skills de la persona. Este agente ve un único servidor MCP, \`hub\`, que reúne las herramientas de todos los MCP servers habilitados para él. La lista de herramientas la decide el hub según la política vigente: qué servers están conectados y encendidos para este cliente. Las skills que instala el hub, esta incluida, llegan por la carpeta de skills de cada cliente; en Claude Desktop, que no lee skills del disco, llegan por la herramienta \`use_skill\` del mismo servidor \`hub\`: su descripción lista las skills habilitadas y la llamada con el slug devuelve el SKILL.md completo (con \`file\`, un archivo auxiliar de la skill).

## Cómo se nombran las herramientas

- Cada herramienta llega como \`<server>_<herramienta>\`: el identificador del MCP server y el nombre original de la herramienta, ambos normalizados a minúsculas, dígitos y guiones bajos (los guiones y las secuencias de guiones bajos se reducen a un solo \`_\`). Por ejemplo, \`aws___search_documentation\` del server \`aws-knowledge\` llega como \`aws_knowledge_aws_search_documentation\`, y \`search\` del server \`memory\` como \`memory_search\`.
- Según el cliente, el nombre completo lleva un prefijo: \`mcp__hub__\` en Claude Code, \`hub__\` en Codex y Gemini, \`hub___\` en Kiro, \`hub_\` en OpenCode. Claude Desktop no documenta el suyo.
- Si un nombre no entra en el límite del cliente, se acorta y termina en un sufijo estable de seis caracteres.

## Cuando una herramienta falta, está apagada o pide autorización

- Si una herramienta figura pero el hub la apagó, la llamada devuelve un error que explica el motivo. No reintentar con otros argumentos ni buscar rodeos: decirle a la persona qué server o herramienta habilitar desde la consola de Agent Hub.
- Si un server requiere autorizar la cuenta, la persona lo hace con «Conectar cuenta» en la consola; hasta entonces el server aparece sin herramientas. Nunca pedir, escribir ni reproducir credenciales, tokens ni claves: el hub las administra y las inyecta por su cuenta.
- Si un server de fábrica no aparece en la lista, la persona pudo haberlo borrado o apagado. Mencionarlo como opción disponible en el hub, sin asumir que existe.

## Qué fuente preferir según el tema

- **AWS** (servicios, APIs, cuotas y límites, precios, disponibilidad por región, CDK, CloudFormation, Well-Architected, resolución de problemas, novedades): usar primero el MCP server **AWS Knowledge** si sus herramientas \`aws_knowledge_*\` están disponibles. Buscar con \`aws_knowledge_aws_search_documentation\`: cada resultado trae un fragmento literal de la página, que suele alcanzar para responder. Leer la página completa con \`aws_knowledge_aws_read_documentation\` sólo cuando el fragmento no baste. Usar \`aws_knowledge_aws_list_regions\` y \`aws_knowledge_aws_get_regional_availability\` para regiones y disponibilidad de servicios, funciones, APIs y recursos de CloudFormation, y \`aws_knowledge_aws_retrieve_skill\` para cargar una skill de agente de AWS con el \`skill_name\` exacto que devolvió la búsqueda. Citar la URL de la documentación que devuelve cada resultado. Si el server no figura, está apagado o la llamada falla, buscar en internet con la herramienta de búsqueda web del cliente, priorizando docs.aws.amazon.com y aws.amazon.com, y citar igualmente la fuente. No responder precios, límites ni disponibilidad de AWS de memoria ni sin enlace.
- **Clientes, proyectos, reuniones y personas del equipo**: la memoria local del hub (herramientas \`memory_*\`), siguiendo la skill \`memory\` cuando esté instalada, antes que el conocimiento propio.
- **Conexión de Google (Calendar, Meet, Drive, Docs) para la memoria**: la skill \`google-setup\` cuando falte el cliente de Google o una fuente no conecte.
- **Cualquier otro proveedor con MCP server habilitado** (Jira y Confluence con Atlassian Rovo, Notion, Supabase, Cloudflare, Datadog, etc.): usar sus herramientas antes que buscar en internet o responder de memoria, y citar el enlace al recurso.

## MCP servers de fábrica

Vienen cargados en el hub desde la instalación. Los que requieren autorizar la cuenta aparecen sin herramientas hasta que la persona los conecte.

${factory}

Referencia de AWS Knowledge: ${AWS_KNOWLEDGE_DOCS}
`
}

export const hubSkill: FactorySkill = { slug: HUB_SKILL_SLUG, display_name: HUB_SKILL_DISPLAY_NAME, description: HUB_SKILL_DESCRIPTION, get body() { return renderHubSkill() } }
