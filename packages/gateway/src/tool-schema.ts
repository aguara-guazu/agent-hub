/** Kiro's model API rejects root object unions. Widen only the advertised shape;
 * the original MCP server still validates the full discriminated union on execution. */
export function clientToolSchema(schema:Record<string,unknown>,kind:string):Record<string,unknown> {
  if(kind!=='kiro')return schema
  const union=Array.isArray(schema.oneOf)?'oneOf':Array.isArray(schema.anyOf)?'anyOf':undefined
  if(!union)return schema
  const variants=schema[union] as Record<string,any>[]
  if(!variants.length || !variants.every(v=>v && v.type==='object' && v.properties && typeof v.properties==='object'))return schema
  const properties:Record<string,unknown>={...(schema.properties as Record<string,unknown> ?? {})}
  const fields=new Set(variants.flatMap(v=>Object.keys(v.properties)))
  for(const key of fields) {
    const choices=variants.filter(v=>key in v.properties).map(v=>v.properties[key])
    const unique=[...new Map(choices.map(value=>[JSON.stringify(value),value])).values()]
    properties[key]=unique.length===1?unique[0]:{anyOf:unique}
  }
  const required=[...new Set([...(Array.isArray(schema.required)?schema.required:[]),
    ...(variants[0]!.required ?? []).filter((key:string)=>variants.every(v=>v.required?.includes(key)))])]
  const result:Record<string,unknown>={...schema,type:'object',properties,required}
  delete result[union]
  return result
}
