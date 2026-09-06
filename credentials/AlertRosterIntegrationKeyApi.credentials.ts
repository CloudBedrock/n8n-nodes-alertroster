import { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * A source integration key (`ark_async_…` for the Lane A event firehose,
 * `ark_sync_…` for the Lane B incident API) or an account API token
 * (`art_…`, Lane B only). All three are sent as `Authorization: Bearer`.
 *
 * There is no `authenticate` block: the node injects the header itself so it
 * can check the key prefix against the lane an operation needs and raise a
 * clear error instead of the server's deliberately generic 401.
 *
 * No credential test: neither lane has a side-effect-free GET that works
 * without an existing incident id.
 */
export class AlertRosterIntegrationKeyApi implements ICredentialType {
  name = 'alertRosterIntegrationKeyApi';
  displayName = 'AlertRoster Integration Key';
  documentationUrl = 'https://github.com/CloudBedrock/n8n-nodes-alertroster';
  properties: INodeProperties[] = [
    {
      displayName: 'Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      required: true,
      description:
        'A source integration key minted on the Sources page (ark_async_… for Event operations, ark_sync_… for Incident operations) or an account API token (art_…, Incident operations only)',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://alertroster.com',
      required: true,
      description: 'Base URL of your AlertRoster instance, without a trailing slash',
    },
  ];
}
