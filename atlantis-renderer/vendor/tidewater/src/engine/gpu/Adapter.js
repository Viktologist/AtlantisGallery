                                   
  
                                                                                            
                                                                                               
                                                                                               
                                                                  

const ATTEMPTS = [
	{ label: 'high-performance (immediate)', options: { powerPreference: 'high-performance' }, waitMs: 0 },
	{ label: 'default (after 500 ms)', options: {}, waitMs: 500 },
	{ label: 'high-performance (after 500 ms)', options: { powerPreference: 'high-performance' }, waitMs: 500 },
];

export async function requestNativeAdapter(
	gpu,
	{
		sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) ),
		context = {},
	} = {},
) {

	const diagnostics = {
		context: {
			isSecureContext: context.isSecureContext,
			origin: context.origin,
			userAgent: context.userAgent,
		},
		attempts: [],
	};

	for ( const attempt of ATTEMPTS ) {

		if ( attempt.waitMs > 0 ) await sleep( attempt.waitMs );

		const record = { label: attempt.label, options: attempt.options, outcome: null };

		try {

			const adapter = await gpu.requestAdapter( attempt.options );
			record.outcome = adapter ? 'adapter' : 'null';
			if ( adapter ) {

				record.adapterInfo = adapter.info
					? {
						vendor: adapter.info.vendor,
						architecture: adapter.info.architecture,
						device: adapter.info.device,
						description: adapter.info.description,
					}
					: null;
				diagnostics.attempts.push( record );
				return { adapter, diagnostics };

			}

		} catch ( error ) {

			record.outcome = 'error';
			record.error = error instanceof Error ? error.message : String( error );

		}

		diagnostics.attempts.push( record );

	}

	return { adapter: null, diagnostics };

}
