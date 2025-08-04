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
    console.error(
      "Missing required environment variables:",
      missingVars.join(", ")
    );
    process.exit(1);
  }

  console.log("All required environment variables are set.");
  
  // Log domain filtering configuration
  if (ALLOWED_SENDER_DOMAINS) {
    console.log("Domain filtering enabled. Allowed domains:", ALLOWED_SENDER_DOMAINS);
  } else {
    console.log("Domain filtering disabled. All emails will be forwarded.");
  }
}

// Custom logger for ImapFlow using console statements
const customLogger = {
  trace: () => {}, // Suppress trace logs
  debug: () => {}, // Suppress debug logs
  info: (msg: any, ...args: any[]) => {
    // Only log important info messages
    if (typeof msg === 'string' && (msg.includes('Connected') || msg.includes('Authenticated'))) {
      console.log('IMAP:', msg, ...args);
    }
  },
  warn: (msg: any, ...args: any[]) => {
    console.warn('IMAP Warning:', msg, ...args);
  },
  error: (msg: any, ...args: any[]) => {
    console.error('IMAP Error:', msg, ...args);
  },
  fatal: (msg: any, ...args: any[]) => {
    console.error('IMAP Fatal:', msg, ...args);
  }
};

function shouldForwardEmail(email) {
  // If no domain filtering is configured, forward all emails
  if (!ALLOWED_SENDER_DOMAINS) {
    return true;
  }

  // Get sender email address
  const fromAddress = email.from?.value?.[0]?.address || email.from?.text || '';
  
  if (!fromAddress) {
    console.log("No sender address found, skipping email");
    return false;
  }

  // Extract domain from sender email
  const senderDomain = fromAddress.split('@')[1]?.toLowerCase();
  
  if (!senderDomain) {
    console.log("Invalid sender email format:", fromAddress);
    return false;
  }

  // Parse allowed domains (comma-separated, case-insensitive)
  const allowedDomains = ALLOWED_SENDER_DOMAINS
    .split(',')
    .map(domain => domain.trim().toLowerCase())
    .filter(domain => domain.length > 0);

  const isAllowed = allowedDomains.includes(senderDomain);
  
  if (!isAllowed) {
    console.log(`Email from ${fromAddress} (domain: ${senderDomain}) not in allowed domains: ${allowedDomains.join(', ')}`);
  }

  return isAllowed;
}

async function forwardMail(email) {
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
    console.log("Forwarded email:", email.subject);
  } catch (error) {
    console.error("Failed to forward email:", email.subject, "Error:", error.message);
    throw error; // Re-throw to let the caller decide how to handle
  }
}

async function main() {
  // Validate all required environment variables are set
  validateEnvironmentVariables();

  const client = new ImapFlow({
    host: IMAP_HOST!,
    port: parseInt(IMAP_PORT!, 10),
    secure: true,
    auth: {
      user: IMAP_USER!,
      pass: IMAP_PASSWORD!,
    },
    logger: customLogger
  });

  try {
    await client.connect();

    // Select and lock the mailbox in read-write mode.
    let lock = await client.getMailboxLock("INBOX", { readOnly: false });
    try {
      console.log("Searching for unseen messages...");
      // Fetch all unseen messages at once to avoid deadlock with flag operations
      const messages = await client.fetchAll(
        { seen: false },
        { source: true, uid: true }
      );
      
      console.log(`Found ${messages.length} unseen message(s)`);
      
      for (const message of messages) {
        const parsed = await simpleParser(message.source);
        console.log("Found unread message:", parsed.subject);
        
        // Check if email should be forwarded based on sender domain
        if (!shouldForwardEmail(parsed)) {
          console.log("Skipping email due to domain filter. Marking as seen...");
          try {
            await client.messageFlagsAdd(message.uid, ["\\Seen"]);
            console.log("Email marked as seen (filtered)");
          } catch (flagError) {
            console.error("Failed to mark filtered email as seen:", flagError.message);
          }
          continue;
        }
        
        try {
          await forwardMail(parsed);
          // Delete the message after successful forwarding
          console.log("Deleting forwarded email...");
          try {
            await client.messageDelete(message.uid);
            console.log("Email deleted successfully");
          } catch (deleteError) {
            console.error("Failed to delete email:", deleteError.message);
            // If deletion fails, mark as seen as fallback
            try {
              await client.messageFlagsAdd(message.uid, ["\\Seen"]);
              console.log("Email marked as seen as fallback");
            } catch (flagError) {
              console.error("Failed to mark email as seen:", flagError.message);
            }
          }
        } catch (error) {
          console.error("Skipping email due to forwarding error. Email will remain unread for retry.");
          // Don't delete or mark as seen so it can be retried later
        }
      }
      console.log("Finished processing all unseen messages");
    } finally {
      lock.release();
    }

    await client.logout();
    console.log("Mail forwarding completed successfully.");
    process.exit(0);
  } catch (err) {
    console.error("IMAP error:", err);
    process.exit(1);
  }
}

main();
