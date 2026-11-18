import { RenderTarget } from '../engine/gpu/Texture.js';
import { LAYERS, DEPTH_FORMAT } from '../engine/render/SceneRenderer.js';
import { FrameUniforms, createViewUniforms, setFrameCamera } from '../engine/render/Frame.js';
import { Box3, Matrix4, Vector3 } from '../engine/math/index.js';

                                                                                                    
                                                                                                     
                                                                                               
  
                                                                                                  
                                                                                                    
                                                                                                  
                                                                                                      
                                                                                                       
                                       
  
                                                                                                      
                                                                       
  
                                                                                                    
                                                                                                      
                                                                                                      
                                                                                                        
                                                                                                     
                                                                                                     
                                                                                         
const CLIP_MARGIN = 0.4;                                                                               
const GUARD = { left: 0.15, right: 0.15, bottom: 0.6, top: 0.0 };
export const REFRACTION_GUARD = {
	cx: ( GUARD.right - GUARD.left ) / 2, cy: ( GUARD.top - GUARD.bottom ) / 2,
	sx: 1 + ( GUARD.left + GUARD.right ) / 2, sy: 1 + ( GUARD.top + GUARD.bottom ) / 2,
};
const _guard = new Matrix4().set(
	1 / REFRACTION_GUARD.sx, 0, 0, - REFRACTION_GUARD.cx / REFRACTION_GUARD.sx,
	0, 1 / REFRACTION_GUARD.sy, 0, - REFRACTION_GUARD.cy / REFRACTION_GUARD.sy,
	0, 0, 1, 0,
	0, 0, 0, 1,
);
const _prevVP = new Matrix4();

const _box = new Box3();
const _v = new Vector3();

export class RefractionPass {

	constructor( { meshRenderer, scene, camera, sceneRenderer, scale = 0.5 } ) {

		this.meshRenderer = meshRenderer;
		this.scene = scene;
		this.camera = camera;
		this.sceneRenderer = sceneRenderer;
		this.scale = scale;
		this.enabled = true;
		this.guard = REFRACTION_GUARD;
		                                                                                              
		                                 
		this._camera = Object.create( camera );
		this._camera.projectionMatrix = new Matrix4();
		this.block = createViewUniforms( 'refraction' );
		this.target = new RenderTarget( 1, 1, { colors: [ 'rgba16float' ], depth: DEPTH_FORMAT, label: 'refraction' } );
		this.texture = this.target.texture;
		this.depthTexture = this.target.depthTexture;
		this._clearColors = [ [ 0, 0, 0, 0 ] ];
		                                                                                                   
		                                                                                               
		                                                
		this._filter = ( o ) => {

			const m = o.material;
			if ( m.underwaterLighting === 'none' || m.isWaterMaterial ) return false;
			if ( o.isInstancedMesh ) return this._instancedMinY( o ) < this._clipY;
			if ( ! o.geometry.attributes.position ) return true;
			return _box.copy( this._localBox( o ) ).applyMatrix4( o.matrixWorld ).min.y < this._clipY;

		};

		                                                                                                 
		                                                                                           
		this._boxes = new WeakMap();
		this._instBoxes = new WeakMap();

		this._clipY = 0;
		this._defines = { REFRACTION_CLIP: 1, REFRACTION_CLIP_MARGIN: CLIP_MARGIN };

	}

	                                                                                      
	_instancedMinY( o ) {

		const im = o.instanceMatrix;
		let c = this._instBoxes.get( o );
		if ( ! c || c.version !== ( im.version || 0 ) || c.count !== o.count || c.array !== im.array ) {

			o.computeBoundingBox();
			c = { version: im.version || 0, count: o.count, array: im.array, box: o.boundingBox.clone() };
			this._instBoxes.set( o, c );

		}

		return c.count ? _box.copy( c.box ).applyMatrix4( o.matrixWorld ).min.y : Infinity;

	}

	_localBox( o ) {

		const g = o.geometry, dr = g.drawRange || { start: 0, count: Infinity };
		const c = this._boxes.get( o );
		if ( c && c.geometry === g && c.start === dr.start && c.count === dr.count && c.version === ( g.attributes.position.version || 0 ) ) return c.box;
		const box = new Box3();
		const pos = g.attributes.position;
		if ( ( dr.start === 0 && ( dr.count === Infinity || dr.count === null ) ) ) {

			if ( ! g.boundingBox ) g.computeBoundingBox();
			box.copy( g.boundingBox );

		} else {

			const idx = g.index ? g.index.array : null;
			const n = idx ? idx.length : pos.count;
			const end = Math.min( n, dr.start + ( dr.count ?? Infinity ) );
			for ( let i = dr.start; i < end; i ++ ) {

				const v = idx ? idx[ i ] : i;
				_v.set( pos.getX( v ), pos.getY( v ), pos.getZ( v ) );
				box.expandByPoint( _v );

			}

		}

		this._boxes.set( o, { geometry: g, start: dr.start, count: dr.count, version: pos.version || 0, box } );
		return box;

	}

	render( seaLevel ) {

		const sr = this.sceneRenderer;
		const g = this.guard;
		const w = Math.max( 1, Math.round( sr.width * this.scale * g.sx ) ), h = Math.max( 1, Math.round( sr.height * this.scale * g.sy ) );
		if ( this.target.width !== w || this.target.height !== h ) this.target.setSize( w, h );
		this._clipY = seaLevel + CLIP_MARGIN;
		const rt = this.target;
		                                                                                                 
		                         
		const F = FrameUniforms.fields;
		const cam = this._camera;
		cam.projectionMatrix.multiplyMatrices( _guard, this.camera.projectionMatrix );
		_prevVP.multiplyMatrices( _guard, F.prevViewProjNoJitter.value );
		setFrameCamera( cam, w, h, {
			jitterX: F.jitter.value.x / g.sx * w / 2, jitterY: F.jitter.value.y / g.sy * h / 2,
			prevViewProj: _prevVP, prevCameraPos: F.prevCameraPos.value, block: this.block,
		} );
		this.meshRenderer.render( this.scene, {
			label: 'refraction',
			kind: 'color',
			camera: cam,
			frameBlock: this.block,
			colorViews: [ rt.texture.view() ],
			colorFormats: rt.formats,
			clearColors: this._clearColors,
			depthView: rt.depthTexture.view(),
			depthFormat: DEPTH_FORMAT,
			clearDepth: 0,
			layerMask: this.enabled ? 1 << LAYERS.OPAQUE : 0,
			filter: this._filter,
			defines: this._defines,
		} );

	}

}
