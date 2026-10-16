import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { isAbsolute, join, dirname } from 'node:path';

const dispatcher=readFileSync(new URL('../.github/workflows/cannele-onboarding.yml',import.meta.url),'utf8');
const runner=readFileSync(new URL('../.github/workflows/cannele-onboarding-run.yml',import.meta.url),'utf8');
function inline(marker:string):Script {
  const start=runner.indexOf(`node --input-type=module <<'${marker}'\n`),end=runner.indexOf(`\n          ${marker}`,start);
  assert.ok(start>0&&end>start);const source=runner.slice(start+`node --input-type=module <<'${marker}'\n`.length,end);
  assert.doesNotMatch(source,/\$\{\{/);return new Script(source.split('\n').filter(line=>!line.trimStart().startsWith('import ')).join('\n'));
}
const validator=inline('CANNELE_ONBOARDING_INPUT_JS'),prepare=inline('CANNELE_ONBOARDING_SOURCE_JS');
const revision='a'.repeat(40),sourceRevision='c'.repeat(40),requestId='00000000-0000-4000-8000-000000000042';
const config={protocol:'cake-cannele-onboarding/v1',canneleSourceRevision:sourceRevision};
function validate(overrides:Record<string,string|undefined>={},options:{config?:unknown;symlink?:boolean;dirty?:boolean;mode?:string;committed?:string}={}) {
  const env={GITHUB_SHA:revision,RUNNER_TEMP:'/runner/_temp',GITHUB_OUTPUT:'/runner/output',CANNELE_ONBOARDING_ACTION:'inspect',
    CANNELE_ONBOARDING_EXPECTED_REVISION:revision,CANNELE_ONBOARDING_REQUEST_ID:requestId,CANNELE_ONBOARDING_TRANSITION_JSON:'',
    CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:'',CANNELE_ONBOARDING_RUNTIME_ROLE_NAME:'',CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'false',...overrides};
  const bytes=Buffer.from(JSON.stringify(options.config??config));const outputs:string[]=[];
  validator.runInNewContext({process:{env},Buffer,isAbsolute,join,
    lstatSync:()=>({isFile:()=>!options.symlink,isSymbolicLink:()=>Boolean(options.symlink),nlink:1,size:bytes.length}),readFileSync:()=>bytes,
    appendFileSync:(_path:string,value:string)=>outputs.push(value),
    execFileSync:(command:string,args:string[])=>{
      assert.equal(command,'git');if(args[0]==='rev-parse')return `${revision}\n`;
      if(args[0]==='status')return options.dirty?' M cannele-onboarding.config.json':'';
      if(args[0]==='ls-tree')return `${options.mode??'100644'} blob ${'d'.repeat(40)}\tcannele-onboarding.config.json\n`;
      if(args[0]==='show')return options.committed?Buffer.from(options.committed):bytes;
      throw new Error('Unexpected fixture git operation');
    },
  });return outputs.join('');
}
const transition=()=>JSON.stringify({source:{cakeRevision:revision,canneleRevision:sourceRevision},admission:{oldProviderCreationCredentialsRevoked:true}});
const activationContext=()=>({instanceId:'00000000-0000-4000-8000-000000000043',repositoryId:1318171856,bindingDigest:'d'.repeat(64),
  writerEpoch:1,schemaVersion:4,schemaChecksum:'e'.repeat(64)});

test('owner/main first-attempt dispatcher binds a same-commit reusable helper with only read permissions',()=>{
  assert.match(dispatcher,/options: \[inspect, transition, bootstrap-runtime, provision-runtime, activate-runtime\]/);
  assert.deepEqual([...dispatcher.matchAll(/^      ([a-z_]+):$/gm)].map(match=>match[1]),
    ['action','reviewed_revision','request_id','transition_json','runtime_context_json','runtime_role_name','confirm_credential_drain']);
  assert.match(dispatcher,/confirm_credential_drain:[\s\S]*?required: true\s+default: false\s+type: boolean/);
  for(const source of [dispatcher,runner])assert.match(source,/description: Old actors stopped[^\n]*old management DB\/owner credentials[^\n]*provider policy in transition JSON/);
  for(const source of [dispatcher,runner]) {
    assert.match(source,/github\.event_name == 'workflow_dispatch'/);assert.match(source,/github\.repository == 'tyask\/Cake'/);
    assert.match(source,/github\.ref == 'refs\/heads\/main'/);assert.match(source,/github\.actor == github\.repository_owner/);
    assert.match(source,/github\.run_attempt == '1'/);assert.match(source,/inputs\.reviewed_revision == github\.sha/);
    assert.match(source,/permissions:\s+contents: read\s+actions: read\s+pull-requests: read/);
    assert.doesNotMatch(source,/^\s+environment:|secrets: inherit|id-token:|contents: write|actions: write|pull_request:|schedule:|cron:/m);
  }
  assert.match(dispatcher,/secrets\.CANNELE_TRANSITION_VERCEL_TOKEN/);assert.match(dispatcher,/secrets\.CANNELE_TRANSITION_NEON_API_KEY/);
  assert.doesNotMatch([dispatcher,runner].join('\n'),/secrets\.VERCEL_TOKEN\b|secrets\.NEON_API_KEY\b/);
  const readiness=readFileSync(new URL('../.github/workflows/cannele-readiness.yml',import.meta.url),'utf8');
  assert.match(readiness,/secrets\.CANNELE_REGISTRY_ADMIN_DATABASE_URL/);
  assert.match(readiness,/secrets\.CANNELE_REGISTRY_ADMIN_DATABASE_HOST/);
  assert.match(readiness,/secrets\.CANNELE_TRANSITION_VERCEL_TOKEN/);
  assert.match(readiness,/secrets\.CANNELE_TRANSITION_NEON_API_KEY/);
  assert.doesNotMatch(readiness,/secrets\.(?:CAKE_QA_REGISTRY_DATABASE_(?:URL|HOST)|VERCEL_TOKEN\b|NEON_API_KEY\b)/);
  assert.match(dispatcher,/uses: \.\/\.github\/workflows\/cannele-onboarding-run\.yml/);
  assert.match(runner,/repository: tyask\/Cake\s+ref: \$\{\{ github\.sha \}\}\s+fetch-depth: 0\s+persist-credentials: false/);
});

test('actual input validator binds action, UUID, immutable regular config blob, and reviewed source revisions',()=>{
  assert.match(validate(),new RegExp(`source_revision=${sourceRevision}`));
  assert.doesNotThrow(()=>validate({CANNELE_ONBOARDING_ACTION:'transition',CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'true',CANNELE_ONBOARDING_TRANSITION_JSON:transition()}));
  assert.doesNotThrow(()=>validate({CANNELE_ONBOARDING_ACTION:'transition',CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'true',
    CANNELE_ONBOARDING_TRANSITION_JSON:JSON.stringify({source:{cakeRevision:'f'.repeat(40),canneleRevision:sourceRevision}})}));
  assert.doesNotThrow(()=>validate({CANNELE_ONBOARDING_ACTION:'provision-runtime',CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:'{"schemaVersion":4}',CANNELE_ONBOARDING_RUNTIME_ROLE_NAME:'cannele_runtime'}));
  for(const env of [
    {CANNELE_ONBOARDING_ACTION:'create-role'}, {CANNELE_ONBOARDING_EXPECTED_REVISION:'main'}, {CANNELE_ONBOARDING_REQUEST_ID:'../private'},
    {CANNELE_ONBOARDING_ACTION:'transition',CANNELE_ONBOARDING_TRANSITION_JSON:transition()},
    {CANNELE_ONBOARDING_ACTION:'transition',CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'true',CANNELE_ONBOARDING_TRANSITION_JSON:'[]'},
    {CANNELE_ONBOARDING_ACTION:'transition',CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'true',CANNELE_ONBOARDING_TRANSITION_JSON:'{"password":"do-not-log"}'},
    {CANNELE_ONBOARDING_ACTION:'transition',CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'true',CANNELE_ONBOARDING_TRANSITION_JSON:'{"origin":"https://caller.invalid"}'},
    {CANNELE_ONBOARDING_ACTION:'transition',CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'true',CANNELE_ONBOARDING_TRANSITION_JSON:JSON.stringify({source:{cakeRevision:revision,canneleRevision:'b'.repeat(40)}})},
    {CANNELE_ONBOARDING_ACTION:'provision-runtime',CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:'{}',CANNELE_ONBOARDING_RUNTIME_ROLE_NAME:'admin; DROP ROLE'},
  ])assert.throws(()=>validate(env),/public inputs or source pin are invalid/);
  for(const options of [{symlink:true},{dirty:true},{mode:'120000'},{committed:'different'},{config:{...config,canneleSourceRevision:'main'}},{config:{...config,origin:'https://caller.invalid'}}])
    assert.throws(()=>validate({},options),/public inputs or source pin are invalid/);
  assert.equal(validate().includes('do-not-log'),false);
});

test('bootstrap accepts only the existing reviewed context and role inputs, without transition or credential payloads',()=>{
  const context=JSON.stringify({instanceId:'00000000-0000-4000-8000-000000000043',repositoryId:1318171856,bindingDigest:'d'.repeat(64),
    writerEpoch:1,schemaVersion:4,schemaChecksum:'e'.repeat(64)});
  const bootstrap={CANNELE_ONBOARDING_ACTION:'bootstrap-runtime',CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:context,CANNELE_ONBOARDING_RUNTIME_ROLE_NAME:'cannele_runtime'};
  assert.doesNotThrow(()=>validate(bootstrap));
  for(const changes of [
    {CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'true'}, {CANNELE_ONBOARDING_TRANSITION_JSON:transition()},
    {CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:''}, {CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:'[]'},
    {CANNELE_ONBOARDING_RUNTIME_ROLE_NAME:''}, {CANNELE_ONBOARDING_RUNTIME_ROLE_NAME:'runtime; ALTER ROLE owner'},
    {CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:'{"databaseUrl":"postgresql://private:password@private/db"}'},
    {CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:'{"apiOrigin":"https://foreign.invalid"}'},
    {CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:'{"token":"private-token"}'},
  ])assert.throws(()=>validate({...bootstrap,...changes}),/public inputs or source pin are invalid/);
  assert.doesNotMatch(validate(bootstrap),/databaseUrl|password|private-token|https:\/\//);
});

test('activation accepts exactly the reviewed six-field context without role, transition, or drain confirmation',()=>{
  const context=activationContext(),activation={CANNELE_ONBOARDING_ACTION:'activate-runtime',CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:JSON.stringify(context)};
  assert.doesNotThrow(()=>validate(activation));
  for(const changes of [
    {CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:'true'}, {CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN:''},
    {CANNELE_ONBOARDING_TRANSITION_JSON:transition()}, {CANNELE_ONBOARDING_RUNTIME_ROLE_NAME:'cannele_runtime'},
    ...['','[]','null','"context"'].map(value=>({CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:value})),
  ])assert.throws(()=>validate({...activation,...changes}),/public inputs or source pin are invalid/);
  for(const key of Object.keys(context)) {
    const missing:Record<string,unknown>={...context};delete missing[key];
    assert.throws(()=>validate({...activation,CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:JSON.stringify(missing)}),/public inputs or source pin are invalid/);
  }
  for(const changes of [
    {instanceId:'not-a-uuid'}, {instanceId:42}, {repositoryId:1318171857}, {repositoryId:'1318171856'},
    {writerEpoch:0}, {writerEpoch:2}, {writerEpoch:'1'}, {schemaVersion:3}, {schemaVersion:'4'},
    {bindingDigest:'D'.repeat(64)}, {bindingDigest:'d'.repeat(63)}, {bindingDigest:[]},
    {schemaChecksum:'e'.repeat(65)}, {schemaChecksum:null}, {transitionId:requestId}, {roleName:'cannele_runtime'},
    {databaseUrl:'postgresql://private:password@private/db'}, {apiOrigin:'https://foreign.invalid'}, {token:'private-token'},
  ])assert.throws(()=>validate({...activation,CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON:JSON.stringify({...context,...changes})}),/public inputs or source pin are invalid/);
  assert.doesNotMatch(validate(activation),/databaseUrl|password|private-token|https:\/\/|bindingDigest|schemaChecksum/);
});

test('activation evaluates only administrator Secret mappings at the dispatcher boundary',()=>{
  const secretMappings=dispatcher.slice(dispatcher.indexOf('    secrets:'));
  const expressions=[...secretMappings.matchAll(/^      ([a-z_]+): \$\{\{ ([^\n]+) \}\}$/gm)];
  assert.deepEqual(expressions.map(match=>match[1]),['admin_database_url','admin_database_host','runtime_database_url','runtime_database_host',
    'bootstrap_vercel_token','transition_vercel_token','transition_neon_api_key']);
  const reads:string[]=[],secrets=Object.create(null);
  for(const name of ['CANNELE_REGISTRY_ADMIN_DATABASE_URL','CANNELE_REGISTRY_ADMIN_DATABASE_HOST','CANNELE_REGISTRY_DATABASE_URL',
    'CANNELE_REGISTRY_DATABASE_HOST','CANNELE_BOOTSTRAP_VERCEL_TOKEN','CANNELE_TRANSITION_VERCEL_TOKEN','CANNELE_TRANSITION_NEON_API_KEY'])
    Object.defineProperty(secrets,name,{get:()=>{reads.push(name);return `fixture-${name}`;}});
  const values=Object.fromEntries(expressions.map(([,name,expression])=>[name,new Script(`(${expression})`).runInNewContext({inputs:{action:'activate-runtime'},secrets})]));
  assert.deepEqual(reads,['CANNELE_REGISTRY_ADMIN_DATABASE_URL','CANNELE_REGISTRY_ADMIN_DATABASE_HOST']);
  assert.deepEqual(values,{admin_database_url:'fixture-CANNELE_REGISTRY_ADMIN_DATABASE_URL',admin_database_host:'fixture-CANNELE_REGISTRY_ADMIN_DATABASE_HOST',
    runtime_database_url:'',runtime_database_host:'',bootstrap_vercel_token:'',transition_vercel_token:'',transition_neon_api_key:''});
});

test('the separate API-project management Secret is evaluated only for bootstrap-runtime',()=>{
  const expression=dispatcher.match(/bootstrap_vercel_token: \$\{\{ ([^\n]+) \}\}/)?.[1];assert.ok(expression);
  const mapping=new Script(`(${expression})`);
  for(const action of ['inspect','transition','bootstrap-runtime','provision-runtime','activate-runtime','unknown']){
    let reads=0;
    const secrets=Object.create(null,{CANNELE_BOOTSTRAP_VERCEL_TOKEN:{get:()=>{reads++;return'fixture-api-project-management-token';}}});
    const value=mapping.runInNewContext({inputs:{action},secrets});
    assert.equal(value,action==='bootstrap-runtime'?'fixture-api-project-management-token':'');
    assert.equal(reads,action==='bootstrap-runtime'?1:0);
  }
  assert.match(runner,/bootstrap_vercel_token:\s+required: false/);
});

test('actual source preparation clones only the fixed public repository and rejects unmerged, dirty, or mismatched pins',()=>{
  function execute(mode='ok'){
    const calls:string[][]=[];const source='/runner/_temp/cannele-onboarding-source/'+requestId;
    prepare.runInNewContext({process:{env:{CANNELE_ONBOARDING_SOURCE_DIR:source,CANNELE_ONBOARDING_SOURCE_REVISION:sourceRevision}},dirname,
      existsSync:()=>mode==='exists',mkdirSync:()=>{},execFileSync:(command:string,args:string[],options:{env:Record<string,string>})=>{
        assert.equal(command,'git');calls.push(args);assert.equal(options.env.GIT_TERMINAL_PROMPT,'0');
        if(args.includes('merge-base')&&mode==='unmerged')throw new Error('private git diagnostics');
        if(args.includes('rev-parse'))return mode==='wrong'?'b'.repeat(40):sourceRevision;
        if(args.includes('status'))return mode==='dirty'?' M unknown-file':'';return '';
      }});return calls;
  }
  const calls=execute();assert.ok(calls[0]!.includes('https://github.com/tyask/cannele.git'));assert.ok(calls[0]!.includes('credential.helper='));
  assert.equal(calls[0]!.includes('--depth'),false);assert.deepEqual([...calls[1]!.slice(-4)],['merge-base','--is-ancestor',sourceRevision,'origin/main']);
  for(const mode of ['exists','unmerged','wrong','dirty'])assert.throws(()=>execute(mode),/Exact merged Cannele source could not be prepared/);
});

test('dependency installation and generated contracts precede Secrets; provider/runtime credentials are action-specific',()=>{
  const adminStart=runner.indexOf('      - name: Inspect the fenced registry');const prefix=runner.slice(runner.indexOf('    steps:'),adminStart);
  assert.doesNotMatch(prefix,/secrets\.|GITHUB_TOKEN|VERCEL_TOKEN|NEON_API_KEY|CANNELE_REGISTRY_(?:ADMIN_)?DATABASE_/);
  assert.match(prefix,/Install reviewed Cake dependencies[\s\S]*?run: npm ci/);
  assert.match(prefix,/Install pinned Cannele dependencies[\s\S]*?working-directory: \$\{\{ steps\.public\.outputs\.source_dir \}\}\s+run: npm ci/);
  assert.match(prefix,/Generate pinned Cannele contracts[\s\S]*?run: node --import tsx scripts\/generate-contracts\.ts/);
  const transitionStart=runner.indexOf('      - name: Run the explicitly confirmed'),bootstrapStart=runner.indexOf('      - name: Create and verify runtime access'),
    runtimeStart=runner.indexOf('      - name: Grant and verify'),activationStart=runner.indexOf('      - name: Activate the reviewed runtime writer'),uploadStart=runner.indexOf('      - name: Upload strict');
  assert.ok(transitionStart<bootstrapStart&&bootstrapStart<runtimeStart&&runtimeStart<activationStart&&activationStart<uploadStart);
  const inspect=runner.slice(adminStart,transitionStart),transitionStep=runner.slice(transitionStart,bootstrapStart),bootstrap=runner.slice(bootstrapStart,runtimeStart),
    runtime=runner.slice(runtimeStart,activationStart),activation=runner.slice(activationStart,uploadStart);
  assert.doesNotMatch(inspect,/secrets\.transition_vercel_token|secrets\.transition_neon_api_key|secrets\.runtime_database/);
  assert.match(transitionStep,/if: inputs\.action == 'transition'/);assert.match(transitionStep,/CANNELE_TRANSITION_VERCEL_TOKEN: \$\{\{ secrets\.transition_vercel_token \}\}/);
  assert.match(transitionStep,/CANNELE_TRANSITION_NEON_API_KEY: \$\{\{ secrets\.transition_neon_api_key \}\}/);assert.doesNotMatch(transitionStep,/secrets\.runtime_database/);
  assert.match(runtime,/if: inputs\.action == 'provision-runtime'/);assert.match(runtime,/CANNELE_REGISTRY_DATABASE_URL: \$\{\{ secrets\.runtime_database_url \}\}/);
  assert.doesNotMatch(runtime,/secrets\.transition_vercel_token|secrets\.transition_neon_api_key/);
  assert.match(bootstrap,/if: inputs\.action == 'bootstrap-runtime'/);
  assert.match(bootstrap,/CANNELE_BOOTSTRAP_VERCEL_TOKEN: \$\{\{ secrets\.bootstrap_vercel_token \}\}/);
  assert.match(bootstrap,/CANNELE_TRANSITION_VERCEL_TOKEN: \$\{\{ secrets\.transition_vercel_token \}\}/);
  assert.match(bootstrap,/CANNELE_TRANSITION_NEON_API_KEY: \$\{\{ secrets\.transition_neon_api_key \}\}/);
  assert.doesNotMatch(bootstrap,/secrets\.runtime_database|CANNELE_REGISTRY_DATABASE_(?:URL|HOST)|GITHUB_OUTPUT|GITHUB_ENV|--token|password/);
  assert.match(activation,/if: inputs\.action == 'activate-runtime'/);
  assert.doesNotMatch(activation,/CANNELE_(?:BOOTSTRAP|TRANSITION)_|CANNELE_REGISTRY_DATABASE_(?:URL|HOST)|secrets\.(?:runtime_database|bootstrap_vercel_token|transition_)/);
  assert.doesNotMatch(activation,/CANNELE_ONBOARDING_RUNTIME_ROLE_NAME|CANNELE_ONBOARDING_TRANSITION_JSON/);
  assert.deepEqual([...activation.matchAll(/^          ([A-Z_]+):/gm)].map(match=>match[1]),[
    'EVENT_NAME','GITHUB_TOKEN','CANNELE_ONBOARDING_ACTION','CANNELE_ONBOARDING_EXPECTED_REVISION','CANNELE_ONBOARDING_REQUEST_ID',
    'CANNELE_ONBOARDING_RESULT_PATH','CANNELE_ONBOARDING_SOURCE_DIR','CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON','CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN',
    'CAKE_CANNELE_ENABLED','CAKE_QA_POOL_ENABLED','CAKE_QA_REGISTRY_ENABLED','CANNELE_REGISTRY_ADMIN_DATABASE_URL','CANNELE_REGISTRY_ADMIN_DATABASE_HOST',
  ]);
  for(const step of [inspect,transitionStep,runtime,activation])assert.doesNotMatch(step,/CANNELE_BOOTSTRAP_VERCEL_TOKEN|secrets\.bootstrap_vercel_token/);
  assert.equal((runner.match(/CANNELE_BOOTSTRAP_VERCEL_TOKEN: /g)??[]).length,1);
  for(const step of [inspect,transitionStep,bootstrap,runtime,activation]) {
    assert.match(step,/CANNELE_REGISTRY_ADMIN_DATABASE_URL: \$\{\{ secrets\.admin_database_url \}\}/);
    assert.match(step,/CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN: \$\{\{ inputs\.confirm_credential_drain \}\}/);
    assert.match(step,/node --import tsx scripts\/cannele-onboarding\.ts/);
    for(const name of ['CAKE_CANNELE_ENABLED','CAKE_QA_POOL_ENABLED','CAKE_QA_REGISTRY_ENABLED'])assert.ok(step.includes(name+': ${{ vars.'+name+' }}'));
  }
  for(const name of ['VERCEL_TOKEN','NEON_API_KEY'])assert.match(dispatcher,new RegExp(`\\(inputs\\.action == 'transition' \\|\\| inputs\\.action == 'bootstrap-runtime'\\) && secrets\\.CANNELE_TRANSITION_${name}`));
  for(const suffix of ['url','host'])assert.match(dispatcher,new RegExp(`runtime_database_${suffix}: \\$\\{\\{ inputs\\.action == 'provision-runtime' && secrets\\.CANNELE_REGISTRY_DATABASE_`));
  assert.doesNotMatch(runner,/CAKE_QA_REGISTRY_DATABASE_URL|CAKE_QA_REGISTRY_DATABASE_HOST|env pull|vercel env|CREATE ROLE/);
});

test('only the request-bound strict public result is uploaded from the private temp path',()=>{
  assert.match(runner,/uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(runner,/name: cannele-onboarding-\$\{\{ inputs\.action \}\}-\$\{\{ inputs\.request_id \}\}/);
  assert.match(runner,/path: \$\{\{ steps\.public\.outputs\.result_path \}\}\s+if-no-files-found: error\s+retention-days: 1/);
  assert.doesNotMatch(runner.slice(runner.indexOf('      - name: Upload strict')),/secrets\.|always\(\)|\*|\.env|source_dir/);
});
