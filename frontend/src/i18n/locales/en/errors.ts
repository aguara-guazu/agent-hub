import type es from "../es/errors"
import type { Messages } from "../../types"

const errors = {
  network: "Couldn’t connect to Agent Hub. Check that the app is still open.",
  timeout: "Agent Hub took too long to respond. Try again.",
  unauthorized: "Your session expired. Close and reopen Agent Hub.",
  forbidden: "You don’t have permission to do this. Ask the project admin for access.",
  notFound: "It no longer exists. It may have been deleted from another client.",
  conflict: "It changed while you were editing. Reload and apply your change again.",
  tooLarge: "The file is over the size limit. Try a smaller one.",
  server: "Something failed in Agent Hub. Try again; if it keeps failing, check Activity.",
  invalid: "Some value isn’t valid. Check the fields and try again.",
  rateLimited: "Too many attempts in a row. Wait a moment and try again.",
  unknown: "Something went wrong. Try again.",
  memoryUnavailable: "Memory isn’t responding. Agent Hub keeps trying to open it; if it persists, check Activity.",
  desktopOnly: "This action is only available in the desktop app.",
  actionFailed: "Couldn’t complete the action. Try again.",
  loadFailed: "Couldn’t load. Try again.",
  saveFailed: "Change not saved. Try again.",
  jira: {
    issue_unassigned: "The issue has no assignee, and Agent Hub only writes to issues assigned to you. Assign it to yourself in Jira and try again.",
    assignee_mismatch: "The issue is assigned to someone else, so nothing was written to Jira. Ask them to assign it to you if you need to update it.",
    account_mismatch: "The Jira connector token belongs to another account. Add your own token in Settings › Integrations.",
    assignee_unverified: "Couldn't read the issue's assignee in Jira, so nothing was written. Check that the issue exists and that you have access.",
    identity_unverified: "Couldn't confirm your Jira account, so nothing was written. Check the connector in Settings › Integrations.",
  },
  field: {
    required: "Fill in this field.",
    invalidUrl: "Enter a URL that starts with http:// or https://.",
    invalidEmail: "Enter a valid email.",
    tooLong: "Use {{max}} characters at most.",
    duplicate: "One with that name already exists. Choose another.",
  },
} satisfies Messages<typeof es>

export default errors
