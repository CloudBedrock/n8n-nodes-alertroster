import { INodeProperties } from 'n8n-workflow';

import { ResourceModule, show, stringParam, unwrap } from './shared';

const RESOURCE = 'override';

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
        name: 'Cancel',
        value: 'cancel',
        description: 'Cancel an override (admin, or the responder who created it)',
        action: 'Cancel an override',
      },
      {
        name: 'Create',
        value: 'create',
        description: 'Put a responder on call for a window, over the rotation (admin)',
        action: 'Create an override',
      },
    ],
  },
  stringParam(RESOURCE, ['cancel'], 'overrideId', 'Override ID', 'UUID of the override'),
  stringParam(RESOURCE, ['create'], 'scheduleId', 'Schedule ID', 'UUID of the schedule'),
  stringParam(RESOURCE, ['create'], 'userId', 'User ID', 'UUID of the responder to put on call'),
  stringParam(RESOURCE, ['create'], 'startsAt', 'Starts At', 'ISO 8601 start of the window'),
  stringParam(RESOURCE, ['create'], 'endsAt', 'Ends At', 'ISO 8601 end of the window'),
];

export const overrideResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async create(itemIndex, client) {
      const scheduleId = this.getNodeParameter('scheduleId', itemIndex) as string;
      const body = {
        user_id: this.getNodeParameter('userId', itemIndex) as string,
        starts_at: this.getNodeParameter('startsAt', itemIndex) as string,
        ends_at: this.getNodeParameter('endsAt', itemIndex) as string,
      };
      return unwrap(
        await client.request('POST', `/api/v1/schedules/${scheduleId}/overrides`, { body }),
        'override',
      );
    },
    async cancel(itemIndex, client) {
      const id = this.getNodeParameter('overrideId', itemIndex) as string;
      return unwrap(await client.request('DELETE', `/api/v1/overrides/${id}`), 'override');
    },
  },
};
