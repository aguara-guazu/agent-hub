import { MediaSettingsBlock } from "./MediaBlock"
import { RecordingSettingsBlock } from "./RecordingBlock"

export default function Settings() {
  return <><MediaSettingsBlock />{window.agentHub?.getRecordingStatus && <RecordingSettingsBlock />}</>
}
