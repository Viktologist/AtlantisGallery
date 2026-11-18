                                                                                    

import { Object3D } from './Object3D.js';
import { BufferGeometry } from '../geometry/BufferGeometry.js';
import { InstancedBufferAttribute } from '../geometry/BufferAttribute.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Box3 } from '../math/Box3.js';
import { Sphere } from '../math/Sphere.js';

export class Mesh extends Object3D {

	constructor( geometry = new BufferGeometry(), material = null ) {

		super();
		this.type = 'Mesh';
		this.geometry = geometry;
		this.material = material;
		this.count = 1;                                              

	}

	copy( source, recursive ) {

		super.copy( source, recursive );
		this.material = Array.isArray( source.material ) ? source.material.slice() : source.material;
		this.geometry = source.geometry;
		this.count = source.count;
		return this;

	}

}

Mesh.prototype.isMesh = true;

const _m =               new Matrix4();
const _box =               new Box3();
const _sphere =               new Sphere();

                                                                      
export class InstancedMesh extends Mesh {

	constructor( geometry, material, count ) {

		super( geometry, material );
		this.type = 'InstancedMesh';
		this.instanceMatrix = new InstancedBufferAttribute( new Float32Array( count * 16 ), 16 );
		this.instanceColor = null;
		this.count = count;
		this.boundingBox = null;
		this.boundingSphere = null;
		for ( let i = 0; i < count; i ++ ) this.setMatrixAt( i, _m.identity() );

	}

	getMatrixAt( i, m ) { return m.fromArray( this.instanceMatrix.array, i * 16 ); }
	setMatrixAt( i, m ) { m.toArray( this.instanceMatrix.array, i * 16 ); }
	getColorAt( i, c ) { return c.fromArray( this.instanceColor.array, i * 3 ); }

	setColorAt( i, c ) {

		if ( this.instanceColor === null ) {

			this.instanceColor = new InstancedBufferAttribute( new Float32Array( this.instanceMatrix.count * 3 ).fill( 1 ), 3 );

		}

		c.toArray( this.instanceColor.array, i * 3 );

	}

	                                               
	computeBoundingBox() {

		const g = this.geometry;
		if ( this.boundingBox === null ) this.boundingBox = new Box3();
		if ( g.boundingBox === null ) g.computeBoundingBox();
		this.boundingBox.makeEmpty();
		for ( let i = 0; i < this.count; i ++ ) {

			this.getMatrixAt( i, _m );
			_box.copy( g.boundingBox ).applyMatrix4( _m );
			this.boundingBox.union( _box );

		}

	}

	computeBoundingSphere() {

		const g = this.geometry;
		if ( this.boundingSphere === null ) this.boundingSphere = new Sphere();
		if ( g.boundingSphere === null ) g.computeBoundingSphere();
		this.boundingSphere.makeEmpty();
		for ( let i = 0; i < this.count; i ++ ) {

			this.getMatrixAt( i, _m );
			_sphere.copy( g.boundingSphere ).applyMatrix4( _m );
			this.boundingSphere.union( _sphere );

		}

	}

	copy( source, recursive ) {

		super.copy( source, recursive );
		this.instanceMatrix.copy( source.instanceMatrix );
		if ( source.instanceColor !== null ) this.instanceColor = source.instanceColor.clone();
		this.count = source.count;
		if ( source.boundingBox !== null ) this.boundingBox = source.boundingBox.clone();
		if ( source.boundingSphere !== null ) this.boundingSphere = source.boundingSphere.clone();
		return this;

	}

	clone( recursive ) { return new InstancedMesh( this.geometry, this.material, this.count ).copy( this, recursive ); }

	dispose() { this.dispatchEvent( { type: 'dispose' } ); }

}

InstancedMesh.prototype.isInstancedMesh = true;
