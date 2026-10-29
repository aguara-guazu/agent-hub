import type es from "../es/memory"
import type { Messages } from "../../types"

const memory = {} satisfies Messages<typeof es>

export default memory
