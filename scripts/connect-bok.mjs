// Compatibility entry point: the agent no longer connects to the old Bok vault.
import { PersonalMemory } from '../src/adapters/memory.mjs';
const memory=new PersonalMemory();
await memory.start();
console.log(JSON.stringify(await memory.health(),null,2));
