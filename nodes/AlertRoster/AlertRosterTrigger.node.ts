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
  assigned_to_user_id?: string | null;
  assigned_at?: string | null;
  escalation_rule_position?: number;
  escalation_repeat_count?: number;
  escalate_at?: string | null;
  silenced_until?: string | null;
  duress?: boolean;
}

/** What the last poll saw of one open incident: enough to name the transition since. */
interface Snapshot {
  status: Status;
  assignedTo: string | null;
  assignedAt: string | null;
  rulePosition: number;
  repeatCount: number;
  escalateAt: string | null;
  silencedUntil: string | null;
  /** `silenced_until` was still ahead, on a `triggered` incident, when this snapshot was taken. */
  quiet: boolean;
}

interface PollState {
  /**
   * Open incidents seen on the last poll, by id. Releases before the one that
   * added the escalated / reassigned / silenced events stored the bare status
   * string; such an entry is read as a status-only snapshot for one poll and
   * upgraded.
   */
  known?: Record<string, Snapshot | Status>;
}

const EVENT_TRIGGERED = 'incident.triggered';
const EVENT_ACKNOWLEDGED = 'incident.acknowledged';
const EVENT_ESCALATED = 'incident.escalated';
const EVENT_REASSIGNED = 'incident.reassigned';
const EVENT_SILENCED = 'incident.silenced';
const EVENT_UNSILENCED = 'incident.unsilenced';
const EVENT_RESOLVED = 'incident.resolved';

const TERMINAL: Status[] = ['resolved', 'auto_resolved', 'expired'];

/** Only `silenced_until > now` on a `triggered` incident means quiet (INCIDENT_API.md §3). */
function isQuiet(status: Status, silencedUntil: string | null, now: number): boolean {
  if (status !== 'triggered' || !silencedUntil) {
    return false;
  }
  const until = Date.parse(silencedUntil);
  return Number.isFinite(until) && until > now;
}

function snapshot(incident: Incident, now: number): Snapshot {
  const silencedUntil = incident.silenced_until ?? null;
  return {
    status: incident.status,
    assignedTo: incident.assigned_to_user_id ?? null,
    assignedAt: incident.assigned_at ?? null,
    rulePosition: incident.escalation_rule_position ?? 0,
    repeatCount: incident.escalation_repeat_count ?? 0,
    escalateAt: incident.escalate_at ?? null,
    silencedUntil,
    quiet: isQuiet(incident.status, silencedUntil, now),
  };
}

function at(value: string | null): number {
  return value ? Date.parse(value) : NaN;
}

/**
 * The transitions between two snapshots of one open incident, in the order a
 * workflow would want them. Acknowledge, escalate and reassign are exclusive,
 * in that priority: an acknowledgement also claims the incident (so the
 * assignee moves), an escalation re-resolves who is paged (so the assignee may
 * move), and neither is a reassignment. Silence and its lapse are independent
 * of those three. `now` is the instant the current snapshot was read.
 */
function transitions(previous: Snapshot, current: Snapshot, now: number): string[] {
  const out: string[] = [];

  // Acknowledging a `triggered` incident, or claiming a reassigned one that
  // was already `acknowledged`: the claim leaves the status alone, moves the
  // assignee to the caller and clears the live ack window (INCIDENT_API.md §6).
  const acknowledged =
    (previous.status === 'triggered' && current.status === 'acknowledged') ||
    (previous.status === 'acknowledged' &&
      current.status === 'acknowledged' &&
      previous.escalateAt !== null &&
      current.escalateAt === null);
  // A rung or a lap moved: a policy rung fired, or a schedule source paged
  // again (that path counts laps too).
  const laddered =
    current.rulePosition > previous.rulePosition || current.repeatCount > previous.repeatCount;
  // The ack window moved forward without a counter moving. Two things do
  // that: the end of a local grace (rule 0 starts, nobody was assigned) and a
  // reassignment (which restarts the window). They are told apart by the
  // clock: an escalation happens because the window we last saw ran out.
  const windowMoved =
    previous.escalateAt !== null &&
    current.escalateAt !== null &&
    at(current.escalateAt) > at(previous.escalateAt);
  const windowElapsed = previous.escalateAt !== null && at(previous.escalateAt) <= now;
  // `assigned_at` moves on a reassign to the responder who already holds it,
  // which the server treats as a real hand-back rather than a no-op (§7).
  const reassigned =
    current.assignedTo !== previous.assignedTo || current.assignedAt !== previous.assignedAt;

  if (acknowledged) {
    out.push(EVENT_ACKNOWLEDGED);
  } else if (laddered || (windowMoved && windowElapsed && current.status === 'triggered')) {
    out.push(EVENT_ESCALATED);
  } else if (reassigned) {
    out.push(EVENT_REASSIGNED);
  }

  // `silenced_until` is never cleared: a past value is history, only a
  // future one on a `triggered` incident is quiet. A second silence
  // overwrites the first, which is another silence.
  if (current.quiet && current.silencedUntil !== previous.silencedUntil) {
    out.push(EVENT_SILENCED);
  } else if (
    previous.quiet &&
    !current.quiet &&
    current.status === 'triggered' &&
    current.silencedUntil === previous.silencedUntil
  ) {
    // Still `triggered` and nothing rewrote the window: the clock ended it.
    out.push(EVENT_UNSILENCED);
  }

  return out;
}

/**
 * AlertRoster has no outbound webhooks and `GET /api/v1/incidents` returns
 * only open incidents with no cursor, so this trigger diffs the open list
 * between polls. An incident that leaves the open list is fetched by id to
 * learn how it closed. Everything else is read off the incident fields the
 * list already carries, so a reassignment, an escalation and a silence cost
 * no extra request.
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
      'Starts a workflow when an AlertRoster incident is triggered, acknowledged, escalated, reassigned, silenced, or resolved',
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
            name: 'Incident Escalated',
            value: EVENT_ESCALATED,
            description:
              'The ack window ran out with nobody answering: the next rung of the escalation policy fired, a schedule source paged again, or a local grace ended and the first page went out',
          },
          {
            name: 'Incident Reassigned',
            value: EVENT_REASSIGNED,
            description: 'An open incident was handed to a different responder',
          },
          {
            name: 'Incident Resolved',
            value: EVENT_RESOLVED,
            description: 'An incident left the open list (resolved, auto-resolved, or expired)',
          },
          {
            name: 'Incident Silenced',
            value: EVENT_SILENCED,
            description: 'Somebody stopped the noise for a bounded window without acknowledging',
          },
          {
            name: 'Incident Triggered',
            value: EVENT_TRIGGERED,
            description: 'A new incident appeared',
          },
          {
            name: 'Incident Unsilenced',
            value: EVENT_UNSILENCED,
            description: 'The silence ran out with nobody having answered',
          },
        ],
      },
      {
        displayName: 'Duress Only',
        name: 'duressOnly',
        type: 'boolean',
        default: false,
        description:
          'Whether to fire only for incidents raised under duress (a check-in satisfied with the duress code). Every incident carries a duress flag either way.',
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
    const duressOnly = this.getNodeParameter('duressOnly', false) === true;
    const open = unwrapList(
      await session.request('GET', '/api/v1/incidents'),
      'incidents',
    ) as Incident[];
    // Read the clock after the request so a silence is judged at the instant
    // the list was read, not before the round trip.
    const now = Date.now();

    const wanted = (incident: Incident): boolean => !duressOnly || incident.duress === true;

    // Manual test run: show the open incidents as samples without touching
    // state, as the events the selection would name them.
    if (this.getMode() === 'manual') {
      const samples = open
        .filter(wanted)
        .map((incident) => ({
          event: incident.status === 'acknowledged' ? EVENT_ACKNOWLEDGED : EVENT_TRIGGERED,
          incident,
        }))
        .filter((sample) => events.has(sample.event));
      return samples.length ? [this.helpers.returnJsonArray(samples)] : null;
    }

    const state = this.getWorkflowStaticData('node') as PollState;

    // First activation: remember what is already open rather than replaying it.
    if (!state.known) {
      state.known = Object.fromEntries(
        open.map((incident) => [incident.id, snapshot(incident, now)]),
      );
      return null;
    }

    const known = state.known;
    const next: Record<string, Snapshot> = {};
    const out: IDataObject[] = [];
    const emit = (event: string, incident: Incident) => {
      if (events.has(event) && wanted(incident)) {
        out.push({ event, incident });
      }
    };

    for (const incident of open) {
      const previous = known[incident.id];
      const current = snapshot(incident, now);
      next[incident.id] = current;

      if (previous === undefined) {
        emit(EVENT_TRIGGERED, incident);
        if (incident.status === 'acknowledged') {
          emit(EVENT_ACKNOWLEDGED, incident);
        }
        continue;
      }

      if (typeof previous === 'string') {
        // State from an earlier release carried only the status; the other
        // fields are unknown, so only the status transition can be named.
        if (previous === 'triggered' && incident.status === 'acknowledged') {
          emit(EVENT_ACKNOWLEDGED, incident);
        }
        continue;
      }

      for (const event of transitions(previous, current, now)) {
        emit(event, incident);
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
          emit(EVENT_RESOLVED, incident);
        } else {
          // Still open by id but missing from the list: keep watching it.
          next[id] = snapshot(incident, now);
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
