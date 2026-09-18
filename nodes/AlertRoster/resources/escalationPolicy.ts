import { INodeProperties } from 'n8n-workflow';

import { ResourceModule, compact, show, stringParam, unwrap, unwrapList } from './shared';

const RESOURCE = 'escalationPolicy';

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
        name: 'Get',
        value: 'get',
        description:
          'One ladder with, on every rung, who it would wake right now (or at a given instant), resolved the way a firing rung is resolved',
        action: 'Get an escalation policy',
      },
      {
        name: 'Get Many',
        value: 'getAll',
        description:
          'Every escalation ladder in the account, with its rungs in order and what each rung names. Nobody is resolved here; Get answers who a rung would wake.',
        action: 'Get many escalation policies',
      },
    ],
  },
  stringParam(RESOURCE, ['get'], 'policyId', 'Policy ID', 'UUID of the escalation policy'),
  {
    displayName: 'At',
    name: 'at',
    type: 'dateTime',
    default: '',
    displayOptions: show(RESOURCE, ['get']),
    description:
      'Resolve who each rung would wake at this instant instead of now, for questions like "is this staffed on Sunday night". ISO 8601.',
  },
];

/**
 * Read-only: ladders are edited in the policy editor. Admin role. `would_wake`
 * on the detail route is a live answer about the present (or about `at`),
 * never a record; what a rung *did* wake is on the incident timeline.
 */
export const escalationPolicyResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getAll(_itemIndex, client) {
      return unwrapList(
        await client.request('GET', '/api/v1/escalation_policies'),
        'escalation_policies',
      );
    },
    async get(itemIndex, client) {
      const id = this.getNodeParameter('policyId', itemIndex) as string;
      const qs = compact({ at: this.getNodeParameter('at', itemIndex, '') });
      return unwrap(
        await client.request('GET', `/api/v1/escalation_policies/${id}`, { qs }),
        'escalation_policy',
      );
    },
  },
};
