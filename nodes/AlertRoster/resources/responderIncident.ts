import { INodeProperties } from 'n8n-workflow';

import { ResourceModule, show, stringParam, unwrap, unwrapList } from './shared';

const RESOURCE = 'responderIncident';

const properties: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(RESOURCE),
    default: 'getAll',
    options: [
      {
        name: 'Acknowledge',
        value: 'acknowledge',
        description: 'Stop the escalation, as this responder',
        action: 'Acknowledge an incident',
      },
      {
        name: 'Get',
        value: 'get',
        description: 'Read an incident, open or closed',
        action: 'Get an incident',
      },
      {
        name: 'Get Many',
        value: 'getAll',
        description: 'List the open incidents in the account, newest first',
        action: 'Get many incidents',
      },
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
        name: 'Silence',
        value: 'silence',
        description: 'Stop the noise for 90 seconds without acknowledging',
        action: 'Silence an incident',
      },
    ],
  },
  stringParam(
    RESOURCE,
    ['get', 'acknowledge', 'resolve', 'reassign', 'silence'],
    'incidentId',
    'Incident ID',
    'UUID of the incident',
  ),
  stringParam(
    RESOURCE,
    ['reassign'],
    'userId',
    'User ID',
    'UUID of the responder to hand the incident to',
  ),
];

export const responderIncidentResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getAll(_itemIndex, client) {
      return unwrapList(await client.request('GET', '/api/v1/incidents'), 'incidents');
    },
    async get(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(await client.request('GET', `/api/v1/incidents/${id}`), 'incident');
    },
    async acknowledge(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(
        await client.request('POST', `/api/v1/incidents/${id}/acknowledge`),
        'incident',
      );
    },
    async resolve(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(await client.request('POST', `/api/v1/incidents/${id}/resolve`), 'incident');
    },
    async reassign(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      const body = { user_id: this.getNodeParameter('userId', itemIndex) as string };
      return unwrap(
        await client.request('POST', `/api/v1/incidents/${id}/reassign`, { body }),
        'incident',
      );
    },
    async silence(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(await client.request('POST', `/api/v1/incidents/${id}/silence`), 'incident');
    },
  },
};
