/**
 * `@agenthub/daemon`: estado local, sincronización con el control plane, adaptadores
 * de los cuatro CLIs con escritura atómica, materialización de skills, broker de
 * secretos y selección/plan de runtime.
 *
 * Invariantes que sostiene el paquete:
 * - Cada adaptador escribe UNA SOLA entrada `hub`, preserva contenido ajeno y usa
 *   reemplazo atómico.
 * - Los secretos solo son referencias `keychain://`, `env://` o `file://`; nunca
 *   entran en el snapshot, logs ni disco de estado.
 * - El modo degradado conserva el último snapshot válido, nunca fail-open.
 *
 * `TRANSPORT_STDIO`/`TRANSPORT_HTTP` los definen varios submódulos con el mismo
 * valor; para no exportar un nombre ambiguo desde la raíz se re-exportan una sola
 * vez desde aquí. Quien necesite la constante de un submódulo concreto lo importa
 * directamente.
 */

export { TRANSPORT_STDIO, TRANSPORT_HTTP } from './config.js'

export * from './naming.js'
export * from './state.js'
export * from './sync.js'
export * from './app.js'

export {
  APP_NAME,
  DAEMON_EXECUTABLE_NAME,
  DEFAULT_CONTROL_PLANE_URL,
  DEFAULT_GATEWAY_BASE_PORT,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PATH,
  DEFAULT_GATEWAY_TRANSPORT,
  DEFAULT_HUB_HOST,
  DEFAULT_HUB_PORT,
  DEFAULT_POLL_SECONDS,
  DEFAULT_ROSTER_SECONDS,
  DEFAULT_REQUEST_TIMEOUT,
  ENV_PREFIX,
  GATEWAY_TRANSPORTS,
  apiBase,
  configApiBase,
  daemonCommand,
  defaultStateDir,
  gatewayArgs,
  gatewayUrl,
  hubUrl,
  loadConfig,
  APPIMAGE_BOOTSTRAP,
  packagedAppRoot,
  resolveGatewayLaunch,
  stdioGateway,
  type DaemonConfig,
  type GatewayLaunch,
  type GatewayLaunchContext,
  type LoadConfigOptions,
} from './config.js'

export * from './adapters/index.js'
export * from './secrets/index.js'

export {
  DEFAULT_PROBE_TIMEOUT,
  ENGINE_COLIMA,
  ENGINE_DOCKER,
  ENGINE_PODMAN,
  ENGINE_PROBES,
  ISOLATION_ENV_VAR,
  RUNTIME_HOST_PROCESS,
  RUNTIME_REMOTE_HTTP,
  RUNTIME_TOOLHIVE,
  TOOLHIVE_BINARY,
  TOOLHIVE_PROBE,
  activeEngine,
  availabilityReason,
  availabilitySummary,
  defaultWhich,
  describeTool,
  detectPlan,
  detectRuntimes,
  isolationAvailable,
  planIsolationAvailable,
  planRuntimes,
  planSummary,
  runProbe,
  runtimeFor,
  type Prober,
  type ProbeResult,
  type RuntimeAvailability,
  type RuntimePlan,
  type ToolStatus,
  type Which,
} from './runtime/detect.js'
export * from './runtime/spec.js'
export * from './runtime/toolhive_plan.js'
