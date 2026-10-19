import {expect,it} from 'vitest'
import {clientToolSchema} from './tool-schema.js'
it('adapta uniones de objetos para Kiro sin cambiar el esquema validado ni otros clientes',()=>{
  const schema={type:'object',oneOf:[{type:'object',properties:{action:{const:'assign'},id:{type:'string'},project:{type:'string'}},required:['action','id','project'],additionalProperties:false},
    {type:'object',properties:{action:{const:'none'},id:{type:'string'}},required:['action','id'],additionalProperties:false}]}
  const adapted=clientToolSchema(schema,'kiro')
  expect(adapted).not.toHaveProperty('oneOf');expect(adapted.required).toEqual(['action','id'])
  expect(adapted.properties).toEqual({action:{anyOf:[{const:'assign'},{const:'none'}]},id:{type:'string'},project:{type:'string'}})
  expect(schema.oneOf).toHaveLength(2);expect(clientToolSchema(schema,'claude_code')).toBe(schema)
})
