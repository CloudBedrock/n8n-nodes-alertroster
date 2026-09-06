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
        name: 'Beacon',
        value: 'beacon',
        description:
          "Light the torch and sound the phone of the person a missed check-in is about. Burns for 900 seconds; send again to keep it going, or mode 'off' to stop it.",
        action: 'Set the beacon on an incident',
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
        name: 'Get Search',
        value: 'getSearch',
        description:
          'The search panel for a missed check-in: the position trail, device commands, whether locate and beacon are available, and who the roster is looking for',
        action: 'Get the search panel of an incident',
      },
      {
        name: 'Locate',
        value: 'locate',
        description:
          'Ask the device of the person a missed check-in is about for a fresh position. Answers 202 with the queued command; the fix arrives on the incident later.',
        action: 'Locate the subject of an incident',
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
    ['get', 'acknowledge', 'resolve', 'reassign', 'silence', 'getSearch', 'locate', 'beacon'],
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
  {
    displayName: 'Mode',
    name: 'mode',
    type: 'options',
    default: 'strobe',
    required: true,
    displayOptions: show(RESOURCE, ['beacon']),
    options: [
      { name: 'Off', value: 'off', description: 'Put the light out. Never refused for consent.' },
      { name: 'Steady', value: 'steady' },
      { name: 'Strobe', value: 'strobe' },
    ],
  },
  {
    displayName: 'Confirm Duress',
    name: 'confirmDuress',
    type: 'boolean',
    default: false,
    displayOptions: show(RESOURCE, ['beacon']),
    description:
      'Whether to light the beacon even though the incident was raised under duress. Refused with 409 duress_confirmation_required otherwise: a lit phone can put a coerced person in more danger. The override is recorded on the incident timeline.',
  },
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
    // The search routes apply to an incident a missed check-in raised. On any
    // other incident the panel is empty and both capabilities report
    // `not_a_checkin_incident`; the commands are refused with 409.
    async getSearch(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(await client.request('GET', `/api/v1/incidents/${id}/search`), 'search');
    },
    async locate(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      return unwrap(
        await client.request('POST', `/api/v1/incidents/${id}/search/locate`),
        'command',
      );
    },
    async beacon(itemIndex, client) {
      const id = this.getNodeParameter('incidentId', itemIndex) as string;
      // Only a literal `true` confirms on the server, so the boolean is sent
      // as is rather than through `compact`.
      const body = {
        mode: this.getNodeParameter('mode', itemIndex) as string,
        confirm_duress: this.getNodeParameter('confirmDuress', itemIndex, false) === true,
      };
      return unwrap(
        await client.request('POST', `/api/v1/incidents/${id}/search/beacon`, { body }),
        'command',
      );
    },
  },
};
