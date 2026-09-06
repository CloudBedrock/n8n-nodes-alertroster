import { INodeProperties } from 'n8n-workflow';

import { ResourceModule, show, unwrapList } from './shared';

const RESOURCE = 'user';

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
        name: 'Get Many',
        value: 'getAll',
        description: 'List the responders in the account (up to 500, sorted by name)',
        action: 'Get many users',
      },
    ],
  },
];

export const userResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getAll(_itemIndex, client) {
      return unwrapList(await client.request('GET', '/api/v1/users'), 'users');
    },
  },
};
