export const hubIssueSkill = {
  slug: "report-hub-issue",
  display_name: "Reportar un problema de Agent Hub",
  description: "Use ONLY when the person reports a problem with Agent Hub itself and wants it reported (reportar un problema del Hub, abrir un issue, bug del Hub); never proactively or for errors you notice on your own. Builds a redacted issue and publishes it to aguara-guazu/agent-hub only after the person approves the exact text.",
  body: `# Report an Agent Hub problem

Talk to the person in their language. Only when the person reports a problem with Agent Hub itself; never on your own initiative, for errors you noticed, or for problems of other tools.

1. Ask only what is missing: what they did (steps), what they expected, what happened, and roughly when. Convert that time to UTC for the tool; show times to the person in their local zone and format (memory_context person_time).
2. Call memory_diagnostic_report with summary, steps, expected, observed and a from/to window in UTC (at most 24 h, a few minutes around the problem). It publishes nothing and redacts credentials, emails and the home path; it adds Hub and CLI versions, OS, the window's Hub log lines, process incidents and notice causes, and stores the body in a private \`body_file\` that the Hub deletes within an hour (or on its next start if it was closed). Never add conversation content, keys, session_keys, invitations or personal paths to it.
3. Show the person the exact title and body (the returned \`text\`) that would be published, with times in their local zone, and ask for explicit approval. If they edit anything, call memory_diagnostic_report again with the edited summary, steps, expected, observed or title and show the new result: only the last returned title and \`body_file\` can be published.
4. Only after an explicit yes, and if \`gh auth status\` succeeds and a \`body_file\` was returned, publish in one command, pasting the returned title and \`body_file\` inside single quotes (neither can contain one):
   - POSIX shell: \`f='<body_file>'; trap 'rm -f "$f"' EXIT INT TERM HUP; gh issue create --repo aguara-guazu/agent-hub --title '<title>' --body-file "$f"\`. gh runs last, so the command's status is gh's; the trap removes the file on success, failure or interruption.
   - PowerShell: \`$f='<body_file>'; $code=1; try { gh issue create --repo aguara-guazu/agent-hub --title '<title>' --body-file $f; $code=$LASTEXITCODE } finally { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }; exit $code\`.
   Never write, echo or edit the body yourself. Give the person the issue link. Without gh or \`body_file\`, give them the returned url to open, and the full text to paste if the link was shortened.
5. No approval, no publication. Never change or append anything after approval, never publish elsewhere, and never retry a failed publication without asking again: on failure offer the url and text instead.
`,
}
