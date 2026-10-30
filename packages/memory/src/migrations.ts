// SQLite schema. Equivalent to PostgreSQL schema version 4 (see legacy-postgres.ts for the import).
// Conventions: ids are TEXT uuids; timestamps are ISO-8601 UTC TEXT ('YYYY-MM-DDTHH:MM:SS.sssZ') so they
// compare as strings; JSON/BOOLEAN declared types drive result conversion in database-engine.ts.
// `entities` and `fragments` carry an INTEGER PRIMARY KEY `rid` because FTS5 maps rows by rowid and
// VACUUM may renumber implicit rowids. Schema objects use only built-in SQL so external tools can open the file.
const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const ENTITY_TEXT = (row: string) => `${row}.title || char(10) || COALESCE(${row}.data->>'description','') || char(10) || COALESCE(${row}.data->>'text','')
  || char(10) || COALESCE(${row}.data->>'email','') || char(10) || COALESCE(${row}.data->>'category','') || char(10) || COALESCE(${row}.data->>'status','')`

export const migrations = [String.raw`
CREATE TABLE entities (
  rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('company','project','person','meeting','event','document','message','issue','note','collection','fact')),
  title TEXT NOT NULL, data JSON NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX entities_kind ON entities(kind, updated_at DESC);
CREATE TABLE connectors (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL,
  config JSON NOT NULL DEFAULT '{}', project_ids JSON NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT 0, interval_minutes INTEGER NOT NULL DEFAULT 30,
  cursor JSON NOT NULL DEFAULT '{}', last_success_at TIMESTAMP, last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, account TEXT NOT NULL, external_id TEXT NOT NULL,
  connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL, url TEXT,
  current_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL DEFAULT 'active', synced_at TIMESTAMP NOT NULL DEFAULT ${NOW},
  UNIQUE(provider,account,external_id)
);
CREATE TABLE versions (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL, original_path TEXT NOT NULL,
  metadata JSON NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL DEFAULT ${NOW},
  UNIQUE(source_id,content_hash)
);
CREATE TABLE identities (
  provider TEXT NOT NULL, account TEXT NOT NULL, external_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL, email TEXT, verified BOOLEAN NOT NULL DEFAULT 0,
  PRIMARY KEY(provider,account,external_id)
);
CREATE INDEX identities_person ON identities(person_id);
CREATE TABLE fragments (
  rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, text TEXT NOT NULL, speaker_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  start_time TIMESTAMP, end_time TIMESTAMP, offset_ms INTEGER,
  metadata JSON NOT NULL DEFAULT '{}',
  UNIQUE(version_id,ordinal)
);
CREATE INDEX fragments_speaker ON fragments(speaker_id,start_time);
CREATE TABLE fragment_projects (
  fragment_id TEXT REFERENCES fragments(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY(fragment_id,project_id)
);
CREATE INDEX fragment_projects_project ON fragment_projects(project_id,fragment_id);
CREATE TABLE links (
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, type TEXT NOT NULL,
  data JSON NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL DEFAULT ${NOW},
  UNIQUE(from_id,to_id,type), CHECK(from_id <> to_id)
);
CREATE INDEX links_to ON links(to_id,type);
CREATE TABLE evidence (
  entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
  fragment_id TEXT REFERENCES fragments(id) ON DELETE CASCADE,
  PRIMARY KEY(entity_id,fragment_id)
);
CREATE INDEX evidence_fragment ON evidence(fragment_id);
CREATE TABLE link_evidence (
  link_id TEXT REFERENCES links(id) ON DELETE CASCADE, fragment_id TEXT REFERENCES fragments(id) ON DELETE CASCADE,
  PRIMARY KEY(link_id,fragment_id)
);
CREATE TABLE embeddings (
  fragment_id TEXT REFERENCES fragments(id) ON DELETE CASCADE,
  model TEXT NOT NULL, dimension INTEGER NOT NULL, embedding BLOB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, PRIMARY KEY(fragment_id,model),
  CHECK(length(embedding)=dimension*4)
);
CREATE TABLE entity_embeddings (
  entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
  model TEXT NOT NULL, dimension INTEGER NOT NULL, embedding BLOB NOT NULL, content_hash TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, PRIMARY KEY(entity_id,model),
  CHECK(length(embedding)=dimension*4)
);
CREATE TABLE collection_records (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  "values" JSON NOT NULL, schema_version INTEGER NOT NULL,
  idempotency_key TEXT, origin TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW},
  UNIQUE(collection_id,idempotency_key)
);
CREATE TABLE record_evidence (
  record_id TEXT REFERENCES collection_records(id) ON DELETE CASCADE,
  fragment_id TEXT REFERENCES fragments(id) ON DELETE CASCADE,
  PRIMARY KEY(record_id,fragment_id)
);
CREATE TABLE rules (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name TEXT NOT NULL, instructions TEXT NOT NULL, project_ids JSON NOT NULL DEFAULT '[]',
  person_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE TABLE rule_runs (
  rule_id TEXT REFERENCES rules(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  version_id TEXT REFERENCES versions(id) ON DELETE CASCADE,
  completed_at TIMESTAMP NOT NULL DEFAULT ${NOW}, PRIMARY KEY(rule_id,revision,version_id)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload JSON NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TIMESTAMP NOT NULL DEFAULT ${NOW}, lease_until TIMESTAMP, lease_owner TEXT,
  progress JSON NOT NULL DEFAULT '{}', error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE UNIQUE INDEX jobs_active_dedupe ON jobs(dedupe_key) WHERE state IN ('queued','running','waiting');
CREATE INDEX jobs_ready ON jobs(state,available_at);
CREATE INDEX jobs_dedupe ON jobs(dedupe_key,state);
CREATE INDEX jobs_version ON jobs(payload->>'version_id');
CREATE TABLE settings (key TEXT PRIMARY KEY, value JSON NOT NULL);
CREATE TABLE changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT, action TEXT NOT NULL, actor TEXT NOT NULL,
  before_value JSON, after_value JSON, created_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX changes_entity ON changes(entity_id, id DESC);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('jira','pending')),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('todo','in_progress','blocked','done','dropped')),
  origin TEXT NOT NULL DEFAULT 'manual',
  external_key TEXT, external_status TEXT, external_category TEXT, external_url TEXT, external_updated_at TIMESTAMP,
  issue_type TEXT, priority TEXT, assignee TEXT, code_ref TEXT,
  source_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}, closed_at TIMESTAMP,
  external_site TEXT NOT NULL DEFAULT '',
  CHECK(kind <> 'jira' OR external_key IS NOT NULL)
);
CREATE UNIQUE INDEX tasks_jira_key ON tasks(external_site,external_key) WHERE kind='jira';
CREATE INDEX tasks_project ON tasks(project_id,status,updated_at DESC);
CREATE TABLE task_evidence (
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, fragment_id TEXT REFERENCES fragments(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id,fragment_id)
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action TEXT NOT NULL, actor TEXT NOT NULL, status_before TEXT, status_after TEXT,
  detail JSON NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX task_events_task ON task_events(task_id,created_at);
CREATE INDEX task_events_created ON task_events(created_at);
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_label TEXT NOT NULL, cli_kind TEXT NOT NULL DEFAULT '',
  cwd TEXT, project_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  started_at TIMESTAMP NOT NULL DEFAULT ${NOW}, last_seen_at TIMESTAMP NOT NULL DEFAULT ${NOW}, ended_at TIMESTAMP
);
CREATE TABLE agent_notes (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL, agent_label TEXT NOT NULL, cli_kind TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES entities(id) ON DELETE CASCADE, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 600),
  state TEXT NOT NULL CHECK(state IN ('working','done','blocked')), finish_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}, finished_at TIMESTAMP
);
CREATE INDEX agent_notes_project ON agent_notes(project_id,updated_at DESC);
CREATE INDEX agent_notes_working ON agent_notes(session_id) WHERE state='working';

-- Full text: PostgreSQL used to_tsvector('simple', …); unicode61 also folds accents ("reunion" finds "reunión").
CREATE VIRTUAL TABLE fragments_fts USING fts5(text, content='fragments', content_rowid='rid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER fragments_fts_insert AFTER INSERT ON fragments BEGIN
  INSERT INTO fragments_fts(rowid,text) VALUES(new.rid,new.text);
END;
CREATE TRIGGER fragments_fts_delete AFTER DELETE ON fragments BEGIN
  INSERT INTO fragments_fts(fragments_fts,rowid,text) VALUES('delete',old.rid,old.text);
END;
CREATE TRIGGER fragments_fts_update AFTER UPDATE OF text ON fragments BEGIN
  INSERT INTO fragments_fts(fragments_fts,rowid,text) VALUES('delete',old.rid,old.text);
  INSERT INTO fragments_fts(rowid,text) VALUES(new.rid,new.text);
END;
CREATE VIRTUAL TABLE entities_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER entities_fts_insert AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid,text) VALUES(new.rid,${ENTITY_TEXT('new')});
END;
CREATE TRIGGER entities_fts_delete AFTER DELETE ON entities BEGIN
  DELETE FROM entities_fts WHERE rowid=old.rid;
END;
CREATE TRIGGER entities_fts_update AFTER UPDATE OF title,data ON entities BEGIN
  DELETE FROM entities_fts WHERE rowid=old.rid;
  INSERT INTO entities_fts(rowid,text) VALUES(new.rid,${ENTITY_TEXT('new')});
END;
`, String.raw`
-- Search starts from matching fragments; resolve their current source without scanning all sources.
CREATE INDEX sources_current_version ON sources(current_version_id);
`, String.raw`
-- Case-fold before indexing so substring candidates use the same Unicode lower() as ILIKE.
-- Contentless storage avoids duplicating transcript text. Residual ILIKE checks preserve wildcards.
CREATE VIRTUAL TABLE fragments_substrings USING fts5(text, content='', contentless_delete=1, tokenize='trigram case_sensitive 1');
INSERT INTO fragments_substrings(rowid,text) SELECT rid,lower(text) FROM fragments;
CREATE TRIGGER fragments_substrings_insert AFTER INSERT ON fragments BEGIN
  INSERT INTO fragments_substrings(rowid,text) VALUES(new.rid,lower(new.text));
END;
CREATE TRIGGER fragments_substrings_delete AFTER DELETE ON fragments BEGIN
  DELETE FROM fragments_substrings WHERE rowid=old.rid;
END;
CREATE TRIGGER fragments_substrings_update AFTER UPDATE OF text ON fragments BEGIN
  DELETE FROM fragments_substrings WHERE rowid=old.rid;
  INSERT INTO fragments_substrings(rowid,text) VALUES(new.rid,lower(new.text));
END;
`, String.raw`
CREATE TABLE shared_projects (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  genesis JSON NOT NULL, policy_hash TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 1,
  conflict TEXT, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE TABLE shared_policies (
  hash TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, document JSON NOT NULL
);
CREATE INDEX shared_policies_project ON shared_policies(project_id,revision);
CREATE TABLE shared_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  document JSON NOT NULL, payload JSON, received_from TEXT,
  applied BOOLEAN NOT NULL DEFAULT 0, received_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX shared_events_project ON shared_events(project_id,seq);
CREATE TABLE shared_items (
  project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE, item_key TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL, heads JSON NOT NULL DEFAULT '[]',
  published_hash TEXT, PRIMARY KEY(project_id,item_key)
);
CREATE TABLE shared_objects (
  project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE, item_key TEXT NOT NULL,
  local_id TEXT NOT NULL, heads JSON NOT NULL DEFAULT '[]', published_hash TEXT,
  PRIMARY KEY(project_id,item_key)
);
CREATE TABLE shared_notices (
  project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE, recipient TEXT NOT NULL,
  fingerprint TEXT NOT NULL, shown_at TIMESTAMP NOT NULL, PRIMARY KEY(project_id,recipient)
);
CREATE TABLE shared_peers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen_at TIMESTAMP NOT NULL, error TEXT
);
CREATE TABLE shared_source_sync (
  project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  item_key TEXT, input_hash TEXT, heads JSON NOT NULL DEFAULT '[]',
  checked_at TIMESTAMP NOT NULL DEFAULT ${NOW}, error TEXT,
  PRIMARY KEY(project_id,entity_id)
);
`, String.raw`
-- Local collaboration never enters the shared/P2P project event log.
CREATE TABLE chat_channels (
 id TEXT PRIMARY KEY, project_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
 path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, branch TEXT, repository TEXT,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE TABLE chat_sessions (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, native_id TEXT, key_hash TEXT NOT NULL UNIQUE,
 label TEXT NOT NULL, cli_kind TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES chat_channels(id),
 state TEXT NOT NULL DEFAULT 'idle', capability TEXT NOT NULL DEFAULT 'next_turn',
 process_id INTEGER, process_started TEXT, lease_until TIMESTAMP, event_at TIMESTAMP NOT NULL,
 last_seen_at TIMESTAMP NOT NULL DEFAULT ${NOW}, created_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 closed_at TIMESTAMP, wake_error TEXT
);
CREATE INDEX chat_sessions_channel ON chat_sessions(channel_id,last_seen_at);
CREATE TABLE chat_threads (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES chat_channels(id),
 title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL REFERENCES chat_sessions(id),
 task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX chat_threads_channel ON chat_threads(channel_id,updated_at);
CREATE TABLE chat_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES chat_threads(id),
 author_id TEXT NOT NULL REFERENCES chat_sessions(id), text TEXT NOT NULL,
 reply_to TEXT REFERENCES chat_messages(id), request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, UNIQUE(author_id,request_id)
);
CREATE INDEX chat_messages_thread ON chat_messages(thread_id,seq);
CREATE TABLE chat_deliveries (
 message_id TEXT NOT NULL REFERENCES chat_messages(id), recipient_id TEXT NOT NULL REFERENCES chat_sessions(id),
 notified_at TIMESTAMP, read_at TIMESTAMP, handled_at TIMESTAMP,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMP NOT NULL DEFAULT ${NOW}, error TEXT,
 PRIMARY KEY(message_id,recipient_id)
);
CREATE INDEX chat_deliveries_pending ON chat_deliveries(recipient_id,read_at,next_attempt_at);
`, String.raw`
ALTER TABLE chat_sessions ADD COLUMN nickname TEXT;
ALTER TABLE chat_sessions ADD COLUMN nickname_key TEXT;
CREATE UNIQUE INDEX chat_sessions_nickname ON chat_sessions(nickname_key);
UPDATE chat_sessions SET label='Sin nick todavía';
`, String.raw`
-- Identity and location are separate: two Orca spaces may share a directory.
-- Renaming the unique column preserves every channel FK without rebuilding tables.
ALTER TABLE chat_channels RENAME COLUMN path TO scope_key;
ALTER TABLE chat_channels ADD COLUMN path TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_channels ADD COLUMN orca_workspace_id TEXT;
UPDATE chat_channels SET path=scope_key,scope_key='git:'||scope_key;
CREATE UNIQUE INDEX chat_channels_orca ON chat_channels(orca_workspace_id);
`, String.raw`
ALTER TABLE chat_sessions ADD COLUMN orca_terminal JSON;
`, String.raw`
ALTER TABLE chat_channels ADD COLUMN leader_id TEXT REFERENCES chat_sessions(id);
ALTER TABLE chat_sessions ADD COLUMN team_seen BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE chat_sessions ADD COLUMN bootstrap_sent_at TIMESTAMP;
-- Existing teams retain their first participating conversation as coordinator.
UPDATE chat_channels SET leader_id=(SELECT s.id FROM chat_sessions s WHERE s.channel_id=chat_channels.id AND s.nickname IS NOT NULL ORDER BY s.created_at,s.id LIMIT 1);
ALTER TABLE chat_sessions ADD COLUMN bootstrap_attempts INTEGER NOT NULL DEFAULT 0;
-- Terminal hosts are optional metadata, never a delivery transport.
UPDATE chat_sessions SET capability='next_turn',orca_terminal=NULL,
 wake_error='Reabrí esta conversación con agenthub-kiro para activar la escucha independiente del Hub.' WHERE capability='orca_prompt';
`, String.raw`
ALTER TABLE chat_sessions ADD COLUMN removed_at TIMESTAMP;
ALTER TABLE chat_sessions ADD COLUMN removed_by TEXT;
ALTER TABLE chat_sessions ADD COLUMN removal_reason TEXT;
ALTER TABLE chat_sessions ADD COLUMN gateway_session_id TEXT;
UPDATE chat_sessions SET gateway_session_id=id WHERE native_id IS NOT NULL;
CREATE INDEX chat_sessions_gateway ON chat_sessions(agent_id,gateway_session_id);
ALTER TABLE chat_deliveries ADD COLUMN cancelled_at TIMESTAMP;
`, String.raw`
-- Ordinary folders only become channels after an explicit agent tool call.
ALTER TABLE chat_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE chat_channels ADD COLUMN activated_at TIMESTAMP;
ALTER TABLE chat_channels ADD COLUMN closed_at TIMESTAMP;
ALTER TABLE chat_channels ADD COLUMN virtual_path TEXT;
CREATE UNIQUE INDEX chat_channels_virtual_open ON chat_channels(virtual_path);
`, String.raw`
CREATE TABLE chat_team_plans (
 id TEXT PRIMARY KEY, master_channel_id TEXT NOT NULL REFERENCES chat_channels(id),
 root_thread_id TEXT NOT NULL UNIQUE REFERENCES chat_threads(id), created_by TEXT NOT NULL REFERENCES chat_sessions(id),
 objective TEXT NOT NULL, parent JSON NOT NULL, base_revision TEXT NOT NULL, plan JSON NOT NULL, digest TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL, human_instruction TEXT, launched_by TEXT REFERENCES chat_sessions(id),
 launch_started_at TIMESTAMP, launched_at TIMESTAMP, close_reason TEXT, closed_at TIMESTAMP,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX chat_team_plans_master ON chat_team_plans(master_channel_id,updated_at);
CREATE TABLE chat_team_members (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES chat_team_plans(id), ordinal INTEGER NOT NULL,
 worktree_name TEXT NOT NULL, cli TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, role TEXT NOT NULL, task TEXT NOT NULL,
 prompt TEXT NOT NULL, capabilities JSON, state TEXT NOT NULL,
 workspace_id TEXT UNIQUE, workspace_path TEXT, workspace_repo_id TEXT, workspace_head TEXT,
 launch_handle TEXT, launch_kind TEXT, operation_id TEXT, prompt_outcome TEXT, error TEXT,
 invitation_hash TEXT UNIQUE, invitation_expires_at TIMESTAMP, invitation_used_at TIMESTAMP,
 session_id TEXT UNIQUE REFERENCES chat_sessions(id), channel_id TEXT UNIQUE REFERENCES chat_channels(id),
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 UNIQUE(team_id,ordinal), UNIQUE(team_id,worktree_name)
);
CREATE INDEX chat_team_members_team ON chat_team_members(team_id,ordinal);
CREATE TABLE chat_team_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, team_id TEXT NOT NULL REFERENCES chat_team_plans(id),
 member_id TEXT REFERENCES chat_team_members(id), type TEXT NOT NULL, actor_session_id TEXT REFERENCES chat_sessions(id),
 source_channel_id TEXT REFERENCES chat_channels(id), target_thread_id TEXT REFERENCES chat_threads(id), payload JSON NOT NULL DEFAULT '{}',
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX chat_team_events_team ON chat_team_events(team_id,seq);
`, String.raw`
CREATE TABLE chat_work_state (
 session_id TEXT NOT NULL REFERENCES chat_sessions(id), work_id TEXT NOT NULL,
 thread_id TEXT NOT NULL REFERENCES chat_threads(id), status TEXT NOT NULL CHECK(status IN ('active','waiting','completed')),
 summary TEXT NOT NULL, waiting_for TEXT, last_progress_at TIMESTAMP, reported_at TIMESTAMP,
 report_message_id TEXT REFERENCES chat_messages(id), version INTEGER NOT NULL, updated_at TIMESTAMP NOT NULL,
 PRIMARY KEY(session_id,work_id)
);
CREATE INDEX chat_work_thread ON chat_work_state(thread_id,updated_at);
CREATE TABLE chat_work_events (
 session_id TEXT NOT NULL REFERENCES chat_sessions(id), request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, snapshot JSON NOT NULL, PRIMARY KEY(session_id,request_id)
);
`, String.raw`
-- Shadow observations are evidence, never delivery/recovery attempts or agent messages.
CREATE TABLE chat_watchdog_observations (
 session_id TEXT NOT NULL, work_id TEXT NOT NULL, work_version INTEGER NOT NULL,
 policy_version TEXT NOT NULL, policy_config JSON NOT NULL, decision JSON NOT NULL, snapshot JSON NOT NULL,
 fingerprint TEXT NOT NULL, first_observed_at TIMESTAMP NOT NULL, last_observed_at TIMESTAMP NOT NULL,
 next_scan_at TIMESTAMP NOT NULL,
 PRIMARY KEY(session_id,work_id),
 FOREIGN KEY(session_id,work_id) REFERENCES chat_work_state(session_id,work_id) ON DELETE CASCADE
);
CREATE INDEX chat_watchdog_due ON chat_watchdog_observations(next_scan_at);
CREATE TABLE chat_watchdog_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, work_id TEXT NOT NULL,
 work_version INTEGER NOT NULL, policy_version TEXT NOT NULL, policy_config JSON NOT NULL,
 decision JSON NOT NULL, snapshot JSON NOT NULL, observed_at TIMESTAMP NOT NULL,
 FOREIGN KEY(session_id,work_id) REFERENCES chat_work_state(session_id,work_id) ON DELETE CASCADE
);
`, String.raw`
-- Per-session read state is separate from mention deliveries: every reader advances independently.
CREATE TABLE chat_read_receipts (
 session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
 read_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 PRIMARY KEY(session_id,message_id)
);
CREATE INDEX chat_read_receipts_message ON chat_read_receipts(message_id);
-- chat_read historically advanced mention deliveries. Preserve that read state when upgrading.
INSERT OR IGNORE INTO chat_read_receipts(session_id,message_id,read_at)
 SELECT recipient_id,message_id,read_at FROM chat_deliveries WHERE read_at IS NOT NULL;
`, String.raw`
-- Child team threads live in the master channel but are ACL-bound to this immutable root.
ALTER TABLE chat_threads ADD COLUMN team_root_thread_id TEXT REFERENCES chat_threads(id);
CREATE INDEX chat_threads_team_root ON chat_threads(team_root_thread_id,updated_at);
`, String.raw`
-- Hook-observed turns are deliberately separate from work state and messages.
CREATE TABLE chat_turn_state (
 session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL, opened_at TIMESTAMP NOT NULL, terminal_at TIMESTAMP,
 terminal_cause TEXT, chat_sent_at TIMESTAMP, alerted_at TIMESTAMP, last_event_at TIMESTAMP NOT NULL
);
CREATE TABLE chat_turn_alerts (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL, cause TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES chat_sessions(id),
 message_id TEXT NOT NULL UNIQUE REFERENCES chat_messages(id), created_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 UNIQUE(session_id,turn_id,cause)
);
CREATE INDEX chat_turn_alerts_recipient ON chat_turn_alerts(recipient_id,created_at);
`, String.raw`
-- A session can close one turn while the next is already open; retain every turn independently.
CREATE TABLE chat_turns (
 session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL, opened_at TIMESTAMP NOT NULL, terminal_at TIMESTAMP,
 terminal_cause TEXT, chat_sent_at TIMESTAMP, alerted_at TIMESTAMP, last_event_at TIMESTAMP NOT NULL,
 PRIMARY KEY(session_id,turn_id)
);
CREATE INDEX chat_turns_pending ON chat_turns(terminal_at,alerted_at,chat_sent_at);
INSERT INTO chat_turns(session_id,turn_id,opened_at,terminal_at,terminal_cause,chat_sent_at,alerted_at,last_event_at)
 SELECT session_id,turn_id,opened_at,terminal_at,terminal_cause,chat_sent_at,alerted_at,last_event_at FROM chat_turn_state;
`, String.raw`
-- Bind observations to the coordination scope in which the turn started.
ALTER TABLE chat_turns ADD COLUMN channel_id TEXT REFERENCES chat_channels(id);
ALTER TABLE chat_turns ADD COLUMN team_id TEXT REFERENCES chat_team_plans(id);
ALTER TABLE chat_turns ADD COLUMN waiting_at_close INTEGER NOT NULL DEFAULT 0;
UPDATE chat_turns SET channel_id=(SELECT channel_id FROM chat_sessions WHERE id=session_id);
-- Earlier observations lack a scope snapshot and must not produce fresh notifications after upgrade.
UPDATE chat_turns SET alerted_at=COALESCE(alerted_at,${NOW});
`, String.raw`
-- Private status notifications do not belong to the team's conversation history.
CREATE TABLE chat_status_notices (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL, cause TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES chat_channels(id),
 team_id TEXT REFERENCES chat_team_plans(id), recipient_id TEXT NOT NULL REFERENCES chat_sessions(id),
 work_thread_id TEXT REFERENCES chat_threads(id), text TEXT NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, notified_at TIMESTAMP, read_at TIMESTAMP,
 handled_at TIMESTAMP, cancelled_at TIMESTAMP, error TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 UNIQUE(session_id,turn_id)
);
CREATE INDEX chat_status_notices_recipient ON chat_status_notices(recipient_id,read_at,next_attempt_at);
CREATE UNIQUE INDEX chat_status_notices_pending ON chat_status_notices(session_id,recipient_id)
 WHERE handled_at IS NULL AND cancelled_at IS NULL;
ALTER TABLE chat_turns ADD COLUMN report_recipient_id TEXT REFERENCES chat_sessions(id);
ALTER TABLE chat_threads ADD COLUMN archived_notice INTEGER NOT NULL DEFAULT 0;
-- Retain legacy content for audit, but hide automatic-only notice threads from conversations.
UPDATE chat_threads SET archived_notice=1 WHERE id IN (
 SELECT m.thread_id FROM chat_turn_alerts a JOIN chat_messages m ON m.id=a.message_id
 JOIN chat_sessions s ON s.id=m.author_id WHERE s.agent_id='agenthub-system' AND s.cli_kind='hub'
) AND NOT EXISTS (
 SELECT 1 FROM chat_messages m JOIN chat_sessions s ON s.id=m.author_id
 WHERE m.thread_id=chat_threads.id AND (s.agent_id<>'agenthub-system' OR s.cli_kind<>'hub')
);
UPDATE chat_deliveries SET cancelled_at=COALESCE(cancelled_at,${NOW}),error='Aviso automático legado retirado'
 WHERE message_id IN (SELECT message_id FROM chat_turn_alerts);
-- Never replay pre-upgrade activity under the new notification contract.
UPDATE chat_turns SET alerted_at=COALESCE(alerted_at,${NOW});
`, String.raw`
-- Local native quota observations are not shared project events or credentials.
CREATE TABLE usage_quota_bindings (
 binding_id TEXT PRIMARY KEY, binding_version INTEGER NOT NULL,
 cli TEXT NOT NULL, provider TEXT NOT NULL, account_ref TEXT,
 active BOOLEAN NOT NULL DEFAULT 1, bound_at TIMESTAMP NOT NULL
);
CREATE TABLE usage_quota_pools (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_ref TEXT, pool_id TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('account','binding')),
 active BOOLEAN NOT NULL DEFAULT 1, observation JSON NOT NULL, window_evidence JSON NOT NULL DEFAULT '{}', status_evidence JSON, last_known JSON, observed_status TEXT NOT NULL, event_state TEXT NOT NULL DEFAULT 'unknown',
 observed_at TIMESTAMP NOT NULL, digest TEXT NOT NULL
);
CREATE TABLE usage_quota_memberships (
 binding_id TEXT NOT NULL REFERENCES usage_quota_bindings(binding_id) ON DELETE CASCADE,
 pool_key TEXT NOT NULL REFERENCES usage_quota_pools(id) ON DELETE CASCADE,
 PRIMARY KEY(binding_id,pool_key)
);
CREATE TABLE usage_quota_notices (
 id TEXT PRIMARY KEY, event_key TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES chat_sessions(id),
 channel_id TEXT NOT NULL REFERENCES chat_channels(id), team_id TEXT REFERENCES chat_team_plans(id),
 payload JSON NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, read_at TIMESTAMP, notified_at TIMESTAMP,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMP NOT NULL DEFAULT ${NOW}, UNIQUE(event_key,recipient_id)
);
CREATE INDEX usage_quota_notices_pending ON usage_quota_notices(recipient_id,read_at,next_attempt_at);
CREATE TABLE usage_quota_transitions (
 id TEXT PRIMARY KEY, pool_key TEXT NOT NULL REFERENCES usage_quota_pools(id) ON DELETE CASCADE,
 before_state TEXT NOT NULL, after_state TEXT NOT NULL, observed_at TIMESTAMP NOT NULL,
 UNIQUE(pool_key,observed_at)
);
`, String.raw`
ALTER TABLE chat_team_members ADD COLUMN runtime JSON;
`, String.raw`
ALTER TABLE chat_channels ADD COLUMN deleted_at TIMESTAMP;
ALTER TABLE chat_channels ADD COLUMN deleted_by TEXT;
ALTER TABLE chat_channels ADD COLUMN deletion_reason TEXT;
ALTER TABLE chat_team_plans ADD COLUMN approval_source TEXT;
ALTER TABLE chat_team_plans ADD COLUMN approved_by_user_id TEXT;
`, String.raw`
ALTER TABLE chat_team_members ADD COLUMN work_thread_id TEXT REFERENCES chat_threads(id);
-- Existing teams keep their conversation. Add dedicated task threads without inventing reports.
INSERT INTO chat_threads(id,channel_id,title,created_by,team_root_thread_id,state)
 SELECT m.id,p.master_channel_id,substr(m.worktree_name,1,200),p.created_by,p.root_thread_id,
 CASE WHEN p.state IN ('cancelled','completed') THEN 'resolved' ELSE 'open' END
 FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id;
UPDATE chat_team_members SET work_thread_id=id;
CREATE INDEX chat_team_members_workspace_path ON chat_team_members(workspace_path);
`, String.raw`
ALTER TABLE chat_deliveries ADD COLUMN response_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_deliveries ADD COLUMN response_message_id TEXT REFERENCES chat_messages(id);
ALTER TABLE chat_deliveries ADD COLUMN response_alerted_at TIMESTAMP;
CREATE INDEX chat_deliveries_responses ON chat_deliveries(response_required,response_message_id,cancelled_at);
`, String.raw`
-- Execution workspaces no longer determine channel identity. Keep existing scopes/history.
DROP INDEX chat_channels_orca;
CREATE INDEX chat_channels_orca ON chat_channels(orca_workspace_id);
`, String.raw`
-- Scheduler. A run's definition is frozen at creation, so editing a schedule never changes an occurrence already created.
CREATE TABLE schedules (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('project','owner')), project_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
 template TEXT NOT NULL CHECK(template IN ('reminder','custom_synthesis','daily_brief','daily_close','project_status','team_health')),
 template_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('notice','synthesis')),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), instructions TEXT NOT NULL DEFAULT '' CHECK(length(instructions)<=4000),
 params JSON NOT NULL DEFAULT '{}', recurrence JSON NOT NULL, delivery JSON NOT NULL,
 misfire TEXT NOT NULL CHECK(misfire IN ('run_once','skip')), grace_minutes INTEGER NOT NULL,
 grace_policy TEXT NOT NULL DEFAULT 'minutes' CHECK(grace_policy IN ('minutes','until_next','until_local_time')), grace_until TEXT, target_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','paused','cancelled','expired','completed')),
 paused_by TEXT CHECK(paused_by IN ('agent','human','system')), next_run_at TIMESTAMP, expires_at TIMESTAMP,
 revision INTEGER NOT NULL DEFAULT 1, created_by_kind TEXT NOT NULL CHECK(created_by_kind IN ('agent','human','system')),
 created_by_agent TEXT, created_by_session TEXT, origin JSON NOT NULL DEFAULT '{}',
 cancelled_at TIMESTAMP, cancelled_by TEXT CHECK(cancelled_by IN ('agent','human','system')), cancel_reason TEXT,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 CHECK((scope='project')=(project_id IS NOT NULL)),
 CHECK(created_by_kind<>'agent' OR (created_by_agent IS NOT NULL AND created_by_session IS NOT NULL))
);
CREATE UNIQUE INDEX schedules_live_target ON schedules(target_key) WHERE state IN ('active','paused');
CREATE INDEX schedules_due ON schedules(state,next_run_at);
CREATE INDEX schedules_project ON schedules(project_id,state);
CREATE TABLE schedule_constraints (
 id TEXT PRIMARY KEY, subject TEXT NOT NULL CHECK(subject IN ('project','owner')), project_id TEXT, template TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('target','template_project')), target_key TEXT,
 schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL, created_by_user TEXT NOT NULL, reason TEXT,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, lifted_at TIMESTAMP, lifted_by_user TEXT,
 CHECK(scope<>'target' OR target_key IS NOT NULL), CHECK((subject='project')=(project_id IS NOT NULL))
);
CREATE UNIQUE INDEX schedule_constraints_active ON schedule_constraints(scope,COALESCE(project_id,''),template,COALESCE(target_key,'')) WHERE lifted_at IS NULL;
CREATE TABLE schedule_runs (
 id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
 scheduled_for TIMESTAMP NOT NULL, schedule_revision INTEGER NOT NULL, definition JSON NOT NULL,
 trigger TEXT NOT NULL CHECK(trigger IN ('clock','misfire','run_now')),
 state TEXT NOT NULL CHECK(state IN ('pending','running','deferred','succeeded','partial','failed','uncertain','skipped','cancelled','interrupted')),
 phase TEXT NOT NULL CHECK(phase IN ('collect','synthesize','persist','deliver','done')),
 generation INTEGER NOT NULL DEFAULT 0, skip_reason TEXT CHECK(skip_reason IN ('overlap','misfire_out_of_grace','superseded','automations_off','schedule_cancelled','remote_processing_excluded')),
 deferred_reason TEXT CHECK(deferred_reason IN ('quota','automations_off','delivery_unavailable')),
 next_attempt_at TIMESTAMP, quota JSON, artifact_id TEXT,
 continuity TEXT CHECK(continuity IN ('live_destination','fork','exclusive_resume','linked_new','none')), error_code TEXT,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, started_at TIMESTAMP, finished_at TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 UNIQUE(schedule_id,scheduled_for)
);
CREATE INDEX schedule_runs_due ON schedule_runs(state,next_attempt_at);
CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule_id,scheduled_for DESC);
CREATE TABLE schedule_run_attempts (
 run_id TEXT NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE, generation INTEGER NOT NULL, phase TEXT NOT NULL,
 profile TEXT NOT NULL CHECK(profile IN ('notice','synthesis')), cli TEXT, model TEXT, boot_id TEXT,
 host_pid INTEGER, host_started TEXT, cli_pid INTEGER, cli_started TEXT,
 state TEXT NOT NULL CHECK(state IN ('starting','running','exited','deadline_exceeded','terminated','orphan_terminated','orphan_unverified','termination_unknown','spawn_failed')),
 deadline_at TIMESTAMP NOT NULL, started_at TIMESTAMP, ended_at TIMESTAMP, exit_code TEXT,
 PRIMARY KEY(run_id,generation)
);
CREATE INDEX schedule_run_attempts_live ON schedule_run_attempts(state);
CREATE TABLE schedule_run_phases (
 run_id TEXT NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE, phase TEXT NOT NULL, generation INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('started','done','failed','uncertain','skipped')), receipt JSON NOT NULL DEFAULT '{}',
 started_at TIMESTAMP, finished_at TIMESTAMP,
 PRIMARY KEY(run_id,phase,generation)
);
CREATE TABLE schedule_deliveries (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
 target TEXT NOT NULL CHECK(target IN ('hub_inbox','app_window','gmail_self','slack_self')),
 state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','uncertain','skipped')), outbox_ref TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, read_at TIMESTAMP,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 UNIQUE(run_id,target)
);
CREATE TABLE schedule_artifacts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES schedule_runs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('notice','brief','close','status','report')), title TEXT NOT NULL, body_md TEXT NOT NULL,
 items JSON NOT NULL DEFAULT '[]', snapshot_refs JSON NOT NULL DEFAULT '[]', decision_request_ref TEXT,
 -- Effects validated by the template, written with the artifact so a crash before decision_request_ref is stored can be repaired; never exposed by any read path.
 effects JSON NOT NULL DEFAULT '[]',
 -- A restored artifact carries no authority until the decision module reconciles it, whatever the mirror says.
 authority TEXT NOT NULL DEFAULT 'live' CHECK(authority IN ('live','unavailable')),
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, read_at TIMESTAMP
);
-- Public mirror of each decision item's state; authority stays in the isolated decision store.
CREATE TABLE schedule_item_states (
 run_id TEXT NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, effect_digest TEXT, estimate_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('proposed','approved','rejected','dispatching','succeeded','uncertain','expired','superseded','unverifiable')),
 updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}, PRIMARY KEY(run_id,ordinal)
);
CREATE TABLE schedule_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, schedule_id TEXT, run_id TEXT, type TEXT NOT NULL,
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('agent','human','system')), actor_ref TEXT, request_id TEXT,
 payload JSON NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE UNIQUE INDEX schedule_events_request ON schedule_events(actor_ref,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX schedule_events_run ON schedule_events(run_id);
-- Terminated or interrupted processes of runs and fleet members; no foreign keys so the history outlives its subject.
CREATE TABLE process_incidents (
 id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL CHECK(subject_kind IN ('schedule_run','fleet_member')), subject_id TEXT NOT NULL, generation TEXT,
 schedule_id TEXT, run_id TEXT, team_id TEXT, member_id TEXT, session_id TEXT, project_id TEXT,
 cause TEXT NOT NULL CHECK(cause IN ('hub_restart','deadline_exceeded','automations_off','collaboration_off','cancelled','spawn_failed','process_exited')),
 action TEXT NOT NULL CHECK(action IN ('terminated','already_exited','unverified_left_running','termination_unknown','none')),
 pid INTEGER, process_started TEXT, boot_id TEXT, observed_at TIMESTAMP NOT NULL, detail JSON NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX process_incidents_subject ON process_incidents(subject_kind,subject_id,COALESCE(generation,''),cause);
CREATE INDEX process_incidents_project ON process_incidents(project_id,observed_at DESC);
-- Non-secret tombstones of delivery messages consulted before ingesting Gmail or Slack content; approval authority lives elsewhere.
CREATE TABLE decision_exclusions (
 integration TEXT NOT NULL, account TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('message','thread','rfc_message_id','conversation')), native_id TEXT NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, PRIMARY KEY(integration,account,kind,native_id)
);
`, String.raw`
ALTER TABLE chat_sessions ADD COLUMN model TEXT;
ALTER TABLE chat_sessions ADD COLUMN native_cwd TEXT;
ALTER TABLE chat_sessions ADD COLUMN start_source TEXT;
ALTER TABLE chat_sessions ADD COLUMN surface TEXT;
ALTER TABLE chat_sessions ADD COLUMN adapter_version TEXT;
ALTER TABLE chat_sessions ADD COLUMN id_captured_by TEXT;
ALTER TABLE chat_sessions ADD COLUMN id_captured_at TIMESTAMP;
ALTER TABLE chat_sessions ADD COLUMN resumable INTEGER NOT NULL DEFAULT 0;
CREATE TABLE cli_capabilities (
 cli TEXT NOT NULL, surface TEXT NOT NULL, version TEXT NOT NULL, capability TEXT NOT NULL,
 support TEXT NOT NULL CHECK(support IN ('supported','unsupported','unverified')), source_url TEXT, checked_at TIMESTAMP NOT NULL,
 PRIMARY KEY(cli,surface,version,capability)
);
CREATE TABLE liveness_incidents (
 id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, team_id TEXT, member_id TEXT, session_id TEXT NOT NULL, generation TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('possible_stall','missing_report','session_lost','report_undelivered')), episode TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open','resolved')), evidence JSON NOT NULL DEFAULT '{}', notice_id TEXT,
 opened_at TIMESTAMP NOT NULL, last_observed_at TIMESTAMP NOT NULL, resolved_at TIMESTAMP, resolution TEXT
);
CREATE INDEX liveness_incidents_team ON liveness_incidents(team_id,resolved_at);
CREATE INDEX liveness_incidents_session ON liveness_incidents(session_id,resolved_at);
CREATE TABLE progress_checkpoints (
 checkpoint_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, generation TEXT, opening_turn_id TEXT, last_native_turn_id TEXT,
 pending_since TIMESTAMP NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','reported','missing_report','closed')),
 report_kind TEXT CHECK(report_kind IN ('note','work_update','message')), report_ref TEXT, reported_at TIMESTAMP,
 continuation_count INTEGER NOT NULL DEFAULT 0 CHECK(continuation_count IN (0,1)), continuation_consumed_at TIMESTAMP, closed_at TIMESTAMP, closed_reason TEXT
);
CREATE INDEX progress_checkpoints_session ON progress_checkpoints(session_id,closed_at);
CREATE UNIQUE INDEX progress_checkpoints_open ON progress_checkpoints(session_id) WHERE closed_at IS NULL;
`, String.raw`
-- Standing delegation per project. channel_id and coordinator_session_id carry no foreign keys so deleting a channel or session never blocks on them.
CREATE TABLE project_automation (
 project_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, delegation_version INTEGER,
 channel_id TEXT, coordinator_session_id TEXT, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_by_user TEXT NOT NULL
);
CREATE TABLE project_delegations (
 project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, version INTEGER NOT NULL, document JSON NOT NULL, digest TEXT NOT NULL,
 approval_source TEXT NOT NULL CHECK(approval_source IN ('owner_ui','coordinator_declaration')), instruction TEXT,
 created_by_user TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, revoked_at TIMESTAMP, PRIMARY KEY(project_id,version)
);
CREATE TABLE project_repositories (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, repo_path TEXT NOT NULL, canonical_remote_url TEXT NOT NULL,
 remote_name TEXT NOT NULL DEFAULT 'origin', default_branch TEXT NOT NULL, allowed_branches JSON NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 UNIQUE(project_id,repo_path)
);
-- Pushes proposed by the agent that did the work; the close turns open candidates into approvable items.
CREATE TABLE push_candidates (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, repo_id TEXT NOT NULL REFERENCES project_repositories(id) ON DELETE CASCADE,
 branch TEXT NOT NULL, local_sha TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 300), proposed_by_agent TEXT NOT NULL, proposed_by_session TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('open','proposed','superseded','withdrawn')), run_id TEXT,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}, UNIQUE(repo_id,branch,local_sha)
);
ALTER TABLE chat_team_plans ADD COLUMN delegation_project_id TEXT;
ALTER TABLE chat_team_plans ADD COLUMN delegation_version INTEGER;
ALTER TABLE chat_team_plans ADD COLUMN decision_request_id TEXT;
-- The same approved request never launches two plans.
CREATE UNIQUE INDEX chat_team_plans_derived ON chat_team_plans(delegation_project_id,decision_request_id) WHERE decision_request_id IS NOT NULL;
CREATE INDEX chat_team_plans_delegation ON chat_team_plans(delegation_project_id,state) WHERE delegation_project_id IS NOT NULL;
`, String.raw`
-- Per-project status snapshots and hour estimates. Estimated, approved and sent seconds live in separate columns and never overwrite each other.
ALTER TABLE tasks ADD COLUMN assignee_account_id TEXT;
ALTER TABLE tasks ADD COLUMN due_at TIMESTAMP;
CREATE INDEX tasks_assignee_account ON tasks(assignee_account_id,project_id) WHERE assignee_account_id IS NOT NULL;
CREATE TABLE project_status_snapshots (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, version INTEGER NOT NULL, as_of TIMESTAMP NOT NULL,
 coverage JSON, pending JSON, deterministic JSON, synthesis JSON, model TEXT, source_watermark JSON,
 freshness TEXT CHECK(freshness IN ('current','stale_no_report','excluded_remote')), created_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 UNIQUE(project_id,version)
);
CREATE INDEX project_status_snapshots_asof ON project_status_snapshots(project_id,as_of DESC);
CREATE TABLE hour_estimates (
 id TEXT PRIMARY KEY, run_id TEXT, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
 issue_key TEXT, estimated_seconds INTEGER, basis TEXT, confidence TEXT CHECK(confidence IN ('low','medium','high')), assumptions JSON,
 method TEXT NOT NULL DEFAULT 'model_judgment', model TEXT, approved_seconds INTEGER, approved_item_ref TEXT, sent_seconds INTEGER, sent_receipt_ref TEXT,
 state TEXT NOT NULL CHECK(state IN ('proposed','approved','rejected','sent','uncertain')),
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}, UNIQUE(run_id,task_id)
);
CREATE INDEX hour_estimates_project ON hour_estimates(project_id,state);
`, String.raw`
-- Quota failures and resume attempts of fleet members; SQLite cannot alter a CHECK, so the table is rebuilt with its rows and indexes.
DROP INDEX process_incidents_subject;
DROP INDEX process_incidents_project;
ALTER TABLE process_incidents RENAME TO process_incidents_previous;
CREATE TABLE process_incidents (
 id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL CHECK(subject_kind IN ('schedule_run','fleet_member')), subject_id TEXT NOT NULL, generation TEXT,
 schedule_id TEXT, run_id TEXT, team_id TEXT, member_id TEXT, session_id TEXT, project_id TEXT,
 cause TEXT NOT NULL CHECK(cause IN ('hub_restart','deadline_exceeded','automations_off','collaboration_off','cancelled','spawn_failed','process_exited','quota_exhausted','quota_resume')),
 action TEXT NOT NULL CHECK(action IN ('terminated','already_exited','unverified_left_running','termination_unknown','none','resumed','resume_unsupported','resume_failed')),
 pid INTEGER, process_started TEXT, boot_id TEXT, observed_at TIMESTAMP NOT NULL, detail JSON NOT NULL DEFAULT '{}'
);
INSERT INTO process_incidents(id,subject_kind,subject_id,generation,schedule_id,run_id,team_id,member_id,session_id,project_id,cause,action,pid,process_started,boot_id,observed_at,detail)
  SELECT id,subject_kind,subject_id,generation,schedule_id,run_id,team_id,member_id,session_id,project_id,cause,action,pid,process_started,boot_id,observed_at,detail FROM process_incidents_previous;
DROP TABLE process_incidents_previous;
CREATE UNIQUE INDEX process_incidents_subject ON process_incidents(subject_kind,subject_id,COALESCE(generation,''),cause);
CREATE INDEX process_incidents_project ON process_incidents(project_id,observed_at DESC);
`, String.raw`
-- Fields a person changed from the app; an agent update that touches one is refused.
ALTER TABLE schedules ADD COLUMN human_override JSON NOT NULL DEFAULT '[]';
`, String.raw`
-- When the model of a session was last reported by a hook (session start or a model switch).
ALTER TABLE chat_sessions ADD COLUMN model_observed_at TIMESTAMP;
`, String.raw`
-- Append-only audit of leadership and read-access decisions. No foreign keys: the record outlives sessions and channels.
CREATE TABLE chat_authority_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 channel_id TEXT, project_id TEXT, actor_session_id TEXT, actor_user_id TEXT, target_session_id TEXT,
 reason TEXT NOT NULL, evidence JSON NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX chat_authority_events_project ON chat_authority_events(project_id,seq);
CREATE INDEX chat_authority_events_channel ON chat_authority_events(channel_id,seq);
CREATE INDEX chat_authority_events_kind ON chat_authority_events(kind,seq);
-- Cross-project reads: an agent asks, its leader elevates, only the authenticated person grants.
CREATE TABLE chat_read_requests (
 id TEXT PRIMARY KEY, requester_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
 requester_channel_id TEXT NOT NULL, requester_project_id TEXT, target_project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
 leader_session_id TEXT, team_id TEXT, reason TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending_leader','pending_person','granted','rejected','cancelled')),
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, elevated_at TIMESTAMP, elevated_by TEXT, elevation_note TEXT,
 decided_at TIMESTAMP, decided_by_user TEXT, decision_note TEXT, confirmation_phrase TEXT
);
CREATE UNIQUE INDEX chat_read_requests_open ON chat_read_requests(requester_session_id,target_project_id) WHERE state IN ('pending_leader','pending_person');
CREATE INDEX chat_read_requests_state ON chat_read_requests(state,created_at);
CREATE TABLE chat_read_grants (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES chat_read_requests(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
 granted_by_user TEXT NOT NULL, granted_at TIMESTAMP NOT NULL DEFAULT ${NOW}, expires_at TIMESTAMP NOT NULL,
 revoked_at TIMESTAMP, revoke_reason TEXT
);
CREATE INDEX chat_read_grants_session ON chat_read_grants(session_id,revoked_at);
`, String.raw`
-- Leadership taken over from a silent leader stays reclaimable by that exact session; leader_changed_at dates the last change.
ALTER TABLE chat_channels ADD COLUMN displaced_leader_id TEXT REFERENCES chat_sessions(id);
ALTER TABLE chat_channels ADD COLUMN displaced_at TIMESTAMP;
ALTER TABLE chat_channels ADD COLUMN leader_changed_at TIMESTAMP;
CREATE INDEX chat_channels_leader ON chat_channels(leader_id);
`, String.raw`
-- Optional stance label of agent messages and a channel description, both shown read-only in the Hub UI.
ALTER TABLE chat_messages ADD COLUMN kind TEXT;
ALTER TABLE chat_channels ADD COLUMN description TEXT;
`, String.raw`
-- Inter-hub chat state is strictly additive. A remote author enters chat_sessions only as a closed placeholder
-- (cli_kind 'interhub-remote', non-routable key_hash) that the message and thread FKs require; it gets no wakes,
-- leadership, team or agent-listing behavior. The roster of remote agents lives in interhub_remote_sessions.
CREATE TABLE interhub_remote_sessions (
  channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  hub_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  label TEXT NOT NULL,
  cli_kind TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('leader','member')),
  state TEXT NOT NULL CHECK(state IN ('online','offline','unknown')),
  peer_id TEXT NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT ${NOW},
  PRIMARY KEY(channel_id,hub_id,session_id)
);
CREATE INDEX interhub_remote_sessions_channel ON interhub_remote_sessions(channel_id,hub_id,role,updated_at);
CREATE TABLE interhub_received_envelopes (
  envelope_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  origin_hub_id TEXT NOT NULL,
  origin_peer_id TEXT NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX interhub_received_envelopes_channel ON interhub_received_envelopes(channel_id,occurred_at,envelope_id);
CREATE TABLE interhub_message_origins (
  message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  envelope_id TEXT NOT NULL UNIQUE REFERENCES interhub_received_envelopes(envelope_id) ON DELETE CASCADE,
  hub_id TEXT NOT NULL,
  hub_name TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK(author_role IN ('leader','member'))
);
CREATE INDEX interhub_message_origins_hub ON interhub_message_origins(hub_id,message_id);
CREATE TABLE interhub_escalations (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  question_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  last_hub_id TEXT,
  next_hub_id TEXT,
  escalated_at TIMESTAMP NOT NULL,
  answered_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT ${NOW},
  updated_at TIMESTAMP NOT NULL DEFAULT ${NOW},
  UNIQUE(channel_id,thread_id,question_message_id)
);
CREATE INDEX interhub_escalations_due ON interhub_escalations(answered_at,escalated_at);
`, String.raw`
-- Inter-hub channel replication. Creator codes are represented only by a hash here; plaintext is creator-local vault state.
CREATE TABLE interhub_channels (
 channel_id TEXT PRIMARY KEY REFERENCES chat_channels(id) ON DELETE CASCADE,
 creator_hub_id TEXT NOT NULL, creator_session_id TEXT NOT NULL REFERENCES chat_sessions(id),
 code_hash TEXT NOT NULL, code_generation INTEGER NOT NULL DEFAULT 1, code_revoked_at TIMESTAMP,
 created_at TIMESTAMP NOT NULL DEFAULT ${NOW}, updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE TABLE interhub_members (
 channel_id TEXT NOT NULL REFERENCES interhub_channels(channel_id) ON DELETE CASCADE,
 hub_id TEXT NOT NULL, peer_identity JSON NOT NULL, leader_session_id TEXT, leader_label TEXT NOT NULL,
 joined_at TIMESTAMP NOT NULL DEFAULT ${NOW}, last_seen_at TIMESTAMP NOT NULL DEFAULT ${NOW}, removed_at TIMESTAMP,
 PRIMARY KEY(channel_id,hub_id)
);
CREATE TABLE interhub_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL REFERENCES interhub_channels(channel_id) ON DELETE CASCADE,
 origin_hub_id TEXT NOT NULL, envelope JSON NOT NULL, received_from TEXT NOT NULL,
 received_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX interhub_events_channel ON interhub_events(channel_id,seq);
`, String.raw`
-- Inter-hub transport. Replicated events are stored before they are applied, so an event that arrives
-- before its thread waits and is retried. The outbox records which local rows were already published.
-- Rollback: DROP TABLE interhub_outbox; DROP INDEX interhub_events_pending; then drop the three added columns.
ALTER TABLE interhub_events ADD COLUMN applied_at TIMESTAMP;
ALTER TABLE interhub_events ADD COLUMN apply_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE interhub_events ADD COLUMN apply_error TEXT;
UPDATE interhub_events SET applied_at=received_at;
CREATE INDEX interhub_events_pending ON interhub_events(applied_at,seq);
CREATE TABLE interhub_outbox (
 key TEXT PRIMARY KEY,
 channel_id TEXT NOT NULL REFERENCES interhub_channels(channel_id) ON DELETE CASCADE,
 envelope_id TEXT NOT NULL, digest TEXT NOT NULL,
 updated_at TIMESTAMP NOT NULL DEFAULT ${NOW}
);
CREATE INDEX interhub_outbox_channel ON interhub_outbox(channel_id);
`, String.raw`
-- Local agent sessions that this hub's leader in an inter-hub channel associated with it: they read, write and are
-- mentioned there as members of this hub. removed_at ends the association and keeps the audit row.
-- Rollback: DROP TABLE interhub_local_agents.
CREATE TABLE interhub_local_agents (
 channel_id TEXT NOT NULL REFERENCES interhub_channels(channel_id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
 added_by TEXT NOT NULL, added_at TIMESTAMP NOT NULL DEFAULT ${NOW},
 removed_by TEXT, removed_at TIMESTAMP,
 PRIMARY KEY(channel_id,session_id)
);
CREATE INDEX interhub_local_agents_session ON interhub_local_agents(session_id,removed_at);
`, String.raw`
-- Wrap up and channel archive. activity_at: server clock of the last Hub-observed activity of a session (hook events other
-- than heartbeats, collaboration calls, fleet protocol events); legacy rows take their best recorded evidence.
-- dismissed_*: the channel leader cleaned the session from agent listings; it is listed again once activity_at passes dismissed_at.
-- archived_at/archive_cause: written only by the server sweep; archive_proposed_*: a leader's pending proposal (24 h instead of 48 h).
-- Rollback: DROP INDEX chat_channels_archived; ALTER TABLE chat_channels DROP COLUMN for unarchived_at, archive_proposal_reason,
-- archive_proposed_by, archive_proposed_at, archive_cause, archived_at; ALTER TABLE chat_sessions DROP COLUMN for dismissal_reason,
-- dismissed_by, dismissed_at, activity_at; then delete this version from schema_versions.
ALTER TABLE chat_sessions ADD COLUMN activity_at TIMESTAMP;
ALTER TABLE chat_sessions ADD COLUMN dismissed_at TIMESTAMP;
ALTER TABLE chat_sessions ADD COLUMN dismissed_by TEXT;
ALTER TABLE chat_sessions ADD COLUMN dismissal_reason TEXT;
ALTER TABLE chat_channels ADD COLUMN archived_at TIMESTAMP;
ALTER TABLE chat_channels ADD COLUMN archive_cause TEXT;
ALTER TABLE chat_channels ADD COLUMN archive_proposed_at TIMESTAMP;
ALTER TABLE chat_channels ADD COLUMN archive_proposed_by TEXT;
ALTER TABLE chat_channels ADD COLUMN archive_proposal_reason TEXT;
ALTER TABLE chat_channels ADD COLUMN unarchived_at TIMESTAMP;
UPDATE chat_sessions SET activity_at=max(created_at,
  COALESCE(CASE WHEN event_at>'1970-01-02' THEN event_at END,created_at),
  COALESCE((SELECT max(m.created_at) FROM chat_messages m WHERE m.author_id=chat_sessions.id),created_at),
  COALESCE((SELECT max(w.updated_at) FROM chat_work_state w WHERE w.session_id=chat_sessions.id),created_at));
CREATE INDEX chat_channels_archived ON chat_channels(archived_at);
`, String.raw`
-- Last assistant or tool output of a Hub-owned process; it extends a busy interval without touching lifecycle events.
-- Distinct from activity_at, which dates any Hub-observed activity for wrap up and archive decisions.
-- Rollback: ALTER TABLE chat_sessions DROP COLUMN output_at; then delete this version from schema_versions.
ALTER TABLE chat_sessions ADD COLUMN output_at TIMESTAMP;
`]
