import { IDataObject, INodeProperties } from 'n8n-workflow';

import {
  ResourceModule,
  asInteger,
  compact,
  locationBody,
  locationCollection,
  show,
  stringParam,
  unwrap,
  unwrapList,
} from './shared';

const RESOURCE = 'checkin';

const TRANSITIONS = ['arm', 'extend', 'satisfy', 'cancel'];

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
        name: 'Arm',
        value: 'arm',
        description: 'Start the countdown (timer: to a deadline; daily: to the next local time)',
        action: 'Arm a check-in',
      },
      {
        name: 'Cancel',
        value: 'cancel',
        description: 'Disarm without satisfying',
        action: 'Cancel a check-in',
      },
      {
        name: 'Clear Code',
        value: 'clearCode',
        description: 'Remove the check-in code (refused while any check-in requires it)',
        action: 'Clear the check-in code',
      },
      {
        name: 'Clear Duress Code',
        value: 'clearDuressCode',
        action: 'Clear the duress code',
      },
      {
        name: 'Create',
        value: 'create',
        description: 'Create a check-in (idle until armed)',
        action: 'Create a check-in',
      },
      { name: 'Delete', value: 'delete', action: 'Delete a check-in' },
      {
        name: 'Extend',
        value: 'extend',
        description: 'Push the deadline out',
        action: 'Extend a check-in',
      },
      {
        name: 'Get Code Status',
        value: 'getCodeStatus',
        description: 'Whether a check-in code and a duress code are set',
        action: 'Get the code status',
      },
      {
        name: 'Get Location Opt-In',
        value: 'getLocationOptIn',
        description: 'Whether this responder shares position with check-ins',
        action: 'Get the location opt-in',
      },
      {
        name: 'Get Many',
        value: 'getAll',
        description: "List this responder's check-ins",
        action: 'Get many check-ins',
      },
      {
        name: 'Satisfy',
        value: 'satisfy',
        description: 'Check in: disarm before the deadline',
        action: 'Satisfy a check-in',
      },
      {
        name: 'Set Code',
        value: 'setCode',
        description: 'Set the check-in code and optionally a duress code (6-12 digits)',
        action: 'Set the check-in code',
      },
      {
        name: 'Set Location Opt-In',
        value: 'setLocationOptIn',
        action: 'Set the location opt-in',
      },
      {
        name: 'Set Require Code',
        value: 'setRequireCode',
        description: 'Whether satisfying or cancelling this check-in needs the code',
        action: 'Set whether a check-in requires the code',
      },
      { name: 'Update', value: 'update', action: 'Update a check-in' },
    ],
  },
  stringParam(
    RESOURCE,
    ['update', 'delete', 'setRequireCode', ...TRANSITIONS],
    'checkinId',
    'Check-In ID',
    'UUID of the check-in',
  ),
  stringParam(RESOURCE, ['create'], 'label', 'Label', 'Label shown on the check-in (1-255 chars)'),
  {
    displayName: 'Kind',
    name: 'kind',
    type: 'options',
    default: 'timer',
    required: true,
    displayOptions: show(RESOURCE, ['create']),
    description: 'Cannot be changed after creation',
    options: [
      { name: 'Daily', value: 'daily', description: 'Due at a local time every day' },
      { name: 'Timer', value: 'timer', description: 'Due at a deadline chosen when armed' },
    ],
  },
  stringParam(
    RESOURCE,
    ['create'],
    'timeZone',
    'Time Zone',
    'IANA time zone the daily time is read in',
    { displayOptions: { show: { resource: [RESOURCE], operation: ['create'], kind: ['daily'] } } },
  ),
  stringParam(RESOURCE, ['create'], 'localTime', 'Local Time', 'Daily due time as HH:MM:SS', {
    placeholder: '21:00:00',
    displayOptions: { show: { resource: [RESOURCE], operation: ['create'], kind: ['daily'] } },
  }),
  {
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: show(RESOURCE, ['create']),
    options: [
      {
        displayName: 'Escalation Schedule ID',
        name: 'escalationScheduleId',
        type: 'string',
        default: '',
        description:
          'Schedule whose on-call responder is paged when the deadline passes. Empty pages every responder.',
      },
      {
        displayName: 'Reminder Lead (Seconds)',
        name: 'reminderLeadSeconds',
        type: 'number',
        default: 900,
        description: 'How long before the deadline to remind (0-3600; 0 disables)',
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
        displayName: 'Escalation Schedule ID',
        name: 'escalationScheduleId',
        type: 'string',
        default: '',
        description: 'Set to the word "none" to clear',
      },
      { displayName: 'Label', name: 'label', type: 'string', default: '' },
      {
        displayName: 'Local Time',
        name: 'localTime',
        type: 'string',
        default: '',
        placeholder: '21:00:00',
      },
      {
        displayName: 'Reminder Lead (Seconds)',
        name: 'reminderLeadSeconds',
        type: 'number',
        default: 900,
      },
      { displayName: 'Time Zone', name: 'timeZone', type: 'string', default: '' },
    ],
  },
  {
    displayName: 'Deadline At',
    name: 'deadlineAt',
    type: 'string',
    default: '',
    displayOptions: show(RESOURCE, ['arm']),
    description:
      'ISO 8601 deadline for a timer check-in (must be in the future, within 7 days). Leave empty for a daily check-in.',
  },
  {
    displayName: 'By (Seconds)',
    name: 'bySeconds',
    type: 'number',
    default: 3600,
    required: true,
    displayOptions: show(RESOURCE, ['extend']),
    description: 'How much to push the deadline out (the new deadline must stay within 7 days)',
  },
  {
    displayName: 'Expected Deadline At',
    name: 'expectedDeadlineAt',
    type: 'string',
    default: '',
    displayOptions: show(RESOURCE, ['extend']),
    description:
      'Optional guard: the current deadline you believe is set. The extend is refused if it has moved.',
  },
  {
    displayName: 'Code',
    name: 'code',
    type: 'string',
    typeOptions: { password: true },
    default: '',
    displayOptions: show(RESOURCE, ['satisfy', 'cancel']),
    description: 'The check-in code, when this check-in requires one',
  },
  locationCollection(RESOURCE, TRANSITIONS),
  {
    displayName: 'Require Code',
    name: 'requireCode',
    type: 'boolean',
    default: true,
    displayOptions: show(RESOURCE, ['setRequireCode']),
  },
  {
    displayName: 'Code',
    name: 'newCode',
    type: 'string',
    typeOptions: { password: true },
    default: '',
    required: true,
    displayOptions: show(RESOURCE, ['setCode']),
    description: '6-12 digits',
  },
  {
    displayName: 'Duress Code',
    name: 'duressCode',
    type: 'string',
    typeOptions: { password: true },
    default: '',
    displayOptions: show(RESOURCE, ['setCode']),
    description:
      'Optional 6-12 digit code that satisfies the check-in while silently raising a duress incident',
  },
  {
    displayName: 'Opt In',
    name: 'optIn',
    type: 'boolean',
    default: true,
    displayOptions: show(RESOURCE, ['setLocationOptIn']),
    description: 'Whether to share position with check-in transitions',
  },
];

function withLocation(
  ctx: Parameters<typeof locationBody>[0],
  itemIndex: number,
  body: IDataObject,
) {
  const location = locationBody(ctx, itemIndex);
  return location ? { ...body, location } : body;
}

export const checkinResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getAll(_itemIndex, client) {
      return unwrapList(await client.request('GET', '/api/v1/checkins'), 'checkins');
    },
    async create(itemIndex, client) {
      const kind = this.getNodeParameter('kind', itemIndex) as string;
      const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
      const body: IDataObject = compact({
        label: this.getNodeParameter('label', itemIndex),
        kind,
        reminder_lead_seconds: asInteger(
          this,
          itemIndex,
          additional.reminderLeadSeconds,
          'Reminder Lead (Seconds)',
        ),
        escalation_schedule_id: additional.escalationScheduleId,
      });
      if (kind === 'daily') {
        body.time_zone = this.getNodeParameter('timeZone', itemIndex) as string;
        body.local_time = this.getNodeParameter('localTime', itemIndex) as string;
      }
      return unwrap(await client.request('POST', '/api/v1/checkins', { body }), 'checkin');
    },
    async update(itemIndex, client) {
      const id = this.getNodeParameter('checkinId', itemIndex) as string;
      const fields = this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject;
      const body: IDataObject = compact({
        label: fields.label,
        reminder_lead_seconds: asInteger(
          this,
          itemIndex,
          fields.reminderLeadSeconds,
          'Reminder Lead (Seconds)',
        ),
        time_zone: fields.timeZone,
        local_time: fields.localTime,
      });
      if (fields.escalationScheduleId === 'none') {
        body.escalation_schedule_id = null;
      } else if (fields.escalationScheduleId) {
        body.escalation_schedule_id = fields.escalationScheduleId;
      }
      return unwrap(await client.request('PATCH', `/api/v1/checkins/${id}`, { body }), 'checkin');
    },
    async delete(itemIndex, client) {
      const id = this.getNodeParameter('checkinId', itemIndex) as string;
      await client.request('DELETE', `/api/v1/checkins/${id}`);
      return { success: true, id };
    },
    async arm(itemIndex, client) {
      const id = this.getNodeParameter('checkinId', itemIndex) as string;
      const body = withLocation(
        this,
        itemIndex,
        compact({ deadline_at: this.getNodeParameter('deadlineAt', itemIndex, '') }),
      );
      return unwrap(
        await client.request('POST', `/api/v1/checkins/${id}/arm`, { body }),
        'checkin',
      );
    },
    async extend(itemIndex, client) {
      const id = this.getNodeParameter('checkinId', itemIndex) as string;
      const body = withLocation(
        this,
        itemIndex,
        compact({
          by_seconds: asInteger(
            this,
            itemIndex,
            this.getNodeParameter('bySeconds', itemIndex),
            'By (Seconds)',
          ),
          expected_deadline_at: this.getNodeParameter('expectedDeadlineAt', itemIndex, ''),
        }),
      );
      return unwrap(
        await client.request('POST', `/api/v1/checkins/${id}/extend`, { body }),
        'checkin',
      );
    },
    async satisfy(itemIndex, client) {
      const id = this.getNodeParameter('checkinId', itemIndex) as string;
      const body = withLocation(
        this,
        itemIndex,
        compact({ code: this.getNodeParameter('code', itemIndex, '') }),
      );
      return unwrap(
        await client.request('POST', `/api/v1/checkins/${id}/satisfy`, { body }),
        'checkin',
      );
    },
    async cancel(itemIndex, client) {
      const id = this.getNodeParameter('checkinId', itemIndex) as string;
      const body = withLocation(
        this,
        itemIndex,
        compact({ code: this.getNodeParameter('code', itemIndex, '') }),
      );
      return unwrap(
        await client.request('POST', `/api/v1/checkins/${id}/cancel`, { body }),
        'checkin',
      );
    },
    async setRequireCode(itemIndex, client) {
      const id = this.getNodeParameter('checkinId', itemIndex) as string;
      const body = { require_code: this.getNodeParameter('requireCode', itemIndex) as boolean };
      return unwrap(
        await client.request('POST', `/api/v1/checkins/${id}/require_code`, { body }),
        'checkin',
      );
    },
    async getCodeStatus(_itemIndex, client) {
      return client.request('GET', '/api/v1/checkins/code');
    },
    async setCode(itemIndex, client) {
      const body = compact({
        code: this.getNodeParameter('newCode', itemIndex),
        duress_code: this.getNodeParameter('duressCode', itemIndex, ''),
      });
      return client.request('PUT', '/api/v1/checkins/code', { body });
    },
    async clearCode(_itemIndex, client) {
      return client.request('DELETE', '/api/v1/checkins/code');
    },
    async clearDuressCode(_itemIndex, client) {
      return client.request('DELETE', '/api/v1/checkins/duress_code');
    },
    async getLocationOptIn(_itemIndex, client) {
      return client.request('GET', '/api/v1/checkins/location');
    },
    async setLocationOptIn(itemIndex, client) {
      const body = { opt_in: this.getNodeParameter('optIn', itemIndex) as boolean };
      return client.request('PUT', '/api/v1/checkins/location', { body });
    },
  },
};
