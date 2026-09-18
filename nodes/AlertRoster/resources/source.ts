import { INodeProperties } from 'n8n-workflow';

import { ResourceModule, show, unwrapList } from './shared';

const RESOURCE = 'source';

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
        description:
          'Every source in the account and what each escalates to: a schedule, an escalation policy, or nothing (which pages every responder). Integration keys appear as prefix, lane and stamps, never the key itself.',
        action: 'Get many sources',
      },
    ],
  },
];

/**
 * Read-only: sources are the account's ingest configuration and are edited
 * on the Sources page. Admin role. The list is what a coverage audit walks
 * (which sources route to a ladder whose first rung would wake nobody) and
 * what the Source ID field on Incident → Create is copied from.
 */
export const sourceResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getAll(_itemIndex, client) {
      return unwrapList(await client.request('GET', '/api/v1/sources'), 'sources');
    },
  },
};
