                                                                            
                                                                             
                                                                             
                                                                           
const types = {void: '', float: 'f32', int: 'i32', uint: 'u32', bool: 'bool',
  vec2: 'vec2f', vec3: 'vec3f', vec4: 'vec4f', ivec2: 'vec2i', ivec3: 'vec3i',
  ivec4: 'vec4i', uvec2: 'vec2u', uvec3: 'vec3u', uvec4: 'vec4u', mat3: 'mat3x3f', mat4: 'mat4x4f'};
const uniforms = {uNoiseAnchor: 'terrainParams.noiseAnchor', uTerrainExtent: 'terrainParams.extent',
  uHistory: 'terrainHistory', uState: 'terrainState', uContext: 'terrainContextField',
  uFlow: 'terrainFlow', uEcology: 'terrainEcology', uCoastalSurface: 'terrainCoastal',
  uCoastalSurfaceEnabled: 'terrainParams.coastalEnabled', uDetail: 'terrainParams.detail',
  uInfluence: 'terrainParams.influence', uVegetation: 'terrainParams.vegetation', uTerrainMode: 'terrainParams.mode',
  cameraPosition: 'frame.cameraPos', PI: 'PI'};
const precedence = {'=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '?': 2,
  '||': 3, '&&': 4, '|': 5, '^': 6, '&': 7, '==': 8, '!=': 8,
  '<': 9, '>': 9, '<=': 9, '>=': 9, '<<': 10, '>>': 10, '+': 11, '-': 11, '*': 12, '/': 12, '%': 12};
const token = /\s+|(?:0x[\da-fA-F]+[uU]?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[uU]?)|[A-Za-z_]\w*|(?:\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||[+*/-]=)|[{}()[\];,.?:+*/%<>=!~&|^-]/y;

export function translateTerrainGLSL(source) {
                                                                                   
                                                           
  source = source.replace(/\bdiagnostic\b/g, 'apsDiagnosticValue').replace(/\btarget\b/g, 'apsTargetValue');
  if (typeof source !== 'string') throw Error('Terrain GLSL source required');
                                                                          
                                                                               
  source = source.replace('normalize(transpose(mat3(viewMatrix))*terrainCtx.normal)', 'normalize(terrainCtx.normal)')
    .replace('normalize(mat3(viewMatrix)*microN)', 'normalize(microN)');
  source = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
  const ts = []; let offset = 0;
  while (offset < source.length) {
    token.lastIndex = offset; const m = token.exec(source);
    if (!m) throw Error('Unsupported terrain GLSL near: ' + source.slice(offset, offset + 70));
    if (!/^\s+$/.test(m[0])) ts.push(m[0]); offset = token.lastIndex;
  }
  let i = 0, pointers = new Set();
  const custom = new Set(['PrincipledMaterial', 'MaterialContext']);
  const functions = new Map();
                                                               
  for (let j = 0; j < ts.length; j++) {
    if (ts[j] === 'struct') custom.add(ts[j + 1]);
    if (ts[j] === 'const') custom.add(ts[j + 2]);
    if ((ts[j] in types || custom.has(ts[j])) && /^\w+$/.test(ts[j + 1] || '') && ts[j + 2] === '(') {
      const args = []; let k = j + 3, n = 0;
      while (ts[k] !== ')' && k < ts.length) { if (ts[k] === 'inout') args.push(n); if (ts[k] === ',') n++; k++; }
      if (ts[k + 1] === '{') { custom.add(ts[j + 1]); functions.set(ts[j + 1], args); }
    }
  }
  const id = s => pointers.has(s) ? '(*' + s + ')' : uniforms[s] || (custom.has(s) ? 'apsT_' + s : s);
  const type = s => types[s] ?? (custom.has(s) ? 'apsT_' + s : (() => { throw Error('Unsupported terrain type ' + s); })());
  const take = s => { if (ts[i] !== s) throw Error(`Terrain GLSL expected ${s}, got ${ts[i]} at token ${i}`); i++; };
  const number = s => s.endsWith('u') || s.endsWith('U') ? s.toLowerCase() : s.startsWith('.') ? '0' + s : s.endsWith('.') ? s + '0' : s;
  function expression(min = 0) {
    let a;
    const t = ts[i++];
    if (['-', '+', '!', '~'].includes(t)) a = '(' + t + expression(13) + ')';
    else if (t === '(') { a = '(' + expression() + ')'; take(')'); }
    else if (/^(?:\d|\.)/.test(t || '')) a = number(t);
    else if (/^[A-Za-z_]\w*$/.test(t || '')) {
      if (ts[i] === '(') {
        i++; const args = [];
        if (ts[i] !== ')') { do { args.push(expression()); if (ts[i] !== ',') break; i++; } while (true); }
        take(')');
        if (t === 'texture') a = `textureSample(${args[0]}, smpLinearClamp, ${args[1]})`;
        else if (t === 'textureSize') a = `vec2i(textureDimensions(${args.join(', ')}))`;
        else if (t === 'texelFetch') a = `textureLoad(${args.join(', ')})`;
        else if (t === 'mat3' && args.length === 9) a = `mat3x3f(${[0, 3, 6].map(k => 'vec3f(' + args.slice(k, k + 3).join(', ') + ')').join(', ')})`;
        else {
          const name = {dFdx: 'dpdx', dFdy: 'dpdy'}[t] || (t in types ? type(t) : id(t));
          for (const k of functions.get(t) || []) args[k] = '&' + args[k];
                                                                          
                                                                            
          a = name + '(' + args.join(', ') + ')';
        }
      } else a = id(t);
    } else throw Error('Unsupported terrain expression token ' + t);
    while (true) {
      const op = ts[i];
      if (op === '.') { i++; a += '.' + ts[i++]; continue; }
      if (op === '[') { i++; a += '[' + expression() + ']'; take(']'); continue; }
      if (op === '++' || op === '--') { i++; a += op; continue; }
      const p = precedence[op]; if (p === undefined || p < min) break;
      i++;
      if (op === '?') { const yes = expression(); take(':'); const no = expression(p); a = `select(${no}, ${yes}, ${a})`; }
      else { const b = expression(p + (p === 1 ? 0 : 1)); a = p === 1 ? `${a} ${op} ${b}` : `(${a} ${op} ${b})`; }
    }
    return a;
  }
  function declaration(global = false, semicolon = true) {
    const constant = ts[i] === 'const'; if (constant) i++;
    const ty = type(ts[i++]), lines = [];
    do {
      const name = id(ts[i++]); let dt = ty;
      if (ts[i] === '[') { i++; const n = ts[i++]; take(']'); dt = `array<${ty}, ${n}>`; }
      let init = ''; if (ts[i] === '=') { i++; init = ' = ' + expression(); }
      lines.push(`${constant ? 'const' : 'var'} ${name}: ${dt}${init}`);
      if (ts[i] !== ',') break; i++;
    } while (true);
    if (semicolon) take(';');
    if (!semicolon && lines.length !== 1) throw Error('Unsupported multiple for declarations');
    if (global && !constant) throw Error('Unsupported terrain global variable');
    return lines.join(';\n') + (semicolon ? ';\n' : '');
  }
  function block() { take('{'); let s = '{\n'; while (ts[i] !== '}') s += statement(); take('}'); return s + '}\n'; }
  function wrapped() { return ts[i] === '{' ? block() : '{\n' + statement() + '}\n'; }
  function statement() {
    const t = ts[i];
    if (t === '{') return block();
    if (t === 'if') { i++; take('('); const c = expression(); take(')'); let s = `if (${c}) ` + wrapped(); if (ts[i] === 'else') { i++; s += 'else ' + wrapped(); } return s; }
    if (t === 'for') {
      i++; take('('); const start = declaration(false, false); take(';'); const cond = expression(); take(';'); const inc = expression(); take(')');
      return `for (${start}; ${cond}; ${inc}) ` + wrapped();
    }
    if (t === 'return') { i++; const e = ts[i] === ';' ? '' : ' ' + expression(); take(';'); return 'return' + e + ';\n'; }
    if (t === 'const' || t in types || custom.has(t) && ts[i + 1] !== '(') return declaration();
    const e = expression(); take(';'); return e + ';\n';
  }
  let out = '';
  while (i < ts.length) {
    if (ts[i] === 'uniform') {
      i += 2;
      do { const n = ts[i++]; if (!(n in uniforms)) throw Error('Unsupported terrain uniform ' + n); if (ts[i] !== ',') break; i++; } while (true);
      take(';'); continue;
    }
    if (ts[i] === 'struct') {
      i++; const name = id(ts[i++]); take('{'); out += `struct ${name} {\n`;
      while (ts[i] !== '}') { const ty = type(ts[i++]), field = ts[i++]; take(';'); out += `${field}: ${ty},\n`; }
      take('}'); take(';'); out += '};\n'; continue;
    }
    if (ts[i] === 'const') { out += declaration(true); continue; }
    const ty = type(ts[i++]), name = ts[i++]; take('('); const params = []; pointers = new Set();
    if (ts[i] !== ')') {
      do {
        const pointer = ts[i] === 'inout'; if (pointer) i++;
        const pt = type(ts[i++]), pn = ts[i++]; if (pointer) pointers.add(pn);
        params.push(pn + ': ' + (pointer ? `ptr<function, ${pt}>` : pt));
        if (ts[i] !== ',') break; i++;
      } while (true);
    }
    take(')'); out += `fn ${id(name)}(${params.join(', ')})${ty ? ' -> ' + ty : ''} ` + block(); pointers = new Set();
  }
                                                                        
                                                                          
  out = out.replace(/fn apsT_toLinear\([\s\S]*?\n}\n/, `fn apsT_toLinear(c: vec3f) -> vec3f {\nreturn select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c >= vec3f(0.04045));\n}\n`)
    .replace(/fn apsT_toSrgb\([\s\S]*?\n}\n/, `fn apsT_toSrgb(c: vec3f) -> vec3f {\nreturn select(c * 12.92, 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, c >= vec3f(0.0031308));\n}\n`)
    ;
                                                                              
  out = out.replace(/\bstep\(/g, 'apsT_step(');
  if (/\b(viewMatrix|step|texture|texelFetch|textureSize|inout)\b/.test(out)) throw Error('Untranslated terrain GLSL feature');
  return 'fn apsT_step(edge: f32, x: f32) -> f32 { return select(0.0, 1.0, x >= edge); }\n' + out;
}
