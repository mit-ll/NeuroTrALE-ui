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
 * 
 * @modifcations
 * MIT modified this file. For more information see the NOTICES.txt file
 */

import {Annotation, AnnotationType} from 'neuroglancer/annotation';
import {AnnotationLayer} from 'neuroglancer/annotation/frontend';
import {PerspectiveViewRenderContext} from 'neuroglancer/perspective_view/render_layer';
import {SliceViewPanelRenderContext} from 'neuroglancer/sliceview/panel';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export interface AnnotationRenderContext {
  buffer: Buffer;
  annotationLayer: AnnotationLayer;
  renderContext: SliceViewPanelRenderContext|PerspectiveViewRenderContext;
  bufferOffset: number;
  colorMap: Array<vec4 | null>;
  sizeMap: Array<Number | null>;
  count: number;
  byteCount: number[];
  basePickId: number;
  selectedIndex: number;
  projectionMatrix: mat4;
}

const tempPickID = new Float32Array(4);

export abstract class AnnotationRenderHelper extends RefCounted {
  pickIdsPerInstance: (annotations: Annotation[]) => number[];
  getPickIdCount: (annotation: Annotation|null) => number;
  targetIsSliceView: boolean;

  constructor(public gl: GL) {
    super();
  }

  setPartIndex(builder: ShaderBuilder, ...partIndexExpressions: string[]) {
    let s = `
void setPartIndex(${partIndexExpressions.map((_, i) => `highp uint partIndex${i}`).join()}) {
  highp uint pickID = uPickID;
  highp uint pickBaseOffset = getPickBaseOffset();
${
        partIndexExpressions
            .map((_, i) => `highp uint pickOffset${i} = pickBaseOffset + partIndex${i};`)
            .join('\n')}
`;
    if (partIndexExpressions.length === 0) {
      s += `
  highp uint pickOffset0 = pickBaseOffset;
`;
    }
    s += `
  vPickID = pickID + pickOffset0;
  highp uint selectedIndex = uSelectedIndex;
if (selectedIndex == pickBaseOffset${
        partIndexExpressions.map((_, i) => ` || selectedIndex == pickOffset${i}`).join('')}) {
    vColor = uColorSelected;
  } else {
    vColor = uColor;
  }
}
`;
    builder.addVertexCode(s);
    return `setPartIndex(${partIndexExpressions.join()})`;
  }

  getCrossSectionFadeFactor() {
    if (this.targetIsSliceView) {
      return `(clamp(1.0 - 2.0 * abs(0.5 - gl_FragCoord.z), 0.0, 1.0))`;
    } else {
      return `(1.0)`;
    }
  }

  defineShader(builder: ShaderBuilder, isInstanced: boolean = false) {
    builder.addUniform('highp vec4', 'uColor');
    builder.addUniform('highp vec4', 'uColorSelected');
    builder.addUniform('highp uint', 'uSelectedIndex');
    builder.addVarying('highp vec4', 'vColor');
    // Transform from camera to clip coordinates.
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp uint', 'uPickID');
    builder.addVarying('highp uint', 'vPickID', 'flat');

    // TODO Empty array?
    /*builder.addVertexCode(`
highp uint getPickBaseOffset() { return uint(gl_InstanceID) * ${this.pickIdsPerInstance([]).reduce((a, b) => a + b, 0)}u; }
`);*/


  // For dynamic geometries, e.g. polygons and line strings, the instance ID is used to back out the base pick ID. For
  // static geometries, e.g. lines, the offset can be pre-calculated based on the number of instances being drawn.
  if (isInstanced) {
    builder.addVertexCode(`
    highp uint getPickBaseOffset() { return uint(gl_InstanceID) + uInstancedBasePickOffset; }
    `);
  }
  else {
    builder.addVertexCode(`
    highp uint getPickBaseOffset() { return uint(gl_InstanceID) * ${this.getPickIdCount(null)}u; }
    `);
  }

    builder.addFragmentCode(`
void emitAnnotation(vec4 color) {
  emit(color, vPickID);
}
`);
  }

  enable(shader: ShaderProgram, context: AnnotationRenderContext, callback: () => void) {
    shader.bind();
    const {gl} = this;
    const {renderContext} = context;
    const {annotationLayer} = context;
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, context.projectionMatrix);
    if (renderContext.emitPickID) {
      gl.uniform1ui(shader.uniform('uPickID'), context.basePickId);
    }
    if (renderContext.emitColor) {
      const colorVec4 = tempPickID;
      const color = annotationLayer.state.color.value;
      colorVec4[0] = color[0];
      colorVec4[1] = color[1];
      colorVec4[2] = color[2];
      colorVec4[3] = 1;
      gl.uniform4fv(shader.uniform('uColor'), colorVec4);
      const saturationAmount = 0.75;
      for (let i = 0; i < 3; ++i) {
        colorVec4[i] = saturationAmount + (1 - saturationAmount) * colorVec4[i];
      }
      gl.uniform4fv(shader.uniform('uColorSelected'), colorVec4);
      gl.uniform1ui(shader.uniform('uSelectedIndex'), context.selectedIndex);
    }

    callback();
  }

  abstract draw(context: AnnotationRenderContext): void;
}

interface AnnotationTypeRenderHandler<T extends Annotation> {
  bytes: (annotation: T) => number;
  serializer:
      (buffer: ArrayBuffer, offset: number,
       numAnnotations: number) => ((annotation: T, index: number) => void);
  perspectiveViewRenderHelper: {
    new(
        gl: GL,
        ): AnnotationRenderHelper;
  };
  sliceViewRenderHelper: {new(gl: GL): AnnotationRenderHelper;};
  pickIdsPerInstance: (annotations: T[]) => number[];
  getPickIdCount: (annotation: T) => number;
  getRepresentativePoint: (objectToData: mat4, annotation: T, partIndex: number) => vec3;
  updateViaRepresentativePoint:
      (oldAnnotation: T, position: vec3, dataToObject: mat4, partIndex: number) => T;
  snapPosition:
      (position: vec3, objectToData: mat4, data: ArrayBuffer, offset: number,
       partIndex: number) => void;
  deletePoint?: (oldAnnotation: T, partIndex: number) => T;
  subdivideEdge?: (oldAnnotation: T, partIndex: number) => T;
  createSelection?: (oldAnnotation: T, position: vec3, dataToObject: mat4, partIndex: number) => T;
}

const annotationTypeRenderHandlers =
    new Map<AnnotationType, AnnotationTypeRenderHandler<Annotation>>();

export function registerAnnotationTypeRenderHandler<T extends Annotation>(
    type: AnnotationType, handler: AnnotationTypeRenderHandler<T>) {
  annotationTypeRenderHandlers.set(type, handler);
}

export function getAnnotationTypeRenderHandler(type: AnnotationType):
    AnnotationTypeRenderHandler<Annotation> {
  return annotationTypeRenderHandlers.get(type)!;
}
