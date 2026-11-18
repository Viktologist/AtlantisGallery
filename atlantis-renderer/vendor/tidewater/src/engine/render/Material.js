import { UniformBlock } from '../gpu/Uniforms.js';
import { Color, Vector2, Vector3, Vector4 } from '../math/index.js';

                                                                                            
  
                                
                    
                                                                                      
                                                                                                                 
                                                                                                                 
                                                                                                        
                                                                                                                           
                                                                                              
                                                                                
                                 
                                                                                                                 
         
  
                                                           
                                                                                                                
                                                                                                       
                                                                                                
                                                                                                         
                                                                                                         
                                  
                                                                             
                                                                                                            
                                                                                    
                                                                                                        
                                                                                                                          
                                                                                                        
                                                                                                             
                                                                                                    
                                                                                                          
                                                                                        
  
                                                                                                     
                                                                                           

let _id = 0;
                                                                            
                                                                         
                                                                       
const uniformTypeNames = new Map();
function materialUniformType( fields ) {

	const key = JSON.stringify( Object.entries( fields ).map( ( [ name, def ] ) => [ name, Array.isArray( def ) ? def[ 0 ] : def ] ) );
	if ( ! uniformTypeNames.has( key ) ) uniformTypeNames.set( key, 'MaterialParamsLayout' + uniformTypeNames.size );
	return uniformTypeNames.get( key );

}

const BUILTIN_UNIFORMS = {
	color: [ 'vec3f', null ],
	opacity: [ 'f32', 1 ],
	emissive: [ 'vec3f', null ],
	roughness: [ 'f32', 1 ],
	metalness: [ 'f32', 0 ],
	alphaTest: [ 'f32', 0 ],
};

export class Material {

	constructor( o = {} ) {

		this.id = _id ++;
		this.isMaterial = true;
		this.name = o.name || 'material' + this.id;
		this.version = 0;
		this.modules = o.modules || [];
		this.varyings = o.varyings || {};
		this.attributes = o.attributes || {};
		this.vertex = o.vertex || '';
		this.surface = o.surface || '';
		this.output = o.output || '';
		this.shadow = o.shadow || '';
		this.defines = { ...( o.defines || {} ) };
		this.lit = o.lit !== false;
		this.side = o.side || 'front';
		this.transparent = !! o.transparent;
		this.blending = o.blending || ( this.transparent ? 'normal' : 'none' );
		this.depthWrite = o.depthWrite ?? ! this.transparent;
		this.depthTest = o.depthTest ?? true;
		this.depthCompare = o.depthCompare || null;
		this.depthBias = o.depthBias || 0;                                                                
		this.depthBiasSlopeScale = o.depthBiasSlopeScale || 0;
		this.colorWrite = o.colorWrite ?? true;
		this.topology = o.topology || 'triangle-list';
		this.visible = o.visible ?? true;
		this.vertexColors = !! o.vertexColors;
		                                                                                              
		this.velocityWeight = o.velocityWeight ?? 1;
		                                                           
		this.underwaterLighting = o.underwaterLighting || 'full';
		this.appliesHillShadow = !! o.appliesHillShadow;
		this.localLightsCheap = !! o.localLightsCheap;
		this.receiveShadows = o.receiveShadows ?? true;
		this.userData = o.userData || {};

		const fields = { ...BUILTIN_UNIFORMS };
		for ( const k in o.uniforms || {} ) fields[ k ] = o.uniforms[ k ];
		this.uniformBlock = new UniformBlock( materialUniformType( fields ), fields, { label: this.name } );
		this.uniforms = this.uniformBlock.fields;
		const u = this.uniforms;
		u.color.value = toColor( o.color, new Color( 1, 1, 1 ) );
		u.emissive.value = toColor( o.emissive, new Color( 0, 0, 0 ) );
		if ( o.roughness !== undefined ) u.roughness.value = o.roughness;
		if ( o.metalness !== undefined ) u.metalness.value = o.metalness;
		if ( o.opacity !== undefined ) u.opacity.value = o.opacity;
		if ( o.alphaTest !== undefined ) u.alphaTest.value = o.alphaTest;

		this.bindings = {};
		for ( const k in o.textures || {} ) {

			const t = o.textures[ k ];
			this.bindings[ k ] = t && t.isTexture ? { texture: t } : typeof t === 'function' ? { texture: t } : t;

		}

		for ( const k in o.storage || {} ) {

			const b = o.storage[ k ];
			this.bindings[ k ] = b && b.isStorageBuffer ? { storage: b, access: 'read' } : b;

		}

		Object.assign( this.bindings, o.bindings || {} );
		this._listeners = [];

	}

	                                                     
	get color() { return this.uniforms.color.value; }
	set color( v ) { this.uniforms.color.value = toColor( v, this.uniforms.color.value ); }
	get emissive() { return this.uniforms.emissive.value; }
	set emissive( v ) { this.uniforms.emissive.value = toColor( v, this.uniforms.emissive.value ); }
	get roughness() { return this.uniforms.roughness.value; }
	set roughness( v ) { this.uniforms.roughness.value = v; }
	get metalness() { return this.uniforms.metalness.value; }
	set metalness( v ) { this.uniforms.metalness.value = v; }
	get opacity() { return this.uniforms.opacity.value; }
	set opacity( v ) { this.uniforms.opacity.value = v; }
	get alphaTest() { return this.uniforms.alphaTest.value; }
	set alphaTest( v ) {

		if ( ( v > 0 ) !== ( this.uniforms.alphaTest.value > 0 ) ) this.needsUpdate = true;
		this.uniforms.alphaTest.value = v;

	}

	set( name, v ) {

		this.uniformBlock.set( name, v );

	}

	                                                                   
	set needsUpdate( v ) {

		if ( v ) this.version ++;

	}

	setDefine( k, v ) {

		if ( this.defines[ k ] === v ) return;
		this.defines[ k ] = v;
		this.version ++;

	}

	                                                                       
	pipelineKey() {

		return `${ this.id }.${ this.version }.${ this.side }.${ this.transparent }.${ typeof this.blending === 'string' ? this.blending : JSON.stringify( this.blending ) }.${ this.depthWrite }.${ this.depthTest }.${ this.depthCompare }.${ this.colorWrite }.${ this.topology }.${ this.alphaTest > 0 }.${ this.underwaterLighting }.${ this.appliesHillShadow }.${ this.localLightsCheap }.${ this.receiveShadows }.${ this.depthBias }.${ this.depthBiasSlopeScale }.${ this.vertexColors }`;

	}

	allDefines() {

		return {
			...this.defines,
			UNDERWATER_LIGHTING: { none: 0, lite: 1, full: 2 }[ this.underwaterLighting ] ?? 2,
			HILL_SHADOW_SELF: this.appliesHillShadow ? 1 : 0,
			LOCAL_LIGHTS_CHEAP: this.localLightsCheap ? 1 : 0,
			ALPHA_TEST: this.alphaTest > 0 ? 1 : 0,
			DOUBLE_SIDED: this.side === 'double' ? 1 : 0,
			BACK_SIDE: this.side === 'back' ? 1 : 0,
			TRANSPARENT: this.transparent ? 1 : 0,
			RECEIVE_SHADOWS: this.receiveShadows ? 1 : 0,
		};

	}

	addEventListener( type, fn ) {

		if ( type === 'dispose' ) this._listeners.push( fn );

	}

	dispose() {

		for ( const f of this._listeners ) f( { target: this } );

	}

	clone() {

		const m = Object.create( Object.getPrototypeOf( this ) );
		Object.assign( m, this );
		m.id = _id ++;
		m.version = 0;
		m.defines = { ...this.defines };
		m.bindings = { ...this.bindings };
		const fields = Object.fromEntries( this.uniformBlock.order.map( ( k ) => [ k, [ this.uniformBlock.layout[ k ].typeStr, cloneValue( this.uniforms[ k ].value ) ] ] ) );
		m.uniformBlock = new UniformBlock( materialUniformType( fields ), fields, { label: m.name } );
		m.uniforms = m.uniformBlock.fields;
		m._listeners = [];
		return m;

	}

}

function cloneValue( v ) {

	if ( v && typeof v === 'object' && v.clone ) return v.clone();
	if ( Array.isArray( v ) ) return v.map( cloneValue );
	return v;

}

function toColor( v, target ) {

	if ( v === undefined || v === null ) return target;
	if ( v.isColor ) return target.copy ? target.copy( v ) : v.clone();
	if ( typeof v === 'number' || typeof v === 'string' ) return target.set( v );
	if ( Array.isArray( v ) ) return target.setRGB( v[ 0 ], v[ 1 ], v[ 2 ] );
	if ( v.isVector3 ) return target.setRGB( v.x, v.y, v.z );
	return target;

}

                                                                                        
export function blendState( b ) {

	if ( ! b || b === 'none' ) return undefined;
	if ( typeof b === 'object' ) return b;
	const c = ( src, dst, op = 'add' ) => ( { srcFactor: src, dstFactor: dst, operation: op } );
	switch ( b ) {

		case 'normal': return { color: c( 'src-alpha', 'one-minus-src-alpha' ), alpha: c( 'one', 'one-minus-src-alpha' ) };
		case 'premultiplied': return { color: c( 'one', 'one-minus-src-alpha' ), alpha: c( 'one', 'one-minus-src-alpha' ) };
		case 'additive': return { color: c( 'src-alpha', 'one' ), alpha: c( 'zero', 'one' ) };
		case 'add': return { color: c( 'one', 'one' ), alpha: c( 'one', 'one' ) };
		case 'multiply': return { color: c( 'dst', 'zero' ), alpha: c( 'zero', 'one' ) };
		case 'min': return { color: c( 'one', 'one', 'min' ), alpha: c( 'one', 'one', 'min' ) };
		case 'max': return { color: c( 'one', 'one', 'max' ), alpha: c( 'one', 'one', 'max' ) };

	}

	throw new Error( 'unknown blending ' + b );

}

                                                                                                        
export function basicMaterial( o = {} ) {

	return new Material( { lit: false, ...o } );

}

export { Vector2, Vector3, Vector4, Color };
