import type es from "../es/nav"
import type { Messages } from "../../types"

const nav = {
  search: "Search or go to…",
  home: "Home",
  groupWork: "Work",
  projects: "Projects",
  memory: "Memory",
  collaboration: "Collaboration",
  automations: "Automations",
  groupConnections: "Connections",
  servers: "MCP servers",
  skills: "Skills",
  clients: "Clients",
  activity: "Activity",
  settings: "Settings",
  syncNow: "Sync now",
  syncedAgo: "Synced {{when}}",
} satisfies Messages<typeof es>

export default nav
