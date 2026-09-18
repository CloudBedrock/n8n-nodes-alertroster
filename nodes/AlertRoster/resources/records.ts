import { IDataObject, IExecuteFunctions, INodeProperties, NodeOperationError } from 'n8n-workflow';

import { ResourceModule, asInteger, show, unwrap, unwrapList } from './shared';

const RESOURCE = 'record';

// The server's own page size; the loop below asks for it and follows
// `has_more`, so Return All costs one request per page rather than one per row.
const PAGE_SIZE = 100;

const EXPORT_FORMATS = [
  {
    name: 'Check-In Events (CSV)',
    value: 'checkin_csv',
    description: 'One row per check-in event: armed, extended, satisfied, cancelled, missed',
  },
  {
    name: 'Incident Timeline (CSV)',
    value: 'timeline_csv',
    description: 'One row per incident timeline entry',
  },
  {
    name: 'Both Tables (JSON)',
    value: 'json',
    description: 'The incident timeline and the check-in events in one document',
  },
];

/** A date field: the server takes whole days in UTC, so only the date part is sent. */
function dateParam(name: string, displayName: string, description: string): INodeProperties {
  return {
    displayName,
    name,
    type: 'dateTime',
    default: '',
    required: true,
    description,
    displayOptions: show(RESOURCE),
  };
}

const properties: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: show(RESOURCE),
    default: 'getIncidents',
    options: [
      {
        name: 'Export',
        value: 'export',
        description:
          'The raw append-only rows as a file, byte for byte what the download button on the records page produces',
        action: 'Export the records',
      },
      {
        name: 'Get Coverage',
        value: 'getCoverage',
        description:
          'Was somebody on call, did people check in, and how fast did anyone answer, across the range',
        action: 'Get the coverage report',
      },
      {
        name: 'Get Incidents',
        value: 'getIncidents',
        description:
          'Every incident raised in the range, newest first, with when it was raised, answered and closed, who answered, and how it closed',
        action: 'Get the incidents raised in a range',
      },
    ],
  },
  dateParam(
    'from',
    'From',
    'First day of the range (UTC). Only the date part is used. Required: the range is a decision the caller makes rather than a default it inherits.',
  ),
  dateParam(
    'to',
    'To',
    'Last day of the range (UTC), inclusive. Only the date part is used. A range longer than 366 days is refused.',
  ),
  {
    displayName: 'Format',
    name: 'format',
    type: 'options',
    default: 'timeline_csv',
    required: true,
    options: EXPORT_FORMATS,
    displayOptions: show(RESOURCE, ['export']),
  },
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    description: 'Whether to return all results or only up to a given limit',
    displayOptions: show(RESOURCE, ['getIncidents']),
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    default: 50,
    typeOptions: { minValue: 1 },
    description: 'Max number of results to return',
    displayOptions: {
      show: { resource: [RESOURCE], operation: ['getIncidents'], returnAll: [false] },
    },
  },
];

/** `YYYY-MM-DD` from whatever n8n's date picker or an expression handed over. */
function dateOnly(ctx: IExecuteFunctions, itemIndex: number, name: string): string {
  const raw = String(ctx.getNodeParameter(name, itemIndex, '') ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) {
    throw new NodeOperationError(ctx.getNode(), `${name} must be a date (YYYY-MM-DD)`, {
      itemIndex,
    });
  }
  return match[1];
}

export const recordsResource: ResourceModule = {
  resource: RESOURCE,
  auth: 'responder',
  properties,
  operations: {
    async getIncidents(itemIndex, client) {
      const from = dateOnly(this, itemIndex, 'from');
      const to = dateOnly(this, itemIndex, 'to');
      const returnAll = this.getNodeParameter('returnAll', itemIndex, false) === true;
      const limit = returnAll
        ? Number.POSITIVE_INFINITY
        : (asInteger(this, itemIndex, this.getNodeParameter('limit', itemIndex, 50), 'Limit') ??
          50);

      const out: IDataObject[] = [];
      let offset = 0;
      for (;;) {
        const page = await client.request('GET', '/api/v1/records/incidents', {
          qs: { from, to, limit: Math.min(PAGE_SIZE, limit - out.length), offset },
        });
        const rows = unwrapList(page, 'incidents');
        out.push(...rows);
        if (out.length >= limit || page.has_more !== true || rows.length === 0) {
          break;
        }
        offset += rows.length;
      }
      return out.slice(0, Number.isFinite(limit) ? limit : undefined);
    },
    async getCoverage(itemIndex, client) {
      const from = dateOnly(this, itemIndex, 'from');
      const to = dateOnly(this, itemIndex, 'to');
      return unwrap(
        await client.request('GET', '/api/v1/records/coverage', { qs: { from, to } }),
        'coverage',
      );
    },
    async export(itemIndex, client) {
      if (!client.download) {
        throw new NodeOperationError(this.getNode(), 'Export needs the responder credential', {
          itemIndex,
        });
      }
      const from = dateOnly(this, itemIndex, 'from');
      const to = dateOnly(this, itemIndex, 'to');
      const format = this.getNodeParameter('format', itemIndex) as string;
      const file = await client.download('GET', '/api/v1/records/export', {
        qs: { from, to, format },
      });
      const extension = format === 'json' ? 'json' : 'csv';
      const fileName = file.fileName ?? `alertroster-records-${format}-${from}-${to}.${extension}`;
      const mimeType = file.contentType.split(';')[0].trim();
      return {
        json: {
          from,
          to,
          format,
          file_name: fileName,
          mime_type: mimeType,
          bytes: file.body.length,
        },
        binary: { data: await this.helpers.prepareBinaryData(file.body, fileName, mimeType) },
      };
    },
  },
};
