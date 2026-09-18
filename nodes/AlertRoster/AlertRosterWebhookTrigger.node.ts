import {
  IDataObject,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
  NodeConnectionTypes,
} from 'n8n-workflow';

import { SeenIds, rememberEventId } from '../../utils/WebhookDedup';
import { verifySignature } from '../../utils/WebhookSignature';

/** Everything AlertRoster sends today (INCIDENT_WEBHOOKS.md §2), in the order the UI lists it. */
const INCIDENT_EVENTS = [
  {
    name: 'Incident Acknowledged',
    value: 'incident.acknowledged',
    description: 'Somebody answered it. Also on an idempotent re-acknowledgement.',
  },
  {
    name: 'Incident Escalated',
    value: 'incident.escalated',
    description: 'An ack window ran out and the next rung fired',
  },
  {
    name: 'Incident Reassigned',
    value: 'incident.reassigned',
    description: 'The page moved to somebody else',
  },
  { name: 'Incident Resolved', value: 'incident.resolved', description: 'It closed' },
  {
    name: 'Incident Silenced',
    value: 'incident.silenced',
    description: 'Somebody quieted the horn for a bounded window',
  },
  { name: 'Incident Triggered', value: 'incident.triggered', description: 'An incident opened' },
  { name: 'Incident Unsilenced', value: 'incident.unsilenced', description: 'A silence ended' },
  {
    name: 'Incident Updated',
    value: 'incident.updated',
    description: 'Title or urgency revised, or the rendered position moved; never a transition',
  },
];

const TEST_EVENT = 'webhook.test';

interface WebhookBody extends IDataObject {
  id: string;
  type: string;
  created_at?: string;
  account_id?: string;
  incident?: IDataObject;
}

interface WebhookState {
  seen?: SeenIds;
}

/**
 * Receives AlertRoster's signed outbound incident webhooks (backend
 * `docs/INCIDENT_WEBHOOKS.md`). The signature is checked on the raw request
 * bytes before anything else, a stale or wrong one is answered 401 so the
 * admin sees `refused` in the endpoint's delivery log, duplicates of a
 * retried event are answered 200 without a run, and an accepted event starts
 * the workflow with the same `{ event, incident }` shape the polling trigger
 * emits, so the two are interchangeable downstream.
 *
 * Endpoints are created on AlertRoster's Webhooks page only (there is no API
 * for them), with this node's production URL and no event filter; the secret
 * shown there goes into the credential.
 */
export class AlertRosterWebhookTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'AlertRoster Webhook Trigger',
    name: 'alertRosterWebhookTrigger',
    icon: 'file:alertroster.svg',
    group: ['trigger'],
    version: 1,
    subtitle:
      '={{ $parameter["events"].length ? $parameter["events"].join(", ") : "all incident events" }}',
    description:
      'Starts a workflow when AlertRoster delivers a signed incident webhook: triggered, acknowledged, escalated, reassigned, silenced, updated, or resolved',
    defaults: {
      name: 'AlertRoster Webhook Trigger',
    },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'alertRosterWebhookApi',
        required: true,
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'alertroster',
      },
    ],
    properties: [
      {
        displayName:
          'Create an endpoint on the AlertRoster Webhooks page (as an admin) with this node\'s production URL, and paste the signing secret it shows once into the credential. "Send a test event" there proves the URL and the secret.',
        name: 'setupNotice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        default: [],
        description:
          'Which incident events start this workflow. Leave empty for every incident event, including kinds AlertRoster adds later.',
        options: INCIDENT_EVENTS,
      },
      {
        displayName: 'Duress Only',
        name: 'duressOnly',
        type: 'boolean',
        default: false,
        description:
          'Whether to start only for incidents raised under duress (a check-in satisfied with the duress code). Every incident carries a duress flag either way.',
      },
      {
        displayName: 'Emit Test Events',
        name: 'emitTestEvents',
        type: 'boolean',
        default: false,
        description:
          'Whether a "Send a test event" from the AlertRoster Webhooks page starts this workflow. Its incident is synthetic (nil UUID, priority normal) and must not be acted on; leave off except while wiring the workflow up.',
      },
    ],
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const res = this.getResponseObject();
    const refuse = (status: number, error: string): IWebhookResponseData => {
      res.status(status).json({ error });
      return { noWebhookResponse: true };
    };
    const ignore = (reason: string): IWebhookResponseData => ({
      webhookResponse: { ok: true, ignored: reason },
    });

    // 1. The exact bytes the sender signed. n8n keeps them on the request;
    //    read them if it has not, and give up rather than verify a re-encoding.
    const req = this.getRequestObject();
    let raw: unknown = req.rawBody;
    if (!Buffer.isBuffer(raw)) {
      try {
        await req.readRawBody?.();
        raw = req.rawBody;
      } catch {
        raw = undefined;
      }
    }
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      return refuse(
        400,
        'request body was not available as raw bytes; signature cannot be verified',
      );
    }

    // 2. The signature, before anything that could answer 200.
    const credentials = await this.getCredentials('alertRosterWebhookApi');
    const secret = String(credentials.secret ?? '').trim();
    if (!secret) {
      return refuse(401, 'no signing secret is set on the n8n credential');
    }
    const headerValue = this.getHeaderData()['x-alertroster-signature'];
    const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const verdict = verifySignature(secret, header, raw);
    if (!verdict.ok) {
      return refuse(401, verdict.detail);
    }

    // 3. Only now is the body worth reading, from the verified bytes.
    let body: WebhookBody;
    try {
      body = JSON.parse(raw.toString('utf8')) as WebhookBody;
    } catch {
      return refuse(400, 'body is not valid JSON');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.id !== 'string' ||
      typeof body.type !== 'string'
    ) {
      return refuse(400, 'body lacks the id and type of an AlertRoster webhook event');
    }

    // 4. Routing. A test event is never subscribable server-side and is only
    //    let through on request; everything else must be an incident event
    //    the node was asked for.
    const events = this.getNodeParameter('events', []) as string[];
    const duressOnly = this.getNodeParameter('duressOnly', false) === true;
    const emitTestEvents = this.getNodeParameter('emitTestEvents', false) === true;
    const isTest = body.type === TEST_EVENT;
    if (isTest && !emitTestEvents) {
      return ignore('test');
    }
    if (!isTest) {
      if (!body.type.startsWith('incident.')) {
        return ignore('unknown type');
      }
      if (events.length > 0 && !events.includes(body.type)) {
        return ignore('unsubscribed');
      }
      if (duressOnly && body.incident?.duress !== true) {
        return ignore('filtered');
      }
    }

    // 5. A retry of an event already accepted is answered without a run.
    //    Assigned, not mutated: n8n persists static data on assignment.
    const state = this.getWorkflowStaticData('node') as WebhookState;
    const remembered = rememberEventId(state.seen, body.id, Date.now());
    if (remembered.duplicate) {
      return ignore('duplicate');
    }
    state.seen = remembered.seen;

    const attempt = Number.parseInt(
      String(this.getHeaderData()['x-alertroster-delivery-attempt'] ?? '1'),
      10,
    );
    const item: IDataObject = {
      event: body.type,
      incident: body.incident ?? null,
      event_id: body.id,
      created_at: body.created_at ?? null,
      account_id: body.account_id ?? null,
      delivery_attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
    };
    return {
      workflowData: [this.helpers.returnJsonArray([item])],
      webhookResponse: { ok: true },
    };
  }
}
