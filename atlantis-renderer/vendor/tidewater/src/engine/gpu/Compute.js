import { GPU } from './GPU.js';
import { composeShader, createShaderModule } from './Shader.js';

                                                            
  
                                   
                         
                              
                                                                          
                                    
                        
                                                     
                                                                         
         
                                                                                       
                                                                                     
  
                                                                                               
                                                                                                                                                              

export class ComputeKernel {

	constructor( { label = 'kernel', modules = [], bindings = {}, code, workgroupSize = [ 64, 1, 1 ], defines = {}, entryPoint = 'main' } ) {

		this.label = label;
		this.workgroupSize = workgroupSize;
		const [ x, y = 1, z = 1 ] = workgroupSize;
		const body = code.replace( /\bWG_X\b/g, x ).replace( /\bWG_Y\b/g, y ).replace( /\bWG_Z\b/g, z );
		const c = composeShader( { modules, bindings, code: body, defines, stage: 'compute', label } );
		this.source = c.code;
		this.bindings = c.bindings;
		this.group0 = c.group0;
		const module = createShaderModule( c.code, label );
		this.handle = GPU.computePipeline( {
			label,
			layout: GPU.pipelineLayout( { bindGroupLayouts: [ c.group0.layout, c.bindings.layout ] } ),
			compute: { module, entryPoint },
		} );
		this.timestampWrites = null;                       

	}

	get pipeline() {

		return GPU.ready( this.handle );

	}

	                                                  
	dispatch( counts, { pass = null, indirect = null } = {} ) {

		                                                                        
		                                                                         
		                                                         
		if(GPU.deferUnreadyPipelines&&!this.handle.pipeline&&!this.handle.failed)return;
		const [ x, y = 1, z = 1 ] = Array.isArray( counts ) ? counts : [ counts ];
		if ( ! indirect && ( x === 0 || y === 0 || z === 0 ) ) return;
		const run = ( p ) => {

			p.setPipeline( GPU.ready( this.handle ) );
			p.setBindGroup( 0, this.group0.getBindGroup() );
			p.setBindGroup( 1, this.bindings.getBindGroup() );
			if ( indirect ) p.dispatchWorkgroupsIndirect( indirect.buffer.getGPU ? indirect.buffer.getGPU() : indirect.buffer, indirect.offset || 0 );
			else p.dispatchWorkgroups( x, y, z );

		};

		if ( pass ) run( pass );
		else GPU.computePass( this.label, run, this.timestampWrites || undefined );

	}

	                               
	groups( nx, ny = 1, nz = 1 ) {

		const [ x, y = 1, z = 1 ] = this.workgroupSize;
		return [ Math.ceil( nx / x ), Math.ceil( ny / y ), Math.ceil( nz / z ) ];

	}

}
