import type { LocalChat } from '../../src/local-chat.js'

/** Seed an existing shared channel for protocol/upgrade tests, independently of enrollment. */
export async function existingChannel(chat:LocalChat, registration:any, scope:string) {
  const prior=(await chat.db.query('SELECT * FROM chat_channels WHERE scope_key=$1',[`fixture:${scope}`]))[0]
  if(prior) {
    await chat.db.query('UPDATE chat_sessions SET channel_id=$2 WHERE id=$1',[registration.session.id,prior.id])
    await chat.db.query('UPDATE chat_turns SET channel_id=$2 WHERE session_id=$1',[registration.session.id,prior.id])
    await chat.db.query('DELETE FROM chat_channels WHERE id=$1',[registration.channel.id])
    registration.channel=prior
  } else {
    registration.channel=(await chat.db.query("UPDATE chat_channels SET scope_key=$2,kind='git',activated_at=now() WHERE id=$1 RETURNING *",[registration.channel.id,`fixture:${scope}`]))[0]
  }
  registration.session.channel_id=registration.channel.id
  return registration
}
