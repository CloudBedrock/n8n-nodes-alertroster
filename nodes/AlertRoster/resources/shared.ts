import {
  IDataObject,
  IExecuteFunctions,
  IHttpRequestMethods,
  INodeProperties,
  NodeOperationError,
} from 'n8n-workflow';

import { AlertRosterHttpError } from '../../../utils/AlertRosterHttp';

/** What every resource module needs from a client, whichever credential backs it. */
export interface ApiClient {
  request<T = IDataObject>(
    method: IHttpRequestMethods,
    path: string,
    options?: { body?: IDataObject; qs?: IDataObject },
  ): Promise<T>;
}

export type OperationHandler = (
  this: IExecuteFunctions,
  itemIndex: number,
  client: ApiClient,
) => Promise<IDataObject | IDataObject[]>;

export interface ResourceModule {
  /** The `resource` parameter value. */
  resource: string;
  /** Which credential backs the module; `lane` applies to `key` only. */
  auth: 'key' | 'responder';
  lane?: 'async' | 'sync';
  properties: INodeProperties[];
  operations: Record<string, OperationHandler>;
}

/** `displayOptions.show` for one resource and (optionally) a set of operations. */
export function show(resource: string, operations?: string[]): INodeProperties['displayOptions'] {
  const conditions: Record<string, string[]> = { resource: [resource] };
  if (operations) {
    conditions.operation = operations;
  }
  return { show: conditions };
}

/** A required string parameter shown for the given operations. */
export function stringParam(
  resource: string,
  operations: string[],
  name: string,
  displayName: string,
  description: string,
  extra: Partial<INodeProperties> = {},
): INodeProperties {
  return {
    displayName,
    name,
    type: 'string',
    default: '',
    required: true,
    description,
    displayOptions: show(resource, operations),
    ...extra,
  };
}

/** Copy only the entries whose value is not empty. */
export function compact(source: IDataObject): IDataObject {
  const out: IDataObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Parse a JSON-typed parameter that n8n may hand over as a string or an object. */
export function jsonObject(
  ctx: IExecuteFunctions,
  itemIndex: number,
  value: unknown,
  label: string,
): IDataObject | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new NodeOperationError(ctx.getNode(), `${label} must be valid JSON`, { itemIndex });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON object`, { itemIndex });
  }
  return parsed as IDataObject;
}

/** Split a comma-separated id list, dropping blanks. */
export function idList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Require a whole number, so the server gets a JSON integer (it refuses strings and floats). */
export function asInteger(
  ctx: IExecuteFunctions,
  itemIndex: number,
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num)) {
    throw new NodeOperationError(ctx.getNode(), `${label} must be a whole number`, { itemIndex });
  }
  return num;
}

/** Read a parameter and require it to be a whole number. */
export function integerParam(
  ctx: IExecuteFunctions,
  itemIndex: number,
  name: string,
  label: string,
): number | undefined {
  return asInteger(ctx, itemIndex, ctx.getNodeParameter(name, itemIndex, undefined), label);
}

/** Unwrap `{ "<key>": {...} }` into the object. */
export function unwrap<T extends IDataObject = IDataObject>(response: IDataObject, key: string): T {
  const inner = response[key];
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as T;
  }
  return response as T;
}

/** Unwrap `{ "<key>": [...] }` into the array. */
export function unwrapList(response: IDataObject, key: string): IDataObject[] {
  const inner = response[key];
  return Array.isArray(inner) ? (inner as IDataObject[]) : [];
}

export function isNotFound(error: unknown): boolean {
  return error instanceof AlertRosterHttpError && error.status === 404;
}

/**
 * The optional `location` object accepted by the four check-in transitions.
 * The server drops it silently when it is malformed or unconsented, so the
 * node only forwards what the user filled in.
 */
export function locationCollection(resource: string, operations: string[]): INodeProperties {
  return {
    displayName: 'Location',
    name: 'location',
    type: 'collection',
    placeholder: 'Add Location',
    default: {},
    description:
      'Optional position captured with this transition. Stored only when the responder has opted in to location sharing.',
    displayOptions: show(resource, operations),
    options: [
      { displayName: 'Accuracy (m)', name: 'accuracy_m', type: 'number', default: 0 },
      {
        displayName: 'Fix At',
        name: 'fix_at',
        type: 'string',
        default: '',
        description: 'ISO 8601 time of the GPS fix. Must be within the last day.',
      },
      { displayName: 'Latitude', name: 'latitude', type: 'number', default: 0 },
      { displayName: 'Longitude', name: 'longitude', type: 'number', default: 0 },
    ],
  };
}

export function locationBody(ctx: IExecuteFunctions, itemIndex: number): IDataObject | undefined {
  const raw = ctx.getNodeParameter('location', itemIndex, {}) as IDataObject;
  const location = compact(raw);
  if (location.latitude === undefined && location.longitude === undefined) {
    return undefined;
  }
  // An accuracy of 0 m is the untouched default, not a measurement.
  if (location.accuracy_m === 0) {
    delete location.accuracy_m;
  }
  return location;
}

/**
 * The search-description fields: what a person said they were wearing and
 * where they said they were going. `PUT /checkins/:id/details` takes them as
 * a deliberate write (blank clears, unconsented refuses); the four transitions
 * take the same fields as an optional `details` object the server drops
 * rather than refuses.
 */
export function detailsCollection(
  resource: string,
  operations: string[],
  extra: Partial<INodeProperties> = {},
): INodeProperties {
  return {
    displayName: 'Details',
    name: 'details',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    description:
      'Optional search description written with this transition. Stored only when the responder has opted in to details; never fails the transition.',
    displayOptions: show(resource, operations),
    options: [
      { displayName: 'Destination', name: 'destination_text', type: 'string', default: '' },
      {
        displayName: 'Destination Latitude',
        name: 'destination_latitude',
        type: 'number',
        default: 0,
      },
      {
        displayName: 'Destination Longitude',
        name: 'destination_longitude',
        type: 'number',
        default: 0,
      },
      { displayName: 'Origin', name: 'origin_text', type: 'string', default: '' },
      { displayName: 'Origin Latitude', name: 'origin_latitude', type: 'number', default: 0 },
      { displayName: 'Origin Longitude', name: 'origin_longitude', type: 'number', default: 0 },
      {
        displayName: 'Wearing',
        name: 'wearing',
        type: 'string',
        default: '',
        description: 'Clothing and kit, up to 500 characters',
      },
    ],
    ...extra,
  };
}

/** The `details` object for a transition, or nothing when the user typed nothing. */
export function detailsBody(ctx: IExecuteFunctions, itemIndex: number): IDataObject | undefined {
  const details = compact(ctx.getNodeParameter('details', itemIndex, {}) as IDataObject);
  return Object.keys(details).length > 0 ? details : undefined;
}
