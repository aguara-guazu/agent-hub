export const hubIssueSkill = {
  slug: "report-hub-issue",
  display_name: "Reportar un problema de Agent Hub",
  description: "Use ONLY when the person reports a problem with Agent Hub itself and wants it reported (reportar un problema del Hub, abrir un issue, bug del Hub); never proactively or for errors you notice on your own. Builds a redacted issue and publishes it to aguara-guazu/agent-hub only after the person approves the exact text.",
  body: `# Report an Agent Hub problem

Talk to the person in their language. Only when the person reports a problem with Agent Hub itself; never on your own initiative, for errors you noticed, or for problems of other tools.

1. Ask only what is missing: what they did (steps), what they expected, what happened, and roughly when. Convert that time to UTC for the tool; show times to the person in their local zone and format (memory_context person_time).
2. Call memory_diagnostic_report with summary, steps, expected, observed and a from/to window in UTC (at most 24 h, a few minutes around the problem). It is read-only and redacts credentials, emails and the home path; it adds Hub and CLI versions, OS, the window's Hub log lines, process incidents and notice causes. Never add conversation content, keys, session_keys, invitations or personal paths to it.
3. Show the person the exact title and body that would be published, with times in their local zone, and ask for explicit approval. They may edit it; show the final text again.
4. Only after an explicit yes: if \`gh auth status\` succeeds, write the approved body to a temporary file and run \`gh issue create --repo aguara-guazu/agent-hub --title "<title>" --body-file <file>\`, then delete the file and give the person the issue link. Otherwise give them the returned url to open, and the full text to paste if the link was shortened.
5. No approval, no publication. Never change or append anything after approval, never publish elsewhere, and never retry a failed publication without asking again.
`,
}
