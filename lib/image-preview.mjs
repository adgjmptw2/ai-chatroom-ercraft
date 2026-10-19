// Derived public previews only. Never read raw workspace files or change originals.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
const MAX_OUTPUT = 2 * 1024 ** 2, DISK_LIMIT = 64 * 1024 ** 2;
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
export const previewKey = bytes => createHash('sha256').update('jpeg-720-q82-v1\0').update(bytes).digest('hex');
export function safePreview(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_OUTPUT || bytes.readUInt16BE(0) !== 0xffd8
    || bytes.readUInt16BE(bytes.length-2) !== 0xffd9) return false;
  let at=2, dimensions=false;
  while(at+4<=bytes.length) {
    if(bytes[at]!==0xff)return false;
    const marker=bytes[at+1],length=bytes.readUInt16BE(at+2);
    if(length<2||at+2+length>bytes.length)return false;
    // No EXIF, XMP, ICC, comments or identifying APP segments in cached copies.
    if(marker===0xfe || marker>=0xe1&&marker<=0xef)return false;
    if(marker===0xe0 && bytes.toString('ascii',at+4,at+9)!=='JFIF\0')return false;
    if(marker===0xc0||marker===0xc2) {
      if(length<8)return false;
      const height=bytes.readUInt16BE(at+5),width=bytes.readUInt16BE(at+7);
      if(!width||!height||width>720||height>720)return false;
      dimensions=true;
    }
    if(marker===0xda)return dimensions;
    at+=2+length;
  }
  return false;
}
export function renderPreview(bytes) {
  return new Promise((resolve,reject)=>{
    const command=path.join(process.env.SystemRoot || 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const child=execFile(command,['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(import.meta.dirname,'image-preview.ps1')],
      {windowsHide:true,encoding:'buffer',maxBuffer:MAX_OUTPUT,timeout:10000},(error,stdout)=>{
        if(error||!safePreview(stdout))reject(Error('Preview unavailable'));else resolve(stdout);
      });
    child.stdin.on('error',()=>{});child.stdin.end(bytes.toString('base64'));
  });
}
export class ImagePreviews {
  constructor(directory,{render=renderPreview}={}) {
    this.directory=directory;this.render=render;this.pending=new Map();this.tail=Promise.resolve();this.memory=new Map();this.bytes=0;
  }
  get busy(){return this.pending.size>0;}
  directoryReady() {
    fs.mkdirSync(this.directory,{recursive:true});
    const stat=fs.lstatSync(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Preview cache unavailable');
  }
  remember(key,body) {
    const prior=this.memory.get(key);if(prior)this.bytes-=prior.length;
    this.memory.delete(key);this.memory.set(key,body);this.bytes+=body.length;
    while(this.bytes>16*1024**2||this.memory.size>128){const first=this.memory.keys().next().value;this.bytes-=this.memory.get(first).length;this.memory.delete(first);}
    return body;
  }
  readDisk(key) {
    try {
      const file=path.join(this.directory,key+'.jpg'),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_OUTPUT)throw Error('Invalid preview cache');
      const body=fs.readFileSync(file);if(!safePreview(body))throw Error('Invalid preview cache');return body;
    } catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  prune() {
    const files=fs.readdirSync(this.directory).filter(n=>/^[a-f0-9]{64}\.jpg$/.test(n)).map(name=>({name,stat:fs.lstatSync(path.join(this.directory,name))}));
    if(files.some(f=>!f.stat.isFile()||f.stat.isSymbolicLink()))throw Error('Invalid preview cache');
    let size=files.reduce((n,f)=>n+f.stat.size,0);
    for(const file of files.sort((a,b)=>a.stat.mtimeMs-b.stat.mtimeMs)){
      if(size<=DISK_LIMIT)break;fs.unlinkSync(path.join(this.directory,file.name));size-=file.stat.size;
    }
  }
  async get(bytes) {
    if(!Buffer.isBuffer(bytes)||bytes.length<33||bytes.length>32*1024**2||!bytes.subarray(0,8).equals(PNG)
      ||bytes.toString('ascii',12,16)!=='IHDR')throw Error('Preview unavailable');
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    if(!width||!height||width>4096||height>4096||width*height>16777216)throw Error('Preview unavailable');
    const key=previewKey(bytes);
    const cached=this.memory.get(key);if(cached)return this.remember(key,cached);
    if(this.pending.has(key))return this.pending.get(key);
    if(this.pending.size>=16)throw Error('Preview queue busy');
    const work=this.tail.then(async()=>{
      this.directoryReady();const disk=this.readDisk(key);if(disk)return this.remember(key,disk);
      const body=await this.render(bytes);if(!safePreview(body))throw Error('Preview unavailable');
      const file=path.join(this.directory,key+'.jpg'),temp=file+'.'+process.pid+'.tmp';
      // Exclusive staging; do not delete a file this call did not create.
      const fd=fs.openSync(temp,'wx');
      try {try{fs.writeFileSync(fd,body);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}
      finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
      this.prune();return this.remember(key,body);
    });
    this.tail=work.catch(()=>{});
    this.pending.set(key,work);
    try{return await work;}finally{this.pending.delete(key);}
  }
}
