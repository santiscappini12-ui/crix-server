'use strict';

// This process runs published ServerScripts in isolated V8 heaps. It has no
// access to the database or Socket.IO server; only validated JSON messages are
// exchanged with server.js over the child-process IPC channel.
let ivm;
try {
  ivm = require('isolated-vm');
} catch (error) {
    if (process.send) process.send({ type:'fatal', message:'No se pudo cargar isolated-vm: ' + error.message },()=>process.disconnect?.());
    else process.exit(1);
    process.exitCode = 1;
}

const rooms = new Map();
const MAX_ROOMS = 20;
const MAX_SCRIPTS_PER_ROOM = 8;
const MAX_SOURCE_CHARS = 32 * 1024;
const MAX_PARTS = 500;
const MAX_COMMANDS_PER_SECOND = 100;
const MAX_TICK_BUDGET_MS = 35;
const MAX_SCRIPT_CALL_MS = 25;
const TICK_MS = 50;

function send(message) {
  if (process.connected) process.send(message);
}

function cloneJson(value, fallback = null) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_) { return fallback; }
}

function finite(value, fallback = 0, min = -10000, max = 10000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function compileCrixScript(source) {
  return String(source || '').replace(/--[^\n]*/g, '')
    .replace(/\bfunction\s+([\w$]+(?:\.[\w$]+)*)\s*\(([^)]*)\)/g, 'function $1($2) {')
    .replace(/\blocal\s+(\w+)/g, 'let $1')
    .replace(/\bif\b\s*(.*?)\s*then/g, 'if ($1) {')
    .replace(/\bwhile\s+(.*?)\s+do/g, 'while ($1) {')
    .replace(/\bthen\b/g, '').replace(/\bdo\b/g, '{')
    .replace(/\bnot\s+/g, '!').replace(/\band\s+/g, '&& ')
    .replace(/\bor\s+/g, '|| ').replace(/\bnil\b/g, 'null')
    .replace(/\bprint\b/g, 'env.print').replace(/\bwarn\b/g, 'env.warn')
    .replace(/\berror\b/g, 'env.error').replace(/\bworkspace\b/g, 'env.workspace')
    .replace(/\bmath\b/g, 'env.math').replace(/\btonumber\b/g, 'env.tonumber')
    .replace(/\btostring\b/g, 'env.tostring').replace(/\.\./g, '+')
    .replace(/\bgame\b/g, 'env.game').replace(/\bend\b/g, '}');
}

function normalizePart(id, source = {}) {
  const position = source.position || {};
  const size = source.size || {};
  const types = ['Block','Sphere','Cylinder','Wedge','TrussPart','Spawn','ImportedMesh'];
  const materials = ['SmoothPlastic','Neon','Metal','Glass','Grass','Brick','Wood'];
  const type=types.includes(source.type)?source.type:'Block';
  const color = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(source.color || '')) ? String(source.color) : '#5b8def';
  const part={
    id:String(id).slice(0,120), name:String(source.name || 'Part').slice(0,80),
    type,
    x:finite(source.x ?? position.x ?? position.X),
    y:finite(source.y ?? position.y ?? position.Y),
    z:finite(source.z ?? position.z ?? position.Z),
    sx:finite(source.sx ?? size.x ?? size.X,4,0.1,1000),
    sy:finite(source.sy ?? size.y ?? size.Y,4,0.1,1000),
    sz:finite(source.sz ?? size.z ?? size.Z,4,0.1,1000),
    rx:finite(source.rx), ry:finite(source.ry), rz:finite(source.rz),
    color, material:materials.includes(source.material) ? source.material : 'SmoothPlastic',
    anchored:source.anchored === undefined ? true : source.anchored === true, canCollide:source.canCollide !== false,
    transparent:finite(source.transparent,0,0,0.95),
  };
  if(type==='ImportedMesh'&&typeof source.meshData==='string'&&source.meshData.length<=2*1024*1024)part.meshData=source.meshData;
  return part;
}

function normalizePlayers(players) {
  return (Array.isArray(players) ? players : []).slice(0,64).map(player => ({
    userId:String(player.userId || '').slice(0,100), username:String(player.username || 'Jugador').slice(0,30),
    x:finite(player.x), y:finite(player.y), z:finite(player.z), ry:finite(player.ry,-0,-1000,1000),
    position:{x:finite(player.x),y:finite(player.y),z:finite(player.z)}, rotationY:finite(player.ry),
    moving:!!player.moving, onGround:!!player.onGround,
  }));
}

function output(room, script, text, cls = '') {
  const now = Date.now();
  room.logs = room.logs.filter(time => now - time < 2000);
  if (room.logs.length >= 10) return;
  room.logs.push(now);
  send({ type:'output', roomId:room.id, script:String(script || 'Script').slice(0,80), text:String(text || '').slice(0,500), cls:cls === 'warn' ? 'warn' : cls === 'err' ? 'err' : '' });
}

function emitSceneCommand(room, command, payload) {
  const now = Date.now();
  room.commandTimes = room.commandTimes.filter(time => now - time < 1000);
  if (room.commandTimes.length >= MAX_COMMANDS_PER_SECOND) throw new Error('Límite de cambios del mundo alcanzado');
  room.commandTimes.push(now);
  const safePayload = cloneJson(payload, {});
  if (command === 'createPart') {
    if (room.parts.size >= MAX_PARTS) throw new Error('La instancia alcanzó el máximo de piezas');
    const roomSuffix=room.instanceId.replace(/[^a-z0-9]/ig,'').slice(-12)||'room';
    const id = `server-${roomSuffix}-${++room.nextPartId}`;
    const data = normalizePart(id, safePayload.data || {});
    room.parts.set(id, data);
    send({ type:'sceneCommand', roomId:room.id, command, payload:{ id, data } });
    return id;
  }
  const id = String(safePayload.id || '').slice(0,120);
  if (!id || !room.parts.has(id)) throw new Error('No existe la pieza ' + id);
  if (command === 'updatePart') {
    const current = room.parts.get(id);
    const patch = safePayload.patch && typeof safePayload.patch === 'object' ? safePayload.patch : {};
    const merged = { ...current, ...patch, id };
    if (patch.position) {
      for (const axis of ['x','y','z']) if (patch.position[axis] !== undefined || patch.position[axis.toUpperCase()] !== undefined) merged[axis] = patch.position[axis] ?? patch.position[axis.toUpperCase()];
    }
    if (patch.size) {
      for (const axis of ['x','y','z']) if (patch.size[axis] !== undefined || patch.size[axis.toUpperCase()] !== undefined) merged['s'+axis] = patch.size[axis] ?? patch.size[axis.toUpperCase()];
    }
    room.parts.set(id, normalizePart(id, merged));
    send({ type:'sceneCommand', roomId:room.id, command, payload:{ id, patch:cloneJson(patch,{}) } });
    return true;
  }
  if (command === 'destroyPart') {
    room.parts.delete(id);
    send({ type:'sceneCommand', roomId:room.id, command, payload:{ id } });
    return true;
  }
  throw new Error('Operación de mundo desconocida');
}

function bootstrapSource(modules) {
  return `
    globalThis.__crixScripts = [];
    globalThis.__crixPlayers = [];
    globalThis.__crixParts = [];
    const __emit = __crixEmit;
    const __getPlayers = __crixGetPlayers;
    const __getParts = __crixGetParts;
    const __log = __crixLog;
    const __moduleSources = ${JSON.stringify(modules)};
    const __moduleCache = new Map();
    const math = Math;
    const game = {
      createPart: props => __emit('createPart', { data: props || {} }),
      updatePart: (id, patch) => __emit('updatePart', { id, patch: patch || {} }),
      destroyPart: id => __emit('destroyPart', { id }),
      getPlayer: () => __getPlayers()[0] || null,
      getPlayers: () => __getPlayers()
    };
    game.CreatePart = game.createPart;
    game.UpdatePart = game.updatePart;
    game.DestroyPart = game.destroyPart;
    game.GetPlayer = game.getPlayer;
    game.GetPlayers = game.getPlayers;
    Object.freeze(game);
    const workspace = Object.freeze({
      getChildren: () => __getParts(),
      findFirstChild: name => __getParts().find(part => part.name === String(name)) || null,
      createPart: game.createPart, updatePart: game.updatePart, destroyPart: game.destroyPart,
      GetChildren: () => __getParts(), FindFirstChild: name => __getParts().find(part => part.name === String(name)) || null
    });
    const __waiters = [];
    const task = Object.freeze({
      wait: seconds => new Promise(resolve => __waiters.push({ left: Math.max(0, Math.min(30, Number(seconds) || 0)), callback:resolve })),
      delay: (seconds, callback) => { if (typeof callback !== 'function') throw new TypeError('task.delay necesita una función'); __waiters.push({ left: Math.max(0, Math.min(30, Number(seconds) || 0)), callback }); }
    });
    const print = (...values) => __log('info', values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
    const warn = (...values) => __log('warn', values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
    const error = (...values) => __log('err', values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
    const env = { game, workspace, math, task, print, warn, error, tonumber:value=>Number(value), tostring:value=>String(value) };
    function require(name) {
      const entry = __moduleSources.find(item => item.id === String(name) || item.name === String(name));
      if (!entry) throw new Error('No existe el ModuleScript: ' + name);
      if (__moduleCache.has(entry.id)) return __moduleCache.get(entry.id).exports;
      const module = { exports:{} };
      __moduleCache.set(entry.id, module);
      const result = new Function('env','game','workspace','math','task','print','warn','error','require','module','exports', entry.code + '\\n;return module.exports;')(env,game,workspace,math,task,print,warn,error,require,module,module.exports);
      if (result !== undefined) module.exports = result;
      return module.exports;
    }
    function __crixAdvance(dt) {
      for (let index=__waiters.length-1; index>=0; index--) {
        const waiter=__waiters[index]; waiter.left-=dt;
        if (waiter.left<=0) { __waiters.splice(index,1); try { waiter.callback(); } catch (err) { error(err && err.message || err); } }
      }
    }
    function __crixInvoke(eventName, dt, index) {
      const script=__crixScripts[index]; if (!script || script.disabled) return;
      try {
        const fn=script[eventName];
        if (typeof fn==='function') {
          if (eventName==='onUpdate') fn(dt,game.getPlayer(),game.getPlayers());
          else fn(game.getPlayer(),game.getPlayers());
        }
      } catch (err) { script.disabled=true; error(script.name+': '+(err && err.stack || err)); }
    }
    delete globalThis.__crixEmit; delete globalThis.__crixGetPlayers; delete globalThis.__crixGetParts; delete globalThis.__crixLog;
  `;
}

function createRoom(message) {
  if (!ivm) return null;
  if (rooms.has(message.roomId)) stopRoom(message.roomId);
  if (rooms.size >= MAX_ROOMS) throw new Error('El servidor llegó al límite de instancias con scripts activos');
  const scripts = (Array.isArray(message.scripts) ? message.scripts : [])
    .filter(script => script && script.type === 'Script' && typeof script.code === 'string')
    .slice(0, MAX_SCRIPTS_PER_ROOM);
  const modules = (Array.isArray(message.scripts) ? message.scripts : [])
    .filter(script => script && script.type === 'ModuleScript' && typeof script.code === 'string')
    .slice(0,40).map(script => ({ id:String(script.id || script.name), name:String(script.name || 'ModuleScript'), code:(script.language === 'crixscript' ? compileCrixScript(script.code) : script.code).slice(0,MAX_SOURCE_CHARS) }));
  const isolate = new ivm.Isolate({ memoryLimit:16 });
  const context = isolate.createContextSync();
  const room = {
    id:String(message.roomId), mapId:String(message.mapId), instanceId:String(message.instanceId),
    isolate, context, players:normalizePlayers(message.players), parts:new Map(), scripts,
    disabledScripts:new Set(), commandTimes:[], logs:[], nextPartId:0, busy:false, timer:null,
  };
  for (const part of (Array.isArray(message.parts) ? message.parts : []).slice(0,MAX_PARTS)) {
    if (!part || part.type === 'Spawn' || part.isNPC) continue;
    const id=String(part.id || 'map-part'); room.parts.set(id,normalizePart(id,part));
  }
  const jail=context.global;
  jail.setSync('global',jail.derefInto());
  jail.setSync('__crixEmit',new ivm.Callback((command,payload)=>emitSceneCommand(room,String(command),payload),{sync:true}));
  jail.setSync('__crixGetPlayers',new ivm.Callback(()=>room.players,{sync:true}));
  jail.setSync('__crixGetParts',new ivm.Callback(()=>Array.from(room.parts.values()),{sync:true}));
  jail.setSync('__crixLog',new ivm.Callback((cls,text)=>output(room,room.currentScriptName || 'Servidor',text,cls),{sync:true}));
  context.evalSync(bootstrapSource(modules),{timeout:1000});
  const enabled = [];
  scripts.forEach((script,index)=>{
    if (String(script.code).length > MAX_SOURCE_CHARS) {
      output(room,script.name,'El script supera el límite de '+MAX_SOURCE_CHARS+' caracteres','err');
      context.evalSync(`globalThis.__crixScripts.push({name:${JSON.stringify(String(script.name||'ServerScript'))},disabled:true});`);
      return;
    }
    const code=script.language==='crixscript'?compileCrixScript(script.code):script.code;
    const name=JSON.stringify(String(script.name || 'ServerScript_'+index).slice(0,80));
    try {
      context.evalSync(`(function(){\n${code}\n;globalThis.__crixScripts.push({name:${name},onStart:typeof onStart==='function'?onStart:null,onUpdate:typeof onUpdate==='function'?onUpdate:null,onStop:typeof onStop==='function'?onStop:null});\n})();`,{timeout:MAX_SCRIPT_CALL_MS});
      enabled.push(index);
    } catch (error) { output(room,script.name,error.message,'err');context.evalSync(`globalThis.__crixScripts.push({name:${name},disabled:true});`); }
  });
  room.enabledScripts=enabled;
  rooms.set(room.id,room);
  for (const index of room.enabledScripts) invoke(room,'onStart',index,0);
  room.timer=setInterval(()=>tick(room),TICK_MS);
  send({type:'started',roomId:room.id,scriptCount:room.enabledScripts.length});
  return room;
}

function invoke(room,eventName,index,dt) {
  if (room.disabledScripts.has(index) || room.isolate.isDisposed) return;
  room.currentScriptName=room.scripts[index]?.name || 'ServerScript';
  try {
    const budget=Math.max(1,MAX_SCRIPT_CALL_MS);
    room.context.evalSync(`globalThis.__crixInvoke(${JSON.stringify(eventName)},${finite(dt,0,0,1)},${index});`,{timeout:budget});
  } catch (error) {
    room.disabledScripts.add(index);
    output(room,room.scripts[index]?.name,error.message,'err');
  } finally { room.currentScriptName=''; }
}

function tick(room) {
  if (room.busy || !room.players.length || room.isolate.isDisposed) return;
  room.busy=true;
  try {
    room.context.evalSync(`globalThis.__crixPlayers=${JSON.stringify(room.players)};globalThis.__crixAdvance(${TICK_MS/1000});`,{timeout:MAX_SCRIPT_CALL_MS});
    const deadline=Date.now()+MAX_TICK_BUDGET_MS;
    for (const index of room.enabledScripts) {
      const remaining=deadline-Date.now();
      if (remaining<2) break;
      invokeWithTimeout(room,'onUpdate',index,TICK_MS/1000,Math.min(MAX_SCRIPT_CALL_MS,remaining));
    }
  } catch (error) { output(room,'Servidor','Error del entorno: '+error.message,'err'); }
  finally { room.busy=false; }
}

function invokeWithTimeout(room,eventName,index,dt,timeout) {
  if (room.disabledScripts.has(index) || room.isolate.isDisposed) return;
  room.currentScriptName=room.scripts[index]?.name || 'ServerScript';
  try {
    room.context.evalSync(`globalThis.__crixInvoke(${JSON.stringify(eventName)},${finite(dt,0,0,1)},${index});`,{timeout});
  } catch (error) {
    room.disabledScripts.add(index);
    output(room,room.scripts[index]?.name,error.message,'err');
  } finally { room.currentScriptName=''; }
}

function stopRoom(roomId) {
  const room=rooms.get(String(roomId)); if (!room) return;
  if (room.timer) clearInterval(room.timer);
  for (const index of room.enabledScripts || []) invoke(room,'onStop',index,0);
  rooms.delete(String(roomId));
  try { room.isolate.dispose(); } catch (_) {}
  send({type:'stopped',roomId:String(roomId)});
}

if (ivm) {
  process.on('message',message=>{
    if (!message || typeof message !== 'object') return;
    try {
      if (message.type==='start') createRoom(message);
      else if (message.type==='players') {
        const room=rooms.get(String(message.roomId)); if (room) room.players=normalizePlayers(message.players);
      } else if (message.type==='worldPart') {
        const room=rooms.get(String(message.roomId));
        if (room && message.part?.id) room.parts.set(String(message.part.id),normalizePart(message.part.id,message.part));
      } else if (message.type==='worldPosition') {
        const room=rooms.get(String(message.roomId)),part=room?.parts.get(String(message.part?.id||''));
        if(part){part.x=finite(message.part.x,part.x);part.y=finite(message.part.y,part.y);part.z=finite(message.part.z,part.z);}
      } else if (message.type==='worldRemove') {
        const room=rooms.get(String(message.roomId)); if (room) room.parts.delete(String(message.id || ''));
      } else if (message.type==='stop') stopRoom(message.roomId);
      else if (message.type==='shutdown') { for (const id of [...rooms.keys()]) stopRoom(id); process.disconnect?.(); }
    } catch (error) { send({type:'roomError',roomId:String(message.roomId || ''),message:error.message || String(error)}); }
  });
  send({type:'ready'});
}

process.on('disconnect',()=>{ for (const id of [...rooms.keys()]) stopRoom(id); process.exit(0); });
