import {it,expect} from 'vitest';
import {runtimeInvocationResultSchema} from './index.js';

it('preserves rejected branch outcomes through the versioned runtime wire contract',()=>{
  const result={contractVersion:'runtime.result.v2',invocationId:'inv',runId:'run',status:'completed',output:{other:'ok'},errorCode:null,checkpointId:null,
    providerMetadata:{},settlements:{screening:{status:'rejected',reason:{code:'provider.unavailable',message:'provider.unavailable'}}}};
  expect(runtimeInvocationResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  expect(()=>runtimeInvocationResultSchema.parse({...result,contractVersion:'runtime.result.v1'})).toThrow();
});
