import {DISTRIBUTION,BUILD_IDENTITY} from '../src/distribution.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT,DATA,ORIGIN } from '../src/config.mjs';
import { harnessVersion } from '../src/adapters/harness.mjs';
import { Secrets } from '../src/adapters/secrets.mjs';
import { PersonalMemory } from '../src/adapters/memory.mjs';
const secrets=new Secrets();let online=false;try{online=(await fetch(ORIGIN)).ok;}catch{}
console.log(JSON.stringify({app:DISTRIBUTION.productName,buildIdentity:BUILD_IDENTITY,harnessVersion:harnessVersion(),credentials:await secrets.status(),memory:await new PersonalMemory().health(),phoneComponentBuilt:fs.existsSync(path.join(DATA,'tools/phoneuse/1.3.0/phoneuse_client.py')),serverOnline:online,origin:ORIGIN,dataDirectory:DATA,livePhoneVerified:false},null,2));
