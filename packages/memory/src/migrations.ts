export const migrations = [String.raw`
CREATE TABLE entities (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('company','project','person','meeting','event','document','message','issue','note','collection','fact')),
  title text NOT NULL, data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entities_kind ON entities(kind, updated_at DESC);
CREATE INDEX entities_data ON entities USING gin(data);
CREATE TABLE sources (
  id uuid PRIMARY KEY, entity_id uuid NOT NULL UNIQUE REFERENCES entities ON DELETE CASCADE,
  provider text NOT NULL, account text NOT NULL, external_id text NOT NULL,
  connector_id uuid, url text, current_version_id uuid,
  status text NOT NULL DEFAULT 'active', synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,account,external_id)
);
CREATE TABLE versions (
  id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES sources ON DELETE CASCADE,
  content_hash text NOT NULL, original_path text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id,content_hash)
);
ALTER TABLE sources ADD CONSTRAINT source_current_version FOREIGN KEY(current_version_id) REFERENCES versions ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE identities (
  provider text NOT NULL, account text NOT NULL, external_id text NOT NULL,
  person_id uuid NOT NULL REFERENCES entities ON DELETE CASCADE,
  display_name text NOT NULL, email text, verified boolean NOT NULL DEFAULT false,
  PRIMARY KEY(provider,account,external_id)
);
CREATE TABLE fragments (
  id uuid PRIMARY KEY, version_id uuid NOT NULL REFERENCES versions ON DELETE CASCADE,
  ordinal integer NOT NULL, text text NOT NULL, speaker_id uuid REFERENCES entities ON DELETE SET NULL,
  start_time timestamptz, end_time timestamptz, offset_ms bigint,
  metadata jsonb NOT NULL DEFAULT '{}',
  search_text tsvector GENERATED ALWAYS AS(to_tsvector('simple',text)) STORED,
  UNIQUE(version_id,ordinal)
);
CREATE INDEX fragments_version ON fragments(version_id, ordinal);
CREATE INDEX fragments_speaker ON fragments(speaker_id,start_time);
CREATE INDEX fragments_fts ON fragments USING gin(search_text);
CREATE TABLE fragment_projects (
  fragment_id uuid REFERENCES fragments ON DELETE CASCADE,
  project_id uuid REFERENCES entities ON DELETE CASCADE,
  PRIMARY KEY(fragment_id,project_id)
);
CREATE INDEX fragment_projects_project ON fragment_projects(project_id,fragment_id);
CREATE TABLE links (
  id uuid PRIMARY KEY, from_id uuid NOT NULL REFERENCES entities ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES entities ON DELETE CASCADE, type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(from_id,to_id,type), CHECK(from_id <> to_id)
);
CREATE INDEX links_to ON links(to_id,type);
CREATE TABLE evidence (
  entity_id uuid REFERENCES entities ON DELETE CASCADE,
  fragment_id uuid REFERENCES fragments ON DELETE CASCADE,
  PRIMARY KEY(entity_id,fragment_id)
);
CREATE TABLE link_evidence (
  link_id uuid REFERENCES links ON DELETE CASCADE, fragment_id uuid REFERENCES fragments ON DELETE CASCADE,
  PRIMARY KEY(link_id,fragment_id)
);
CREATE TABLE embeddings (
  fragment_id uuid REFERENCES fragments ON DELETE CASCADE,
  model text NOT NULL, dimension integer NOT NULL, embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(fragment_id,model),
  CHECK(vector_dims(embedding)=dimension)
);
CREATE TABLE collection_records (
  id uuid PRIMARY KEY, collection_id uuid NOT NULL REFERENCES entities ON DELETE CASCADE,
  values jsonb NOT NULL, schema_version integer NOT NULL,
  idempotency_key text, origin text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(collection_id,idempotency_key)
);
CREATE INDEX collection_records_values ON collection_records USING gin(values);
CREATE TABLE record_evidence (
  record_id uuid REFERENCES collection_records ON DELETE CASCADE,
  fragment_id uuid REFERENCES fragments ON DELETE CASCADE,
  PRIMARY KEY(record_id,fragment_id)
);
CREATE TABLE rules (
  id uuid PRIMARY KEY, collection_id uuid NOT NULL REFERENCES entities ON DELETE CASCADE,
  name text NOT NULL, instructions text NOT NULL, project_ids uuid[] NOT NULL DEFAULT '{}',
  person_id uuid REFERENCES entities ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rule_runs (
  rule_id uuid REFERENCES rules ON DELETE CASCADE, revision integer NOT NULL,
  version_id uuid REFERENCES versions ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(rule_id,revision,version_id)
);
CREATE TABLE connectors (
  id uuid PRIMARY KEY, provider text NOT NULL, name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}', project_ids uuid[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT false, interval_minutes integer NOT NULL DEFAULT 30,
  cursor jsonb NOT NULL DEFAULT '{}', last_success_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sources ADD CONSTRAINT source_connector FOREIGN KEY(connector_id) REFERENCES connectors ON DELETE SET NULL;
CREATE TABLE jobs (
  id uuid PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text NOT NULL, state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_owner text,
  progress jsonb NOT NULL DEFAULT '{}', error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_active_dedupe ON jobs(dedupe_key) WHERE state IN ('queued','running','waiting');
CREATE INDEX jobs_ready ON jobs(state,available_at);
CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE changes (
  id bigserial PRIMARY KEY, entity_id uuid, action text NOT NULL, actor text NOT NULL,
  before_value jsonb, after_value jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
`, String.raw`
-- Entity metadata is searchable even when it has no imported source (projects, facts, people…).
CREATE FUNCTION memory_entity_text(title text, data jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT title || E'\n' || COALESCE(data->>'description','') || E'\n' || COALESCE(data->>'text','') || E'\n'
    || COALESCE(data->>'email','') || E'\n' || COALESCE(data->>'category','') || E'\n' || COALESCE(data->>'status','')
$$;
CREATE INDEX entities_search ON entities USING gin(to_tsvector('simple',memory_entity_text(title,data)));
CREATE TABLE entity_embeddings (
  entity_id uuid REFERENCES entities ON DELETE CASCADE,
  model text NOT NULL, dimension integer NOT NULL, embedding vector NOT NULL, content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(entity_id,model),
  CHECK(vector_dims(embedding)=dimension)
);
`, String.raw`
-- Project work tracking. Jira rows mirror the issue (external_* holds Jira's own values); pending rows are internal debt and follow-ups.
CREATE TABLE tasks (
  id uuid PRIMARY KEY, project_id uuid REFERENCES entities ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('jira','pending')),
  title text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK(status IN ('todo','in_progress','blocked','done','dropped')),
  origin text NOT NULL DEFAULT 'manual',
  external_key text, external_status text, external_category text, external_url text, external_updated_at timestamptz,
  issue_type text, priority text, assignee text, code_ref text,
  source_entity_id uuid REFERENCES entities ON DELETE SET NULL,
  created_by text NOT NULL, updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  CHECK(kind <> 'jira' OR external_key IS NOT NULL)
);
CREATE UNIQUE INDEX tasks_jira_key ON tasks(external_key) WHERE kind='jira';
CREATE INDEX tasks_project ON tasks(project_id,status,updated_at DESC);
CREATE TABLE task_evidence (
  task_id uuid REFERENCES tasks ON DELETE CASCADE, fragment_id uuid REFERENCES fragments ON DELETE CASCADE,
  PRIMARY KEY(task_id,fragment_id)
);
CREATE TABLE task_events (
  id bigserial PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks ON DELETE CASCADE,
  action text NOT NULL, actor text NOT NULL, status_before text, status_after text,
  detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task ON task_events(task_id,created_at);
CREATE INDEX task_events_created ON task_events(created_at);
-- One row per gateway process (a CLI session). last_seen_at advances with every memory call made through it.
CREATE TABLE agent_sessions (
  id text PRIMARY KEY, agent_id text NOT NULL, agent_label text NOT NULL, cli_kind text NOT NULL DEFAULT '',
  cwd text, project_id uuid REFERENCES entities ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz
);
CREATE TABLE agent_notes (
  id uuid PRIMARY KEY, session_id text REFERENCES agent_sessions ON DELETE SET NULL,
  agent_id text NOT NULL, agent_label text NOT NULL, cli_kind text NOT NULL DEFAULT '',
  project_id uuid REFERENCES entities ON DELETE CASCADE, task_id uuid REFERENCES tasks ON DELETE SET NULL,
  text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 600),
  state text NOT NULL CHECK(state IN ('working','done','blocked')), finish_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX agent_notes_project ON agent_notes(project_id,updated_at DESC);
CREATE INDEX agent_notes_working ON agent_notes(session_id) WHERE state='working';
`, String.raw`
ALTER TABLE tasks ADD COLUMN external_site text NOT NULL DEFAULT '';
UPDATE tasks t SET external_site=COALESCE(NULLIF(p.data->>'jira_site_url',''),
  CASE WHEN t.external_url LIKE 'https://%.atlassian.net/%' THEN split_part(t.external_url,'/',1)||'//'||split_part(t.external_url,'/',3) END,'')
  FROM entities p WHERE t.project_id=p.id AND t.kind='jira';
DROP INDEX tasks_jira_key;
CREATE UNIQUE INDEX tasks_jira_key ON tasks(external_site,external_key) WHERE kind='jira';
`]
