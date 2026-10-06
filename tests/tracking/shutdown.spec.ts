import test from 'node:test';
import assert from 'node:assert/strict';
test('all manual and tracked motion stops before a blocked vision helper is awaited',async()=>{
  const {stopMotionBeforeHelpers}=require('../../src/app/stopMotionBeforeHelpers');
  const calls:string[]=[];let release!:()=>void;
  const blocked=new Promise<void>(r=>release=r);
  const promise=stopMotionBeforeHelpers({halt:()=>calls.push('invalidate'),stop:()=>{calls.push('helper');return blocked;}},[
    {stop:()=>calls.push('tracked-stop')},{stop:()=>calls.push('manual-stop')},
  ]);
  assert.deepEqual(calls,['invalidate','tracked-stop','manual-stop']);
  await new Promise<void>(r=>setImmediate(r));
  assert.deepEqual(calls,['invalidate','tracked-stop','manual-stop','helper']);
  release();await promise;
});
test('throwing halt/device still attempts every stop and reaps the helper before reporting failure',async()=>{
  const {stopMotionBeforeHelpers}=require('../../src/app/stopMotionBeforeHelpers');const calls:string[]=[];
  await assert.rejects(stopMotionBeforeHelpers({halt:()=>{calls.push('halt');throw Error('halt');},stop:async()=>{calls.push('helper');}},[
    {stop:()=>{calls.push('broken');throw Error('device');}},{stop:()=>calls.push('healthy')},
  ]),AggregateError);
  assert.deepEqual(calls,['halt','broken','healthy','helper']);
});
