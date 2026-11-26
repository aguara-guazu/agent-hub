export const assistantMigration = `
CREATE TABLE assistant_profiles (
  project_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  config JSON NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  last_scan TIMESTAMP, last_error TEXT
);
CREATE TABLE assistant_cases (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, score INTEGER NOT NULL,
  reason TEXT NOT NULL, state TEXT NOT NULL, source JSON NOT NULL, evidence JSON NOT NULL DEFAULT '[]',
  fingerprint TEXT NOT NULL, draft TEXT, revision INTEGER NOT NULL DEFAULT 1,
  notify_after TIMESTAMP NOT NULL, notified_revision INTEGER NOT NULL DEFAULT 0,
  send_id TEXT, sender_pid INTEGER, receipt TEXT, updated_at TIMESTAMP NOT NULL, UNIQUE(project_id,source_key)
);
CREATE INDEX assistant_cases_attention ON assistant_cases(project_id,state,score DESC);
CREATE TABLE assistant_source_cursors (
  project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL, scanned_at TIMESTAMP NOT NULL, PRIMARY KEY(project_id,source_key)
);
CREATE TABLE assistant_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  case_id TEXT REFERENCES assistant_cases(id) ON DELETE CASCADE, role TEXT NOT NULL, body TEXT NOT NULL,
  evidence JSON NOT NULL DEFAULT '[]', created_at TIMESTAMP NOT NULL
);
CREATE INDEX assistant_conversation ON assistant_messages(project_id,case_id,seq);
CREATE TABLE assistant_work (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  case_id TEXT REFERENCES assistant_cases(id) ON DELETE SET NULL, request_key TEXT NOT NULL,
  role TEXT NOT NULL, objective TEXT NOT NULL, state TEXT NOT NULL, scope JSON NOT NULL,
  checkpoint JSON NOT NULL DEFAULT '{}', result JSON, attempts INTEGER NOT NULL DEFAULT 0,
  lease_pid INTEGER, notified_attempt INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP, updated_at TIMESTAMP NOT NULL, UNIQUE(project_id,request_key)
);
CREATE INDEX assistant_work_queue ON assistant_work(state,updated_at);
CREATE TABLE assistant_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, at TIMESTAMP NOT NULL,
  local_day TEXT NOT NULL, measured BOOLEAN NOT NULL DEFAULT 0
);
`

export const portfolioMigration = `
ALTER TABLE assistant_profiles ADD COLUMN source_overrides JSON NOT NULL DEFAULT '{}';
UPDATE assistant_profiles SET source_overrides=json_object('slack',json_extract(config,'$.slack'),
  'github_repos',json_extract(config,'$.github_repos'),'jira_owner',json_extract(config,'$.jira_owner'));
CREATE TABLE assistant_portfolio_policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1),value JSON NOT NULL);
CREATE TABLE assistant_overview_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, body TEXT NOT NULL, evidence JSON NOT NULL DEFAULT '[]',
  projects JSON NOT NULL DEFAULT '[]', remote BOOLEAN NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL
);
`

// Advance the same optimistic version used by scans, Slack approvals and queued work.
const trackingChanged = `
  UPDATE assistant_profiles SET version=version+1,last_scan=NULL,last_error=NULL WHERE project_id=NEW.project_id;
  UPDATE assistant_cases SET state=CASE WHEN state='open' THEN 'closed' ELSE state END,
    draft=NULL,source=CASE WHEN state='open' AND kind='slack' THEN json_set(source,'$.archive_recheck',1) ELSE source END,
    fingerprint=CASE WHEN state='open' THEN '' ELSE fingerprint END,
    notified_revision=revision+1,revision=revision+1 WHERE project_id=NEW.project_id AND NEW.archived_at IS NOT NULL;
  DELETE FROM assistant_source_cursors WHERE project_id=NEW.project_id;
  UPDATE assistant_work SET state=CASE WHEN NEW.archived_at IS NOT NULL AND case_id IS NOT NULL THEN 'cancelled'
    WHEN NEW.archived_at IS NOT NULL THEN 'paused' ELSE 'queued' END,
    lease_pid=NULL,scope=json_set(scope,'$.version',(SELECT version FROM assistant_profiles WHERE project_id=NEW.project_id))
    WHERE project_id=NEW.project_id AND state IN ('queued','running','paused');
  UPDATE assistant_work SET notified_attempt=attempts WHERE project_id=NEW.project_id AND NEW.archived_at IS NOT NULL;
`
export const assistantArchiveMigration = `
CREATE TRIGGER assistant_archive_created AFTER INSERT ON project_archive_state BEGIN ${trackingChanged} END;
CREATE TRIGGER assistant_archive_changed AFTER UPDATE OF version ON project_archive_state BEGIN ${trackingChanged} END;
`

export const notificationMigration = `
CREATE TABLE assistant_notice_days(
  item_id TEXT NOT NULL, local_day TEXT NOT NULL, presentations INTEGER NOT NULL, last_at TIMESTAMP NOT NULL,
  capped_at TIMESTAMP, PRIMARY KEY(item_id,local_day)
);
CREATE TABLE assistant_notice_batches(
  id TEXT PRIMARY KEY, notice_id TEXT NOT NULL, revision INTEGER NOT NULL, members JSON NOT NULL,
  created_at TIMESTAMP NOT NULL, consumer TEXT, lease_until TIMESTAMP, presented_at TIMESTAMP
);
CREATE INDEX assistant_calendar_event_end ON entities(julianday(coalesce(json_extract(data,'$.scheduled_end.dateTime'),data->>'ended_at',data->>'occurred_at'))) WHERE kind='event';
CREATE INDEX assistant_notice_last ON assistant_notice_batches(presented_at);
CREATE INDEX assistant_notice_lease ON assistant_notice_batches(lease_until) WHERE presented_at IS NULL;
CREATE INDEX assistant_notice_legacy ON assistant_notice_batches(notice_id,revision,created_at);
CREATE INDEX assistant_notice_brief ON assistant_notice_days(capped_at) WHERE capped_at IS NOT NULL;
INSERT INTO assistant_notice_days(item_id,local_day,presentations,last_at)
SELECT id,date(updated_at,'localtime'),1,updated_at FROM assistant_cases WHERE state='open' AND notified_revision>0;
`

export const overviewCaseMigration = `
ALTER TABLE assistant_overview_messages ADD COLUMN case_id TEXT;
`

export const assistantSessionMigration = `
ALTER TABLE assistant_usage ADD COLUMN owner_turn BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE assistant_overview_messages ADD COLUMN work_id TEXT;
ALTER TABLE assistant_overview_messages ADD COLUMN jira_key TEXT;
CREATE INDEX assistant_overview_focus ON assistant_overview_messages(case_id,work_id,seq);
CREATE TABLE assistant_terminal_sessions(
  project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, conversation TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, cwd TEXT NOT NULL, native_id TEXT NOT NULL,
  PRIMARY KEY(project_id,conversation)
);
`

export const retireAssistantTurnLimit = `
UPDATE assistant_profiles SET config=json_remove(config,'$.daily_turns')
WHERE json_type(config,'$.daily_turns') IS NOT NULL;
UPDATE assistant_portfolio_policy SET value=json_remove(value,'$.config.daily_turns')
WHERE json_type(value,'$.config.daily_turns') IS NOT NULL;
UPDATE assistant_work SET state='queued',result=NULL,lease_pid=NULL
WHERE state='blocked' AND result->>'summary' IN (
  'Se alcanzó el presupuesto diario del asistente',
  'Se alcanzó el presupuesto diario de turnos del proyecto',
  'Se alcanzó el presupuesto diario de turnos automáticos del asistente'
) AND project_id IN (SELECT project_id FROM assistant_profiles WHERE config->>'active'=1)
AND project_id NOT IN (SELECT project_id FROM archived_projects);
`
