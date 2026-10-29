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
export const HUB_SKILL_DESCRIPTION = 'Using Agent Hub tools via the hub MCP server: naming, turned-off or unauthorized tools, preferred source per topic. For AWS (services, limits, pricing, APIs, regions, CDK, CloudFormation, Well-Architected) use AWS Knowledge first if available, else web search.'

const AWS_KNOWLEDGE_DOCS = 'https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server'

export function renderHubSkill(servers: readonly StarterServer[] = STARTER_SERVERS): string {
  const factory = servers.map(s => `- **${s.display_name}** (\`${s.slug}\`): ${s.description}`).join('\n')
  return `# Using Agent Hub

Talk to the person in their language.

You see one MCP server, \`hub\`, aggregating the tools the person's local Agent Hub policy enables for this client. Hub skills (this one too) arrive in the client's skills folder; Claude Desktop, which doesn't read skills from disk, gets them via \`use_skill\` on \`hub\` (its description lists enabled skills; a slug returns the full SKILL.md, adding \`file\` an auxiliary file).

## Tool names

- \`<server>_<tool>\`: server id and original tool name, normalized to lowercase letters, digits and underscores (hyphens and underscore runs become one \`_\`). E.g. \`aws___search_documentation\` of \`aws-knowledge\` → \`aws_knowledge_aws_search_documentation\`; \`search\` of \`memory\` → \`memory_search\`.
- Client prefixes: \`mcp__hub__\` Claude Code, \`hub__\` Codex and Gemini, \`hub___\` Kiro, \`hub_\` OpenCode, \`mcp_hub_\` Antigravity; Claude Desktop's is undocumented.
- Names over the client's limit are shortened, ending in a stable six-character suffix.

## Missing, off or unauthorized

- A tool the hub turned off returns an error with the reason. Don't retry with other arguments or work around it: tell the person which server or tool to enable in the Agent Hub console.
- A server needing account authorization shows no tools until the person uses «Conectar cuenta» in the console. Never ask for, write or reproduce credentials, tokens or keys: the hub manages and injects them.
- A missing factory server may have been deleted or turned off: mention it as a hub option without assuming it exists.

## Source per topic

- **AWS** (services, APIs, quotas, limits, pricing, regional availability, CDK, CloudFormation, Well-Architected, troubleshooting, news): **AWS Knowledge** first if \`aws_knowledge_*\` tools exist: \`aws_knowledge_aws_search_documentation\` (results include a literal excerpt, usually enough), \`aws_knowledge_aws_read_documentation\` for full pages only if needed, \`aws_knowledge_aws_list_regions\` and \`aws_knowledge_aws_get_regional_availability\` for regions and availability of services, features, APIs and CloudFormation resources, \`aws_knowledge_aws_retrieve_skill\` to load an AWS agent skill by the exact \`skill_name\` from search. Cite each result's doc URL. If it is missing, off or failing, use web search (prefer docs.aws.amazon.com, aws.amazon.com), still citing the source. Never state AWS pricing, limits or availability from memory or without a link.
- **Clients, projects, meetings, team members**: local memory (\`memory_*\`, per the \`memory\` skill if installed) before your own knowledge.
- **Google for memory (Calendar, Meet, Drive, Docs)**: the \`google-setup\` skill if the Google client is missing or a source won't connect.
- **Other providers with an enabled server** (Jira and Confluence via Atlassian Rovo, Notion, Supabase, Cloudflare, Datadog, etc.): their tools before web search or memory; cite the resource link.
- **Jira writes** (comments, transitions, worklogs, edits): the hub doesn't restrict them. As a recommendation, prefer tickets assigned to the person; if a ticket is assigned to someone else or unassigned, ask the person before writing.

## Factory MCP servers

Preloaded at install:

${factory}

AWS Knowledge reference: ${AWS_KNOWLEDGE_DOCS}
`
}

export const hubSkill: FactorySkill = { slug: HUB_SKILL_SLUG, display_name: HUB_SKILL_DISPLAY_NAME, description: HUB_SKILL_DESCRIPTION, get body() { return renderHubSkill() } }
