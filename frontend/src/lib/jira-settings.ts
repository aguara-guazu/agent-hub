import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

export function useJiraSettings() {
  return useQuery({ queryKey: ["memory", "jira-settings"], queryFn: () => api.get<{ default_site_url: string | null }>("/memory/jira-settings") })
}
