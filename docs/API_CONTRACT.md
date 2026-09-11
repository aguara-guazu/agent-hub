# Contrato de la API — Agent Hub

Fuente de verdad para backend, daemon y frontend. Todo endpoint cuelga de `/api`.
`frontend/src/lib/types.ts` refleja estas formas: si cambiás una, cambiá la otra.

## De quién es cada cosa

La organización sirve para el **ingreso, las personas y la auditoría**. Sobre los MCP
servers y las skills **no manda**: son de cada persona y corren en su máquina, así que
no hay rol que pueda crearlos, aprobarlos, imponerlos ni apagarlos por ella. Todo
`/catalog` es de alcance personal, y en `/policy` un admin puede **leer** la matriz de
otra persona —hace falta para dar soporte— pero no escribirla.

## Autenticación

Dos principales distintos, nunca intercambiables:

- **Consola web**: JWT en `Authorization: Bearer <jwt>`. Dependencia `deps.current_user`.
- **Daemon local**: token opaco `ahd_...` en `Authorization: Bearer <token>`. Dependencia
  `deps.current_daemon`. Nunca acepta JWT, y el JWT nunca sirve para `/sync`.

## Endpoints

### auth (prefix `/auth`)
| Método | Ruta | Auth | Cuerpo | Respuesta |
|---|---|---|---|---|
| POST | `/auth/login` | — | `{email, password}` | `{access_token, token_type:"bearer", user: User}` |
| GET | `/auth/me` | user | — | `User` |

### identity (prefix `/identity`)
| POST | `/identity/users` | admin | `{email, full_name, password, org_role}` | `User` |
| GET | `/identity/users` | user | — | `User[]` |
| PATCH | `/identity/users/{id}` | admin | `{full_name?, org_role?, is_active?}` | `User` |
| GET | `/identity/squads` | user | — | `Squad[]` |
| POST | `/identity/squads` | admin | `{slug, name, client_account_id?}` | `Squad` |
| POST | `/identity/squads/{id}/members` | admin | `{user_id, role, valid_from?, valid_to?}` | `204` |
| DELETE | `/identity/squads/{id}/members/{user_id}` | admin | — | `204` |
| GET | `/identity/client-accounts` | user | — | `ClientAccount[]` |
| POST | `/identity/client-accounts` | admin | `{slug, name}` | `ClientAccount` |

`User` incluye `squads: [{id, slug, name, role}]` de las membresías vigentes y
`organization`, el nombre de la organización de esa persona (en el hub local, `Local`).

### catalog (prefix `/catalog`)
| Método | Ruta | Auth | Cuerpo | Respuesta |
|---|---|---|---|---|
| GET | `/catalog/servers` | user | — | `McpServer[]` **de quien pregunta**, con sus `tools` |
| POST | `/catalog/servers` | user | campos de McpServer | `McpServer` |
| PATCH | `/catalog/servers/{id}` | user | parcial | `McpServer` |
| DELETE | `/catalog/servers/{id}` | user | — | `204` |
| POST | `/catalog/servers/{id}/probe` | user | — | `McpServer` (descubre tools reales conectándose) |
| POST | `/catalog/servers/{id}/approve` | user | — | `McpServer` (acepta las definiciones de hoy) |
| POST | `/catalog/servers/{id}/oauth/start` | user | — | `{status: 'redirect', authorization_url}` o `{status: 'authorized', server}` |
| GET | `/oauth/callback?code&state` | ninguna (vuelta del navegador) | — | HTML; canjea el código, sondea y guarda la cuenta |
| POST | `/catalog/servers/{id}/oauth/logout` | user | — | `McpServer` (borra la cuenta autorizada) |
| POST | `/catalog/servers/{id}/oauth/client` | user | `{client_id, client_secret?}` | `McpServer` (cliente OAuth propio; descarta la cuenta anterior) |
| GET | `/oauth/settings` | user | — | `{redirect_url}` (la URL de retorno a registrar en el proveedor) |
| GET/POST/PATCH/DELETE | `/catalog/skills[...]` | user | | `Skill` |

El recurso de otra persona devuelve **404, no 403**: con un 403 la respuesta
confirmaría que ese id existe. La unicidad del slug es `(user_id, slug)`, así que dos
personas pueden tener cada una su `escalidrau`.

No hay instalar ni desinstalar: crear el server **ya es tenerlo**, y queda expuesto en
todos los clientes de la persona salvo que lo apague en la matriz.

`probe` levanta el MCP server real (stdio o http), hace `initialize` + `tools/list`,
guarda las `McpTool` con su `exposed_name` calculado por `naming.build_exposed_name`,
y pone en cuarentena las tools cuyo `definition_hash` cambió. Si el sondeo falla queda
`last_probe_error`, y el core lo **reintenta solo cada 30 segundos**
(`AGENTHUB_PROBE_RETRY_SECONDS`, `0` lo desactiva) mientras el server esté habilitado
para su dueño y tenga comando o URL; un server apagado en la matriz no se reintenta.

### OAuth en servers http

`McpServer.auth` es `none` (nada o encabezados estáticos) u `oauth`. Con `oauth`, el hub
actúa como cliente OAuth 2.1 según la [autorización de MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):
descubre el servidor de autorización (RFC 9728/8414), registra el cliente si el proveedor
lo admite (RFC 7591), usa PKCE y refresca tokens. `oauth/start` devuelve la URL para
abrir en el navegador; el proveedor vuelve a `/api/oauth/callback` en el loopback del
core (`AGENTHUB_OAUTH_REDIRECT_URL`), que canjea el código, sondea y descubre tools.

`McpServer.oauth_status` es `none`, `required` o `authorized`. El token **nunca** sale
por la API ni entra en la base: vive en `<estado>/oauth/<server_id>.json` con permisos
0600 (`AGENTHUB_OAUTH_DIR`), y lo leen tanto el core (sondeo) como el gateway (llamadas),
que lo refresca solo. Sin cuenta autorizada el sondeo no toca la red, el reintento
automático saltea el server y el gateway responde «requiere autorizar la cuenta».
Si el proveedor no admite registro dinámico, `oauth/start` responde `502` con el motivo;
en ese caso la persona crea una app OAuth en el proveedor con `redirect_url` como URL de
retorno y carga su `client_id` (y `client_secret` si lo hay) con `oauth/client`. El
secreto va al mismo archivo 0600 y `McpServer.oauth_client_configured` sólo dice que
existe. `approve` no es una
aprobación de catálogo —no hay quien apruebe por encima del dueño—: es aceptar la
definición nueva y levantar esa cuarentena.

### policy (prefix `/policy`)
| GET | `/policy/matrix?user_id=` | user | — | `MatrixResponse` |
| PUT | `/policy/rules` | user | `{scope, scope_id, resource_type, resource_id, state, reason?}` | `204` |
| GET | `/policy/explain?agent_id=&resource_type=&resource_id=` | user | — | `Explanation` |
| GET | `/policy/snapshot/{agent_id}` | user | — | snapshot completo (para depurar desde la consola) |

`scope` ∈ `user | client`. Con `scope=client`, `scope_id` es un `agent_instance.id` de una
máquina propia; con `scope=user` se omite (el backend usa a quien escribe, que es la única
persona cuya política puede tocar). Escribir sobre otra persona es `403`; sobre un recurso
ajeno o inexistente, `404`.

El cuerpo rechaza campos desconocidos: un cliente viejo que todavía mande `locked` recibe
un `422` en vez de creer que congeló algo que hoy no congela nada.

**Precedencia:** `default ON → regla de la persona → regla del cliente`. El default es ON y
no deny: el server es tuyo y corre en tu máquina, así que agregarlo alcanza. Apagar es el
acto explícito. Las tools heredan la decisión de su server.

### machines (prefix `/machines`)
| POST | `/machines/enroll` | user | `{hostname, os, daemon_version}` | `{machine: Machine, token: "ahd_..."}` (token en claro una sola vez) |
| GET | `/machines` | user | — | `Machine[]` (admin ve las de toda la org) |
| DELETE | `/machines/{id}` | user | — | `204` (revoca tokens y borra la máquina) |
| POST | `/machines/{id}/agents` | daemon | `{agents:[{cli_kind, cli_version, config_path}]}` | `AgentInstance[]` |
| PATCH | `/machines/agents/{id}` | user | `{enabled?}` | `AgentInstance` |

### sync (prefix `/sync`)
| GET | `/sync/bootstrap` | daemon | — | `{machine_id, user_email, agents: AgentInstance[]}` |
| GET | `/sync/snapshot/{agent_id}?known_hash=` | daemon | — | snapshot de `resolver.compute_snapshot`, o `304` si el hash coincide |
| POST | `/sync/report` | daemon | `{agent_id, listed_hash?, connected?, drift_detected?, drift_detail?}` | `204` |
| POST | `/sync/tool-call` | daemon | `{agent_id, server_slug, tool_name, exposed_name, decision, denial_reason, args_digest, duration_ms, error}` | `204` |

### audit (prefix `/audit`)
| GET | `/audit/events?limit=&action=` | user | — | `AuditEvent[]` |
| GET | `/audit/tool-calls?limit=&agent_id=` | user | — | `ToolCallLog[]` |
| GET | `/audit/verify` | admin | — | `{ok: bool, broken_at: string|null}` (verifica la cadena de hashes) |

## Snapshot

Lo produce `agenthub.modules.policy.resolver.compute_snapshot`. Forma exacta:

```json
{
  "agent_instance_id": "...", "cli_kind": "claude_code",
  "user_id": "...", "user_email": "...", "machine_id": "...",
  "servers": [{"id","slug","display_name","transport","command","args","env","cwd",
               "url","headers","secret_refs",
               "tools":[{"id","name","exposed_name","title","description","input_schema","definition_hash"}]}],
  "skills": [{"id","slug","display_name","description","body","version","content_hash"}],
  "denied": [{"resource_type","resource_id","slug","exposed","source","detail"}],
  "snapshot_hash": "sha256...", "generated_at": "iso8601"
}
```

`snapshot_hash` es determinista sobre todo el cuerpo menos el propio hash y `generated_at`.

## Propagación

`MatrixCell.propagation` es honesto sobre lo que realmente pasó:

- `applied_live`: el gateway aplica y el CLI ya refrescó su lista. Sólo Claude Code.
- `applied_stale_list`: el gateway ya deniega, pero el CLI sigue mostrando la herramienta.
- `pending_restart`: hace falta reiniciar el CLI para que el cambio se vea.
- `pending_sync`: el daemon todavía no bajó el snapshot nuevo.
- `unknown`: nunca se conectó.

Regla de cálculo: si `agent.last_listed_hash == snapshot_hash` → `applied_live`.
Si difiere y el CLI es Claude Code → `pending_sync`. Si difiere y el CLI no recarga
en caliente → `applied_stale_list` cuando el daemon ya tiene el snapshot, y
`pending_restart` cuando además hay que reiniciar. Si nunca se conectó → `unknown`.
