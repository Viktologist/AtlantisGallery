                                                                                   
const types={float:'f32',int:'i32',uint:'u32',bool:'bool',vec2:'vec2f',vec3:'vec3f',vec4:'vec4f',ivec2:'vec2i',ivec3:'vec3i',ivec4:'vec4i',uvec2:'vec2u',uvec3:'vec3u',uvec4:'vec4u',mat2:'mat2x2f',mat3:'mat3x3f',mat4:'mat4x4f',PrincipledMaterial:'APSPrincipled',MaterialContext:'APSContext',void:'void'};
const scalars=['metallic','roughness','occlusion','specular','specularTint','anisotropy','subsurface','sheen','sheenTint','clearcoat','clearcoatGloss','subsurfaceColorWeight','diffuseTransmission','transmissionThickness'];
const structs={APSPrincipled:Object.fromEntries([...scalars.map(k=>[k,'f32']),...['baseColor','normal','emission','subsurfaceColor','clearcoatNormal','transmissionColor'].map(k=>[k,'vec3f'])]),APSContext:{source:'APSPrincipled',normal:'vec3f',tangent:'vec3f',bitangent:'vec3f',position:'vec3f',worldPosition:'vec3f',viewPosition:'vec3f',uv:'vec2f',uvFootprint:'vec2f',footprint_m:'f32',opacity:'f32'}};
const width=t=>Number(/^vec([234])[fiu]$/.exec(t)?.[1]??0);
const numeric=t=>['f32','i32','u32'].includes(t)||width(t)||/^mat/.test(t);
const value=(code,type,lvalue=false)=>({code,type,lvalue});
                                                                             
                                                                               
                                              
                                             
const wgslReserved=new Set(`alias break case const const_assert continue continuing default diagnostic discard else enable false fn for if let loop override requires return struct switch true var while
NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become cast catch class co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation non_coherent noncoherent noperspective null nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set shared sizeof smooth snorm static static_assert static_cast std subroutine super target template this thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl where with writeonly yield`.split(/\s+/));
const emittedSymbol=name=>wgslReserved.has(name)||name==='_'||name.startsWith('__')?'apsReserved_'+name:name;
function tokensOf(source) {
  if(typeof source!=='string')throw Error('Expected GLSL source string');
  const s=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  const re=/\s*(\+\+|--|\+=|-=|\*=|\/=|%=|==|!=|<=|>=|&&|\|\||[A-Za-z_]\w*|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[uU]?|[{}\[\]()+\-*/%.,;=<>!?:])/gy;
  const out=[];let offset=0;
  while(s.slice(offset).trim()) {re.lastIndex=offset;const m=re.exec(s);if(!m)throw Error(`Unsupported syntax near ${s.slice(offset,offset+32)}`);out.push(m[1]);offset=re.lastIndex;}
  return out;
}
const builtinUnary=new Set(['sin','cos','tan','asin','acos','exp','exp2','log','log2','sqrt','abs','floor','ceil','fract','normalize','sign','round','trunc','inverseSqrt','degrees','radians','fwidth','dFdx','dFdy','sinh','cosh','tanh']);
const rename={inversesqrt:'inverseSqrt',dFdx:'dpdx',dFdy:'dpdy',principledMaterialDefaults:'apsPrincipledDefaults',principledSanitize:'apsSanitize',principledTangent:'apsTangent',disneyFifth:'apsFifth',disneyVisibility:'apsVisibility'};
function cast(e,t) {
  if(e.type===t)return e.code;
  if(numeric(e.type)&&numeric(t)&&(!width(e.type)||width(e.type)===width(t))&&!/^mat/.test(e.type)&&!/^mat/.test(t))return `${t}(${e.code})`;
  throw Error(`Incompatible material types ${e.type} / ${t}`);
}
function common(a,b) {if(a===b)return a;if(width(a)||width(b)){const t=width(a)?a:b;if(width(a)&&width(b)&&a!==b)throw Error('Incompatible vector operands');return t;}if(numeric(a)&&numeric(b))return a==='f32'||b==='f32'?'f32':a==='u32'&&b==='u32'?'u32':'i32';throw Error('Incompatible operands');}
export function compileMaterialProgram(body,{materialLibrary='',textures={},lygia=false,floatUniformPrefix=null}={}) {
  try {
    if(floatUniformPrefix!==null&&!/^[A-Za-z_]\w*$/.test(floatUniformPrefix))throw Error('Invalid float uniform prefix');
    const floatUniforms={};
    const functions=new Map([
      ['principledMaterialDefaults',{name:'apsPrincipledDefaults',args:['vec3f'],type:'APSPrincipled'}],
      ['principledSanitize',{name:'apsSanitize',args:['APSPrincipled','vec3f'],type:'APSPrincipled'}],
      ['principledTangent',{name:'apsTangent',args:['vec3f','vec3f'],type:'vec3f'}],
      ['apsNativeDiffuse',{name:'apsDiffuseDirect',args:['APSPrincipled','vec3f','vec3f'],type:'vec3f'}],
      ['apsNativeGlossy',{name:'apsGlossyDirect',args:['APSPrincipled','vec3f','vec3f'],type:'vec3f'}],
      ['disneyFifth',{name:'apsFifth',args:['f32'],type:'f32'}],
      ['disneyVisibility',{name:'apsVisibility',args:['f32','f32','f32','vec2f'],type:'f32'}],
    ]);
    if(lygia)for(const [name,signature] of [
      ['apsSurfaceNoise',{name:'apsLygia_filteredFbm3',args:['vec3f','f32','f32','i32'],type:'f32'}],
      ['apsSurfaceGradient',{name:'apsLygia_filteredGradient3',args:['vec3f','f32','f32','i32'],type:'vec4f'}],
      ['apsSurfaceRandom',{name:'apsLygia_random3',args:['vec3f'],type:'f32'}],
    ])functions.set(name,signature);
    const globals={PI:'f32',TWO_PI:'f32'};const libraryTokens=tokensOf(materialLibrary);
                                                                             
    for(let i=0,depth=0;i<libraryTokens.length;i++) {
      const t=libraryTokens[i];if(t==='{')depth++;if(t==='}')depth--;
      if(depth===0&&types[t]&&libraryTokens[i+2]==='(') {
        const args=[];let j=i+3;while(libraryTokens[j]!==')') {
          if(['const','in'].includes(libraryTokens[j]))j++;
          const at=types[libraryTokens[j++]];if(!at)throw Error('Unsupported helper parameter type');j++;
          args.push(at);if(libraryTokens[j]===',')j++;else if(libraryTokens[j]!==')')throw Error('Unsupported helper parameter');
        }
        const name=libraryTokens[i+1];if(functions.has(name))throw Error(`Conflicting helper ${name}`);
        functions.set(name,{name:'apsAuthored_'+name,args,type:types[t]});
      }
    }
    class Parser {
      constructor(tokens,env,returnType){this.ts=tokens;this.p=0;this.env={...globals,...env};this.returnType=returnType;this.returns=0;this.parameterizeFloats=false;}
      peek(){return this.ts[this.p];}take(){return this.ts[this.p++];}need(t){if(this.take()!==t)throw Error(`Expected ${t}`);}
      expr(min=0) {
        let e;const token=this.take();
        if(['-','+','!'].includes(token)){const a=this.expr(80);if(token==='!'&&a.type!=='bool')throw Error('Expected boolean');e=value(token==='+'?a.code:`(${token}${a.code})`,a.type);}
        else if(token==='('){e=this.expr();this.need(')');}
        else if(token==='true'||token==='false')e=value(token,'bool');
        else if(token&&/^(\d|\.\d)/.test(token)){
          const u=/u$/i.test(token),flt=/[.eE]/.test(token);if(!Number.isFinite(Number(u?token.slice(0,-1):token)))throw Error('Nonfinite shader literal');e=value(u?token.slice(0,-1)+'u':flt?(String(Number(token)).match(/[.eE]/)?String(Number(token)):String(Number(token))+'.0'):token,u?'u32':flt?'f32':'i32');
          if(flt&&!u&&this.parameterizeFloats){const name=floatUniformPrefix+Object.keys(floatUniforms).length;floatUniforms[name]=['f32',Number(token)];e=value('mat.'+name,'f32');}
        } else if(this.peek()==='(') {
          this.take();const args=[];if(this.peek()!==')')do{args.push(this.expr());}while(this.peek()===','&&this.take());this.need(')');e=this.call(token,args);
        } else {if(!this.env[token]&&!textures[token])throw Error(`Unsupported symbol ${token}`);e=value(textures[token]?token:emittedSymbol(token),this.env[token]??'texture',!textures[token]&&token!=='ctx');}
        for(;;) {
          if(this.peek()==='.') {
            this.take();const f=this.take();let type=structs[e.type]?.[f];
            if(width(e.type)&&/^(?:[xyzw]+|[rgba]+|[stpq]+)$/.test(f)&&f.length<=4){const letters=f[0].match(/[xyzw]/)?'xyzw':f[0].match(/[rgba]/)?'rgba':'stpq';if([...f].every(c=>letters.indexOf(c)<width(e.type)))type=f.length===1?({f:'f32',i:'i32',u:'u32'}[e.type.at(-1)]):`vec${f.length}${e.type.at(-1)}`;}
            if(!type)throw Error(`Unsupported field ${f}`);const vector=width(e.type),base=e;const mapped=vector?f.replace(/[stpq]/g,c=>'xyzw'['stpq'.indexOf(c)]):f;e=value(`${base.code}.${mapped}`,type,base.lvalue);if(vector&&f.length>1)e.swizzle={base:base.code,fields:mapped};continue;
          }
          if(this.peek()==='['){this.take();const index=this.expr();this.need(']');if(!['i32','u32'].includes(index.type))throw Error('Noninteger subscript');let type;if(width(e.type))type={f:'f32',i:'i32',u:'u32'}[e.type.at(-1)];else type=/^array<(.+),\d+>$/.exec(e.type)?.[1]??(/^mat([234])/.test(e.type)?`vec${e.type[3]}f`:null);if(!type)throw Error('Unsupported subscript');e=value(`${e.code}[${index.code}]`,type,e.lvalue);continue;}
          const op=this.peek(),prec={'||':5,'&&':6,'==':10,'!=':10,'<':15,'>':15,'<=':15,'>=':15,'+':30,'-':30,'*':40,'/':40,'%':40}[op];
          if(prec===undefined||prec<min)break;
          this.take();const b=this.expr(prec+1);
          if(op==='&&'||op==='||'){if(e.type!=='bool'||b.type!=='bool')throw Error('Expected boolean operands');e=value(`(${e.code}${op}${b.code})`,'bool');continue;}
          if(op==='*'&&(/^mat/.test(e.type)||/^mat/.test(b.type))){const mat=/^mat/.test(e.type)?e:b,other=mat===e?b:e;const n=Number(mat.type[3]);if(other.type!==mat.type&&other.type!==`vec${n}f`&&other.type!=='f32'&&other.type!=='i32')throw Error('Incompatible matrix product');e=value(`(${e.code}*${b.code})`,/^mat/.test(other.type)||!width(other.type)?mat.type:other.type);continue;}
          const t=common(e.type,b.type);if(['<','>','<=','>=','==','!='].includes(op)&&width(t))throw Error('GLSL vector comparisons require relational builtins');
                                                                                     
          e=value(`(${cast(e,t)}${op}${cast(b,t)})`,['<','>','<=','>=','==','!='].includes(op)?'bool':t);
        }
        if(min===0&&this.peek()==='?') {
          this.take();const yes=this.expr();this.need(':');const no=this.expr();if(e.type!=='bool')throw Error('Nonboolean conditional');const t=common(yes.type,no.type);if(!numeric(t)&&t!=='bool')throw Error('Unsupported aggregate conditional');e=value(`select(${cast(no,t)},${cast(yes,t)},${e.code})`,t);
        }
        return e;
      }
      call(name,args) {
        if(types[name]) {
          const type=types[name];if(type==='void'||type.startsWith('APS'))throw Error('Unsupported struct constructor');
          if(/^mat/.test(type)&&args.length===1&&['f32','i32','u32'].includes(args[0].type)){
            const n=Number(type[3]),x=cast(args[0],'f32'),cols=Array.from({length:n},(_,i)=>`vec${n}f(${Array.from({length:n},(_,j)=>i===j?x:'0.0').join(',')})`);return value(`${type}(${cols.join(',')})`,type);
          }
          const n=width(type);if(n&&!(args.length===1&&(!width(args[0].type)||width(args[0].type)===n))&&args.reduce((s,a)=>s+(width(a.type)||1),0)!==n)throw Error('Invalid vector constructor');
          return value(`${type}(${args.map(a=>width(a.type)?a.code:cast(a,type==='bool'?'bool':type.endsWith('i')||type==='i32'?'i32':type.endsWith('u')||type==='u32'?'u32':'f32')).join(',')})`,type);
        }
        if(functions.has(name)) {const f=functions.get(name);if(args.length!==f.args.length)throw Error(`Invalid ${name} argument count`);return value(`${f.name}(${args.map((a,i)=>cast(a,f.args[i])).join(',')})`,f.type);}
        if(['texture','texture2D','textureLod'].includes(name)) {
          const binding=textures[args[0]?.code];if(!binding||args.length!==(name==='textureLod'?3:2)||args[1].type!=='vec2f')throw Error('Texture call needs a bound sampler2D and vec2 UV');
          const layer=binding.layer;
          if(layer!==undefined&&layer!==null&&(!Number.isInteger(layer)||layer<0))throw Error(`Invalid texture array layer ${layer}`);
          const array=layer===undefined||layer===null?'':`,${binding.layerExpression??`${layer}u`}`;
          return value(name==='textureLod'?`textureSampleLevel(${binding.name},${binding.samplerName},${args[1].code}${array},${cast(args[2],'f32')})`:`textureSample(${binding.name},${binding.samplerName},${args[1].code}${array})`,'vec4f');
        }
        name=rename[name]??name;
        if(builtinUnary.has(name)||name==='dpdx'||name==='dpdy') {if(args.length!==1||!numeric(args[0].type))throw Error(`Invalid ${name}`);let t=args[0].type;if(['i32','u32'].includes(t)&&!['abs','sign'].includes(name))t='f32';return value(`${name}(${cast(args[0],t)})`,t);}
        if(name==='atan'&&args.length===1)return value(`atan(${cast(args[0],width(args[0].type)?args[0].type:'f32')})`,width(args[0].type)?args[0].type:'f32');
        if(['min','max','pow','step','mod','atan','distance','dot','cross','reflect','mix','clamp','smoothstep','faceforward','refract'].includes(name)) {
          const count={mix:3,clamp:3,smoothstep:3,faceforward:3,refract:3}[name]??2;if(args.length!==count)throw Error(`Invalid ${name} arguments`);
          let t=args.reduce((t,a)=>common(t,a.type),args[0].type);if(['pow','step','atan','mod','smoothstep','mix'].includes(name)&&['i32','u32'].includes(t))t='f32';
          const codes=args.map(a=>cast(a,t));if(name==='mod')return value(`(${codes[0]}-${codes[1]}*floor(${codes[0]}/${codes[1]}))`,t);
          if(name==='refract')codes[2]=cast(args[2],'f32');
          return value(`${name==='atan'?'atan2':name}(${codes.join(',')})`,['dot','distance'].includes(name)?'f32':t);
        }
        if(['length','determinant','transpose','any','all','not'].includes(name)) {if(args.length!==1)throw Error(`Invalid ${name}`);return value(`${name==='not'?'!':name}(${args[0].code})`,['length','determinant'].includes(name)?'f32':['any','all'].includes(name)?'bool':args[0].type);}
        throw Error(`Unsupported function ${name}`);
      }
      declaration(terminator=';') {
        const constant=this.peek()==='const';if(constant)this.take();const type=types[this.take()];if(!type||type==='void')throw Error('Unsupported declaration');const out=[];
        do {
          const name=this.take();if(!/^[A-Za-z_]\w*$/.test(name)||this.env[name]||name.startsWith('aps'))throw Error('Invalid/redeclared local name');let t=type;
          if(this.peek()==='['){this.take();const n=this.take();if(!/^\d+$/.test(n)||Number(n)<1)throw Error('Array size must be positive literal');this.need(']');t=`array<${type},${n}>`;}
          let init='';if(this.peek()==='='){this.take();init=' = '+cast(this.expr(),t);}else if(constant)throw Error('Constant needs initializer');
          this.env[name]=t;out.push(`${constant?'let':'var'} ${emittedSymbol(name)}: ${t}${init};`);
        }while(this.peek()===','&&this.take());
        this.need(terminator);return out.join('\n');
      }
      simple(terminator=';') {
        if(types[this.peek()]||this.peek()==='const')return this.declaration(terminator);
        if(this.peek()==='++'||this.peek()==='--'){const op=this.take(),lhs=this.expr();if(!lhs.lvalue)throw Error('Invalid prefix increment');this.need(terminator);return `${lhs.code} ${op==='++'?'+=':'-='} ${cast(value('1','i32'),lhs.type)};`;}
        const lhs=this.expr();let out;const op=this.take();
        if(['=','+=','-=','*=','/=','%='].includes(op)) {if(!lhs.lvalue)throw Error('Assignment needs writable local');const rhs=this.expr();if(lhs.swizzle){const {base,fields}=lhs.swizzle;if(new Set(fields).size!==fields.length)throw Error('Repeated writable swizzle component');const temp='apsSwizzle'+this.p;out=`let ${temp}: ${lhs.type} = ${cast(rhs,lhs.type)};\n`+[...fields].map((f,i)=>`${base}.${f} ${op} ${temp}.${'xyzw'[i]};`).join('\n');}else out=`${lhs.code} ${op} ${cast(rhs,lhs.type)};`;}
        else if(op==='++'||op==='--'){if(!lhs.lvalue||!numeric(lhs.type))throw Error('Invalid increment');out=`${lhs.code} ${op==='++'?'+=':'-='} ${cast(value('1','i32'),lhs.type)};`;}
        else if(op===terminator){return `${lhs.code};`;}
        else throw Error(`Unsupported statement ${op}`);
        this.need(terminator);return out;
      }
      block() {
        this.need('{');const env={...this.env},out=[];while(this.peek()!=='}'){if(this.peek()===undefined)throw Error('Unclosed block');out.push(this.statement());}this.take();this.env=env;return `{\n${out.join('\n')}\n}`;
      }
      statement() {
        const t=this.peek();if(t==='{')return this.block();if(t===';'){this.take();return ';';}
        if(t==='return'){this.take();this.returns++;if(this.returnType==='void'){this.need(';');return 'return;';}const e=this.expr();this.need(';');return `return ${cast(e,this.returnType)};`;}
        if(t==='break'||t==='continue'){this.take();this.need(';');return t+';';}
        if(t==='if'){this.take();this.need('(');const cond=this.expr();this.need(')');if(cond.type!=='bool')throw Error('Nonboolean branch');let out=`if(${cond.code}) ${this.wrapped()}`;if(this.peek()==='else'){this.take();out+=' else '+this.wrapped();}return out;}
        if(t==='for') {
          this.take();this.need('(');const env={...this.env};const init=this.peek()===';'?(this.take(),''):this.simple();const cond=this.peek()===';'?value('true','bool'):this.expr();this.need(';');if(cond.type!=='bool')throw Error('Nonboolean loop');const step=this.peek()===')'?(this.take(),''):this.simple(')');const block=this.wrapped();this.env=env;
          return `{\n${init}\nfor(;${cond.code};${step.replace(/;$/,'')}) ${block}\n}`;
        }
        if(t==='while'){this.take();this.need('(');const cond=this.expr();this.need(')');if(cond.type!=='bool')throw Error('Nonboolean loop');return `while(${cond.code}) ${this.wrapped()}`;}
        if(t==='do'){this.take();const b=this.wrapped();this.need('while');this.need('(');const cond=this.expr();this.need(')');this.need(';');if(cond.type!=='bool')throw Error('Nonboolean loop');return `loop ${b.slice(0,-1)}continuing { break if !(${cond.code}); }\n}`;}
        return this.simple();
      }
      wrapped(){return this.peek()==='{'?this.block():`{\n${this.statement()}\n}`;}
      all(){const out=[];while(this.p<this.ts.length)out.push(this.statement());if(this.returnType!=='void'&&!this.returns)throw Error('Missing material/helper return');return out.join('\n');}
    }
    const lib=new Parser(libraryTokens,{},'void'),decls=[];
    while(lib.p<lib.ts.length) {
      if(lib.peek()==='const') {
                                                                             
        const start=lib.p,text=lib.declaration();decls.push(text.replace(/^let /gm,'const '));Object.assign(globals,lib.env);if(lib.p===start)throw Error('Library parse stalled');continue;
      }
      const ret=types[lib.take()],name=lib.take();if(!ret||!functions.has(name))throw Error('Unsupported library declaration');lib.need('(');const args=[],env={},copies=[];
      if(lib.peek()!==')')do{if(['const','in'].includes(lib.peek()))lib.take();const type=types[lib.take()],arg=lib.take();if(!type)throw Error('Unsupported parameter');if(!/^[A-Za-z_]\w*$/.test(arg)||arg.startsWith('aps')||env[arg])throw Error('Invalid/redeclared parameter name');args.push(`apsInput_${arg}: ${type}`);copies.push(`var ${emittedSymbol(arg)}: ${type} = apsInput_${arg};`);env[arg]=type;}while(lib.peek()===','&&lib.take());lib.need(')');
      const nested=new Parser(lib.ts.slice(lib.p),env,ret);const block=nested.block();lib.p+=nested.p;
      if(ret!=='void'&&!nested.returns)throw Error('Missing helper return');decls.push(`fn ${functions.get(name).name}(${args.join(',')})${ret==='void'?'':` -> ${ret}`} ${block.replace('{','{\n'+copies.join('\n'))}`);
    }
    const parser=new Parser(tokensOf(body),{ctx:'APSContext'},'APSPrincipled');parser.parameterizeFloats=floatUniformPrefix!==null;
    const compiled=parser.all();return {body:compiled,library:decls.join('\n'),...(floatUniformPrefix!==null?{floatUniforms}:{})};
  } catch(e) {throw Error(`Unsupported authored GLSL mat_code: ${e.message}`);}
}
