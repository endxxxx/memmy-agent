/** Vscdb reader module. */
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const SQLITE_ROW_YIELD_INTERVAL = 100;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

/** Contract for raw cursor message. */
export interface RawCursorMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  rawMeta: Readonly<Record<string, unknown>>;
  ordinal?: number;
}

interface ItemTableRow {
  key: string;
  value: string;
}

interface CursorDiskKvRow {
  key: string;
  value: string;
}

interface ParsedMessageContainer {
  conversationId: string;
  messages: readonly RawMessageLike[];
}

interface RawMessageLike {
  id?: unknown;
  messageId?: unknown;
  role?: unknown;
  content?: unknown;
  text?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
}

interface RawBubbleLike {
  bubbleId?: unknown;
  type?: unknown;
  text?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
  conversationTurnIndex?: unknown;
}

interface RawComposerHeaderLike {
  bubbleId?: unknown;
  type?: unknown;
  createdAt?: unknown;
}

interface CanonicalComposer {
  conversationId: string;
  headers: readonly RawComposerHeaderLike[];
}

/** Vscdb reader module. */
export async function* readCursorVscdb(path: string): AsyncIterable<RawCursorMessage> {
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    const messages = [...(await readItemTableMessages(db)), ...(await readCursorDiskKvMessages(db))].sort(compareRawCursorMessages);
    for (const message of messages) {
      yield message;
    }
  } finally {
    db.close();
  }
}

/** Streams Cursor rows without building a database-wide message array. */
export async function* streamCursorVscdb(path: string): AsyncIterable<RawCursorMessage> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (hasTable(db, "ItemTable")) {
      const statement = db.prepare("SELECT key, value FROM ItemTable WHERE value IS NOT NULL ORDER BY key ASC");
      let rows = 0;
      for (const row of statement.iterate() as Iterable<ItemTableRow>) {
        rows += 1;
        if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) await yieldToEventLoop();
        if (Buffer.byteLength(row.value) > MAX_RECORD_BYTES) continue;
        for (const message of extractMessagesFromItemRow(row)) yield message;
      }
    }
    if (hasTable(db, "cursorDiskKV")) {
      for await (const message of streamCursorDiskKvMessages(db)) yield message;
    }
  } finally {
    db.close();
  }
}

/** Reads read item table messages. */
async function readItemTableMessages(db: DatabaseSync): Promise<RawCursorMessage[]> {
  if (!hasTable(db, "ItemTable")) {
    return [];
  }

  const statement = db.prepare("SELECT key, value FROM ItemTable WHERE value IS NOT NULL ORDER BY key ASC");
  const messages: RawCursorMessage[] = [];
  let rows = 0;
  for (const row of statement.iterate() as Iterable<ItemTableRow>) {
    rows += 1;
    if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }

    if (Buffer.byteLength(row.value) <= MAX_RECORD_BYTES) messages.push(...extractMessagesFromItemRow(row));
  }

  return messages;
}

/** Reads read cursor disk kv messages. */
async function readCursorDiskKvMessages(db: DatabaseSync): Promise<RawCursorMessage[]> {
  if (!hasTable(db, "cursorDiskKV")) {
    return [];
  }

  const messages: RawCursorMessage[] = [];
  for await (const message of streamCursorDiskKvMessages(db)) messages.push(message);

  return messages;
}

/**
 * Reads modern Cursor conversations through their canonical header arrays.
 * Unreferenced bubble rows are stale branches/checkpoints and must not be
 * interpreted as active conversation messages.
 */
async function* streamCursorDiskKvMessages(db: DatabaseSync): AsyncIterable<RawCursorMessage> {
  const composers = await readCanonicalComposers(db);
  const canonicalConversationIds = new Set(composers.map((composer) => composer.conversationId));
  const getBubble = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key = ? AND value IS NOT NULL");
  let rows = 0;

  for (const composer of composers) {
    let skipSyntheticTurn = false;
    for (const [index, header] of composer.headers.entries()) {
      const bubbleId = getString(header.bubbleId);
      if (!bubbleId) continue;
      rows += 1;
      if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) await yieldToEventLoop();
      const row = getBubble.get(`bubbleId:${composer.conversationId}:${bubbleId}`) as CursorDiskKvRow | undefined;
      const beginsUserTurn = normalizeBubbleRole(header.type) === "user";
      if (!row || Buffer.byteLength(row.value) > MAX_RECORD_BYTES) {
        if (beginsUserTurn) skipSyntheticTurn = true;
        continue;
      }
      const message = extractMessageFromBubbleRow(row, {
        ordinal: index,
        headerType: header.type,
        headerCreatedAt: header.createdAt
      });
      if (!message) {
        if (beginsUserTurn) skipSyntheticTurn = true;
        continue;
      }
      if (message.role === "user") {
        skipSyntheticTurn = isSyntheticNotification(message.content);
        if (skipSyntheticTurn) continue;
      } else if (skipSyntheticTurn) {
        continue;
      }
      yield message;
    }
  }

  // Older/partial databases may have bubble rows but no composerData headers.
  // Preserve that compatibility only for conversations without canonical data.
  const statement = db.prepare(
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value IS NOT NULL ORDER BY key ASC"
  );
  for (const row of statement.iterate() as Iterable<CursorDiskKvRow>) {
    rows += 1;
    if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) await yieldToEventLoop();
    if (Buffer.byteLength(row.value) > MAX_RECORD_BYTES) continue;
    const key = parseBubbleKey(row.key);
    if (!key || canonicalConversationIds.has(key.conversationId)) continue;
    const message = extractMessageFromBubbleRow(row);
    if (message) yield message;
  }
}

async function readCanonicalComposers(db: DatabaseSync): Promise<CanonicalComposer[]> {
  const statement = db.prepare(
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL ORDER BY key ASC"
  );
  const composers: CanonicalComposer[] = [];
  let rows = 0;
  for (const row of statement.iterate() as Iterable<CursorDiskKvRow>) {
    rows += 1;
    if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) await yieldToEventLoop();
    if (Buffer.byteLength(row.value) > MAX_RECORD_BYTES) continue;
    const parsed = parseJson(row.value);
    if (!isRecord(parsed) || !Array.isArray(parsed.fullConversationHeadersOnly)) continue;
    const conversationId = getString(parsed.composerId) ?? parseComposerKey(row.key);
    if (!conversationId) continue;
    composers.push({
      conversationId,
      headers: parsed.fullConversationHeadersOnly.filter(isRecord)
    });
  }
  return composers;
}

/** Handles extract messages from item row. */
function extractMessagesFromItemRow(row: ItemTableRow): RawCursorMessage[] {
  const parsed = parseJson(row.value);
  const container = toMessageContainer(row.key, parsed);

  if (!container) {
    return [];
  }

  return container.messages.flatMap((message, index) => {
    const parsedMessage = toRawCursorMessage(container.conversationId, row.key, index, message);
    return parsedMessage ? [parsedMessage] : [];
  });
}

/** Handles extract message from bubble row. */
function extractMessageFromBubbleRow(
  row: CursorDiskKvRow,
  canonical?: { ordinal: number; headerType?: unknown; headerCreatedAt?: unknown }
): RawCursorMessage | null {
  const parsed = parseJson(row.value);
  if (!isRecord(parsed)) {
    return null;
  }

  const keyParts = parseBubbleKey(row.key);
  if (!keyParts) {
    return null;
  }

  return toRawCursorBubbleMessage(keyParts.conversationId, row.key, keyParts.bubbleId, parsed, canonical);
}

/** Handles to message container. */
function toMessageContainer(fallbackConversationId: string, value: unknown): ParsedMessageContainer | null {
  if (Array.isArray(value)) {
    return {
      conversationId: fallbackConversationId,
      messages: value.filter(isRecord)
    };
  }

  if (!isRecord(value)) {
    return null;
  }

  const messages = value.messages;
  if (!Array.isArray(messages)) {
    return null;
  }

  return {
    conversationId: typeof value.conversationId === "string" ? value.conversationId : fallbackConversationId,
    messages: messages.filter(isRecord)
  };
}

/** Handles to raw cursor message. */
function toRawCursorMessage(
  conversationId: string,
  rowKey: string,
  index: number,
  message: RawMessageLike
): RawCursorMessage | null {
  const content = getMessageContent(message);
  const role = normalizeRole(message.role);

  if (!content || !role) {
    return null;
  }

  return {
    messageId: getString(message.messageId) ?? getString(message.id) ?? `${conversationId}:${index}`,
    conversationId,
    role,
    content,
    createdAt: normalizeTimestamp(message.createdAt ?? message.timestamp),
    rawMeta: Object.freeze({
      cursorItemKey: rowKey,
      cursorMessageIndex: index
    })
  };
}

/**
 * Converts a Cursor bubble object into a RawCursorMessage.
 *
 * @param conversationId composer conversation id.
 * @param rowKey cursorDiskKV key.
 * @param fallbackBubbleId The bubble id from the key.
 * @param bubble Unknown bubble object.
 * @returns A usable message, or null when required fields are missing.
 */
function toRawCursorBubbleMessage(
  conversationId: string,
  rowKey: string,
  fallbackBubbleId: string,
  bubble: RawBubbleLike,
  canonical?: { ordinal: number; headerType?: unknown; headerCreatedAt?: unknown }
): RawCursorMessage | null {
  const content = getString(bubble.text);
  const role = normalizeBubbleRole(bubble.type ?? canonical?.headerType);
  if (!content || !role) {
    return null;
  }

  const bubbleId = getString(bubble.bubbleId) ?? fallbackBubbleId;
  return {
    messageId: bubbleId,
    conversationId,
    role,
    content,
    createdAt: normalizeTimestamp(bubble.createdAt ?? bubble.timestamp ?? canonical?.headerCreatedAt),
    ...(canonical ? { ordinal: canonical.ordinal } : {}),
    rawMeta: Object.freeze({
      cursorDiskKvKey: rowKey,
      cursorBubbleId: bubbleId,
      cursorBubbleType: bubble.type ?? canonical?.headerType,
      ...(canonical ? { cursorConversationIndex: canonical.ordinal } : {}),
      ...(typeof bubble.conversationTurnIndex === "number"
        ? { cursorConversationTurnIndex: bubble.conversationTurnIndex }
        : {})
    })
  };
}

/**
 * Parses the message body.
 *
 * @param message Unknown message object.
 * @returns The text content, or null when absent.
 */
function getMessageContent(message: RawMessageLike): string | null {
  return getString(message.content) ?? getString(message.text);
}

/**
 * Normalizes the message role.
 *
 * @param role Unknown role field.
 * @returns A unified role, or null when it cannot be recognized.
 */
function normalizeRole(role: unknown): RawCursorMessage["role"] | null {
  if (role === "user" || role === "assistant" || role === "tool" || role === "system") {
    return role;
  }

  return null;
}

/**
 * Normalizes the Cursor bubble type.
 *
 * @param type Cursor bubble type.
 * @returns A unified role, or null when it cannot be recognized.
 */
function normalizeBubbleRole(type: unknown): RawCursorMessage["role"] | null {
  if (type === 1) {
    return "user";
  }

  if (type === 2) {
    return "assistant";
  }

  return null;
}

/**
 * Normalizes a timestamp.
 *
 * @param timestamp A string or millisecond timestamp.
 * @returns An ISO 8601 time.
 */
function normalizeTimestamp(timestamp: unknown): string {
  if (typeof timestamp === "string") {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }

  if (typeof timestamp === "number") {
    return new Date(timestamp).toISOString();
  }

  return new Date(0).toISOString();
}

/**
 * JSON parsing helper.
 *
 * @param input SQLite value text.
 * @returns The parsed unknown value, or null on failure.
 */
function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

/**
 * Parses a cursorDiskKV bubble key.
 *
 * @param key cursorDiskKV key.
 * @returns The composer conversation id and bubble id.
 */
function parseBubbleKey(key: string): { conversationId: string; bubbleId: string } | null {
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== "bubbleId" || !parts[1] || !parts[2]) {
    return null;
  }

  return {
    conversationId: parts[1],
    bubbleId: parts[2]
  };
}

function parseComposerKey(key: string): string | null {
  const prefix = "composerData:";
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null;
}

function isSyntheticNotification(content: string): boolean {
  if (!/<system_notification>[\s\S]*<\/system_notification>/i.test(content)) return false;
  const userQuery = content.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1]?.trim();
  return !userQuery || /^(briefly\s+)?inform the user\b/i.test(userQuery);
}

/**
 * Determines whether a SQLite table exists.
 *
 * @param db SQLite connection.
 * @param tableName Table name.
 * @returns true when the table exists.
 */
function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

/**
 * Sorts raw messages so that messages in the same conversation stay contiguous.
 *
 * @param left Left-hand message.
 * @param right Right-hand message.
 * @returns The Array.sort comparison result.
 */
function compareRawCursorMessages(left: RawCursorMessage, right: RawCursorMessage): number {
  const ordinalOrder = typeof left.ordinal === "number" && typeof right.ordinal === "number"
    ? left.ordinal - right.ordinal
    : 0;
  return (
    left.conversationId.localeCompare(right.conversationId) ||
    ordinalOrder ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.messageId.localeCompare(right.messageId)
  );
}

/**
 * String type guard.
 *
 * @param value Unknown value.
 * @returns The string, or null.
 */
function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Plain-object type guard.
 *
 * @param value Unknown value.
 * @returns Whether it is an indexable record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
