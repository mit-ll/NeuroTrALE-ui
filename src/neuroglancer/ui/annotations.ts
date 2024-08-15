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

/**
 * @file User interface for display and editing annotations.
 */

import './annotations.css';

import debounce from 'lodash/debounce';
import {Annotation, AnnotationReference, AnnotationType, AxisAlignedBoundingBox, Ellipsoid, getAnnotationTypeHandler, Line, Polygon, LineString} from 'neuroglancer/annotation';
import {AnnotationLayer, AnnotationLayerState, PerspectiveViewAnnotationLayer, SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
import {DataFetchSliceViewRenderLayer, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {setAnnotationHoverStateFromMouseState} from 'neuroglancer/annotation/selection';
import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
import {NavigationState, VoxelSize} from 'neuroglancer/navigation_state';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {registerNested, TrackableValueInterface, WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
import {registerTool, Tool} from 'neuroglancer/ui/tool';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {mat3, mat3FromMat4, mat4, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyOptionalInt, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {formatBoundingBoxVolume, formatIntegerBounds, formatIntegerPoint, formatLength} from 'neuroglancer/util/spatial_units';
import {Uint64} from 'neuroglancer/util/uint64';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {ColorWidget} from 'neuroglancer/widget/color';
import {RangeWidget} from 'neuroglancer/widget/range';
import {StackView, Tab} from 'neuroglancer/widget/tab_view';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

type AnnotationIdAndPart = {
  id: string,
  partIndex?: number
};

export class AnnotationSegmentListWidget extends RefCounted {
  element = document.createElement('div');
  private addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  private segmentationState: SegmentationDisplayState|undefined|null;
  private debouncedUpdateView = debounce(() => this.updateView(), 0);
  constructor(
      public reference: Borrowed<AnnotationReference>,
      public annotationLayer: AnnotationLayerState) {
    super();
    this.element.className = 'neuroglancer-annotation-segment-list';
    const {addSegmentWidget} = this;
    addSegmentWidget.element.style.display = 'inline-block';
    addSegmentWidget.element.title = 'Associate segments';
    this.element.appendChild(addSegmentWidget.element);
    this.registerDisposer(annotationLayer.segmentationState.changed.add(this.debouncedUpdateView));
    this.registerDisposer(() => this.unregisterSegmentationState());
    this.registerDisposer(this.addSegmentWidget.valuesEntered.add(values => {
      const annotation = this.reference.value;
      if (annotation == null) {
        return;
      }
      const existingSegments = annotation.segments;
      const segments = [...(existingSegments || []), ...values];
      const newAnnotation = {...annotation, segments};
      this.annotationLayer.source.update(this.reference, newAnnotation);
      this.annotationLayer.source.commit(this.reference);
    }));
    this.registerDisposer(reference.changed.add(this.debouncedUpdateView));
    this.updateView();
  }

  private unregisterSegmentationState() {
    const {segmentationState} = this;
    if (segmentationState != null) {
      segmentationState.visibleSegments.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentColorHash.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentSelectionState.changed.remove(this.debouncedUpdateView);
      this.segmentationState = undefined;
    }
  }

  private updateView() {
    const segmentationState = this.annotationLayer.segmentationState.value;
    if (segmentationState !== this.segmentationState) {
      this.unregisterSegmentationState();
      this.segmentationState = segmentationState;
      if (segmentationState != null) {
        segmentationState.visibleSegments.changed.add(this.debouncedUpdateView);
        segmentationState.segmentColorHash.changed.add(this.debouncedUpdateView);
        segmentationState.segmentSelectionState.changed.add(this.debouncedUpdateView);
      }
    }

    const {element} = this;
    // Remove existing segment representations.
    for (let child = this.addSegmentWidget.element.nextElementSibling; child !== null;) {
      const next = child.nextElementSibling;
      element.removeChild(child);
      child = next;
    }
    element.style.display = 'none';
    const annotation = this.reference.value;
    if (annotation == null) {
      return;
    }
    const segments = annotation.segments;
    if (segmentationState === null) {
      return;
    }
    element.style.display = '';
    if (segments === undefined || segments.length === 0) {
      return;
    }
    const segmentColorHash = segmentationState ? segmentationState.segmentColorHash : undefined;
    segments.forEach((segment, index) => {
      if (index !== 0) {
        element.appendChild(document.createTextNode(' '));
      }
      const child = document.createElement('span');
      child.title =
          'Double click to toggle segment visibility, control+click to disassociate segment from annotation.';
      child.className = 'neuroglancer-annotation-segment-item';
      child.textContent = segment.toString();
      if (segmentationState !== undefined) {
        child.style.backgroundColor = segmentColorHash!.computeCssColor(segment);
        child.addEventListener('mouseenter', () => {
          segmentationState.segmentSelectionState.set(segment);
        });
        child.addEventListener('mouseleave', () => {
          segmentationState.segmentSelectionState.set(null);
        });
        child.addEventListener('dblclick', (event: MouseEvent) => {
          if (event.ctrlKey) {
            return;
          }
          if (segmentationState.visibleSegments.has(segment)) {
            segmentationState.visibleSegments.delete(segment);
          } else {
            segmentationState.visibleSegments.add(segment);
          }
        });
      }
      child.addEventListener('click', (event: MouseEvent) => {
        if (!event.ctrlKey) {
          return;
        }
        const existingSegments = annotation.segments || [];
        const newSegments = existingSegments.filter(x => !Uint64.equal(segment, x));
        const newAnnotation = {...annotation, segments: newSegments ? newSegments : undefined};
        this.annotationLayer.source.update(this.reference, newAnnotation);
        this.annotationLayer.source.commit(this.reference);
      });
      element.appendChild(child);
    });
  }
}

export class SelectedAnnotationState extends RefCounted implements
    TrackableValueInterface<AnnotationIdAndPart|undefined> {
  private value_: AnnotationIdAndPart|undefined;
  changed = new NullarySignal();

  private annotationLayer: AnnotationLayerState|undefined;
  private reference_: Owned<AnnotationReference>|undefined;

  get reference() {
    return this.reference_;
  }

  constructor(public annotationLayerState: Owned<WatchableRefCounted<AnnotationLayerState>>) {
    super();
    this.registerDisposer(annotationLayerState);
    this.registerDisposer(annotationLayerState.changed.add(this.validate));
    this.updateAnnotationLayer();
    this.reference_ = undefined;
    this.value_ = undefined;
  }

  get value() {
    return this.value_;
  }

  get validValue() {
    return this.annotationLayer && this.value_;
  }

  set value(value: AnnotationIdAndPart|undefined) {
    this.value_ = value;
    const reference = this.reference_;
    if (reference !== undefined) {
      if (value === undefined || reference.id !== value.id) {
        this.unbindReference();
      }
    }
    this.validate();
    this.changed.dispatch();
  }

  private updateAnnotationLayer() {
    const annotationLayer = this.annotationLayerState.value;
    if (annotationLayer === this.annotationLayer) {
      return false;
    }
    this.unbindLayer();
    this.annotationLayer = annotationLayer;
    if (annotationLayer !== undefined) {
      annotationLayer.source.changed.add(this.validate);
    }
    return true;
  }

  private unbindLayer() {
    if (this.annotationLayer !== undefined) {
      this.annotationLayer.source.changed.remove(this.validate);
      this.annotationLayer = undefined;
    }
  }

  disposed() {
    this.unbindLayer();
    this.unbindReference();
    super.disposed();
  }

  private unbindReference() {
    const reference = this.reference_;
    if (reference !== undefined) {
      reference.changed.remove(this.referenceChanged);
      this.reference_ = undefined;
    }
  }

  private referenceChanged = (() => {
    this.validate();
    this.changed.dispatch();
  });

  private validate = (() => {
    const updatedLayer = this.updateAnnotationLayer();
    const {annotationLayer} = this;
    if (annotationLayer !== undefined) {
      const value = this.value_;
      if (value !== undefined) {
        let reference = this.reference_;
        if (reference !== undefined && reference.id !== value.id) {
          // Id changed.
          value.id = reference.id;
        } else if (reference === undefined) {
          reference = this.reference_ = annotationLayer.source.getReference(value.id);
          reference.changed.add(this.referenceChanged);
        }
        if (reference.value === null) {
          this.unbindReference();
          this.value = undefined;
          return;
        }
      } else {
        this.unbindReference();
      }
    }
    if (updatedLayer) {
      this.changed.dispatch();
    }
  });

  toJSON() {
    const value = this.value_;
    if (value === undefined) {
      return undefined;
    }
    if (value.partIndex === 0) {
      return value.id;
    }
    return value;
  }
  reset() {
    this.value = undefined;
  }
  restoreState(x: any) {
    if (x === undefined) {
      this.value = undefined;
      return;
    }
    if (typeof x === 'string') {
      this.value = {'id': x, 'partIndex': 0};
      return;
    }
    verifyObject(x);
    this.value = {
      'id': verifyObjectProperty(x, 'id', verifyString),
      'partIndex': verifyObjectProperty(x, 'partIndex', verifyOptionalInt),
    };
  }
}

const tempVec3 = vec3.create();

function makePointLink(
    point: vec3, transform: mat4, voxelSize: VoxelSize,
    setSpatialCoordinates?: (point: vec3) => void) {
  const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
  const positionText = formatIntegerPoint(voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
  if (setSpatialCoordinates !== undefined) {
    const element = document.createElement('span');
    element.className = 'neuroglancer-voxel-coordinates-link';
    element.textContent = positionText;
    element.title = `Center view on voxel coordinates ${positionText}.`;
    element.addEventListener('click', () => {
      setSpatialCoordinates(spatialPoint);
    });
    return element;
  } else {
    return document.createTextNode(positionText);
  }
}

function makeCheckbox(annotation:Annotation) {
  const checkbox = document.createElement('input');
  checkbox.id = annotation.id;
  checkbox.type = 'checkbox';
  checkbox.name = 'reviewed status';
  if (annotation.reviewed == undefined) {
    return;
  }
  if (checkbox.checked) {
    annotation.visited = true;
  }
  if (annotation.reviewed) {
    checkbox.value = "reviewed";
    checkbox.checked = true;
  }
  else {
    checkbox.value = "unreviewed";
    checkbox.checked = false;
    annotation.reviewed = false;
  }
  checkbox.onclick = function() {
    if (checkbox.checked) {
      annotation.reviewed = true;
    } else {
      annotation.reviewed = false;
    }
  }
  return checkbox;
}

export function getPositionSummary(
    element: HTMLElement, annotation: Annotation, transform: mat4, voxelSize: VoxelSize,
    setSpatialCoordinates?: (point: vec3) => void) {
  const makePointLinkWithTransform = (point: vec3) =>
      makePointLink(point, transform, voxelSize, setSpatialCoordinates);

  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      element.appendChild(makePointLinkWithTransform(annotation.pointA));
      element.appendChild(document.createTextNode('–'));
      element.appendChild(makePointLinkWithTransform(annotation.pointB));
      element.appendChild(document.createTextNode(' | reviewed: '));
      let lineCheck = makeCheckbox(annotation);
      element.appendChild(lineCheck!);
      break;
    case AnnotationType.POINT:
      element.appendChild(makePointLinkWithTransform(annotation.point));
      element.appendChild(document.createTextNode(' | reviewed: '));
      let pointBox = makeCheckbox(annotation);
      element.appendChild(pointBox!);
      break;
    case AnnotationType.ELLIPSOID:
      element.appendChild(makePointLinkWithTransform(annotation.center));
      const transformedRadii = transformVectorByMat4(tempVec3, annotation.radii, transform);
      voxelSize.voxelFromSpatial(transformedRadii, transformedRadii);
      element.appendChild(document.createTextNode('±' + formatIntegerBounds(transformedRadii)));
      element.appendChild(document.createTextNode(' | reviewed: '));
      let ellipsoidCheck = makeCheckbox(annotation);
      element.appendChild(ellipsoidCheck!);
      break;
    case AnnotationType.POLYGON:
    case AnnotationType.LINESTRING: 
      element.appendChild(makePointLinkWithTransform(annotation.points[0])); // TODO Calculate center point.
      element.appendChild(document.createTextNode(' / ' + annotation.points.length + ' | reviewed: '));
      let polygonLinestringCheck = makeCheckbox(annotation);
      element.appendChild(polygonLinestringCheck!);
  }
}

function getCenterPosition(annotation: Annotation, transform: mat4) {
  const center = vec3.create();
  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      vec3.add(center, annotation.pointA, annotation.pointB);
      vec3.scale(center, center, 0.5);
      break;
    case AnnotationType.POINT:
      vec3.copy(center, annotation.point);
      break;
    case AnnotationType.ELLIPSOID:
      vec3.copy(center, annotation.center);
      break;
  }
  return vec3.transformMat4(center, center, transform);
}

export class AnnotationLayerView extends Tab {
  private annotationListContainer = document.createElement('ul');
  private annotationListElements = new Map<string, HTMLElement>();
  private previousSelectedId: string|undefined;
  private previousHoverId: string|undefined;
  private updated = false;

  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>,
      public annotationLayer: Owned<AnnotationLayerState>,
      public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-layer-view');
    this.annotationListContainer.classList.add('neuroglancer-annotation-list');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(annotationLayer);
    const {source} = annotationLayer;
    const updateView = () => {
      this.updated = false;
      this.updateView();
    };
    this.registerDisposer(source.childAdded.add((annotation) => this.addAnnotationElement(annotation)));
    this.registerDisposer(source.childUpdated.add((annotation) => this.updateAnnotationElement(annotation)));
    this.registerDisposer(source.childDeleted.add((annotationId) => this.deleteAnnotationElement(annotationId)));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.registerDisposer(source.changed.add(() => updateView()));
    this.registerDisposer(annotationLayer.transform.changed.add(updateView));
    this.updateView();

    const toolbox = document.createElement('div');
    toolbox.className = 'neuroglancer-annotation-toolbox';

    layer.initializeAnnotationLayerViewTab(this);

    {
      const widget = this.registerDisposer(new RangeWidget(this.annotationLayer.fillOpacity));
      widget.promptElement.textContent = 'Fill opacity';
      this.element.appendChild(widget.element);
    }

    {
      const widget = this.registerDisposer(new RangeWidget(this.annotationLayer.sizeFilter, {min: 0, max: 1, step: 0.1}));
      widget.promptElement.textContent = 'Size filter';
      this.element.appendChild(widget.element);
    }

    const colorPicker = this.registerDisposer(new ColorWidget(this.annotationLayer.color));
    colorPicker.element.title = 'Change annotation display color';
    toolbox.appendChild(colorPicker.element);
    if (!annotationLayer.source.readonly) {
      const pointButton = document.createElement('button');
      pointButton.textContent = getAnnotationTypeHandler(AnnotationType.POINT).icon;
      pointButton.title = 'Annotate point';
      pointButton.addEventListener('click', () => {
        this.layer.tool.value = new PlacePointTool(this.layer, {});
      });
      toolbox.appendChild(pointButton);


      const boundingBoxButton = document.createElement('button');
      boundingBoxButton.textContent =
          getAnnotationTypeHandler(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX).icon;
      boundingBoxButton.title = 'Annotate bounding box';
      boundingBoxButton.addEventListener('click', () => {
        this.layer.tool.value = new PlaceBoundingBoxTool(this.layer, {});
      });
      toolbox.appendChild(boundingBoxButton);


      const lineButton = document.createElement('button');
      lineButton.textContent = getAnnotationTypeHandler(AnnotationType.LINE).icon;
      lineButton.title = 'Annotate line';
      lineButton.addEventListener('click', () => {
        this.layer.tool.value = new PlaceLineTool(this.layer, {});
      });
      toolbox.appendChild(lineButton);


      const ellipsoidButton = document.createElement('button');
      ellipsoidButton.textContent = getAnnotationTypeHandler(AnnotationType.ELLIPSOID).icon;
      ellipsoidButton.title = 'Annotate ellipsoid';
      ellipsoidButton.addEventListener('click', () => {
        this.layer.tool.value = new PlaceSphereTool(this.layer, {});
      });
      toolbox.appendChild(ellipsoidButton);

      const polygonButton = document.createElement('button');
      polygonButton.textContent = getAnnotationTypeHandler(AnnotationType.POLYGON).icon;
      polygonButton.title = 'Annotate polygon';
      polygonButton.addEventListener('click', () => {
        this.layer.tool.value = new PlacePolygonTool(this.layer, {});
      });
      toolbox.appendChild(polygonButton);

      const linestringButton = document.createElement('button');
      linestringButton.textContent = getAnnotationTypeHandler(AnnotationType.LINESTRING).icon;
      linestringButton.title = 'Annotate line string';
      linestringButton.addEventListener('click', () => {
        this.layer.tool.value = new PlaceLineStringTool(this.layer, {});
      });
      toolbox.appendChild(linestringButton);
    }
    this.element.appendChild(toolbox);

    this.element.appendChild(this.annotationListContainer);

    this.annotationListContainer.addEventListener('mouseleave', () => {
      this.annotationLayer.hoverState.value = undefined;
    });
    this.registerDisposer(
        this.annotationLayer.hoverState.changed.add(() => this.updateHoverView()));
    this.registerDisposer(this.state.changed.add(() => this.updateSelectionView()));
  }

  private updateSelectionView() {
    const selectedValue = this.state.value;
    let newSelectedId: string|undefined;
    if (selectedValue !== undefined) {
      newSelectedId = selectedValue.id;
    }
    const {previousSelectedId} = this;
    if (newSelectedId === previousSelectedId) {
      return;
    }
    if (previousSelectedId !== undefined) {
      const element = this.annotationListElements.get(previousSelectedId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-selected');
      }
    }
    if (newSelectedId !== undefined) {
      const element = this.annotationListElements.get(newSelectedId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-selected');
        element.scrollIntoView();
      }
    }
    this.previousSelectedId = newSelectedId;
    this.updateView();
  }

  private updateHoverView() {
    const selectedValue = this.annotationLayer.hoverState.value;
    let newHoverId: string|undefined;
    if (selectedValue !== undefined) {
      newHoverId = selectedValue.id;
    }
    const {previousHoverId} = this;
    if (newHoverId === previousHoverId) {
      return;
    }
    if (previousHoverId !== undefined) {
      const element = this.annotationListElements.get(previousHoverId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-hover');
      }
    }
    if (newHoverId !== undefined) {
      const element = this.annotationListElements.get(newHoverId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-hover');
      }
    }
    this.previousHoverId = newHoverId;
  }

  private addAnnotationElementHelper(annotation: Annotation) {
    const {annotationLayer, annotationListContainer, annotationListElements} = this;
    const {objectToGlobal} = annotationLayer;

    const element = this.makeAnnotationListElement(annotation, objectToGlobal);
    // sort annotation list by review vs unreviewed 
    if (annotation.reviewed) {
      annotationListContainer.appendChild(element);
    } else {
      annotationListContainer.insertBefore(element, annotationListContainer.firstChild);
    }
    
    annotationListElements.set(annotation.id, element);

    element.addEventListener('mouseenter', () => {
      this.annotationLayer.hoverState.value = {id: annotation.id, partIndex: 0};
    });
    element.addEventListener('click', () => {
      this.state.value = {id: annotation.id, partIndex: 0};
      if (!annotation.visited) {
        annotation.reviewed = true;
      }
      annotation.visited = true;
      if (!annotation.reviewed) {
        annotation.reviewed;
      }
      const {reference} = this.state;
      if (reference == null) {
        return;
      }
      annotationLayer.source.update(reference, {...annotation});
      annotationLayer.source.commit(reference);
      this.updated = false;
      this.updateView();
    });

    element.addEventListener('mouseup', (event: MouseEvent) => {
      if (event.button === 2) {
        this.setSpatialCoordinates(
            getCenterPosition(annotation, this.annotationLayer.objectToGlobal));
      }
    });
  }

  private updateView() {
    if (!this.visible) {
      return;
    }
    if (this.updated) {
      return;
    }
    const {annotationLayer, annotationListContainer, annotationListElements} = this;
    const {source} = annotationLayer;
    removeChildren(annotationListContainer);
    annotationListElements.clear();
    for(const annotation of source) {
      this.addAnnotationElementHelper(annotation);
    }
    this.resetOnUpdate();
  }

  private addAnnotationElement(annotation:Annotation) {
    if(!this.visible) {
      return;
    }
    this.addAnnotationElementHelper(annotation);
    this.resetOnUpdate();
  }

  private updateAnnotationElement(annotation:Annotation) {
    if (!this.visible) {
      return;
    }
    var element = this.annotationListElements.get(annotation.id);
    if (!element) {
      return;
    }
    if (element.lastElementChild && element.children.length === 3) {
      if (!annotation.description) {
        element.removeChild(element.lastElementChild);
      }
      else {
        element.lastElementChild.innerHTML = annotation.description;
      }
    }
    else {
      const description = document.createElement('div');
      description.className = 'neuroglancer-annotation-description';
      description.textContent = annotation.description || '';
      element.appendChild(description);
    }
    this.resetOnUpdate();
  }

  private deleteAnnotationElement(annotationId: string) {
    if (!this.visible) {
      return;
    }
    let element = this.annotationListElements.get(annotationId);
    if (element) {
      removeFromParent(element);
      this.annotationListElements.delete(annotationId);
    }
    this.resetOnUpdate();
  }

  private resetOnUpdate() {
    this.previousSelectedId = undefined;
    this.previousHoverId = undefined;
    this.updated = true;
    this.updateHoverView();
    this.updateSelectionView();
  }

  private makeAnnotationListElement(annotation: Annotation, transform: mat4) {
    const element = document.createElement('li');
    element.title = 'Click to select, right click to recenter view.';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-icon';
    icon.textContent = getAnnotationTypeHandler(annotation.type).icon;
    element.appendChild(icon);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-position';
    getPositionSummary(position, annotation, transform, this.voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);

    if (annotation.description) {
      const description = document.createElement('div');
      description.className = 'neuroglancer-annotation-description';
      description.textContent = annotation.description;
      element.appendChild(description);
    }
    return element;
  }
}

export class AnnotationDetailsTab extends Tab {
  private valid = false;
  private mouseEntered = false;
  private hoverState: WatchableValue<{id: string, partIndex?: number}|undefined>|undefined;
  private segmentListWidget: AnnotationSegmentListWidget|undefined;
  constructor(
      public state: Owned<SelectedAnnotationState>, public voxelSize: VoxelSize,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-details');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    }));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    });
    this.element.addEventListener('mouseenter', () => {
      this.mouseEntered = true;
      if (this.hoverState !== undefined) {
        this.hoverState.value = this.state.value;
      }
    });
    this.element.addEventListener('mouseleave', () => {
      this.mouseEntered = false;
      if (this.hoverState !== undefined) {
        this.hoverState.value = undefined;
      }
    });
    this.updateView();
  }

  private updateView() {
    if (!this.visible) {
      this.element.style.display = 'none';
      this.hoverState = undefined;
      return;
    }
    this.element.style.display = null;
    if (this.valid) {
      return;
    }
    const {element} = this;
    removeChildren(element);
    this.valid = true;
    const {reference} = this.state;
    if (reference === undefined) {
      return;
    }
    const value = this.state.value!;
    const annotation = reference.value;
    if (annotation == null) {
      return;
    }
    const annotationLayer = this.state.annotationLayerState.value!;
    this.hoverState = annotationLayer.hoverState;
    if (this.mouseEntered) {
      this.hoverState.value = value;
    }

    const {objectToGlobal} = annotationLayer;
    const {voxelSize} = this;

    const handler = getAnnotationTypeHandler(annotation.type);

    const title = document.createElement('div');
    title.className = 'neuroglancer-annotation-details-title';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-details-icon';
    icon.textContent = handler.icon;

    const titleText = document.createElement('div');
    titleText.className = 'neuroglancer-annotation-details-title-text';
    titleText.textContent = `${handler.description}`;
    title.appendChild(icon);
    title.appendChild(titleText);

    if (!annotationLayer.source.readonly) {
      const deleteButton = makeTextIconButton('🗑', 'Delete annotation');
      deleteButton.addEventListener('click', () => {
        const ref = annotationLayer.source.getReference(value.id);
        try {
          annotationLayer.source.delete(ref);
        } finally {
          ref.dispose();
        }
      });
      title.appendChild(deleteButton);
    }

    const closeButton = makeCloseButton();
    closeButton.title = 'Hide annotation details';
    closeButton.addEventListener('click', () => {
      this.state.value = undefined;
    });
    title.appendChild(closeButton);

    element.appendChild(title);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-details-position';
    getPositionSummary(position, annotation, objectToGlobal, voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);

    if (annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
      const volume = document.createElement('div');
      volume.className = 'neuroglancer-annotation-details-volume';
      volume.textContent =
          formatBoundingBoxVolume(annotation.pointA, annotation.pointB, objectToGlobal);
      element.appendChild(volume);

      // FIXME: only do this if it is axis aligned
      const spatialOffset = transformVectorByMat4(
          tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB), objectToGlobal);
      const voxelVolume = document.createElement('div');
      voxelVolume.className = 'neuroglancer-annotation-details-volume-in-voxels';
      const voxelOffset = voxelSize.voxelFromSpatial(tempVec3, spatialOffset);
      voxelVolume.textContent = `${formatIntegerBounds(voxelOffset)}`;
      element.appendChild(voxelVolume);
    } else if (annotation.type === AnnotationType.LINE) {
      const spatialOffset = transformVectorByMat4(
          tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB), objectToGlobal);
      const length = document.createElement('div');
      length.className = 'neuroglancer-annotation-details-length';
      const spatialLengthText = formatLength(vec3.length(spatialOffset));
      let voxelLengthText = '';
      if (voxelSize.valid) {
        const voxelLength = vec3.length(voxelSize.voxelFromSpatial(tempVec3, spatialOffset));
        voxelLengthText = `, ${Math.round(voxelLength)} vx`;
      }
      length.textContent = spatialLengthText + voxelLengthText;
      element.appendChild(length);
    }

    let {segmentListWidget} = this;
    if (segmentListWidget !== undefined) {
      if (segmentListWidget.reference !== reference) {
        segmentListWidget.dispose();
        this.unregisterDisposer(segmentListWidget);
        segmentListWidget = this.segmentListWidget = undefined;
      }
    }
    if (segmentListWidget === undefined) {
      this.segmentListWidget = segmentListWidget =
          this.registerDisposer(new AnnotationSegmentListWidget(reference, annotationLayer));
    }
    element.appendChild(segmentListWidget.element);

    const description = document.createElement('textarea');
    description.value = annotation.description || '';
    description.rows = 3;
    description.className = 'neuroglancer-annotation-details-description';
    description.placeholder = 'Description';
    if (annotationLayer.source.readonly) {
      description.readOnly = true;
    } else {
      description.addEventListener('change', () => {
        const x = description.value;
        annotationLayer.source.update(reference, {...annotation, description: x ? x : undefined});
        annotationLayer.source.commit(reference);
      });
    }
    element.appendChild(description);
  }
}

export class AnnotationTab extends Tab {
  private stack = this.registerDisposer(
      new StackView<AnnotationLayerState, AnnotationLayerView>(annotationLayerState => {
        return new AnnotationLayerView(
            this.layer, this.state.addRef(), annotationLayerState.addRef(), this.voxelSize.addRef(),
            this.setSpatialCoordinates);
      }, this.visibility));
  private detailsTab = this.registerDisposer(
      new AnnotationDetailsTab(this.state, this.voxelSize.addRef(), this.setSpatialCoordinates));
  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    const {element} = this;
    element.classList.add('neuroglancer-annotations-tab');
    this.stack.element.classList.add('neuroglancer-annotations-stack');
    element.appendChild(this.stack.element);
    element.appendChild(this.detailsTab.element);
    const updateDetailsVisibility = () => {
      this.detailsTab.visibility.value = this.state.validValue !== undefined && this.visible ?
          WatchableVisibilityPriority.VISIBLE :
          WatchableVisibilityPriority.IGNORED;
    };
    this.registerDisposer(this.state.changed.add(updateDetailsVisibility));
    this.registerDisposer(this.visibility.changed.add(updateDetailsVisibility));
    const setAnnotationLayerView = () => {
      this.stack.selected = this.state.annotationLayerState.value;
    };
    this.registerDisposer(this.state.annotationLayerState.changed.add(setAnnotationLayerView));
    setAnnotationLayerView();
  }
}

function getSelectedAssocatedSegment(annotationLayer: AnnotationLayerState) {
  let segments: Uint64[]|undefined;
  const segmentationState = annotationLayer.segmentationState.value;
  if (segmentationState != null) {
    if (segmentationState.segmentSelectionState.hasSelectedSegment) {
      segments = [segmentationState.segmentSelectionState.selectedSegment.clone()];
    }
  }
  return segments;
}

abstract class PlaceAnnotationTool extends Tool {
  group: string;
  annotationDescription: string|undefined;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super();
    if (layer.annotationLayerState === undefined) {
      throw new Error(`Invalid layer for annotation tool.`);
    }
    this.annotationDescription = verifyObjectProperty(options, 'description', verifyOptionalString);
  }

  get annotationLayer() {
    return this.layer.annotationLayerState.value;
  }
}

const ANNOTATE_POINT_TOOL_ID = 'annotatePoint';
const ANNOTATE_LINE_TOOL_ID = 'annotateLine';
const ANNOTATE_BOUNDING_BOX_TOOL_ID = 'annotateBoundingBox';
const ANNOTATE_ELLIPSOID_TOOL_ID = 'annotateSphere';
const ANNOTATE_POLYGON_TOOL_ID = 'annotatePolygon';
const ANNOTATE_LINESTRING_TOOL_ID = 'annotateLineString';

export class PlacePointTool extends PlaceAnnotationTool {
  constructor(layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
  }

  trigger(mouseState: MouseSelectionState) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const annotation: Annotation = {
        id: '',
        description: '',
        segments: getSelectedAssocatedSegment(annotationLayer),
        point:
            vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject),
        type: AnnotationType.POINT,
        anntype: this.layer.annotationType ? this.layer.annotationType : "unknown",
        reviewed: false,
        visited: false
      };
      const reference = annotationLayer.source.add(annotation, /*commit=*/true);
      this.layer.selectedAnnotation.value = {id: reference.id};
      reference.dispose();
    }
  }

  get description() {
    return `annotate point`;
  }

  toJSON() {
    return ANNOTATE_POINT_TOOL_ID;
  }
}

function getMousePositionInAnnotationCoordinates(
    mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState) {
  return vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject);
}

export abstract class TwoStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;
  isLastUpdate:boolean = false;
  selectionPathCanvas:HTMLCanvasElement = document.createElement("canvas");
  followAnnotationIndex:number = 0;
  followAnnotationId:string = "";
  followAnnotationLocation:vec3 = vec3.create();
  followAnnotationDistance:number = 10;
  followAnnotationForward:boolean|null = null;

  constructor(layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);

    // Initialize the 2D canvas context.
    this.selectionPathCanvas.getContext("2d");
  }

  abstract getInitialAnnotation(
      mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation;
  abstract getUpdatedAnnotation(
      oldAnnotation: Annotation, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation;

  trigger(mouseState: MouseSelectionState) {
    this.isLastUpdate = false;
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const updatePointB = () => {
        const state = this.inProgressAnnotation!;
        const reference = state.reference;
        const newAnnotation =
            this.getUpdatedAnnotation(reference.value!, mouseState, annotationLayer);
        state.annotationLayer.source.update(reference, newAnnotation);
        this.layer.selectedAnnotation.value = {id: reference.id};
      };

      if (this.inProgressAnnotation === undefined) {
        const reference = annotationLayer.source.add(
            this.getInitialAnnotation(mouseState, annotationLayer), /*commit=*/false);
        this.layer.selectedAnnotation.value = {id: reference.id};
        const mouseDisposer = mouseState.changed.add(updatePointB);
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
      } else {
        let annotationLayer = this.inProgressAnnotation.annotationLayer;

        updatePointB();
        this.inProgressAnnotation.annotationLayer.source.commit(
            this.inProgressAnnotation.reference);
        this.inProgressAnnotation.disposer();
        this.inProgressAnnotation = undefined;

        this.isLastUpdate = true;
        annotationLayer.source.changed.dispatch();
      }
    }
  }

  // Enable the two-step annotation tool to select annotations within the drawn geometry.
  select(mouseState: MouseSelectionState) {
    this.isLastUpdate = false;
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const updatePointB = () => {
        const state = this.inProgressAnnotation!;
        const reference = state.reference;
        const newAnnotation =
            this.getUpdatedAnnotation(reference.value!, mouseState, annotationLayer);
        state.annotationLayer.source.update(reference, newAnnotation);
        this.layer.selectedAnnotation.value = {id: reference.id};
      };

      if (this.inProgressAnnotation === undefined) {
        const reference = annotationLayer.source.add(
            this.getInitialAnnotation(mouseState, annotationLayer), /*commit=*/false);
        this.layer.selectedAnnotation.value = {id: reference.id};
        const mouseDisposer = mouseState.changed.add(updatePointB);
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
      } else {
        let annotationLayer = this.inProgressAnnotation.annotationLayer;

        updatePointB();

        // TODO Clean up typecasting.
        const selectionGeometry:any = this.inProgressAnnotation.reference.value;
        let pathCtx = this.selectionPathCanvas.getContext("2d");
        pathCtx!.beginPath();
        for (let i = 0; i < selectionGeometry.points.length; ++i) {
          let point = selectionGeometry.points[i];

          if (i == 0) {
            pathCtx!.moveTo(point[0], point[1]);
          }
          else {
            pathCtx!.lineTo(point[0], point[1]);
          }
        }
        pathCtx!.closePath();
      
        if (selectionGeometry && selectionGeometry.points) {
          for (const [id, annotation] of annotationLayer.source.references.entries()) {
            if (id == this.inProgressAnnotation.reference.id) { // Don't check the selection geometry with itself.
              continue;
            }
            if (annotation.value == null) { // In case the geometry has been removed.
              continue;
            }

            let testGeometry:any = annotation.value;
            let hasSelection = false;
            testGeometry.selected = [];

            if (testGeometry.points) {
              for (let i = 0; i < testGeometry.points.length; ++i) {
                let point:vec3 = testGeometry.points[i];
                let isPointInSelection = pathCtx!.isPointInPath(point[0], point[1]);
                if (isPointInSelection) {
                  testGeometry.selected.push(true);
                  hasSelection = true;
                }
                else {
                  testGeometry.selected.push(false);
                }
              }
            }

            // Record whether any portion of the geometry has been selected for downstream handling.
            testGeometry.hasSelection = hasSelection;
          }
        }
        
        // TODO This appears to leave a null reference (by design?) in the 'references' object, but removes it from the 'annotationMap' object.
        // TODO Manage the deletion more cleanly; this appears to temporarily leave a null reference for the renderer.
        annotationLayer.source.delete(this.inProgressAnnotation.reference);
        this.inProgressAnnotation.disposer();
        this.inProgressAnnotation = undefined;

        // TODO Naming the flag isLastUpdate isn't accurate, rename to 'captureUpdates'?
        annotationLayer.source.changed.dispatch();
        this.isLastUpdate = true;
      }
    }
  }

  deleteSelection() {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }

    let isLayerModified = false;

    // TODO This only supports polygon and line string editing right now.
    for (const annotation of annotationLayer.source.references.values()) {
      if (annotation.value && annotation.value.hasSelection && (annotation.value.type == AnnotationType.POLYGON || annotation.value.type == AnnotationType.LINESTRING)) {
        isLayerModified = true;

        let lineStrings:any = [];
        let retainPoint = false;
        
        // Note that the selected points are the ones that should *not* be retained.
        for (let i = 0; i < annotation.value.points.length; ++i) {
          if (annotation.value.selected![i] == false && retainPoint == false) { // Start a new line string.
            lineStrings.push([]);
          }

          retainPoint = !annotation.value.selected![i];

          if (retainPoint) {
            lineStrings[lineStrings.length - 1].push(annotation.value.points[i]);
          }
        }

        // If the annotation being modified is a polygon, when the first line string and last line string are contiguous they should be fused.
        if (annotation.value.type == AnnotationType.POLYGON && lineStrings.length > 1 && annotation.value.selected![0] == false && annotation.value.selected![annotation.value.points.length - 1] == false) {
          lineStrings[0] = [].concat(lineStrings[lineStrings.length - 1], lineStrings[0]);
          lineStrings.splice(lineStrings.length - 1, 1);
        }

        // Delete the annotation.
        annotationLayer.source.delete(annotation);

        // Draw the remaining line strings.
        for (let i = 0; i < lineStrings.length; ++i) {
          let lineString = <LineString>{
            id: '',
            type: AnnotationType.LINESTRING,
            description: '',
            points: lineStrings[i],
            anntype: "unknown", // TODO Propagate the layer type (follow approach from newly-drawn annotations).
            reviewed: false,
            visited: false
          };

          annotationLayer.source.add(lineString, true);
        }
      }
    }

    // Refresh the layer if it was modified.
    if (isLayerModified) {
      annotationLayer.source.changed.dispatch();
    }

    // TODO Naming the flag isLastUpdate isn't accurate, rename to 'captureUpdates'?
    annotationLayer.source.changed.dispatch();
    this.isLastUpdate = true;
  }

  followAnnotation(navigationState: NavigationState, moveForward:boolean) {
    let annotation = this.layer.selectedAnnotation.reference!.value!;
    let points = (annotation as Polygon || annotation as LineString).points;
    let interpolate = true;

    if (points) {
      if (!interpolate) {
        let referenceIndex = 0; // In case the annotation was not selected before.

        // If the annotation selection has not changed, continue moving along it in the desired direction.
        if (this.followAnnotationId == annotation.id) {
          referenceIndex = moveForward ? this.followAnnotationIndex + 1 : this.followAnnotationIndex - 1;
          referenceIndex = (referenceIndex + points.length) % points.length;
        }

        // Determine the next point to move the camera to.
        let referencePoint = points[referenceIndex];
        let nextPosition = navigationState.voxelSize.spatialFromVoxel(vec3.create(), vec3.fromValues(referencePoint[0], referencePoint[1], referencePoint[2]));

        // Update the camera.
        vec3.copy(navigationState.pose.position.spatialCoordinates, nextPosition);
        navigationState.pose.position.changed.dispatch();

        // Update the reference to continue following the current annotation in case it changed.
        this.followAnnotationId = annotation.id;

        // Update the reference index.
        this.followAnnotationIndex = referenceIndex;
      }
      else {
        let referenceIndex = this.followAnnotationId == annotation.id ? this.followAnnotationIndex : 0;
        if (this.followAnnotationId == annotation.id && moveForward && moveForward != this.followAnnotationForward) {
          referenceIndex = ((referenceIndex - 1) + points.length) % points.length;
        }
        else if (this.followAnnotationId == annotation.id && !moveForward && moveForward != this.followAnnotationForward) {
          referenceIndex = ((referenceIndex + 1) + points.length) % points.length;
        }

        let currentPoint = this.followAnnotationId == annotation.id ? this.followAnnotationLocation : points[referenceIndex];
        let nextPoint = points[((moveForward ? referenceIndex + 1 : referenceIndex - 1) + points.length) % points.length];
        let direction = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), nextPoint, currentPoint));

        let moveToPoint = this.followAnnotationId == annotation.id ? this.followAnnotationLocation : currentPoint;
        let distanceToMove = this.followAnnotationId == annotation.id ? this.followAnnotationDistance : 0;

        // Don't traverse the gap between the first and last points, just jump across it.
        if (currentPoint == points[0] && nextPoint == points[points.length - 1] || currentPoint == points[points.length - 1] && nextPoint == points[0]) {
          currentPoint = nextPoint;
          referenceIndex = moveForward ? referenceIndex + 1 : referenceIndex - 1;
          nextPoint = points[(referenceIndex + points.length) % points.length];
          moveToPoint = nextPoint;
        }
        else {
          while (distanceToMove > 0) {
            moveToPoint = vec3.scaleAndAdd(vec3.create(), currentPoint, direction, distanceToMove);
            let difference = vec3.subtract(vec3.create(), nextPoint, moveToPoint);
            let length = vec3.length(difference);

            if (length < distanceToMove && (referenceIndex == points.length - 2 && moveForward || referenceIndex == 1 && !moveForward)) {
              distanceToMove = 0;
              moveToPoint = nextPoint;
              referenceIndex = ((moveForward ? referenceIndex + 1 : referenceIndex - 1) + points.length) % points.length;
            }
            if (length < distanceToMove) { // The projection extends beyond the next point, so continue iterating.
              distanceToMove -= length;

              currentPoint = nextPoint;
              referenceIndex = ((moveForward ? referenceIndex + 1 : referenceIndex - 1) + points.length) % points.length;
              nextPoint = points[((moveForward ? referenceIndex + 1 : referenceIndex - 1) + points.length) % points.length];
              direction = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), nextPoint, currentPoint));
            }
            else { // Didn't extend beyond the next point.
              distanceToMove = 0;
            }
          }
        }

        // Update the camera.
        let nextPosition = navigationState.voxelSize.spatialFromVoxel(vec3.create(), vec3.fromValues(moveToPoint[0], moveToPoint[1], moveToPoint[2]));
        vec3.copy(navigationState.pose.position.spatialCoordinates, nextPosition);
        navigationState.pose.position.changed.dispatch();

        // Update the reference to continue following the current annotation in case it changed.
        this.followAnnotationId = annotation.id;

        // Update the reference index.
        this.followAnnotationIndex = referenceIndex;

        // Update the reference location.
        this.followAnnotationLocation = moveToPoint;

        // Record the direction being moved.
        this.followAnnotationForward = moveForward;
      }
    }
  }

  disposed() {
    this.deactivate();
    super.disposed();
  }

  deactivate() {
    if (this.inProgressAnnotation !== undefined) {
      this.inProgressAnnotation.annotationLayer.source.delete(this.inProgressAnnotation.reference);
      this.inProgressAnnotation.disposer();
      this.inProgressAnnotation = undefined;
    }
  }
}


abstract class PlacePolygonAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.POLYGON;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
    Annotation {
      const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
      return <Polygon>{
        id: '',
        type: this.annotationType,
        description: '',
        points: [point],
        anntype: this.layer.annotationType ? this.layer.annotationType : "unknown",
        reviewed: false,
        visited: false,
        selected: [],
        hasSelection: false
      };
    }

  getUpdatedAnnotation(oldAnnotation: Polygon, mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
    Annotation {
      const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
      const lastPoint = oldAnnotation.points[oldAnnotation.points.length - 1];

      // Only record the new point if the cursor has moved.
      if (point[0] != lastPoint[0] || point[1] != lastPoint[1] || point[2] != lastPoint[2]) {        
        if (!isNaN(point[0]) && !isNaN(point[1]) && !isNaN(point[2])) {
          oldAnnotation.points.push(point);
        }
      }

      return oldAnnotation;
    }
}

abstract class PlaceLineStringAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.LINESTRING;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
    Annotation {
      const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
      let appendGeometry = false;

      if (appendGeometry) {        
        const upperLeft = vec3.transformMat4(vec3.create(), vec3.add(vec3.create(), mouseState.position, [-5, -5, 0]), annotationLayer.globalToObject);
        const upperRight = vec3.transformMat4(vec3.create(), vec3.add(vec3.create(), mouseState.position, [5, -5, 0]), annotationLayer.globalToObject);
        const lowerRight = vec3.transformMat4(vec3.create(), vec3.add(vec3.create(), mouseState.position, [5, 5, 0]), annotationLayer.globalToObject);
        const lowerLeft = vec3.transformMat4(vec3.create(), vec3.add(vec3.create(), mouseState.position, [-5, 5, 0]), annotationLayer.globalToObject);

        // Check to see if point is in screen space radius of any other start or end of a line string.
        // If point overlaps radius, don't create new annotation and instead add new point to existing one.
        // Signal that getUpdatedAnnotation() should continue adding to existing annotation reference.

        // Generate a path for the test region around the user's point to find other line strings that start or end there.
        let pathCtx = this.selectionPathCanvas.getContext("2d");
        pathCtx!.beginPath();
        pathCtx!.moveTo(upperLeft[0], upperLeft[1]);
        pathCtx!.lineTo(upperRight[0], upperRight[1]);
        pathCtx!.lineTo(lowerRight[0], lowerRight[1]);
        pathCtx!.lineTo(lowerLeft[0], lowerLeft[1]);
        pathCtx!.closePath();

        for (const annotation of annotationLayer.source.references.values()) {
          if (annotation.value == null) { // In case the geometry has been removed.
            continue;
          }

          let testGeometry:any = annotation.value;
          let prependPoints = false;
          let appendPoints = false;

          if (testGeometry.points) {
            let startPoint = testGeometry.points[0];
            if (pathCtx!.isPointInPath(startPoint[0], startPoint[1])) { // Starting point is in the selection region.
              prependPoints = true;
            }

            if (testGeometry.points.length > 1) {
              let endPoint = testGeometry.points[testGeometry.points.length - 1];
              if (pathCtx!.isPointInPath(endPoint[0], endPoint[1])) { // Ending point is in the selection region.
                appendPoints = true;
              }
            }
          }

          if (prependPoints || appendPoints) { // Only allow modification of a single geometry.
            //console.log([prependPoints, appendPoints, annotation]);
            break;
          }
        }
      }

      return <LineString>{
        id: '',
        type: this.annotationType,
        description: '',
        points: [point],
        anntype: this.layer.annotationType ? this.layer.annotationType : "unknown",
        reviewed: false
      };
    }

  getUpdatedAnnotation(oldAnnotation: LineString, mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
    Annotation {
      const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
      const lastPoint = oldAnnotation.points[oldAnnotation.points.length - 1];

      // Only record the new point if the cursor has moved.
      if (point[0] != lastPoint[0] || point[1] != lastPoint[1] || point[2] != lastPoint[2]) {        
        if (!isNaN(point[0]) && !isNaN(point[1]) && !isNaN(point[2])) {
          oldAnnotation.points.push(point);
        }
      }

      return oldAnnotation;
    }
}


abstract class PlaceTwoCornerAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.LINE|AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return <AxisAlignedBoundingBox|Line>{
      id: '',
      type: this.annotationType,
      description: '',
      pointA: point,
      pointB: point,
      anntype: this.layer.annotationType ? this.layer.annotationType : "unknown",
      reviewed: false
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: AxisAlignedBoundingBox|Line, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return {...oldAnnotation, pointB: point};
  }
}

export class PlaceBoundingBoxTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate bounding box`;
  }

  toJSON() {
    return ANNOTATE_BOUNDING_BOX_TOOL_ID;
  }
}
PlaceBoundingBoxTool.prototype.annotationType = AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

export class PlaceLineTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate line`;
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation {
    const result = super.getInitialAnnotation(mouseState, annotationLayer);
    result.segments = getSelectedAssocatedSegment(annotationLayer);
    return result;
  }

  getUpdatedAnnotation(
      oldAnnotation: Line|AxisAlignedBoundingBox, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const result = super.getUpdatedAnnotation(oldAnnotation, mouseState, annotationLayer);
    const segments = result.segments;
    if (segments !== undefined && segments.length > 0) {
      segments.length = 1;
    }
    let newSegments = getSelectedAssocatedSegment(annotationLayer);
    if (newSegments && segments) {
      newSegments = newSegments.filter(x => segments.findIndex(y => Uint64.equal(x, y)) === -1);
    }
    result.segments = [...(segments || []), ...(newSegments || [])] || undefined;
    return result;
  }

  toJSON() {
    return ANNOTATE_LINE_TOOL_ID;
  }
}
PlaceLineTool.prototype.annotationType = AnnotationType.LINE;

class PlaceSphereTool extends TwoStepAnnotationTool {
  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);

    return <Ellipsoid>{
      type: AnnotationType.ELLIPSOID,
      id: '',
      description: '',
      segments: getSelectedAssocatedSegment(annotationLayer),
      center: point,
      radii: vec3.fromValues(0, 0, 0),
      anntype: this.layer.annotationType ? this.layer.annotationType : "unknown",
      reviewed: false
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: Ellipsoid, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const spatialCenter =
        vec3.transformMat4(vec3.create(), oldAnnotation.center, annotationLayer.objectToGlobal);

    const radius = vec3.distance(spatialCenter, mouseState.position);

    const tempMatrix = mat3.create();
    tempMatrix[0] = tempMatrix[4] = tempMatrix[8] = 1 / (radius * radius);


    const objectToGlobalLinearTransform =
        mat3FromMat4(mat3.create(), annotationLayer.objectToGlobal);
    mat3.multiply(tempMatrix, tempMatrix, objectToGlobalLinearTransform);
    mat3.transpose(objectToGlobalLinearTransform, objectToGlobalLinearTransform);
    mat3.multiply(tempMatrix, objectToGlobalLinearTransform, tempMatrix);

    return <Ellipsoid>{
      ...oldAnnotation,
      radii: vec3.fromValues(
          1 / Math.sqrt(tempMatrix[0]), 1 / Math.sqrt(tempMatrix[4]), 1 / Math.sqrt(tempMatrix[8])),
    };
  }
  get description() {
    return `annotate ellipsoid`;
  }

  toJSON() {
    return ANNOTATE_ELLIPSOID_TOOL_ID;
  }
}

export class PlacePolygonTool extends PlacePolygonAnnotationTool {
  get description() {
    return `annotate polygon`;
  }

  toJSON() {
    return ANNOTATE_POLYGON_TOOL_ID;
  }
}
PlacePolygonTool.prototype.annotationType = AnnotationType.POLYGON;

export class PlaceLineStringTool extends PlaceLineStringAnnotationTool {
  get description() {
    return `annotate line string`;
  }

  toJSON() {
    return ANNOTATE_LINESTRING_TOOL_ID;
  }
}
PlaceLineStringAnnotationTool.prototype.annotationType = AnnotationType.LINESTRING;

registerTool(
    ANNOTATE_POINT_TOOL_ID,
    (layer, options) => new PlacePointTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_BOUNDING_BOX_TOOL_ID,
    (layer, options) => new PlaceBoundingBoxTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_LINE_TOOL_ID,
    (layer, options) => new PlaceLineTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_ELLIPSOID_TOOL_ID,
  (layer, options) => new PlaceSphereTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_POLYGON_TOOL_ID,
  (layer, options) => new PlacePolygonTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_LINESTRING_TOOL_ID,
  (layer, options) => new PlaceLineStringTool(<UserLayerWithAnnotations>layer, options));

export interface UserLayerWithAnnotations extends UserLayer {
  annotationType?: any;
  annotationLayerState: WatchableRefCounted<AnnotationLayerState>;
  selectedAnnotation: SelectedAnnotationState;
  annotationColor: TrackableRGB;
  annotationFillOpacity: TrackableAlphaValue;
  initializeAnnotationLayerViewTab(tab: AnnotationLayerView): void;
}

export function getAnnotationRenderOptions(userLayer: UserLayerWithAnnotations) {
  return {color: userLayer.annotationColor, fillOpacity: userLayer.annotationFillOpacity};
}

const SELECTED_ANNOTATION_JSON_KEY = 'selectedAnnotation';
const ANNOTATION_COLOR_JSON_KEY = 'annotationColor';
const ANNOTATION_FILL_OPACITY_JSON_KEY = 'annotationFillOpacity';
export function UserLayerWithAnnotationsMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  abstract class C extends Base implements UserLayerWithAnnotations {
    annotationLayerState = this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());
    selectedAnnotation =
        this.registerDisposer(new SelectedAnnotationState(this.annotationLayerState.addRef()));
    annotationColor = new TrackableRGB(vec3.fromValues(1, 1, 0));
    annotationFillOpacity = trackableAlphaValue(0.0);

    constructor(...args: any[]) {
      super(...args);
      this.selectedAnnotation.changed.add(this.specificationChanged.dispatch);
      this.annotationColor.changed.add(this.specificationChanged.dispatch);
      this.annotationFillOpacity.changed.add(this.specificationChanged.dispatch);
      this.tabs.add('annotations', {
        label: 'Annotations',
        order: 10,
        getter: () => new AnnotationTab(
            this, this.selectedAnnotation.addRef(), this.manager.voxelSize.addRef(),
            point => this.manager.setSpatialCoordinates(point))
      });
      this.annotationLayerState.changed.add(() => {
        const state = this.annotationLayerState.value;
        if (state !== undefined) {
          const annotationLayer = new AnnotationLayer(this.manager.chunkManager, state.addRef());
          setAnnotationHoverStateFromMouseState(state, this.manager.layerSelectedValues.mouseState);
          this.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
          this.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
          if (annotationLayer.source instanceof MultiscaleAnnotationSource) {
            const dataFetchLayer = this.registerDisposer(
                new DataFetchSliceViewRenderLayer(annotationLayer.source.addRef()));
            this.registerDisposer(registerNested(state.filterBySegmentation, (context, value) => {
              if (!value) {
                this.addRenderLayer(dataFetchLayer.addRef());
                context.registerDisposer(() => this.removeRenderLayer(dataFetchLayer));
              }
            }));
          }
        }
      });
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      this.selectedAnnotation.restoreState(specification[SELECTED_ANNOTATION_JSON_KEY]);
      this.annotationColor.restoreState(specification[ANNOTATION_COLOR_JSON_KEY]);
      this.annotationFillOpacity.restoreState(specification[ANNOTATION_FILL_OPACITY_JSON_KEY]);
    }

    toJSON() {
      const x = super.toJSON();
      x[SELECTED_ANNOTATION_JSON_KEY] = this.selectedAnnotation.toJSON();
      x[ANNOTATION_COLOR_JSON_KEY] = this.annotationColor.toJSON();
      x[ANNOTATION_FILL_OPACITY_JSON_KEY] = this.annotationFillOpacity.toJSON();
      return x;
    }

    initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
      tab;
    }
  }
  return C;
}
