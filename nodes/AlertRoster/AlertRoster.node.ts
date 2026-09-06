import {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';

import { KeyClient } from '../../utils/KeyClient';
import { ResponderSession } from '../../utils/ResponderSession';
import { checkinResource } from './resources/checkin';
import { eventResource } from './resources/event';
import { handoffResource } from './resources/handoff';
import { incidentResource } from './resources/incident';
import { layerResource } from './resources/layer';
import { overrideResource } from './resources/override';
import { responderIncidentResource } from './resources/responderIncident';
import { scheduleResource } from './resources/schedule';
import { ApiClient, ResourceModule } from './resources/shared';
import { userResource } from './resources/user';

const RESOURCES: ResourceModule[] = [
  checkinResource,
  eventResource,
  handoffResource,
  incidentResource,
  layerResource,
  overrideResource,
  responderIncidentResource,
  scheduleResource,
  userResource,
];

const BY_RESOURCE = new Map(RESOURCES.map((module) => [module.resource, module]));

const keyResources = RESOURCES.filter((m) => m.auth === 'key').map((m) => m.resource);
const responderResources = RESOURCES.filter((m) => m.auth === 'responder').map((m) => m.resource);

export class AlertRoster implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'AlertRoster',
    name: 'alertRoster',
    icon: 'file:alertroster.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description:
      'Raise and manage AlertRoster incidents, on-call schedules, handoffs, overrides, and check-ins',
    defaults: {
      name: 'AlertRoster',
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [
      {
        name: 'alertRosterIntegrationKeyApi',
        required: true,
        displayOptions: { show: { resource: keyResources } },
      },
      {
        name: 'alertRosterResponderApi',
        required: true,
        displayOptions: { show: { resource: responderResources } },
      },
    ],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'incident',
        options: [
          {
            name: 'Check-In',
            value: 'checkin',
            description: "This responder's dead-man's-switch check-ins (responder sign-in)",
          },
          {
            name: 'Event',
            value: 'event',
            description: 'Fire-and-forget events on the ingest firehose (ark_async_ key)',
          },
          {
            name: 'Handoff',
            value: 'handoff',
            description: 'Shift handoff and cover requests (responder sign-in)',
          },
          {
            name: 'Incident',
            value: 'incident',
            description:
              'Open and drive incidents as a system of record (ark_sync_ key or art_ token)',
          },
          {
            name: 'Layer',
            value: 'layer',
            description: 'Rotation layers of a schedule (responder sign-in, admin)',
          },
          {
            name: 'Override',
            value: 'override',
            description: 'Admin overrides on a schedule (responder sign-in)',
          },
          {
            name: 'Responder Incident',
            value: 'responderIncident',
            description:
              'Incidents as a responder sees them: list open, acknowledge, resolve, silence',
          },
          {
            name: 'Schedule',
            value: 'schedule',
            description: 'On-call schedules, who is on call, and the roster (responder sign-in)',
          },
          {
            name: 'User',
            value: 'user',
            description: 'Responders in the account (responder sign-in)',
          },
        ],
      },
      ...RESOURCES.flatMap((module) => module.properties),
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;

    const module = BY_RESOURCE.get(resource);
    if (!module) {
      throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`);
    }
    const handler = module.operations[operation];
    if (!handler) {
      throw new NodeOperationError(
        this.getNode(),
        `Operation "${operation}" is not supported for resource "${resource}"`,
      );
    }

    const client = await buildClient.call(this, module);

    for (let i = 0; i < items.length; i++) {
      try {
        const result = await handler.call(this, i, client);
        const rows = Array.isArray(result) ? result : [result];
        for (const row of rows) {
          returnData.push({ json: row, pairedItem: { item: i } });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: (error as Error).message },
            pairedItem: { item: i },
          });
          continue;
        }
        if (error instanceof NodeOperationError) {
          throw error;
        }
        throw new NodeApiError(this.getNode(), error as never, {
          message: (error as Error).message,
          itemIndex: i,
        });
      }
    }

    return [returnData];
  }
}

async function buildClient(this: IExecuteFunctions, module: ResourceModule): Promise<ApiClient> {
  if (module.auth === 'key') {
    const credentials = await this.getCredentials('alertRosterIntegrationKeyApi');
    try {
      return new KeyClient(
        credentials.baseUrl as string,
        credentials.apiKey as string,
        module.lane ?? 'sync',
      );
    } catch (error) {
      throw new NodeOperationError(this.getNode(), (error as Error).message);
    }
  }

  const credentials = await this.getCredentials('alertRosterResponderApi');
  try {
    return new ResponderSession(
      {
        baseUrl: credentials.baseUrl as string,
        email: credentials.email as string,
        password: credentials.password as string,
        accountId: (credentials.accountId as string) || undefined,
      },
      this.getWorkflowStaticData('global') as IDataObject,
    );
  } catch (error) {
    throw new NodeOperationError(this.getNode(), (error as Error).message);
  }
}
