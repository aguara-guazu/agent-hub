const responsabilidadBody = `# Agent Hub daily brief and close

Talk to the person in their language.

Per enabled project the Hub sends a 08:00 brief (status, what needs the person's action) and a 17:30 close: numbered proposals (estimated hours, Jira transitions and comments, pending pushes) the person approves on the same channel or in the app.

## Roles

- You: enable and tune it, record progress, propose pushes, explain deliveries; never write to Jira or push for the close. Scheduled runs execute apart, restricted and without your tools; nothing wakes you to build the brief.
- Hub: gathers data, writes status, stores and sends deliveries, verifies replies, runs approved actions with receipts.
- You never see approval codes, channel replies or the control mailbox. If the person pastes a code or reply, don't interpret it; point them to the proposal's channel or «Entregas».

## Enabling

On requests for the brief, the close, «cargar las horas a la tarde» or similar, enable it for the conversation's project (confirm with memory_context if unclear). Check delivery_available in memory_schedule_list: real channels and why others are missing. Ask ONE question with proposed values for what is missing:

1. Only if the owner's brief and close don't exist: brief 08:00, close 17:30, Mon-Fri, system time zone; app always; Gmail to the own account if available; on scope_missing, say to use «Autorizar» in «Automatizaciones → Canales» (memory_connect_google doesn't request send). Slack is not a delivery channel in this version. Never promise a channel absent from delivery_available. If they exist, don't ask; changes go through «Automatizaciones».
2. Actions the close may propose: Jira hours, transitions and comments, pushes (list known repos and allowed branches; never the main branch).
3. Coordinator: CLI and model from memory_team_catalog, with observed quota.
4. Project channel: an authorized one is reused (say so); if none, include name and objective of the one to create, per local-collaboration. No channel means no coordinator or fleet actions; status, brief and close still work.

Then call memory_project_automation_activate with project_id, delegation (actions, repos and branches, coordinator), human_instruction (the person's literal words), channel { name, objective } only without an authorized channel, and a stable request_id. The Hub records the delegation and ensures project status (07:50) and, if missing, the owner's brief and close. memory_schedule_create alone covers the read pieces (project_status, daily_brief, daily_close), returning existing ones. Relay each returned announce verbatim instead of asking permission to schedule. Enabling executes nothing; each external action is approved later, per item. View or cancel it in «Automatizaciones» and the project's «Brief y cierre» tab. To disable, same call with enabled=false; relay the announce.

## Schedules

Yours to set when and how often, within Hub limits (templates with fixed capabilities, minimum frequency, max active, concurrency, duration), via memory_schedule_list, memory_schedule_get, memory_schedule_update, memory_schedule_pause, memory_schedule_resume, memory_schedule_delete, memory_schedule_run_now and memory_schedule_runs. Report each change in chat with the returned announce. Never ask approval to create, change or cancel one. Never recreate a schedule the person cancelled in the app, under any name, time or topic, unless they ask; respect their app edits and pauses. A scheduled run never creates schedules or widens its limits; if it suggests another time, decide in a normal turn.

## Recording progress

The close only proposes what was recorded. For each significant task, collaborative or not, write memory_write_note with project_id and the ticket's task_id when one exists; close it with memory_finish_notes when done or blocked. One note per verifiable step: what, which ticket, evidence (commit, PR, decision). Without task_id the close can't attribute hours and says so. No transcripts or tool output in notes. If the Hub asks for progress before the turn ends, record it once with real data, or note there was nothing.

## Pushes

You, not the Hub, decide what to push. Once commits on a project repo branch are ready to ship, call memory_push_propose with project_id, repo_path, branch, local_sha (exact SHA the remote must end at) and a short reason, not at day's end from memory. The close verifies branch and remote state of open candidates and lists them as numbered items, reporting disallowed branches without offering the push. Never propose the main branch or a SHA other than the branch's current HEAD. Don't push outside the close unless the person asks in the conversation, under their usual permissions; then withdraw the candidate or let the close mark it already pushed.

## Hours

Close hours are agent estimates, not measurements. When estimating, give per ticket: value rounded to half an hour; one-sentence basis with sources (task_id notes, sibling tasks and their approved hours, Jira moves, planned calendar meetings); confidence high, medium or low; what would change it. Never count agent activity windows as human hours. The person's past corrections are project facts: check them and say when one adjusted an estimate. Never call hours logged before the Jira receipt exists.

## Deliveries and approvals

Asked about a brief or close, read the artifact and each item's public status with memory_schedule_runs by run_id (in solo mode, unread deliveries show in the project's memory_context). Cite the time, per-channel and per-item status, and link «Entregas». Quote reasons as the Hub records them: «omitido: Agent Hub cerrado», «diferido por cuota hasta las 19:40», «correo no enviado: token vencido», «incierto: el Hub no pudo confirmar el resultado y no reintenta solo». Never read uncertain as success or failure.

The person approves, corrects or rejects by replying on the proposal's channel or in «Entregas». Never approve for them: you lack the tool and it wouldn't count. Expired proposal: «Volver a proponer» in «Entregas»; uncertain items aren't re-proposed until the Hub reconciles whether they ran. Actions outside the proposal: do them in the conversation with their tools and usual permissions, or note them for the next close. For an agent to continue an approved item, the person adds a separate line «Seguimiento N: <qué hacer>» (N = item number) to the same reply: one per project, max 500 characters, only enabled projects with a channel; the Hub ignores a line it can't separate with certainty.

## Launched for a follow-up

For a «Seguimiento N: …» line the Hub may launch you as project agent with a restricted profile: work only on that instruction, in the assigned worktree, repo and branches; report in the project channel; propose pushes or Jira changes via memory_push_propose or a task_id note for the next close. Never run external writes, touch the main branch or approve anything.

## Limits

- No polls, recurring self-reminders or checks on other agents: the Hub supervises deterministically.
- Never message the brief thread or the person's own Slack or Gmail chat: that channel is the Hub's.
- Never store codes, approval replies or control-mailbox content in memory, notes or facts.
- Respect «Ajustes» switches: with automations off the feature doesn't run; say so, no workarounds.
`

export const responsabilidadSkill = {
  slug: 'responsabilidad',
  display_name: 'Brief diario y cierre del día',
  description: 'Agent Hub per-project 08:00 brief and 17:30 close: enable, pick channels once, set times, record progress with task_id for proposed hours and tasks, explain deliveries and approvals. Use for brief, resumen diario, cierre del día, cargar horas, mover tareas, pushes pendientes, automatizaciones.',
  body: responsabilidadBody,
}
