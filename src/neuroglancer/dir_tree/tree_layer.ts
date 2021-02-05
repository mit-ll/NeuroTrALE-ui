/**
 * @license
 * Copyright 2016 Google Inc.
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
//import {UserLayer} from 'neuroglancer/layer';
import $ from "jquery";
import 'jstree';
import { LayerManager } from "../layer";
//import {LayerListSpecification, ManagedUserLayerWithSpecification} from 'neuroglancer/layer_specification';
//import {Tab} from 'neuroglancer/widget/tab_view';

import { Point, Polygon } from '../annotation';
import { AnnotationUserLayer } from '../annotation/user_layer';
import { NavigationState } from '../navigation_state';
import { vec3, vec4 } from '../util/geom';
//import { VoxelSize, SpatialPosition } from '../navigation_state';


require('./user_layer.css');
// require('./tree_layer.css');

/*
const SOURCE_JSON_KEY = 'source';

export class TreeUserLayer extends UserLayer {
  sourceUrl: string|undefined;
  element: HTMLElement;
  arrayCollection: {};

  constructor(manager: LayerListSpecification, specification: any) {
    super(manager, specification);
    this.sourceUrl = specification['url'];

    fetch(this.sourceUrl + '/tree.json')
      .then(response => response.json())
      .then(data => {this.tabs.add('Tree', {label: 'Tree', getter: () => new DisplayTab(this, data, specification['layers'], specification['voxelSize'])});
    })

  }

  toJSON() {
    const x = super.toJSON();
    x['type'] = 'annotation';
    x[SOURCE_JSON_KEY] = this.sourceUrl;
    return x;
  }

}
*/
/*
class DisplayTab extends Tab {
  constructor(public layer: UserLayer, public data: JSON, public layers: ManagedUserLayerWithSpecification[], public  position: SpatialPosition) {
    super();
    const {element} = this;

    // console.log(data);
    // console.log(tree);

    let div = document.createElement('div');
    let jstree = document.createElement('div');
    div.setAttribute("style", "overflow: auto; height: 100vh; width: 100vw;");
    div.appendChild(jstree);

    // console.log(tree);
    
    $(jstree).jstree({
      'core': {
        'data': data
      }
    });

    
    $(jstree).on('select_node.jstree', function(_: any, data: any) {
      console.log(data.node.original.id);
      if (data.node.original.id !== null) {
        layers.forEach(function(layer) {
          
          console.log(layer);

          // TODO: Change other types to handle multiple points.
          if (layer !== null && layer.layer instanceof AnnotationUserLayer && layer.layer.localAnnotations.get(data.node.original.id) !== undefined) {
            var point = layer.layer.localAnnotations.get(data.node.original.id);
            
            //TODO change to vec3[]
            var points: vec3;

            if ((<Point>point).point !== undefined) {
              points = (<Point>point).point;
            } else {
              //TODO: Fix, handle all points
              points = (<Polygon>point).points[0];
            }

            console.log(points);
            position.setVoxelCoordinates(points);
            
          }

        })


      }
    });
    element.appendChild(div);
  }
}
*/
//registerLayerType('tree', TreeUserLayer);

export const annotationColorMap:Map<string, vec4> = new Map(); // TODO Move this color map to a self-contained class.

export class TreeInfoPanelContainer {
  jstree: Node;
  element: HTMLDivElement;
  layerManager: LayerManager;
  sourceUrl: string = "";
  navigationState: NavigationState;
  treeData: Array<object>;
  colorIndex: number = 0;

  constructor() {
    let instance = this;
    let div = document.createElement('div');
    this.jstree = document.createElement('div');
    div.appendChild(this.jstree);
    
    $(this.jstree).on('select_node.jstree', function(_: any, data: any) {
      //console.log(data.node.original.id);
      if (data.node.original.id !== null) {
        instance.layerManager.layerSet.forEach(function(layer) {
          
          //console.log(layer);

          // TODO: Change other types to handle multiple points.
          if (layer !== null && layer.layer instanceof AnnotationUserLayer && layer.layer.localAnnotations.get(data.node.original.id) !== undefined) {
            var point = layer.layer.localAnnotations.get(data.node.original.id);
            
            //TODO change to vec3[]
            var points: vec3;

            if ((<Point>point).point !== undefined) {
              points = (<Point>point).point;
            } else {
              //TODO: Fix, handle all points
              points = (<Polygon>point).points[0];
            }

            //console.log(points);
            instance.navigationState.position.setVoxelCoordinates(points);
            
          }

        })
      }
    });

    $(this.jstree).on("before_open.jstree", function(_, data) {
      let children = data.node.children;
      for (let i = 0; i < children.length; ++i) {
        let annotationId = children[i];
        let color = annotationColorMap.get(annotationId);
        let isAnnotationShowing = false;
        instance.layerManager.layerSet.forEach(function(layer) {
          if (layer !== null && layer.layer instanceof AnnotationUserLayer && layer.layer.localAnnotations.get(annotationId) !== undefined) {
            isAnnotationShowing = true;
          }
        });

        if (color) {
          $(`#${annotationId}_anchor`).css("color", `rgba(${color[0] * 255}, ${color[1] * 255}, ${color[2] * 255}, ${ isAnnotationShowing ? color[3] : color[3] / 4})`);
        }
      }
    });

    this.element = div;
    return this;
  }

  showTree() {
    this.element.setAttribute("style", "overflow: auto; min-width: 300px; border-left: 1px solid #222222;");
  }

  hideTree() {
    this.element.setAttribute("style", "display: none;");
  }

  constructColorMap() {
    let colorOptions = [vec4.fromValues(1, 0, 0, 1), // Red.
      vec4.fromValues(0, 0.5, 1, 1), // Blue.
      vec4.fromValues(0, 0.9, 0, 1), // Green.
      vec4.fromValues(0, 1, 1, 1), // Teal.
      vec4.fromValues(1, 0.7, 0, 1), // Orange.
      vec4.fromValues(1, 0, 1, 1), // Purple.
      vec4.fromValues(1, 1, 0, 1)]; // Yellow.

    for (let i = 0; i < this.treeData.length; ++i) {
      this.addIdsToColorMap(this.treeData[i], colorOptions);
    }
  }

  addIdsToColorMap(node: any, colorOptions: any[]) {
    if (node.id != null && !annotationColorMap.has(node.id)) {
      annotationColorMap.set(node.id, colorOptions[this.colorIndex % colorOptions.length]);
      ++this.colorIndex;
    }

    for (let i = 0; i < node.children.length; ++i) {
      this.addIdsToColorMap(node.children[i], colorOptions);
    }
  }

  loadTree(sourceUrl: string, layerManager: LayerManager, navigationState: NavigationState) {
    let instance = this;
    if (this.sourceUrl != sourceUrl) {
      this.sourceUrl = sourceUrl;
      this.layerManager = layerManager;
      this.navigationState = navigationState;
    }
    else { // The tree for the provided source URL has already been loaded.
      return;
    }

    fetch(sourceUrl + '/tree.json').then(response => {
      if (response.status != 200) {
        instance.hideTree();
        return;
      }

      response.json().then(data => {
        instance.treeData = data;
        instance.constructColorMap();
        instance.showTree();

        $(instance.jstree).jstree({
          'core': {
            'data': data
          }
        });
      });
    });
  }
}