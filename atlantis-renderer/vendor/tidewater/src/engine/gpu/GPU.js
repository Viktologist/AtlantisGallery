                                                       
  
                                                                                                  
                                                                                                 
                                                                                     
  
                                                                                                    
                                                                                                   
                                                                      

import {pipelineCacheFor} from './PipelineCache.js';
import {requestNativeAdapter} from './Adapter.js';

export const GPU = {

	device: null,
	queue: null,
	adapter: null,
	adapterDiagnostics: null,
	context: null,
	canvas: null,
	format: 'bgra8unorm',
	features: new Set(),
	limits: null,
	hasTimestamp: false,
	hasFloat32Filterable: false,
	encoder: null,
	frame: 0,
	samplers: null,
	_submitHooks: [],

	async init( { canvas = null, requiredLimits = {}, headless = false } = {} ) {

		if ( ! navigator.gpu ) throw new Error( 'WebGPU is not available in this browser.' );
		const { adapter, diagnostics } = await requestNativeAdapter( navigator.gpu, {
			context: {
				isSecureContext: globalThis.isSecureContext,
				origin: globalThis.location?.origin,
				userAgent: navigator.userAgent,
			},
		} );
		this.adapterDiagnostics = diagnostics;
		if ( ! adapter ) {
			console.error( 'WebGPU adapter diagnostics:', JSON.stringify( diagnostics ) );
			throw new Error( 'No WebGPU adapter found.' );
		}
		this.adapter = adapter;

		const L = adapter.limits;
		const want = {
			maxSampledTexturesPerShaderStage: 32,
			maxSamplersPerShaderStage: 16,
			maxStorageBuffersPerShaderStage: 10,
			maxStorageTexturesPerShaderStage: 8,
			maxComputeWorkgroupStorageSize: 32768,
			maxColorAttachmentBytesPerSample: 64,
			maxStorageBuffersInVertexStage: 4,
			maxStorageBuffersInFragmentStage: 8,
			maxStorageTexturesInFragmentStage: 4,
			maxBindingsPerBindGroup: 1000,
			maxBufferSize: 1024 * 1024 * 1024,
			maxStorageBufferBindingSize: 512 * 1024 * 1024,
			...requiredLimits,
		};
		const limits = {};
		for ( const k in want ) if ( L[ k ] !== undefined ) limits[ k ] = Math.min( want[ k ], L[ k ] );

		const optional = [ 'float32-filterable', 'timestamp-query', 'rg11b10ufloat-renderable', 'float32-blendable', 'shader-f16', 'clip-distances' ];
		const requiredFeatures = optional.filter( ( f ) => adapter.features.has( f ) );
		this.features = new Set( requiredFeatures );
		this.hasTimestamp = this.features.has( 'timestamp-query' );
		this.hasFloat32Filterable = this.features.has( 'float32-filterable' );

		const device = await adapter.requestDevice( { requiredFeatures, requiredLimits: limits } );
		this.device = device;
		this.queue = device.queue;
		this.limits = device.limits;
		device.lost.then( ( info ) => console.error( 'WebGPU device lost:', info.message ) );
		device.addEventListener && device.addEventListener( 'uncapturederror', ( e ) => console.error( 'WebGPU:', e.error.message.split( '\n' ).slice( 0, 6 ).join( '\n' ) ) );

		if ( canvas && ! headless ) {

			this.canvas = canvas;
			this.context = canvas.getContext( 'webgpu' );
			this.format = navigator.gpu.getPreferredCanvasFormat();
			this.context.configure( { device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST } );

		}

		this._createSamplers();
		return this;

	},

	_createSamplers() {

		const d = this.device;
		const s = ( desc ) => d.createSampler( desc );
		const lin = { magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' };
		this.samplers = {
			linearRepeat: s( { ...lin, addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' } ),
			linearClamp: s( { ...lin, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' } ),
			linearMirror: s( { ...lin, addressModeU: 'mirror-repeat', addressModeV: 'mirror-repeat', addressModeW: 'mirror-repeat' } ),
			anisoRepeat: s( { ...lin, addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat', maxAnisotropy: 8 } ),
			                                                                                              
			aniso4Repeat: s( { ...lin, addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat', maxAnisotropy: 4 } ),
			anisoClamp: s( { ...lin, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 8 } ),
			nearestClamp: s( { magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' } ),
			nearestRepeat: s( { magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' } ),
			shadow: s( { magFilter: 'linear', minFilter: 'linear', compare: 'less', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' } ),
		};

	},

	                                                                                           
	                                
	beginFrame() {

		this.frame ++;
		return this.getEncoder();

	},

	getEncoder() {

		if ( ! this.encoder ) this.encoder = this.device.createCommandEncoder();
		return this.encoder;

	},

	                                                                                          
	submit() {

		if ( ! this.encoder ) return;
		const hooks = this._submitHooks;
		this._submitHooks = [];
		for ( const h of hooks ) if ( h.before ) h.before( this.encoder );
		this.queue.submit( [ this.encoder.finish() ] );
		this.encoder = null;
		for ( const h of hooks ) if ( h.after ) h.after();

	},

	onSubmit( before, after ) {

		this._submitHooks.push( { before, after } );

	},

	                 
	                                                                                                   
	                                                                                                  
	                                                                                                  
	                                                                                                 
	_pending: new Set(),
	_compileLimit: 2,
	_compiling: 0,
	_compileWaiters: [],
	syncCompiles: [],                                                                                

	async _acquireCompiler() {

		if ( this._compiling < this._compileLimit ) { this._compiling ++; return; }
		await new Promise( ( resolve ) => this._compileWaiters.push( resolve ) );

	},

	_releaseCompiler() {

		const next = this._compileWaiters.shift();
		if ( next ) next();
		else this._compiling --;

	},

	renderPipeline( desc ) {

		return this._async( desc, 'render' );

	},

	computePipeline( desc ) {

		return this._async( desc, 'compute' );

	},

	_async( desc, kind ) {

		const device=this.device,cache=pipelineCacheFor(device),key=kind+'|'+cache.key(desc);
		const existing=cache.pipelines.get(key);
		if(existing&&!existing.failed){cache.hits++;return existing;}
		cache.misses++;
		const h = { pipeline: null, label: desc.label, desc, kind, failed: false };
		cache.pipelines.set(key,h);
		                                                                                               
		                                                 
		                                                                         
		                                                                         
		const p = Promise.resolve().then( async () => {

			if ( h.pipeline ) return;
			await this._acquireCompiler();
			try {
			if ( h.pipeline ) return;
			const create = kind === 'render' ? device.createRenderPipelineAsync : device.createComputePipelineAsync;
			await create.call( device, desc ).then( ( pipeline ) => {

				if ( ! h.pipeline ) h.pipeline = pipeline;
				h.desc = null;

			}, ( e ) => {

				h.failed = true;
				h.error = e;
				console.error( `WebGPU: pipeline "${ desc.label }" failed: ${ e.message.split( '\n' ).slice( 0, 6 ).join( '\n' ) }` );

			} );
			} finally { this._releaseCompiler(); }

		} ).finally( () => this._pending.delete( p ) );
		this._pending.add( p );
		return h;

	},

	                                                                             
	ready( h ) {

		if ( h.failed ) throw new Error( `WebGPU pipeline "${ h.label }" failed: ${ h.error?.message || 'compilation failed' }` );
		if ( h.pipeline ) return h.pipeline;
		this.syncCompiles.push( h.label );
		h.pipeline = h.kind === 'render' ? this.device.createRenderPipeline( h.desc ) : this.device.createComputePipeline( h.desc );
		return h.pipeline;

	},

	                                                             
	async pipelinesReady() {

		while ( this._pending.size ) await Promise.all( [ ...this._pending ] );

	},

	pipelineLayout(desc){return pipelineCacheFor(this.device).layout(desc);},
	pipelineCacheMetadata(){return pipelineCacheFor(this.device).metadata();},

	                                                 
	computePass( label, fn, timestampWrites ) {

		const pass = this.getEncoder().beginComputePass( { label, timestampWrites } );
		fn( pass );
		pass.end();

	},

};

                                                                                                  

const FORMAT_INFO = {
	r8unorm: { bytes: 1, sample: 'float' },
	rg8unorm: { bytes: 2, sample: 'float' },
	rgba8unorm: { bytes: 4, sample: 'float' },
	'rgba8unorm-srgb': { bytes: 4, sample: 'float' },
	bgra8unorm: { bytes: 4, sample: 'float' },
	r16float: { bytes: 2, sample: 'float' },
	rg16float: { bytes: 4, sample: 'float' },
	rgba16float: { bytes: 8, sample: 'float' },
	rg11b10ufloat: { bytes: 4, sample: 'float' },
	r32float: { bytes: 4, sample: 'unfilterable-float' },
	rg32float: { bytes: 8, sample: 'unfilterable-float' },
	rgba32float: { bytes: 16, sample: 'unfilterable-float' },
	r32uint: { bytes: 4, sample: 'uint' },
	rg32uint: { bytes: 8, sample: 'uint' },
	rgba32uint: { bytes: 16, sample: 'uint' },
	r32sint: { bytes: 4, sample: 'sint' },
	r8uint: { bytes: 1, sample: 'uint' },
	rgba8uint: { bytes: 4, sample: 'uint' },
	depth32float: { bytes: 4, sample: 'depth' },
	depth24plus: { bytes: 4, sample: 'depth' },
	'depth24plus-stencil8': { bytes: 4, sample: 'depth' },
};

export function formatInfo( format ) {

	const i = FORMAT_INFO[ format ];
	if ( ! i ) throw new Error( 'Unknown texture format ' + format );
	return i;

}

                                                                                                        
export function sampleTypeOf( format ) {

	const t = formatInfo( format ).sample;
	if ( t === 'unfilterable-float' && GPU.hasFloat32Filterable ) return 'float';
	return t;

}
