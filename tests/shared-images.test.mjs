import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { appUrl } from '../public/base-path.js';
import {SharedImageCache,sharedImageUrl,observeSharedImages,setSharedImage} from '../public/shared-images.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('hundreds of simultaneous copies and later renders share one fetch and object URL',async()=>{
  const gate=deferred();let calls=0,urls=0;
  const c=new SharedImageCache({fetchImage:()=>{calls++;return gate.promise;},makeUrl:()=>`blob:${++urls}`});
  const leases=Array.from({length:300},()=>c.acquire('/same.png'));
  await flush();assert.equal(calls,1);gate.resolve({size:2000000});
  assert.equal(new Set(await Promise.all(leases.map(l=>l.promise))).size,1);
  leases.forEach(l=>l.release());
  const next=c.acquire('/same.png');assert.equal(await next.promise,'blob:1');next.release();assert.equal(calls,1);
});
test('parallel downloads are capped and detached queued requests never start',async()=>{
  const gates=Array.from({length:7},deferred);const calls=[];
  const c=new SharedImageCache({fetchImage:k=>{calls.push(k);return gates[+k].promise;},makeUrl:()=> 'blob:ok',concurrency:4});
  const leases=Array.from({length:7},(_,i)=>c.acquire(String(i)));
  const results=leases.map(l=>l.promise.catch(e=>e.message));leases[4].release();
  await flush();assert.equal(calls.length,4);gates.slice(0,4).forEach(g=>g.resolve({size:5}));await flush();
  assert.deepEqual(calls,['0','1','2','3','5','6']);gates[5].resolve({size:5});gates[6].resolve({size:5});await Promise.all(results);
  leases.forEach(l=>l.release());
});
test('removing one consumer does not cancel a shared download',async()=>{
  const gate=deferred();let calls=0;
  const c=new SharedImageCache({fetchImage:()=>{calls++;return gate.promise;},makeUrl:()=> 'blob:shared'});
  const a=c.acquire('/a'),b=c.acquire('/a');a.release();gate.resolve({size:5});
  assert.equal(await b.promise,'blob:shared');assert.equal(calls,1);b.release();
});
test('revised photo finishes independently of an older request and failures can retry',async()=>{
  const older=deferred(),newer=deferred();let calls=0;
  const c=new SharedImageCache({fetchImage:key=>{calls++;return key.endsWith('1')?older.promise:newer.promise;},makeUrl:b=>'blob:'+b.name});
  const a=c.acquire('/photo?t=1'),b=c.acquire('/photo?t=2');
  newer.resolve({size:1,name:'new'});assert.equal(await b.promise,'blob:new');
  older.resolve({size:1,name:'old'});assert.equal(await a.promise,'blob:old');assert.equal(await c.acquire('/photo?t=2').promise,'blob:new');assert.equal(calls,2);
  let tries=0;const retry=new SharedImageCache({fetchImage:()=>{if(!tries++)throw Error('network');return {size:5};},makeUrl:()=> 'blob:retry'});
  await assert.rejects(retry.acquire('/a').promise,/network/);assert.equal(await retry.acquire('/a').promise,'blob:retry');
});
test('idle eviction is bounded without revoking URLs still in use',async()=>{
  const revoked=[];const c=new SharedImageCache({fetchImage:async k=>({size:10,k}),makeUrl:b=>'blob:'+b.k,revokeUrl:u=>revoked.push(u),maxIdleBytes:10});
  const a=c.acquire('a'),b=c.acquire('b'),d=c.acquire('d');await Promise.all([a.promise,b.promise,d.promise]);
  a.release();b.release();await flush();assert.equal(revoked.length,1);assert.ok(!revoked.includes('blob:d'));
  d.release();await flush();assert.equal(revoked.length,2);d.release();assert.equal(revoked.length,2);
});
test('only same-origin public image routes enter the sharing cache',()=>{
  const origin='https://ercraft.net';
  for(const good of ['/assets/characters/eleven/avatar.png','/ws/images/photo.png?t=1-20','/ws/stickers/cat.svg'])assert.equal(sharedImageUrl(good,origin),good);
  for(const bad of ['https://evil.invalid/x.png','//evil.invalid/x.png','blob:secret','/api/admin/settings','/ws/../api/state','/assets/characters/internal/avatar.png','/ws/file.html','/ws/image.png\n','/ws/\\bad.png'])assert.equal(sharedImageUrl(bad,origin),null,bad);
});

test('eager panels release while hidden, reacquire on show, and reject stale revisions',async()=>{
  const previous=Object.fromEntries(['location','IntersectionObserver','MutationObserver'].map(k=>[k,globalThis[k]]));
  let visible,mutate;const observed=new Set();
  const img={nodeType:1,isConnected:true,dataset:{sharedSrc:'/ws/images/photo.png?t=1',sharedEager:'true'},
    addEventListener(){},removeEventListener(){},removeAttribute(){delete this.src;},matches(){return true;},querySelectorAll(){return [];}};
  const root={querySelectorAll:()=>[img]};let observer;
  try{
    globalThis.location={origin:'https://ercraft.net'};
    globalThis.IntersectionObserver=class {constructor(cb){visible=cb;}observe(i){observed.add(i);}unobserve(i){observed.delete(i);}disconnect(){}};
    globalThis.MutationObserver=class {constructor(cb){mutate=cb;}observe(){}disconnect(){}};
    observer=observeSharedImages(root);let calls=0;const old=deferred(),fresh=deferred();
    observer.cache.fetchImage=key=>{calls++;return key.endsWith('1')?old.promise:fresh.promise;};
    observer.cache.makeUrl=blob=>'blob:'+blob.name;observer.cache.revokeUrl=()=>{};
    await flush();assert.ok(observed.has(img));
    visible([{target:img,isIntersecting:false}]);
    assert.equal([...observer.cache.entries.values()][0].users,0);
    visible([{target:img,isIntersecting:true}]);
    assert.equal([...observer.cache.entries.values()][0].users,1);assert.equal(calls,1);
    img.dataset.sharedSrc='/ws/images/photo.png?t=2';mutate([{type:'attributes',target:img}]);
    fresh.resolve({size:5,name:'new'});await flush();assert.equal(img.src,'blob:new');
    old.resolve({size:5,name:'old'});await flush();assert.equal(img.src,'blob:new');
    visible([{target:img,isIntersecting:false}]);
    assert.ok([...observer.cache.entries.values()].every(e=>e.users===0));
    visible([{target:img,isIntersecting:true}]);await flush();assert.equal(img.src,'blob:new');assert.equal(calls,2);
    img.dataset.sharedSrc='';mutate([{type:'attributes',target:img}]);assert.equal(img.src,undefined);
  }finally{observer?.disconnect();for(const [k,v]of Object.entries(previous)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

// Small DOM/observer fixture: no server, browser, dependencies or real requests.
function imageFixture(t, { fetchImage, maxIdleBytes, base = '' } = {}) {
  const globals = ['document','location','IntersectionObserver','MutationObserver'];
  const saved = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let intersect, mutate, sequence = 0;
  const calls = [], revoked = [], images = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.nodeType = 1; this.dataset = {}; this.attributes = {}; this.children = []; this.listeners = new Map(); }
    get isConnected() { return this.parentNode === doc || !!this.parentNode?.isConnected; }
    get src() { return this.attributes.src; }
    set src(value) { this.attributes.src = value; this.complete = false; this.naturalWidth = 0; }
    setAttribute(key,value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; if (key === 'src') { this.complete = true; this.naturalWidth = 0; } }
    append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentNode = this; } }
    after(node) { node.remove(); this.parentNode.children.splice(this.parentNode.children.indexOf(this)+1,0,node); node.parentNode = this.parentNode; }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this),1); this.parentNode = null; }
    matches() { return this.tagName === 'img' && this.dataset.sharedSrc !== undefined; }
    querySelectorAll() { return this.children.flatMap(node => [...(node.matches() ? [node] : []), ...node.querySelectorAll()]); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type,new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type) { for (const fn of this.listeners.get(type) || []) fn(); }
    loaded() { this.complete = true; this.naturalWidth = 720; this.naturalHeight = 540; this.emit('load'); }
  }
  const doc = new Element('document');
  doc.nodeType = 9; doc.documentElement = { lang: 'ko' };
  doc.querySelector = () => ({ getAttribute: () => base });
  doc.createElement = tag => new Element(tag);
  globalThis.document = doc; globalThis.location = { origin: 'https://ercraft.net' };
  globalThis.IntersectionObserver = class { constructor(cb) { intersect = cb; } observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { constructor(cb) { mutate = cb; } observe() {} disconnect() {} };
  const cache = new SharedImageCache({
    fetchImage: url => { calls.push(url); return fetchImage?.(url,calls.length) ?? { size: 10 }; },
    makeUrl: () => `blob:fixture-${++sequence}`,
    revokeUrl: url => { assert.ok(images.every(img => img.src !== url), 'a DOM source must be cleared before revocation'); revoked.push(url); },
    ...(maxIdleBytes === undefined ? {} : {maxIdleBytes}),
  });
  const observer = observeSharedImages(doc, {cache});
  t.after(() => {
    observer.disconnect();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
    }
  });
  const changes = (addedNodes = [], removedNodes = []) => mutate([{type:'childList',addedNodes,removedNodes}]);
  return {
    cache, observer, calls, revoked, doc,
    add(url = `${base}/ws/images/photo.png?t=1&preview=1`, options = { eager: true, feedback: true }) {
      const img = new Element('img'); setSharedImage(img,url,options); images.push(img); doc.append(img); changes([img]); return img;
    },
    visible(img, value) { intersect([{target:img,isIntersecting:value}]); },
    source(img, url) { img.dataset.sharedSrc = url; mutate([{type:'attributes',target:img}]); },
    detach(img) { img.remove(); changes([], [img]); },
    attach(img) { doc.append(img); changes([img]); },
    status(img) { return img.parentNode.children[img.parentNode.children.indexOf(img)+1]; },
    retry(img) {
      const status = this.status(img), button = status.children[1];
      assert.equal(status.hidden,false); assert.equal(status.attributes.role,'status');
      assert.equal(button.tagName,'button'); assert.equal(button.type,'button'); assert.equal(button.hidden,false);
      let prevented = false, stopped = false;
      button.onclick({preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
      assert.ok(prevented && stopped, 'retry must not close the lightbox or activate its parent');
    },
  };
}

test('photos share delayed retry after a transient body failure and become ready only after decode',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const f=imageFixture(t,{fetchImage:(url,n)=>{if(n===1)throw Error('body stalled');return {size:108261};}});
  const a=f.add(),b=f.add(); await flush();
  assert.equal(f.calls.length,1); assert.equal(a.dataset.sharedState,'loading');
  assert.match(f.status(a).children[0].textContent,/불러오는 중/); assert.equal(f.status(a).children[1].hidden,true);
  t.mock.timers.tick(1499);await flush();assert.equal(f.calls.length,1);
  const c=f.add();await flush();assert.equal(f.calls.length,1,'mounting a copy must respect backoff');
  t.mock.timers.tick(1);await flush();assert.equal(f.calls.length,2);
  assert.equal(new Set([a.src,b.src,c.src]).size,1);
  assert.equal(a.dataset.sharedState,'loading','Blob delivery is not image decode');
  for(const img of [a,b,c]){img.loaded();assert.equal(img.dataset.sharedState,'ready');assert.equal(f.status(img).hidden,true);}
  assert.equal(a.attributes['aria-busy'],'false');
});

test('three attempts stay exhausted across visibility changes and remounts; user retry starts one shared bounded cycle',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let succeeds=false;
  const f=imageFixture(t,{fetchImage:()=>{if(!succeeds)throw Error('offline');return {size:10};}});
  const a=f.add();await flush();f.visible(a,false);
  t.mock.timers.tick(1000);f.visible(a,true);await flush();assert.equal(f.calls.length,1);
  t.mock.timers.tick(500);await flush();assert.equal(f.calls.length,2);
  f.detach(a);const b=f.add();await flush();assert.equal(f.calls.length,2);
  t.mock.timers.tick(3000);await flush();assert.equal(f.calls.length,3);
  assert.equal(b.dataset.sharedState,'failed');assert.equal(b.attributes['aria-busy'],'false');
  t.mock.timers.tick(60000);f.visible(b,false);f.visible(b,true);const c=f.add();await flush();
  assert.equal(f.calls.length,3);assert.equal(c.dataset.sharedState,'failed');
  f.retry(b);await flush();assert.equal(f.calls.length,4);
  t.mock.timers.tick(1500);await flush();t.mock.timers.tick(3000);await flush();
  assert.equal(f.calls.length,6);assert.equal(b.dataset.sharedState,'failed');assert.equal(c.dataset.sharedState,'failed');
  t.mock.timers.tick(60000);await flush();assert.equal(f.calls.length,6);
  succeeds=true;f.retry(c);await flush();assert.equal(f.calls.length,7);assert.equal(b.src,c.src);
  b.loaded();c.loaded();assert.equal(c.dataset.sharedState,'ready');
});

test('hidden or detached pending photos neither retry in the background nor lose their shared request on remount',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const gate=deferred();const f=imageFixture(t,{fetchImage:()=>gate.promise});
  const a=f.add();await flush();f.visible(a,false);
  f.detach(a);const b=f.add();await flush();assert.equal(f.calls.length,1);
  f.detach(b);gate.reject(Error('network'));await flush();t.mock.timers.tick(10000);await flush();
  assert.equal(f.calls.length,1);assert.equal(a.src,undefined);assert.equal(b.src,undefined);
  f.cache.fetchImage=async()=>({size:10});f.attach(b);await flush();b.loaded();assert.equal(b.dataset.sharedState,'ready');
});

test('a source revision changed before MutationObserver delivery cannot accept a stale Blob',async t=>{
  const old=deferred(),fresh=deferred();
  const f=imageFixture(t,{fetchImage:url=>url.includes('t=1&')?old.promise:fresh.promise});
  const a=f.add();await flush();a.dataset.sharedSrc='/ws/images/photo.png?t=2&preview=1';
  old.resolve({size:10});await flush();assert.equal(a.src,undefined);
  f.source(a,a.dataset.sharedSrc);await flush();fresh.resolve({size:10});await flush();a.loaded();
  assert.equal(a.dataset.sharedState,'ready');assert.equal(f.calls.length,2);
  f.source(a,'');assert.equal(a.src,undefined);assert.equal(a.dataset.sharedState,'unavailable');
});

test('detached queued images consume no retry budget and four downloads remain the limit',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const gates=Array.from({length:6},deferred);let active=0,peak=0;
  const f=imageFixture(t,{fetchImage:url=>{
    active++;peak=Math.max(peak,active);
    return gates[Number(new URL(url,'https://ercraft.net').searchParams.get('t'))].promise.finally(()=>active--);
  }});
  const images=Array.from({length:6},(_,i)=>f.add(`/ws/images/p${i}.png?t=${i}&preview=1`));
  await flush();assert.equal(f.calls.length,4);f.detach(images[4]);
  gates.slice(0,4).forEach(g=>g.resolve({size:10}));await flush();assert.equal(f.calls.length,5);
  f.attach(images[4]);await flush();assert.equal(f.calls.length,6,'no backoff for a request skipped before fetching');
  gates[4].resolve({size:10});gates[5].resolve({size:10});await flush();
  assert.equal(peak,4);images[4].loaded();assert.equal(images[4].dataset.sharedState,'ready');
});

test('decode failures expose retry and invalidate only the bad shared Blob without revoking a DOM reference',async t=>{
  const f=imageFixture(t);const a=f.add(),b=f.add();await flush();
  assert.equal(a.src,b.src);a.emit('error');
  assert.equal(a.src,undefined);assert.equal(b.src,undefined);assert.equal(f.revoked.length,1);
  assert.equal(a.dataset.sharedState,'failed');assert.equal(b.dataset.sharedState,'failed');
  f.retry(a);await flush();assert.equal(f.calls.length,2);assert.equal(a.src,b.src);assert.notEqual(a.src,f.revoked[0]);
  a.loaded();b.loaded();assert.equal(a.dataset.sharedState,'ready');
});

test('offscreen eviction and disconnect clear sources before revocation; late completion cannot write a detached image',async t=>{
  const late=deferred();const f=imageFixture(t,{maxIdleBytes:0,fetchImage:url=>url.includes('late')?late.promise:{size:10}});
  const a=f.add();await flush();a.loaded();f.visible(a,false);
  assert.equal(a.src,undefined);assert.equal(f.revoked.length,1);assert.equal(a.width,720);assert.equal(a.height,540);
  const b=f.add('/ws/images/late.png?preview=1');await flush();
  f.observer.disconnect();late.resolve({size:10});await flush();
  assert.equal(b.src,undefined);assert.equal(f.revoked.length,2);
});

test('compact workspace indicators do not nest buttons, and unrelated avatars get no photo UI',async t=>{
  const f=imageFixture(t);const photo=f.add(undefined,{eager:true,feedback:'compact'});
  const avatar=f.add('/assets/characters/eleven/avatar.png?preview=1',{eager:true});await flush();
  assert.equal(f.status(photo).children.length,1);assert.equal(f.status(avatar),undefined);
  photo.loaded();assert.equal(f.status(photo).hidden,true);
});

test('/chat image allowlist preserves preview and revision queries and rejects other origins or mount paths',t=>{
  imageFixture(t,{base:'/chat'});
  const origin='https://ercraft.net';
  for(const url of ['/chat/ws/images/a%20b.png?t=20-2144451&preview=1','/chat/ws/images/a.png?t=20-2144451','/chat/assets/characters/eleven/avatar.png?preview=1'])assert.equal(sharedImageUrl(url,origin),url);
  for(const url of ['/ws/images/a.png?preview=1','https://elsewhere.invalid/chat/ws/a.png?preview=1','//elsewhere.invalid/chat/ws/a.png','/chat/../ws/a.png','/chat/api/state?preview=1'])assert.equal(sharedImageUrl(url,origin),null);
});

test('actual workspace URL builder keeps revisions on previews and explicit originals without altering non-photo files',t=>{
  imageFixture(t,{base:'/chat'});
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const files=[{path:'images/a b.png',mtime:42,size:2144451},{path:'images/gone.png',available:false},{path:'stickers/a.png',sticker:true,mtime:1,size:20}];
  const helpers=source.slice(source.indexOf('const wsUrl ='),source.indexOf('// The dev session'));
  const build=vm.runInNewContext(`${helpers}\nworkspaceImageUrl`,{appUrl,S:{files}});
  assert.equal(build('images/a b.png'),'/chat/ws/images/a%20b.png?t=42-2144451&preview=1');
  assert.equal(build('images/a b.png',{original:true}),'/chat/ws/images/a%20b.png?t=42-2144451');
  assert.equal(build('images/new.jpg'),'/chat/ws/images/new.jpg?preview=1');
  assert.equal(build('images/gone.png'),'');
  assert.equal(build('stickers/a.png'),'/chat/ws/stickers/a.png?t=1-20');
  for(const path of ['page.html','motion.gif','drawing.svg'])assert.equal(build(path),`/chat/ws/${path}`);
});

test('timeline and workspace render previews; only explicit lightbox/link requests use originals, including file updates',async t=>{
  const f=imageFixture(t,{base:'/chat'});
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const nodes=Object.fromEntries(['#lbImg','#lbCap','#lightbox','#wsFiles','#stickerPop','#wsBadge'].map(key=>[key,f.doc.createElement(key==='#lbImg'?'img':'div')]));
  f.doc.append(...Object.values(nodes));nodes['#stickerPop'].hidden=true;
  const S={files:[{path:'images/photo.png',mtime:1,size:2144451}],openPath:'images/photo.png',freshFiles:new Set(),tab:'files'};
  const el=(tag,cls,html)=>{const node=f.doc.createElement(tag);node.className=cls;node.innerHTML=html;return node;};
  const scope=vm.createContext({S,appUrl,setSharedImage,el,locale:'ko-KR',IMG_EXT:['png','jpg','jpeg','webp','gif','svg'],
    extOf:p=>p.split('.').pop(),esc:String,t:key=>key,nameOf:String,ago:String,size:String,
    $:key=>nodes[key],document:{querySelectorAll:()=>f.doc.querySelectorAll().filter(img=>img.dataset.workspaceImage)},
    wsVisible:()=>true,renderWs:()=>{},setTimeout:()=>{},
  });
  vm.runInContext([
    section('const wsUrl =','// The dev session'),
    section('function buildAttach(a)','function buildTools('),
    section('function fileIcon(f)','function renderFileList('),
    section('async function renderViewer()','async function loadNotes()'),
    section('function lightbox(src',"$('#lightbox').onclick"),
  ].join('\n'),scope);
  const attachment=vm.runInContext("buildAttach({path: 'images/photo.png'})",scope);f.doc.append(attachment);
  const timeline=attachment.children[0];
  assert.equal(timeline.dataset.sharedSrc,'/chat/ws/images/photo.png?t=1-2144451&preview=1');
  assert.equal(timeline.dataset.sharedFeedback,'true');
  assert.match(vm.runInContext('fileIcon(S.files[0])',scope),/preview=1/);
  await vm.runInContext('renderViewer()',scope);
  const viewer=nodes['#wsFiles'].children[0],link=viewer.children[0].children[2],photo=viewer.children[1].children[0].children[0];
  assert.equal(photo.dataset.sharedSrc,timeline.dataset.sharedSrc);
  assert.equal(link.href,'/chat/ws/images/photo.png?t=1-2144451');assert.equal(link.textContent,'원본 열기');
  assert.equal(nodes['#lbImg'].dataset.sharedSrc,undefined,'original is not loaded when opening the workspace preview');
  timeline.onclick();
  assert.equal(nodes['#lbImg'].dataset.sharedSrc,link.href);assert.equal(nodes['#lbImg'].dataset.sharedFeedback,'true');
  vm.runInContext("onFiles([{path:'images/photo.png',mtime:2,size:2100000}])",scope);
  assert.equal(timeline.dataset.sharedSrc,'/chat/ws/images/photo.png?t=2-2100000&preview=1');
  assert.equal(photo.dataset.sharedSrc,timeline.dataset.sharedSrc);
  assert.equal(nodes['#lbImg'].dataset.sharedSrc,'/chat/ws/images/photo.png?t=2-2100000');
});
