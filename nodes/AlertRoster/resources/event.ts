import { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';

import { ApiClient, ResourceModule, compact, jsonObject, show, stringParam } from './shared';

const RESOURCE = 'event';

const properties: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(RESOURCE),
    default: 'trigger',
    options: [
      {
        name: 'Acknowledge',
        value: 'acknowledge',
        description: 'Acknowledge the open incident for a dedup key',
        action: 'Acknowledge an event',
      },
      {
        name: 'Resolve',
        value: 'resolve',
        description: 'Resolve the open incident for a dedup key',
        action: 'Resolve an event',
      },
      {
        name: 'Trigger',
        value: 'trigger',
        description:
          'Raise an event; opens an incident or folds into the open one for the dedup key',
        action: 'Trigger an event',
      },
    ],
  },
  stringParam(
    RESOURCE,
    ['trigger', 'acknowledge', 'resolve'],
    'dedupKey',
    'Dedup Key',
    'Identity of the condition (1-255 chars). Repeated triggers with the same key fold into one incident.',
    { placeholder: 'db-primary-down' },
  ),
  stringParam(
    RESOURCE,
    ['trigger'],
    'summary',
    'Summary',
    'Becomes the incident title (1-1024 chars)',
  ),
  {
    displayName: 'Severity',
    name: 'severity',
    type: 'options',
    default: 'error',
    required: true,
    displayOptions: show(RESOURCE, ['trigger']),
    options: [
      { name: 'Critical', value: 'critical' },
      { name: 'Error', value: 'error' },
      { name: 'Info', value: 'info' },
      { name: 'Warning', value: 'warning' },
    ],
  },
  {
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: show(RESOURCE, ['trigger', 'acknowledge', 'resolve']),
    options: [
      {
        displayName: 'Custom Details',
        name: 'customDetails',
        type: 'json',
        default: '{}',
        description: 'Any JSON object. Stored verbatim on the alert, never interpreted.',
      },
      {
        displayName: 'Source',
        name: 'source',
        type: 'string',
        default: '',
        description: 'Free text naming where the condition was observed, such as a hostname',
      },
    ],
  },
];

async function enqueue(
  this: IExecuteFunctions,
  itemIndex: number,
  client: ApiClient,
  action: 'trigger' | 'acknowledge' | 'resolve',
): Promise<IDataObject> {
  const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
  const payload: IDataObject = compact({
    source: additional.source,
    custom_details: jsonObject(this, itemIndex, additional.customDetails, 'Custom Details'),
  });
  if (action === 'trigger') {
    payload.summary = this.getNodeParameter('summary', itemIndex) as string;
    payload.severity = this.getNodeParameter('severity', itemIndex) as string;
  }

  const body: IDataObject = {
    event_action: action,
    dedup_key: this.getNodeParameter('dedupKey', itemIndex) as string,
  };
  if (Object.keys(payload).length > 0) {
    body.payload = payload;
  }

  return client.request('POST', '/api/v2/enqueue', { body });
}

export const eventResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'key',
  lane: 'async',
  properties,
  operations: {
    trigger(itemIndex, client) {
      return enqueue.call(this, itemIndex, client, 'trigger');
    },
    acknowledge(itemIndex, client) {
      return enqueue.call(this, itemIndex, client, 'acknowledge');
    },
    resolve(itemIndex, client) {
      return enqueue.call(this, itemIndex, client, 'resolve');
    },
  },
};
