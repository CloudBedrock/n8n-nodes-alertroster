import { IDataObject, INodeProperties } from 'n8n-workflow';

import {
  ResourceModule,
  asInteger,
  compact,
  idList,
  show,
  stringParam,
  unwrap,
  unwrapList,
} from './shared';

const RESOURCE = 'schedule';

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
        name: 'Create',
        value: 'create',
        description: 'Create a schedule, optionally with a first rotation layer (admin)',
        action: 'Create a schedule',
      },
      {
        name: 'Delete',
        value: 'delete',
        description: 'Delete a schedule and unlink it from its sources (admin)',
        action: 'Delete a schedule',
      },
      { name: 'Get', value: 'get', description: 'Read a schedule', action: 'Get a schedule' },
      {
        name: 'Get Many',
        value: 'getAll',
        description: 'List the schedules in the account',
        action: 'Get many schedules',
      },
      {
        name: 'Get On-Call',
        value: 'getOnCall',
        description: 'Who is on call at an instant, and via which layer or override',
        action: 'Get who is on call',
      },
      {
        name: 'Get Roster',
        value: 'getRoster',
        description: 'The on-call segments over a window (default: the next 7 days)',
        action: 'Get the roster',
      },
      {
        name: 'Update',
        value: 'update',
        description: 'Rename a schedule or change its time zone (admin)',
        action: 'Update a schedule',
      },
    ],
  },
  stringParam(
    RESOURCE,
    ['get', 'update', 'delete', 'getOnCall', 'getRoster'],
    'scheduleId',
    'Schedule ID',
    'UUID of the schedule',
  ),
  stringParam(RESOURCE, ['create'], 'name', 'Name', 'Schedule name'),
  stringParam(
    RESOURCE,
    ['create'],
    'timeZone',
    'Time Zone',
    'IANA time zone the schedule is read in',
    { placeholder: 'America/New_York' },
  ),
  {
    displayName: 'Rotation',
    name: 'rotation',
    type: 'collection',
    placeholder: 'Add Rotation',
    default: {},
    displayOptions: show(RESOURCE, ['create']),
    description: 'Optional first layer. Leave empty to create a bare schedule.',
    options: [
      {
        displayName: 'Length (Seconds)',
        name: 'lengthSeconds',
        type: 'number',
        default: 604800,
        description: 'How long each member holds the rotation, in seconds (604800 = one week)',
      },
      {
        displayName: 'Member IDs',
        name: 'memberIds',
        type: 'string',
        default: '',
        description: 'Comma-separated responder UUIDs, in rotation order',
      },
      {
        displayName: 'Starts At',
        name: 'startsAt',
        type: 'string',
        default: '',
        description: 'ISO 8601 instant the rotation starts',
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
      { displayName: 'Name', name: 'name', type: 'string', default: '' },
      {
        displayName: 'Time Zone',
        name: 'time_zone',
        type: 'string',
        default: '',
        placeholder: 'America/New_York',
      },
    ],
  },
  {
    displayName: 'At',
    name: 'at',
    type: 'string',
    default: '',
    displayOptions: show(RESOURCE, ['getOnCall']),
    description: 'ISO 8601 instant to evaluate. Defaults to now.',
  },
  {
    displayName: 'From',
    name: 'from',
    type: 'string',
    default: '',
    displayOptions: show(RESOURCE, ['getRoster']),
    description: 'ISO 8601 start of the window. Defaults to now.',
  },
  {
    displayName: 'To',
    name: 'to',
    type: 'string',
    default: '',
    displayOptions: show(RESOURCE, ['getRoster']),
    description: 'ISO 8601 end of the window. Defaults to 7 days after From; capped at 90 days.',
  },
];

export const scheduleResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getAll(_itemIndex, client) {
      return unwrapList(await client.request('GET', '/api/v1/schedules'), 'schedules');
    },
    async get(itemIndex, client) {
      const id = this.getNodeParameter('scheduleId', itemIndex) as string;
      return unwrap(await client.request('GET', `/api/v1/schedules/${id}`), 'schedule');
    },
    async create(itemIndex, client) {
      const body: IDataObject = {
        name: this.getNodeParameter('name', itemIndex) as string,
        time_zone: this.getNodeParameter('timeZone', itemIndex) as string,
      };
      const rotation = this.getNodeParameter('rotation', itemIndex, {}) as IDataObject;
      if (Object.keys(compact(rotation)).length > 0) {
        body.rotation = compact({
          starts_at: rotation.startsAt,
          length_seconds: asInteger(this, itemIndex, rotation.lengthSeconds, 'Length (Seconds)'),
          member_ids: idList(rotation.memberIds),
        });
      }
      // Two-key response ({schedule, layers}); returned whole.
      return client.request('POST', '/api/v1/schedules', { body });
    },
    async update(itemIndex, client) {
      const id = this.getNodeParameter('scheduleId', itemIndex) as string;
      const body = compact(this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject);
      return unwrap(await client.request('PATCH', `/api/v1/schedules/${id}`, { body }), 'schedule');
    },
    async delete(itemIndex, client) {
      const id = this.getNodeParameter('scheduleId', itemIndex) as string;
      // Two-key response ({schedule, unlinked_sources}); returned whole.
      return client.request('DELETE', `/api/v1/schedules/${id}`);
    },
    async getOnCall(itemIndex, client) {
      const id = this.getNodeParameter('scheduleId', itemIndex) as string;
      const qs = compact({ at: this.getNodeParameter('at', itemIndex, '') });
      return client.request('GET', `/api/v1/schedules/${id}/on_call`, { qs });
    },
    async getRoster(itemIndex, client) {
      const id = this.getNodeParameter('scheduleId', itemIndex) as string;
      const qs = compact({
        from: this.getNodeParameter('from', itemIndex, ''),
        to: this.getNodeParameter('to', itemIndex, ''),
      });
      return client.request('GET', `/api/v1/schedules/${id}/roster`, { qs });
    },
  },
};
