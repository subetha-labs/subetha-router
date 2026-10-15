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
