import { INodeProperties } from 'n8n-workflow';

import { ResourceModule, compact, show, stringParam, unwrap, unwrapList } from './shared';

const RESOURCE = 'handoff';

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
        name: 'Accept',
        value: 'accept',
        description: 'Accept a handoff addressed to this responder',
        action: 'Accept a handoff',
      },
      {
        name: 'Cancel',
        value: 'cancel',
        description: 'Withdraw a handoff you requested (or any, as admin)',
        action: 'Cancel a handoff',
      },
      {
        name: 'Create',
        value: 'create',
        description: 'Ask another responder to take a window of your shift',
        action: 'Create a handoff',
      },
      {
        name: 'Decline',
        value: 'decline',
        description: 'Decline a handoff addressed to this responder',
        action: 'Decline a handoff',
      },
      {
        name: 'Get Many',
        value: 'getAll',
        description: 'Handoffs this responder asked for or was asked to take, newest first',
        action: 'Get many handoffs',
      },
    ],
  },
  stringParam(
    RESOURCE,
    ['accept', 'decline', 'cancel'],
    'handoffId',
    'Handoff ID',
    'UUID of the handoff',
  ),
  stringParam(RESOURCE, ['create'], 'scheduleId', 'Schedule ID', 'UUID of the schedule'),
  stringParam(
    RESOURCE,
    ['create'],
    'toUserId',
    'To User ID',
    'UUID of the responder being asked to take the window',
  ),
  {
    displayName: 'Kind',
    name: 'kind',
    type: 'options',
    default: 'cover',
    required: true,
    displayOptions: show(RESOURCE, ['create']),
    options: [
      { name: 'Cover', value: 'cover', description: 'They cover you; you remain a fallback' },
      { name: 'Handoff', value: 'handoff', description: 'The shift moves to them entirely' },
    ],
  },
  stringParam(RESOURCE, ['create'], 'startsAt', 'Starts At', 'ISO 8601 start of the window'),
  stringParam(RESOURCE, ['create'], 'endsAt', 'Ends At', 'ISO 8601 end of the window'),
  {
    displayName: 'Status',
    name: 'status',
    type: 'options',
    default: '',
    displayOptions: show(RESOURCE, ['getAll']),
    description: 'Filter by handoff status',
    options: [
      { name: 'Any', value: '' },
      { name: 'Accepted', value: 'accepted' },
      { name: 'Cancelled', value: 'cancelled' },
      { name: 'Declined', value: 'declined' },
      { name: 'Pending', value: 'pending' },
    ],
  },
];

export const handoffResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getAll(itemIndex, client) {
      const qs = compact({ status: this.getNodeParameter('status', itemIndex, '') });
      return unwrapList(await client.request('GET', '/api/v1/handoffs', { qs }), 'handoffs');
    },
    async create(itemIndex, client) {
      const scheduleId = this.getNodeParameter('scheduleId', itemIndex) as string;
      const body = {
        to_user_id: this.getNodeParameter('toUserId', itemIndex) as string,
        kind: this.getNodeParameter('kind', itemIndex) as string,
        starts_at: this.getNodeParameter('startsAt', itemIndex) as string,
        ends_at: this.getNodeParameter('endsAt', itemIndex) as string,
      };
      return unwrap(
        await client.request('POST', `/api/v1/schedules/${scheduleId}/handoffs`, { body }),
        'handoff',
      );
    },
    async accept(itemIndex, client) {
      const id = this.getNodeParameter('handoffId', itemIndex) as string;
      return unwrap(await client.request('POST', `/api/v1/handoffs/${id}/accept`), 'handoff');
    },
    async decline(itemIndex, client) {
      const id = this.getNodeParameter('handoffId', itemIndex) as string;
      return unwrap(await client.request('POST', `/api/v1/handoffs/${id}/decline`), 'handoff');
    },
    async cancel(itemIndex, client) {
      const id = this.getNodeParameter('handoffId', itemIndex) as string;
      return unwrap(await client.request('POST', `/api/v1/handoffs/${id}/cancel`), 'handoff');
    },
  },
};
