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
`]
