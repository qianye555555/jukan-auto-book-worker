'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {
  coordToCell,cellToCoord,pvToCells,parseEval,positionCommand,SearchCapture,
  isImmediateWinningMove,attachImmediateProof,githubOidcConfig
}=require('./worker.cjs');

test('cell conversion round-trips on 15x15 board',()=>{
  for(const cell of ['A1','H8','O15','I10'])assert.equal(coordToCell(cellToCoord(cell)),cell);
  assert.throws(()=>cellToCoord('P1'),/INVALID_CELL/);
  assert.throws(()=>cellToCoord('A16'),/INVALID_CELL/);
});

test('PV and eval parsing preserve raw engine semantics',()=>{
  assert.deepEqual(pvToCells('7,7 7,8 8,9'),['H8','H9','I10']);
  assert.deepEqual(parseEval('+M7'),{eval:null,mate:{sign:1,plies:7}});
  assert.deepEqual(parseEval('-M*'),{eval:null,mate:{sign:-1,plies:null}});
  assert.equal(parseEval('0.25').eval,0.25);
});

test('YXBOARD encoding stays identical to JUKAN v1 worker convention',()=>{
  assert.equal(
    positionCommand(['H8','H9','I10']),
    'YXBOARD\n7,7,2\n7,8,1\n8,9,2\nDONE'
  );
});

test('SearchCapture emits legal final candidate and checkpoints',()=>{
  const capture=new SearchCapture(300000);
  capture.startedAt=Date.now()-300000;
  for(const line of [
    'INFO PV 1',
    'INFO BESTLINE 6,6 7,6',
    'INFO EVAL 0.42',
    'INFO WINRATE 0.61',
    'INFO DEPTH 24',
    'INFO TOTALNODES 123456',
    'INFO TOTALTIME 300000',
    'INFO PV DONE'
  ])capture.line(line);
  assert.equal(capture.line('6,6'),true);
  const result=capture.result();
  assert.equal(result.candidates[0].cell,'G7');
  assert.equal(result.candidates[0].eval,0.42);
  assert.ok(result.checkpoints.length>=1);
});

test('immediate exact-five result is proven without waiting full budget',()=>{
  const moves=['H8','A1','I8','A2','J8','A3','K8','A4'];
  assert.equal(isImmediateWinningMove(moves,'G8','renju'),true);
  assert.equal(isImmediateWinningMove(moves,'G7','renju'),false);
  const result={
    candidates:[{cell:'G8',rank:1,eval:null,mate:null}],
    checkpoints:[{elapsed_ms:120,best_move:'G8',eval:null,mate:null}],
    durationMs:120
  };
  attachImmediateProof(result,{moves,rule:'renju'});
  assert.deepEqual(result.candidates[0].mate,{sign:1,plies:1});
  assert.deepEqual(result.checkpoints[0].mate,{sign:1,plies:1});
});

test('OIDC config never accepts missing GitHub token environment',()=>{
  assert.throws(()=>githubOidcConfig({}),/AUTO_BOOK_GITHUB_OIDC_UNAVAILABLE/);
});
