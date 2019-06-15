/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { v4 } from 'uuid';
import { Observable, Subscription, pairs } from 'rxjs';
import { first } from 'rxjs/operators';

import {
  PluginInitializerContext,
  Logger,
  ClusterClient,
  ElasticsearchServiceSetup,
} from 'src/core/server';

import { ProxyPluginType } from './proxy';

export enum RouteState {
  Initializing,
  Started,
  Closed,
}

export interface RoutingNode {
  type: string; // what are all the types this can be?
  node: string;
  state: RouteState;
}

interface LivenessNode {
  lastUpdate: number;
}

interface ClusterDoc {
  nodes: NodeList;
  routing_table: RoutingTable;
}

export interface RoutingTable {
  [key: string]: RoutingNode;
}
interface NodeList {
  [key: string]: LivenessNode;
}

export class ClusterDocClient {
  public nodeName: string;
  private routingTable: RoutingTable = {};
  private elasticsearch?: Observable<ClusterClient>;
  private updateInterval?: number;
  private timeoutThreshold: number = 15 * 1000;
  private timer: null | number = null;
  private configSubscription?: Subscription;

  private readonly proxyIndex = '.kibana';
  private readonly proxyDoc = 'proxy-resource-list';
  private readonly log: Logger;
  private readonly config$: Observable<ProxyPluginType>;

  constructor(initializerContext: PluginInitializerContext) {
    this.nodeName = v4();
    this.config$ = initializerContext.config.create<ProxyPluginType>();
    this.log = initializerContext.logger.get('proxy');
  }

  public async setup(esClient: Partial<ElasticsearchServiceSetup>) {
    this.elasticsearch = esClient.dataClient$;
    this.configSubscription = this.config$.subscribe(config => {
      this.setConfig(config);
    });
    const config = await this.config$.pipe(first()).toPromise();
    this.setConfig(config);
  }

  public async start() {
    await this.mainLoop();
  }

  public async stop() {
    // stop http service
    if (this.timer) {
      clearTimeout(this.timer);
    }

    const nodes = await this.getNodeList();
    delete nodes[this.nodeName];
    await this.updateNodeList(nodes);

    if (this.configSubscription === undefined) {
      return;
    }

    this.configSubscription.unsubscribe();
    this.configSubscription = undefined;
  }

  public getRoutingTable(): Observable<[string, RoutingNode]> {
    return pairs(this.routingTable);
  }

  public getNodeForResource(resource: string) {
    return this.routingTable[resource];
  }

  public async assignResource(resource: string, type: string, state: RouteState, node?: string) {
    // getting the ndoe list will refresh the internal routing table to match
    // whatever the es doc contains, so this needs to be done before we assign
    // the new node to the routing table, or we lose the update
    const nodes = await this.getNodeList();
    const data = {
      type,
      state,
      node: node || this.nodeName,
    };
    this.routingTable[resource] = data;
    const currentTime = new Date().getTime();
    await this.updateNodeList(this.updateLocalNode(nodes, currentTime));
  }

  public async unassignResource(resource: string) {
    const nodes = await this.getNodeList();
    delete this.routingTable[resource];
    const currentTime = new Date().getTime();
    await this.updateNodeList(this.updateLocalNode(nodes, currentTime));
  }

  private setConfig(config: ProxyPluginType) {
    this.updateInterval = config.updateInterval;
    this.timeoutThreshold = config.timeoutThreshold;
  }

  private setTimer() {
    if (this.timer) return;
    this.log.debug('Set timer to updateNodeMap');
    this.timer = setTimeout(async () => {
      this.log.debug('Updating node map');
      await this.mainLoop();
    }, this.updateInterval);
  }

  private updateRoutingTable(routingTable: RoutingTable): void {
    const currentRoutes = [...Object.keys(this.routingTable)];
    for (const [key, node] of Object.entries(routingTable)) {
      this.routingTable[key] = node;
      const idx = currentRoutes.findIndex(k => k === key);
      if (idx) currentRoutes.splice(idx, 1);
    }

    for (const key of currentRoutes.values()) {
      delete this.routingTable[key];
    }
  }

  private async getNodeList(): Promise<NodeList> {
    if (!this.elasticsearch) {
      throw new Error('You must call setup first');
    }
    const client = await this.elasticsearch.pipe(first()).toPromise();
    const params = {
      id: this.proxyDoc,
      index: this.proxyIndex,
      _source: true,
    };
    const reply = await client.callAsInternalUser('get', params);
    const data: ClusterDoc = reply._source;
    this.updateRoutingTable(data.routing_table || {});
    const nodes: NodeList = data.nodes || {};
    return nodes;
  }

  private async updateNodeList(nodes: NodeList): Promise<void> {
    if (!this.elasticsearch) {
      throw new Error('You must call setup first');
    }
    const doc = {
      nodes,
      routing_table: this.routingTable,
    };
    const client = await this.elasticsearch.pipe(first()).toPromise();
    const params = {
      id: this.proxyDoc,
      index: this.proxyIndex,
      doc,
    };
    await client.callAsInternalUser('update', params);
  }

  private updateLocalNode(nodes: NodeList, finishTime: number): NodeList {
    nodes[this.nodeName] = {
      lastUpdate: finishTime,
    };
    return nodes;
  }

  private removeNode(node: string) {
    for (const [resource, data] of Object.entries(this.routingTable)) {
      if (data.node === node) {
        delete this.routingTable[resource];
      }
    }
  }

  private async mainLoop(): Promise<void> {
    const nodes = await this.getNodeList();
    const finishTime = new Date().getTime();

    for (const [key, node] of Object.entries(nodes)) {
      const timeout = finishTime - node.lastUpdate;
      if (!node || timeout > this.timeoutThreshold) {
        this.log.warn(`Node ${key} has not updated in ${timeout}ms and has been dropped`);
        this.removeNode(key);
        delete nodes[key];
      }
    }

    this.updateNodeList(this.updateLocalNode(nodes, finishTime));
    this.setTimer();
  }
}