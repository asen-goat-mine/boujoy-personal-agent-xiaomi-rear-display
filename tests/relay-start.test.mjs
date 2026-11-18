import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sourceDir=fileURLToPath(new URL('../deploy/relay/',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const routesFor=value=>JSON.stringify({'synthetic-device':{macTokenHash:sha('mac-'+value),androidTokenHash:sha('android-'+value)}})+'\n';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-relay-start-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // Exercise real shell quoting and dotenv-safe relative paths in an awkward release path.
  const release=path.join(root,"release $unset #1 'quoted'"),dir=path.join(release,'deploy/relay'),bin=path.join(root,'bin');
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(bin);
  for(const name of ['start.sh','compose.yaml','Caddyfile','Caddyfile.ip'])fs.copyFileSync(path.join(sourceDir,name),path.join(dir,name));
  const routes=path.join(root,"source routes $token 'hashes'.json");fs.writeFileSync(routes,routesFor('first'),{mode:0o600});
  const dockerScript=path.join(root,'docker-fixture.mjs'),log=path.join(root,'docker-calls.jsonl');
  // This executable records actual start.sh invocations and models only dotenv
  // precedence. It is deliberately not a Docker/Compose/container implementation.
  fs.writeFileSync(dockerScript,`import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),cwd=process.cwd(),dotenv={},explicitEnv=args[1]==='--env-file',envFile=explicitEnv?args[2]:'.env',command=args.slice(explicitEnv?3:1);
if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').trim().split('\\n')){const at=line.indexOf('=');if(at>0)dotenv[line.slice(0,at)]=line.slice(at+1);}
const config=Object.fromEntries(['COMPOSE_PROJECT_NAME','BOUJOY_RELAY_DOMAIN','BOUJOY_RELAY_ROUTES_FILE','BOUJOY_RELAY_CADDYFILE'].map(key=>[key,process.env[key]??dotenv[key]]));
if(args[0]!=='compose'||config.COMPOSE_PROJECT_NAME!=='boujoy-relay'||!config.BOUJOY_RELAY_DOMAIN||!config.BOUJOY_RELAY_ROUTES_FILE?.startsWith('./config/')||!['./Caddyfile','./Caddyfile.ip'].includes(config.BOUJOY_RELAY_CADDYFILE))process.exit(31);
const routePath=path.resolve(cwd,config.BOUJOY_RELAY_ROUTES_FILE);
fs.appendFileSync(process.env.BOUJOY_FIXTURE_LOG,JSON.stringify({args,command,envFile,cwd,config,caddyfile:fs.readFileSync(config.BOUJOY_RELAY_CADDYFILE,'utf8'),routes:fs.readFileSync(routePath,'utf8'),envMode:fs.statSync(envFile).mode&511,routeMode:fs.statSync(routePath).mode&511})+'\\n');
if(command[0]==='config'&&process.env.BOUJOY_FIXTURE_FAIL_CONFIG==='1')process.exit(42);
if(command[0]==='up'&&process.env.BOUJOY_FIXTURE_FAIL_UP==='1')process.exit(43);
`);
  fs.writeFileSync(path.join(bin,'docker'),'#!/bin/sh\nexec "$BOUJOY_FIXTURE_NODE" "$BOUJOY_FIXTURE_DOCKER" "$@"\n',{mode:0o755});
  const env={PATH:bin+':/usr/bin:/bin:/usr/sbin:/sbin',BOUJOY_FIXTURE_NODE:process.execPath,BOUJOY_FIXTURE_DOCKER:dockerScript,BOUJOY_FIXTURE_LOG:log};
  return {root,release,dir,bin,routes,env,log,
    start:(domain='relay.example.com',routeFile=routes,overrides={})=>spawnSync('/bin/sh',[path.join(dir,'start.sh'),domain,routeFile],{cwd:root,env:{...env,...overrides},encoding:'utf8'}),
    calls:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],
  };
}

test('start.sh persists a private stable Compose configuration usable by fresh ps/logs/restart processes',t=>{
  const f=fixture(t),result=f.start('relay.example.com',f.routes,{COMPOSE_PROJECT_NAME:'unrelated-export',BOUJOY_RELAY_DOMAIN:'wrong.example.com',BOUJOY_RELAY_ROUTES_FILE:'/wrong/file',BOUJOY_RELAY_CADDYFILE:'/wrong/Caddyfile'});
  assert.equal(result.status,0,result.stderr);
  const envText=fs.readFileSync(path.join(f.dir,'.env'),'utf8');
  assert.equal(envText,'COMPOSE_PROJECT_NAME=boujoy-relay\nBOUJOY_RELAY_DOMAIN=relay.example.com\nBOUJOY_RELAY_ROUTES_FILE=./config/routes.json\nBOUJOY_RELAY_CADDYFILE=./Caddyfile\n');
  assert.equal(fs.statSync(path.join(f.dir,'.env')).mode&0o777,0o600);
  assert.equal(fs.statSync(path.join(f.dir,'config')).mode&0o777,0o700);
  assert.equal(fs.statSync(path.join(f.dir,'config/routes.json')).mode&0o777,0o444);
  assert.equal(fs.readFileSync(path.join(f.dir,'config/routes.json'),'utf8'),routesFor('first'));
  assert.equal(envText.includes(f.routes),false);assert.equal(envText.includes('mac-first'),false);
  assert.deepEqual(f.calls().map(c=>c.command),[['config','--quiet'],['up','--build','--force-recreate','-d']]);
  assert.equal(f.calls()[0].args[1],'--env-file');assert.match(f.calls()[0].envFile,/^\.env\./);
  for(const command of [['ps'],['logs','--tail','20'],['restart']]){
    // New processes have no project/domain/routes environment from start.sh.
    const next=spawnSync(path.join(f.bin,'docker'),['compose',...command],{cwd:f.dir,env:f.env,encoding:'utf8'});
    assert.equal(next.status,0,next.stderr);
  }
  const calls=f.calls();assert.equal(calls.length,5);
  for(const call of calls){assert.equal(call.config.COMPOSE_PROJECT_NAME,'boujoy-relay');assert.equal(call.config.BOUJOY_RELAY_DOMAIN,'relay.example.com');assert.equal(call.config.BOUJOY_RELAY_CADDYFILE,'./Caddyfile');assert.equal(call.routes,routesFor('first'));assert.equal(call.envMode,0o600);assert.equal(call.routeMode,0o444);}
  assert.match(calls[0].config.BOUJOY_RELAY_ROUTES_FILE,/^\.\/config\/\.routes\./);
  assert(calls.slice(1).every(call=>call.config.BOUJOY_RELAY_ROUTES_FILE==='./config/routes.json'));
  assert.equal((result.stdout+result.stderr).includes('mac-first'),false);
});

test('start.sh can replace an existing read-only route table and preserves the fixed project across release directories',t=>{
  const f=fixture(t);assert.equal(f.start().status,0);
  const oldInode=fs.statSync(path.join(f.dir,'config/routes.json')).ino;
  fs.writeFileSync(f.routes,routesFor('second'));
  const result=f.start('new-relay.example.com');assert.equal(result.status,0,result.stderr);
  const latest=f.calls().slice(-2);assert(latest.every(c=>c.routes===routesFor('second')));
  assert(latest.every(c=>c.config.BOUJOY_RELAY_DOMAIN==='new-relay.example.com'));
  assert.notEqual(fs.statSync(path.join(f.dir,'config/routes.json')).ino,oldInode);
  assert.equal(fs.statSync(path.join(f.dir,'.env')).mode&0o777,0o600);
  assert.deepEqual(fs.readdirSync(path.join(f.dir,'config')),['routes.json']);
  assert.equal(fs.readdirSync(f.dir).some(n=>n.startsWith('.env.')),false);
  const second=fixture(t);assert.equal(second.start().status,0);
  assert.notEqual(f.release,second.release);
  assert.equal(f.calls().at(-1).config.COMPOSE_PROJECT_NAME,second.calls().at(-1).config.COMPOSE_PROJECT_NAME);
});

test('invalid domains and route paths fail before invoking Docker or persisting configuration',t=>{
  const f=fixture(t);
  for(const domain of ['', 'localhost','192.168.5.116','-relay.example.com','relay-.example.com','relay..example.com','relay.example.com.','https://relay.example.com','relay.example.com\nOTHER=bad','relay.$(false).com','x'.repeat(64)+'.example.com']){
    const result=f.start(domain);assert.equal(result.status,2,domain+': '+result.stderr);
  }
  assert.equal(f.start('relay.example.com','relative-routes.json').status,2);
  assert.equal(f.start('relay.example.com',path.join(f.root,'missing')).status,2);
  assert.deepEqual(f.calls(),[]);assert.equal(fs.existsSync(path.join(f.dir,'.env')),false);
});

test('symlink deployment targets and non-file .env are refused without touching their targets',t=>{
  for(const kind of ['config','.env','config/routes.json','env-directory']){
    const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);
    const marker=path.join(outside,'marker');fs.writeFileSync(marker,'unchanged');
    if(kind==='config')fs.symlinkSync(outside,path.join(f.dir,'config'));
    else if(kind==='.env')fs.symlinkSync(marker,path.join(f.dir,'.env'));
    else if(kind==='env-directory')fs.mkdirSync(path.join(f.dir,'.env'));
    else{fs.mkdirSync(path.join(f.dir,'config'));fs.symlinkSync(marker,path.join(f.dir,'config/routes.json'));}
    const result=f.start();assert.equal(result.status,2,kind+': '+result.stderr);
    assert.deepEqual(f.calls(),[]);assert.equal(fs.readFileSync(marker,'utf8'),'unchanged');
  }
});

test('Compose validation failure never launches containers and leaves no temporary configuration files',t=>{
  const f=fixture(t),result=f.start('relay.example.com',f.routes,{BOUJOY_FIXTURE_FAIL_CONFIG:'1'});
  assert.equal(result.status,42,result.stderr);
  assert.deepEqual(f.calls().map(c=>c.command),[['config','--quiet']]);
  assert.equal(fs.existsSync(path.join(f.dir,'.env')),false);
  assert.deepEqual(fs.readdirSync(path.join(f.dir,'config')),[]);
  assert.equal(fs.readdirSync(f.dir).some(n=>n.startsWith('.env.')),false);
});

test('failed upgrade preflight preserves the previous domain, route bytes and file identities',t=>{
  const f=fixture(t);assert.equal(f.start().status,0);
  const previousEnv=fs.readFileSync(path.join(f.dir,'.env')),previousRoutes=fs.readFileSync(path.join(f.dir,'config/routes.json'));
  const envInode=fs.statSync(path.join(f.dir,'.env')).ino,routeInode=fs.statSync(path.join(f.dir,'config/routes.json')).ino;
  fs.writeFileSync(f.routes,routesFor('new-authorization'));
  const result=f.start('8.8.4.4',f.routes,{BOUJOY_FIXTURE_FAIL_CONFIG:'1'});assert.equal(result.status,42,result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'.env')),previousEnv);assert.deepEqual(fs.readFileSync(path.join(f.dir,'config/routes.json')),previousRoutes);
  assert.equal(fs.statSync(path.join(f.dir,'.env')).ino,envInode);assert.equal(fs.statSync(path.join(f.dir,'config/routes.json')).ino,routeInode);
  assert.equal(f.calls().length,3);assert.deepEqual(f.calls().at(-1).command,['config','--quiet']);
  assert.equal(f.calls().at(-1).config.BOUJOY_RELAY_DOMAIN,'8.8.4.4');assert.equal(f.calls().at(-1).routes,routesFor('new-authorization'));
  assert.deepEqual(fs.readdirSync(path.join(f.dir,'config')),['routes.json']);assert.equal(fs.readdirSync(f.dir).some(n=>n.startsWith('.env.')),false);
});

test('failed container startup returns its failure and accurately reports committed config without claiming rollback',t=>{
  const f=fixture(t),result=f.start('relay.example.com',f.routes,{BOUJOY_FIXTURE_FAIL_UP:'1'});
  assert.equal(result.status,43);assert.match(result.stderr,/startup failed after committing configuration; no automatic rollback/);
  assert.equal(result.stdout.includes('Relay configured'),false);
  assert.equal(fs.statSync(path.join(f.dir,'.env')).mode&0o777,0o600);
  assert.equal(fs.readFileSync(path.join(f.dir,'config/routes.json'),'utf8'),routesFor('first'));
  assert.deepEqual(f.calls().map(c=>c.command),[['config','--quiet'],['up','--build','--force-recreate','-d']]);
});

test('public IPv4 selects and persists explicit public-ACME configuration including no-SNI fallback',t=>{
  const f=fixture(t),result=f.start('8.8.4.4');assert.equal(result.status,0,result.stderr);
  const [config,up]=f.calls();
  assert.equal(config.config.BOUJOY_RELAY_DOMAIN,'8.8.4.4');
  assert.equal(config.config.BOUJOY_RELAY_CADDYFILE,'./Caddyfile.ip');
  assert.match(config.caddyfile,/default_sni \{\$BOUJOY_RELAY_DOMAIN\}/);
  assert.match(config.caddyfile,/issuer acme\s*\{\s*dir https:\/\/acme-v02\.api\.letsencrypt\.org\/directory\s+profile shortlived\s*\}/);
  assert.doesNotMatch(config.caddyfile,/tls internal|local_certs|skip_verify|staging/);
  assert.deepEqual(up.args,['compose','up','--build','--force-recreate','-d']);
  const restart=spawnSync(path.join(f.bin,'docker'),['compose','restart'],{cwd:f.dir,env:f.env,encoding:'utf8'});assert.equal(restart.status,0,restart.stderr);
  assert.deepEqual(f.calls().at(-1).config,up.config);
  assert.equal(f.start('relay.example.com').status,0);
  assert.equal(f.calls().at(-1).config.BOUJOY_RELAY_CADDYFILE,'./Caddyfile');
  assert.equal(f.calls().at(-1).config.COMPOSE_PROJECT_NAME,config.config.COMPOSE_PROJECT_NAME);
});

test('IPv4 branch rejects private, shared, reserved, malformed and alternate encodings before Docker',t=>{
  const f=fixture(t);
  for(const address of ['0.0.0.0','0.1.2.3','10.0.0.1','100.64.0.1','100.127.255.254','127.0.0.1','169.254.1.1','172.16.0.1','172.31.255.254','192.0.0.9','192.0.2.1','192.88.99.1','192.168.5.116','198.18.0.1','198.19.255.254','198.51.100.1','203.0.113.1','224.0.0.1','239.255.255.255','240.0.0.1','255.255.255.255','256.1.2.3','8.8.8','8.8.8.8.8','008.8.8.8','8.08.8.8','134744072','0x08080808','0x7f.0.0.1','8.8.8.0x8','8.8.8.8:443','8.8.8.8/32','[2606:4700:4700::1111]']){
    const result=f.start(address);assert.equal(result.status,2,address+': '+result.stderr);
  }
  assert.deepEqual(f.calls(),[]);assert.equal(fs.existsSync(path.join(f.dir,'.env')),false);
});

test('Compose pins the IP-certificate capable Caddy and preserves config selection plus certificate volumes',()=>{
  const compose=fs.readFileSync(path.join(sourceDir,'compose.yaml'),'utf8');
  assert.match(compose,/image: caddy:2\.11\.7-alpine\s/);
  assert.match(compose,/\$\{BOUJOY_RELAY_CADDYFILE:-\.\/Caddyfile\}:\/etc\/caddy\/Caddyfile:ro/);
  assert.match(compose,/- caddy_data:\/data/);assert.match(compose,/- caddy_config:\/config/);
  const ip=fs.readFileSync(path.join(sourceDir,'Caddyfile.ip'),'utf8'),domain=fs.readFileSync(path.join(sourceDir,'Caddyfile'),'utf8');
  const routes=value=>value.split('\n').map(line=>line.trim()).filter(line=>/^@tunnel |^reverse_proxy |^respond /.test(line));
  assert.deepEqual(routes(ip),routes(domain));
});

test('both Caddy entrypoints keep the 404 fallback inside the same ordered route after both proxies',()=>{
  // Caddy normally sorts respond before reverse_proxy. Matching text order at
  // site level therefore passed the old test while every public URL got 404.
  // Require the handlers to share an explicit route block, whose order Caddy
  // preserves. This is a source guard; real Caddy adapt and HTTPS remain live
  // deployment checks, not something the shell/Docker recorder simulates.
  const verify=value=>{
    const stack=[],handlers=[];
    for(const raw of value.split('\n')){
      const line=raw.trim();if(!line||line.startsWith('#'))continue;
      if(line==='}'){stack.pop();continue;}
      if(line.endsWith('{')){stack.push({name:line.slice(0,-1).trim()});continue;}
      if(/^(reverse_proxy|respond)\s/.test(line))handlers.push({line,block:stack.at(-1)});
    }
    assert.deepEqual(handlers.map(item=>item.line),['reverse_proxy @tunnel relay:18843','reverse_proxy /healthz relay:18843','respond 404']);
    assert.equal(handlers[0].block?.name,'route','proxy and fallback must bypass Caddy directive sorting');
    assert(handlers.every(item=>item.block===handlers[0].block),'handlers must share one ordered route');
  };
  for(const name of ['Caddyfile','Caddyfile.ip'])verify(fs.readFileSync(path.join(sourceDir,name),'utf8'));
  assert.throws(()=>verify('relay.example.com {\n@tunnel path /v1/tunnel\nreverse_proxy @tunnel relay:18843\nreverse_proxy /healthz relay:18843\nrespond 404\n}'),/directive sorting/);
});
