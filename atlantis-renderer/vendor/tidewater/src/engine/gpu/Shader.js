import { GPU } from './GPU.js';
import { UniformBlock } from './Uniforms.js';

                    
  
                                                                                              
                                                                                                   
                                                                                                
                                                                                                 
                                        
  
                                                     
                       
                              
                                                                                                                        
                  
                                                                              
                                                                    
         
                                                                                                                                          
         
  
          
                                                                                               
                                                         
                                                               
  
                                                                                                      
                                                                                          

export const SAMPLERS = [
	[ 'smpLinearRepeat', 'linearRepeat', 'filtering' ],
	[ 'smpLinearClamp', 'linearClamp', 'filtering' ],
	[ 'smpLinearMirror', 'linearMirror', 'filtering' ],
	[ 'smpAnisoRepeat', 'anisoRepeat', 'filtering' ],
	[ 'smpAnisoClamp', 'anisoClamp', 'filtering' ],
	[ 'smpAniso4Repeat', 'aniso4Repeat', 'filtering' ],
	[ 'smpNearestClamp', 'nearestClamp', 'non-filtering' ],
	[ 'smpNearestRepeat', 'nearestRepeat', 'non-filtering' ],
	[ 'smpShadow', 'shadow', 'comparison' ],
];

let _modId = 0;

export class ShaderModule {

	constructor( { name, deps = [], code = '', bindings = {}, uniforms = null, uniformName = null } ) {

		this.id = _modId ++;
		this.name = name || 'module' + this.id;
		this.deps = deps.filter( Boolean );
		this.code = code;
		this.bindings = { ...bindings };
		if ( uniforms ) this.bindings[ uniformName || lowerFirst( uniforms.structName ) ] = { uniform: uniforms };
		this.isShaderModule = true;

	}

}

function lowerFirst( s ) {

	return s[ 0 ].toLowerCase() + s.slice( 1 );

}

                                            
export function collectModules( list ) {

	const out = [];
	const seen = new Set();
	const visit = ( m ) => {

		if ( ! m || seen.has( m ) ) return;
		seen.add( m );
		for ( const d of m.deps ) visit( d );
		out.push( m );

	};

	for ( const m of list ) visit( m );
	return out;

}

                                                                                                  

export function preprocess( code, defines = {} ) {

	const lines = code.split( '\n' );
	const out = [];
	                                           
	const stack = [];
	const active = () => stack.length === 0 || stack[ stack.length - 1 ].active;
	const evalCond = ( expr ) => {

		expr = expr.trim();
		let m;
		if ( ( m = /^!\s*(\w+)$/.exec( expr ) ) ) return ! truthy( defines[ m[ 1 ] ] );
		if ( ( m = /^(\w+)\s*(==|!=|>=|<=|>|<)\s*([\w.'"-]+)$/.exec( expr ) ) ) {

			const a = defines[ m[ 1 ] ];
			let b = m[ 3 ].replace( /^['"]|['"]$/g, '' );
			if ( ! isNaN( Number( b ) ) && typeof a === 'number' ) b = Number( b );
			switch ( m[ 2 ] ) {

				case '==': return a == b;                              
				case '!=': return a != b;                              
				case '>=': return a >= b;
				case '<=': return a <= b;
				case '>': return a > b;
				case '<': return a < b;

			}

		}

		if ( /\|\|/.test( expr ) ) return expr.split( '||' ).some( ( e ) => evalCond( e ) );
		if ( /&&/.test( expr ) ) return expr.split( '&&' ).every( ( e ) => evalCond( e ) );
		return truthy( defines[ expr ] );

	};

	for ( const line of lines ) {

		const t = line.trim();
		let m;
		if ( ( m = /^#(if|ifdef|ifndef)\s+(.*)$/.exec( t ) ) ) {

			const parent = active();
			let c;
			if ( m[ 1 ] === 'ifdef' ) c = defines[ m[ 2 ].trim() ] !== undefined;
			else if ( m[ 1 ] === 'ifndef' ) c = defines[ m[ 2 ].trim() ] === undefined;
			else c = evalCond( m[ 2 ] );
			stack.push( { active: parent && c, taken: c, parent } );
			continue;

		}

		if ( ( m = /^#elif\s+(.*)$/.exec( t ) ) ) {

			const s = stack[ stack.length - 1 ];
			const c = ! s.taken && evalCond( m[ 1 ] );
			s.active = s.parent && c;
			s.taken = s.taken || c;
			continue;

		}

		if ( t === '#else' ) {

			const s = stack[ stack.length - 1 ];
			s.active = s.parent && ! s.taken;
			s.taken = true;
			continue;

		}

		if ( t === '#endif' ) {

			stack.pop();
			continue;

		}

		if ( active() ) out.push( line );

	}

	if ( stack.length ) throw new Error( 'preprocess: unterminated #if' );
	return out.join( '\n' );

}

function truthy( v ) {

	return v !== undefined && v !== null && v !== false && v !== 0 && v !== '0';

}

                                                                                              

                                                                           
function resolve( r ) {

	return typeof r === 'function' ? r() : r;

}

                                                       
function describe( name, spec, stage ) {

	const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
	const vis = stage === 'compute' ? GPUShaderStage.COMPUTE : VF;
	if ( spec.uniform ) {

		const u = spec.uniform;
		return {
			layout: { visibility: vis, buffer: { type: 'uniform' } },
			decl: `var<uniform> ${ name }: ${ u.structName };`,
			struct: u,
		};

	}

	if ( spec.uniformBuffer ) {

		return { layout: { visibility: vis, buffer: { type: 'uniform' } }, decl: `var<uniform> ${ name }: ${ spec.wgslType };` };

	}

	if ( spec.storage ) {

		const b = resolve( spec.storage );
		const access = spec.access || 'read';
		const t = spec.wgslType || `array<${ spec.type || b.type }>`;
		const v = stage === 'compute' ? vis : access === 'read' ? VF : GPUShaderStage.FRAGMENT;
		return {
			layout: { visibility: v, buffer: { type: access === 'read' ? 'read-only-storage' : 'storage' } },
			decl: `var<storage, ${ access === 'read' ? 'read' : 'read_write' }> ${ name }: ${ t };`,
		};

	}

	if ( spec.storageTexture ) {

		const t = resolve( spec.storageTexture );
		const access = spec.access || 'write';
		const dim = spec.viewDimension || spec.view?.dimension || t.defaultViewDimension;
		const v = stage === 'compute' ? vis : GPUShaderStage.FRAGMENT;
		return {
			layout: { visibility: v, storageTexture: { access: access === 'write' ? 'write-only' : access === 'read' ? 'read-only' : 'read-write', format: t.format, viewDimension: dim } },
			decl: `var ${ name }: texture_storage_${ dim.replace( '-', '_' ) }<${ t.format }, ${ access }>;`,
		};

	}

	if ( spec.texture ) {

		const t = resolve( spec.texture );
		const dim = spec.viewDimension || spec.view?.dimension || t.defaultViewDimension;
		let sampleType = spec.sampleType || t.sampleType;
		let wgsl = spec.wgslType || t.wgslType( dim );
		                                                           
		if ( spec.sampleType === 'unfilterable-float' && t.isDepth ) wgsl = `texture_${ dim.replace( '-', '_' ) }<f32>`;
		return {
			layout: { visibility: vis, texture: { sampleType, viewDimension: dim, multisampled: t.sampleCount > 1 } },
			decl: `var ${ name }: ${ wgsl };`,
		};

	}

	if ( spec.sampler ) {

		return { layout: { visibility: vis, sampler: { type: spec.samplerType || 'filtering' } }, decl: `var ${ name }: ${ spec.samplerType === 'comparison' ? 'sampler_comparison' : 'sampler' };` };

	}

	throw new Error( `binding ${ name }: unknown spec` );

}

function resourceOf( spec ) {

	if ( spec.uniform ) return { buffer: spec.uniform.getBuffer() };                            
	if ( spec.uniformBuffer ) return { buffer: resolve( spec.uniformBuffer ) };
	if ( spec.storage ) {

		const b = resolve( spec.storage );
		const buf = b.getGPU ? b.getGPU() : b;
		return spec.offset !== undefined ? { buffer: buf, offset: spec.offset, size: spec.size } : { buffer: buf };

	}

	if ( spec.storageTexture ) return resolve( spec.storageTexture ).view( spec.view || { dimension: spec.viewDimension || resolve( spec.storageTexture ).defaultViewDimension, mipLevelCount: 1, baseMipLevel: spec.mip || 0 } );
	if ( spec.texture ) {

		const t = resolve( spec.texture );
		return spec.view || spec.viewDimension ? t.view( { ...( spec.view || {} ), dimension: spec.viewDimension || spec.view.dimension } ) : t.view();

	}

	if ( spec.sampler ) return typeof spec.sampler === 'string' ? GPU.samplers[ spec.sampler ] : spec.sampler;
	throw new Error( 'unknown binding' );

}

                                                                                             
const K_UNIFORM = 0, K_UBUF = 1, K_STORAGE = 2, K_TEXTURE = 3, K_OTHER = 4;

function kindOf( spec ) {

	if ( spec.uniform ) return K_UNIFORM;
	if ( spec.uniformBuffer ) return K_UBUF;
	if ( spec.storage ) return K_STORAGE;
	if ( spec.storageTexture || spec.texture ) return K_TEXTURE;
	return K_OTHER;

}

                                                                                                
                                                                          
const GROUP_CACHE = 4;

                                                                                               
                                                                                               
                                                          
const _layoutCaches = new WeakMap();

function deviceCache( caches, device ) {

	let cache = caches.get( device );
	if ( ! cache ) caches.set( device, cache = new Map() );
	return cache;

}

export function getBindGroupLayout( entries, label ) {

	const device = GPU.device;
	if ( ! device ) throw new Error( 'WebGPU device is not initialized' );
	const cache = deviceCache( _layoutCaches, device );
	const key = JSON.stringify( entries );
	let l = cache.get( key );
	if ( ! l ) {

		l = device.createBindGroupLayout( { label, entries } );
		cache.set( key, l );

	}

	return l;

}

                                                                                             
export class BindingSet {

	                                                                                               
	                                                                                                     
	constructor( specs, stage, label = 'bindings', stageOf = null, demote = null ) {

		this.label = label;
		this.stage = stage;
		this.names = Object.keys( specs );
		this.specs = specs;
		this.described = this.names.map( ( n ) => describe( n, specs[ n ], stage ) );
		if ( stageOf ) for ( let i = 0; i < this.names.length; i ++ ) {

			const l = this.described[ i ].layout;
			const st = stageOf[ this.names[ i ] ];
			if ( st === 'fragment' && ( l.visibility & GPUShaderStage.FRAGMENT ) ) l.visibility = GPUShaderStage.FRAGMENT;
			if ( st === 'vertex' && ( l.visibility & GPUShaderStage.VERTEX ) ) l.visibility = GPUShaderStage.VERTEX;

		}

		if ( demote ) for ( let i = 0; i < this.names.length; i ++ ) {

			const d = this.described[ i ];
			if ( ! demote.has( this.names[ i ] ) ) continue;
			d.layout.buffer = { type: 'read-only-storage' };
			d.decl = d.decl.replace( /^var<uniform>/, 'var<storage, read>' );

		}

		this.layout = getBindGroupLayout( this.described.map( ( d, i ) => ( { binding: i, ...d.layout } ) ), label );
		this.group = null;
		const n = this.names.length;
		this._specs = this.names.map( ( k ) => specs[ k ] );
		this._kinds = this._specs.map( kindOf );
		this._blocks = this._specs.filter( ( sp ) => sp.uniform ).map( ( sp ) => sp.uniform );
		this._objs = new Array( n ).fill( null );                                            
		this._vers = new Array( n ).fill( 0 );
		this._entry = null;                                       
		this._cache = [];
		this._token = null;

	}

	declarations( group ) {

		return this.described.map( ( d, i ) => `@group(${ group }) @binding(${ i }) ${ d.decl }` ).join( '\n' );

	}

	structs() {

		const out = [];
		for ( const d of this.described ) if ( d.struct && ! out.includes( d.struct ) ) out.push( d.struct );
		return out;

	}

	                                                                                
	                                                                                               
	                                                                                     
	getBindGroup( token ) {

		if ( token !== undefined && token === this._token && this.group ) return this.group;
		this._token = token;
		const specs = this._specs, kinds = this._kinds, objs = this._objs, vers = this._vers;
		const n = specs.length;
		for ( let i = 0; i < n; i ++ ) {

			const spec = specs[ i ];
			let o = null, v = 0;
			switch ( kinds[ i ] ) {

				case K_UNIFORM: o = spec.uniform; break;
				case K_UBUF: o = resolve( spec.uniformBuffer ); break;
				case K_STORAGE:
					o = resolve( spec.storage );
					if ( o.getGPU ) {

						o.getGPU();
						v = o.version;

					}

					break;
				case K_TEXTURE:
					o = resolve( spec.storageTexture || spec.texture );
					if ( o && o.getGPU ) {

						o.getGPU();
						v = o.version;

					}

					break;
				default: o = spec.sampler;

			}

			objs[ i ] = o;
			vers[ i ] = v;

		}

		const blocks = this._blocks;
		for ( let i = 0; i < blocks.length; i ++ ) blocks[ i ].upload( token );
		if ( this._entry && this._matches( this._entry ) ) return this.group;
		const cache = this._cache;
		for ( let c = 0; c < cache.length; c ++ ) {

			const e = cache[ c ];
			if ( e === this._entry || ! this._matches( e ) ) continue;
			this._entry = e;
			this.group = e.group;
			return this.group;

		}

		const entries = new Array( n );
		for ( let i = 0; i < n; i ++ ) entries[ i ] = { binding: i, resource: resourceOf( specs[ i ] ) };
		this.group = GPU.device.createBindGroup( { label: this.label, layout: this.layout, entries } );
		this._entry = { objs: objs.slice(), vers: vers.slice(), group: this.group };
		cache.unshift( this._entry );
		if ( cache.length > GROUP_CACHE ) cache.pop();
		return this.group;

	}

	_matches( e ) {

		const objs = this._objs, vers = this._vers, eo = e.objs, ev = e.vers;
		for ( let i = 0; i < objs.length; i ++ ) if ( objs[ i ] !== eo[ i ] || vers[ i ] !== ev[ i ] ) return false;
		return true;

	}

}

                                                                                             

let _frameBlock = null;
let _group0ByDevice = new WeakMap();

                                                                                              
                                               
export function setFrameUniforms( block ) {

	_frameBlock = block;
	_group0ByDevice = new WeakMap();

}

export function frameUniforms() {

	return _frameBlock;

}

export function group0( stage ) {

	const device = GPU.device;
	if ( ! device ) throw new Error( 'WebGPU device is not initialized' );
	let stages = _group0ByDevice.get( device );
	if ( ! stages ) _group0ByDevice.set( device, stages = {} );
	if ( ! stages[ stage ] ) {

		const specs = { frame: { uniform: _frameBlock } };
		for ( const [ n, s, type ] of SAMPLERS ) specs[ n ] = { sampler: s, samplerType: type };
		stages[ stage ] = new BindingSet( specs, stage, 'group0-' + stage );

	}

	return stages[ stage ];

}

                                                                   
const _viewGroups = new WeakMap();
export function group0ForBlock( block, stage = 'render' ) {

	if ( block === _frameBlock ) return group0( stage );
	const device = GPU.device;
	let entry = _viewGroups.get( block );
	if ( ! entry || entry.device !== device ) _viewGroups.set( block, entry = { device, stages: {} } );
	if ( ! entry.stages[ stage ] ) {

		const specs = { frame: { uniform: block } };
		for ( const [ n, s, type ] of SAMPLERS ) specs[ n ] = { sampler: s, samplerType: type };
		entry.stages[ stage ] = new BindingSet( specs, stage, 'group0-' + block.label );

	}

	return entry.stages[ stage ];

}

                                                                                             

                                                                                        
                                                                                                  
                                                                       
export function composeShader( { modules = [], bindings = {}, code = '', defines = {}, stage = 'render', label = 'shader', header = '' } ) {

	const mods = collectModules( modules );
	const specs = {};
	for ( const m of mods ) for ( const k in m.bindings ) {

		if ( specs[ k ] && specs[ k ] !== m.bindings[ k ] && ! sameSpec( specs[ k ], m.bindings[ k ] ) ) throw new Error( `${ label }: binding ${ k } declared twice (${ m.name })` );
		specs[ k ] = m.bindings[ k ];

	}

	for ( const k in bindings ) specs[ k ] = bindings[ k ];
	let stageOf = null;
	let demote = null;
	if ( stage === 'render' && /@vertex\s+fn\s+vs\b/.test( code ) ) {

		                                                                                              
		                                                            
		let all = '';
		for ( const m of mods ) all += m.code + '\n';
		const full = preprocess( all + code, defines );
		const usedV = reachableIdentifiers( full, 'vs' );
		const usedF = /@fragment\s+fn\s+fs\b/.test( full ) ? reachableIdentifiers( full, 'fs' ) : null;
		stageOf = {};
		for ( const k in specs ) {

			if ( ! usedV.has( k ) && ( ! usedF || usedF.has( k ) ) ) stageOf[ k ] = 'fragment';
			else if ( usedF && ! usedF.has( k ) && usedV.has( k ) ) stageOf[ k ] = 'vertex';

		}

		                                                                                              
		                                                                                    
		demote = new Set();
		const limits = GPU.limits || {};
		const maxU = ( limits.maxUniformBuffersPerShaderStage || 12 ) - 2;
		const maxS = { vertex: limits.maxStorageBuffersInVertexStage ?? 4, fragment: limits.maxStorageBuffersInFragmentStage ?? limits.maxStorageBuffersPerShaderStage ?? 8 };
		const inStage = ( k, st ) => ! stageOf[ k ] || stageOf[ k ] === st;
		for ( const st of [ 'fragment', 'vertex' ] ) {

			const uniforms = Object.keys( specs ).filter( ( k ) => specs[ k ].uniform && inStage( k, st ) && ! demote.has( k ) );
			let storage = Object.keys( specs ).filter( ( k ) => ( specs[ k ].storage || demote.has( k ) ) && inStage( k, st ) ).length;
			                                                                              
			uniforms.sort( ( a, b ) => ( stageOf[ a ] === st ? 0 : 1 ) - ( stageOf[ b ] === st ? 0 : 1 ) );
			let n = uniforms.length;
			for ( const k of uniforms ) {

				if ( n <= maxU ) break;
				if ( storage >= maxS[ st ] ) break;
				demote.add( k );
				storage ++;
				n --;

			}

		}

	}

	const set = new BindingSet( specs, stage, label + '.g1', stageOf, demote );
	const g0 = group0( stage );
	const structs = [ ...new Set( [ ...g0.structs(), ...set.structs() ] ) ];
	let src = '';
	if ( GPU.features.has( 'shader-f16' ) && defines.F16 ) src += 'enable f16;\n';
	if ( defines.CLIP_DISTANCES ) src += 'enable clip_distances;\n';
	                                                                                                
	                                                                           
	if ( ! /diagnostic\s*\(\s*off\s*,\s*derivative_uniformity/.test( header ) ) src += 'diagnostic( off, derivative_uniformity );\n';
	src += header;
	src += [ ...new Set( structs.map( ( s ) => s.wgsl ) ) ].join( '\n' ) + '\n';
	src += g0.declarations( 0 ) + '\n';
	src += set.declarations( 1 ) + '\n';
	for ( const m of mods ) src += `// ---- ${ m.name }\n${ m.code }\n`;
	src += code;
	return { code: preprocess( src, defines ), bindings: set, group0: g0, modules: mods };

}

                                                                                                 
export function reachableIdentifiers( code, entry ) {

	const fns = new Map();
	const re = /\bfn\s+([A-Za-z_]\w*)\s*\(/g;
	let m;
	while ( ( m = re.exec( code ) ) ) {

		const open = code.indexOf( '{', m.index );
		if ( open < 0 ) break;
		let depth = 0, i = open;
		for ( ; i < code.length; i ++ ) {

			const c = code[ i ];
			if ( c === '{' ) depth ++;
			else if ( c === '}' && -- depth === 0 ) break;

		}

		                                                                                      
		const isEntry = /@(vertex|fragment|compute)[^;{}]*$/.test( code.slice( Math.max( 0, m.index - 80 ), m.index ) );
		if ( ! isEntry || m[ 1 ] === entry ) fns.set( m[ 1 ], code.slice( m.index, i + 1 ) );
		re.lastIndex = i + 1;

	}

	const used = new Set();
	const queue = [ entry ];
	const seen = new Set();
	while ( queue.length ) {

		const f = queue.pop();
		if ( seen.has( f ) || ! fns.has( f ) ) continue;
		seen.add( f );
		for ( const id of fns.get( f ).match( /[A-Za-z_]\w*/g ) || [] ) {

			used.add( id );
			if ( fns.has( id ) && ! seen.has( id ) ) queue.push( id );

		}

	}

	return used;

}

function sameSpec( a, b ) {

	const ka = Object.keys( a ), kb = Object.keys( b );
	return ka.length === kb.length && ka.every( ( k ) => a[ k ] === b[ k ] );

}

                                                                               
const _moduleCaches = new WeakMap();

export function createShaderModule( code, label ) {

	const device = GPU.device;
	if ( ! device ) throw new Error( 'WebGPU device is not initialized' );
	const cache = deviceCache( _moduleCaches, device );
	let m = cache.get( code );
	if ( m ) return m;
	m = device.createShaderModule( { label, code } );
	cache.set( code, m );
	const compilation = m.getCompilationInfo?.();
	if ( compilation ) compilation.then( ( info ) => {

		const errs = info.messages.filter( ( x ) => x.type === 'error' );
		if ( ! errs.length ) return;
		const lines = code.split( '\n' );
		for ( const e of errs ) {

			const a = Math.max( 0, e.lineNum - 4 ), b = Math.min( lines.length, e.lineNum + 2 );
			const excerpt = lines.slice( a, b ).map( ( l, i ) => `${ a + i + 1 }${ a + i + 1 === e.lineNum ? '>' : ' ' } ${ l }` ).join( '\n' );
			console.error( `WGSL error in ${ label } (${ e.lineNum }:${ e.linePos }): ${ e.message }\n${ excerpt }` );

		}

	}, ( error ) => {

		                                                                                            
		                                                                                           
		                                            
		if ( GPU.device !== device || GPU.lostInfo ) return;
		console.warn( `WGSL compilation info unavailable for ${ label }: ${ error?.message || String( error ) }`, error );

	} ).catch( ( error ) => {

		                                                                                          
		                                                                          
		if ( GPU.device === device && ! GPU.lostInfo ) console.warn( `WGSL diagnostics failed for ${ label }: ${ error?.message || String( error ) }`, error );

	} );
	return m;

}

export { UniformBlock };
