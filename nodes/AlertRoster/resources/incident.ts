import { IDataObject, INodeProperties } from 'n8n-workflow';

import { ResourceModule, asInteger, compact, show, stringParam, unwrap } from './shared';

const RESOURCE = 'incident';

const URGENCY_OPTIONS = [
  { name: 'High', value: 'high' },
  { name: 'Low', value: 'low' },
];

const PRIORITY_OPTIONS = [
  { name: 'Emergency', value: 'emergency' },
  { name: 'High', value: 'high' },
  { name: 'Normal', value: 'normal' },
];

const properties: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(RESOURCE),
    default: 'create',
    options: [
      {
        name: 'Acknowledge',
        value: 'acknowledge',
        description: 'Stop the escalation',
        action: 'Acknowledge an incident',
      },
      {
        name: 'Create',
        value: 'create',
        description: 'Open an incident, or return the open one for the dedup key',
        action: 'Create an incident',
      },
      { name: 'Get', value: 'get', description: 'Read an incident', action: 'Get an incident' },
      {
        name: 'Reassign',
        value: 'reassign',
        description: 'Hand the incident to another responder',
        action: 'Reassign an incident',
      },
      {
        name: 'Resolve',
        value: 'resolve',
        description: 'Close the incident',
        action: 'Resolve an incident',
      },
      {
        name: 'Update',
        value: 'update',
        description: 'Revise the title, urgency, or priority',
        action: 'Update an incident',
      },
    ],
  },
  stringParam(
    RESOURCE,
    ['get', 'update', 'acknowledge', 'resolve', 'reassign'],
    'incidentId',
    'Incident ID',
    'UUID of the incident',
  ),
  stringParam(
    RESOURCE,
    ['create'],
    'dedupKey',
    'Dedup Key',
    'Identity of the incident for its whole life (1-255 chars). A second create with the same key returns the open incident.',
    { placeholder: 'tkt-8821' },
  ),
  stringParam(RESOURCE, ['create'], 'title', 'Title', 'Incident title (1-1024 chars)'),
  stringParam(
    RESOURCE,
    ['reassign'],
    'userId',
    'User ID',
    'UUID of the responder to hand the incident to',
  ),
  {
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: show(RESOURCE, ['create']),
    options: [
      {
        displayName: 'Local Grace Seconds',
        name: 'localGraceSeconds',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0, maxValue: 3600 },
        description:
          'How long to hold off-site escalation so someone already on site can answer first (0-3600)',
      },
      {
        displayName: 'Priority',
        name: 'priority',
        type: 'options',
        default: 'emergency',
        options: PRIORITY_OPTIONS,
        description:
          "How loud. Defaults from urgency and is always capped by the source's maximum priority.",
      },
      {
        displayName: 'Source ID',
        name: 'sourceId',
        type: 'string',
        default: '',
        description:
          'Required when the credential is an account API token (art_…). Ignored for source integration keys, which are bound to their source.',
      },
      {
        displayName: 'Urgency',
        name: 'urgency',
        type: 'options',
        default: 'high',
        options: URGENCY_OPTIONS,
      },
    ],
  },
  {
    displayName: 'Update Fields',
    name: 'updateFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: show(RESOURCE, ['update']),
    options: [
      {
        displayName: 'Priority',
        name: 'priority',
        type: 'options',
        default: 'emergency',
        options: PRIORITY_OPTIONS,
      },
      { displayName: 'Title', name: 'title', type: 'string', default: '' },
      {
        displayName: 'Urgency',
        name: 'urgency',
        type: 'options',
        default: 'high',
        options: URGENCY_OPTIONS,
      },
    ],
  },
];

export const incidentResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'key',
  lane: 'sync',
  properties,
  operations: {
    async create(itemIndex, client) {
      const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
      const body: IDataObject = compact({
        dedup_key: this.getNodeParameter('dedupKey', itemIndex),
        title: this.getNodeParameter('title', itemIndex),
        urgency: additional.urgency,
        priority: additional.priority,
        source_id: additional.sourceId,
      });
      const grace = asInteger(this, itemIndex, additional.localGraceSeconds, 'Local Grace Seconds');
      if (grace !== undefined) {
        body.local_grace_seconds = grace;
      }
      return unwrap(await client.request('POST', '/api/v2/incidents', { body }), 'incident');
    },
    async get(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(await client.request('GET', `/api/v2/incidents/${id}`), 'incident');
    },
    async update(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      const body = compact(this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject);
      return unwrap(await client.request('PUT', `/api/v2/incidents/${id}`, { body }), 'incident');
    },
    async acknowledge(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(
        await client.request('POST', `/api/v2/incidents/${id}/acknowledge`),
        'incident',
      );
    },
    async resolve(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(await client.request('POST', `/api/v2/incidents/${id}/resolve`), 'incident');
    },
    async reassign(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      const body = { user_id: this.getNodeParameter('userId', itemIndex) as string };
      return unwrap(
        await client.request('POST', `/api/v2/incidents/${id}/reassign`, { body }),
        'incident',
      );
    },
  },
};
