import {
  IDataObject,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IPollFunctions,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';

import { ResponderSession } from '../../utils/ResponderSession';
import { isNotFound, unwrap, unwrapList } from './resources/shared';

type Status = 'triggered' | 'acknowledged' | 'resolved' | 'auto_resolved' | 'expired';

interface Incident extends IDataObject {
  id: string;
  status: Status;
}

interface PollState {
  /** Open incidents seen on the last poll, by id, with the status seen. */
  known?: Record<string, Status>;
}

const EVENT_TRIGGERED = 'incident.triggered';
const EVENT_ACKNOWLEDGED = 'incident.acknowledged';
const EVENT_RESOLVED = 'incident.resolved';

const TERMINAL: Status[] = ['resolved', 'auto_resolved', 'expired'];

/**
 * AlertRoster has no outbound webhooks and `GET /api/v1/incidents` returns
 * only open incidents with no cursor, so this trigger diffs the open list
 * between polls. An incident that leaves the open list is fetched by id to
 * learn how it closed.
 */
export class AlertRosterTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'AlertRoster Trigger',
    name: 'alertRosterTrigger',
    icon: 'file:alertroster.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description:
      'Starts a workflow when an AlertRoster incident is triggered, acknowledged, or resolved',
    defaults: {
      name: 'AlertRoster Trigger',
    },
    polling: true,
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'alertRosterResponderApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        default: [EVENT_TRIGGERED],
        description: 'Which incident transitions should start this workflow',
        options: [
          {
            name: 'Incident Acknowledged',
            value: EVENT_ACKNOWLEDGED,
            description: 'An open incident was acknowledged',
          },
          {
            name: 'Incident Resolved',
            value: EVENT_RESOLVED,
            description: 'An incident left the open list (resolved, auto-resolved, or expired)',
          },
          {
            name: 'Incident Triggered',
            value: EVENT_TRIGGERED,
            description: 'A new incident appeared',
          },
        ],
      },
    ],
  };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    const credentials = await this.getCredentials('alertRosterResponderApi');
    let session: ResponderSession;
    try {
      session = new ResponderSession(
        {
          baseUrl: credentials.baseUrl as string,
          email: credentials.email as string,
          password: credentials.password as string,
          accountId: (credentials.accountId as string) || undefined,
        },
        this.getWorkflowStaticData('global') as IDataObject,
      );
    } catch (error) {
      throw new NodeOperationError(this.getNode(), (error as Error).message);
    }

    const events = new Set(this.getNodeParameter('events', []) as string[]);
    const open = unwrapList(
      await session.request('GET', '/api/v1/incidents'),
      'incidents',
    ) as Incident[];

    // Manual test run: show the open incidents as samples without touching state.
    if (this.getMode() === 'manual') {
      if (!open.length) {
        return null;
      }
      return [
        this.helpers.returnJsonArray(
          open.map((incident) => ({
            event: incident.status === 'acknowledged' ? EVENT_ACKNOWLEDGED : EVENT_TRIGGERED,
            incident,
          })),
        ),
      ];
    }

    const state = this.getWorkflowStaticData('node') as PollState;

    // First activation: remember what is already open rather than replaying it.
    if (!state.known) {
      state.known = Object.fromEntries(open.map((incident) => [incident.id, incident.status]));
      return null;
    }

    const known = state.known;
    const next: Record<string, Status> = {};
    const out: IDataObject[] = [];

    for (const incident of open) {
      const previous = known[incident.id];
      next[incident.id] = incident.status;

      if (previous === undefined) {
        if (events.has(EVENT_TRIGGERED)) {
          out.push({ event: EVENT_TRIGGERED, incident });
        }
        if (incident.status === 'acknowledged' && events.has(EVENT_ACKNOWLEDGED)) {
          out.push({ event: EVENT_ACKNOWLEDGED, incident });
        }
        continue;
      }

      if (
        previous === 'triggered' &&
        incident.status === 'acknowledged' &&
        events.has(EVENT_ACKNOWLEDGED)
      ) {
        out.push({ event: EVENT_ACKNOWLEDGED, incident });
      }
    }

    // Anything that left the open list closed one way or another.
    const closedIds = Object.keys(known).filter((id) => !(id in next));
    for (const id of closedIds) {
      if (!events.has(EVENT_RESOLVED)) {
        continue;
      }
      try {
        const incident = unwrap<Incident>(
          await session.request('GET', `/api/v1/incidents/${id}`),
          'incident',
        );
        if (TERMINAL.includes(incident.status)) {
          out.push({ event: EVENT_RESOLVED, incident });
        } else {
          // Still open by id but missing from the list: keep watching it.
          next[id] = incident.status;
        }
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }

    state.known = next;

    if (!out.length) {
      return null;
    }
    return [this.helpers.returnJsonArray(out)];
  }
}
