// LINE Simulator: a fake LINE Messaging API, plus a page to chat as your bot's users.
// Point your app's LINE API base URL here, and point a channel's webhook at your app.
// API spec: GET /openapi.json    Page: GET /
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const file = (name) => readFileSync(new URL(name, import.meta.url));
const lineId = (prefix, seed) =>
  prefix + (seed ? createHash("md5").update(seed).digest("hex") : randomBytes(16).toString("hex"));
const messageId = () => `${Date.now()}${randomBytes(2).readUInt16BE()}`;

/** One LINE message event from a user (text, or an image/file your app fetches by id), signed the way LINE signs webhooks. */
export function signedWebhook(chat, { userId, text, file }, secret) {
  const source =
    chat.kind === "group" ? { type: "group", groupId: chat.id, userId } : { type: "user", userId: chat.id };
  const replyToken = randomBytes(16).toString("hex");
  const message = !file
    ? { type: "text", id: messageId(), text, quoteToken: randomUUID() }
    : file.type.startsWith("image/")
      ? { type: "image", id: file.id, contentProvider: { type: "line" }, quoteToken: randomUUID() }
      : { type: "file", id: file.id, fileName: file.name, fileSize: file.size };
  const body = JSON.stringify({
    destination: "Usimulator",
    events: [
      {
        type: "message",
        mode: "active",
        webhookEventId: randomUUID(),
        deliveryContext: { isRedelivery: false },
        timestamp: Date.now(),
        source,
        replyToken,
        message,
      },
    ],
  });
  return { body, replyToken, signature: createHmac("sha256", secret).update(body).digest("base64") };
}

/** Channels from env: WEBHOOK_URL + CHANNEL_SECRET for one, CHANNELS (a JSON array) for more. */
export function channelsFromEnv(env) {
  const list = env.CHANNELS ? JSON.parse(env.CHANNELS) : [];
  if (env.WEBHOOK_URL) list.unshift({ name: "default", webhookUrl: env.WEBHOOK_URL, secret: env.CHANNEL_SECRET ?? "" });
  return list;
}

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// ponytail: all state is in memory and gone on restart; a push to an unknown chat recreates it.
export function createSim(channelList = []) {
  const channels = new Map(channelList.map((c) => [c.name, c]));
  const chats = new Map();
  const contents = new Map(); // message id → { type, bytes }, served at /v2/bot/message/{id}/content
  const replyTokens = new Map(); // reply token → chat id, used once

  const firstChannel = () => channels.keys().next().value ?? "default";

  function chatFor(id) {
    if (!chats.has(id))
      chats.set(id, { id, kind: id.startsWith("U") ? "user" : "group", channel: firstChannel(), name: id, members: {}, messages: [] });
    return chats.get(id);
  }

  function say(chat, from, name, text, media) {
    const message = { from, name, text, media, at: new Date().toISOString() };
    chat.messages.push(message);
    return message;
  }

  function botSays(chat, messages) {
    for (const m of messages)
      say(chat, "bot", "บอท", m.text ?? m.altText ?? `[${m.type}]`, m.originalContentUrl && { url: m.originalContentUrl, image: m.type === "image" });
    return { sentMessages: messages.map(() => ({ id: messageId() })) };
  }

  async function sendAsUser(chat, { sender, text = "", file: upload }) {
    const channel = channels.get(chat.channel);
    if (!channel?.webhookUrl) return { status: 0, error: `channel "${chat.channel}" ยังไม่มี webhookUrl` };
    if (!channel.secret) return { status: 0, error: `channel "${chat.channel}" ยังไม่มี secret` };
    const name = chat.kind === "group" ? sender || "ผู้ใช้" : chat.name;
    const userId = chat.kind === "group" ? lineId("U", `${chat.id}:${name}`) : chat.id;
    if (chat.kind === "group") chat.members[userId] = name;
    let file;
    if (upload) {
      const bytes = Buffer.from(upload.data, "base64");
      file = { id: messageId(), name: upload.name, type: upload.type, size: bytes.length };
      contents.set(file.id, { type: file.type, bytes });
    }
    const { body, signature, replyToken } = signedWebhook(chat, { userId, text: String(text), file }, channel.secret);
    // show the message and accept its reply token before the app answers: apps often reply inside the webhook
    replyTokens.set(replyToken, chat.id);
    const sent = say(chat, "user", name, file ? file.name : text, file && { url: `/v2/bot/message/${file.id}/content`, image: file.type.startsWith("image/") });
    const res = await fetch(channel.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-line-signature": signature },
      body,
    }).catch((e) => ({ ok: false, status: 0, text: async () => `ต่อแอปไม่ได้: ${e.message}` }));
    if (!res.ok) {
      replyTokens.delete(replyToken);
      chat.messages.splice(chat.messages.indexOf(sent), 1);
    }
    return { status: res.status, error: res.ok ? null : await res.text() };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://sim");
    const p = url.pathname.split("/").filter(Boolean);
    const route = `${req.method} /${p.join("/")}`;

    // --- the page and the spec
    if (route === "GET /" || route === "GET /sim") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(file("index.html"));
    }
    if (route === "GET /openapi.json") {
      const spec = JSON.parse(file("openapi.json"));
      spec.servers = [{ url: `http://${req.headers.host}` }];
      return json(res, 200, spec);
    }

    // --- simulator control: what the page uses, and what your tests can use
    if (route === "GET /sim/channels")
      return json(res, 200, [...channels.values()].map(({ name, webhookUrl, secret }) => ({ name, webhookUrl, hasSecret: !!secret })));
    if (route === "POST /sim/channels") {
      const { name, webhookUrl, secret = "" } = await readJson(req);
      if (!name || !webhookUrl) return json(res, 400, { error: "ต้องมี name และ webhookUrl" });
      channels.set(name, { name, webhookUrl, secret });
      return json(res, 201, { name, webhookUrl, hasSecret: !!secret });
    }
    if (route === "GET /sim/chats") return json(res, 200, [...chats.values()]);
    if (route === "POST /sim/chats") {
      const { kind, channel, name } = await readJson(req);
      const chat = chatFor(lineId(kind === "group" ? "C" : "U"));
      Object.assign(chat, { channel: channels.has(channel) ? channel : firstChannel(), name: name || chat.id.slice(-4) });
      return json(res, 201, chat);
    }
    if (route === "DELETE /sim/chats") {
      chats.clear();
      contents.clear();
      replyTokens.clear();
      return json(res, 200, {});
    }
    if (req.method === "POST" && p[0] === "sim" && p[1] === "chats" && p[3] === "messages" && p.length === 4) {
      const chat = chats.get(p[2]);
      if (!chat) return json(res, 404, { error: "ไม่พบแชท" });
      return json(res, 200, await sendAsUser(chat, await readJson(req)));
    }

    // --- the LINE Messaging API endpoints your app calls
    if (route === "POST /v2/bot/message/push") {
      const { to, messages = [] } = await readJson(req);
      return json(res, 200, botSays(chatFor(to), messages));
    }
    if (route === "POST /v2/bot/message/reply") {
      const { replyToken, messages = [] } = await readJson(req);
      const chat = chats.get(replyTokens.get(replyToken));
      if (!chat) return json(res, 400, { message: "Invalid reply token" });
      replyTokens.delete(replyToken);
      return json(res, 200, botSays(chat, messages));
    }
    if (route === "POST /v2/bot/chat/markAsRead") return json(res, 200, {});
    if (req.method === "GET" && p[0] === "v2" && p[1] === "bot") {
      const content = p[2] === "message" && p[4] === "content" && p.length === 5 && contents.get(p[3]);
      if (content) {
        res.writeHead(200, { "Content-Type": content.type });
        return res.end(content.bytes);
      }
      const chat = chats.get(p[3]);
      if (p[2] === "profile" && p.length === 4 && chat?.kind === "user") return json(res, 200, { userId: chat.id, displayName: chat.name });
      if (p[2] === "group" && chat && p[4] === "summary") return json(res, 200, { groupId: chat.id, groupName: chat.name });
      if (p[2] === "group" && p[4] === "member" && chat?.members[p[5]]) return json(res, 200, { userId: p[5], displayName: chat.members[p[5]] });
    }
    json(res, 404, { message: "Not found" });
  }

  return createServer((req, res) => handle(req, res).catch((e) => json(res, 500, { error: e.message })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5530);
  const channels = channelsFromEnv(process.env);
  createSim(channels).listen(port, () => {
    const base = `http://localhost:${port}`;
    const { paths } = JSON.parse(file("openapi.json"));
    console.log(`LINE Simulator: ${base}\nAPI spec:       ${base}/openapi.json\n`);
    for (const [path, ops] of Object.entries(paths))
      for (const [method, op] of Object.entries(ops)) console.log(`  ${method.toUpperCase().padEnd(6)} ${path.padEnd(40)} ${op.summary}`);
    console.log(
      channels.length
        ? `\nChannels: ${channels.map((c) => `${c.name} → ${c.webhookUrl}`).join(", ")}`
        : "\nNo channel yet. Set WEBHOOK_URL + CHANNEL_SECRET in .env, or POST /sim/channels.",
    );
  });
}
