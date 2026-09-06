import { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';

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

const RESOURCE = 'layer';

const DAY_OPTIONS = [
  { name: 'Every Day', value: 'any' },
  { name: 'Friday', value: '5' },
  { name: 'Monday', value: '1' },
  { name: 'Saturday', value: '6' },
  { name: 'Sunday', value: '7' },
  { name: 'Thursday', value: '4' },
  { name: 'Tuesday', value: '2' },
  { name: 'Wednesday', value: '3' },
];

function restrictionsCollection(operations: string[]): INodeProperties {
  return {
    displayName: 'Restrictions',
    name: 'restrictions',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    placeholder: 'Add Restriction',
    default: {},
    displayOptions: show(RESOURCE, operations),
    description:
      "Windows, in the schedule's time zone, during which this layer is on call. None means always. An end at or before the start wraps past midnight.",
    options: [
      {
        displayName: 'Restriction',
        name: 'restriction',
        values: [
          {
            displayName: 'Day of Week',
            name: 'dayOfWeek',
            type: 'options',
            default: 'any',
            options: DAY_OPTIONS,
          },
          {
            displayName: 'Start Time',
            name: 'startTime',
            type: 'string',
            default: '09:00:00',
            placeholder: 'HH:MM:SS',
          },
          {
            displayName: 'End Time',
            name: 'endTime',
            type: 'string',
            default: '17:00:00',
            placeholder: 'HH:MM:SS',
          },
        ],
      },
    ],
  };
}

function restrictionsBody(ctx: IExecuteFunctions, itemIndex: number): IDataObject[] {
  const raw = ctx.getNodeParameter('restrictions', itemIndex, {}) as {
    restriction?: IDataObject[];
  };
  return (raw.restriction ?? []).map((row) => ({
    day_of_week:
      row.dayOfWeek === 'any' || row.dayOfWeek === undefined ? null : Number(row.dayOfWeek),
    start_time: row.startTime,
    end_time: row.endTime,
  }));
}

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
        description: 'Add a rotation layer to a schedule (admin)',
        action: 'Create a layer',
      },
      {
        name: 'Delete',
        value: 'delete',
        description: 'Remove a layer (admin)',
        action: 'Delete a layer',
      },
      {
        name: 'Get Many',
        value: 'getAll',
        description: 'List the layers of a schedule',
        action: 'Get many layers',
      },
      {
        name: 'Set Members',
        value: 'setMembers',
        description: 'Replace the rotation membership, in order (admin)',
        action: 'Set layer members',
      },
      {
        name: 'Set Restrictions',
        value: 'setRestrictions',
        description: 'Replace the time-of-day restrictions (admin)',
        action: 'Set layer restrictions',
      },
      {
        name: 'Update',
        value: 'update',
        description: 'Change name, position, or rotation timing (admin)',
        action: 'Update a layer',
      },
    ],
  },
  stringParam(RESOURCE, ['getAll', 'create'], 'scheduleId', 'Schedule ID', 'UUID of the schedule'),
  stringParam(
    RESOURCE,
    ['update', 'delete', 'setMembers', 'setRestrictions'],
    'layerId',
    'Layer ID',
    'UUID of the layer',
  ),
  stringParam(RESOURCE, ['create'], 'name', 'Name', 'Layer name'),
  {
    displayName: 'Position',
    name: 'position',
    type: 'number',
    default: 0,
    required: true,
    displayOptions: show(RESOURCE, ['create']),
    description: "Precedence among the schedule's layers; 0 is consulted first",
  },
  stringParam(
    RESOURCE,
    ['create'],
    'rotationStartsAt',
    'Rotation Starts At',
    'ISO 8601 instant the first member takes the rotation',
  ),
  {
    displayName: 'Rotation Length (Seconds)',
    name: 'rotationLengthSeconds',
    type: 'number',
    default: 604800,
    required: true,
    displayOptions: show(RESOURCE, ['create']),
    description: 'How long each member holds the rotation (604800 = one week)',
  },
  {
    displayName: 'Member IDs',
    name: 'memberIds',
    type: 'string',
    default: '',
    displayOptions: show(RESOURCE, ['create', 'setMembers']),
    description:
      'Comma-separated responder UUIDs in rotation order. Empty on Set Members empties the rotation.',
  },
  restrictionsCollection(['create', 'setRestrictions']),
  {
    displayName: 'Update Fields',
    name: 'updateFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: show(RESOURCE, ['update']),
    options: [
      { displayName: 'Name', name: 'name', type: 'string', default: '' },
      { displayName: 'Position', name: 'position', type: 'number', default: 0 },
      {
        displayName: 'Rotation Length (Seconds)',
        name: 'rotationLengthSeconds',
        type: 'number',
        default: 604800,
      },
      {
        displayName: 'Rotation Starts At',
        name: 'rotationStartsAt',
        type: 'string',
        default: '',
        description: 'ISO 8601 instant',
      },
    ],
  },
];

export const layerResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getAll(itemIndex, client) {
      const scheduleId = this.getNodeParameter('scheduleId', itemIndex) as string;
      return unwrapList(
        await client.request('GET', `/api/v1/schedules/${scheduleId}/layers`),
        'layers',
      );
    },
    async create(itemIndex, client) {
      const scheduleId = this.getNodeParameter('scheduleId', itemIndex) as string;
      const body: IDataObject = {
        name: this.getNodeParameter('name', itemIndex) as string,
        position: asInteger(
          this,
          itemIndex,
          this.getNodeParameter('position', itemIndex),
          'Position',
        ),
        rotation_starts_at: this.getNodeParameter('rotationStartsAt', itemIndex) as string,
        rotation_length_seconds: asInteger(
          this,
          itemIndex,
          this.getNodeParameter('rotationLengthSeconds', itemIndex),
          'Rotation Length (Seconds)',
        ),
        member_ids: idList(this.getNodeParameter('memberIds', itemIndex, '')),
      };
      const restrictions = restrictionsBody(this, itemIndex);
      if (restrictions.length > 0) {
        body.restrictions = restrictions;
      }
      return unwrap(
        await client.request('POST', `/api/v1/schedules/${scheduleId}/layers`, { body }),
        'layer',
      );
    },
    async update(itemIndex, client) {
      const id = this.getNodeParameter('layerId', itemIndex) as string;
      const fields = this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject;
      const body = compact({
        name: fields.name,
        position: asInteger(this, itemIndex, fields.position, 'Position'),
        rotation_starts_at: fields.rotationStartsAt,
        rotation_length_seconds: asInteger(
          this,
          itemIndex,
          fields.rotationLengthSeconds,
          'Rotation Length (Seconds)',
        ),
      });
      return unwrap(await client.request('PATCH', `/api/v1/layers/${id}`, { body }), 'layer');
    },
    async delete(itemIndex, client) {
      const id = this.getNodeParameter('layerId', itemIndex) as string;
      return unwrap(await client.request('DELETE', `/api/v1/layers/${id}`), 'layer');
    },
    async setMembers(itemIndex, client) {
      const id = this.getNodeParameter('layerId', itemIndex) as string;
      const body = { member_ids: idList(this.getNodeParameter('memberIds', itemIndex, '')) };
      return unwrap(await client.request('PUT', `/api/v1/layers/${id}/members`, { body }), 'layer');
    },
    async setRestrictions(itemIndex, client) {
      const id = this.getNodeParameter('layerId', itemIndex) as string;
      const body = { restrictions: restrictionsBody(this, itemIndex) };
      return unwrap(
        await client.request('PUT', `/api/v1/layers/${id}/restrictions`, { body }),
        'layer',
      );
    },
  },
};
