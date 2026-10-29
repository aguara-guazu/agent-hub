import type es from "../es/access"
import type { Messages } from "../../types"

const access = {
  list: "Read requests",
  row: {
    title: "{{agent}} asks to see «{{target}}»",
    elevated: "Forwarded by {{leader}}",
  },
  pending: "Awaiting your confirmation",
  field: {
    label: "Confirmation phrase",
    hint: "Type it yourself. Access is read-only and ends after 8 h or when the agent finishes its task.",
  },
  example: {
    withProject: "I confirm that agent {{agent}} from project {{source}} can see the channels of project {{target}}",
    withoutProject: "I confirm that agent {{agent}} can see the channels of project {{target}}",
  },
  actions: {
    grant: "Grant access",
    reject: "Decline request",
  },
  toast: {
    granted: "Access granted to {{agent}}",
    rejected: "Request declined",
  },
  empty: "No read requests",
  errors: {
    phrase_structure: "Type the phrase following the example.",
    phrase_target: "The phrase must name the project «{{target}}» exactly as shown.",
    phrase_requester: "The phrase must name the agent {{agent}} or its project.",
    request_not_pending: "This request was already resolved. Refresh the list.",
    requester_inactive: "The agent is no longer connected; the request can't be granted.",
  },
} satisfies Messages<typeof es>

export default access
