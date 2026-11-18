import {KEYCHAIN_ACCOUNT,KEYCHAIN_PREFIX} from '../distribution.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.mjs';
const exec=promisify(execFile);
const NAMES={deepseek:'DEEPSEEK_API_KEY'};
const known=name=>Object.hasOwn(NAMES,name)||/^(?:connector|event|monitor)-[a-f0-9-]{36}$/.test(name);
export class Secrets {
  constructor({exec:run=exec}={}){this.exec=run;this.cache=new Map();}
  async get(name){
    if(!known(name))throw new AppError('invalid_secret','未知凭证');
    if(Object.hasOwn(NAMES,name)&&process.env[NAMES[name]])return process.env[NAMES[name]];
    if(this.cache.has(name))return this.cache.get(name);
    try{const {stdout}=await this.exec('/usr/bin/security',['find-generic-password','-a',KEYCHAIN_ACCOUNT,'-s',`${KEYCHAIN_PREFIX}.personal.${name}`,'-w'],{timeout:5000});const value=stdout.trim();this.cache.set(name,value);return value;}catch{return '';}
  }
  async set(name,value){
    if(!known(name)||typeof value!=='string'||value.length<8||value.length>4096||/[\r\n\0]/.test(value))throw new AppError('invalid_secret','凭证格式不正确');
    try{await this.exec('/usr/bin/security',['add-generic-password','-U','-a',KEYCHAIN_ACCOUNT,'-s',`${KEYCHAIN_PREFIX}.personal.${name}`,'-w',value],{timeout:15000});}catch{throw new AppError('keychain_failed','无法写入系统钥匙串',500);}
    this.cache.set(name,value);return {saved:true};
  }
  async status(){return {deepseek:!!await this.get('deepseek')};}
  async remove(name){if(!/^(?:connector|event|monitor)-[a-f0-9-]{36}$/.test(name))throw new AppError('invalid_secret','未知凭证');this.cache.delete(name);try{await this.exec('/usr/bin/security',['delete-generic-password','-a',KEYCHAIN_ACCOUNT,'-s',`${KEYCHAIN_PREFIX}.personal.${name}`],{timeout:5000});}catch{}}
}
