'use strict';

const {spawn}=require('node:child_process');
const path=require('node:path');

const AUDIENCE='jukan-auto-book';
const DEFAULT_GATEWAY='https://usvkntkilndpieybggff.supabase.co/functions/v1/auto-book-worker';
const CELL_RE=/^[A-O](?:[1-9]|1[0-5])$/;

function githubOidcConfig(env=process.env){
  const requestUrl=env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken=env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const gateway=env.AUTO_BOOK_WORKER_GATEWAY||DEFAULT_GATEWAY;
  if(!requestUrl||!requestToken)throw Error('AUTO_BOOK_GITHUB_OIDC_UNAVAILABLE');
  return {requestUrl,requestToken,gateway};
}

async function oidcToken(config,fetchImpl=globalThis.fetch){
  const url=new URL(config.requestUrl);
  url.searchParams.set('audience',AUDIENCE);
  const response=await fetchImpl(url,{headers:{authorization:`Bearer ${config.requestToken}`}});
  const text=await response.text();
  if(!response.ok)throw Error(`AUTO_BOOK_OIDC_${response.status}:${text.slice(0,160)}`);
  const body=JSON.parse(text);
  if(typeof body?.value!=='string'||body.value.split('.').length!==3)throw Error('AUTO_BOOK_OIDC_INVALID');
  return body.value;
}

function createGateway(config,{fetchImpl=globalThis.fetch}={}){
  return async(action,payload={})=>{
    const token=await oidcToken(config,fetchImpl);
    const response=await fetchImpl(config.gateway,{
      method:'POST',
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({action,...payload})
    });
    const text=await response.text();
    let body=null; try{body=text?JSON.parse(text):null;}catch{}
    if(!response.ok)throw Error(`AUTO_BOOK_GATEWAY_${response.status}:${body?.error||text.slice(0,160)}`);
    return body;
  };
}

function coordToCell(point){
  if(!Array.isArray(point)||point.length!==2)throw Error('INVALID_COORD');
  const [x,y]=point.map(Number);
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||x>=15||y<0||y>=15)throw Error('INVALID_COORD');
  return String.fromCharCode(65+x)+(y+1);
}
function cellToCoord(name){
  const value=String(name||'').toUpperCase();
  if(!CELL_RE.test(value))throw Error('INVALID_CELL');
  return [value.charCodeAt(0)-65,Number(value.slice(1))-1];
}
function pvToCells(value){
  return [...String(value||'').matchAll(/(\d+),(\d+)/g)]
    .map(m=>[Number(m[1]),Number(m[2])])
    .filter(([x,y])=>x>=0&&x<15&&y>=0&&y<15)
    .map(coordToCell);
}
function parseEval(value){
  const text=String(value??'');
  const numeric=Number(text);
  const mate=text.match(/^([+-])M(\d+|\*)$/);
  return {eval:Number.isFinite(numeric)?numeric:null,mate:mate?{sign:mate[1]==='+'?1:-1,plies:mate[2]==='*'?null:Number(mate[2])}:null};
}
function snapshotStats(stats){
  const parsed=parseEval(stats.EVAL);
  return {
    eval:parsed.eval,
    mate:parsed.mate,
    winRate:Number.isFinite(Number(stats.WINRATE))?Number(stats.WINRATE):null,
    pv:pvToCells(stats.BESTLINE),
    depth:Number(stats.DEPTH)||null,
    nodes:Number(stats.TOTALNODES)||0,
    timeMs:Number(stats.TOTALTIME)||0,
    rank:Number(stats.PV)||1
  };
}
function positionCommand(cells){
  const position=cells.map(cellToCoord);
  const side=position.length%2;
  const lines=position.map(([x,y],i)=>`${x},${y},${i%2===side?1:2}`);
  return `YXBOARD\n${lines.join('\n')}\nDONE`;
}
function candidateFromFrame(key,stats,rank){
  const point=String(key).split(',').map(Number);
  return {cell:coordToCell(point),rank,...snapshotStats(stats)};
}

function winningLineLengths(moves,cell){
  if(!Array.isArray(moves))throw Error('INVALID_MOVES');
  const target=String(cell||'').toUpperCase();
  const [x,y]=cellToCoord(target);
  const occupied=new Map();
  for(let i=0;i<moves.length;i++){
    const name=String(moves[i]||'').toUpperCase();
    cellToCoord(name);
    if(occupied.has(name))throw Error('DUPLICATE_MOVE');
    occupied.set(name,i%2);
  }
  if(occupied.has(target))return [];
  const side=moves.length%2;
  occupied.set(target,side);
  const at=(px,py)=>{
    if(px<0||px>=15||py<0||py>=15)return null;
    return occupied.get(coordToCell([px,py]));
  };
  return [[1,0],[0,1],[1,1],[1,-1]].map(([dx,dy])=>{
    let count=1;
    for(const sign of [-1,1]){
      let px=x+dx*sign,py=y+dy*sign;
      while(at(px,py)===side){count++;px+=dx*sign;py+=dy*sign;}
    }
    return count;
  });
}

function isImmediateWinningMove(moves,cell,rule='renju'){
  const lengths=winningLineLengths(moves,cell);
  if(!lengths.length)return false;
  const side=moves.length%2;
  if(rule==='freestyle')return lengths.some(n=>n>=5);
  if(rule==='standard')return lengths.some(n=>n===5);
  if(rule==='renju'){
    if(side===1)return lengths.some(n=>n>=5);
    if(lengths.some(n=>n>5))return false;
    return lengths.some(n=>n===5);
  }
  return false;
}

function attachImmediateProof(result,job){
  const best=result?.candidates?.[0];
  if(!best||best.mate?.sign)return result;
  if(!isImmediateWinningMove(job.moves,best.cell,job.rule))return result;
  best.mate={sign:1,plies:1};
  const finalCheckpoint=result.checkpoints?.at(-1);
  if(finalCheckpoint&&finalCheckpoint.best_move===best.cell&&!finalCheckpoint.mate){
    finalCheckpoint.mate={sign:1,plies:1};
  }
  return result;
}

class SearchCapture{
  constructor(budgetMs){this.reset(budgetMs);}
  reset(budgetMs){
    this.budgetMs=budgetMs; this.startedAt=Date.now(); this.stats={}; this.frames=new Map();
    this.cyclePoints=new Set(); this.frameBest=null; this.finalBest=null; this.finalCandidates=[];
    this.error=null; this.checkpoints=[]; this.nextThreshold=0;
  }
  checkpoint(bestMove,stats){
    if(!bestMove)return;
    const elapsed=Math.max(Date.now()-this.startedAt,Number(stats?.TOTALTIME)||0);
    const thresholds=[.2,.4,.6,.8,1].map(x=>Math.floor(this.budgetMs*x));
    if(this.nextThreshold>=thresholds.length||elapsed<thresholds[this.nextThreshold])return;
    const snap=snapshotStats(stats||{});
    this.checkpoints.push({elapsed_ms:elapsed,best_move:coordToCell(bestMove.split(',').map(Number)),eval:snap.eval,mate:snap.mate,depth:snap.depth,nodes:snap.nodes});
    this.nextThreshold++;
  }
  candidates(best=this.finalBest||this.frameBest){
    const entries=[...this.frames.entries()]
      .filter(([key])=>this.cyclePoints.has(key)||key===best)
      .map(([key,stats])=>({key,stats,snap:snapshotStats(stats)}));
    entries.sort((a,b)=>best
      ? (a.key===best?-1:b.key===best?1:(b.snap.winRate??-Infinity)-(a.snap.winRate??-Infinity))
      : a.snap.rank-b.snap.rank);
    return entries.slice(0,5).map((item,index)=>candidateFromFrame(item.key,item.stats,index+1));
  }
  line(raw){
    const line=String(raw??'').trim();
    if(!line)return false;
    if(/^ERROR/.test(line)){this.error=Error(line);return false;}
    if(line.startsWith('INFO ')){
      const m=line.match(/^INFO (\w+) (.*)$/);
      if(m){
        if(m[1]==='PV'&&m[2]!=='DONE'){
          this.stats={};
          if(m[2]==='1')this.cyclePoints.clear();
        }
        if(m[1]!=='PV'||m[2]!=='DONE')this.stats[m[1]]=m[2];
      }
      if(line==='INFO PV DONE'){
        const first=String(this.stats.BESTLINE||'').match(/\d+,\d+/)?.[0];
        if(first){
          this.frames.set(first,{...this.stats});
          this.cyclePoints.add(first);
          if(Number(this.stats.PV)===1){this.frameBest=first;this.checkpoint(first,this.stats);}
        }
      }
      return false;
    }
    if(/^\d+,\d+( \d+,\d+)?$/.test(line)){
      const first=line.split(' ')[0];
      this.finalBest=first;
      if(!this.frames.has(first))this.frames.set(first,{...this.stats,BESTLINE:this.stats.BESTLINE||line});
      this.checkpoint(first,this.frames.get(first));
      this.finalCandidates=this.candidates(first);
      return true;
    }
    return false;
  }
  result(){
    if(this.error)throw this.error;
    if(!this.finalBest)throw Error('RAPFI_NO_FINAL_MOVE');
    const candidates=this.finalCandidates.length?this.finalCandidates:this.candidates(this.finalBest);
    if(!candidates.length)throw Error('RAPFI_NO_CANDIDATES');
    const finalCell=coordToCell(this.finalBest.split(',').map(Number));
    if(candidates[0]?.cell!==finalCell){
      const hit=candidates.findIndex(c=>c.cell===finalCell);
      if(hit>0)candidates.unshift(candidates.splice(hit,1)[0]);
    }
    const finalSnap=candidates[0];
    const last=this.checkpoints.at(-1);
    if(!last||last.best_move!==finalCell||Math.abs((Date.now()-this.startedAt)-last.elapsed_ms)>5000){
      this.checkpoints.push({elapsed_ms:Date.now()-this.startedAt,best_move:finalCell,eval:finalSnap.eval,mate:finalSnap.mate,depth:finalSnap.depth,nodes:finalSnap.nodes});
    }
    return {candidates,checkpoints:this.checkpoints.slice(-4),durationMs:Date.now()-this.startedAt};
  }
}

function wireLines(stream,onLine){
  let buffer='';
  stream.setEncoding('utf8');
  stream.on('data',chunk=>{
    buffer+=chunk;
    for(;;){
      const i=buffer.indexOf('\n');
      if(i<0)break;
      const line=buffer.slice(0,i).replace(/\r$/,'');
      buffer=buffer.slice(i+1);
      onLine(line);
    }
  });
  stream.on('end',()=>{if(buffer)onLine(buffer.replace(/\r$/,''));});
}

async function createNativeVerifier({engineBin=process.env.AUTO_BOOK_ENGINE_BIN||path.resolve('.cache/engine/rapfi'),engineDir=process.env.AUTO_BOOK_ENGINE_DIR||path.dirname(engineBin)}={}){
  const child=spawn(engineBin,[],{cwd:engineDir,stdio:['pipe','pipe','pipe']});
  let active=null;
  let startupResolve,startupReject;
  let exited=false;

  const failActive=error=>{if(active){const a=active;active=null;a.reject(error);}};
  wireLines(child.stdout,line=>{
    if(line==='OK')startupResolve?.();
    if(active){
      try{if(active.capture.line(line)){const a=active;active=null;a.resolve();}}
      catch(error){const a=active;active=null;a.reject(error);}
    }
  });
  wireLines(child.stderr,line=>{
    if(line.trim())console.error('[rapfi stderr]',line.slice(0,500));
  });
  child.on('error',error=>{startupReject?.(error);failActive(error);});
  child.on('exit',(code,signal)=>{
    exited=true;
    const error=Error(`RAPFI_EXIT:${code??'null'}:${signal??'none'}`);
    startupReject?.(error); failActive(error);
  });
  const send=text=>{
    if(exited||child.stdin.destroyed)throw Error('RAPFI_NOT_RUNNING');
    child.stdin.write(String(text).replace(/\n?$/,'\n'));
  };

  const started=new Promise((resolve,reject)=>{startupResolve=resolve;startupReject=reject;});
  send('START 15');
  const startupTimer=setTimeout(()=>startupReject?.(Error('RAPFI_START_TIMEOUT')),30000);
  try{await started;}finally{clearTimeout(startupTimer);startupResolve=null;startupReject=null;}

  send('INFO THREAD_NUM 1');
  send('INFO HASH_SIZE 131072');
  send('YXSHOWINFO');
  send('INFO SHOW_DETAIL 2');
  send('INFO STRENGTH 100');
  const engineVersion='rapfi-250615-1be1551ced57-net-918b757a1292-native-avx2';

  return Object.freeze({
    engineVersion,
    async verify(job){
      if(active)throw Error('RAPFI_BUSY');
      if(!Array.isArray(job.moves)||job.moves.length<3)throw Error('AUTO_BOOK_JOB_MOVES_INVALID');
      job.moves.forEach(cellToCoord);
      const budgetMs=Number(job.budgetMs);
      if(![300000,600000,1800000].includes(budgetMs))throw Error('AUTO_BOOK_JOB_BUDGET_INVALID');
      const ruleCode={renju:4,standard:1,freestyle:0}[job.rule];
      if(ruleCode===undefined)throw Error('AUTO_BOOK_JOB_RULE_INVALID');

      const capture=new SearchCapture(budgetMs);
      const done=new Promise((resolve,reject)=>{active={capture,resolve,reject};});
      let timeoutId=null;
      try{
        send('YXHASHCLEAR');
        send(`INFO RULE ${ruleCode}`);
        send('INFO CAUTION_FACTOR 3');
        send('INFO STRENGTH 100');
        send('INFO HASH_SIZE 131072');
        send('INFO THREAD_NUM 1');
        send(`INFO TIMEOUT_TURN ${budgetMs}`);
        send('INFO TIMEOUT_MATCH 2147483647');
        send('INFO TIME_LEFT 2147483647');
        send(positionCommand(job.moves));
        send('YXNBEST 5');
        const timeout=new Promise((_,reject)=>{
          timeoutId=setTimeout(()=>reject(Error('RAPFI_SEARCH_TIMEOUT')),budgetMs+90000);
        });
        await Promise.race([done,timeout]);
        const result=capture.result();
        attachImmediateProof(result,job);
        return {...result,engineVersion};
      }finally{
        if(timeoutId!==null)clearTimeout(timeoutId);
        active=null;
      }
    },
    close(){
      try{child.stdin.write('END\n');}catch{}
      setTimeout(()=>{try{if(!exited)child.kill('SIGKILL');}catch{}},1500).unref();
    }
  });
}

async function peekGithubQueue({env=process.env,fetchImpl=globalThis.fetch}={}){
  const gateway=createGateway(githubOidcConfig(env),{fetchImpl});
  const result=await gateway('peek');
  return result?.pending===true;
}

async function runGithubWorker({env=process.env,fetchImpl=globalThis.fetch,createVerifier=createNativeVerifier}={}){
  const gateway=createGateway(githubOidcConfig(env),{fetchImpl});
  const claim=await gateway('claim');
  const job=claim?.job;
  if(!job){console.log('[auto-book] queue empty; no engine started');return {processed:false};}
  console.log(`[auto-book] claimed job ${job.id} · ${job.budgetMs}ms · ${job.moves?.length||0} moves`);
  const verifier=await createVerifier({engineBin:env.AUTO_BOOK_ENGINE_BIN,engineDir:env.AUTO_BOOK_ENGINE_DIR});
  try{
    let result;
    try{result=await verifier.verify(job);}
    catch(error){
      const code=String(error?.message||error).slice(0,120);
      console.error(`[auto-book] verification failed for ${job.id}: ${code}`);
      try{await gateway('fail',{jobId:job.id,errorCode:code});}catch(reportError){console.error('[auto-book] failure report failed',reportError?.message||reportError);}
      throw error;
    }
    let done;
    try{
      done=await gateway('complete',{
        jobId:job.id,
        checkpoints:result.checkpoints,
        candidates:result.candidates,
        engineVersion:result.engineVersion,
        durationMs:result.durationMs
      });
    }catch(error){
      const code=`COMPLETE:${String(error?.message||error)}`.slice(0,120);
      console.error(`[auto-book] completion failed for ${job.id}: ${code}`);
      try{await gateway('fail',{jobId:job.id,errorCode:code});}catch(reportError){console.error('[auto-book] completion failure report failed',reportError?.message||reportError);}
      throw error;
    }
    console.log(`[auto-book] job ${job.id} → ${done?.decision||'completed'} · ${result.durationMs}ms`);
    return {processed:true,jobId:job.id,decision:done?.decision||null};
  }finally{verifier.close();}
}

module.exports={
  AUDIENCE,DEFAULT_GATEWAY,githubOidcConfig,oidcToken,createGateway,
  coordToCell,cellToCoord,pvToCells,parseEval,snapshotStats,positionCommand,
  winningLineLengths,isImmediateWinningMove,attachImmediateProof,SearchCapture,
  createNativeVerifier,peekGithubQueue,runGithubWorker
};

if(require.main===module){
  const peek=process.argv.includes('--peek');
  const task=peek
    ? peekGithubQueue().then(pending=>{
        console.log(`AUTO_BOOK_PENDING=${pending?'true':'false'}`);
        if(process.env.GITHUB_OUTPUT)require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT,`pending=${pending?'true':'false'}\n`);
      })
    : runGithubWorker();
  task.catch(error=>{console.error('[auto-book] fatal',error?.stack||error?.message||error);process.exitCode=1;});
}
