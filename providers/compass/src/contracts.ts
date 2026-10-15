export const errorStatus = {
  invalid_input: 400, forbidden_origin: 403, not_found: 404, method_not_allowed: 405,
  read_timeout: 408, catalog_mismatch: 409, payload_too_large: 413, unsupported_media_type: 415,
  not_ready: 503, busy: 503, model_invalid: 502, model_unavailable: 502, model_timeout: 504, internal_error: 500,
} as const;
export type ErrorCode = keyof typeof errorStatus;
export class ApiError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}
export function errorBody(code: ErrorCode) {
  return { schema: 'compass.internal.error.v1', error: code, purchaseEnabled: false, paid: false } as const;
}
export type Selection = {kind:'chosen';entryId:string} | {kind:'needs_clarification'} | {kind:'none'};
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
}
export const idPattern = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export function validText(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.isWellFormed() && s.length > 0 && s.trim() === s &&
    s.normalize('NFC') === s && !/[\u0000-\u001f\u007f-\u009f]/u.test(s) && [...s].length <= max;
}
// Bounded recursive descent: limits are checked before descending or allocating members.
// JSON.parse is used only for one already-scanned string token, never a whole document.
export function strictJson(raw: Uint8Array, limits: {bytes:number;depth:number;members:number;array:number}): unknown {
  const bad = (): never => { throw new ApiError('invalid_input'); };
  if (raw.byteLength > limits.bytes) bad();
  let text: string;
  try { text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw); } catch { return bad(); }
  let pos=0, members=0;
  const ws=()=>{ while (/[ \n\r\t]/.test(text[pos] ?? '\0')) pos++; };
  const string=():string=>{
    if(text[pos++] !== '"') return bad();
    const start=pos-1;
    while(pos<text.length) {
      const ch=text[pos++];
      if(ch === '\\') { pos++; continue; }
      if(ch === '"') {
        let value: string;
        try { value=JSON.parse(text.slice(start,pos)) as string; } catch { return bad(); }
        if(!value.isWellFormed()) bad();
        return value;
      }
    }
    return bad();
  };
  const value=(depth:number):unknown=>{
    ws(); const ch=text[pos];
    if(ch==='"') return string();
    if(ch==='{' || ch==='[') {
      if(depth>=limits.depth) bad();
      pos++; ws();
      if(ch==='{') {
        const out:Record<string,unknown>=Object.create(null);
        if(text[pos]==='}') {pos++;return out;}
        while(true) {
          if(++members>limits.members) bad();
          const key=string(); if(Object.hasOwn(out,key)) bad();
          ws(); if(text[pos++]!==':') bad();
          out[key]=value(depth+1); ws();
          const end=text[pos++]; if(end==='}') return out; if(end!==',') bad(); ws();
        }
      }
      const out:unknown[]=[];
      if(text[pos]===']') {pos++;return out;}
      while(true) {
        if(out.length>=limits.array) bad();
        out.push(value(depth+1)); ws();
        const end=text[pos++]; if(end===']') return out; if(end!==',') bad();
      }
    }
    for(const [literal,result] of [['true',true],['false',false],['null',null]] as const) {
      if(text.startsWith(literal,pos)) {pos+=literal.length;return result;}
    }
    const match=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(pos));
    if(!match) return bad();
    pos+=match[0].length; const n=Number(match[0]); if(!Number.isFinite(n)) bad(); return n;
  };
  const result=value(0); ws(); if(pos!==text.length) bad(); return result;
}
export interface SelectInput {schema:'compass.internal.select.v1';task:string;catalogVersion:string}
export function parseInput(raw: Uint8Array, version: string): SelectInput {
  if(raw.byteLength>8192) throw new ApiError('payload_too_large');
  const v=strictJson(raw,{bytes:8192,depth:1,members:3,array:0});
  if(!object(v) || !exactKeys(v,['schema','task','catalogVersion']) || v.schema!=='compass.internal.select.v1' ||
    !validText(v.task,1200) || Buffer.byteLength(v.task)>4800 || typeof v.catalogVersion!=='string' || !idPattern.test(v.catalogVersion)) throw new ApiError('invalid_input');
  if(v.catalogVersion!==version) throw new ApiError('catalog_mismatch');
  return v as unknown as SelectInput;
}
