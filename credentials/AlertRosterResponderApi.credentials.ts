import { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Responder sign-in. AlertRoster issues short-lived (15 minute) access tokens
 * from `POST /api/v1/auth/login`; the node signs in with these details, caches
 * the access token in workflow static data, and signs in again when it expires
 * or is rejected. Password login is throttled per client IP (20 per 15 min),
 * which the cache keeps well clear of.
 *
 * The user must have set a password in AlertRoster (Settings) — responders are
 * created by an admin and normally sign in by magic link, so a password is
 * opt-in.
 */
export class AlertRosterResponderApi implements ICredentialType {
  name = 'alertRosterResponderApi';
  displayName = 'AlertRoster Responder';
  documentationUrl = 'https://github.com/CloudBedrock/n8n-nodes-alertroster';
  properties: INodeProperties[] = [
    {
      displayName: 'Email',
      name: 'email',
      type: 'string',
      placeholder: 'name@example.com',
      default: '',
      required: true,
    },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      required: true,
      description: 'The password set on this responder in AlertRoster settings',
    },
    {
      displayName: 'Account ID',
      name: 'accountId',
      type: 'string',
      default: '',
      description:
        'Only needed when the email belongs to more than one AlertRoster account. Leave blank otherwise.',
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

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl}}',
      url: '/api/v1/auth/login',
      method: 'POST',
      body: {
        email: '={{$credentials.email}}',
        password: '={{$credentials.password}}',
        account_id: '={{$credentials.accountId || undefined}}',
      },
    },
  };
}
