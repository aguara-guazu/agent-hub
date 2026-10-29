import type es from "../es/clients"
import type { Messages } from "../../types"

const clients = {} satisfies Messages<typeof es>

export default clients
