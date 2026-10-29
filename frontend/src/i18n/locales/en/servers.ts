import type es from "../es/servers"
import type { Messages } from "../../types"

const servers = {} satisfies Messages<typeof es>

export default servers
