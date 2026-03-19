import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import * as nodemailer from "nodemailer";

const {
  IMAP_HOST,
  IMAP_PORT,
  IMAP_USER,
  IMAP_PASSWORD,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASSWORD,
  FORWARD_TO,
  FORWARD_FROM,
  ALLOWED_SENDER_DOMAINS,
} = process.env;

const PROCESSED_FOLDER = process.env.PROCESSED_FOLDER || 'Forwarded';

const DAEMON = (process.env.DAEMON || '').toLowerCase() === 'true';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const configuredLevel = (process.env.LOG_LEVEL?.toLowerCase() ?? 'info') as LogLevel;
const currentLogLevel = LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.info;

const logger = {
  error: (msg: string, ...args: any[]) => {
    if (currentLogLevel >= LOG_LEVELS.error) console.error(`[ERROR] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: any[]) => {
    if (currentLogLevel >= LOG_LEVELS.warn) console.warn(`[WARN]  ${msg}`, ...args);
  },
  info: (msg: string, ...args: any[]) => {
    if (currentLogLevel >= LOG_LEVELS.info) console.log(`[INFO]  ${msg}`, ...args);
  },
  debug: (msg: string, ...args: any[]) => {
    if (currentLogLevel >= LOG_LEVELS.debug) console.log(`[DEBUG] ${msg}`, ...args);
  },
};

function validateEnvironmentVariables() {
  const requiredVars = [
    "IMAP_HOST",
    "IMAP_PORT",
    "IMAP_USER",
    "IMAP_PASSWORD",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "FORWARD_TO",
    "FORWARD_FROM",
  ];

  const missingVars = requiredVars.filter((varName) => !process.env[varName]);

  if (missingVars.length > 0) {
    logger.error("Missing required environment variables: " + missingVars.join(", "));
    process.exit(1);
  }

  logger.debug("All required environment variables are set.");

  if (ALLOWED_SENDER_DOMAINS) {
    logger.info("Domain filtering enabled. Allowed domains: " + ALLOWED_SENDER_DOMAINS);
  } else {
    logger.debug("Domain filtering disabled. All emails will be forwarded.");
  }
}

function shouldForwardEmail(email: import('mailparser').ParsedMail) {
  // If no domain filtering is configured, forward all emails
  if (!ALLOWED_SENDER_DOMAINS) {
    return true;
  }

  // Get sender email address
  const fromAddress = email.from?.value?.[0]?.address || email.from?.text || '';
  
  if (!fromAddress) {
    logger.debug("No sender address found, skipping email");
    return false;
  }

  // Extract domain from sender email
  const senderDomain = fromAddress.split('@')[1]?.toLowerCase();

  if (!senderDomain) {
    logger.warn(`Invalid sender email format: ${fromAddress}`);
    return false;
  }

  // Parse allowed domains (comma-separated, case-insensitive)
  const allowedDomains = ALLOWED_SENDER_DOMAINS
    .split(',')
    .map(domain => domain.trim().toLowerCase())
    .filter(domain => domain.length > 0);

  const isAllowed = allowedDomains.includes(senderDomain);

  if (!isAllowed) {
    logger.info(`Skipping email from ${fromAddress} — domain not in allowlist: ${allowedDomains.join(', ')}`);
  }

  return isAllowed;
}

interface MailToForward {
  subject: string;
  text: string;
  html: string | undefined;
  attachments: { filename: string | undefined; content: Buffer }[];
}

async function forwardMail(email: MailToForward) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST!,
    port: parseInt(SMTP_PORT!, 10),
    secure: parseInt(SMTP_PORT!, 10) === 465,
    auth: {
      user: SMTP_USER!,
      pass: SMTP_PASSWORD!,
    },
  });

  const mailOptions = {
    from: FORWARD_FROM!,
    to: FORWARD_TO!,
    subject: email.subject,
    text: email.text,
    html: email.html,
    attachments: email.attachments,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`Forwarded email: ${email.subject}`);
  } catch (error) {
    logger.error(`Failed to forward email: ${email.subject} — ${error instanceof Error ? error.message : error}`);
    throw error; // Re-throw to let the caller decide how to handle
  }
}

async function processUnseen(client: ImapFlow) {
  logger.debug("Checking for unseen messages...");

  // Ensure INBOX is open
  if (!client.mailbox || client.mailbox.path !== 'INBOX') {
    logger.debug("Opening INBOX...");
    await client.mailboxOpen('INBOX');
  }

  // Fetch all unseen at once to avoid deadlocks
  const messages = await client.fetchAll({ seen: false }, { uid: true, envelope: true, source: true });

  if (messages.length === 0) {
    logger.debug("No unseen messages to process");
    return;
  }

  logger.info(`Found ${messages.length} unseen message(s)`);

  for (const msg of messages) {
    logger.debug(`Processing message UID: ${msg.uid}`);
    try {
      const parsed = await simpleParser(msg.source as Buffer);
      logger.debug(`Parsed subject: ${parsed.subject || '(no subject)'}`);

      if (!shouldForwardEmail(parsed)) {
        logger.debug(`Domain filter: marking UID ${msg.uid} as seen and skipping`);
        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        continue;
      }

      await forwardMail({
        subject: parsed.subject || '(no subject)',
        text: parsed.text || '',
        html: parsed.html || undefined, // normalize false/null → undefined
        attachments: (parsed.attachments || []).map((a: import('mailparser').Attachment) => ({ filename: a.filename, content: a.content })),
      });

      // Mark as seen immediately so a failed move doesn't cause re-processing
      await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });

      logger.debug(`Moving UID ${msg.uid} to ${PROCESSED_FOLDER}...`);
      await client.messageMove({ uid: msg.uid }, PROCESSED_FOLDER, { uid: true });
    } catch (err) {
      logger.error(`Processing failed for UID ${msg.uid}: ${err}`);
      // Leave message untouched for retry
    }
  }
}

async function main() {
  logger.info("Starting mail forwarder...");

  validateEnvironmentVariables();

  const client = new ImapFlow({
    host: IMAP_HOST!,
    port: parseInt(IMAP_PORT!, 10),
    secure: true,
    auth: { user: IMAP_USER!, pass: IMAP_PASSWORD! },
    logger: false,
  });

  try {
    logger.debug("Connecting to IMAP server...");
    await client.connect();
    logger.info("Connected to IMAP server");

    logger.debug("Opening INBOX...");
    await client.mailboxOpen('INBOX');

    // Ensure processed folder exists
    const existing = await client.list();
    if (!existing.some(m => m.path === PROCESSED_FOLDER)) {
      logger.info(`Creating folder: ${PROCESSED_FOLDER}`);
      await client.mailboxCreate(PROCESSED_FOLDER);
    }

    await processUnseen(client);

    if (DAEMON) {
      logger.info(`Daemon mode: polling every ${POLL_INTERVAL_MS} ms`);
      let busy = false;

      const poll = async () => {
        if (busy) {
          logger.debug("Previous poll still running, skipping");
          return;
        }
        busy = true;
        try {
          await processUnseen(client);
        } catch (e) {
          logger.error(`Polling error: ${e}`);
        } finally {
          busy = false;
        }
      };

      const timer = setInterval(poll, POLL_INTERVAL_MS);

      const shutdown = async (code = 0) => {
        logger.info("Shutting down...");
        clearInterval(timer);
        try { await client.logout(); } catch {}
        process.exit(code);
      };
      process.on('SIGTERM', () => shutdown(0));
      process.on('SIGINT', () => shutdown(0));

      logger.info("Daemon running. Press Ctrl+C to stop.");
      await new Promise(() => {}); // Keep process alive
    } else {
      await client.logout();
      process.exit(0);
    }
  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    try { await client.logout(); } catch {}
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(`Unexpected error: ${err}`);
  process.exit(1);
});
