import { UniformBlock } from '../gpu/Uniforms.js';
import { setFrameUniforms } from '../gpu/Shader.js';
import { Vector2, Vector3, Vector4, Matrix4, Color } from '../math/index.js';

                                                                              
  
                                                                                                  
                                                                                            
                                                                                                     
                                                                                
const FRAME_FIELDS = {
	view: 'mat4x4f',
	proj: 'mat4x4f',
	viewProj: 'mat4x4f',
	invView: 'mat4x4f',
	invProj: 'mat4x4f',
	invViewProj: 'mat4x4f',
	viewProjNoJitter: 'mat4x4f',
	prevViewProjNoJitter: 'mat4x4f',
	cameraPos: [ 'vec3f', new Vector3() ],
	near: [ 'f32', 0.1 ],
	prevCameraPos: [ 'vec3f', new Vector3() ],
	far: [ 'f32', 60000 ],
	                                                                  
	resolution: [ 'vec2f', new Vector2( 1, 1 ) ],
	invResolution: [ 'vec2f', new Vector2( 1, 1 ) ],
	outputResolution: [ 'vec2f', new Vector2( 1, 1 ) ],
	                                                      
	jitter: [ 'vec2f', new Vector2() ],
	                                                                                                      
	prevJitter: [ 'vec2f', new Vector2() ],
	frameIndex: [ 'u32', 0 ],
	time: [ 'f32', 0 ],                       
	dt: [ 'f32', 1 / 60 ],
	seaLevel: [ 'f32', 0 ],

	                                                               
	sunDir: [ 'vec3f', new Vector3( 0.3, 0.6, - 0.7 ).normalize() ],
	night: [ 'f32', 0 ],                           
	                                                                                   
	sunColor: [ 'vec3f', new Color( 1, 1, 1 ) ],
	exposure: [ 'f32', 1 ],
	                                                                              
	skyIrradiance: [ 'vec3f', new Color( 0.3, 0.4, 0.6 ) ],
	cameraUnderwater: [ 'f32', 0 ],
	                                                                 
	horizonColor: [ 'vec3f', new Color( 0.6, 0.7, 0.8 ) ],
	cameraWaterHeight: [ 'f32', 0 ],
	                                        
	waterAbsorption: [ 'vec3f', new Vector3( 0.42, 0.075, 0.035 ) ],
	windSpeed: [ 'f32', 7 ],                      
	waterScattering: [ 'vec3f', new Vector3( 0.012, 0.018, 0.024 ) ],
	envIntensity: [ 'f32', 1 ],
	                                  
	windDir: [ 'vec2f', new Vector2( 0.35, 0.94 ).normalize() ],
	                                                                            
	reversedDepth: [ 'f32', 1 ],
	pad0: [ 'f32', 0 ],
	                                           
	debug: [ 'vec4f', new Vector4() ],
};

const CAMERA_FIELDS = [ 'view', 'proj', 'viewProj', 'invView', 'invProj', 'invViewProj', 'viewProjNoJitter', 'prevViewProjNoJitter',
	'cameraPos', 'near', 'prevCameraPos', 'far', 'resolution', 'invResolution', 'jitter', 'prevJitter', 'reversedDepth' ];

                                                                     
export const FrameUniforms = new UniformBlock( 'Frame', FRAME_FIELDS, { label: 'frame' } );

setFrameUniforms( FrameUniforms );

                                                                                                 
                                                                                                
                                                                    
export function createViewUniforms( label ) {

	const block = new UniformBlock( 'Frame', FRAME_FIELDS, { label } );
	block.onBeforePack = () => {

		for ( const k of FrameUniforms.order ) if ( ! CAMERA_FIELDS.includes( k ) ) block.fields[ k ].value = FrameUniforms.fields[ k ].value;

	};
	return block;

}

const F = FrameUniforms.fields;

                                                                             
export const G = {
	time: F.time,
	dt: F.dt,
	seaLevel: F.seaLevel,
	sunDir: F.sunDir,
	sunColor: F.sunColor,
	skyIrradiance: F.skyIrradiance,
	horizonColor: F.horizonColor,
	waterAbsorption: F.waterAbsorption,
	waterScattering: F.waterScattering,
	cameraUnderwater: F.cameraUnderwater,
	cameraWaterHeight: F.cameraWaterHeight,
	exposure: F.exposure,
	windDir: F.windDir,
	windSpeed: F.windSpeed,
	night: F.night,
	envIntensity: F.envIntensity,
};

export const GRAVITY = 9.81;

const _m = new Matrix4();

                                                                               
export function setFrameCamera( camera, width, height, { jitterX = 0, jitterY = 0, prevViewProj = null, prevCameraPos = null, block = FrameUniforms } = {} ) {

	const F = block.fields;
	camera.updateMatrixWorld();
	if ( camera.matrixWorldInverse ) camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();
	const view = camera.matrixWorldInverse;
	const proj = camera.projectionMatrix;
	F.view.value = view.clone();
	F.proj.value = proj.clone();
	const vp = new Matrix4().multiplyMatrices( proj, view );
	F.viewProjNoJitter.value = vp.clone();
	                                                                                        
	const jx = 2 * jitterX / width, jy = 2 * jitterY / height;
	_m.makeTranslation( jx, jy, 0 );
	const vpj = new Matrix4().multiplyMatrices( _m, vp );
	F.viewProj.value = vpj;
	F.invView.value = camera.matrixWorld.clone();
	F.invProj.value = proj.clone().invert();
	F.invViewProj.value = vpj.clone().invert();
	F.prevViewProjNoJitter.value = prevViewProj ? prevViewProj.clone() : vp.clone();
	F.cameraPos.value = new Vector3().setFromMatrixPosition( camera.matrixWorld );
	F.prevCameraPos.value = prevCameraPos ? prevCameraPos.clone() : F.cameraPos.value.clone();
	F.near.value = camera.near;
	F.far.value = camera.far;
	F.resolution.value = new Vector2( width, height );
	F.invResolution.value = new Vector2( 1 / width, 1 / height );
	F.prevJitter.value = F.jitter.value ? F.jitter.value.clone() : new Vector2();
	F.jitter.value = new Vector2( jx, jy );
	F.reversedDepth.value = camera.reversedDepth === false ? 0 : 1;

}
