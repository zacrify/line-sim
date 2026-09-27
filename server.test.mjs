import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { channelsFromEnv, createSim, signedWebhook } from "./server.mjs";

// the check every LINE SDK does: base64(HMAC-SHA256(secret, raw body)) === x-line-signature
const validSignature = (body, secret, signature) =>
  timingSafeEqual(Buffer.from(createHmac("sha256", secret).update(body).digest("base64")), Buffer.from(signature));

async function listen(server) {
  server.listen(0);
  await once(server, "listening");
  return `http://localhost:${server.address().port}`;
}

test("the webhook passes LINE's signature check and names the chat", () => {
  const { body, signature } = signedWebhook({ id: "Cgroup1", kind: "group" }, { userId: "Ubuyer", text: "สวัสดี" }, "test-secret");
  assert.ok(validSignature(body, "test-secret", signature));
  const [event] = JSON.parse(body).events;
  assert.deepEqual(event.source, { type: "group", groupId: "Cgroup1", userId: "Ubuyer" });
  assert.equal(event.message.type, "text");
  assert.equal(event.message.text, "สวัสดี");
  assert.ok(event.replyToken);
});

test("an image or a file becomes the LINE message your app downloads by id", () => {
  const message = (file) => JSON.parse(signedWebhook({ id: "Uc1", kind: "user" }, { userId: "Uc1", file }, "s").body).events[0].message;
  assert.deepEqual(message({ id: "11", name: "a.png", type: "image/png", size: 3 }).contentProvider, { type: "line" });
  const pdf = message({ id: "12", name: "quote.pdf", type: "application/pdf", size: 9 });
  assert.equal(pdf.type, "file");
  assert.equal(pdf.fileName, "quote.pdf");
  assert.equal(pdf.fileSize, 9);
});

test("channels come from WEBHOOK_URL + CHANNEL_SECRET, then CHANNELS", () => {
  assert.deepEqual(
    channelsFromEnv({
      WEBHOOK_URL: "http://a/hook",
      CHANNEL_SECRET: "s1",
      CHANNELS: '[{"name":"trade","webhookUrl":"http://b/hook","secret":"s2"}]',
    }).map((c) => c.name),
    ["default", "trade"],
  );
});

test("round trip: a user writes, your app replies and downloads the file", async (t) => {
  // a tiny app: verify the signature, download any file, reply with what it got
  let sim;
  const app = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (!validSignature(body, "app-secret", req.headers["x-line-signature"])) return res.writeHead(401).end("bad signature");
    const [event] = JSON.parse(body).events;
    let text = `ได้รับ: ${event.message.text}`;
    if (event.message.type !== "text") {
      const content = await fetch(`${sim}/v2/bot/message/${event.message.id}/content`);
      text = `ได้ไฟล์ ${content.headers.get("content-type")} ${(await content.arrayBuffer()).byteLength} bytes`;
    }
    await fetch(`${sim}/v2/bot/message/reply`, {
      method: "POST",
      body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: "text", text }] }),
    });
    res.end("ok");
  });
  const appUrl = await listen(app);
  const simServer = createSim([{ name: "default", webhookUrl: `${appUrl}/webhook`, secret: "app-secret" }]);
  sim = await listen(simServer);
  t.after(() => (app.close(), simServer.close()));

  const post = async (path, body) => (await fetch(sim + path, { method: "POST", body: JSON.stringify(body) })).json();
  const chat = await post("/sim/chats", { name: "สมชาย" });
  assert.deepEqual(await post(`/sim/chats/${chat.id}/messages`, { text: "สวัสดี" }), { status: 200, error: null });
  const pdf = Buffer.from("%PDF-1.1 fake").toString("base64");
  await post(`/sim/chats/${chat.id}/messages`, { file: { name: "quote.pdf", type: "application/pdf", data: pdf } });

  const [saved] = await (await fetch(`${sim}/sim/chats`)).json();
  assert.deepEqual(
    saved.messages.map((m) => `${m.from}: ${m.text}`),
    ["user: สวัสดี", "bot: ได้รับ: สวัสดี", "user: quote.pdf", "bot: ได้ไฟล์ application/pdf 13 bytes"],
  );
  assert.deepEqual(await (await fetch(`${sim}/v2/bot/profile/${chat.id}`)).json(), { userId: chat.id, displayName: "สมชาย" });
});

test("an unknown reply token gets 400, like LINE", async (t) => {
  const simServer = createSim();
  const sim = await listen(simServer);
  t.after(() => simServer.close());
  const res = await fetch(`${sim}/v2/bot/message/reply`, { method: "POST", body: JSON.stringify({ replyToken: "nope", messages: [] }) });
  assert.equal(res.status, 400);
});

test("/openapi.json lists every route the server answers", async (t) => {
  const simServer = createSim();
  const sim = await listen(simServer);
  t.after(() => simServer.close());
  const spec = await (await fetch(`${sim}/openapi.json`)).json();
  assert.equal(spec.servers[0].url, sim);
  assert.ok(spec.paths["/v2/bot/message/push"].post);
  assert.ok(spec.paths["/sim/chats/{chatId}/messages"].post);
  assert.ok(spec.webhooks.message.post);
});
