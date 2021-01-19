/**
 * @license
 * Copyright 2018 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Support for rendering polygon annotations.
 */

import {AnnotationType, Polygon} from 'neuroglancer/annotation';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {tile2dArray} from 'neuroglancer/util/array';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {CircleShader, VERTICES_PER_CIRCLE} from 'neuroglancer/webgl/circles';
import {LineShader} from 'neuroglancer/webgl/lines';
import {emitterDependentShaderGetter, ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

//const FULL_OBJECT_PICK_OFFSET = 0;
//const ENDPOINTS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;
//const PICK_IDS_PER_INSTANCE = ENDPOINTS_PICK_OFFSET + 2;

function getEndpointIndexArray() {
  return tile2dArray(
      new Uint8Array([0, 1]), /*majorDimension=*/ 1, /*minorTiles=*/ 1,
      /*majorTiles=*/ VERTICES_PER_CIRCLE);
}

class RenderHelper extends AnnotationRenderHelper {
  private lineShader = this.registerDisposer(new LineShader(this.gl, 1));
  private circleShader = this.registerDisposer(new CircleShader(this.gl));

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder, true);
    // Position of endpoints in camera coordinates.
    builder.addAttribute('highp vec3', 'aEndpointA');
    builder.addAttribute('highp vec3', 'aEndpointB');
  }

  private edgeShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        this.defineShader(builder);
        this.lineShader.defineShader(builder);
        builder.addUniform("highp uint", "uInstancedBasePickOffset")
        builder.setVertexMain(`
emitLine(uProjection, aEndpointA, aEndpointB);
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, vColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()}));
`);
      });

  private endpointIndexBuffer =
      this
          .registerDisposer(getMemoizedBuffer(
              this.gl, WebGL2RenderingContext.ARRAY_BUFFER, getEndpointIndexArray))
          .value;

  private endpointShaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
        this.defineShader(builder);
        this.circleShader.defineShader(builder, this.targetIsSliceView);
        builder.addUniform("highp uint", "uInstancedBasePickOffset")
        builder.addAttribute('highp uint', 'aEndpointIndex');
        builder.setVertexMain(`
vec3 vertexPosition = mix(aEndpointA, aEndpointB, float(aEndpointIndex));
emitCircle(uProjection * vec4(vertexPosition, 1.0));
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
emitAnnotation(getCircleColor(vColor, borderColor));
`);
      });

  enable(shader: ShaderProgram, context: AnnotationRenderContext, callback: () => void) {
    super.enable(shader, context, () => {
      const {gl} = shader;
      const aLower = shader.attribute('aEndpointA');
      const aUpper = shader.attribute('aEndpointB');

      context.buffer.bindToVertexAttrib(
          aLower, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
          /*normalized=*/ false,
          /*stride=*/ 4 * 6, /*offset=*/ context.bufferOffset);
      context.buffer.bindToVertexAttrib(
          aUpper, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT,
          /*normalized=*/ false,
          /*stride=*/ 4 * 6, /*offset=*/ context.bufferOffset + 4 * 3);

      gl.vertexAttribDivisor(aLower, 1);
      gl.vertexAttribDivisor(aUpper, 1);
      callback();
      gl.vertexAttribDivisor(aLower, 0);
      gl.vertexAttribDivisor(aUpper, 0);
      gl.disableVertexAttribArray(aLower);
      gl.disableVertexAttribArray(aUpper);
    });
  }

  drawEdges(context: AnnotationRenderContext) {
    const shader = this.edgeShaderGetter(context.renderContext.emitter);

    //const pointCount = context.byteCount.reduce((a, b) => a + b, 0) / (4 * 3);
    //this.enable(shader, context, () => {
    //  this.lineShader.draw(shader, context.renderContext, /*lineWidth=*/ 8, 1.0, Math.floor(pointCount / 2));  
    //});

    let byteOffset = 0;
    let renderedEdges = 0;
    let renderedPoints = 0;
    
    for (let i = 0; i < context.byteCount.length; ++i) {
      context.bufferOffset += byteOffset;
      byteOffset = context.byteCount[i];

      let pointCount = context.byteCount[i] / (4 * 3 * 2);
      this.enable(shader, context, () => {
        const {gl} = shader;
        gl.uniform1ui(shader.uniform('uInstancedBasePickOffset'), renderedEdges + renderedPoints);        
        this.lineShader.draw(shader, context.renderContext, /*lineWidth=*/ 7, 1.0, pointCount);
      });

      renderedPoints += pointCount;
      renderedEdges += pointCount;
    }
  }

  drawEndpoints(context: AnnotationRenderContext) {
    const shader = this.endpointShaderGetter(context.renderContext.emitter);

    //this.enable(shader, context, () => {
    //  const pointCount = context.byteCount.reduce((a, b) => a + b, 0) / (4 * 3 * 2);
    //  const aEndpointIndex = shader.attribute('aEndpointIndex');
    //  this.endpointIndexBuffer.bindToVertexAttribI(
    //      aEndpointIndex, /*components=*/ 1,
    //      /*attributeType=*/ WebGL2RenderingContext.UNSIGNED_BYTE);
    //  this.circleShader.draw(
    //      shader, context.renderContext,
    //      {interiorRadiusInPixels: 15, borderWidthInPixels: 2, featherWidthInPixels: 1},
    //      pointCount);
    //  shader.gl.disableVertexAttribArray(aEndpointIndex);
    //});

    let byteOffset = 0;
    let renderedPoints = 0;
    let renderedEdges = 0;
    
    for (let i = 0; i < context.byteCount.length; ++i) {
      context.bufferOffset += byteOffset;
      byteOffset = context.byteCount[i];

      let pointCount = context.byteCount[i] / (4 * 3 * 2);
      renderedEdges += pointCount;
      this.enable(shader, context, () => {
        const {gl} = shader;
        gl.uniform1ui(shader.uniform('uInstancedBasePickOffset'), renderedPoints + renderedEdges);        
        const aEndpointIndex = shader.attribute('aEndpointIndex');
        this.endpointIndexBuffer.bindToVertexAttribI(
            aEndpointIndex, /*components=*/ 1,
            /*attributeType=*/ WebGL2RenderingContext.UNSIGNED_BYTE);
        this.circleShader.draw(
            shader, context.renderContext,
            {interiorRadiusInPixels: 15, borderWidthInPixels: 2, featherWidthInPixels: 1},
            pointCount);
        shader.gl.disableVertexAttribArray(aEndpointIndex);
      });

      renderedPoints += pointCount;
    }
  }

  draw(context: AnnotationRenderContext) {
    let startingBufferOffset = context.bufferOffset;
    this.drawEdges(context);

    context.bufferOffset = startingBufferOffset;
    this.drawEndpoints(context);
  }
}

/*
function snapPositionToLine(position: vec3, objectToData: mat4, endpoints: Float32Array) {
  const cornerA = vec3.transformMat4(vec3.create(), <vec3>endpoints.subarray(0, 3), objectToData);
  const cornerB = vec3.transformMat4(vec3.create(), <vec3>endpoints.subarray(3, 6), objectToData);
  projectPointToLineSegment(position, cornerA, cornerB, position);
}
*/

function snapPositionToEndpoint(
    position: vec3, objectToData: mat4, endpoints: Float32Array, endpointIndex: number) {
  const startOffset = 3 * endpointIndex;
  const point = <vec3>endpoints.subarray(startOffset, startOffset + 3);
  vec3.transformMat4(position, point, objectToData);
}

registerAnnotationTypeRenderHandler(AnnotationType.POLYGON, {
  bytes: (annotation: Polygon) => annotation.points.length * 3 * 4 * 2,
  serializer: (buffer: ArrayBuffer, offset: number) => {
    return (annotation: Polygon, index: number) => {
      const coordinates = new Float32Array(buffer, offset + index * 4, annotation.points.length * 3 * 2);
      const {points} = annotation;
      for (let i = 1; i < points.length; ++i) {
        const coordinateOffset = (i - 1) * 3  * 2;
        coordinates[coordinateOffset] = points[i - 1][0];
        coordinates[coordinateOffset + 1] = points[i - 1][1];
        coordinates[coordinateOffset + 2] = points[i - 1][2];
        coordinates[coordinateOffset + 3] = points[i][0];
        coordinates[coordinateOffset + 4] = points[i][1];
        coordinates[coordinateOffset + 5] = points[i][2];
      }

      // Connect the ending point to the starting point.
      if (points.length > 1) {
        const lastIndex = points.length - 1;
        const coordinateOffset = lastIndex * 3 * 2;
        coordinates[coordinateOffset] = points[lastIndex][0];
        coordinates[coordinateOffset + 1] = points[lastIndex][1];
        coordinates[coordinateOffset + 2] = points[lastIndex][2];
        coordinates[coordinateOffset + 3] = points[0][0];
        coordinates[coordinateOffset + 4] = points[0][1];
        coordinates[coordinateOffset + 5] = points[0][2];
      }
    };
  },
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  pickIdsPerInstance: (annotations) => {
    let pickIdCounts = [];
    for (let i = 0; i < annotations.length; ++i) {
      pickIdCounts.push(annotations[i].points.length * 2); // One per point and one per edge.
    }

    return pickIdCounts;
  },
  getPickIdCount: (annotation) => annotation == null ? 1 : annotation.points.length, // TODO No code provides the annotation.
  snapPosition: (position, objectToData, data, offset, partIndex) => {
    const endpoints = new Float32Array(data, offset, 3 * partIndex);
    //if (partIndex === FULL_OBJECT_PICK_OFFSET) {
    //  snapPositionToLine(position, objectToData, endpoints);
    //} else {
      snapPositionToEndpoint(position, objectToData, endpoints, partIndex);
    //}
  },
  getRepresentativePoint: (objectToData, ann, partIndex) => {
    let repPoint = vec3.create();
    // if the full object is selected just pick the first point as representative
    //if (partIndex === FULL_OBJECT_PICK_OFFSET) {
    //  vec3.transformMat4(repPoint, ann.points[0], objectToData);
    //} else {
      //if ((partIndex - ENDPOINTS_PICK_OFFSET) === 0) {
      //  vec3.transformMat4(repPoint, ann.points[partIndex], objectToData);
      //} else {
        vec3.transformMat4(repPoint, ann.points[partIndex % ann.points.length], objectToData);
      //}
    //}
    return repPoint;
  },
  updateViaRepresentativePoint: (oldAnnotation, position, dataToObject, partIndex) => {
    let newPt = vec3.transformMat4(vec3.create(), position, dataToObject);
    let basePolygon = {...oldAnnotation};
    let pointOffset = vec3.subtract(vec3.create(), newPt, basePolygon.points[partIndex % basePolygon.points.length]);

    if (partIndex < basePolygon.points.length) { // Moving an edge.
      let lowerIndex = (partIndex + basePolygon.points.length) % basePolygon.points.length;
      let upperIndex = ((partIndex + 1) + basePolygon.points.length) % basePolygon.points.length;

      basePolygon.points[lowerIndex] = vec3.add(vec3.create(), basePolygon.points[lowerIndex], pointOffset);
      basePolygon.points[upperIndex] = vec3.add(vec3.create(), basePolygon.points[upperIndex], pointOffset);
    }
    else { // Moving a point.
      let intermediatePointPullCount = 0; // Number of points on either side of the pulled point.
      let totalPointPullCount = intermediatePointPullCount * 2 + 1;
      let index = ((partIndex - intermediatePointPullCount) + basePolygon.points.length) % basePolygon.points.length;
      
      while (totalPointPullCount) {
        basePolygon.points[index] = vec3.add(vec3.create(), basePolygon.points[index], pointOffset);

        index = (index + 1) % basePolygon.points.length;
        --totalPointPullCount;
      }
    }

    return basePolygon;
  },
  deletePoint: (oldAnnotation, partIndex) => {
    let basePolygon = {...oldAnnotation};
    if (partIndex < basePolygon.points.length) { // Deleting an edge.
      return basePolygon;
    }

    basePolygon.points.splice((partIndex + basePolygon.points.length) % basePolygon.points.length, 1);
    return basePolygon;
  },
  subdivideEdge: (oldAnnotation, partIndex) => {
    let basePolygon = {...oldAnnotation};
    if (partIndex >= basePolygon.points.length) { // The user performed the subdivide action on a point, not an edge.
      return basePolygon;
    }

    let lowerPoint = basePolygon.points[(partIndex + basePolygon.points.length) % basePolygon.points.length];
    let upperPoint = basePolygon.points[(partIndex + 1 + basePolygon.points.length) % basePolygon.points.length];
    let midPoint = vec3.add(vec3.create(), vec3.div(vec3.create(), vec3.sub(vec3.create(), upperPoint, lowerPoint), vec3.fromValues(2, 2, 2)), lowerPoint);

    basePolygon.points.splice((partIndex + 1 + basePolygon.points.length) % basePolygon.points.length, 0, midPoint);
    return basePolygon;
  }
});