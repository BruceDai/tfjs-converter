/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {Tensor, tidy, getBackend} from '@tensorflow/tfjs-core';

import {NamedTensorMap, NamedTensorsMap} from '../data/index';
import {getNodeNameAndIndex, getTensor} from '../operations/executors/utils';
import * as operations from '../operations/index';
import {Node} from '../operations/index';

import {ExecutionContext, ExecutionContextInfo} from './execution_context';

import {util, computeConv2DInfo, computePool2DInfo, Conv2DInfo} from '@tensorflow/tfjs-core';
import {getParamValue} from '../operations/executors/utils';

interface NodeWithContexts {
  contexts: ExecutionContextInfo[];
  node: Node;
}

class OperandInfo {
  index: number;
  dtype: string;
  shape: number[];
}

export class GraphExecutor {
  private compiledOrder: operations.Node[] = [];
  private _weightMap: NamedTensorsMap = {};
  private weightIds: number[];
  private placeholders: string[];
  private outputs: string[];
  private compiledWebMLModel: boolean = false;
  private operandInfos: { [key: string]: OperandInfo } = {};
  private nn: any;
  private model: any;
  private operandIndex: number = 0;
  private compilation: any;
  private execution: any;
  get weightMap(): NamedTensorsMap {
    return this._weightMap;
  }
  set weightMap(weightMap: NamedTensorsMap) {
    const weightIds = Object.keys(weightMap).map(
        key => weightMap[key].map(tensor => tensor.id));
    this.weightIds = [].concat.apply([], weightIds);
    this._weightMap = weightMap;
  }

  get inputNodes(): string[] {
    return this.placeholders;
  }

  get outputNodes(): string[] {
    return this.outputs;
  }

  constructor(private graph: operations.Graph) {
    this.nn = (navigator as any).ml.getNeuralNetworkContext();
    this.placeholders = graph.placeholders.map(node => node.name);
    this.outputs = graph.outputs.map(node => node.name);
    this.compile();
  }

  get isControlFlowModel(): boolean {
    return this.graph.withControlFlow;
  }

  /**
   * Compiles the inference graph to generate the topology order of op nodes,
   * cache the result for inference execution.
   */
  private compile() {
    // Do not compile for graph with control flow, since the execution order
    // requires runtime evaluation of the output tensors.
    if (this.graph.withControlFlow) {
      return;
    }

    const stack = [...this.graph.inputs];
    const visited: {[key: string]: boolean} = {};
    while (stack.length > 0) {
      const node = stack.pop();
      visited[node.name] = true;
      this.compiledOrder.push(node);
      node.children.forEach((childNode) => {
        if (!visited[childNode.name] && childNode.inputNames.every(name => {
              const [nodeName, ] = getNodeNameAndIndex(name);
              return visited[nodeName];
            })) {
          stack.push(childNode);
        }
      });
    }
  }

  addScalarInt32(value: number) {
    const scalarInt32Type = {type: this.nn.INT32};
    let index = this.operandIndex++;
    this.model.addOperand(scalarInt32Type);
    this.model.setOperandValue(index, new Int32Array([value]));
    return index;
  }

  addScalarFloat32(value: number) {
    const scalarInt32Type = {type: this.nn.FLOAT32};
    let index = this.operandIndex++;
    this.model.addOperand(scalarInt32Type);
    this.model.setOperandValue(index, new Float32Array([value]));
    return index;
  }

  private async compileWebMLModel(inputTensors: NamedTensorsMap) {
    if (this.compiledWebMLModel === true) {
      return;
    }
    // console.log(this.graph);
    // console.log(this._weightMap);
    // console.log('compileWebMLModel');
    // console.log(this.nn);
    this.model = await this.nn.createModel({useWebGL2: true});
    // console.log(this.model);
    const context = new ExecutionContext(this._weightMap);
    const visited: { [key: string]: boolean } = {};
    this.compiledOrder.reduce<NamedTensorsMap>((map, node) => {
      // console.log(node);
      let opType = null;
      let inputs: any[] = []
      let outputs: any[] = [];
      if (visited[node.name]) {
      } else if (node.op === 'placeholder') {
        const tensor = map[node.name][0];
        const info = { index: this.operandIndex++, dtype: tensor.dtype, shape: tensor.shape };
        this.operandInfos[node.name] = info;
        // console.log(`Add operand ${node.name} {index: ${info.index}, type: ${info.dtype}, dimensions: [${info.shape}]}`);
        this.model.addOperand({type: this.nn.TENSOR_FLOAT32, dimensions: info.shape});
        visited[node.name] = true;
      } else if (node.op === 'const') {
        let tensor = map[node.name][0];
        // hack on weigths shape from [h, w, in, out] to [out, h, w, in]
        if (tensor.shape.length === 4) {
          // console.log(`transpose tensor ${tensor.shape}`);
          // console.log(tensor.dataSync());
          const transposed = tensor.transpose([3, 0, 1, 2]);
          // console.log(`  to ${transposed.shape}`);
          const info = { index: this.operandIndex++, dtype: tensor.dtype, shape: tensor.shape };
          this.operandInfos[node.name] = info;
          // console.log(`Add operand ${node.name} {index: ${info.index}, type: ${transposed.dtype}, dimensions: [${transposed.shape}]}`);
          this.model.addOperand({type: this.nn.TENSOR_FLOAT32, dimensions: transposed.shape});
          // console.log(`Set operand value`);
          this.model.setOperandValue(info.index, transposed.buffer().values);
          // console.log(transposed.dataSync());
        } else {
          const info = { index: this.operandIndex++, dtype: tensor.dtype, shape: tensor.shape };
          this.operandInfos[node.name] = info;
          // console.log(`Add operand ${node.name} {index: ${info.index}, type: ${info.dtype}, dimensions: [${info.shape}]}`);
          this.model.addOperand({type: this.nn.TENSOR_FLOAT32, dimensions: info.shape});
          // console.log(`Set operand value`);
          this.model.setOperandValue(info.index, tensor.buffer().values);
          // console.log(tensor.dataSync());
        }

        visited[node.name] = true;
      } else if (node.op === 'conv2d' || node.op === 'depthwiseConv2d') {
        const conv = node;
        let biasAdd, relu;
        let childNode = conv.children[0];
        if (childNode.op === 'add') {
          biasAdd = childNode;
          // console.log('Fuse biasAdd');
          childNode = biasAdd.children[0];
          if (childNode.op === 'clipByValue') {
            relu = childNode;
            // console.log('Fuse relu');
          }
        } else {
          // console.error('TODO: support non-bias case');
        }
        visited[conv.name] = true;
        if (biasAdd) visited[biasAdd.name] = true;
        if (relu) visited[relu.name] = true;
        const input = this.operandInfos[conv.inputNames[0]];
        inputs.push(input.index);
        const filter = this.operandInfos[conv.inputNames[1]];
        inputs.push(filter.index);
        const bias = this.operandInfos[biasAdd.inputNames[1]];
        inputs.push(bias.index);
        const pad = getParamValue('pad', node, map, context);
        if (pad === 'same') {
          inputs.push(this.addScalarInt32(this.nn.PADDING_SAME));
        } else if (pad === 'valid') {
          inputs.push(this.addScalarInt32(this.nn.PADDING_VALID));
        } else {
          throw Error(`padding ${pad} is not supported`);
        }
        const strides =
          getParamValue('strides', node, map, context) as number[];
        inputs.push(this.addScalarInt32(strides[1]));
        inputs.push(this.addScalarInt32(strides[2]));

        let depthwise = conv.op === 'conv2d' ? false : true;
        if (depthwise) {
          inputs.push(this.addScalarInt32(1));
        }
        const dataFormat =
          (getParamValue('dataFormat', node, map, context) as string)
            .toUpperCase();
        if (dataFormat != 'NHWC') {
          throw Error(`dataFormat ${dataFormat} is not supported`);
        }
        const dilations =
          getParamValue('dilations', node, map, context) as number[];
        if (!util.arraysEqual(dilations, [1, 1, 1, 1])) {
          // console.error(`dilations [${dilations}] is not supported`);
        }

        let fuseCode = this.nn.FUSED_NONE;
        if (relu) {
          const max = getParamValue('clipValueMax', relu, map, context) as number;
          if (max === 1) {
            fuseCode = this.nn.FUSED_RELU1;
          } else if (max === 6) {
            fuseCode = this.nn.FUSED_RELU6;
          } else {
            fuseCode = this.nn.FUSED_RELU;
          }
        }
        inputs.push(this.addScalarInt32(fuseCode));

        let outputName;
        if (relu) {
          outputName = relu.name;
        } else {
          outputName = biasAdd.name;
        }

        const inputShape: [number, number, number, number] = [input.shape[0], input.shape[1], input.shape[2], input.shape[3]];
        const filterShape: [number, number, number, number] = [filter.shape[0], filter.shape[1], filter.shape[2], filter.shape[3]];
        const strideShape: [number, number] = [strides[1], strides[2]];
        // console.log(`computeConv2DInfo [${inputShape}] [${filterShape}] [${strideShape}]`);
        const convInfo = computeConv2DInfo(inputShape, filterShape, strideShape, [dilations[0], dilations[1]], pad as 'valid' | 'same', 'floor', depthwise) as Conv2DInfo;
        const outputInfo = { index: this.operandIndex++, dtype: input.dtype, shape: convInfo.outShape }
        this.operandInfos[outputName] = outputInfo;
        // console.log(`Add operand ${outputName} {index: ${outputInfo.index}, type: ${outputInfo.dtype}, dimensions: [${outputInfo.shape}]}`);
        this.model.addOperand({type: this.nn.TENSOR_FLOAT32, dimensions: outputInfo.shape});
        outputs.push(outputInfo.index);
        // console.log(`Add operation {op: ${depthwise ? 'DEPTHWISE_CONV_2D' : 'CONV_2D'} input: ${input.index}, filter: ${filter.index}, bias: ${bias.index}, strides: [${strides}], pad: ${pad}, fuseCode: ${fuseCode}, output: ${outputInfo.index}}`);
        opType = depthwise ? this.nn.DEPTHWISE_CONV_2D : this.nn.CONV_2D;
      } else if (node.op === 'avgPool') {
        const pool = node;
        let relu;
        let childNode = pool.children[0];
        if (childNode.op === 'clipByValue') {
          relu = childNode;
          // console.log('Fuse relu');
        }
        visited[pool.name] = true;
        if (relu) visited[relu.name] = true;
        const input = this.operandInfos[pool.inputNames[0]];
        inputs.push(input.index);
        const pad = getParamValue('pad', node, map, context);
        if (pad === 'same') {
          inputs.push(this.addScalarInt32(this.nn.PADDING_SAME));
        } else if (pad === 'valid') {
          inputs.push(this.addScalarInt32(this.nn.PADDING_VALID));
        } else {
          throw Error(`padding ${pad} is not supported`);
        }
        const strides =
          getParamValue('strides', node, map, context) as number[];
        inputs.push(this.addScalarInt32(strides[1]));
        inputs.push(this.addScalarInt32(strides[2]));
        const kernelSize =
          getParamValue('kernelSize', node, map, context) as number[];
        inputs.push(this.addScalarInt32(kernelSize[1]));
        inputs.push(this.addScalarInt32(kernelSize[2]));

        let fuseCode = this.nn.FUSED_NONE;
        if (relu) {
          const max = getParamValue('clipValueMax', relu, map, context) as number;
          if (max === 1) {
            fuseCode = this.nn.FUSED_RELU1;
          } else if (max === 6) {
            fuseCode = this.nn.FUSED_RELU6;
          } else {
            fuseCode = this.nn.FUSED_RELU;
          }
        }
        inputs.push(this.addScalarInt32(fuseCode));

        let outputName = pool.name;
        if (relu) {
          outputName = relu.name;
        }

        const convInfo = computePool2DInfo([input.shape[0], input.shape[1], input.shape[2], input.shape[3]],
          [kernelSize[1], kernelSize[2]], [strides[1], strides[2]], pad as 'valid' | 'same') as Conv2DInfo;
        const outputInfo = { index: this.operandIndex++, dtype: input.dtype, shape: convInfo.outShape }
        this.operandInfos[outputName] = outputInfo;
        // console.log(`Add operand ${outputName} {index: ${outputInfo.index}, type: ${outputInfo.dtype}, dimensions: [${outputInfo.shape}]}`);
        this.model.addOperand({type: this.nn.TENSOR_FLOAT32, dimensions: outputInfo.shape});
        outputs.push(outputInfo.index);
        // console.log(`Add operation {op: AVERAGE_POOL_2D, input: ${input.index}, strides: [${strides}], pad: ${pad}, kernelSize: [${kernelSize}] fuseCode: ${fuseCode}, output: ${outputInfo.index}}`);
        opType = this.nn.AVERAGE_POOL_2D;
      } else if (node.op === 'squeeze') {
        // console.log(`Compile op ${node.op}`);
        const input = this.operandInfos[node.inputNames[0]];
        inputs.push(input.index);
        const axis = node.params['axis'].value as number[];
        const inputShape = input.shape;
        const outShape = inputShape.reduce((shape, value, index) => {
          if (!(index in axis)) {
            shape.push(value);
          }
          return shape;
        }, []);
        const newShape = this.operandIndex++;
        this.model.addOperand({type: this.nn.TENSOR_INT32, dimensions: [outShape.length]});
        this.model.setOperandValue(newShape, new Int32Array(outShape));
        inputs.push(newShape);
        const outputInfo = { index: this.operandIndex++, dtype: input.dtype, shape: outShape }
        this.operandInfos[node.name] = outputInfo;
        // console.log(`Add operand ${node.name} {index: ${outputInfo.index}, type: ${outputInfo.dtype}, dimensions: [${outputInfo.shape}]}`);
        this.model.addOperand({type: this.nn.TENSOR_FLOAT32, dimensions: outputInfo.shape});
        outputs.push(outputInfo.index);
        // console.log(`Add operation {op: RESHAPE: input: ${input.index}, shape: [${outShape}], output: ${outputInfo.index}}`);
        opType = this.nn.RESHAPE;
        visited[node.name] = true;
      } else if (node.op === 'softmax') {
        // console.log(`Compile op ${node.op}`);
        const input = this.operandInfos[node.inputNames[0]];
        inputs.push(input.index);
        inputs.push(this.addScalarFloat32(1.0));
        const outShape = input.shape;
        const outputInfo = { index: this.operandIndex++, dtype: input.dtype, shape: outShape }
        this.operandInfos[node.name] = outputInfo;
        // console.log(`Add operand ${node.name} {index: ${outputInfo.index}, type: ${outputInfo.dtype}, dimensions: [${outputInfo.shape}]}`);
        this.model.addOperand({type: this.nn.TENSOR_FLOAT32, dimensions: outputInfo.shape});
        outputs.push(outputInfo.index);
        // console.log(`Add operation {op: SOFTMAX: input: ${input.index}, shape: [${outShape}], output: ${outputInfo.index}}`);
        opType = this.nn.SOFTMAX;
        visited[node.name] = true;
      } else {
        // console.error(`Op ${node.op} is not supported`);
      }
      if (opType !== null) {
        this.model.addOperation(opType, inputs, outputs);
        // console.log(`addOperation(${opType}, [${inputs}], [${outputs}])`);
      }
      return map;
    }, { ...this.weightMap, ...inputTensors });

    let input = this.operandInfos[this.graph.placeholders[0].name];
    let output = this.operandInfos[this.graph.outputs[0].name];
    // console.log(`Identify input: ${input.index}, output: ${output.index}`);
    this.model.identifyInputsAndOutputs([input.index], [output.index]);
    await this.model.finish();
    this.compilation = await this.model.createCompilation();
    this.compilation.setPreference(this.nn.PREFER_FAST_SINGLE_ANSWER);
    await this.compilation.finish();
    this.execution = await this.compilation.createExecution();
    this.compiledWebMLModel = true;
  }

  async executeWebMLModel(inputs: NamedTensorsMap, outputs?: string|string[]): Promise<NamedTensorMap> {
    // console.log(inputs);
    const inputTensor = inputs[this.graph.placeholders[0].name][0];
    this.execution.setInput(0, inputTensor.buffer().values);
    // console.log(outputs);
    const output = this.operandInfos[this.graph.outputs[0].name];
    const length = output.shape.reduce((accumulator, currentValue) => accumulator * currentValue);
    let outputTensor = Tensor.make(output.shape, {values: new Float32Array(length)}, 'float32');
    this.execution.setOutput(0, outputTensor.buffer().values);
    // console.log(this.execution);
    let error = await this.execution.startCompute();
    if (error) {
      throw Error(error);
    }
    const outputName = this.graph.outputs[0].name;
    const result: NamedTensorMap = {};
    result[outputName] = outputTensor;
    return result;
  }

  /**
   * Executes the inference for given input tensors.
   * @param inputs Tensor map for the model inputs, keyed by the input node
   * names.
   * @param outputs output node name from the Tensorflow model, if no outputs
   * are specified, the default outputs of the model would be used. You can
   * inspect intermediate nodes of the model by adding them to the outputs
   * array.
   */
  async execute(inputs: NamedTensorsMap, outputs?: string|string[]): Promise<NamedTensorMap> {
    this.checkInput(inputs);
    if (getBackend() === 'webgl') {
      const result = tidy(() => {
        const context = new ExecutionContext(this._weightMap);
        const tensors =
            this.compiledOrder.reduce<NamedTensorsMap>((map, node) => {
              map[node.name] =
                  operations.executeOp(node, map, context) as Tensor[];
              return map;
            }, {...this.weightMap, ...inputs});
        return this.findOutputs(tensors, context, outputs);
      });
      return result;
    } else {
      await this.compileWebMLModel(inputs);
      const result = await this.executeWebMLModel(inputs);
      return result;
    }
  }

  /**
   * Executes the inference for given input tensors in Async fashion.
   * @param inputs Tensor map for the model inputs, keyed by the input node
   * names.
   * @param outputs output node name from the Tensorflow model, if no outputs
   * are specified, the default outputs of the model would be used. You can
   * inspect intermediate nodes of the model by adding them to the outputs
   * array.
   */
  async executeAsync(inputs: NamedTensorsMap, outputs?: string|string[]):
      Promise<NamedTensorMap> {
    const context = new ExecutionContext(this._weightMap);
    // Graph with control flow op requires runtime evaluation of the execution
    // order, while without control flow the execution order is pre-determined
    // in the compile method.
    const tensors = await this.executeWithControlFlow(inputs, context);
    const results = this.findOutputs(tensors, context, outputs);

    // dispose all the intermediate tensors
    const outputIds = Object.keys(results).map(key => results[key].id);
    const inputIdArray =
        Object.keys(inputs).map(key => inputs[key].map(input => input.id));
    const inputIds = [].concat.apply([], inputIdArray);
    Object.keys(tensors).forEach(key => {
      const tensorArray = tensors[key];
      tensorArray.forEach(tensor => {
        if (tensor && outputIds.indexOf(tensor.id) === -1 &&
            inputIds.indexOf(tensor.id) === -1 &&
            this.weightIds.indexOf(tensor.id) === -1) {
          tensor.dispose();
        }
      });
    });
    return results;
  }

  /**
   * When there are control flow nodes in the graph, the graph execution use
   * ExecutionContext to keep track of the frames and loop iterators.
   * @param inputs placeholder tensors for the graph.
   * @param context the execution context object for current execution.
   */
  private async executeWithControlFlow(
      inputs: NamedTensorsMap,
      context: ExecutionContext): Promise<NamedTensorsMap> {
    const stack: NodeWithContexts[] = this.graph.inputs.map(node => {
      return {node, contexts: context.currentContext};
    });
    const tensorMap = {...this.weightMap, ...inputs};
    const added: {[key: string]: boolean} = {};

    while (stack.length > 0) {
      const item = stack.pop();
      context.currentContext = item.contexts;

      const tensors = operations.executeOp(item.node, tensorMap, context);

      const [nodeName, ] = getNodeNameAndIndex(item.node.name, context);
      tensorMap[nodeName] = await tensors;
      item.node.children.forEach((childNode) => {
        const [nodeName, ] = getNodeNameAndIndex(childNode.name, context);
        if (!added[nodeName]) {
          // Merge op can be pushed if any of its inputs has value.
          if (childNode.op === 'merge') {
            if (childNode.inputNames.some(name => {
                  return !!getTensor(name, tensorMap, context);
                })) {
              added[nodeName] = true;
              stack.push({contexts: context.currentContext, node: childNode});
            }
          } else  // Otherwise all inputs must to have value.
              if (childNode.inputNames.every(name => {
                    return !!getTensor(name, tensorMap, context);
                  })) {
            added[nodeName] = true;
            stack.push({contexts: context.currentContext, node: childNode});
          }
        }
      });
    }

    return tensorMap;
  }

  private findOutputs(
      tensorMap: NamedTensorsMap, context: ExecutionContext,
      outputs?: string|string[]): NamedTensorMap {
    if (outputs && !(outputs instanceof Array)) {
      outputs = [outputs];
    }
    const requestedOutputs =
        (outputs || this.graph.outputs.map(node => node.name)) as string[];

    return requestedOutputs.reduce<NamedTensorMap>((map, name) => {
      map[name] = getTensor(name, tensorMap, context);
      return map;
    }, {});
  }
  /**
   * Releases the memory used by the weight tensors.
   */
  dispose() {
    Object.keys(this.weightMap)
        .forEach(
            key => this.weightMap[key].forEach(tensor => tensor.dispose()));
  }

  private checkInput(inputs: NamedTensorsMap) {
    const inputKeys = Object.keys(inputs);
    const missing: string[] = [];
    const extra: string[] = [];

    this.placeholders.forEach(name => {
      if (inputKeys.indexOf(name) === -1) missing.push(name);
    });

    inputKeys.forEach(name => {
      if (this.placeholders.indexOf(name) === -1) extra.push(name);
    });

    if (missing.length > 0) {
      throw new Error(`Missing input placeholders: ${missing}`);
    }

    if (extra.length > 0) {
      throw new Error(`Extra input tensors: ${extra}`);
    }
  }
}
