import { expect, it } from 'vitest'
import { quotaHookProfileSafe } from './usage-quota-hook.js'
it('el hook no usa perfil/config/routing distinto al de la conversación',()=>{
 for(const argument of ['--profile other','-p other','-c auth=other','--config-file cfg','--remote ws://localhost','--oss','--config=auth=other'])expect(quotaHookProfileSafe('codex '+argument)).toBe(false)
 expect(quotaHookProfileSafe('codex --model sol -c model_reasoning_effort="high"')).toBe(true)
 expect(quotaHookProfileSafe('codex --model sol --config \'model_reasoning_effort="high"\'')).toBe(true)
})
