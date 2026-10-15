'use strict';
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = process.cwd();
const env = {PATH:process.env.PATH, HOME:path.join(root,'.c0/cr1-home'), TMPDIR:path.join(root,'.c0/cr1-tmp'), TMP:path.join(root,'.c0/cr1-tmp'), TEMP:path.join(root,'.c0/cr1-tmp'), CI:'true',npm_config_offline:'true'};
const code = String.raw`
import importlib.util, pathlib, hashlib, json
root=pathlib.Path.cwd()
p=root/'providers/compass/cloud-run/patch_entrypoint.py'
s=importlib.util.spec_from_file_location('patch',p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
source=(root/'.claude_workflow/local/cloud-run-source-entrypoint.sh').read_bytes()
images=json.loads((root/'.claude_workflow/local/images.json').read_text())
result=m.patch(source,images).decode()
assert '"host": "127.0.0.1"' in result
assert result.index('import pybase64 as _pb64; base64 = _pb64') > result.index('cp -rf /opt/dgemma/vllm_overlay/')
assert result.index('import pybase64 as _pb64; base64 = _pb64') < result.index('"$PY_BIN" -m compileall')
assert 'S.TEST_PAGE = False' in result
ld=[l for l in result.splitlines() if l.startswith('export LD_LIBRARY_PATH=')]
assert len(ld)==1 and '/usr/local/cuda-13.0/compat' not in ld[0] and ld[0].startswith('export LD_LIBRARY_PATH="/usr/local/cuda-13.0/targets/x86_64-linux/lib:')
print('PASS patch fixed source, overlay ordering, private bind, compat hidden')
`;
const r=spawnSync('python3',['-I','-B','-c',code],{env,encoding:'utf8',timeout:30000});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
assert.equal(r.status,0,'entrypoint behavioral fixture');
const safety = String.raw`
import importlib.util, pathlib, json, tempfile, hashlib, io, time
root=pathlib.Path.cwd()
def module(name,path):
    s=importlib.util.spec_from_file_location(name,root/path); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
h=module('h','.claude_workflow/local/run_cloud_run_probe.py')
d=module('d','providers/compass/cloud-run/download_model.py')
p=module('p','providers/compass/cloud-run/patch_entrypoint.py')
def rejects(fn):
    try: fn()
    except (ValueError,TimeoutError,FileNotFoundError): return
    raise AssertionError('expected refusal')
h.baseline(); assert h.REAL_EXECUTOR_CALLS==0
images=json.loads((root/'.claude_workflow/local/images.json').read_text())
source=(root/'.claude_workflow/local/cloud-run-source-entrypoint.sh').read_bytes()
rejects(lambda:p.patch(source+b' ',images))
changed=source.replace(b'S.TEST_PAGE = True',b'S.TEST_PAGE = False')
rejects(lambda:p.patch(changed,{**images,'entrypoint_sha256':hashlib.sha256(changed).hexdigest()}))
manifest=json.loads((root/'.claude_workflow/local/model-manifest.json').read_text())
d.validate(manifest)
rejects(lambda:d.validate({**manifest,'files':manifest['files'][:-1]}))
with tempfile.TemporaryDirectory() as tmp:
    tmp=pathlib.Path(tmp)
    tiny={**manifest,'files':[{**f,'size':3,'sha256':hashlib.sha256(b'abc').hexdigest()} for f in manifest['files']]}
    calls=[]
    def fake(url,timeout): calls.append(url); return io.BytesIO(b'abc')
    d.download(tiny,tmp/'good',opener=fake)
    assert len(calls)==14 and len(list((tmp/'good').iterdir()))==15
    assert (tmp/'good'/'.gitattributes').read_bytes()==b'abc'
    rejects(lambda:d.download(tiny,tmp/'bad',opener=lambda *a,**k:io.BytesIO(b'abcd')))
    assert not (tmp/'bad'/'.ready').exists()
    (tmp/'link').symlink_to(tmp/'good'/'.ready'); rejects(lambda:h.regular(tmp/'link'))
    ident='crp-'+'1'*16
    plan={'id':ident,'project':h.PROJECT,'configuration':h.CONFIG,'region':h.REGION,'service':ident,'repository':ident,'bucket':h.PROJECT+'-'+ident,'build_sa':ident+'-b','runtime_sa':ident+'-r','labels':{'compass-probe':ident},'budget':{'preparation':3,'gpu':2,'contingency':5,'total':10}}
    m={'plan':plan,'intents':[],'resources':{'service':{'intent':True}},'build_submitted':False,'cleanup_deadline':time.time()+100,'prepare_cutoff':time.time()+10}
    rejects(lambda:h.guard(tmp,m,10,'prepare'))
    class Fake:
        def __init__(self,mismatch=False): self.calls=[]; self.deleted=False; self.mismatch=mismatch
        def call(self,method,url,body=None,**kw):
            self.calls.append((method,url))
            if method=='DELETE': self.deleted=True; return {}
            return {'_not_found':True} if self.deleted else {'labels':{'compass-probe':'other' if self.mismatch else ident}}
    h.durable(tmp/'manifest.json',m)
    fake=Fake(); assert h.cleanup(tmp,fake); assert fake.deleted
    assert all(method in ['GET','DELETE'] for method,url in fake.calls)
    count=len(fake.calls); assert h.cleanup(tmp,fake); assert len(fake.calls)==count+1
    assert (tmp/'STOP').exists()
    rejects(lambda:h.guard(tmp,m,0,'gpu'))
    h.durable(tmp/'manifest.json',m); bad=Fake(True); assert not h.cleanup(tmp,bad); assert not bad.deleted
    assert h.read(tmp/'manifest.json')['cleanup']['failures']
    body=h.service_body(plan,'image@sha256:'+'a'*64)
    assert body['scaling']=={'minInstanceCount':0,'maxInstanceCount':1}
    assert body['template']['containers'][0]['resources']['limits']['nvidia.com/gpu']=='1'
    assert body['template']['gpuZonalRedundancyDisabled'] is True
    assert not h.explicit_zero({},0,time.time(),ident,'rev')
    from datetime import datetime,timezone
    now=time.time(); stamp=datetime.fromtimestamp(now,timezone.utc).isoformat()
    def series(state,value='0'):
        return {'resource':{'labels':{'service_name':ident,'revision_name':'rev'}},'metric':{'labels':{'state':state}},'points':[{'interval':{'endTime':stamp},'value':{'int64Value':value}}]}
    assert h.explicit_zero({'timeSeries':[series('active'),series('idle')]},now-10,now+1,ident,'rev')
    assert not h.explicit_zero({'timeSeries':[series('active')]},now-10,now+1,ident,'rev')
    assert not h.explicit_zero({'timeSeries':[series('active','1'),series('idle')]},now-10,now+1,ident,'rev')
assert h.REAL_EXECUTOR_CALLS==0
print('PASS baseline, 14-file download, corruption, symlink, deadlines, cleanup restart/ownership, service schema, explicit zero; real executor calls=0')
`;
const r2=spawnSync('python3',['-I','-B','-c',safety],{env,encoding:'utf8',timeout:30000});
process.stdout.write(r2.stdout||'');process.stderr.write(r2.stderr||'');assert.equal(r2.status,0,'safety fixtures');
(async()=>{
  const {EventEmitter}=require('node:events');
  const {createIngress}=await import('./launcher.mjs');
  let calls=0, sent, destroyed=0;
  function fakeRequest(options,callback){calls++;sent=options;const up=new EventEmitter();up.destroy=()=>{destroyed++;};up.end=()=>{const response=new EventEmitter();response.statusCode=200;response.destroy=()=>{};callback(response);queueMicrotask(()=>{response.emit('data',Buffer.from(options.port===8082?'{"status":"ok","mode":"inproc-vllm"}':'{"schema":"compass.internal.result.v1","modelSource":"live","selection":{"kind":"chosen","entryId":"exa_search"},"purchaseEnabled":false,"paid":false}'));response.emit('end');});};return up;}
  async function invoke(method,url,headers={},body='{}',aborted=false){
    const req=new EventEmitter();Object.assign(req,{method,url,headers,rawHeaders:Object.entries(headers).flat()});
    const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>res.headers[k]=v;res.end=b=>{res.body=String(b);res.writableFinished=true;res.emit('finish');};res.destroy=()=>{res.destroyed=true;};
    createIngress({bootId:'test-boot',request:fakeRequest})(req,res);
    req.emit('data',Buffer.from(body));req.emit('end');if(aborted)req.emit('aborted');await new Promise(resolve=>setImmediate(resolve));return res;
  }
  let res=await invoke('GET','/health');assert.equal(res.statusCode,200);assert.equal(sent.port,8082);
  res=await invoke('POST','/internal/v1/select',{'content-type':'application/json','authorization':'secret','cookie':'secret','x-forwarded-host':'evil'});
  assert.equal(res.statusCode,200);assert.equal(sent.port,8081);assert.deepEqual(Object.keys(sent.headers).sort(),['content-length','content-type']);assert.equal(res.headers['X-Compass-Boot-Id'],'test-boot');
  const before=calls;
  for(const url of ['/health?x=1','/read','/playground.html','/internal/v1/select?x=1'])assert.equal((await invoke('GET',url)).statusCode,404);
  assert.equal((await invoke('POST','/internal/v1/select',{'content-type':'application/json','origin':'https://evil'})).statusCode,403);
  assert.equal((await invoke('POST','/internal/v1/select',{'content-type':'application/json'},'a'.repeat(8193))).statusCode,413);
  assert.equal(calls,before);
  res=await invoke('POST','/internal/v1/select',{'content-type':'application/json'},'{}',true);assert.equal(res.destroyed,true);assert.ok(destroyed>0);
  console.log('PASS socket-free proxy health/path/header/body/abort/boot boundaries; cloud calls=0');
})().catch(e=>{console.error(e);process.exitCode=1;});
const faults=String.raw`
import importlib.util,pathlib,tempfile,time,os,json
p=pathlib.Path('.claude_workflow/local/run_cloud_run_probe.py'); spec=importlib.util.spec_from_file_location('faults',p); h=importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
with tempfile.TemporaryDirectory() as tmp:
    run=pathlib.Path(tmp); ident='crp-'+'2'*16
    plan={'id':ident,'project':h.PROJECT,'configuration':h.CONFIG,'region':h.REGION,'service':ident,'repository':ident,'bucket':h.PROJECT+'-'+ident,'build_sa':ident+'-b','runtime_sa':ident+'-r','labels':{'compass-probe':ident},'budget':{'preparation':3,'gpu':2,'contingency':5,'total':10}}
    m={'plan':plan,'intents':[],'resources':{},'cleanup_deadline':time.time()+10800,'prepare_cutoff':time.time()+7200}
    h.durable(run/'manifest.json',m)
    h.durable(run/'watchdog.json',{'run':str(run),'pid':os.getppid(),'time':time.time(),'cleanup_deadline':m['cleanup_deadline']})
    h.watchdog_ok(run,m['cleanup_deadline'])
    try: h.watchdog_ok(run,m['cleanup_deadline']-3600)
    except ValueError: pass
    else: raise AssertionError('unacknowledged shortened deadline accepted')
    class Refusal:
        calls=0
        def call(self,*a,**kw): self.calls+=1; raise RuntimeError('cloud HTTP 429')
    fake=Refusal()
    try: h.mutation(run,fake,'create quota refusal',h.urls(plan)['service'],'POST',{},stage='prepare',resource='service')
    except RuntimeError: pass
    else: raise AssertionError('refusal swallowed')
    state=h.read(run/'manifest.json')
    assert fake.calls==1 and state['intents'][0]['status']=='intent' and state['resources']['service']['intent']
    h.durable(run/'STOP',{})
    try: h.mutation(run,fake,'retry',h.urls(plan)['service'],'POST',{})
    except ValueError: pass
    else: raise AssertionError('paid call after STOP')
    assert fake.calls==1
assert h.REAL_EXECUTOR_CALLS==0
print('PASS watchdog shortened deadline, actual refusal durable unknown, no retry, STOP race guard; real executor calls=0')
`;
const r3=spawnSync('python3',['-I','-B','-c',faults],{env,encoding:'utf8',timeout:30000});process.stdout.write(r3.stdout||'');process.stderr.write(r3.stderr||'');assert.equal(r3.status,0,'failure fixtures');
const review=String.raw`
import importlib.util,pathlib,tempfile,time,os,json,subprocess,threading,http.server,re
root=pathlib.Path.cwd()
def module(name,path):
    s=importlib.util.spec_from_file_location(name,root/path); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
h=module('r','.claude_workflow/local/run_cloud_run_probe.py')
pe=module('pe','providers/compass/cloud-run/patch_entrypoint.py')
h.time.sleep=lambda s:None
# M1: the real src/http.ts shape {..., modelSource, selection:{kind,entryId}, purchaseEnabled, paid}.
sha=h.sha(json.dumps(json.loads((root/'providers/compass/catalog/demo-selection.json').read_text()),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())
assert sha=='7db0f0d18a8b18c166ee3ded75ef85bdfdd081d096190997bac08def6c6b5460'
def body(**kw):
    b={'schema':'compass.internal.result.v1','catalogVersion':'existing-resources-v1','catalogSha256':sha,'modelSource':'live','selection':{'kind':'chosen','entryId':'exa_search'},'purchaseEnabled':False,'paid':False}; b.update(kw); return json.dumps(b).encode()
v=h.judge(200,body(),'exa_search'); assert v['well_formed'] and v['selection_match'], v
v=h.judge(200,body(selection={'kind':'none'}),'exa_search'); assert v['well_formed'] and not v['selection_match'] and v['selection']=={'kind':'none'}
assert not h.judge(200,body(modelSource='recorded-fixture'),'exa_search')['well_formed']
assert not h.judge(503,body(),'exa_search')['well_formed']
old_shape=json.dumps({'schema':'compass.internal.result.v1','catalogVersion':'existing-resources-v1','catalogSha256':sha,'kind':'chosen','entryId':'exa_search','purchaseEnabled':False,'paid':False}).encode()
assert not h.judge(200,old_shape,'exa_search')['well_formed']
assert not h.judge(200,b'not json','exa_search')['well_formed']
# M2: literal slashes in the metric descriptor resource name.
assert h.DESCRIPTOR_URL.endswith('/metricDescriptors/run.googleapis.com/container/instance_count') and '%2F' not in h.DESCRIPTOR_URL
# M5: UNWRAP is conditional (as on the working VM); M6: diagnostics are non-fatal.
images=json.loads((root/'.claude_workflow/local/images.json').read_text())
patched=pe.patch((root/'.claude_workflow/local/cloud-run-source-entrypoint.sh').read_bytes(),images).decode()
snippet=re.search(r"<<'COMPASS_UNWRAP'\n(.*?)\nCOMPASS_UNWRAP\n",patched,re.S).group(1)
with tempfile.TemporaryDirectory() as tmp:
    tmp=pathlib.Path(tmp); target=tmp/'structured_server.py'
    code=snippet.replace('/opt/dgemma/structured_server.py',str(target))
    def unwrap(text):
        if text is None:
            if target.exists(): target.unlink()
        else: target.write_text(text)
        r=subprocess.run(['python3','-I','-B','-c',code],capture_output=True,text=True,timeout=10)
        return r.returncode, r.stdout, target.read_text() if target.exists() else None
    plain='import pybase64 as base64\nprint(1)\n'
    assert unwrap(plain)==(0,'[compass-runtime] unwrap=not-needed\n',plain)
    wrapped='try:\n    import pybase64 as base64\nexcept ImportError:\n    import base64\n'
    rc,out,text=unwrap(wrapped); assert rc==0 and 'applied' in out and 'import pybase64 as base64' not in text and 'import pybase64 as _pb64; base64 = _pb64' in text
    assert unwrap('import base64\n')[0]==0
    assert unwrap(None)[0]==0
    diag=patched.split('# Diagnostics only: a missing tool or path is recorded, never fatal.\n',1)[1].split('\n\n',1)[0]
    r=subprocess.run(['/bin/bash','-c','set -euo pipefail\nunset LD_LIBRARY_PATH\n'+diag+'\necho DIAG-DONE'],capture_output=True,text=True,timeout=10,env={'PATH':'/usr/bin:/bin'})
    assert r.returncode==0 and 'DIAG-DONE' in r.stdout and 'nvidia-ld-path=absent' in r.stdout and 'driver=unavailable' in r.stdout, (r.returncode,r.stdout,r.stderr)
    # Fixtures for M3/M4/M7/M8.
    run=tmp/'run'; run.mkdir(); ident='crp-'+'3'*16
    plan={'id':ident,'project':h.PROJECT,'configuration':h.CONFIG,'region':h.REGION,'service':ident,'repository':ident,'bucket':h.PROJECT+'-'+ident,'build_sa':ident+'-b','runtime_sa':ident+'-r','labels':{'compass-probe':ident},'budget':{'preparation':3,'gpu':2,'contingency':5,'total':10}}
    u=h.urls(plan)
    def fresh(**kw):
        for f in ['STOP']:
            if (run/f).exists(): (run/f).unlink()
        m={'plan':plan,'intents':[],'resources':{},'build_submitted':False,'cleanup_deadline':time.time()+10800,'prepare_cutoff':time.time()+7200}; m.update(kw)
        h.durable(run/'manifest.json',m)
        h.durable(run/'watchdog.json',{'run':str(run),'pid':os.getppid(),'time':time.time(),'cleanup_deadline':m['cleanup_deadline']})
    class Cloud:
        def __init__(self,gets): self.gets=gets; self.calls=[]
        def call(self,method,url,body=None,**kw):
            self.calls.append((method,url))
            if method=='GET':
                q=self.gets.get(url,[])
                return q.pop(0) if q else {'_not_found':True}
            return {}
    owned={'labels':{'compass-probe':ident}}
    # M3: the repository DELETE carries no query parameter.
    fresh(resources={'repository':{'intent':True}},intents=[{'resource':'repository','status':'returned'}])
    c=Cloud({u['repository']:[owned]}); assert h.cleanup(run,c)
    assert ('DELETE',u['repository']) in c.calls and not any(m=='DELETE' and '?' in x for m,x in c.calls)
    # M7: an unknown create whose first read is 404 but which then appears is deleted, not called absent.
    fresh(resources={'service':{'intent':True}},intents=[{'resource':'service','status':'intent'}])
    c=Cloud({u['service']:[{'_not_found':True},owned]}); assert h.cleanup(run,c)
    assert ('DELETE',u['service']) in c.calls
    # A returned create with an immediate 404 needs one read; an unknown one needs two.
    fresh(resources={'service':{'intent':True}},intents=[{'resource':'service','status':'returned'}])
    c=Cloud({}); assert h.cleanup(run,c); assert [x for x in c.calls if x[0]=='GET']==[('GET',u['service'])]
    fresh(resources={'service':{'intent':True}},intents=[{'resource':'service','status':'intent'}])
    c=Cloud({}); assert h.cleanup(run,c); assert len([x for x in c.calls if x[0]=='GET'])==2
    assert h.read(run/'manifest.json')['resources']['service']['absence_reads']==2
    # Not enough time for the full interval: unknown create is unconfirmed, cleanup incomplete.
    fresh(resources={'service':{'intent':True}},intents=[{'resource':'service','status':'intent'}])
    c=Cloud({}); assert not h.cleanup(run,c,budget=h.CONFIRM_SECONDS+30)
    st=h.read(run/'manifest.json'); assert st['resources']['service'].get('absent_unconfirmed') and not st['resources']['service'].get('absent') and not st['cleanup']['complete']
    assert len([x for x in c.calls if x[0]=='GET'])==1
    # The zero wait always leaves room for the post-wait request, even after a worst-case iteration.
    for d in [time.time()+3600, 10**9]:
        assert h.post_wait_fits(h.zero_wait_end(d)+30+15+1,d) and not h.post_wait_fits(d-300-635,d)
    assert not h.judge(200,body(selection={}),'exa_search')['well_formed']
    assert not h.judge(200,body(selection={'kind':'chosen'}),'exa_search')['well_formed']
    assert h.judge(200,body(selection={'kind':'needs_clarification'}),'exa_search')['well_formed']
    # M7: a lost build submit response: empty listing once, the build appears on the second read and is cancelled.
    listing='https://cloudbuild.googleapis.com/v1/projects/subetha/locations/asia-southeast1/builds?pageSize=100&filter='+h.urllib.parse.quote('tags="'+ident+'"')
    build={'id':'b1','status':'WORKING','tags':[ident],'source':{'storageSource':{'bucket':plan['bucket']}}}
    fresh(build_submitted=True)
    c=Cloud({listing:[{},{'builds':[build]}],listing.split('?')[0]+'/b1':[{'status':'CANCELLED'}]}); assert h.cleanup(run,c)
    assert ('POST',listing.split('?')[0]+'/b1:cancel') in c.calls
    # Known build id missing from an eventually consistent listing: read directly, still cancelled.
    fresh(build_submitted=True,build_id='b1')
    c=Cloud({listing:[{}],listing.split('?')[0]+'/b1':[build,{'status':'CANCELLED'}]}); assert h.cleanup(run,c)
    assert ('POST',listing.split('?')[0]+'/b1:cancel') in c.calls
    # M4: a new service account is waited for by read-only GETs; never visible is a refusal.
    fresh(); c=Cloud({u['build_sa']:[{'_not_found':True},{'_not_found':True},{'email':'x'}]})
    h.wait_visible(run,c,u['build_sa']); assert c.calls==[('GET',u['build_sa'])]*3
    fresh(); c=Cloud({})
    try: h.wait_visible(run,c,u['build_sa'],limit=0.5)
    except TimeoutError: pass
    else: raise AssertionError('invisible SA accepted')
    assert c.calls and all(m=='GET' for m,_ in c.calls)
    # Regional build: poll the build resource; a 404 operation is a failure, never "running".
    fresh(); c=Cloud({'https://x/op':[{'_not_found':True}]})
    try: h.poll(run,c,'https://x/op','prepare',60)
    except RuntimeError: pass
    else: raise AssertionError('404 operation polled as running')
    bid='64311812-6b41-420d-8ea6-94e2d517785f'; img='asia-southeast1-docker.pkg.dev/subetha/'+ident+'/probe'
    done={'id':bid,'status':'SUCCESS','tags':[ident],'source':{'storageSource':{'bucket':plan['bucket']}},'results':{'images':[{'name':img,'digest':'sha256:'+'b'*64}]}}
    fresh(build_submitted=True,build_id=bid,phase='preparing')
    plan={**plan,'context_sha256':'c'*64}
    c=Cloud({h.build_url(bid):[{'status':'WORKING'},done]}); h.finalize_build(run,c,plan)
    st=h.read(run/'manifest.json'); assert st['phase']=='prepared' and st['image']==img+'@sha256:'+'b'*64 and all(m=='GET' for m,_ in c.calls)
    (run/'build-receipt.json').unlink()
    # Real Cloud Build shape (run cr2-r2, build 64311812): two names, one digest.
    two={**done,'results':{'images':[{'name':img,'digest':'sha256:'+'d'*64},{'name':img+':latest','digest':'sha256:'+'d'*64}]}}
    fresh(build_submitted=True,build_id=bid,phase='preparing')
    c=Cloud({h.build_url(bid):[two]}); h.finalize_build(run,c,plan)
    assert h.read(run/'manifest.json')['image']==img+'@sha256:'+'d'*64
    (run/'build-receipt.json').unlink()
    for bad in [[{'name':img,'digest':'sha256:'+'d'*64},{'name':img+':latest','digest':'sha256:'+'e'*64}],[{'name':img,'digest':'sha256:'+'d'*64},{'name':'other/probe','digest':'sha256:'+'d'*64}],[]]:
        fresh(build_submitted=True,build_id=bid,phase='preparing')
        c=Cloud({h.build_url(bid):[{**done,'results':{'images':bad}}]})
        try: h.finalize_build(run,c,plan)
        except ValueError: pass
        else: raise AssertionError('ambiguous build image accepted')
    fresh(build_submitted=True,build_id=bid,phase='preparing')
    c=Cloud({h.build_url(bid):[{**done,'status':'FAILURE'}]})
    try: h.finalize_build(run,c,plan)
    except RuntimeError: pass
    else: raise AssertionError('failed build accepted')
    fresh(build_submitted=True,build_id=bid,phase='preparing')
    c=Cloud({h.build_url(bid):[{**done,'tags':['other']}]})
    try: h.finalize_build(run,c,plan)
    except ValueError: pass
    else: raise AssertionError('foreign build accepted')
    assert not (run/'build-receipt.json').exists()
    # Keep-image retry: a failed first GPU attempt keeps repository and runtime SA; final pass removes them.
    sa=lambda k:{'displayName':ident,'email':plan[k]+'@subetha.iam.gserviceaccount.com'}
    fresh(resources={k:{'intent':True} for k in ['service','repository','bucket','build_sa','runtime_sa']},intents=[{'resource':k,'status':'returned'} for k in ['service','repository','bucket','build_sa','runtime_sa']])
    c=Cloud({u['service']:[owned],u['bucket']:[owned],u['build_sa']:[sa('build_sa')]})
    assert h.cleanup(run,c,keep=('repository','runtime_sa'))
    st=h.read(run/'manifest.json'); assert st['phase']=='gpu-failed-image-kept' and st['cleanup']['kept']==['repository','runtime_sa'] and not st['cleanup']['failures'] and not st['cleanup']['complete']
    assert not (run/'STOP').exists(), 'STOP must not trigger the watchdog sweep of a kept image'
    assert not any(m=='DELETE' and (u['repository'] in x or u['runtime_sa'] in x) for m,x in c.calls) and ('DELETE',u['service']) in c.calls
    c2=Cloud({u['repository']:[owned],u['runtime_sa']:[sa('runtime_sa')]})
    assert h.cleanup(run,c2); st=h.read(run/'manifest.json'); assert st['cleanup']['complete'] and st['phase']=='cleaned' and ('DELETE',u['repository']) in c2.calls
    # Watchdog path: a kept run is not swept before its deadline (sweep_kept=False), and the lock timeout is survivable.
    fresh(resources={'repository':{'intent':True,'kept':True},'runtime_sa':{'intent':True,'kept':True}},phase='gpu-failed-image-kept',intents=[])
    (run/'STOP').write_text('{}'); c3=Cloud({})
    assert h.cleanup(run,c3,sweep_kept=False) and not c3.calls and not (run/'STOP').exists() and h.read(run/'manifest.json')['phase']=='gpu-failed-image-kept'
    c4=Cloud({u['repository']:[owned],u['runtime_sa']:[sa('runtime_sa')]}); assert h.cleanup(run,c4,sweep_kept=True) and ('DELETE',u['repository']) in c4.calls and h.read(run/'manifest.json')['cleanup']['complete']
    # Cleanup failures always win over intentional retention: phase incomplete, STOP stays.
    fresh(resources={'service':{'intent':True},'repository':{'intent':True},'runtime_sa':{'intent':True}},intents=[{'resource':k,'status':'returned'} for k in ['service','repository','runtime_sa']])
    c5=Cloud({u['service']:[{'labels':{'compass-probe':'other'}}]}); assert not h.cleanup(run,c5,keep=('repository','runtime_sa'))
    st=h.read(run/'manifest.json'); assert st['phase']=='cleanup-incomplete' and st['cleanup']['failures'] and (run/'STOP').exists()
    c6=Cloud({}); assert h.cleanup(run,c6,sweep_kept=False) and c6.calls, 'incomplete cleanup must be retried, not treated as kept'
    assert h.read(run/'manifest.json')['phase']=='cleaned'
    # Operation error classification: only Cloud Run code 9 with a start/probe message is retryable.
    assert h.classify_operation_error({'code':9,'message':'The user-provided container failed the configured startup probe checks. Logs URL: ...'})=='startup_failed'
    assert h.classify_operation_error({'code':8,'message':'Quota exceeded for nvidia-l4'})=='held'
    assert h.classify_operation_error({'code':9,'message':'Revision is not ready and cannot serve traffic.'})=='held'
    assert h.classify_operation_error({'code':7,'message':'Permission denied'})=='held' and h.classify_operation_error(None)=='held'
    # Retry eligibility: only an accepted create whose revision failed to start.
    create={'action':'create one L4 service','status':'returned'}
    assert h.retry_eligible({'gpu_attempts':1,'attempt_outcome':'startup_failed','intents':[create]})
    assert not h.retry_eligible({'gpu_attempts':1,'attempt_outcome':'startup_failed','intents':[{**create,'status':'intent','error':{'type':'RuntimeError','message':'cloud HTTP 429'}}]})
    assert not h.retry_eligible({'gpu_attempts':1,'attempt_outcome':'startup_failed','intents':[{**create,'status':'intent'}]})
    assert not h.retry_eligible({'gpu_attempts':1,'intents':[create]})
    assert not h.retry_eligible({'gpu_attempts':2,'attempt_outcome':'startup_failed','intents':[create]})
    # GPU accounting rounds up and accumulates.
    assert h.gpu_seconds_used({'gpu_started':1000.0},1000.2)==1 and h.gpu_seconds_used({'gpu_started':1000.0,'gpu_seconds_used':100},1010.5)==111
    # Startup override: command/args only, shape-checked; absent file means no override.
    assert h.startup_override(run) is None
    (run/'startup-override.json').write_text(json.dumps({'command':['/bin/bash'],'args':['-c','exec /usr/local/bin/node /opt/compass/launcher.mjs']}))
    b=h.service_body(plan,'img@sha256:'+'a'*64,h.startup_override(run)); assert b['template']['containers'][0]['command']==['/bin/bash'] and b['template']['containers'][0]['image']=='img@sha256:'+'a'*64
    for bad in [{'env':[{'name':'X','value':'y'}]},{'command':[]},{'command':'x'},{}]:
        (run/'startup-override.json').write_text(json.dumps(bad))
        try: h.startup_override(run)
        except ValueError: pass
        else: raise AssertionError('bad override accepted')
    (run/'startup-override.json').unlink()
    # M8: boot events paged and correlation separated from the selection result.
    class Logs:
        def __init__(self): self.bodies=[]
        def call(self,method,url,body=None,**kw):
            self.bodies.append(body)
            return {'entries':[{'jsonPayload':{'event':'compass_boot','bootId':'a'*36}}],'nextPageToken':'t'} if 'pageToken' not in body else {'entries':[{'jsonPayload':{'event':'compass_boot','bootId':'b'*36}}]}
    lg=Logs(); r=h.boot_correlation(lg,plan,'rev',[{'boot_id':'a'*36},{'boot_id':'b'*36},{'boot_id':'c'*36}])
    assert r['complete'] and r['request_boots_found']==['a'*36,'b'*36] and r['request_boots_missing']==['c'*36]
    assert all('jsonPayload.event="compass_boot"' in b['filter'] for b in lg.bodies) and lg.bodies[1]['pageToken']=='t'
    # SHOULD: a non-2xx answer is a received HTTP status, not 'unknown' (HTTPError.fp has no .raw).
    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers['content-length'])); b=b'{"error":{"code":"busy"}}'
            self.send_response(503); self.send_header('X-Compass-Boot-Id','1'*8+'-1111-1111-1111-'+'1'*12); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b)
        def log_message(self,*a): pass
    server=http.server.HTTPServer(('127.0.0.1',0),H); threading.Thread(target=server.serve_forever,daemon=True).start()
    class Token:
        def command(self,args): return b'tok'
    fresh(cleanup_deadline=time.time()+3600,requests=[])
    try: h.request_case(run,Token(),'http://127.0.0.1:%d'%server.server_port,{'id':'topic-search','task':'x','expected':'exa_search'},10)
    except ValueError: pass
    else: raise AssertionError('503 accepted')
    server.shutdown()
    req=h.read(run/'manifest.json')['requests'][0]
    assert req['status']=='received' and req['http_status']==503 and req['well_formed'] is False, req
print('PASS review r1 fixes: real response shape, descriptor path, conditional UNWRAP, nonfatal diagnostics, repository DELETE, unknown-create second read, lost build, SA visibility, paged boot logs, non-2xx status')
`;
const r4=spawnSync('python3',['-I','-B','-c',review],{env,encoding:'utf8',timeout:60000});process.stdout.write(r4.stdout||'');process.stderr.write(r4.stderr||'');assert.equal(r4.status,0,'review r1 fixtures');
// ---- Public mode (design §0.4): x402 gate with injected store/facilitator/clock; ingress branch; log content.
let publicModeDone=false; process.on('exit',()=>{if(!publicModeDone){console.error('public mode block did not complete');process.exitCode=1;}});
(async()=>{
  const g=await import('./x402-gate.mjs');
  const config={publicUrl:'https://compass-test.a.run.app',payTo:'0x1111111111111111111111111111111111111111',gateModule:g,disclosure:'d'};
  const req=g.requirements(config);
  const auth=(over={})=>({from:'0x2222222222222222222222222222222222222222',to:config.payTo,value:'10000',validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+600),nonce:'0x'+'ab'.repeat(32),...over});
  const cred=(a=auth(),accepted=req)=>g.b64encode(JSON.stringify({x402Version:2,accepted,payload:{signature:'0x'+'cd'.repeat(65),authorization:a}}));
  // Pure checks: challenge shape, strict decode, key normalisation, classify.
  const pr=g.paymentRequired(config); const dec=JSON.parse(Buffer.from(pr.headers['payment-required'],'base64').toString());
  assert.equal(pr.status,402);assert.deepEqual(dec.accepts,[req]);assert.equal(dec.resource.url,'https://compass-test.a.run.app/select');assert.equal(dec.resource.mimeType,'application/json');
  assert.ok(g.decodeCredential(cred(),config).ok);
  assert.equal(g.decodeCredential(cred(auth(),{...req,amount:'1'}),config).ok,false);
  assert.equal(g.decodeCredential(cred(auth({to:'0x3333333333333333333333333333333333333333'})),config).ok,false);
  assert.equal(g.decodeCredential(cred(auth({value:'9999'})),config).ok,false);
  assert.equal(g.decodeCredential(cred(auth({nonce:'0x12'})),config).ok,false);
  assert.equal(g.decodeCredential('not base64!',config).ok,false);
  assert.equal(g.decodeCredential(g.b64encode('{"x402Version":2,"accepted":{},"payload":{"a":[[[[[[1]]]]]]}}'),config).ok,false);
  assert.equal(g.nonceKey('EIP155:84532','0xABCD','0xEF'),g.nonceKey('eip155:84532','0xabcd','0xef'));
  const tx='0x'+'11'.repeat(32);
  assert.equal(g.classifySettle(200,{success:true,transaction:tx,network:g.NETWORK,payer:'0x2222222222222222222222222222222222222222'.toUpperCase().replace('0X','0x')},auth().from).kind,'settled');
  assert.equal(g.classifySettle(200,{success:true,transaction:tx,network:g.NETWORK,payer:'0x9999999999999999999999999999999999999999'},auth().from).kind,'unknown');
  assert.equal(g.classifySettle(200,{success:false,errorReason:'settlement_pending'},auth().from).kind,'unknown');
  assert.equal(g.classifySettle(200,{success:false,errorReason:'invalid'},auth().from).kind,'failed');
  assert.equal(g.classifySettle(500,{success:true,transaction:tx,network:g.NETWORK},auth().from).kind,'unknown');
  assert.equal(g.classifySettle(200,{success:true,transaction:'0x12',network:g.NETWORK},auth().from).kind,'unknown');
  assert.equal(g.classifyVerify(200,{isValid:true}),'valid');assert.equal(g.classifyVerify(200,{isValid:false}),'invalid');
  assert.equal(g.classifyVerify(200,{isValid:'false'}),'error');assert.equal(g.classifyVerify(200,{}),'error');assert.equal(g.classifyVerify(503,{isValid:true}),'error');
  assert.equal(g.conflictBody({state:'settling',nonce:'n'}).paid,'possibly');assert.equal(g.conflictBody({state:'accepted'}).paid,'no');assert.equal(g.conflictBody({state:'settled'}).paid,'yes');
  // Orchestrator with fakes.
  function harness({records={},verify='valid',settle={kind:'settled',receipt:{transaction:tx},header:'H'},infer={status:200,body:{selection:{kind:'chosen'}}},ready=true,busy=false,draining=false,clock=[0],storeFail=null,inferDelay=0,settleDelay=0}={}){
    const calls={verify:0,settle:0,infer:0,writes:[],lookups:0}; const logs=[];
    let gen=0;
    const store={async lookup(key){calls.lookups++;if(storeFail==='lookup')return {error:true};return records[key]?{found:true,record:records[key]}:{found:false};},
      async write(key,g0,record){calls.writes.push(record.state);if(storeFail===record.state)return {error:true};if(g0==='0'&&records[key])return {conflict:true};if(g0!=='0'&&String(gen)!==g0)return {conflict:true};records[key]=record;gen++;return {ok:true,generation:String(gen)};}};
    const facilitator={async verify(){calls.verify++;return verify;},async settle(){calls.settle++;clock[0]+=settleDelay;return settle;}};
    let slot=busy, dr=draining;
    const ctx={now:()=>clock[0],bootId:'b',log:f=>logs.push(f),draining:()=>dr,ready:async()=>ready,busy:()=>slot,acquire:()=>{if(slot)return null;slot=true;return()=>{slot=false;};},
      infer:async(_b,ms)=>{calls.infer++;calls.inferMs=ms;clock[0]+=inferDelay;return infer;},store,facilitator,setDraining:v=>{dr=v;},validateInput:b=>String(b)!=='BAD'};
    return {ctx,calls,logs,records};
  }
  const key=g.nonceKey(g.NETWORK,auth().from,auth().nonce);
  // (a) not ready / busy / draining -> 503 before any 402, credential or not; nothing called.
  for(const [opt,code] of [[{ready:false},'not_ready'],[{busy:true},'busy'],[{draining:true},'draining']]){
    const h=harness(opt); const r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')});
    assert.equal(r.status,503);assert.equal(r.outcome,code);assert.ok(r.headers['retry-after']);assert.equal(h.calls.verify+h.calls.settle+h.calls.infer+h.calls.lookups,0);
  }
  // unpaid -> 402 challenge; invalid -> 402; stale -> 402 (no verify, no record).
  let h=harness(); let r=await g.handleSelect({config,ctx:h.ctx,header:undefined,body:Buffer.from('{}')}); assert.equal(r.status,402);assert.ok(r.headers['payment-required']);
  h=harness(); r=await g.handleSelect({config,ctx:h.ctx,header:'zz',body:Buffer.from('{}')}); assert.equal(r.status,402);assert.equal(h.calls.verify,0);
  h=harness(); r=await g.handleSelect({config,ctx:h.ctx,header:cred(auth({validBefore:'5'})),body:Buffer.from('{}')}); assert.equal(r.status,402);assert.equal(r.stage,'stale');assert.equal(h.calls.verify,0);assert.equal(h.calls.writes.length,0);
  // duplicate: any recorded state -> 409 before verify, and settling -> paid possibly; lookup error -> 503.
  for(const state of ['accepted','settling','settled','unknown','failed']){
    h=harness({records:{[key]:{state,nonce:auth().nonce}}}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')});
    assert.equal(r.status,409);assert.equal(r.body.recorded,state);assert.equal(h.calls.verify+h.calls.infer+h.calls.settle,0);
  }
  h=harness({storeFail:'lookup'}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,503);assert.equal(h.calls.verify,0);
  // verify false -> 402, no record; verify error -> 503, no record.
  h=harness({verify:'invalid'}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,402);assert.equal(h.calls.writes.length,0);
  h=harness({verify:'error'}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,503);assert.equal(h.calls.writes.length,0);
  // accepted write failure -> 503, no inference; create conflict -> 409.
  h=harness({storeFail:'accepted'}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,503);assert.equal(h.calls.infer,0);
  // happy path: order accepted -> infer -> settling -> settle -> settled -> 200 with receipt; slot released.
  h=harness(); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')});
  assert.equal(r.status,200);assert.equal(r.headers['payment-response'],'H');assert.deepEqual(h.calls.writes,['accepted','settling','settled']);assert.equal(h.calls.settle,1);assert.equal(h.ctx.busy(),false);
  assert.deepEqual(Object.keys(h.records[key]).sort(),['at','bootId','from','network','nonce','payTo','state','transaction','validBefore','value']);
  // inference failure -> 503, no settling/settle, record stays accepted.
  h=harness({infer:{status:502,body:null}}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,503);assert.equal(h.calls.settle,0);assert.equal(h.records[key].state,'accepted');
  // reserve: inference that eats the budget -> refused before settling (no charge).
  h=harness({inferDelay:g.DEADLINE_MS-g.RESERVE_MS+1}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,503);assert.equal(r.outcome,'no_time');assert.equal(h.calls.settle,0);assert.deepEqual(h.calls.writes,['accepted']);
  // The inference call itself is bounded by the remaining time minus the reserve (never the bare 15 s).
  h=harness(); await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.ok(h.calls.inferMs<=g.DEADLINE_MS-g.RESERVE_MS&&h.calls.inferMs<=g.BUDGET.infer,String(h.calls.inferMs));
  h=harness(); h.ctx.now=()=>g.DEADLINE_MS-g.RESERVE_MS-1000; // pretend time passed before inference: bound shrinks to ~1 s
  { const ctx2={...h.ctx}; let t0=0; const start=Date.now; ctx2.now=()=>t0; const r2=g.handleSelect({config,ctx:ctx2,header:cred(),body:Buffer.from('{}')}); t0=g.DEADLINE_MS-g.RESERVE_MS-1000; await r2; assert.ok(h.calls.inferMs<=1000,String(h.calls.inferMs)); }
  // STALE_MS (30 s) >= DEADLINE_MS (28 s): a credential that passes the stale check always covers the pre-settle reserve;
  // the validBefore term of the gate is defensive. Documented here rather than tested.
  assert.ok(g.STALE_MS>=g.DEADLINE_MS);
  // settling transition failure -> 503, no settle. Draining after settling -> no settle, state stays settling.
  h=harness({storeFail:'settling'}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,503);assert.equal(h.calls.settle,0);
  h=harness(); { const orig=h.ctx.store.write; h.ctx.store.write=async(k,g0,rec)=>{const v=await orig(k,g0,rec); if(rec.state==='settling')h.ctx.setDraining(true); return v;}; }
  r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,503);assert.equal(r.outcome,'not_settled');assert.equal(h.calls.settle,0);assert.equal(h.records[key].state,'settling');assert.ok(h.logs.some(l=>l.outcome==='nonce_not_settled'));
  // settle outcomes: failed -> 402 + failed record; unknown -> 502 + unknown record; unknown write failure still 502 + log.
  h=harness({settle:{kind:'failed'}}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,402);assert.equal(h.records[key].state,'failed');
  h=harness({settle:{kind:'unknown'}}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,502);assert.equal(r.body.status,'unknown');assert.equal(h.records[key].state,'unknown');
  h=harness({settle:{kind:'unknown'},storeFail:'unknown'}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,502);assert.ok(h.logs.some(l=>l.outcome==='nonce_write_failed'));
  // Logs never contain the credential, the body or the receipt header.
  h=harness(); await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{"task":"SECRET-PROMPT"}')});
  const text=JSON.stringify(h.logs); assert.ok(!text.includes(cred().slice(0,40))&&!text.includes('SECRET-PROMPT')&&!text.includes('0x'+'cd'.repeat(3)));
  for(const l of h.logs)assert.ok(Object.keys(l).every(k=>['stage','outcome','httpStatus','elapsedMs','key'].includes(k)),JSON.stringify(l));
  // Invalid body: 400 before verify, nothing recorded (nonce not spent).
  h=harness(); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('BAD')}); assert.equal(r.status,400);assert.equal(h.calls.verify,0);assert.equal(h.calls.writes.length,0);
  // Strict base64: non-canonical padding and invalid UTF-8 are refused.
  assert.equal(g.decodeCredential(cred()+'=',config).ok,false);
  assert.equal(g.decodeCredential(Buffer.from([0xff,0xfe,0x7b]).toString('base64'),config).ok,false);
  // Real store: thrown fetch / token failures become {error:true}; never throw.
  { const throwing=g.createNonceStore({bucket:'b',fetch:async()=>{throw new Error('net');},token:async()=>'T'}); assert.deepEqual(await throwing.lookup('k',500),{error:true}); assert.deepEqual(await throwing.write('k','0',{},500),{error:true});
    const noToken=g.createNonceStore({bucket:'b',fetch:async()=>new Response('{}'),token:async()=>{throw new Error('meta');}}); assert.deepEqual(await noToken.lookup('k',500),{error:true}); }
  // Confirmed settlement with a failing settled-write still delivers 200 + receipt (no 503 that discards the answer).
  h=harness({storeFail:'settled'}); r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,200);assert.equal(r.headers['payment-response'],'H');assert.ok(h.logs.some(l=>l.outcome==='nonce_write_failed'&&l.key===key));
  // Throwing store during the unknown write still answers 502 with the key-bearing log.
  h=harness({settle:{kind:'unknown'}}); { const w=h.ctx.store.write; h.ctx.store.write=async(k,g0,rec)=>{if(rec.state==='unknown')return {error:true};return w(k,g0,rec);}; }
  r=await g.handleSelect({config,ctx:h.ctx,header:cred(),body:Buffer.from('{}')}); assert.equal(r.status,502);assert.ok(h.logs.some(l=>l.outcome==='nonce_write_failed'&&l.key===key));
  // Real gate wiring: createPublicGate drain aborts inference and forces durable unknown for an unanswered settle.
  { const {createPublicGate}=await import('./launcher.mjs'); const {EventEmitter}=require('node:events');
    const writes=[]; const store2={lookup:async()=>({found:false}),write:async(k,g0,rec)=>{writes.push(rec.state);return {ok:true,generation:String(writes.length)};}};
    let settleResolve; const fac2={verify:async()=>'valid',settle:()=>new Promise(r=>{settleResolve=r;})};
    const fakeRequest=(opts,cb)=>{const up=new EventEmitter();up.destroyed=false;up.destroy=()=>{up.destroyed=true;queueMicrotask(()=>up.emit('close'));};up.end=()=>{const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};cb(res);queueMicrotask(()=>{res.emit('data',Buffer.from(opts.port===8082?'{"status":"ok","mode":"inproc-vllm"}':'{"selection":{"kind":"chosen"}}'));res.emit('end');up.emit('close');});};return up;};
    const logs2=[]; const pg=createPublicGate({bootId:'b2',config:{...config,gateModule:g,disclosure:'x'.repeat(90)},request:fakeRequest,healthy:()=>true,store:store2,facilitator:fac2,validateInput:()=>true,log:f=>logs2.push(f)});
    let result; pg.select(Buffer.from('{}'),cred(),(st)=>{result=st;});
    for(let i=0;i<50&&!settleResolve;i++)await new Promise(r=>setTimeout(r,5));
    assert.ok(settleResolve,'settle in flight'); assert.deepEqual(writes,['accepted','settling']);
    const t0=Date.now(); await pg.drain(200); assert.ok(Date.now()-t0<2000);
    assert.deepEqual(writes,['accepted','settling','unknown']); assert.ok(logs2.some(l=>l.outcome==='drain_forced'));
    settleResolve({kind:'unknown'});
    // /health in public mode carries the approved disclosure from the authorization record.
    { const auth=JSON.parse(require('node:fs').readFileSync('.claude_workflow/local/compass-provider-authorization-20261015.json','utf8'));
      const pgH=createPublicGate({bootId:'bh',config:{...config,gateModule:g,disclosure:auth.disclosure_required},request:fakeRequest,healthy:()=>true,store:store2,facilitator:fac2,validateInput:()=>true,log:()=>{}});
      let hs,hb; pgH.health({}, {}, (st,b)=>{hs=st;hb=JSON.parse(b);}); for(let i=0;i<50&&hs===undefined;i++)await new Promise(r=>setTimeout(r,5));
      assert.equal(hs,200); assert.equal(hb.disclosure,auth.disclosure_required); for(const w of ['161.3','8.5 min','11.5 min','600 s','estimate','No payment'])assert.ok(hb.disclosure.includes(w),w); }
    // After drain, admission refuses (acquire and ready both check draining).
    let after; await pg.select(Buffer.from('{}'),cred(),(st)=>{after=st;}); assert.equal(after,503);
    // Pre-settle inference is aborted by drain (socket destroyed -> 503, no settle).
    const writes3=[]; let settles3=0; const slowReq=(opts,cb)=>{const up=new EventEmitter();up.destroy=()=>{queueMicrotask(()=>up.emit('close'));};up.end=()=>{if(opts.port===8082){const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};cb(res);queueMicrotask(()=>{res.emit('data',Buffer.from('{"status":"ok","mode":"inproc-vllm"}'));res.emit('end');up.emit('close');});}};return up;};
    const pg3=createPublicGate({bootId:'b3',config:{...config,gateModule:g,disclosure:'x'.repeat(90)},request:slowReq,healthy:()=>true,store:{lookup:async()=>({found:false}),write:async(k,g0,rec)=>{writes3.push(rec.state);return {ok:true,generation:'1'};}},facilitator:{verify:async()=>'valid',settle:async()=>{settles3++;return {kind:'unknown'};}},validateInput:()=>true,log:()=>{}});
    let st3; const p3=pg3.select(Buffer.from('{}'),cred(),(s)=>{st3=s;}); for(let i=0;i<50&&writes3.length===0;i++)await new Promise(r=>setTimeout(r,5));
    const tAbort=Date.now(); await pg3.drain(100); await p3; assert.ok(Date.now()-tAbort<1500,'drain must abort the running inference, not wait for its timeout'); assert.equal(st3,503); assert.equal(settles3,0); assert.deepEqual(writes3,['accepted']);
    // Drain holds until a confirmed settlement's outcome write and response delivery are done.
    { let settleCalled=false; const slowStore={lookup:async()=>({found:false}),write:async(k,g0,rec)=>{if(rec.state==='settled')await new Promise(r=>setTimeout(r,300));return {ok:true,generation:'1'};}};
      const pg5=createPublicGate({bootId:'b5',config:{...config,gateModule:g,disclosure:'x'.repeat(90)},request:fakeRequest,healthy:()=>true,store:slowStore,facilitator:{verify:async()=>'valid',settle:async()=>{settleCalled=true;return {kind:'settled',receipt:{transaction:'0x'+'11'.repeat(32)},header:'R'};}},validateInput:()=>true,log:()=>{}});
      let delivered; const p5=pg5.select(Buffer.from('{}'),cred(),(st)=>{delivered=st;});
      for(let i=0;i<100&&!settleCalled;i++)await new Promise(r=>setTimeout(r,2));
      assert.ok(settleCalled); await pg5.drain(6000,2000); assert.equal(delivered,200,'drain resolved before the paid response was delivered'); await p5; }
    // Same with the wait window already exhausted: a settled payment being recorded is waited for (within the
    // shared deadline) and never overwritten by a forced `unknown`.
    { let settleCalled=false; const states=[]; const slowStore={lookup:async()=>({found:false}),write:async(k,g0,rec)=>{states.push(rec.state);if(rec.state==='settled')await new Promise(r=>setTimeout(r,300));return {ok:true,generation:'1'};}};
      const pg7=createPublicGate({bootId:'b7',config:{...config,gateModule:g,disclosure:'x'.repeat(90)},request:fakeRequest,healthy:()=>true,store:slowStore,facilitator:{verify:async()=>'valid',settle:async()=>{settleCalled=true;return {kind:'settled',receipt:{transaction:'0x'+'11'.repeat(32)},header:'R'};}},validateInput:()=>true,log:()=>{}});
      let delivered; const p7=pg7.select(Buffer.from('{}'),cred(),(st)=>{delivered=st;});
      for(let i=0;i<100&&!settleCalled;i++)await new Promise(r=>setTimeout(r,2));
      await new Promise(r=>setTimeout(r,5)); await pg7.drain(10,2000); assert.equal(delivered,200); assert.ok(!states.includes('unknown'),JSON.stringify(states)); await p7; }
    // Race: the settle returns while the forced `unknown` write is pending -> the paid response is still waited for.
    // Deterministic: the forced write finishes first; the settled write is held open by hand.
    { let settleCalled=false, resolveSettle, releaseSettled, forcedDone=false, forcedStarted=false;
      const raceStore={lookup:async()=>({found:false}),write:async(k,g0,rec)=>{
        if(rec.state==='unknown'){forcedStarted=true;await new Promise(r=>setTimeout(r,30));forcedDone=true;}
        if(rec.state==='settled')await new Promise(r=>{releaseSettled=r;});
        return {ok:true,generation:'1'};}};
      const pg8=createPublicGate({bootId:'b8',config:{...config,gateModule:g,disclosure:'x'.repeat(90)},request:fakeRequest,healthy:()=>true,store:raceStore,facilitator:{verify:async()=>'valid',settle:()=>{settleCalled=true;return new Promise(r=>{resolveSettle=r;});}},validateInput:()=>true,log:()=>{}});
      let delivered; const p8=pg8.select(Buffer.from('{}'),cred(),(st)=>{delivered=st;});
      for(let i=0;i<100&&!settleCalled;i++)await new Promise(r=>setTimeout(r,2));
      let drained=false; const d8=pg8.drain(10,3000).then(()=>{drained=true;});
      for(let i=0;i<200&&!forcedStarted;i++)await new Promise(r=>setTimeout(r,2));
      assert.ok(forcedStarted&&!forcedDone,'forced write in flight');
      resolveSettle({kind:'settled',receipt:{transaction:'0x'+'11'.repeat(32)},header:'R'});
      for(let i=0;i<200&&(!forcedDone||!releaseSettled);i++)await new Promise(r=>setTimeout(r,2));
      assert.ok(forcedDone&&releaseSettled,'forced write done and settled write pending');
      await new Promise(r=>setTimeout(r,100));
      assert.equal(drained,false,'drain resolved while a returned settlement was still being recorded');
      releaseSettled(); await d8; assert.equal(delivered,200); await p8; }
    // Forced unknown writes are bounded by the shared deadline even if the store never answers.
    { let settleCalled=false; const hangStore={lookup:async()=>({found:false}),write:async(k,g0,rec)=>rec.state==='unknown'?new Promise(()=>{}):{ok:true,generation:'1'}};
      const pg6=createPublicGate({bootId:'b6',config:{...config,gateModule:g,disclosure:'x'.repeat(90)},request:fakeRequest,healthy:()=>true,store:hangStore,facilitator:{verify:async()=>'valid',settle:()=>{settleCalled=true;return new Promise(()=>{});}},validateInput:()=>true,log:()=>{}});
      pg6.select(Buffer.from('{}'),cred(),()=>{}); for(let i=0;i<100&&!settleCalled;i++)await new Promise(r=>setTimeout(r,2));
      const t6=Date.now(); await pg6.drain(50,200); const el=Date.now()-t6; assert.ok(el>=200&&el<800,String(el)); }
    // Draining that starts after admission (during the durable lookup) is caught by acquire(): no verify.
    let verifies4=0; let pg4; const store4={lookup:async()=>{pg4.drain(0);return {found:false};},write:async()=>({ok:true,generation:'1'})};
    pg4=createPublicGate({bootId:'b4',config:{...config,gateModule:g,disclosure:'x'.repeat(90)},request:fakeRequest,healthy:()=>true,store:store4,facilitator:{verify:async()=>{verifies4++;return 'valid';},settle:async()=>({kind:'unknown'})},validateInput:()=>true,log:()=>{}});
    let st4; await pg4.select(Buffer.from('{}'),cred(),(s)=>{st4=s;}); assert.equal(st4,503); assert.equal(verifies4,0);
  }
  // Real GCS/facilitator clients: request shapes with an injected fetch.
  const seen=[]; const fakeFetch=async(url,init)=>{seen.push({url,method:init.method,headers:init.headers,body:init.body,redirect:init.redirect}); if(String(url).includes('/o?uploadType=media')) return new Response(JSON.stringify({generation:'7'}),{status:200}); if(String(url).endsWith('?alt=media')) return new Response('',{status:404}); if(String(url).endsWith('/verify')) return new Response(JSON.stringify({isValid:true}),{status:200}); if(String(url).endsWith('/settle')) return new Response(JSON.stringify({success:true,transaction:tx,network:g.NETWORK}),{status:200}); return new Response('{}',{status:200});};
  const store=g.createNonceStore({bucket:'bkt',fetch:fakeFetch,token:async()=>'TOK'}); const fac=g.createFacilitator({url:'https://f.example/',fetch:fakeFetch});
  assert.deepEqual(await store.lookup('k',1000),{found:false}); assert.deepEqual(await store.write('k','0',{state:'accepted'},1000),{ok:true,generation:'7'});
  const decoded=g.decodeCredential(cred(),config).payload;
  assert.equal(await fac.verify(decoded,config,1000),'valid'); assert.equal((await fac.settle(decoded,config,1000)).kind,'settled');
  assert.ok(seen[0].url.includes('/b/bkt/o/nonce%2Fk?alt=media')&&seen[0].headers.authorization==='Bearer TOK');
  assert.ok(seen[1].url.includes('ifGenerationMatch=0')&&seen[1].method==='POST');
  assert.equal(seen[2].url,'https://f.example/verify'); const vb=JSON.parse(seen[2].body); assert.equal(vb.x402Version,2);assert.deepEqual(vb.paymentRequirements,req);assert.equal(vb.paymentPayload.scheme,'exact');assert.equal(vb.paymentPayload.network,g.NETWORK);assert.equal(vb.paymentPayload.x402Version,2);assert.deepEqual(Object.keys(vb.paymentPayload).sort(),['accepted','network','payload','scheme','x402Version']);
  assert.ok(seen.every(s=>s.redirect==='manual'));
  // Ingress branch: public mode closes the internal path, routes /select through the gate, keeps /health shape with disclosure.
  const {createIngress}=await import('./launcher.mjs'); const {EventEmitter}=require('node:events');
  const gateCalls=[]; const publicGate={health:(req,res,finish)=>finish(200,'{"ready":true,"disclosure":"d"}'),select:async(body,header,respond)=>{gateCalls.push({body:String(body),header});respond(402,{'payment-required':'X','content-type':'application/json'},'{}');}};
  async function invoke2(method,url,headers={},body='{}'){const req=new EventEmitter();Object.assign(req,{method,url,headers,rawHeaders:Object.entries(headers).flat()});const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>res.headers[k]=v;res.end=b=>{res.body=String(b);res.writableFinished=true;res.emit('finish');};res.destroy=()=>{};createIngress({bootId:'pb',publicGate})(req,res);req.emit('data',Buffer.from(body));req.emit('end');await new Promise(r=>setTimeout(r,5));return res;}
  assert.equal((await invoke2('POST','/internal/v1/select',{'content-type':'application/json'})).statusCode,404);
  let pres=await invoke2('POST','/select',{'content-type':'application/json','payment-signature':'SIG'},'{"task":"t"}'); assert.equal(pres.statusCode,402);assert.equal(pres.headers['payment-required'],'X');assert.deepEqual(gateCalls,[{body:'{"task":"t"}',header:'SIG'}]);
  assert.equal((await invoke2('GET','/health')).statusCode,200);
  assert.equal((await invoke2('GET','/select')).statusCode,404);
  publicModeDone=true;
  console.log('PASS public mode: gate admission/challenge/decode/duplicate/verify/record/infer/reserve/settle/drain paths, log allowlist, GCS and facilitator wire, ingress branch');
})().catch(e=>{console.error(e);process.exitCode=1;});
const publishFixtures=String.raw`
import importlib.util,pathlib,tempfile,time,os,json
root=pathlib.Path.cwd()
s=importlib.util.spec_from_file_location('h',root/'.claude_workflow/local/run_cloud_run_probe.py'); h=importlib.util.module_from_spec(s); s.loader.exec_module(h)
# Publication refuses while the owner has not confirmed the stop rule (hash-pinned record).
a=json.loads(h.regular(h.PROVIDER_AUTH)); assert a['stop_rule']['owner_confirmed'] is True
orig=h.PROVIDER_AUTH
with tempfile.TemporaryDirectory() as tmp:
    tmp=pathlib.Path(tmp); bad=tmp/'auth.json'; b=dict(a); b['stop_rule']={**a['stop_rule'],'owner_confirmed':False}; bad.write_text(json.dumps(b))
    h.PROVIDER_AUTH=bad
    try: h.provider_authorization()
    except ValueError as e: assert 'not confirmed' in str(e)
    else: raise AssertionError('unconfirmed stop rule accepted')
    h.PROVIDER_AUTH=orig; h.provider_authorization()
    # GPU-on minutes: active or idle > 0 counts; a missing minute counts (conservative); explicit zeros do not.
    from datetime import datetime,timezone
    st=lambda t:datetime.fromtimestamp(t,timezone.utc).isoformat().replace('+00:00','Z')
    base=1_800_000_000
    pts=lambda state,vals:{'metric':{'labels':{'state':state}},'points':[{'interval':{'endTime':st(base+60*i+30)},'value':{'int64Value':str(v)}} for i,v in vals]}
    data={'timeSeries':[pts('active',[(0,1),(1,0),(2,0),(4,0),(5,0)]),pts('idle',[(0,0),(1,1),(2,0),(4,0)])]}
    # minutes 0,1 on; 2 off; 3 missing->on; 4 off; 5 idle missing -> on
    assert h.gpu_seconds_from_series(data,base,base+360)==240, h.gpu_seconds_from_series(data,base,base+360)
    # Public service body: concurrency 2, five env vars, unchanged GPU/scale settings.
    plan={'id':'crp-'+'4'*16,'service':'crp-'+'4'*16,'labels':{},'runtime_sa':'r','nonce_bucket':'subetha-nonce-x'}
    body=h.public_service_body(plan,'img@sha256:'+'a'*64,{'pay_to':'0x'+'1'*40,'disclosure':'d'*90},'https://x.a.run.app')
    t=body['template']; assert t['maxInstanceRequestConcurrency']==2 and body['scaling']=={'minInstanceCount':0,'maxInstanceCount':1}
    env={e['name']:e['value'] for e in t['containers'][0]['env']}; assert set(env)=={'PROVIDER_MODE','PUBLIC_URL','PAY_TO','FACILITATOR_URL','NONCE_BUCKET','DISCLOSURE'} and env['PUBLIC_URL']=='https://x.a.run.app'
    assert t['containers'][0]['resources']['limits']['nvidia.com/gpu']=='1'
    # --stop deletes only the owned service; keeps everything else.
    run=tmp/'run'; run.mkdir(); ident='crp-'+'5'*16
    plan={'id':ident,'project':h.PROJECT,'configuration':h.CONFIG,'region':h.REGION,'service':ident,'repository':ident,'bucket':h.PROJECT+'-'+ident,'build_sa':ident+'-b','runtime_sa':ident+'-r','labels':{'compass-probe':ident},'budget':{'preparation':3,'gpu':2,'contingency':5,'total':10},'nonce_bucket':h.PROJECT+'-nonce-'+ident}
    h.durable(run/'manifest.json',{'plan':plan,'intents':[],'resources':{},'cleanup_deadline':time.time()+10800})
    u=h.urls(plan)
    class C:
        def __init__(self): self.calls=[]; self.gone=False
        def call(self,m,url,body=None,**k):
            self.calls.append((m,url))
            if m=='DELETE': self.gone=True; return {}
            if url==u['service']: return {'_not_found':True} if self.gone else {'labels':{'compass-probe':ident}}
            return {'_not_found':True}
    c=C(); h.stop(run,c,reason='test')
    assert [x for x in c.calls if x[0]=='DELETE']==[('DELETE',u['service'])] and h.read(run/'manifest.json')['phase']=='stopped'
    # cleanup keeps the nonce bucket before the deadline when retained; deletes it after.
    h.durable(run/'manifest.json',{'plan':plan,'intents':[{'resource':'nonce_bucket','status':'returned'}],'resources':{'nonce_bucket':{'intent':True}},'cleanup_deadline':time.time()+10800,'retained':{'delete_on':'2026-10-29'},'build_submitted':False})
    class B:
        def __init__(self): self.calls=[]
        def call(self,m,url,body=None,**k): self.calls.append((m,url)); return {'labels':{'compass-probe':ident},'softDeletePolicy':{'retentionDurationSeconds':'0'}} if m=='GET' and 'nonce' in url and not any(x[0]=='DELETE' for x in self.calls) else ({'_not_found':True} if m=='GET' else {})
    bb=B(); h.cleanup(run,bb); st2=h.read(run/'manifest.json'); assert st2['resources']['nonce_bucket'].get('kept') and not any(x[0]=='DELETE' for x in bb.calls)
    m2=h.read(run/'manifest.json'); m2['cleanup_deadline']=time.time()-1; m2['phase']='x'; h.durable(run/'manifest.json',m2)
    (run/'STOP').unlink(missing_ok=True)
    bb=B(); assert h.cleanup(run,bb) and ('DELETE',u['nonce_bucket']) in bb.calls
    # Reconcile: settling -> settled when consumed, failed when unconsumed and expired, refused otherwise; generation-checked.
    rec={'state':'settling','from':'0x'+'2'*40,'nonce':'0x'+'ab'*32,'validBefore':'100'}
    class R:
        def __init__(self,record): self.record=record; self.calls=[]
        def call(self,m,url,body=None,**k):
            self.calls.append((m,url,body))
            if m=='GET' and url.endswith('?alt=media'): return dict(self.record)
            if m=='GET': return {'generation':'42'}
            return {'generation':'43'}
    h.durable(run/'manifest.json',{'plan':plan,'intents':[],'resources':{},'cleanup_deadline':time.time()+10800})
    k='c'*64
    r=R(rec); assert h.reconcile(run,r,k,consumed=True,now=50)=='settled'; post=[c for c in r.calls if c[0]=='POST'][0]; assert 'ifGenerationMatch=42' in post[1] and post[2]['reconciled'] is True
    r=R(rec); assert h.reconcile(run,r,k,consumed=False,now=200)=='failed'
    r=R(rec)
    try: h.reconcile(run,r,k,consumed=False,now=50)
    except ValueError: pass
    else: raise AssertionError('unexpired unconsumed reconciled')
    assert not any(c[0]=='POST' for c in r.calls)
    r=R({**rec,'state':'settled'})
    try: h.reconcile(run,r,k,consumed=True,now=50)
    except ValueError: pass
    else: raise AssertionError('settled record reconciled')
    # publish_failed: service and bucket deleted with confirmed absence, image kept, retry state restored.
    h.durable(run/'manifest.json',{'plan':plan,'intents':[],'resources':{'service':{'intent':True},'nonce_bucket':{'intent':True}},'cleanup_deadline':time.time()+10800,'phase':'publishing','service_submitted':True})
    class F:
        def __init__(self): self.calls=[]; self.deleted=set()
        def call(self,m,url,body=None,**k):
            self.calls.append((m,url))
            if m=='DELETE': self.deleted.add(url); return {}
            if url in self.deleted: return {'_not_found':True}
            if url.endswith('/o?versions=true&maxResults=1000'): return {'items':[{'name':'nonce/x','generation':'1'}]}
            return {'labels':{'compass-probe':ident}}
    f=F(); assert h.publish_failed(run,f); st3=h.read(run/'manifest.json')
    assert st3['phase']=='prepared' and st3['service_submitted'] is False and u['service'] in f.deleted and u['nonce_bucket'] in f.deleted and not any(u['repository'] in x for x in f.deleted)
    # Publication plan binds the receiving address: changing pay_to after approval invalidates it.
    m0={'plan':plan,'publish':{'pay_to':'0x'+'1'*40,'public_url_placeholder':'https://p.a.run.app','disclosure':'d'*90},'image':'img@sha256:'+'a'*64}
    d1=h.sha(json.dumps(h.publication_plan(m0,'A'),sort_keys=True).encode()); m0['publish']['pay_to']='0x'+'9'*40
    assert d1!=h.sha(json.dumps(h.publication_plan(m0,'A'),sort_keys=True).encode())
    assert d1!=h.sha(json.dumps(h.publication_plan({**m0,'publish':{**m0['publish'],'pay_to':'0x'+'1'*40}},'B'),sort_keys=True).encode())
    # publish() end to end with gates satisfied: a refused service create triggers publish_failed (service+bucket gone, image kept, retry allowed).
    h.durable(run/'manifest.json',{'plan':{**plan,'nonce_bucket':None},'intents':[],'resources':{},'cleanup_deadline':time.time()+10800,'phase':'prepared','service_submitted':False,'image':'img@sha256:'+'a'*64,'build_receipt':{'image':'img@sha256:'+'a'*64},'publish':{'pay_to':'0x'+'1'*40,'public_url_placeholder':'https://p.a.run.app','disclosure':'d'*90}})
    h.durable(run/'build-receipt.json',{'image':'img@sha256:'+'a'*64}); (run/'STOP').unlink(missing_ok=True)
    m4=h.read(run/'manifest.json'); m4['plan'].pop('nonce_bucket'); h.durable(run/'manifest.json',m4)
    real_gates=h.publish_gates; h.publish_gates=lambda run,args:(h.read(run/'manifest.json'),dict(a))
    class P:
        def __init__(self): self.calls=[]; self.deleted=set(); self.created=set()
        def call(self,m,url,body=None,**k):
            self.calls.append((m,url))
            if 'serviceId=' in url: raise RuntimeError('cloud HTTP 429')
            if m=='POST' and url.endswith('/b?project=subetha'): self.created.add('bucket'); return {'name':'b'}
            if m=='DELETE': self.deleted.add(url); return {}
            if url in self.deleted: return {'_not_found':True}
            if url.endswith('/iam'): return {'bindings':[]}
            if 'nonce' in url and 'bucket' in self.created: return {'labels':{'compass-probe':ident},'items':[]}
            return {'_not_found':True}
    pc=P()
    try: h.publish(run,None,pc)
    except RuntimeError: pass
    else: raise AssertionError('refused create swallowed')
    finally: h.publish_gates=real_gates
    st4=h.read(run/'manifest.json'); assert st4['phase']=='prepared' and st4['service_submitted'] is False and st4['publish_attempts']==1 and st4['accounting_start']
    assert any('nonce' in x and x.endswith(ident) for x in pc.deleted) and not any('/repositories/' in x for x in pc.deleted), pc.deleted
    # publish_failed: unconfirmed service deletion keeps the nonce bucket (records of a possibly live service).
    h.durable(run/'manifest.json',{'plan':plan,'intents':[],'resources':{'service':{'intent':True},'nonce_bucket':{'intent':True}},'cleanup_deadline':time.time()+10800,'phase':'publishing','service_submitted':True})
    class Stuck(F):
        def call(self,m,url,body=None,**k):
            if url==u['service'] and m=='GET': self.calls.append((m,url)); return {'labels':{'compass-probe':ident}}
            return super().call(m,url,body,**k)
    real_sleep=h.time.sleep; h.time.sleep=lambda s:None; real_time=h.time.time; tick=[real_time()]
    h.time.time=lambda:tick.__setitem__(0,tick[0]+30) or tick[0]
    try: sf=Stuck(); assert not h.publish_failed(run,sf)
    finally: h.time.sleep=real_sleep; h.time.time=real_time
    st5=h.read(run/'manifest.json'); assert st5['phase']=='publish-cleanup-incomplete' and not any(u['nonce_bucket'] in x for x in sf.deleted) and any('held until service absence' in f for f in st5['publish_failure']['failures'])
    # Real publish_gates rejects a changed receiving address after parent approval (no stubbing of the gate).
    import fcntl
    rd=tmp/'gate-run'; rd.mkdir(); (rd/'context').mkdir(); (rd/'context'/'f.txt').write_text('x')
    hashes=h.context_hash(rd); h.durable(rd/'context-hashes.json',hashes)
    gplan={**plan,'nonce_bucket':None,'budget':h.TRIAL_BUDGET,'context_sha256':h.sha(json.dumps(hashes,sort_keys=True).encode()),'authorization_sha256':h.sha(h.regular(h.AUTH))}; gplan.pop('nonce_bucket')
    ahash=h.sha(h.regular(h.PROVIDER_AUTH))
    gm={'plan':gplan,'intents':[],'resources':{},'cleanup_deadline':time.time()+10800,'feasibility_evidence':{'x':1},'permission_evidence':{'x':1},'provider_authorization_sha256':ahash,'publish':{'pay_to':'0x'+'1'*40,'public_url_placeholder':'https://p.a.run.app','disclosure':a['disclosure_required']},'image':'img@sha256:'+'a'*64}
    gm['parent_approved_publication_sha256']=h.sha(json.dumps(h.publication_plan(gm,ahash),sort_keys=True).encode())
    h.durable(rd/'manifest.json',gm)
    lockf=open(h.ROOT/'.claude_workflow/worker.lock','a+')
    class Args: authorization=str(h.AUTH); baseline_sha256=h.BASELINE; worker_lock_fd=lockf.fileno()
    h.publish_gates(rd,Args())
    gm['publish']['pay_to']='0x'+'9'*40; h.durable(rd/'manifest.json',gm)
    try: h.publish_gates(rd,Args())
    except ValueError as e: assert 'not approved' in str(e), e
    else: raise AssertionError('tampered pay_to accepted by the real gate')
    gm['publish']['pay_to']='0x'+'1'*40; gm['publish']['disclosure']='d'*90; h.durable(rd/'manifest.json',gm)
    try: h.publish_gates(rd,Args())
    except ValueError as e: assert 'disclosure' in str(e), e
    else: raise AssertionError('unapproved disclosure accepted')
    fcntl.flock(lockf,fcntl.LOCK_UN); lockf.close()
assert h.REAL_EXECUTOR_CALLS==0
print('PASS publish gates (owner_confirmed), conservative GPU minutes, public service body, --stop scope, nonce bucket retention; real executor calls=0')
`;
const r5=spawnSync('python3',['-I','-B','-c',publishFixtures],{env,encoding:'utf8',timeout:60000});process.stdout.write(r5.stdout||'');process.stderr.write(r5.stderr||'');assert.equal(r5.status,0,'publish fixtures');
