// Skip reasons for the tests that need something outside this repository.
// Each constant is false when the requirement is met, otherwise the reason shown next to the skipped test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {harnessVersion} from '../../src/adapters/harness.mjs';
import {bokPersonalInstalled} from '../../src/adapters/bok-personal.mjs';

const mac=process.platform==='darwin';
const sandbox=mac&&fs.existsSync('/usr/bin/sandbox-exec');
const home=path.join(os.homedir(),'.local/bin/python3');
// Same candidates and the same 3.10 floor as src/tools/local-code.mjs.
function python310(){
  return [process.env.BOUJOY_PYTHON,home,'/usr/bin/python3'].filter(Boolean).some(candidate=>{
    try{
      const out=spawnSync(fs.realpathSync(candidate),['-I','-S','-c','import sys;print(sys.version_info[0],sys.version_info[1])'],{timeout:5000,encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
      const [major,minor]=String(out.stdout||'').trim().split(' ').map(Number);
      return out.status===0&&major===3&&minor>=10;
    }catch{return false;}
  });
}
export const NEEDS_MAC=mac?false:'needs macOS';
export const NEEDS_SANDBOX=sandbox?false:'needs the macOS system sandbox (sandbox-exec)';
export const NEEDS_SANDBOX_PYTHON=NEEDS_SANDBOX||(python310()?false:'needs Python 3.10 or newer (BOUJOY_PYTHON, ~/.local/bin/python3 or /usr/bin/python3)');
export const NEEDS_HARNESS=harnessVersion()==='0.2.1-alpha.2'?false:'needs DeepSeek Harness: run npm run setup first';
export const NEEDS_BOK=bokPersonalInstalled()?false:'needs the optional Bok personal core (vendor/bok_personal)';
// Same lookup as src/adapters/voice.mjs.
export const VOICE_PYTHON=[process.env.BOUJOY_PYTHON,home].find(p=>p&&fs.existsSync(p))||null;
export const NEEDS_VOICE=NEEDS_SANDBOX||(VOICE_PYTHON?false:'needs the local voice Python (BOUJOY_PYTHON or ~/.local/bin/python3)');
