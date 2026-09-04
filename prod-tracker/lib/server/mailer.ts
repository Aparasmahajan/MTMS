/**
 * Where an invitation actually goes.
 *
 * There is one seam and one call site, so wiring a real transport is a change here and
 * nowhere else. The default transport **logs and does not send** — this app has no mail
 * server of its own, and quietly failing to deliver would be worse than saying so.
 *
 * `MAIL_TRANSPORT=webhook` posts the message to `MAIL_WEBHOOK_URL` instead, which is the
 * seam a Kafka `user.invited` consumer or a corporate relay plugs into without this file
 * needing to know about SMTP, credentials or retries.
 */

export interface Message {
  to: string;
  subject: string;
  body: string;
}

export type DeliveryState = 'logged' | 'sent' | 'failed';

export interface Delivery {
  state: DeliveryState;
  /** Written for the admin who pressed the button, not for a log reader. */
  detail: string;
}

function transportName(): 'log' | 'webhook' {
  return process.env.MAIL_TRANSPORT === 'webhook' ? 'webhook' : 'log';
}

async function postToWebhook(message: Message): Promise<Delivery> {
  const url = process.env.MAIL_WEBHOOK_URL;
  if (!url) {
    return {
      state: 'failed',
      detail: 'MAIL_TRANSPORT is set to webhook but MAIL_WEBHOOK_URL is not set.',
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      return { state: 'failed', detail: `The mail webhook returned ${response.status}.` };
    }
    return { state: 'sent', detail: `Sent to ${message.to}.` };
  } catch {
    // The invitation itself is already committed, so a delivery failure must not read as
    // "the invitation failed" — the link still works and the caller surfaces it.
    return { state: 'failed', detail: 'The mail webhook could not be reached.' };
  }
}

export async function deliver(message: Message): Promise<Delivery> {
  if (transportName() === 'webhook') return postToWebhook(message);

  console.info(`[mail] would send to ${message.to}: ${message.subject}`);
  return {
    state: 'logged',
    detail: 'No mail transport is configured, so nothing was sent.',
  };
}

export function invitationMessage(input: {
  email: string;
  displayName: string;
  invitedBy: string;
  orgName: string;
  acceptUrl: string;
}): Message {
  return {
    to: input.email,
    subject: `${input.orgName} — you have been invited to the Prod Tracker`,
    body: [
      `${input.displayName || input.email},`,
      '',
      `${input.invitedBy} has invited you to ${input.orgName} on the Prod Tracker.`,
      'Follow this single-use link to set your password:',
      '',
      input.acceptUrl,
      '',
      'The link expires in seven days.',
    ].join('\n'),
  };
}
