import { describe, it, expect } from 'vitest';
import { parseInput, strictJson } from '../src/contracts.js';
const input = (task: unknown = 'Find weather', extra = {}) => Buffer.from(JSON.stringify({schema:'compass.internal.select.v1',task,catalogVersion:'directory-v1',...extra}));
describe('strict input', () => {
 it('accepts exact scalar and byte boundary', () => { expect(parseInput(input('😀'.repeat(1200)), 'directory-v1').task).toHaveLength(2400); });
 it.each(['', ' ', ' x', 'x ', 'e\u0301', '\n', '\t', '\u0000', '\u0085', '\ud800', 'x'.repeat(1201), '😀'.repeat(1201)])('rejects invalid task %j', task => { expect(()=>parseInput(input(task),'directory-v1')).toThrow(); });
 it.each([null,1,true,{},[],undefined])('rejects non-string/missing %j', task => { const b = task === undefined ? Buffer.from('{"schema":"compass.internal.select.v1","catalogVersion":"directory-v1"}') : input(task); expect(()=>parseInput(b,'directory-v1')).toThrow(); });
 it('rejects mismatch, extra field and schema',()=> { for(const b of [input('x',{catalogVersion:'other'}),input('x',{url:'x'}),input('x',{schema:'other'})]) expect(()=>parseInput(b,'directory-v1')).toThrow(); });
 it('enforces raw byte boundary',()=> { const b=input(); expect(parseInput(Buffer.concat([b,Buffer.alloc(8192-b.length,32)]),'directory-v1').task).toBe('Find weather'); expect(()=>parseInput(Buffer.concat([b,Buffer.alloc(8193-b.length,32)]),'directory-v1')).toThrow(); });
 it.each(['{"schema":"compass.internal.select.v1","task":"x","ta\\u0073k":"y","catalogVersion":"directory-v1"}', '{"x":{"y":1}}','{"x":[]}', '[]', '{} trailing'])('rejects structure %s',raw=>expect(()=>parseInput(Buffer.from(raw),'directory-v1')).toThrow());
 it('rejects BOM and invalid UTF8',()=> { for(const b of [Buffer.concat([Buffer.from([239,187,191]),input()]),Buffer.from([255])]) expect(()=>parseInput(b,'directory-v1')).toThrow(); });
});
describe('bounded JSON',()=> {
 const limits={bytes:65536,depth:8,members:256,array:64};
 it('handles primitive values and escaped duplicate names',()=> { expect(strictJson(Buffer.from('{"a":[true,false,null,-1.2e2,"x"]}'),limits)).toEqual({a:[true,false,null,-120,'x']}); expect(()=>strictJson(Buffer.from('{"a":1,"\\u0061":2}'),limits)).toThrow(); });
 it.each(['[1,]','{"a":1,}','01','1e999','"\\udc00"','{"a":1}x'])('rejects malformed %s',s=>expect(()=>strictJson(Buffer.from(s),limits)).toThrow());
 it('bounds depth, members and arrays before unbounded parsing',()=> { for(const s of ['['.repeat(9)+'0'+']'.repeat(9),JSON.stringify(Array(65).fill(0)),JSON.stringify(Object.fromEntries(Array.from({length:257},(_,i)=>[i,0])))]) expect(()=>strictJson(Buffer.from(s),limits)).toThrow(); });
});
it('accepts exact JSON depth/member/array limits and rejects one beyond',()=>{
 const limits={bytes:65536,depth:8,members:256,array:64};
 const nested='['.repeat(8)+'0'+']'.repeat(8);
 expect(()=>strictJson(Buffer.from(nested),limits)).not.toThrow();
 expect(()=>strictJson(Buffer.from(JSON.stringify(Array(64).fill(0))),limits)).not.toThrow();
 expect(()=>strictJson(Buffer.from(JSON.stringify(Object.fromEntries(Array.from({length:256},(_,i)=>[i,0])))),limits)).not.toThrow();
});
