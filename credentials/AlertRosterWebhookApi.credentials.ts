import { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * The signing secret of one outbound webhook endpoint, for the AlertRoster
 * Webhook Trigger. An admin creates the endpoint on AlertRoster's Webhooks
 * page with the trigger's production URL; the secret is shown exactly once
 * there and cannot be shown again (lost secrets are rotated, not recovered).
 *
 * No credential test on purpose: a signing secret is only provable by a
 * delivery, and the Webhooks page's "Send a test event" is that test — a
 * wrong secret shows there as a refused 401.
 */
export class AlertRosterWebhookApi implements ICredentialType {
  name = 'alertRosterWebhookApi';
  displayName = 'AlertRoster Webhook Secret';
  documentationUrl = 'https://github.com/CloudBedrock/n8n-nodes-alertroster';
  properties: INodeProperties[] = [
    {
      displayName: 'Signing Secret',
      name: 'secret',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      required: true,
      description:
        'The secret shown once when the endpoint was created on the AlertRoster Webhooks page. Rotate it there and paste the new one here.',
    },
  ];
}
