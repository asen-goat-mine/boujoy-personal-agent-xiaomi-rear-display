import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedAudio} from '../desktop/media-permission.cjs';
for(const port of [18891,18892])test(`microphone accepts only this edition origin ${port}`,()=>{
 const origin=`http://127.0.0.1:${port}`,main={isDestroyed:()=>false,getURL:()=>origin+'/#home'},input={contents:main,mainContents:main,permission:'media',origin,expectedOrigin:origin,details:{requestingUrl:origin+'/',isMainFrame:true,mediaType:'audio'}};
 assert.equal(allowedAudio(input),true);assert.equal(allowedAudio({...input,request:true,details:{...input.details,mediaTypes:['audio']}}),true);
 for(const other of ['http://127.0.0.1:18791',`http://127.0.0.1:${port===18891?18892:18891}`,'https://example.com'])assert.equal(allowedAudio({...input,origin:other}),false);
 assert.equal(allowedAudio({...input,expectedOrigin:undefined}),false);assert.equal(allowedAudio({...input,details:{...input.details,mediaType:'video'}}),false);assert.equal(allowedAudio({...input,request:true,details:{...input.details,mediaTypes:['audio','video']}}),false);assert.equal(allowedAudio({...input,details:{...input.details,isMainFrame:false}}),false);assert.equal(allowedAudio({...input,mainContents:{}}),false);
});
